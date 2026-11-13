#!/usr/bin/env node
// File delivery only. No session, model call, dispatch, lease change or live messaging.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG, SHARED, isReadyTask, readTelemetryTail, safeId, unsafeFile } from './lib/resource-data.mjs';
const policy = JSON.parse(fs.readFileSync(new URL('./resource-policy.json', import.meta.url), 'utf8'));
const targetName = (s) => typeof s === 'string' && s.trim() && /^[\p{L}\p{N} ._:/+-]{1,120}$/u.test(s)
  && !/(?:token|password|secret|cookie|bearer|api[_-]?key)\s*[:=]/i.test(s) ? s : null;

export function idleHints(samples, { now = Date.now(), config = policy.idleHint } = {}) {
  const rows = [...new Map(samples.filter((s) => Number.isFinite(s.t) && s.t <= now).map((s) => [`${s.host}/${s.t}`, s])).values()]
    .sort((a, b) => a.t - b.t).slice(-3);
  if (rows.length !== 3 || new Set(rows.map((s) => s.host)).size !== 1 || now - rows[2].t > 360000
    || rows[2].t - rows[0].t < 480000 || rows[2].t - rows[0].t > 720000) return [];
  if (!rows.every((s, i) => (!i || s.t - rows[i - 1].t >= 240000 && s.t - rows[i - 1].t <= 360000)
    && s.complete === true && s.attributionComplete === true && s.taskStateComplete !== false && !s.taskStateCounts?.unknown
    && Number.isFinite(s.load?.[0]) && s.load[0] < config.loadBelow
    && Number.isFinite(s.cpu?.idle) && s.cpu.idle > config.cpuIdleAbovePct
    && s.heavyLocks?.complete === true && s.heavyLocks.waitersComplete === true && Array.isArray(s.heavyLocks.waiters) && !s.heavyLocks.waiters.length)) return [];
  const last = rows[2], byTarget = new Map();
  for (const p of last.projects ?? []) {
    const project = safeId(p.project), target = targetName(p.orchestrator);
    if (!project || !target) continue;
    const tasks = (last.tasks ?? []).filter((t) => t.project === project && isReadyTask(t) && safeId(t.task));
    if (!tasks.length) continue;
    const entry = byTarget.get(target) ?? { schema: 1, t: now, at: new Date(now).toISOString(), target, projects: [], tasks: [] };
    entry.projects.push(project); entry.tasks.push(...tasks.map((t) => `${project}/${t.task}`)); byTarget.set(target, entry);
  }
  return [...byTarget.values()].map((h) => ({ ...h, message: `Resources idle for the last three five-minute samples: load1m < ${config.loadBelow}, CPU idle > ${config.cpuIdleAbovePct}%, no heavy lock waiters. Ready but undispatched: ${h.tasks.join(', ')}. Check dependencies and route ready work; this is a hint, not a dispatch.` }));
}

export function writeIdleHints({ samples = null, log = LOG, file = path.join(SHARED, 'idle-hints.jsonl'), now = Date.now(), print = console.log } = {}) {
  if (samples === null) {
    samples = readTelemetryTail(log, 16 * 2 ** 20);
    if (samples.length < 3) samples = [...readTelemetryTail(`${log}.1`, 16 * 2 ** 20), ...samples];
  }
  const hints = idleHints(samples, { now });
  if (!hints.length) return [];
  if (path.basename(file) !== 'idle-hints.jsonl' || unsafeFile(file)) throw Error('idle hint path refused');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, fd = fs.openSync(lock, 'wx', 0o600);
  try {
    const previous = readTelemetryTail(file, 4 * 2 ** 20);
    // Do not lose cooldown evidence by clipping a large history; ask its owner to archive it.
    if (fs.existsSync(file) && fs.statSync(file).size > 4 * 2 ** 20) throw Error('idle hint history exceeds read budget; owner archival needed');
    const delivered = hints.filter((h) => !previous.some((p) => p.target === h.target && Number.isFinite(p.t) && now - p.t < policy.idleHint.cooldownMinutes * 60000));
    if (delivered.length) {
      fs.appendFileSync(file, delivered.map((h) => JSON.stringify(h) + '\n').join(''), { mode: 0o600 });
      for (const h of delivered) print(`Target: ${h.target}\n${h.message}`);
    }
    return delivered;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('usage: node resource-idle-hint.mjs');
    writeIdleHints();
  } catch (e) { console.error(`BLOCKED: ${e.message}`); process.exitCode = 2; }
}
