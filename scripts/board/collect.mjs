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

const DAY = 86_400_000;
const HOUR = 3_600_000;
const defaultData = path.join(os.homedir(), '.claude/orchestrator/_shared/board');
const hostMap = new URL('./hosts.json', import.meta.url);
const emptySource = (id) => id === 'notes' ? { latest: {}, failed: [] } : id === 'devboxLeases' ? { holds: [], load: {} }
  : id.startsWith('tasks:') || id === 'routes' ? {} : id === 'quota' ? { items: [], hubs: [] } : [];

function clean(value) {
  if (typeof value === 'string') return sanitize(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 600);
  if (Array.isArray(value)) return value.map(clean);
  // All object keys are schema fields, configured labels, or opaque join keys.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
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
    return { data: clean(data), updatedAt: now, stale: false };
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

function derive(blocks, now) {
  const get = (id) => blocks[id]?.data ?? emptySource(id);
  const audit = get('audit');
  const metrics = get('hostMetrics');
  const devbox = get('devboxLeases');
  // Prefer a fresh command when overlapping status views disagree. A failed
  // source can still show its last good values, explicitly marked below.
  const devices = get('devices');
  const holds = [...devbox.holds, ...get('localLeases')];
  const machineNames = new Set([...audit.map((r) => r.host), ...metrics.map((r) => r.host), ...holds.map((r) => r.host),
    ...pools.flatMap((p) => get(`pool:${p}`).map((r) => r.host))]);
  const machines = [...machineNames].map((name) => {
    const fact = audit.find((r) => r.host === name);
    const metric = metrics.find((r) => r.host === name);
    const capacity = Object.fromEntries(pools.flatMap((p) => get(`pool:${p}`).filter((r) => r.host === name).map((r) => [p, r])));
    const sample = capacity.local ?? capacity['local-light'] ?? capacity['local-build'] ?? capacity.mini2;
    const holders = holds.filter((row) => row.host === name);
    const held = Math.max(holders.length, fact?.held ?? sample?.held ?? 0);
    const metricOk = metric?.state === 'ok';
    const related = Object.keys(capacity).map((pool) => `pool:${pool}`);
    if (metric?.kind === 'devbox') related.push('audit', 'devboxLeases');
    else if (metric?.kind === 'mini2' || Object.hasOwn(capacity, 'local')) related.push('localLeases');
    const faults = [];
    if (metric?.state === 'missing') faults.push('metrics-missing');
    if (metric?.state === 'invalid') faults.push('metrics-invalid');
    if (metricOk && held > 0 && now - Date.parse(metric.sampledAt) > 6 * HOUR) faults.push('metrics-old-with-lease');
    if (Object.values(capacity).some((row) => row.link === 'down')) faults.push('link-down');
    if ((metric && blocks.hostMetrics?.stale) || related.some((id) => blocks[id]?.stale)) faults.push('res-failed');
    return { name, cores: metricOk ? metric.cores : sample?.cores ?? fact?.cores, memGiB: sample?.memGiB,
      load5: metricOk ? metric.load5 : metric ? null : sample?.load5 ?? devbox.load[name],
      sampledAt: metricOk ? metric.sampledAt : null, sampleOnDemand: Boolean(metric), sampleState: metric?.state ?? null,
      availableGiB: metricOk ? metric.availableGiB : metric ? null : sample?.availableGiB,
      freeGiB: metricOk ? metric.freeGiB : metric ? null : sample?.freeGiB ?? fact?.freeGiB, pressure: sample?.pressure,
      spareCores: fact?.spareCores, link: Object.values(capacity).find((row) => row.link)?.link ?? sample?.link,
      held, holders, faults: [...new Set(faults)], fault: faults.length > 0,
      claims: Object.fromEntries(Object.entries(capacity).map(([p, r]) => [p, { count: r.claims, gate: r.gate }])) };
  });
  const notes = get('notes');
  const running = get('workers');
  const failed = notes.failed.filter((row) => !running.some((r) => r.routeRef === row.routeRef));
  const rows = [...running, ...failed];
  const assigned = assignHolds(running, [...holds, ...devices.filter((r) => r.held)]);
  const tasks = rows.map((row) => {
    const { id, taskRef, routeRef, ...worker } = row;
    const details = get(`tasks:${worker.project}`)[taskRef];
    const latestNote = notes.latest[taskRef];
    const title = details?.title;
    return { id, ...worker, title: title || worker.name, summary: details?.summary || (title ? title : latestNote) || worker.task,
      latestNote, routeWhy: get('routes')[routeRef], resources: assigned.get(id) ?? [] };
  });
  return { tasks, machines, devices, quota: get('quota'), cards: get('cards') };
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
  labels, prune = true } = {}) {
  const at = new Date(now).toISOString();
  labels ??= JSON.parse(await fs.readFile(hostMap, 'utf8'));
  const before = await readPrevious(data);
  const sources = makeSources({ data, shared, home, command, labels, now });
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
