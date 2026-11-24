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

export const projects = { 'video-agent': 'VAK', 'vesdk-mainline': 'Webview', 'lynx-view': 'Lynx', orchestrator: '全局规则' };
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
async function ndjson(file, signal, visit, { optional = false, strict = false } = {}) {
  const input = createReadStream(file, { signal, encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch (error) { if (strict) throw error; continue; }
      if (object(row)) visit(row);
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
    queuePosition: number(queue.position),
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

export function parseCards(events, now) {
  const cards = new Map();
  for (const row of events) {
    if (!row.id || !iso(row.at)) continue;
    const at = iso(row.at);
    if (Date.parse(at) > now || (cards.get(row.id)?.at ?? '') > at) continue;
    if (['asked', 'answered', 'withdrawn'].includes(row.event)) cards.set(row.id, { ...row, at });
  }
  return [...cards.values()].filter((row) => row.event === 'asked' && (row.defaultAt == null || Date.parse(row.defaultAt) > now))
    .map((row) => ({ title: string(row.title) || '待确认事项', project: string(row.project), at: row.at })).sort((a, b) => a.at.localeCompare(b.at));
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

async function readMetric(file, signal) {
  try { return { state: 'ok', ...metricSample(await jsonFile(file, signal)) }; }
  catch (error) {
    if (signal.aborted) throw error;
    if (error.code === 'ENOENT') return { state: 'missing' };
    if (error instanceof SyntaxError || error.boardMessage) return { state: 'invalid' };
    throw error;
  }
}

export function makeSources({ data, shared = process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared'),
  home = os.homedir(), command = run, labels, now }) {
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
      const events = [];
      await ndjson(path.join(data, 'cards.ndjson'), signal, (row) => events.push(row), { optional: true, strict: true });
      return parseCards(events, now);
    },
    notes: async (signal, workers) => {
      const latest = new Map(), lifecycle = new Map();
      await ndjson(path.join(shared, 'worker-events.jsonl'), signal, (row) => {
        if (!row.project || !(row.task || row.name)) return;
        if (row.event === 'message' && typeof row.text === 'string') {
          const id = taskKey({ ...row, task: row.task || row.name });
          if (!latest.has(id) || row.t >= latest.get(id).t) latest.set(id, { text: row.text, t: row.t });
        }
        if (['failed', 'running', 'finished', 'retired'].includes(row.event) && row.name && iso(row.t)) {
          if (now - Date.parse(iso(row.t)) > 30 * 60_000) return;
          const id = nameKey(row);
          if (!lifecycle.has(id) || row.t >= lifecycle.get(id).t) lifecycle.set(id, row);
        }
      });
      const failed = [...lifecycle.values()].filter((row) => row.event === 'failed').map((row) => worker(row, 'failed', row.startedAt ?? row.t));
      const wanted = new Set([...workers, ...failed].map((row) => row.taskRef));
      return { latest: Object.fromEntries([...latest].filter(([k]) => wanted.has(k)).map(([k, v]) => [k, v.text])), failed };
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
