#!/usr/bin/env node
// No worker wall-clock limit. Hub follower exits are not necessarily turn failures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scanLogFindings } from './lib/nightly-audit.mjs';
import { checkedLogStat, readLogText, redactLogFile } from './lib/log-redaction.mjs';
import { computeNightly, nightlyBrief, nightlyReport, metricTable } from './lib/nightly-metrics.mjs';
import { nightlyRecipients, deliveryPlan, deliverNightly } from './lib/nightly-delivery.mjs';
import { rulesAcknowledgements } from './lib/rules-acknowledgements.mjs';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(skill, 'scripts/nightly-review.mjs');
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dir = process.env.NIGHTLY_DIR || path.join(os.homedir(), '.claude/orchestrator/_shared/routing-review');
const day = process.env.NIGHTLY_DAY || localDay();
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('NIGHTLY_DAY must be YYYY-MM-DD');
const runDir = path.join(dir, `${day}.run`);
const mode = process.env.NIGHTLY_MODE || 'auto';
const userOK = process.env.NIGHTLY_USER_OK;
const setting = (key, fallback, min) => { const n = Number(process.env[key]); return Number.isSafeInteger(n) && n > 0 ? Math.max(min, n) : fallback; };
const pollMs = setting('NIGHTLY_POLL_MS', 5000, 50);
const probeMs = setting('NIGHTLY_PROBE_MS', 15000, 100);
const resultRetries = setting('NIGHTLY_RESULT_RETRIES', 3, 1);
const livenessRetries = setting('NIGHTLY_LIVENESS_RETRIES', 3, 1);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const nonempty = (f) => { try { return fs.statSync(f).size > 0; } catch { return false; } };
const atomic = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(tmp, f);
};
const log = (s) => {
  const line = `${new Date().toISOString()} ${s}\n`;
  if (mode !== 'plan') { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'launch.log'), line); }
  process.stdout.write(line);
};
const sleep = () => new Promise((r) => setTimeout(r, pollMs));
const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const ackCommand = (file) => `node ${quote(script)} ack --file ${quote(file)}`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

function claimLock(lock) {
  // Publish the claimant PID atomically, and reclaim only its unique dead-owner entry.
  const guard = `${lock}.claim`;
  const entry = `owner-${process.pid}-${randomUUID()}.json`;
  const prepared = `${guard}.${entry}.tmp`;
  fs.mkdirSync(prepared); atomic(path.join(prepared, entry), { pid: process.pid });
  const publish = () => { try { fs.renameSync(prepared, guard); return true; } catch (e) { if (['EEXIST', 'ENOTEMPTY'].includes(e.code)) return false; throw e; } };
  let claimed = false;
  try {
    claimed = publish();
    if (!claimed) {
      const entries = fs.readdirSync(guard);
      const owner = entries.length === 1 && /^owner-.*\.json$/.test(entries[0]) ? entries[0] : null;
      const pid = owner && read(path.join(guard, owner))?.pid;
      if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) return false;
      try { fs.unlinkSync(path.join(guard, owner)); fs.rmdirSync(guard); }
      catch (e) { if (['ENOENT', 'ENOTEMPTY'].includes(e.code)) return false; throw e; }
      claimed = publish();
      if (!claimed) return false;
    }
    if (fs.existsSync(lock)) {
      const pid = read(path.join(lock, 'owner.json'))?.pid;
      if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) return false;
      fs.rmSync(lock, { recursive: true });
    }
    fs.mkdirSync(lock); atomic(path.join(lock, 'owner.json'), { pid: process.pid }); return true;
  } finally {
    if (claimed) { fs.unlinkSync(path.join(guard, entry)); fs.rmdirSync(guard); }
    fs.rmSync(prepared, { recursive: true, force: true });
  }
}

// Stop only an owned observer/follower client. Never signal a hub turn or Claude session.
function closeClient(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const reap = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 1000);
  reap.unref(); child.once('exit', () => clearTimeout(reap));
}

async function command(exe, args, { file, errFile, line, budgetMs, monitor } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', pending = '', stdout = '', observed, monitoring = false;
    const budget = budgetMs && setTimeout(() => { observed = { state: 'blocked', note: '只读状态 RPC 超时' }; closeClient(child); }, budgetMs);
    const pulse = monitor && setInterval(async () => {
      if (monitoring || observed) return;
      monitoring = true;
      try {
        const isOpen = () => child.exitCode === null && child.signalCode === null;
        const result = await monitor(isOpen);
        if (result && isOpen()) { observed = result; closeClient(child); }
      } catch (e) {
        if (child.exitCode === null && child.signalCode === null) { observed = { state: 'blocked', note: `liveness check failed: ${e.message}` }; closeClient(child); }
      }
      finally { monitoring = false; }
    }, pollMs);
    const consume = (chunk, output) => {
      const s = chunk.toString(); tail = (tail + s).slice(-16000);
      if (output) fs.appendFileSync(output, s);
      pending += s;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const s of lines) line?.(s);
    };
    child.stdout.on('data', (chunk) => {
      if (!file) stdout = (stdout + chunk.toString()).slice(-4 * 2 ** 20);
      consume(chunk, file);
    });
    child.stderr.on('data', (chunk) => consume(chunk, errFile || file));
    child.on('error', (e) => { tail += e.message; });
    // A dead client must not keep us waiting on pipes inherited by a descendant.
    child.once('exit', () => {
      const drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, probeMs);
      drain.unref(); child.once('close', () => clearTimeout(drain));
    });
    child.on('close', (code, signal) => {
      clearTimeout(budget); clearInterval(pulse);
      if (pending) line?.(pending);
      resolve({ code: code ?? 1, signal, text: tail, stdout, observed });
    });
  });
}

async function route(category, extra = [], name = `routing-nightly-review-${day}`, taskDir=attemptDir||path.join(dir,'launches',name)) {
  const r = await command('node', [path.join(skill, 'scripts/route.mjs'), category, ...extra, '--json',
    '--project', 'routing', '--name', name, '--cwd', dir,'--task-dir',taskDir,...(mode==='plan'?['--dry']:[])]);
  try { return r.code === 0 ? JSON.parse(r.stdout) : { deferred: r.text }; }
  catch { return { deferred: r.text || 'invalid route response' }; }
}

const launchable = r => r?.kind==='launch'&&typeof r.pick?.command==='string'&&r.pick.command.trim()&&!(r.needsUserOK||[]).length
  && ['codex','claude'].includes(r.pick.vendor)&&typeof r.pick.model==='string'&&typeof r.pick.effort==='string';
const workerPath=(pick,key,fallback)=>{const args=pick.workerArgs,index=Array.isArray(args)?args.indexOf(`--${key}`):-1;return index>=0&&typeof args[index+1]==='string'?args[index+1]:fallback;};
function brief(taskDir,text) {fs.mkdirSync(taskDir,{recursive:true});fs.writeFileSync(path.join(taskDir,'brief.md'),text+'\n');}
async function claude(name, prompt, routed, sessionFile) {
  const taskDir=routed?attemptDir:path.join(sessionFile?path.dirname(sessionFile):dir,`launch-${name}`);
  const r = routed || await route('claude-tools', [], name,taskDir);
  if (!launchable(r) || r.pick.vendor !== 'claude') return { code: 1, text: 'notification route blocked' };
  brief(taskDir,[prompt,...(r.notes??[])].join('\n'));
  if (sessionFile) atomic(sessionFile, { name, model: r.pick.model, effort: r.pick.effort, id: null, sessionId: null });
  let misses = 0; const started=Date.now();
  const result = await command('sh', ['-c',r.pick.command], { monitor: sessionFile && (async () => {
      if(!read(sessionFile)?.id&&Date.now()-started<probeMs) return null;
      const failed = await sessionLiveness(sessionFile);
      if (!failed) { misses = 0; return null; }
      return ++misses >= livenessRetries ? failed : null;
    }) });
  if (sessionFile) {
    let identity; try { identity = JSON.parse(result.stdout); } catch {}
    const previous = read(sessionFile);
    atomic(sessionFile, { ...previous, id: identity?.id || identity?.jobId || previous.id,
      sessionId: identity?.sessionId || previous.sessionId, launchCode: result.code });
  }
  return result;
}

async function sessionLiveness(file) {
  const identity = read(file);
  if (!identity?.name) return { state: 'blocked', note: '没有可核对的 Claude session 身份' };
  const r = await command('claude', ['agents', '--json'], { budgetMs: probeMs });
  let agents; try { agents = JSON.parse(r.stdout); } catch {}
  if (r.code || !Array.isArray(agents) || agents.some((a) => !a || typeof a !== 'object' || !['id', 'name', 'sessionId'].some((k) => typeof a[k] === 'string'))) {
    return { state: 'blocked', note: 'Claude session 状态不可确认' };
  }
  const agent = agents.find((a) => identity.id ? a.id === identity.id : identity.sessionId ? a.sessionId === identity.sessionId : a.name === identity.name);
  if (!agent) return { state: 'failed', note: 'Claude session 已退出/不在活动列表，未写 delivery receipt' };
  if (agent.name !== identity.name || (identity.sessionId && agent.sessionId !== identity.sessionId)) return { state: 'blocked', note: 'Claude session 身份不匹配' };
  const pid = Number(agent.pid);
  const s = typeof agent.status === 'object' ? agent.status?.type : agent.status || agent.state;
  atomic(file, { ...identity, id: agent.id || identity.id, sessionId: agent.sessionId || identity.sessionId, pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    observedAt: new Date().toISOString(), observedState: s || null });
  if (['failed', 'stopped', 'completed', 'done', 'exited', 'terminated'].includes(s)) return { state: 'failed', note: `Claude session ${s}，未写 delivery receipt` };
  // Logical inactivity wins over a live PID; callers allow only a bounded probe grace.
  if (s === 'blocked' || s === 'idle') return { state: 'blocked', note: `Claude session ${s}，未写 delivery receipt；需要 owner 检查` };
  if (Number.isInteger(pid) && pid > 0 && !alive(pid)) return { state: 'failed', note: `Claude session PID ${pid} 已退出，未写 delivery receipt` };
  if (['running', 'working', 'active', 'busy', 'inProgress'].includes(s) || (!s && agent.running === true)) return null;
  return { state: 'blocked', note: 'Claude session 未提供可验证的工作状态；PID 存活不能证明进展' };
}

async function confirmSessionEnd(file) {
  let ended;
  for (let i = 0; i < livenessRetries; i++) {
    ended = await sessionLiveness(file);
    if (!ended || ended.state === 'blocked') return ended;
    if (i + 1 < livenessRetries) await sleep();
  }
  return ended;
}

function deadlineAt() {
  const time = process.env.NIGHTLY_DEADLINE || '05:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Error('NIGHTLY_DEADLINE must be local HH:MM');
  const d = new Date(`${day}T${time}:00`);
  if (!Number.isFinite(d.getTime()) || localDay(d) !== day) throw Error('invalid nightly date/deadline');
  return d.getTime();
}

function statusMessage(s) {
  if (s?.stage === 'finish' && s?.state === 'done') return `夜间复盘已完成：${day} 报告和通知已交付。`;
  const w = s?.worker?.state;
  const worker = w === 'running' ? 'worker 仍在运行' : w === 'failed' ? 'worker 已失败' : w === 'done' ?
    s?.stage === 'report' && s?.state === 'failed' ? 'worker 已完成，结果/报告不可用' : 'worker 已完成，通知待交付' : 'worker 状态未知/未启动';
  return `夜间复盘未完成：卡在 ${s?.stage || 'gather'}，已做 ${s?.completed || s?.note || '未找到当日启动记录'}，${worker}（${s?.state || 'blocked'}：${s?.note || '无启动记录'}）。`;
}

async function recipients(data = path.join(attemptDir || runDir, 'data')) {
  const review = read(path.join(data, 'review-data-24h.json')) ?? { globalRules: { acknowledgements: rulesAcknowledgements() } };
  const current = rulesAcknowledgements();
  const names = new Set(current.map(a => a.orchestrator));
  review.globalRules ??= {};
  review.globalRules.acknowledgements = [...current, ...(review.globalRules.acknowledgements ?? []).filter(a => !names.has(a.orchestrator))];
  const rosterFile = path.join(data, 'roster.txt');
  let roster = ''; try { roster = fs.readFileSync(fs.existsSync(rosterFile) ? rosterFile : path.join(process.env.RULES_SHARED || path.dirname(dir), 'orchestrators.txt'), 'utf8'); } catch {}
  let agents = read(path.join(data, 'agents.json'));
  const r = await command('claude', ['agents', '--json'], { budgetMs: probeMs });
  try { if (r.code === 0) agents = JSON.parse(r.stdout); } catch {}
  return nightlyRecipients(review, agents, roster);
}

async function deliverStatus(file, message, name) {
  if (read(file)?.delivery === 'sent') return 0;
  const rows = await recipients();
  const owner = rows.find(r => ['routing', 'orchestrator'].includes(r.project)) ?? rows.find(r => /全局规则/.test(r.name ?? ''));
  const plan = { messages: owner?.owner ? [{ owner: owner.owner, recipient: owner.name, text: message }] : [],
    unresolved: owner?.owner ? [] : [{ text: message, recipient: 'routing owner' }] };
  atomic(`${file}.outbox.json`, plan);
  const receipt = await deliverNightly(plan, { day: `${day}/${name}`, outFile: `${file}.outbox.json` });
  atomic(file, { ...receipt, message });
  return receipt.delivery === 'sent' ? 0 : 1;
}

// A separate launchd invocation can deliver even if the launcher has exited/crashed.
async function deadlineCheck() {
  if (Date.now() < deadlineAt()) { log(`deadline check: not due for ${day}`); return 0; }
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'deadline-status.json');
  const existing = read(file);
  if (existing?.delivery === 'sent') return 0;
  const claim = path.join(runDir, 'deadline-check.lock');
  if (!claimLock(claim)) { log('deadline check BLOCKED: another checker owns delivery (or owner is unknown)'); return 1; }
  try {
    const s = read(path.join(runDir, 'status.json'));
    if (s?.mode === 'dry' || s?.stage === 'finish' && s?.state === 'done') { log('deadline check: completed/dry run, no notification'); return 0; }
    const message = statusMessage(s);
    if (!existing || !['pending', 'launched'].includes(existing.delivery)) atomic(file, {
      ...existing, t: new Date().toISOString(), stage: s?.stage || 'gather', state: s?.state || 'blocked',
      attempt: s?.attempt || 0, worker: s?.worker || null, message });
    fs.writeFileSync(path.join(runDir, 'deadline-status.md'), message + '\n');
    log(`deadline: ${message}`);
    const pendingMessage = existing && ['pending', 'launched'].includes(existing.delivery) ? existing.message : null;
    return await deliverStatus(file, pendingMessage || message, `routing-nightly-review-${day}-status`);
  } finally { fs.rmSync(claim, { recursive: true }); }
}

let status, attemptDir, lastProgress;
function update(stage, state, note, worker = status?.worker || null) {
  const attempt = Number(path.basename(attemptDir).slice(8));
  const completed = stage === 'gather' && state === 'done' ? note : status?.attempt === attempt ? status.completed : '尚无完成步骤';
  status = { stage, state, t: new Date().toISOString(), mode, attempt, pid: process.pid, worker, note, completed };
  atomic(path.join(attemptDir, 'status.json'), status);
  atomic(path.join(runDir, 'status.json'), status);
  fs.appendFileSync(path.join(attemptDir, 'status.jsonl'), JSON.stringify(status) + '\n');
  log(`attempt ${status.attempt}: ${stage}/${state} ${note}`);
}

function progress() {
  if (!status || status.state !== 'running' || status.worker?.state !== 'running' || !['review', 'report'].includes(status.stage)) return;
  const p = read(path.join(attemptDir, 'progress.json'));
  if (p && ['review', 'report'].includes(p.stage) && p.t !== lastProgress && typeof p.note === 'string') {
    lastProgress = p.t;
    status.completed = p.note;
    update(p.stage, 'running', p.note);
  }
}

async function gather() {
  const d = path.join(attemptDir, 'data'); fs.mkdirSync(d);
  update('gather', 'running', '采集路由和资源证据');
  const jobs = [
    ['review-data.mjs', ['--hours', '24', '--json', '--cached'], 'review-data-24h.json'],
    ['review-data.mjs', ['--hours', '168', '--json', '--cached'], 'review-data-168h.json'],
    ['orch-usage.mjs', ['--hours', '24', '--json'], 'orch-usage-24h.json'],
    ['resource-review.mjs', ['--hours', '24'], 'resource-review-24h.txt'],
    ['resource-review.mjs', ['--hours', '24', '--json'], 'resource-review-24h.json'],
    ['resource-review.mjs', ['--hours', '96', '--json'], 'resource-review-96h.json'],
    ['resource-sample.mjs', ['--read-only', '--json'], 'resource-now.json'],
  ];
  for (const [name, args, out] of jobs) {
    const r = await command('node', [path.join(skill, 'scripts', name), ...args], { file: path.join(d, out), errFile: path.join(d, `${out}.err`) });
    if (r.code) {
      fs.appendFileSync(path.join(d, `${out}.err`), `UNKNOWN: exit ${r.code}\n`);
    }
  }
  await command('claude', ['agents', '--json'], { file: path.join(d, 'agents.json'), errFile: path.join(d, 'agents.err'), budgetMs: probeMs });
  // Freeze the full log so pre-window takes and queue starts can be paired.
  for (const name of ['log.tsv', 'resources.tsv']) {
    const text = readText(path.join(process.env.RULES_SHARED || path.dirname(dir), name));
    if (text != null) fs.writeFileSync(path.join(d, name), text);
    else fs.writeFileSync(path.join(d, `${name}.err`), 'UNKNOWN: resource history unavailable\n');
  }
  let roster = ''; try { roster = fs.readFileSync(path.join(process.env.RULES_SHARED || path.dirname(dir), 'orchestrators.txt'), 'utf8'); } catch {}
  fs.writeFileSync(path.join(d, 'roster.txt'), roster);
  update('gather', 'done', '路由和只读资源证据已采集；失败或缺失采样为 UNKNOWN');
  return d;
}

function compute(data) {
  const previousDay = new Date(`${day}T12:00:00`); previousDay.setDate(previousDay.getDate() - 1);
  const result = computeNightly({ day, review: read(path.join(data, 'review-data-24h.json')),
    resources: read(path.join(data, 'resource-review-24h.json')),
    usage: read(path.join(data, 'orch-usage-24h.json')),
    resourceLog: readText(path.join(data, 'log.tsv')), resourceRegistry: readText(path.join(data, 'resources.tsv')),
    now: read(path.join(data, 'review-data-24h.json'))?.collectedAt ?? Date.now(),
    previousUnknownClasses: read(path.join(dir, `${localDay(previousDay)}.metrics.json`))?.unknownClasses ?? [],
    evidence: { review: path.join(data, 'review-data-24h.json'), resources: path.join(data, 'resource-review-24h.json'),
      resourceLog: path.join(data, 'log.tsv'), resourceRegistry: path.join(data, 'resources.tsv'),
      weekly: path.join(data, 'review-data-168h.json'), usage: path.join(data, 'orch-usage-24h.json'), resourceHistory: path.join(data, 'resource-review-96h.json') } });
  atomic(path.join(attemptDir, 'metrics.json'), result);
  atomic(path.join(dir, `${day}.metrics.json`), result);
  fs.writeFileSync(path.join(attemptDir, 'script-report.md'), nightlyReport(result));
  fs.copyFileSync(path.join(attemptDir, 'script-report.md'), path.join(dir, `${day}.md`));
  process.stdout.write(metricTable(result) + '\n');
  return result;
}

function prompt(data) {
  const result = read(path.join(attemptDir, 'metrics.json')) ?? compute(data);
  return nightlyBrief(result, attemptDir);
}

const workerArgs = (commandName) => ['--account', status.worker.account, commandName];
async function workerStatus() {
  const r = await command('node', [path.join(skill, 'scripts/codex-worker.mjs'), ...workerArgs('status'), '--thread', status.worker.thread], { budgetMs: probeMs });
  try {
    const remote = r.code === 0 ? JSON.parse(r.stdout) : null;
    if (!['inProgress', 'completed', 'failed', 'interrupted', 'canceled', 'cancelled'].includes(remote?.last?.status)) return null;
    if ((remote.thread && remote.thread !== status.worker.thread) ||
        (remote.last.id && status.worker.turn && remote.last.id !== status.worker.turn)) return null;
    return remote;
  } catch { return null; }
}

async function followWorker(pick, data, resume = false, taskNotes = []) {
  const w = path.join(skill, 'scripts/codex-worker.mjs');
  if (!resume) update('review', 'running', '证据已采集，启动 hub worker',
    { account: pick.account, model: pick.model, effort: pick.effort,sandbox:pick.sandbox, thread: null, turn: null, state: 'running',
      out:workerPath(pick,'out',path.join(attemptDir,'codex-last.md')),
      log:workerPath(pick,'log',path.join(attemptDir,'codex.jsonl')) });
  if(!resume) brief(attemptDir,prompt(data));
  let first=!resume,args=resume?[...workerArgs('wait'),'--thread',status.worker.thread]:null;
  let completedSince;
  for (;;) {
    const started = Date.now();
    const r = await command(first?'sh':'node', first?['-c',pick.command]:[w, ...args, '--log',status.worker.log||path.join(attemptDir,'worker.jsonl'), '--out',status.worker.out||path.join(attemptDir,'worker-final.md')],
      { file: path.join(attemptDir, 'worker-launch.log'), monitor: async (isOpen) => {
        if (!status.worker.thread) return Date.now() - started >= probeMs ? { state: 'blocked', note: 'hub 启动未返回 thread 身份；只关闭启动客户端，不重复提交' } : null;
        const remote = await workerStatus();
        if (!isOpen()) return null;
        if (!remote?.last) return { state: 'blocked', note: 'hub 状态不可确认；只关闭 follower，保留 worker thread' };
        if (remote.last.status === 'inProgress') { completedSince = null; return null; }
        if (remote.last.status === 'completed') {
          if (!completedSince) {
            completedSince = Date.now();
            update('report', 'running', 'turn 已完成，follower 正在取回结果', { ...status.worker, state: 'done', resultPending: true });
          }
          return Date.now() - completedSince >= probeMs ? { state: 'failed', note: '已完成 turn 的结果读取无响应', remote } : null;
        }
        return { state: 'failed', note: `hub turn ${remote.last.status}`, remote };
      }, line: (line) => {
        const ids = /^thread=(\S+) turn=(\S+)/.exec(line);
        if (ids) update(status.stage, 'running', status.note, { ...status.worker, thread: ids[1], turn: ids[2] });
      } });
    first=false;
    if(r.code===0&&status.worker.out&&nonempty(status.worker.out)&&status.worker.out!==path.join(attemptDir,'worker-final.md'))
      fs.copyFileSync(status.worker.out,path.join(attemptDir,'worker-final.md'));
    progress();
    if (r.code === 0) { update('report', 'running', 'worker 已完成，校验报告和通知文件', { ...status.worker, state: 'done', resultPending: false }); return r; }
    if (r.observed?.state === 'blocked') {
      update(status.stage, 'blocked', r.observed.note, { ...status.worker, state: 'unknown' });
      return { ...r, blocked: true };
    }
    // Exit 4 is only the follower's stall alarm. Never interrupt or duplicate the accepted turn.
    if (status.worker.thread) {
      const remote = r.observed?.remote || await workerStatus();
      if (!remote?.last) {
        update(status.stage, 'blocked', 'hub 状态不可确认；保留 thread，禁止重复启动', { ...status.worker, state: 'unknown' });
        return { ...r, blocked: true };
      }
      if (remote.last.status === 'completed') {
        const fetches = (status.worker.resultFetchAttempts || 0) + 1;
        if (fetches > resultRetries) {
          update('report', 'failed', `turn 已完成，但 ${resultRetries} 次结果恢复均失败`,
            { ...status.worker, state: 'done', resultFetchAttempts: fetches, resultUnavailable: true });
          return { ...r, terminal: true };
        }
        update('report', 'running', `turn 已完成，结果恢复 ${fetches}/${resultRetries}`,
          { ...status.worker, state: 'done', resultPending: true, resultFetchAttempts: fetches });
        completedSince = null;
        await sleep(); args = [...workerArgs('wait'), '--thread', status.worker.thread]; continue;
      }
      if (remote.last.status === 'inProgress') {
        update(status.stage, 'running', 'follower 停止，worker 仍在运行；重新 wait', { ...status.worker, state: 'running' });
        await sleep(); args = [...workerArgs('wait'), '--thread', status.worker.thread]; continue;
      }
      r.text += '\n' + JSON.stringify(remote.last.error || remote.last.status);
    } else if (/connection closed|cannot reach|startup task|ECONN|hub connection/i.test(r.text)) {
      update('review', 'blocked', `启动接收状态未知，需要 owner 检查 hub，禁止重复启动：${r.text.slice(-500)}`, { ...status.worker, state: 'unknown' });
      return { ...r, blocked: true };
    }
    update('review', 'failed', `worker exit ${r.code}: ${r.text.slice(-1000)}`, { ...status.worker, state: 'failed' });
    return r;
  }
}

function reportReady() {
  const n = read(path.join(attemptDir, 'notify.json'));
  return nonempty(path.join(attemptDir, 'report.md')) && !!n && typeof n === 'object' && !Array.isArray(n);
}

async function waitDelivery(file, sessionFile) {
  let misses = 0;
  for (;;) {
    const receipt = read(file);
    if (receipt?.delivery === 'sent') return null;
    if (['failed', 'blocked'].includes(receipt?.delivery)) return { state: receipt.delivery, note: receipt.note || receipt.error || 'delivery failed' };
    const failed = await sessionLiveness(sessionFile);
    // A receipt can arrive while the final liveness probe is in flight.
    if (read(file)?.delivery === 'sent') return null;
    if (failed) {
      if (++misses >= livenessRetries) {
        atomic(file, { ...read(file), delivery: failed.state, note: failed.note });
        return failed;
      }
    } else misses = 0;
    await sleep();
  }
}

async function relaySecretary(message) {
  const ack = path.join(attemptDir, 'secretary-relay.json');
  const identity = path.join(attemptDir, 'secretary-relay-session.json');
  if (read(ack)?.delivery === 'sent') return;
  if (read(identity)) {
    const ended = await confirmSessionEnd(identity);
    if (!ended || ended.state === 'blocked') {
      const failed = await waitDelivery(ack, identity);
      if (failed) throw Error(failed.note);
      return;
    }
  }
  atomic(ack, { delivery: 'pending' });
  const r = await claude(`routing-nightly-review-${day}-secretary-${status.attempt}`,
    `Only relay the following single message to the secretary named ${message.recipient} through SendMessage. No review, edits, notification broadcast or user cards. Do not wait for decisions. After sending, run ${ackCommand(ack)}.\n${message.text}`, null, identity);
  if (r.code && read(ack)?.delivery !== 'sent') throw Error(r.observed?.note || 'secretary relay failed');
  const failed = await waitDelivery(ack, identity);
  if (failed) throw Error(failed.note);
}

async function finish() {
  const result = read(path.join(attemptDir, 'metrics.json'));
  if (!result) { update('report', 'failed', 'missing deterministic metrics'); return 1; }
  const analysisFile = path.join(attemptDir, 'report.md');
  if (result.needsModel && mode !== 'dry' && !reportReady()) { update('report', 'failed', 'worker 未产生 report.md / 有效 notify.json'); return 1; }
  const analysis = result.needsModel ? (mode === 'dry' ? fs.readFileSync(path.join(attemptDir, 'worker-final.md'), 'utf8') : fs.readFileSync(analysisFile, 'utf8')) : '';
  const report = nightlyReport(result, analysis);
  fs.writeFileSync(path.join(attemptDir, 'published-report.md'), report);
  fs.writeFileSync(path.join(dir, `${day}.md`), report);
  const notify = result.needsModel && mode !== 'dry' ? read(path.join(attemptDir, 'notify.json')) : { actions: [], decisions: [] };
  atomic(path.join(dir, `${day}.notify.json`), notify);
  if (mode === 'dry' || !result.findings.length) {
    atomic(path.join(attemptDir, 'delivery.json'), { delivery: 'sent', sent: [], note: 'script-only/dry report; no messages' });
    update('finish', 'done', '脚本表格已交付；无通知或 finisher'); return 0;
  }
  update('notify', 'running', '直接投递 worker-event inbox；决定交秘书');
  const rows = await recipients(path.dirname(result.metrics[0]?.evidence?.[0]?.split('#')[0] ?? path.join(attemptDir, 'data/review-data-24h.json')));
  const outbox = path.join(attemptDir, 'outbox.json');
  const plan = deliveryPlan(result, notify, rows, path.join(dir, `${day}.md`));
  atomic(outbox, plan);
  const receipt = await deliverNightly(plan, { day, outFile: outbox, relaySecretary });
  atomic(path.join(attemptDir, 'delivery.json'), receipt);
  if (receipt.delivery !== 'sent') { update('notify', 'blocked', receipt.note); return 1; }
  fs.appendFileSync(path.join(dir, `${day}.md`), `\nDelivery: ${receipt.sent.map(r => `${r.recipient}: ${r.delivery} (unconfirmed)`).join('; ') || 'no messages'}.\n`);
  update('finish', 'done', '报告和 inbox 已交付；秘书独立出卡'); return 0;
}

function newAttempt() {
  lastProgress = null;
  let n = 1; while (fs.existsSync(path.join(runDir, `attempt-${n}`))) n++;
  attemptDir = path.join(runDir, `attempt-${n}`); fs.mkdirSync(attemptDir);
  // Retain pre-migration day-level artifacts; never delete the evidence.
  if (n === 1) {
    const legacy = path.join(attemptDir, 'legacy'); fs.mkdirSync(legacy);
    for (const suffix of ['.md', '.notify.json', '.worker.jsonl', '.worker-final.md', '.data']) {
      const source = path.join(dir, day + suffix);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(legacy, day + suffix), { recursive: true });
    }
  }
  update('gather', 'running', '新 attempt，保留此前所有输出', null);
}

async function review() {
  if (!['auto', 'dry', 'plan', 'claude'].includes(mode)) throw Error(`unknown NIGHTLY_MODE: ${mode}`);
  fs.mkdirSync(dir, { recursive: true });
  if (mode === 'plan') {
    process.env.ROUTE_LOG = '0';
    log(`plan: review ${JSON.stringify(await route('analysis', ['--stakes', 'high']))}`);
    log('plan: model only for model-requiring findings or Monday; script-only imbalance advice goes directly to inbox, secretary relay only if needed'); return 0;
  }
  fs.mkdirSync(runDir, { recursive: true });
  const lock = path.join(runDir, 'launcher.lock');
  if (!claimLock(lock)) { log('final: blocked; another launcher owns this day (or owner is unknown)'); return 1; }
  let timer, progressTimer;
  try {
    const previous = read(path.join(runDir, 'status.json'));
    if (previous?.attempt) { attemptDir = path.join(runDir, `attempt-${previous.attempt}`); status = previous; }
    if (previous?.stage === 'finish' && previous.state === 'done' && process.env.NIGHTLY_RERUN !== '1') {
      log('already delivered; no same-day duplicate review'); return 0;
    }
    const due = deadlineAt();
    if (mode !== 'dry' && due > Date.now()) timer = setTimeout(() => deadlineCheck().catch((e) => log(`deadline check failed: ${e.message}`)), due - Date.now());
    progressTimer = setInterval(progress, pollMs);
    if (previous?.worker?.resultUnavailable && process.env.NIGHTLY_RERUN !== '1') {
      update('report', 'failed', '已完成 turn 的结果恢复已耗尽；需要 owner 决定，不能自动重复复盘'); return 1;
    }
    const pending = previous && ((previous.worker && ['running', 'unknown'].includes(previous.worker.state)) ||
      (['running', 'blocked'].includes(previous.state) && ['report', 'notify'].includes(previous.stage)));
    if (pending && previous.mode && previous.mode !== mode) { log('BLOCKED: cannot change mode of an unfinished attempt'); return 1; }
    if (previous?.stage === 'notify' && ['failed', 'blocked', 'running'].includes(previous.state)) return await finish();
    if (previous?.worker?.state === 'done' && previous.state === 'running' && previous.stage === 'report') {
      attemptDir = path.join(runDir, `attempt-${previous.attempt}`); status = previous;
      if (previous.worker.resultPending) {
        const r = await followWorker(null, null, true);
        if (r.code || r.blocked || r.terminal) return 1;
      }
      return await finish();
    }
    if (previous && ((previous.worker && ['running', 'unknown'].includes(previous.worker.state)) || (previous.stage === 'notify' && ['running', 'blocked'].includes(previous.state)))) {
      attemptDir = path.join(runDir, `attempt-${previous.attempt}`); status = previous;
      if (previous.stage === 'notify') return await finish(true);
      if (!previous.worker.thread) {
        const sessionFile = path.join(attemptDir, 'worker-session.json');
        if (read(sessionFile)) return await finishClaudeReview(sessionFile);
        update(previous.stage, 'blocked', '已有未确认的启动/Claude session；需要 owner 检查，不启动重复 worker'); return 1;
      }
      update(previous.stage, 'running', '重新接管原 hub thread；不创建重复 worker');
      const r = await followWorker(null, null, true);
      if (r.code || r.blocked) return 1;
      return await finish();
    }
    const excludeAccounts = (process.env.NIGHTLY_EXCLUDE || '').split(',').filter(Boolean);
    const excludeModels = (process.env.NIGHTLY_EXCLUDE_MODEL || '').split(',').filter(Boolean);
    let data, computed, rateRetry = false;
    for (let i = 0; i < 3; i++) {
      newAttempt();
      if (!data) data = await gather();
      else update('gather', 'done', `复用 ${data} 的证据；此前 attempt 已归档`);
      computed ??= compute(data);
      atomic(path.join(attemptDir, 'metrics.json'), computed);
      if (!computed.needsModel) return await finish();
      const forceClaude=mode==='claude'?['main',...Object.entries(read(process.env.CODEX_ACCOUNTS||path.join(os.homedir(),'.claude/orchestrator/_shared/codex-accounts.json'))||{})
        .filter(([,p])=>p?.kind!=='claude').map(([name])=>name),...(read(process.env.QUOTA_CACHE||path.join(os.homedir(),'.claude/orchestrator/_shared/quota.json'))?.codexAccounts||[])
        .filter(a=>a?.kind!=='claude').map(a=>a.name)]:[];
      const r = await route('analysis',
        ['--stakes', 'high',mode==='dry'?'--read-only':'--writes',
          ...([...new Set([...excludeAccounts,...forceClaude])].length ? ['--exclude-account',[...new Set([...excludeAccounts,...forceClaude])].join(',')] : []),
          ...(excludeModels.length ? ['--exclude-model', excludeModels.join(',')] : []), ...(userOK?['--urgent','--user-ok',userOK]:[])],
        `routing-nightly-review-${day}-attempt-${status.attempt}`);
      atomic(path.join(attemptDir, 'route.json'), r);
      const pick = r.pick;
      if (!launchable(r)) { update('review', 'blocked', `路由未批准启动：${r.deferred||r.needsUserOK?.join('; ')||r.kind||'no executable seat'}`,
        pick?{account:pick.account||pick.vendor,model:pick.model,effort:pick.effort,sandbox:pick.sandbox,thread:null,state:'not-started'}:null);return 1; }
      const accountsFile = process.env.CODEX_ACCOUNTS || path.join(os.homedir(), '.claude/orchestrator/_shared/codex-accounts.json');
      const kind = read(accountsFile)?.[pick.account]?.kind;
      log(`route: ${pick.model} ${pick.effort} on ${pick.account || pick.vendor} (${kind || pick.vendor})`);
      if (pick.vendor === 'claude') {
        update('review', 'running', '启动条件满足；路由批准的 Claude 分析',
          { account: 'claude', model: pick.model, effort: pick.effort, thread: null, state: 'running' });
        const ack = path.join(attemptDir, 'analysis-delivery.json');
        const sessionFile = path.join(attemptDir, 'worker-session.json');
        const launched = await claude(`routing-nightly-review-${day}-attempt-${status.attempt}`,
          prompt(data) + ` After analysis/notify artifacts exist run ${ackCommand(ack)}. No messages or user cards. ` +
          `On failure write ${quote(ack)} as JSON {"delivery":"failed","note":"<reason>"}.`, r, sessionFile);
        if (launched.code && read(ack)?.delivery !== 'sent') {
          update('review', launched.observed?.state || 'failed', launched.observed?.note || launched.text,
            { ...status.worker, state: launched.observed?.state === 'blocked' ? 'unknown' : 'failed' }); return 1;
        }
        return await finishClaudeReview(sessionFile);
      }
      const result = await followWorker(pick, data, false, r.notes??[]);
      if (result.blocked || result.terminal) return 1;
      if (!result.code && (mode === 'dry' || reportReady())) return await finish();
      if (!result.code) update('report', 'failed', 'worker 完成但未产生报告/notify');
      if (/security-policy-block|cyberPolicy/i.test(result.text)) {
        update('review', 'blocked', 'policy block：需要 --adversarial 人工重路由，不重试 GPT'); return 1;
      }
      if (kind === 'ttadk' && /rate-limited:/.test(result.text) && !rateRetry) { rateRetry = true; continue; }
      if (/quota-exhausted:|proxy-unavailable:|not logged in|unauthori[sz]ed|login (required|expired)|\b401\b/i.test(result.text) ||
          (kind === 'ttadk' && /rate-limited:/.test(result.text))) excludeAccounts.push(pick.account);
      else excludeModels.push(pick.model.toLowerCase());
      // The hub already records provider failures with the concrete model; do not record it twice.
      log(`re-route: exclude models=${excludeModels.join(',')} accounts=${excludeAccounts.join(',')}`);
    }
    update(status.stage, 'failed', '3 个 attempts 均未产生完整报告'); return 1;
  } catch (e) {
    if (!attemptDir) throw e;
    update(status?.stage || 'gather', 'failed', e.message); return 1;
  } finally {
    clearTimeout(timer); clearInterval(progressTimer);
    if (mode !== 'dry' && attemptDir && ['failed', 'blocked'].includes(status?.state)) {
      const result = read(path.join(attemptDir, 'metrics.json'));
      if (result && !result.needsModel && result.findings.some(f => f.scriptOnly)) {
        log('script-only finding delivery blocked; retain status/report without a model relay');
      } else {
        try {
          await deliverStatus(path.join(attemptDir, 'failure-status.json'), statusMessage(status),
            `routing-nightly-review-${day}-attempt-${status.attempt}-failure`);
        } catch (e) { log(`failure notification blocked: ${e.message}`); }
      }
    }
    log(`final: ${status?.stage || 'gather'}/${status?.state || 'blocked'}; report=${attemptDir ? nonempty(path.join(attemptDir, 'published-report.md')) || reportReady() : false}`);
    fs.rmSync(lock, { recursive: true });
  }
}

async function finishClaudeReview(sessionFile) {
  const failed = await waitDelivery(path.join(attemptDir, 'analysis-delivery.json'), sessionFile);
  if (failed || !reportReady()) {
    update(failed ? 'review' : 'report', failed?.state || 'failed', failed?.note || 'Claude 未产生分析',
      { ...status.worker, state: failed?.state === 'blocked' ? 'unknown' : 'failed' }); return 1;
  }
  update('report', 'done', 'Claude analysis ready', { ...status.worker, state: 'done' });
  return await finish();
}

const [cmd, ...args] = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
function logCommand() {
  const file = arg('--file');
  if (cmd === 'scan-log') return { findings: scanLogFindings(readLogText(file, checkedLogStat(file)), { jsonl: file.endsWith('.jsonl') }) };
  return redactLogFile(file, { force: args.includes('--force') });
}

if (cmd === 'scan-log' || cmd === 'redact-log') {
  try { console.log(JSON.stringify(logCommand())); }
  catch (e) { console.error(e.code ? 'worker log I/O failed' : e.message); process.exitCode = 1; }
} else if (cmd === 'ack') {
  const file = arg('--file'); if (!file || !path.isAbsolute(file)) throw Error('ack requires --file ABSOLUTE_PATH');
  atomic(file, { ...read(file), delivery: 'sent', sentAt: new Date().toISOString() });
} else if (cmd === 'progress') {
  const a = arg('--attempt-dir'), stage = arg('--stage'), note = arg('--note');
  if (!a || !path.isAbsolute(a) || !['review', 'report'].includes(stage) || !note) throw Error('progress needs --attempt-dir, --stage review|report, --note');
  atomic(path.join(a, 'progress.json'), { stage, note, t: new Date().toISOString() });
} else {
  try {
    if (cmd && cmd !== '--deadline-check') throw Error(`unknown nightly command: ${cmd}`);
    process.exitCode = await (cmd === '--deadline-check' ? deadlineCheck() : review());
  }
  catch (e) {
    if (attemptDir) update(status?.stage || 'gather', 'failed', e.message);
    log(`final: failed ${e.message}`); process.exitCode = 1;
  }
}
