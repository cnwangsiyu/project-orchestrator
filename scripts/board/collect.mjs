#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { makeSources, pools, projects, sanitize, ticket } from './sources.mjs';
import { finishedNotExited } from '../lib/finished-not-exited.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const defaultData = path.join(os.homedir(), '.claude/orchestrator/_shared/board');
const hostMap = new URL('./hosts.json', import.meta.url);
const emptySource = (id) => id === 'notes' ? { latest: {}, notes: {}, notices: {}, rerouted: {}, failed: [] }
  : id === 'devboxLeases' ? { holds: [], load: {} }
    : id === 'cards' ? { open: [], recent: [], timeline: [], malformed: 0 }
      : id === 'releases' ? { ppe: {}, production: {}, lastCycle: null, nightly: null, productionToday: null,
        productionMalformed: 0, releaseEvents: [] }
        : id.startsWith('tasks:') || id === 'routes' ? {} : id === 'quota' ? { items: [], hubs: [] } : [];

function clean(value, field = '', scope = '') {
  if (typeof value === 'string') {
    const text = scope === 'releases' && field === 'version' && /^\d+(?:\.\d+){2,3}(?:[-+][\w.-]+)?$/.test(value) ? value : sanitize(value);
    return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 600);
  }
  if (Array.isArray(value)) return value.map((item) => clean(item, '', scope));
  // All object keys are schema fields, configured labels, or opaque join keys.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k, scope)]));
  return value;
}

async function readPrevious(data) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(data, 'snapshot.json'), 'utf8'));
    return value.version === 1 ? value : {};
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
}

function errorMessage(error, signal) {
  if (signal.aborted || error?.killed || error?.code === 'ETIMEDOUT') return '读取超时（10 秒）';
  if (error?.boardMessage) return error.boardMessage;
  if (error?.code === 'ENOENT') return '找不到数据来源';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return '无法读取数据来源';
  if (error instanceof SyntaxError) return '数据格式无法识别';
  return '数据来源读取失败';
}

async function block(id, read, before, now, timeout, workers) {
  const controller = new AbortController();
  const signal = controller.signal;
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(signal.reason); }, timeout); });
    const data = await Promise.race([Promise.resolve().then(() => read(signal, workers)), deadline]);
    return { data: clean(data, '', id), updatedAt: now, stale: false };
  } catch (error) {
    return { data: before?.data ?? emptySource(id), updatedAt: before?.updatedAt ?? null, stale: true,
      since: before?.since ?? now, error: errorMessage(error, signal) };
  } finally { clearTimeout(timer); }
}

function matchStrength(task, lease) {
  const sameProject = lease.project === task.project;
  if (!sameProject && lease.project && lease.project !== '?') return 0;
  if (lease.holder === task.name) return 4;
  if (lease.task === task.task || lease.task === task.name) return 3;
  // Match a full id in the holder (never T25 inside T253).
  const exactInHolder = [task.task, task.name].filter(Boolean).some((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u');
    return matches.test(lease.holder) && (!lease.task || lease.task === '?' || matches.test(lease.task));
  });
  if (exactInHolder) return 2;
  // Project boards and the lease/worker launchers can use different suffixes
  // for the same ticket. Never use that weaker match across projects.
  const id = ticket(lease.task) ?? ticket(lease.holder);
  return sameProject && id && id === ticket(task.task) ? 1 : 0;
}

function assignHolds(tasks, leases) {
  const result = new Map();
  for (const lease of leases) {
    const scores = tasks.map((task) => matchStrength(task, lease));
    const best = Math.max(0, ...scores);
    if (!best) continue;
    const matches = tasks.filter((_, i) => scores[i] === best);
    if (new Set(matches.map((row) => row.taskRef)).size > 1) continue;
    for (const row of matches) {
      const held = result.get(row.id) ?? [];
      held.push({ host: lease.host, label: lease.label, until: lease.until });
      result.set(row.id, held);
    }
  }
  return result;
}

const minutes = (ms) => Math.max(0, Math.floor(ms / 60_000));
const elapsed = (ms) => minutes(ms) < 1 ? '不到 1 分钟' : `${minutes(ms)} 分钟`;

function exhaustedQuota(task, quota) {
  const normalized = task.model?.toLowerCase().replaceAll('_', '-');
  const ids = task.account === 'trae' ? [`trae-${normalized}`] : [task.account];
  return quota.items?.find((row) => ids.includes(row.id) && row.exhausted);
}

export function taskStatus(task, quota, now) {
  if (task.state === 'failed') return { state: 'failed', stateReason: '任务失败', stateRank: 0 };
  if (task.state === 'interrupted') return { state: 'interrupted', stateReason: '任务中断，尚未重新发起', stateRank: 0 };
  const finished = task.finishedNotExited ?? finishedNotExited(task, { now });
  if (finished) return { state: 'finished-not-exited', stateReason: `已完成，会话未退出（${elapsed(finished.inactiveMs)}）`, stateRank: 1 };
  const queued = ['queued', 'waiting'].includes(task.queueState) || task.state === 'queued' || task.queueStalled;
  if (queued) {
    const since = Date.parse(task.queueSince ?? task.startedAt);
    const waited = Number.isFinite(since) ? Math.max(0, now - since) : 0;
    const duration = elapsed(waited);
    const quotaRow = exhaustedQuota(task, quota);
    const stuck = waited > 5 * 60_000 || task.queueStalled && task.queueDrainPerMinute === 0;
    const daily = quotaRow && (quotaRow.id === 'ttadk' || quotaRow.id.startsWith('trae-'));
    const suffix = quotaRow ? daily ? '，该模型今日额度已用完' : '，该通道额度已用完'
      : task.queueDrainPerMinute === 0 ? '，队列没有前进' : '';
    return stuck ? { state: 'stalled', stateReason: `排队 ${duration}${suffix}`, stateRank: 0 }
      : { state: 'queued', stateReason: `排队 ${duration}`, stateRank: 3 };
  }
  const lastActivity = Date.parse(task.lastActivityAt ?? task.startedAt);
  const inactive = Number.isFinite(lastActivity) ? now - lastActivity : 0;
  if (inactive > 20 * 60_000 && !(task.runningTools > 0)) {
    return { state: 'stalled', stateReason: `${elapsed(inactive)}没有 worker 活动，也没有长时间运行的工具`, stateRank: 0 };
  }
  return { state: 'running', stateReason: task.startedAt ? `运行 ${elapsed(now - Date.parse(task.startedAt))}` : '运行中', stateRank: 2 };
}

function quotaEvents(history, current, now) {
  const snapshots = [...history, { at: new Date(now).toISOString(), items: current.items ?? [] }]
    .filter((row) => row.at && Array.isArray(row.items)).sort((a, b) => a.at.localeCompare(b.at));
  const result = [];
  let before = new Map();
  for (const snapshot of snapshots) {
    const items = new Map(snapshot.items.map((row) => [row.id, row]));
    for (const [id, row] of items) {
      const previous = before.get(id);
      if (!previous) continue;
      if (!previous.exhausted && row.exhausted) result.push({ at: snapshot.at, project: 'general', text: `${row.label || id} 额度用完`, tone: 'warn' });
      else if (previous.exhausted && !row.exhausted) result.push({ at: snapshot.at, project: 'general', text: `${row.label || id} 额度已重置`, tone: 'ok' });
    }
    before = items;
  }
  return result;
}

function derive(blocks, now) {
  const get = (id) => blocks[id]?.data ?? emptySource(id);
  const audit = get('audit');
  const metrics = get('hostMetrics');
  const sharedMetrics = get('hostSamples');
  const devbox = get('devboxLeases');
  // Prefer a fresh command when overlapping status views disagree. A failed
  // source can still show its last good values, explicitly marked below.
  const devices = get('devices');
  const holds = [...devbox.holds, ...get('localLeases')];
  const machineNames = new Set([...audit.map((r) => r.host), ...metrics.map((r) => r.host), ...sharedMetrics.map((r) => r.host), ...holds.map((r) => r.host),
    ...pools.flatMap((p) => get(`pool:${p}`).map((r) => r.host))]);
  const machines = [...machineNames].map((name) => {
    const fact = audit.find((r) => r.host === name);
    const schedulerMetric = metrics.find((r) => r.host === name);
    const sharedMetric = sharedMetrics.find((r) => r.host === name);
    const sharedAge = now - Date.parse(sharedMetric?.sampledAt);
    const useShared = sharedMetric?.state === 'ok' && sharedAge >= 0 && sharedAge < 3 * 60_000;
    const metric = useShared ? sharedMetric : schedulerMetric;
    const capacity = Object.fromEntries(pools.flatMap((p) => get(`pool:${p}`).filter((r) => r.host === name).map((r) => [p, r])));
    const sample = capacity.local ?? capacity['local-light'] ?? capacity['local-build'] ?? capacity.mini2;
    const holders = holds.filter((row) => row.host === name);
    const held = Math.max(holders.length, fact?.held ?? sample?.held ?? 0);
    const metricOk = metric?.state === 'ok';
    const related = Object.keys(capacity).map((pool) => `pool:${pool}`);
    if ((schedulerMetric ?? sharedMetric)?.kind === 'devbox') related.push('audit', 'devboxLeases');
    else if ((schedulerMetric ?? sharedMetric)?.kind === 'mini2' || Object.hasOwn(capacity, 'local')) related.push('localLeases');
    const faults = [];
    if (schedulerMetric?.state === 'missing') faults.push('metrics-missing');
    if (schedulerMetric?.state === 'invalid') faults.push('metrics-invalid');
    if (sharedMetric?.errorClass === 'auth') faults.push('sampler-auth');
    if (metricOk && held > 0 && now - Date.parse(metric.sampledAt) > 6 * HOUR) faults.push('metrics-old-with-lease');
    if (Object.values(capacity).some((row) => row.link === 'down')) faults.push('link-down');
    if ((schedulerMetric && blocks.hostMetrics?.stale) || related.some((id) => blocks[id]?.stale)) faults.push('res-failed');
    return { name, cores: metricOk ? metric.cores : sample?.cores ?? fact?.cores, memGiB: sample?.memGiB,
      load5: metricOk ? metric.load5 : metric ? null : sample?.load5 ?? devbox.load[name],
      sampledAt: metricOk ? metric.sampledAt : null, sampleSource: useShared ? 'shared' : metricOk ? 'scheduler' : null,
      sampleOnDemand: Boolean(metric), sampleState: metric?.state ?? null, samplerError: sharedMetric?.errorClass ?? null,
      availableGiB: metricOk ? metric.availableGiB : metric ? null : sample?.availableGiB,
      freeGiB: metricOk ? metric.freeGiB : metric ? null : sample?.freeGiB ?? fact?.freeGiB, pressure: sample?.pressure,
      spareCores: fact?.spareCores, link: Object.values(capacity).find((row) => row.link)?.link ?? sample?.link,
      held, holders, faults: [...new Set(faults)], fault: faults.length > 0,
      claims: Object.fromEntries(Object.entries(capacity).map(([p, r]) => [p, { count: r.claims, gate: r.gate }])) };
  });
  const notes = get('notes');
  const running = get('workers');
  const attempts = [...running, ...notes.failed].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const rows = [...new Map(attempts.map((row) => [row.taskRef, row])).values()];
  const assigned = assignHolds(running, [...holds, ...devices.filter((r) => r.held)]);
  const quota = get('quota');
  const tasks = rows.map((row) => {
    const { id, taskRef, routeRef, ...worker } = row;
    const details = get(`tasks:${worker.project}`)[taskRef];
    const latestNote = notes.latest[taskRef];
    const title = details?.title;
    const task = { id, ...worker, title: title || worker.name, summary: details?.summary || (title ? title : latestNote) || worker.task,
      latestNote, lastNotes: notes.notes[taskRef] ?? [], ownerNoticeOpen: notes.notices[taskRef] === true,
      queueWaitMinutes: worker.queueSince ? Math.max(0, (now - Date.parse(worker.queueSince)) / 60_000) : null,
      reroutedAt: notes.rerouted?.[taskRef] ?? null, routeWhy: get('routes')[routeRef], resources: assigned.get(id) ?? [] };
    return { ...task, ...taskStatus(task, quota, now) };
  });
  const cardData = get('cards');
  const cards = Array.isArray(cardData) ? cardData : cardData.open ?? [];
  const releases = get('releases');
  const events = [...get('activity'), ...(cardData.timeline ?? []), ...(releases.releaseEvents ?? []),
    ...quotaEvents(get('quotaHistory'), quota, now)].filter((row) => row.at && now - Date.parse(row.at) <= 12 * HOUR)
    .sort((a, b) => b.at.localeCompare(a.at)).filter((row, index, all) => index === all.findIndex((other) =>
      other.at === row.at && other.project === row.project && other.text === row.text)).slice(0, 40);
  return { tasks, machines, devices, quota, cards, recentCards: cardData.recent ?? [], cardMalformed: cardData.malformed ?? 0,
    releases, events };
}

async function atomic(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

async function pruneHistory(dir, now) {
  const cutoff = new Date(now - 2 * DAY).toISOString();
  const today = cutoff.slice(0, 10);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const day = entry.name.slice(0, 10);
    if (day < today) await fs.unlink(file);
    else if (day === today) {
      // Stream the boundary day instead of loading a whole busy day into RAM.
      const temp = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temp, 'wx', 0o600);
      const input = createReadStream(file);
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          // Collector always writes `at` first and in UTC ISO form.
          const at = /^\{"at":"([\dT:.Z-]+)"/.exec(line)?.[1];
          if (at && at >= cutoff) await handle.writeFile(`${line}\n`);
        }
        await handle.close();
        await fs.rename(temp, file);
      } finally { lines.close(); input.destroy(); await handle.close(); await fs.rm(temp, { force: true }); }
    }
  }
}

export async function collect({ data = defaultData, now = Date.now(), timeout = 10_000, command, shared, home,
  labels, sampleFile, sourcePaths, prune = true } = {}) {
  const at = new Date(now).toISOString();
  labels ??= JSON.parse(await fs.readFile(hostMap, 'utf8'));
  const before = await readPrevious(data);
  const sources = makeSources({ data, shared, home, command, labels, now, sampleFile, sourcePaths });
  const fetch = (id, workers) => block(id, sources[id], before.blocks?.[id], at, timeout, workers);
  const independent = Object.keys(sources).filter((id) => !['routes', 'notes'].includes(id) && !id.startsWith('tasks:'));
  const pending = Object.fromEntries(independent.map((id) => [id, fetch(id)]));
  const active = (await pending.workers).data;
  pending.notes = fetch('notes', active);
  const routeWorkers = [...active, ...(await pending.notes).data.failed];
  for (const id of ['routes', ...Object.keys(projects).map((p) => `tasks:${p}`)]) pending[id] = fetch(id, routeWorkers);
  const blocks = Object.fromEntries(await Promise.all(Object.entries(pending).map(async ([id, value]) => [id, await value])));
  const snapshot = { at, version: 1, ...derive(blocks, now), blocks };
  await fs.mkdir(data, { mode: 0o700, recursive: true });
  const history = path.join(data, 'history');
  await fs.mkdir(history, { mode: 0o700, recursive: true });
  const line = `${JSON.stringify(snapshot)}\n`;
  await atomic(path.join(data, 'snapshot.json'), line);
  await fs.appendFile(path.join(history, `${at.slice(0, 10)}.ndjson`), line, { mode: 0o600 });
  if (prune) await pruneHistory(history, now);
  return snapshot;
}

async function main() {
  const { values } = parseArgs({ options: { data: { type: 'string' }, loop: { type: 'string' } } });
  const interval = values.loop === undefined ? 0 : Number(values.loop) * 1000;
  if (values.loop !== undefined && (!Number.isFinite(interval) || interval < 1000)) throw new Error('invalid interval');
  let prunedAt = -Infinity;
  do {
    const started = Date.now();
    const prune = started - prunedAt >= HOUR;
    try {
      await collect({ data: values.data, now: started, prune });
      if (prune) prunedAt = started;
    } catch {
      console.error('board collector: could not publish snapshot or maintain history');
      if (!interval) process.exitCode = 1;
    }
    if (interval) await sleep(Math.max(0, interval - (Date.now() - started)));
  } while (interval);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('usage: collect.mjs [--data DIR] [--loop SECONDS]');
  process.exitCode = 1;
});
