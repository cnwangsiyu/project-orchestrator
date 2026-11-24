import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { maskLogText } from '../lib/nightly-audit.mjs';

const projectSettings = JSON.parse(await fs.readFile(new URL('./projects.json', import.meta.url), 'utf8'));
export const projects = Object.fromEntries(Object.entries(projectSettings).map(([id, row]) => [id, row.label]));
const deviceNames = { iphone11: 'iPhone 11', iphone8: 'iPhone 8', s21: 'S21' };
const quotaScript = fileURLToPath(new URL('../quota.mjs', import.meta.url));
const exec = promisify(execFile);
export const pools = ['devbox-cn', 'devbox-cn-light', 'local', 'local-light', 'local-build', 'mini2'];
export const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const boardError = (message) => Object.assign(new Error(message), { boardMessage: message });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const string = (value) => typeof value === 'string' ? value : '';
const taskKey = ({ project, task }) => key(project, task);
const nameKey = ({ project, name }) => key(project, name);
export const ticket = (value) => /^([WT]\d+[a-z]?)(?=$|[-_\s])/.exec(value ?? '')?.[1];
const rows = (value, label) => { if (!Array.isArray(value)) throw boardError(`${label} 格式无法识别`); return value; };
const record = (value, label) => { if (!object(value)) throw boardError(`${label} 格式无法识别`); return value; };

export function iso(value) {
  if (typeof value === 'number' && value > 0 && value < 1e11) value *= 1000;
  const date = new Date(value ?? NaN);
  return Number.isFinite(+date) ? date.toISOString() : null;
}

export function sanitize(text) {
  return maskLogText(text).text
    .replace(/\b(?:https?|ssh|sftp):\/\/[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/\b(?:[\w.%+\-]+)@[\w.-]+/g, '[已隐藏]')
    .replace(/[\da-f:.]*:[\da-f:.]+(?:%[\w.-]+)?/gi, (part) => isIP(part) === 6 ? '[已隐藏]' : part)
    .replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, '[已隐藏]')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:local|internal|corp|lan)\b/gi, '[已隐藏]')
    .replace(/\b(?:udid|serial(?:\s+number)?|imei|device[-_ ]?id)["']?\s*[:=]?\s*["']?[\w-]+/gi, '[设备标识已隐藏]')
    .replace(/\b(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|[a-f\d]{8}-[a-f\d]{16}|[a-f\d]{32,}|\d{15,16})\b/gi, '[已隐藏]')
    .replace(/\b[\dA-Z]{10,20}\b/g, (part) => /\d/.test(part) && /[A-Z]/.test(part) ? '[已隐藏]' : part)
    .replace(/\b(?:iphone\s*15\s*(?:pm|pro\s*max)|ask[-_ ]user)\b/gi, '不可用');
}

// Run only fixed read commands. Capture stderr without publishing it; many
// status diagnostics contain machine addresses or local filesystem paths.
async function run(command, args, signal) {
  const { stdout } = await exec(command, args, { signal, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
async function jsonFile(file, signal, { optional = false } = {}) {
  try { return JSON.parse(await fs.readFile(file, { encoding: 'utf8', signal })); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function ndjson(file, signal, visit, { optional = false, strict = false, invalid } = {}) {
  const input = createReadStream(file, { signal, encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch (error) { if (invalid) { invalid(); continue; } if (strict) throw error; continue; }
      if (object(row)) visit(row);
      else if (invalid) invalid();
      else if (strict) throw boardError('记录格式无法识别');
    }
  } catch (error) { if (!optional || error.code !== 'ENOENT') throw error; }
  finally { lines.close(); input.destroy(); }
}

function worker(row, state, startedAt = row.startedAt) {
  const project = string(row.project) || 'general';
  const task = string(row.task) || string(row.name) || '未命名任务';
  const name = string(row.name) || task;
  const account = string(row.account);
  const queue = row.queue ?? {};
  return {
    id: key(account, row.runId ?? row.thread ?? name), taskRef: key(project, task), routeRef: key(project, name),
    project, task, name, owner: !string(row.owner) ? null : /^[\w-]{30,}$/.test(row.owner) ?
      (Object.hasOwn(projects, project) ? `${projects[project]} 主对话` : '负责会话') : row.owner,
    account, model: string(row.actualModel) || string(row.model), effort: string(row.effort), state,
    startedAt: iso(startedAt), lastActivityAt: iso(row.lastActivityAt), queueSince: iso(queue.since ?? queue.queuedAt ?? queue.at),
    queuePosition: number(queue.position), queueState: string(queue.state), queueStalled: Boolean(row.queueStalled),
    queueDrainPerMinute: number(queue.drainPerMin), queueWorkedMinutes: number(queue.workedMinutesBefore),
    runningTools: number(queue.runningTools ?? row.runningTools) ?? 0,
  };
}
export function parseWorkers(data) {
  return rows(data?.threads, 'worker').map((row) => worker(row,
    row.queueStalled ? 'stalled' : ['queued', 'waiting'].includes(row.queue?.state) ? 'queued' : 'running'));
}

export function parseQuota(data, fallback = false, now = Date.now()) {
  record(data, '额度');
  const account = (name) => data.codexAccounts?.find((a) => a.name === name);
  const main = fallback ? account('main') : data.codex?.find((a) => a.name === 'main');
  const trae = fallback ? account('trae') : data.trae;
  const ttadk = fallback ? account('ttadk') : data.ttadk;
  const weekly = (list) => (list ?? []).filter((w) => !w.scoped && w.windowMins >= 7 * 24 * 60)
    .sort((a, b) => b.windowMins - a.windowMins)[0];
  const mainWeek = fallback ? weekly(main?.windows) : main?.week;
  const claudeWeek = fallback ? weekly(data.claude) : data.claude?.week;
  const meter = (id, label, row, extra = {}) => {
    const resetsAt = iso(row?.resetsAt);
    const expired = resetsAt && Date.parse(resetsAt) <= now;
    const percent = number(row?.percent);
    return { id, label, percent, resetsAt, expired: Boolean(expired),
      exhausted: !expired && (row?.depleted === true || percent >= 100), ...extra };
  };
  const t = ttadk?.usage;
  const items = [meter('ttadk', 'TTADK 今日', { ...t, percent: t?.limit > 0 ? 100 * t.used / t.limit : t?.utilization,
    resetsAt: t?.resetsAt ?? ttadk?.quotaOut?.resetsAt, depleted: !!ttadk?.quotaOut })];
  for (const [model, bucket] of Object.entries(trae?.quota?.daily ?? {})) {
    const label = model === 'gpt_6_2' ? 'gpt-6.2-sol' : model;
    items.push(meter(`trae-${label}`, `TRAE ${label} 今日高优先级`, { ...bucket,
      percent: number(bucket.used) !== null && bucket.limit > 0 ? 100 * bucket.used / bucket.limit : null }));
  }
  items.push(meter('main', '个人 main 本周', { ...mainWeek, percent: mainWeek?.used }, { resetCards: number(main?.resets?.count) }));
  items.push(meter('claude', 'Claude 本周', { ...claudeWeek, percent: claudeWeek?.used }));
  if (items.every((row) => row.percent === null && !row.resetsAt) && !data.hubs?.length) throw boardError('没有可读的额度数据');
  const hubs = ['ttadk', 'trae', 'main', 'b'].map((name) => {
    const state = fallback ? account(name)?.healthState : data.hubs?.find((h) => h.account === name)?.state;
    return { name, state: ['up', 'down', 'degraded'].includes(state) ? state : 'unknown' };
  });
  return { items, hubs, checkedAt: iso(data.checkedAt), fallback };
}

function lease(id, row) {
  const held = row.held ?? ['held', 'pending', 'stale'].includes(row.state);
  const since = iso(row.since);
  const relative = /^\+(\d+)m$/.exec(row.until ?? '');
  const until = relative && since ? iso(Date.parse(since) + Number(relative[1]) * 60_000) : iso(row.until);
  return { id, held, holder: held ? string(row.holder) : '', project: held ? string(row.project) : '',
    task: held ? string(row.task) : '', since: held ? since : null, until: held ? until : null,
    state: ['pending', 'stale'].includes(row.state) ? row.state : held ? 'held' : 'free' };
}

export function parseStatus(text) {
  const cleanLink = (link) => ['connected', 'not seen', 'offline', 'unauthorized', 'unknown', '-'].includes(link) ? link : 'unknown';
  if (/^\s*[\[{]/.test(text)) {
    const json = JSON.parse(text);
    return rows(json.rows ?? json.resources ?? json, '资源状态').map((row) => ({ ...lease(row.id, row),
      kind: row.kind, policy: row.policy, link: cleanLink(row.link) }));
  }
  const result = [];
  if (!/^ID\s+KIND\s+POLICY\s+LINK\s+HOLDER\b/m.test(text)) throw boardError('资源状态格式无法识别');
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+(device|slot|remote)\s+(\S+)\s+(not seen|\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, id, kind, policy, link, detail] = m;
    if (kind === 'device' && !Object.hasOwn(deviceNames, id)) continue;
    let item = {};
    if (detail.startsWith('CLEANUP PENDING')) item.state = 'pending';
    else if (!detail.startsWith('FREE')) {
      const hold = /^(?:(STALE\S*(?: \([^)]*\))?|PENDING)\s+)?(.*?)\s+\(([^\s/)]+)(?:\/([^\s)]+))?\)\s+(.+?)\s+→\s+(.+?)(?:\s+·\s+|$)/.exec(detail);
      item = hold ? { state: hold[1]?.startsWith('STALE') ? 'stale' : hold[1] ? 'pending' : 'held',
        holder: hold[2], project: hold[3], task: hold[4], since: hold[5], until: hold[6] } : { state: 'held' };
    }
    result.push({ ...lease(id, item), kind, policy, link: cleanLink(link) });
  }
  return result;
}

export function parseCards(events, now, malformed = 0) {
  const cards = new Map();
  for (const row of events) {
    if (!row.id || !iso(row.at)) continue;
    const at = iso(row.at);
    if (Date.parse(at) > now || !['asked', 'answered', 'withdrawn'].includes(row.event)) continue;
    const state = cards.get(row.id) ?? { asked: null, latest: null };
    if (row.event === 'asked' && (!state.asked || state.asked.at < at)) state.asked = { ...row, at };
    if (!state.latest || state.latest.at < at) state.latest = { ...row, at };
    cards.set(row.id, state);
  }
  const detail = ({ asked, latest }) => ({ title: string(asked?.title) || '待确认事项', project: string(asked?.project),
    at: asked?.at ?? latest.at, default: string(asked?.default), defaultAt: iso(asked?.defaultAt),
    answeredAt: latest.event === 'answered' ? latest.at : null, answer: latest.event === 'answered' ? string(latest.answer) : '' });
  const open = [...cards.values()].filter((row) => row.latest?.event === 'asked').map(detail).sort((a, b) => a.at.localeCompare(b.at));
  const recent = [...cards.values()].filter((row) => row.latest?.event === 'answered').map(detail)
    .sort((a, b) => b.answeredAt.localeCompare(a.answeredAt)).slice(0, 3);
  const timeline = [...cards.values()].flatMap(({ asked, latest }) => {
    const rows = [];
    if (asked && now - Date.parse(asked.at) <= 12 * 3600_000) rows.push({ at: asked.at, project: string(asked.project), text: `提出待确认事项：${string(asked.title) || '未命名事项'}` });
    if (latest?.event === 'answered' && now - Date.parse(latest.at) <= 12 * 3600_000) rows.push({ at: latest.at,
      project: string(asked?.project), text: `已回答：${string(asked?.title) || '待确认事项'}` });
    return rows;
  });
  return { open, recent, timeline, malformed };
}

function hostAliases(registry, labels) {
  const hosts = new Map();
  for (const row of registry) {
    if (row.host && Object.hasOwn(labels, row.slot)) hosts.set(row.host, row.slot);
    if (row.host && row.kind === 'slot' && /^heavy-/.test(row.slot)) hosts.set(row.host, 'local');
  }
  // Unregistered addresses are never copied into the snapshot (not even as keys).
  return (host) => labels[hosts.get(host)] ?? '未命名开发机';
}
function poolItems(pool, value, name) {
  const local = pool.startsWith('local');
  return Object.entries(record(value, '容量')).map(([host, row]) => {
    record(row, '容量行');
    const c = row.capacity ?? row;
    return { host: local ? name.local : pool === 'mini2' ? name.mini2 : name.remote(host),
      claims: number(row.claims), held: number(row.held), gate: string(row.gate), link: row.link === 'UP' ? 'up' : row.link ? 'down' : null,
      cores: number(c.cores), memGiB: number(c.memGiB), load5: number(c.load5), availableGiB: number(c.availableGiB),
      freeGiB: number(c.freeGiB), pressure: number(c.pressure) };
  });
}

function metricSample(value) {
  record(value, '机器样本');
  const sampledAt = iso(value.at);
  const cores = number(value.cores);
  const load5 = number(value.load5);
  const availableGiB = number(value.memAvailableGiB ?? value.availableGiB);
  const freeGiB = number(value.freeGiB);
  if (!sampledAt || cores === null || load5 === null || availableGiB === null || freeGiB === null) {
    throw boardError('机器样本格式无法识别');
  }
  return { sampledAt, cores, load5, availableGiB, freeGiB };
}

function sharedSample(value) {
  record(value, '共享机器样本');
  const sampledAt = iso(value.at);
  const errorClass = ['auth', 'timeout', 'refused', 'other'].includes(value.errorClass) ? value.errorClass : null;
  if (value.ok !== true) return { state: 'failed', sampledAt, errorClass };
  const sample = metricSample(value);
  return { ...sample, state: 'ok', errorClass };
}

async function readMetric(file, signal) {
  try { return { state: 'ok', ...metricSample(await jsonFile(file, signal)) }; }
  catch (error) {
    if (signal.aborted) throw error;
    if (error.code === 'ENOENT') return { state: 'missing' };
    if (error instanceof SyntaxError || error.boardMessage) return { state: 'invalid' };
    throw error;
  }
}

async function latestCycle(file, signal) {
  let latest = null;
  await ndjson(file, signal, (row) => { if (iso(row.at) && (!latest || Date.parse(row.at) > Date.parse(latest.at))) latest = row; }, { optional: true });
  if (!latest) return null;
  const result = latest.rollback ? '已回滚' : latest.release ? '已发布' : latest.code && latest.code !== 0 || latest.selfCheckFailed ? '失败'
    : latest.skip ? `跳过：${string(latest.reason) || '没有满足发布条件'}` : '完成，无发布';
  return { at: iso(latest.at), result, failed: result === '失败' };
}

async function latestNightly(root, signal) {
  let entries;
  try { entries = await fs.readdir(path.join(root, 'runs'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const entry of entries.filter((row) => row.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const report = await jsonFile(path.join(root, 'runs', entry.name, 'report.json'), signal, { optional: true });
    if (!report || !Array.isArray(report.rows) || !report.rows.length) continue;
    const rows = report.rows.filter((row) => object(row) && typeof row.status === 'string');
    if (!rows.length) continue;
    const failures = rows.filter((row) => row.status !== 'PASS').map((row) => string(row.job) || '未命名单元').slice(0, 5);
    return { at: iso(report.end ?? report.start), passed: rows.length - rows.filter((row) => row.status !== 'PASS').length,
      total: rows.length, failed: failures.length > 0, failures };
  }
  return null;
}

const ptDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

function releaseTime(value) {
  if (value === 'unknown') return { at: null, atPt: 'unknown', date: null };
  const match = /^(\d{4}-\d{2}-\d{2}) about ([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { at: null, atPt: `${match[1]} ${match[2]}:${match[3]}`, date: match[1] };
}

async function productionReleases(file, signal, now) {
  let input;
  try { input = createReadStream(file, { signal, encoding: 'utf8' }); }
  catch (error) { if (error.code === 'ENOENT') return { latest: null, today: null, malformed: 0 }; throw error; }
  const lines = createInterface({ input, crlfDelay: Infinity });
  let latest = null, malformed = 0, today = 0, found = false;
  const currentDate = ptDate.format(new Date(now));
  try {
    for await (const raw of lines) {
      if (!raw.trim() || raw.startsWith('#')) continue;
      found = true;
      const fields = raw.split('\t');
      const released = releaseTime(fields[0]);
      if (fields.length !== 7 || !released || fields.some((field) => !field.trim())) { malformed += 1; continue; }
      const [releasedAtPt, version, build, commit, ticket, evidence, note] = fields.map((field) => field.trim());
      latest = { version, build, commit: commit === 'unknown' ? commit : commit.slice(0, 7), at: released.at,
        atPt: released.atPt, ticket, evidence, note, fallback: false };
      if (released.date === currentDate) today += 1;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { latest: null, today: null, malformed: 0 };
    throw error;
  } finally { lines.close(); input.destroy(); }
  return { latest, today: found ? today : null, malformed };
}

async function releaseState(vakRoot, nightlyRoot, productionFile, signal, now) {
  const state = await jsonFile(path.join(vakRoot, 'ppe-state.json'), signal, { optional: true });
  const main = object(state?.mainPpe) ? state.mainPpe : {};
  const transaction = object(state?.autoRelease?.lastTransaction) ? state.autoRelease.lastTransaction : {};
  const [lastCycle, nightly, recorded] = await Promise.all([
    latestCycle(path.join(nightlyRoot, 'vak-ppe-release/cycle-events.jsonl'), signal),
    latestNightly(path.join(nightlyRoot, 'vak-web'), signal),
    productionReleases(productionFile, signal, now),
  ]);
  const releaseEvents = Array.isArray(state?.autoRelease?.history) ? state.autoRelease.history.filter((row) => {
    const at = iso(row.deployedAt ?? row.at);
    return at && now - Date.parse(at) <= 12 * 3600_000;
  }).map((row) => ({ at: iso(row.deployedAt ?? row.at), project: 'video-agent', text: 'VAK PPE 已发布' })) : [];
  const fallback = { version: string(transaction.prodVersion), build: '', commit: '', at: iso(transaction.updatedAt ?? transaction.startedAt),
    atPt: '', fallback: true };
  return { ppe: { version: string(main.version), build: main.scm == null ? '' : String(main.scm), at: iso(main.deployedAt) },
    production: recorded.latest ?? fallback, lastCycle, nightly, productionToday: recorded.latest ? recorded.today : null,
    productionMalformed: recorded.malformed, releaseEvents };
}

async function quotaHistory(data, signal, now) {
  const root = path.join(data, 'history');
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const entry of entries.filter((row) => row.isFile() && /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(row.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    await ndjson(path.join(root, entry.name), signal, (snapshot) => {
      const at = iso(snapshot.at);
      if (!at || now - Date.parse(at) > 12 * 3600_000 || !Array.isArray(snapshot.quota?.items)) return;
      rows.push({ at, items: snapshot.quota.items.map((row) => ({ id: string(row.id), label: string(row.label),
        exhausted: row.exhausted === true, resetsAt: iso(row.resetsAt), percent: number(row.percent) })) });
    }, { optional: true });
  }
  return rows.slice(-1500);
}

async function activityState(shared, rulesFile, signal, now) {
  const cutoff = now - 12 * 3600_000;
  const events = [];
  const rerouted = new Set();
  await ndjson(path.join(shared, 'worker-events.jsonl'), signal, (row) => {
    const at = iso(row.t);
    if (!at || Date.parse(at) < cutoff || !row.project || !(row.task || row.name)) return;
    const task = string(row.task) || string(row.name);
    if (row.event === 'finished') events.push({ at, project: string(row.project), text: `${task} 已完成`, tone: 'ok' });
    else if (row.event === 'failed') events.push({ at, project: string(row.project),
      text: row.status === 'interrupted' ? `${task} 已中断` : `${task} 失败`, tone: row.status === 'interrupted' ? 'warn' : 'bad' });
    else if (row.event === 're-routed') {
      const lane = { trae: 'TRAE', ttadk: 'TTADK', main: '个人 main', b: '个人 b' }[row.account] ?? (string(row.account) || '其他通道');
      events.push({ at, project: string(row.project), text: `${task} 已改派到 ${lane}`, tone: 'warn' });
      rerouted.add(`${row.project}\0${task}`);
    }
  }, { optional: true });
  const route = new Map();
  await ndjson(path.join(shared, 'route-log.jsonl'), signal, (row) => {
    const at = iso(row.t);
    if (!at || Date.parse(at) < cutoff || row.kind !== 'launch-model' || !row.project || !row.name) return;
    const id = `${row.project}\0${row.name}`;
    const before = route.get(id);
    if (row.state === 'running' && before?.account && before.account !== row.account && before.state !== 'completed') {
      const lane = { trae: 'TRAE', ttadk: 'TTADK', main: '个人 main', b: '个人 b' }[row.account] ?? (string(row.account) || '其他通道');
      if (!rerouted.has(id)) events.push({ at, project: string(row.project), text: `${string(row.name)} 已改派到 ${lane}`, tone: 'warn' });
    }
    if (row.actualStatus === 'KNOWN' || row.state !== 'running') route.set(id, { account: string(row.account), state: string(row.state) });
  }, { optional: true });
  try {
    const [text, stat] = await Promise.all([fs.readFile(rulesFile, { encoding: 'utf8', signal }), fs.stat(rulesFile)]);
    const version = /^version:\s*(\S+)/m.exec(text)?.[1];
    if (version && stat.mtimeMs >= cutoff) events.push({ at: stat.mtime.toISOString(), project: 'orchestrator', text: `规则升到 ${version}`, tone: 'ok' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return events;
}

export function makeSources({ data, shared = process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared'),
  home = os.homedir(), command = run, labels, now, sampleFile = path.join(shared, 'host-samples/latest.json'), sourcePaths = {} }) {
  const res = (...args) => command(path.join(shared, 'res'), args.slice(1), args[0]);
  const quota = (signal, ...args) => command(process.execPath, [quotaScript, ...args], signal).then(JSON.parse);
  // Share these subprocesses across sources; each consumer still has its own
  // stale block and the subprocess itself has a ten-second deadline.
  let registry, status;
  const getRegistry = () => registry ??= res(AbortSignal.timeout(10_000), 'devbox-registry').then(JSON.parse).then((v) => rows(v, '资源目录'));
  const names = async () => ({ local: labels.local, mini2: labels['mini2-exec-1'], remote: hostAliases(await getRegistry(), labels) });
  const getStatus = () => status ??= (async () => {
    const signal = AbortSignal.timeout(10_000);
    try { return parseStatus(await res(signal, 'status', '--json')); }
    catch (error) {
      if (!/unknown resource|unrecognized arguments|unsupported|usage/i.test(string(error.stderr))) throw error;
      return parseStatus(await res(signal, 'status'));
    }
  })();
  const sources = {
    workers: (signal) => quota(signal, '--running', '--json').then(parseWorkers),
    quota: async (signal) => {
      // Keep the live attempt below the source deadline so a cache read still
      // has time to complete if a hub did not answer.
      try { return parseQuota(await quota(AbortSignal.any([signal, AbortSignal.timeout(8_500)]), '--json'), false, now); }
      catch { return parseQuota(await jsonFile(path.join(shared, 'quota.json'), signal), true, now); }
    },
    devices: async () => (await getStatus()).filter((row) => row.kind === 'device' && Object.hasOwn(deviceNames, row.id))
      .map((row) => row.policy === 'open' ? { ...row, label: deviceNames[row.id] } : { label: '不可用', state: 'unavailable' }),
    audit: async (signal) => {
      const [raw, name] = await Promise.all([res(signal, 'audit', '--json').then(JSON.parse), names()]);
      return Object.entries(record(raw?.hosts, '开发机审计')).map(([host, row]) => ({ host: name.remote(host),
        cores: number(row.cores), spareCores: number(row.spareCores), freeGiB: number(row.freeGiB), held: number(row.heldSlots),
        factsStale: row.probeStale === true || row.metricsFresh === false }));
    },
    hostMetrics: async (signal) => {
      const [registry, name] = await Promise.all([getRegistry(), names()]);
      const hosts = [...new Set(registry.filter((row) => row.policy === 'open' && row.kind === 'remote' && /^devbox-cn-/.test(row.slot))
        .map((row) => string(row.host)).filter((host) => host && path.basename(host) === host))];
      const devboxes = await Promise.all(hosts.map(async (host) => ({ host: name.remote(host), kind: 'devbox',
        ...await readMetric(path.join(shared, 'devbox-metrics', `${host}.json`), signal) })));
      return [...devboxes, { host: labels['mini2-exec-1'], kind: 'mini2',
        ...await readMetric(path.join(shared, 'mini2-metrics.json'), signal) }];
    },
    hostSamples: async (signal) => {
      const value = await jsonFile(sampleFile, signal, { optional: true });
      if (value === null) return [];
      if (value.schema !== 1) throw boardError('共享机器样本格式无法识别');
      const hosts = record(value.hosts, '共享机器样本');
      const [registry, name] = await Promise.all([getRegistry(), names()]);
      const rows = [];
      for (const host of [...new Set(registry.filter((row) => row.policy === 'open' && row.kind === 'remote' && /^devbox-cn-/.test(row.slot))
        .map((row) => string(row.host)).filter(Boolean))]) {
        if (object(hosts[host])) rows.push({ host: name.remote(host), kind: 'devbox', ...sharedSample(hosts[host]) });
      }
      const miniRegistry = registry.find((row) => row.slot === 'mini2-exec-1');
      let miniHost = string(miniRegistry?.host);
      if (!miniHost) {
        try { miniHost = string(JSON.parse(await res(signal, 'slot-host', 'mini2-exec-1')).host); }
        catch { /* An absent mini2 row only removes the optional shared sample. */ }
      }
      if (miniHost && object(hosts[miniHost])) rows.push({ host: labels['mini2-exec-1'], kind: 'mini2', ...sharedSample(hosts[miniHost]) });
      return rows;
    },
    devboxLeases: async (signal) => {
      const [raw, registry, name] = await Promise.all([res(signal, 'status', 'devbox-cn'), getRegistry(), names()]);
      const hosts = new Map(registry.filter((row) => row.policy === 'open' && row.kind === 'remote').map((row) => [row.slot, row.host]));
      const holds = parseStatus(raw).filter((row) => row.held && hosts.has(row.id)).map(({ id, ...row }) => ({
        ...row, id: key(id), host: name.remote(hosts.get(id)), label: '租约' }));
      // Text status supplies measured load, not the audit's projected spare
      // cores (which already subtract reservations and an additional claim).
      const load = {};
      let host;
      for (const line of raw.split('\n')) {
        if (line.startsWith('Host ')) host = line.split(/\s+/)[1];
        const m = /^\s+heavy .*\bload5=([\d.]+)\b/.exec(line);
        if (m && host) load[name.remote(host)] = Number(m[1]);
      }
      return { holds, load };
    },
    localLeases: async (signal) => {
      return (await getStatus()).filter((row) => row.held && /^(?:heavy-(?:build(?:-\d+)?|lane-\d+)|mini2-exec-\d+)$/.test(row.id))
        .map((row) => ({ ...row, host: row.id.startsWith('mini2') ? labels['mini2-exec-1'] : labels.local,
          label: row.id.startsWith('mini2') ? '租约' : row.id.startsWith('heavy-build') ? '构建位' : '通道' }));
    },
    cards: async (signal) => {
      const events = []; let malformed = 0;
      await ndjson(path.join(data, 'cards.ndjson'), signal, (row) => events.push(row), { optional: true, invalid: () => malformed++ });
      return parseCards(events, now, malformed);
    },
    notes: async (signal, workers) => {
      const notes = new Map(), lifecycle = new Map(), notices = new Map(), rerouted = new Map();
      await ndjson(path.join(shared, 'worker-events.jsonl'), signal, (row) => {
        if (!row.project || !(row.task || row.name)) return;
        if (row.event === 'message' && typeof row.text === 'string') {
          const id = taskKey({ ...row, task: row.task || row.name });
          if (row.kind === 'queue-stalled' && row.noticeId) {
            const before = notices.get(row.noticeId);
            if (!before || row.t >= before.t) notices.set(row.noticeId, { id, t: row.t, open: !row.ackAt });
          } else {
            const list = notes.get(id) ?? [];
            list.push({ text: row.text, t: row.t }); notes.set(id, list);
          }
        }
        if (row.event === 're-routed' && iso(row.t)) {
          const id = taskKey({ ...row, task: row.task || row.name });
          if (!rerouted.has(id) || row.t > rerouted.get(id)) rerouted.set(id, row.t);
        }
        if (['failed', 'running', 'finished', 'retired'].includes(row.event) && row.name && iso(row.t)) {
          if (now - Date.parse(iso(row.t)) > 30 * 60_000) return;
          const id = nameKey(row);
          if (!lifecycle.has(id) || row.t >= lifecycle.get(id).t) lifecycle.set(id, row);
        }
      });
      const failed = [...lifecycle.values()].filter((row) => row.event === 'failed')
        .map((row) => worker(row, row.status === 'interrupted' ? 'interrupted' : 'failed', row.startedAt ?? row.t));
      const wanted = new Set([...workers, ...failed].map((row) => row.taskRef));
      const last = Object.fromEntries([...notes].filter(([k]) => wanted.has(k)).map(([k, list]) => [k,
        list.sort((a, b) => b.t - a.t).slice(0, 3).map((row) => row.text)]));
      const openNotices = new Set([...notices.values()].filter((row) => row.open).map((row) => row.id));
      return { latest: Object.fromEntries(Object.entries(last).map(([k, list]) => [k, list[0]])), notes: last,
        notices: Object.fromEntries([...wanted].map((id) => [id, openNotices.has(id)])),
        rerouted: Object.fromEntries([...rerouted].map(([id, at]) => [id, iso(at)])), failed };
    },
    routes: async (signal, workers) => {
      const latest = new Map(), wanted = new Set(workers.map((w) => w.routeRef));
      await ndjson(path.join(shared, 'route-log.jsonl'), signal, (row) => {
        if ((!row.kind || row.kind === 'route') && row.name && Array.isArray(row.why)) {
          const id = nameKey(row);
          if (wanted.has(id) && (!latest.has(id) || row.t >= latest.get(id).t)) latest.set(id, { text: row.why.filter((v) => typeof v === 'string').join('；'), t: row.t });
        }
      });
      return Object.fromEntries([...latest].map(([k, v]) => [k, v.text]));
    },
    releases: (signal) => releaseState(sourcePaths.vakRoot ?? path.join(home, 'code/.claude-data/orchestrator/video-agent'),
      sourcePaths.nightlyRoot ?? path.join(shared, 'nightly'), sourcePaths.productionReleases ?? projectSettings['video-agent'].productionReleases,
      signal, now),
    activity: (signal) => activityState(shared,
      sourcePaths.rulesFile ?? fileURLToPath(new URL('../../references/global-rules.md', import.meta.url)), signal, now),
    quotaHistory: (signal) => quotaHistory(data, signal, now),
  };
  for (const pool of pools) sources[`pool:${pool}`] = async (signal) => {
    const [raw, name] = await Promise.all([res(signal, 'pool-capacity', pool).then(JSON.parse),
      pool.startsWith('devbox-cn') ? names() : { local: labels.local, mini2: labels['mini2-exec-1'] }]);
    return poolItems(pool, raw, name);
  };
  // Each project's board/brief lookup is independent of the other projects.
  for (const project of Object.keys(projects)) sources[`tasks:${project}`] = async (signal, workers) => {
    const target = workers.filter((w) => w.project === project);
    if (!target.length) return {};
    const dir = path.join(home, '.claude/orchestrator', project);
    const board = await jsonFile(path.join(dir, 'board.json'), signal, { optional: true });
    const entries = new Map((board ? rows(board.tasks, '项目任务板') : []).map((r) => [r.id, r]));
    const briefRoot = path.join(home, 'code/.claude-data/orchestrator', project, 'tasks');
    return Object.fromEntries(await Promise.all(target.map(async ({ task, taskRef }) => {
      const item = entries.get(task) ?? entries.get(ticket(task));
      let title = string(item?.title);
      // A worker-supplied task id is never allowed to name an arbitrary file.
      if (!title && /^[\w-]{1,130}$/.test(task)) {
        for (const root of [briefRoot, path.join(dir, 'tasks'), ...(project === 'orchestrator' ? [path.join(shared, 'tasks')] : [])]) {
          try {
            const file = await fs.open(path.join(root, task, 'brief.md'), 'r');
            try {
              const buffer = Buffer.alloc(8192);
              const { bytesRead } = await file.read(buffer);
              title = /^#{1,3}\s+(.+)$/m.exec(buffer.subarray(0, bytesRead).toString('utf8'))?.[1] ?? '';
            } finally { await file.close(); }
            if (title) break;
          } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
        }
      }
      return [taskRef, { title, summary: string(item?.next) }];
    })));
  };
  return sources;
}
