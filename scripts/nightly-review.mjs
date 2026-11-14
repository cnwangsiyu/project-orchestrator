#!/usr/bin/env node
// No worker wall-clock limit. Hub follower exits are not necessarily turn failures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(skill, 'scripts/nightly-review.mjs');
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dir = process.env.NIGHTLY_DIR || path.join(os.homedir(), '.claude/orchestrator/_shared/routing-review');
const day = process.env.NIGHTLY_DAY || localDay();
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('NIGHTLY_DAY must be YYYY-MM-DD');
const runDir = path.join(dir, `${day}.run`);
const mode = process.env.NIGHTLY_MODE || 'auto';
const personalOK = process.env.NIGHTLY_PERSONAL_OK === '1';
const pollMs = Math.max(50, Number(process.env.NIGHTLY_POLL_MS) || 5000);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
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
  // Serialize stale-owner recovery too; two reclaimers must not remove a new owner's lock.
  const guard = `${lock}.claim`;
  try { fs.mkdirSync(guard); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try {
    if (fs.existsSync(lock)) {
      const pid = read(path.join(lock, 'owner.json'))?.pid;
      if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) return false;
      fs.rmSync(lock, { recursive: true });
    }
    fs.mkdirSync(lock); atomic(path.join(lock, 'owner.json'), { pid: process.pid }); return true;
  } finally {
    fs.rmdirSync(guard);
  }
}

async function command(exe, args, { file, errFile, line } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', pending = '', stdout = '';
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
    child.on('close', (code, signal) => { if (pending) line?.(pending); resolve({ code: code ?? 1, signal, text: tail, stdout }); });
  });
}

async function route(category, extra = [], name = `routing-nightly-review-${day}`) {
  const r = await command('node', [path.join(skill, 'scripts/route.mjs'), category, ...extra, '--json',
    '--project', 'routing', '--name', name, '--cwd', dir]);
  try { return r.code === 0 ? JSON.parse(r.stdout) : { deferred: r.text }; }
  catch { return { deferred: r.text || 'invalid route response' }; }
}

async function claude(name, prompt, pick) {
  const r = pick ? { pick } : await route('claude-tools', [], name);
  if (!r.pick || r.pick.vendor !== 'claude' || (r.needsUserOK || []).length) return { code: 1, text: 'notification route blocked' };
  return command('claude', ['--bg', '--remote-control', '--permission-mode', 'bypassPermissions', '-n', name,
    '--model', r.pick.model, '--effort', r.pick.effort, prompt]);
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
  const worker = w === 'running' ? 'worker 仍在运行' : w === 'failed' ? 'worker 已失败' : w === 'done' ? 'worker 已完成，通知待交付' : 'worker 状态未知/未启动';
  return `夜间复盘未完成：卡在 ${s?.stage || 'gather'}，已做 ${s?.completed || s?.note || '未找到当日启动记录'}，${worker}（${s?.state || 'blocked'}：${s?.note || '无启动记录'}）。`;
}

// A separate launchd invocation can deliver even if the launcher has exited/crashed.
async function deadlineCheck() {
  if (Date.now() < deadlineAt()) { log(`deadline check: not due for ${day}`); return 0; }
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'deadline-status.json');
  const existing = read(file);
  if (existing && ['launched', 'sent'].includes(existing.delivery)) return 0;
  const claim = path.join(runDir, 'deadline-check.lock');
  if (!claimLock(claim)) { log('deadline check BLOCKED: another checker owns delivery (or owner is unknown)'); return 1; }
  try {
    const s = read(path.join(runDir, 'status.json'));
    if (s?.mode === 'dry') { log('deadline check: dry run, no notification'); return 0; }
    const message = statusMessage(s);
    atomic(file, { t: new Date().toISOString(), stage: s?.stage || 'gather', state: s?.state || 'blocked',
      attempt: s?.attempt || 0, worker: s?.worker || null, message, delivery: 'pending' });
    fs.writeFileSync(path.join(runDir, 'deadline-status.md'), message + '\n');
    log(`deadline: ${message}`);
    const result = await claude(`routing-nightly-review-${day}-status`,
      `只做通知，不复盘、不启新 worker、不询问个人额度。先用 PushNotification 向用户发送以下中文状态：${message}\n` +
      `成功发送后运行 ${ackCommand(file)}，然后结束。未发送成功不要写 ack。`);
    const latest = read(file);
    if (latest?.delivery !== 'sent') atomic(file, { ...latest, delivery: result.code === 0 ? 'launched' : 'failed', error: result.code ? result.text : null });
    log(`deadline notification ${read(file)?.delivery}; launcher exit ${result.code}`);
    return result.code;
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
  if (!status || status.state !== 'running' || !['review', 'report'].includes(status.stage)) return;
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
    ['review-data.mjs', ['--hours', '24'], 'review-data-24h.txt'],
    ['review-data.mjs', ['--hours', '168'], 'review-data-168h.txt'],
    ['orch-usage.mjs', ['--hours', '24'], 'orch-usage-24h.txt'],
    ['resource-review.mjs', ['--hours', '24'], 'resource-review-24h.txt'],
    ['resource-review.mjs', ['--hours', '24', '--json'], 'resource-review-24h.json'],
    ['resource-review.mjs', ['--hours', '96', '--json'], 'resource-review-96h.json'],
    ['resource-sample.mjs', ['--read-only', '--json'], 'resource-now.json'],
  ];
  for (const [name, args, out] of jobs) {
    const r = await command('node', [path.join(skill, 'scripts', name), ...args], { file: path.join(d, out), errFile: path.join(d, `${out}.err`) });
    if (r.code) fs.appendFileSync(path.join(d, `${out}.err`), `UNKNOWN: exit ${r.code}\n`);
  }
  update('gather', 'done', '路由和只读资源证据已采集；失败或缺失采样为 UNKNOWN');
  return d;
}

function prompt(data) {
  const instructions = `You are the worker of the nightly routing review for the 24 hours ending ${new Date().toString()}. ` +
    `Read ${skill}/references/nightly-review.md and follow the worker part of "Who does what". ` +
    `The data is already gathered in ${data}: review-data-24h.txt, review-data-168h.txt, orch-usage-24h.txt. ` +
    `Machine resources: resource-review-24h.txt/.json, resource-review-96h.json, resource-now.json and adjacent .err files. ` +
    `Missing/failed evidence is UNKNOWN. No process/file cleanup or agent installation. `;
  if (mode === 'dry') return instructions + 'DRY RUN: read-only; no edits, commits or pushes. Your final answer is the report.';
  return instructions + `For this attempt use ${attemptDir}/report.md and ${attemptDir}/notify.json, NOT the day-level output paths. ` +
    `Read prior attempts/drafts in ${runDir} before repeating work. Do not redo fixes already committed by a prior attempt. ` +
    `Write the report draft AND notify.json BEFORE optional deep dives. Commit/push fixes only AFTER the report draft exists. ` +
    `Record progress after each useful milestone with node ${quote(script)} progress --attempt-dir ${quote(attemptDir)} ` +
    `--stage review --note '<short Chinese progress>'; use --stage report when drafting. ` +
    `Keep both files up to date, and leave notifications to the finisher.`;
}

const workerArgs = (commandName) => ['--account', status.worker.account, commandName];
async function workerStatus() {
  const r = await command('node', [path.join(skill, 'scripts/codex-worker.mjs'), ...workerArgs('status'), '--thread', status.worker.thread]);
  try { return r.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
}

async function followWorker(pick, data, resume = false) {
  const w = path.join(skill, 'scripts/codex-worker.mjs');
  if (!resume) update('review', 'running', '证据已采集，启动 hub worker',
    { account: pick.account || 'main', model: pick.model, effort: pick.effort, thread: null, turn: null, state: 'running' });
  let args = resume ? [...workerArgs('wait'), '--thread', status.worker.thread] :
    [...workerArgs('start'), '--cwd', dir, '--sandbox', mode === 'dry' ? 'read-only' : 'danger-full-access',
      '--effort', pick.effort, '--model', pick.model, '--name', `routing-nightly-review-${day}-attempt-${status.attempt}`,
      ...(personalOK ? ['--user-ok', 'NIGHTLY_PERSONAL_OK=1'] : []), prompt(data)];
  for (;;) {
    const r = await command('node', [w, ...args, '--log', path.join(attemptDir, 'worker.jsonl'), '--out', path.join(attemptDir, 'worker-final.md')],
      { file: path.join(attemptDir, 'worker-launch.log'), line: (line) => {
        const ids = /^thread=(\S+) turn=(\S+)/.exec(line);
        if (ids) update(status.stage, 'running', status.note, { ...status.worker, thread: ids[1], turn: ids[2] });
      } });
    progress();
    if (r.code === 0) { update('report', 'running', 'worker 已完成，校验报告和通知文件', { ...status.worker, state: 'done' }); return r; }
    // Exit 4 is only the follower's stall alarm. Never interrupt or duplicate the accepted turn.
    if (status.worker.thread) {
      const remote = await workerStatus();
      if (!remote?.last) {
        update(status.stage, 'blocked', 'hub 状态不可确认；保留 thread，禁止重复启动', { ...status.worker, state: 'unknown' });
        return { ...r, blocked: true };
      }
      if (remote.last.status === 'inProgress' || remote.last.status === 'completed') {
        update(status.stage, 'running', remote.last.status === 'inProgress' ? 'follower 停止，worker 仍在运行；重新 wait' : '重新读取已完成 turn');
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

async function waitDelivery(file) {
  while (!read(file)) await sleep();
  return read(file)?.delivery === 'sent';
}

async function finish(resume = false) {
  if (mode === 'dry') {
    if (!nonempty(path.join(attemptDir, 'worker-final.md'))) { update('report', 'failed', 'worker 未产生 dry 报告'); return 1; }
    update('finish', 'done', 'dry 报告已交付；未启动 finisher'); return 0;
  }
  if (!reportReady()) { update('report', 'failed', 'worker 未产生 report.md / 有效 notify.json'); return 1; }
  const ack = path.join(attemptDir, 'delivery.json');
  if (!resume) {
    update('report', 'done', '报告和 notify.json 已写入归档 attempt');
    fs.copyFileSync(path.join(attemptDir, 'report.md'), path.join(dir, `${day}.md`));
    fs.copyFileSync(path.join(attemptDir, 'notify.json'), path.join(dir, `${day}.notify.json`));
    update('notify', 'running', '报告已产生，等待 finisher 通知回执');
    const r = await claude(`routing-nightly-review-${day}-finish-${status.attempt}`,
      `Finish the nightly routing review for ${day}: read ${skill}/references/nightly-review.md, "Who does what" (finisher) ` +
      `and "Decisions for the user", then ${attemptDir}/report.md and ${attemptDir}/notify.json. Follow the checks and notify orchestrators. ` +
      `Keep all edits and optional decisions in this attempt (${attemptDir}/report.md and ${attemptDir}/decisions.json), never another attempt's files. ` +
      `Send a Chinese PushNotification to the user even with no changes: 「夜间复盘已完成：${day}，报告 ${dir}/${day}.md」。` +
      `After checks and notifications succeed, run ${ackCommand(ack)} BEFORE waiting for optional decision cards. ` +
      `If blocked/failed, write ${quote(ack)} as JSON {"delivery":"failed","note":"<reason>"} instead. ` +
      `Never claim completion without delivering notifications. Do not stop any earlier sessions.`);
    if (r.code) { update('notify', 'failed', `finisher launcher exit ${r.code}: ${r.text}`); return 1; }
  }
  if (!await waitDelivery(ack)) { update('notify', 'failed', read(ack)?.note || 'finisher failed'); return 1; }
  fs.copyFileSync(path.join(attemptDir, 'report.md'), path.join(dir, `${day}.md`));
  update('notify', 'done', 'finisher 通知已确认');
  update('finish', 'done', '报告和通知已交付；用户决定卡片独立等待'); return 0;
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
    log(`plan: finisher ${JSON.stringify(await route('claude-tools'))}`); return 0;
  }
  fs.mkdirSync(runDir, { recursive: true });
  const lock = path.join(runDir, 'launcher.lock');
  if (!claimLock(lock)) { log('final: blocked; another launcher owns this day (or owner is unknown)'); return 1; }
  let timer, progressTimer;
  try {
    if (mode !== 'dry') timer = setTimeout(() => deadlineCheck().catch((e) => log(`deadline check failed: ${e.message}`)), Math.max(0, deadlineAt() - Date.now()));
    progressTimer = setInterval(progress, pollMs);
    const previous = read(path.join(runDir, 'status.json'));
    const pending = previous && ((previous.worker && ['running', 'unknown'].includes(previous.worker.state)) ||
      (previous.state === 'running' && ['report', 'notify'].includes(previous.stage)));
    if (pending && previous.mode && previous.mode !== mode) { log('BLOCKED: cannot change mode of an unfinished attempt'); return 1; }
    if (previous?.stage === 'notify' && previous.state === 'failed' && previous.worker?.state === 'done') {
      const source = path.join(runDir, `attempt-${previous.attempt}`);
      newAttempt();
      for (const name of ['report.md', 'notify.json']) fs.copyFileSync(path.join(source, name), path.join(attemptDir, name));
      update('report', 'done', `复用 ${source} 的报告；只重试通知，不重复复盘/fixes`, previous.worker);
      return await finish();
    }
    if (previous?.worker?.state === 'done' && previous.state === 'running' && previous.stage === 'report') {
      attemptDir = path.join(runDir, `attempt-${previous.attempt}`); status = previous;
      return await finish();
    }
    if (previous && ((previous.worker && ['running', 'unknown'].includes(previous.worker.state)) || (previous.stage === 'notify' && previous.state === 'running'))) {
      attemptDir = path.join(runDir, `attempt-${previous.attempt}`); status = previous;
      if (previous.stage === 'notify') return await finish(true);
      if (!previous.worker.thread) { update(previous.stage, 'blocked', '已有未确认的启动/Claude session；需要 owner 检查，不启动重复 worker'); return 1; }
      update(previous.stage, 'running', '重新接管原 hub thread；不创建重复 worker');
      const r = await followWorker(null, null, true);
      if (r.code || r.blocked) return 1;
      return await finish();
    }
    const excludeAccounts = (process.env.NIGHTLY_EXCLUDE || '').split(',').filter(Boolean);
    const excludeModels = (process.env.NIGHTLY_EXCLUDE_MODEL || '').split(',').filter(Boolean);
    let data, rateRetry = false;
    for (let i = 0; i < 3; i++) {
      newAttempt();
      if (!data) data = await gather();
      else update('gather', 'done', `复用 ${data} 的证据；此前 attempt 已归档`);
      const r = mode === 'claude' ? { pick: { vendor: 'claude', model: 'opus', effort: 'high' } } : await route('analysis',
        ['--stakes', 'high', ...(excludeAccounts.length ? ['--exclude-account', excludeAccounts.join(',')] : []),
          ...(excludeModels.length ? ['--exclude-model', excludeModels.join(',')] : []), ...(personalOK ? ['--urgent'] : [])]);
      atomic(path.join(attemptDir, 'route.json'), r);
      const pick = r.pick;
      if (!pick) { update('review', 'blocked', `无可用路由：${r.deferred || 'no pick'}`); return 1; }
      const accountsFile = process.env.CODEX_ACCOUNTS || path.join(os.homedir(), '.claude/orchestrator/_shared/codex-accounts.json');
      const kind = read(accountsFile)?.[pick.account]?.kind;
      log(`route: ${pick.model} ${pick.effort} on ${pick.account || pick.vendor} (${kind || pick.vendor})`);
      if ((!['ttadk', 'trae'].includes(kind) || (r.needsUserOK || []).length) && !personalOK) {
        update('review', 'blocked', `仅个人额度/审批路由可用：${pick.model} ${pick.effort} on ${pick.account || pick.vendor}；需要用户 OK，不自动打开 ask session`,
          { account: pick.account || pick.vendor, model: pick.model, effort: pick.effort, thread: null, state: 'not-started' }); return 1;
      }
      if (pick.vendor === 'claude') {
        update('review', 'running', '个人额度已批准，启动完整 Claude 复盘',
          { account: 'claude', model: pick.model, effort: pick.effort, thread: null, state: 'running' });
        const ack = path.join(attemptDir, 'delivery.json');
        const launched = await claude(`routing-nightly-review-${day}-attempt-${status.attempt}`,
          prompt(data) + ` Do the finisher's part as well, including a Chinese completion PushNotification. After report/notify and notifications succeed run ${ackCommand(ack)}. ` +
          `On failure write ${quote(ack)} as JSON {"delivery":"failed","note":"<reason>"}.`, pick);
        if (launched.code) { update('review', 'failed', launched.text, { ...status.worker, state: 'failed' }); return 1; }
        if (!await waitDelivery(ack) || !reportReady()) {
          update('report', 'failed', 'Claude 未产生报告和通知回执', { ...status.worker, state: 'failed' }); return 1;
        }
        fs.copyFileSync(path.join(attemptDir, 'report.md'), path.join(dir, `${day}.md`));
        fs.copyFileSync(path.join(attemptDir, 'notify.json'), path.join(dir, `${day}.notify.json`));
        update('finish', 'done', 'Claude 报告和通知已交付', { ...status.worker, state: 'done' }); return 0;
      }
      const result = await followWorker(pick, data);
      if (result.blocked) return 1;
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
  } finally {
    clearTimeout(timer); clearInterval(progressTimer);
    log(`final: ${status?.stage || 'gather'}/${status?.state || 'blocked'}; report=${attemptDir ? reportReady() : false}`);
    fs.rmSync(lock, { recursive: true });
  }
}

const [cmd, ...args] = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (cmd === 'ack') {
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
