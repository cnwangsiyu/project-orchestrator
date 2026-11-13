// Sampled interval estimates, never extrapolated through missing telemetry or resets.
import { GIB, isRunnableTask } from './resource-data.mjs';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v) => +v.toFixed(4);
const validBucket = (q) => q && finite(q.used) && q.used >= 0 && finite(q.limit) && q.limit > 0 && finite(q.resetsAt);

export function quotaUtilisation(records, { since = -Infinity, now = Date.now(), maxResetDistanceMs = 1800000 } = {}) {
  const buckets = new Map(), resets = [];
  for (const s of [...records].filter((s) => finite(s.t) && s.t <= now).sort((a, b) => a.t - b.t)) {
    const entries = [];
    if (s.ttadk?.name) entries.push({ vendor: 'ttadk', account: s.ttadk.name, model: null, q: s.ttadk, sampledAt: s.t });
    if (s.trae?.name) for (const [model, q] of Object.entries(s.trae.daily ?? {}))
      entries.push({ vendor: 'trae', account: s.trae.name, model, q, sampledAt: s.trae.sampledAt ?? s.t });
    for (const row of entries) {
      if (!validBucket(row.q) || !finite(row.sampledAt) || row.sampledAt > s.t) continue;
      const key = `${row.vendor}/${row.account}/${row.model ?? ''}`, prev = buckets.get(key);
      if (prev && row.q.resetsAt - prev.q.resetsAt >= 3600000 && s.t >= prev.q.resetsAt && prev.q.resetsAt >= since) {
        const known = prev.sampledAt <= prev.q.resetsAt && prev.q.resetsAt - prev.sampledAt <= maxResetDistanceMs;
        resets.push({ vendor: row.vendor, account: row.account, model: row.model, at: new Date(prev.q.resetsAt).toISOString(),
          lastObservedAt: new Date(prev.sampledAt).toISOString(), limit: prev.q.limit, usedBefore: prev.q.used,
          unused: known ? Math.max(0, prev.q.limit - prev.q.used) : null,
          basis: known ? 'last pre-reset reading <=30 min from reset; unused upper-bound estimate' : 'UNKNOWN: no near-reset reading' });
      }
      // Never treat post-deadline stale counters or backwards deadline corrections as a new baseline.
      if (row.sampledAt <= row.q.resetsAt && (!prev || row.q.resetsAt >= prev.q.resetsAt)) buckets.set(key, row);
    }
  }
  const tt = resets.filter((r) => r.vendor === 'ttadk'), trae = resets.filter((r) => r.vendor === 'trae');
  const sum = (rows) => rows.length && rows.every((r) => r.unused !== null) ? rows.reduce((n, r) => n + r.unused, 0) : null;
  return { ttadk: { tokensUnusedAtReset: sum(tt), resets: tt },
    trae: { highPriorityUnitsUnusedAtResetByModel: Object.fromEntries([...new Set([...buckets.values()].filter((r) => r.vendor === 'trae').map((r) => r.model))].map((model) => [model, sum(trae.filter((r) => r.model === model))])), resets: trae },
    note: 'No observed rollover is UNKNOWN, not zero waste. Unused quota uses the last near-reset counter, not exact reset-time usage; never mixes tokens, model units or personal weekly percentages. Missing daily windows between snapshots are not reconstructed.' };
}

export function resourceUtilisation(samples, { now = Date.now(), since = now - 24 * 3600000, maxGapMs = 600000, quotaRecords = [] } = {}) {
  let cpuH = 0, idleH = 0, idleReadyH = 0, readyCpuH = 0, gateH = 0, overH = 0;
  let memoryH = 0, memoryGiBHours = 0, memoryMin = Infinity, memoryMax = 0, pressureH = 0, pressureObservedH = 0;
  let queueH = 0, taskQueueH = 0, readyTaskH = 0, taskH = 0, idleCauseH = 0;
  const causes = new Map(), lanes = new Map();
  const knownLock = (l) => l && (l.state === 'FREE' || l.state === 'STALE' || l.state === 'HELD' && l.stale === false && l.pidIdentity === 'observed' && l.local === true);
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i], b = samples[i + 1], gap = b.t - a.t, span = Math.min(b.t, now) - Math.max(a.t, since);
    if (a.host !== b.host || gap <= 0 || gap > maxGapMs || span <= 0) continue;
    const h = span / 3600000, cpuKnown = finite(a.cpu?.idle) && finite(b.cpu?.idle);
    const tasksKnown = a.attributionComplete === true && b.attributionComplete === true
      && a.taskStateComplete !== false && b.taskStateComplete !== false && !a.taskStateCounts?.unknown && !b.taskStateCounts?.unknown
      && Array.isArray(a.tasks) && Array.isArray(b.tasks);
    const ready = (a.tasks ?? []).filter(isRunnableTask);
    const gateKnown = a.heavyGate?.authoritative === true && b.heavyGate?.authoritative === true;
    if (cpuKnown) {
      cpuH += h; idleH += a.cpu.idle / 100 * h;
      if (tasksKnown) { readyCpuH += h; if (a.cpu.idle > 50 && ready.length) idleReadyH += h; }
    }
    if (gateKnown) { gateH += h; if (a.heavyGate.state === 'OVERLOADED') overH += h; }
    if (finite(a.memory?.availableBytes) && finite(b.memory?.availableBytes)) {
      const gib = a.memory.availableBytes / GIB;
      memoryH += h; memoryGiBHours += gib * h; memoryMin = Math.min(memoryMin, gib); memoryMax = Math.max(memoryMax, gib);
    }
    if (['normal', 'warning', 'critical'].includes(a.memory?.pressure) && ['normal', 'warning', 'critical'].includes(b.memory?.pressure)) {
      pressureObservedH += h; if (['warning', 'critical'].includes(a.memory.pressure)) pressureH += h;
    }
    if (tasksKnown) {
      taskH += h;
      const queued = a.tasks.filter((t) => ['ready', 'queued', 'waiting', 'blocked'].includes(t.status));
      if (queued.length) queueH += h;
      taskQueueH += queued.length * h; readyTaskH += ready.length * h;
      if (cpuKnown && a.cpu.idle > 50) {
        idleCauseH += h;
        const cause = !queued.length ? 'no ready tasks'
          : queued.every((t) => t.waitReason === 'user') ? 'waiting on user'
          : queued.some((t) => t.waitReason === 'quota') && !ready.length ? 'quota'
          : ready.length && (a.heavyGate?.state === 'OVERLOADED' || a.heavyLocks?.waiters?.length) ? 'lock gate'
          : ready.some((t) => t.dispatched !== true) ? 'ready but undispatched'
          : ready.length ? 'dispatched work waiting' : queued.some((t) => t.waitReason === 'user') ? 'waiting on user' : 'no ready tasks';
        causes.set(cause, (causes.get(cause) ?? 0) + h);
      }
    }
    if (a.heavyLocks?.complete !== true || b.heavyLocks?.complete !== true) continue;
    for (const l of a.heavyLocks.locks ?? []) {
      if (!/^heavy-lane-[123]$/.test(l.id)) continue;
      const next = b.heavyLocks.locks?.find((q) => q.id === l.id);
      if (!knownLock(l) || !knownLock(next)) continue;
      const v = lanes.get(l.id) ?? { observedHours: 0, occupiedHours: 0 };
      v.observedHours += h; if (l.state === 'HELD') v.occupiedHours += h; lanes.set(l.id, v);
    }
  }
  const laneRows = [...lanes].map(([id, v]) => ({ id, observedHours: round(v.observedHours), occupiedHours: round(v.occupiedHours), occupancyPct: round(v.occupiedHours / v.observedHours * 100) }));
  const laneH = [...lanes.values()].reduce((n, v) => n + v.observedHours, 0), occupiedH = [...lanes.values()].reduce((n, v) => n + v.occupiedHours, 0);
  return { cpu: { observedHours: round(cpuH), meanIdlePct: cpuH ? round(idleH / cpuH * 100) : null,
    readinessObservedHours: round(readyCpuH), hoursIdleAbove50WithReadyTasks: readyCpuH ? round(idleReadyH) : null,
    gateObservedHours: round(gateH), hoursOverGate: gateH ? round(overH) : null },
    memory: { observedHours: round(memoryH), meanAvailableGiB: memoryH ? round(memoryGiBHours / memoryH) : null,
      minAvailableGiB: memoryH ? round(memoryMin) : null, maxAvailableGiB: memoryH ? round(memoryMax) : null,
      pressureObservedHours: round(pressureObservedH), pressureHours: pressureObservedH ? round(pressureH) : null },
    heavyLanes: { occupancyPct: laneH ? round(occupiedH / laneH * 100) : null, observedLaneHours: round(laneH), occupiedLaneHours: round(occupiedH), lanes: laneRows },
    queue: { observedHours: round(taskH), hours: taskH ? round(queueH) : null, taskHours: taskH ? round(taskQueueH) : null, readyTaskHours: taskH ? round(readyTaskH) : null },
    topIdlenessCauses: [...causes].map(([cause, h]) => ({ cause, hours: round(h) })).sort((a, b) => b.hours - a.hours),
    idlenessCauseObservedHours: round(idleCauseH), quota: quotaUtilisation(quotaRecords, { since, now }),
    note: 'Left-endpoint sampled intervals with two valid endpoints, clipped to the window; no gap/tail extrapolation. Gate hours use authoritative combined load/memory verdicts. Occupancy is held time / observed provisioned lane time (lane 3 only if present), not a claim that gated capacity was available. Idleness causes are correlated ledger hints, not proven causality.' };
}

export function utilisationLines(u) {
  const perModel = u?.quota?.trae?.highPriorityUnitsUnusedAtResetByModel;
  return [
    `Utilisation: CPU idle >50% with ready tasks=${u?.cpu?.hoursIdleAbove50WithReadyTasks ?? 'UNKNOWN'}h; over admission gate=${u?.cpu?.hoursOverGate ?? 'UNKNOWN'}h; memory available mean/min=${u?.memory?.meanAvailableGiB ?? 'UNKNOWN'}/${u?.memory?.minAvailableGiB ?? 'UNKNOWN'} GiB, pressure=${u?.memory?.pressureHours ?? 'UNKNOWN'}h; heavy-lane occupancy=${u?.heavyLanes?.occupancyPct ?? 'UNKNOWN'}%; queue=${u?.queue?.hours ?? 'UNKNOWN'}h (${u?.queue?.taskHours ?? 'UNKNOWN'} task-hours).`,
    `Quota unused at reset (sample estimates): TTADK=${u?.quota?.ttadk?.tokensUnusedAtReset ?? 'UNKNOWN'} tokens; TRAE high-priority units by model=${perModel && Object.keys(perModel).length ? JSON.stringify(perModel) : 'UNKNOWN'}.`,
    `Top idleness causes: ${u?.topIdlenessCauses?.map((c) => `${c.cause} ${c.hours}h`).join('; ') || 'UNKNOWN / none established'}; missing coverage stays UNKNOWN; hints never dispatch and lane 3 requires its owner rollout.`,
  ];
}
