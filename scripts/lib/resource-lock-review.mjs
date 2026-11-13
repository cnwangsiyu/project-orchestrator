import { HEAVY_IDS } from './resource-locks.mjs';
import { GIB } from './resource-data.mjs';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const who = (v) => v?.project ? `${v.project}/${v.task ?? '(project only)'}` : '(unknown)';
const sameHolder = (a, b) => !!a.holder && a.holder === b.holder && (!a.project || !b.project || a.project === b.project) && (!a.task || !b.task || a.task === b.task);
const minutes = (n) => finite(n) ? +(n / 60000).toFixed(2) : null;

export function reviewLockTiming(samples, { since, now, maxGapMs }) {
  const events = [...new Map(samples.flatMap((s) => s.heavyLocks?.journal?.events ?? []).filter((e) => HEAVY_IDS.includes(e.resource) && finite(e.t) && e.t <= now && typeof e.eventId === 'string').map((e) => [e.eventId, e])).values()];
  // Map insertion order preserves journal row order within the same minute, including immediate take/return.
  events.sort((a, b) => a.t - b.t);
  const holds = [], open = new Map();
  for (const e of events) {
    if (e.action === 'take') {
      const previous = open.get(e.resource);
      if (previous) { previous.rightCensored = true; previous.endReason = 'next take without an observed release'; }
      const hold = { resource: e.resource, holder: e.holder, project: e.project, task: e.task,
        startLow: e.t, startHigh: e.t + 60000, endLow: null, endHigh: null, leftCensored: false, rightCensored: true,
        source: 'journal (~minute)', eventId: e.eventId };
      holds.push(hold); open.set(e.resource, hold);
    } else if (['return', 'reclaim'].includes(e.action)) {
      let hold = open.get(e.resource);
      if (hold && e.action === 'return' && !sameHolder(hold, e)) hold = null;
      if (!hold) {
        hold = { resource: e.resource, holder: e.action === 'return' ? e.holder : null, project: null, task: null,
          startLow: null, startHigh: null, leftCensored: true, source: 'release without captured take', eventId: e.eventId };
        holds.push(hold);
      } else open.delete(e.resource);
      hold.endLow = e.t; hold.endHigh = e.t + 60000; hold.rightCensored = false; hold.endReason = e.action;
      if (e.action === 'reclaim') hold.reclaimer = e.holder; // Reclaimer is not the old holder.
    }
  }
  for (const s of samples) for (const lock of s.heavyLocks?.locks ?? []) {
    if (!['HELD', 'STALE'].includes(lock.state)) continue;
    const exact = finite(lock.startMs) && lock.startMs <= s.t;
    const startLow = exact ? lock.startMs : null;
    let hold = holds.find((h) => {
      if (h.resource !== lock.id || !sameHolder(h, lock)) return false;
      if (!exact) return h.rightCensored && !finite(h.endHigh);
      if (!finite(h.startLow)) return h.leftCensored && finite(h.endHigh) && lock.startMs <= h.endHigh && s.t <= h.endHigh;
      const startMatches = lock.startMs >= h.startLow && (lock.startMs < h.startHigh || h.startHigh === h.startLow && lock.startMs === h.startLow);
      return startMatches && (!finite(h.endHigh) || lock.startMs <= h.endHigh);
    });
    if (!hold) {
      hold = { resource: lock.id, holder: lock.holder, project: lock.project, task: lock.task,
        startLow, startHigh: startLow, endLow: null, endHigh: null, leftCensored: !exact, rightCensored: true,
        source: exact ? 'lock metadata epoch start' : 'legacy lock; start unknown', pid: lock.pid };
      holds.push(hold);
    } else if (exact) { hold.startLow = startLow; hold.startHigh = startLow; hold.leftCensored = false; hold.project ??= lock.project; hold.task ??= lock.task; hold.source = 'journal + metadata epoch start'; }
    hold.pid ??= lock.pid;
    hold.firstObserved = Math.min(hold.firstObserved ?? s.t, s.t);
    hold.lastObserved = Math.max(hold.lastObserved ?? s.t, s.t);
  }
  const holdTimes = holds.filter((h) => (h.endHigh ?? h.lastObserved ?? h.startHigh ?? -Infinity) >= since).map((h) => {
    const lowerEnd = Math.max(h.endLow ?? -Infinity, h.lastObserved ?? -Infinity);
    return { resource: h.resource, holder: h.holder, owner: who(h), pid: h.pid ?? null,
      startAt: finite(h.startLow) ? new Date(h.startLow).toISOString() : null,
      startPrecisionSeconds: finite(h.startHigh) && finite(h.startLow) ? (h.startHigh - h.startLow) / 1000 : null,
      endAt: finite(h.endLow) ? new Date(h.endLow).toISOString() : null, endReason: h.endReason ?? 'still observed held / release unknown',
      durationMinutesLower: finite(h.startHigh) && finite(lowerEnd) ? minutes(Math.max(0, lowerEnd - h.startHigh)) : 0,
      durationMinutesUpper: finite(h.startLow) && finite(h.endHigh) ? minutes(Math.max(0, h.endHigh - h.startLow)) : null,
      leftCensored: h.leftCensored, rightCensored: h.rightCensored, source: h.source, reclaimer: h.reclaimer ?? null,
      lastObservedAt: finite(h.lastObserved) ? new Date(h.lastObserved).toISOString() : null };
  });

  const waits = new Map();
  for (let i = 0; i < samples.length; i++) for (const waiter of samples[i].heavyLocks?.waiters ?? []) {
    const s = samples[i], key = `${waiter.resource}/${waiter.id}`;
    const wait = waits.get(key) ?? { ...waiter, firstObserved: s.t, lastObserved: s.t, disappearance: null };
    wait.startMs = finite(waiter.startMs) ? Math.min(wait.startMs ?? Infinity, waiter.startMs) : wait.startMs;
    wait.lastObserved = s.t;
    const next = samples[i + 1];
    if (next?.processComplete && next.heavyLocks?.waitersComplete && next.t - s.t <= maxGapMs && !(next.heavyLocks.waiters ?? []).some((w) => w.id === waiter.id && w.resource === waiter.resource)) wait.disappearance = next.t;
    waits.set(key, wait);
  }
  const waitTimes = [...waits.values()].filter((w) => w.lastObserved >= since).map((w) => {
    const acquired = samples.find((s) => s.t >= w.lastObserved && s.t <= (w.disappearance ?? w.lastObserved) && s.heavyLocks?.locks?.some((l) => l.id === w.resource && l.pid === w.holderPid && sameHolder(w, l) && finite(l.startMs) && l.startMs >= w.lastObserved - 1000));
    const lock = acquired?.heavyLocks.locks.find((l) => l.id === w.resource && l.pid === w.holderPid && sameHolder(w, l));
    const end = lock?.startMs;
    return { resource: w.resource, holder: w.holder, owner: who(w), pid: w.pid, holderPid: w.holderPid,
      startAt: finite(w.startMs) ? new Date(w.startMs).toISOString() : null,
      firstObservedAt: new Date(w.firstObserved).toISOString(), lastObservedAt: new Date(w.lastObserved).toISOString(), timeoutMinutes: w.timeoutMinutes,
      durationMinutesLower: finite(w.startMs) ? minutes(Math.max(0, (end ?? w.lastObserved) - w.startMs - 1000)) : 0,
      durationMinutesUpper: finite(w.startMs) && finite(end ?? w.disappearance) ? minutes(Math.max(0, (end ?? w.disappearance) - w.startMs + 1000)) : null,
      rightCensored: !finite(end) && !finite(w.disappearance), outcome: finite(end) ? 'matching wrapper acquired' : w.disappearance ? 'disappeared; timeout/acquisition/error unknown' : 'still observed waiting; end unknown',
      source: 'observed res wait PID/elapsed (~1s); missed waits cannot be reconstructed from take journal' };
  });
  const staleLocks = samples.filter((s) => s.t >= since).flatMap((s) => (s.heavyLocks?.locks ?? []).filter((l) => l.stale === true).map((l) => ({ at: s.at ?? new Date(s.t).toISOString(), resource: l.id,
    holder: l.holder, owner: who(l), pid: l.pid, host: l.host, ageSeconds: l.ageSeconds, reclaimEligibleObserved: l.reclaimEligibleObserved })));
  return { holdTimes, waitTimes, staleLocks, journalEvents: events.filter((e) => e.t + 60000 >= since).length,
    journalSamples: samples.filter((s) => s.t >= since && s.heavyLocks?.journal?.complete).length,
    note: 'Holds use metadata epoch starts or minute-precision journal bounds. Null upper durations are censored, never zero. STALE does not authorize sampler reclamation. Wait starts/timeouts are absent from the live journal; only sampled res wait processes are measurable.' };
}

export function inspectLockInterval(a, b, { span, record }) {
  const result = { gateMinutes: 0, overloadedMinutes: 0, lockMinutes: 0, strictMinutes: 0, looseMinutes: 0, bypassMinutes: 0, comparableMinutes: 0 };
  const gate = a.heavyGate, nextGate = b.heavyGate;
  const authoritative = gate?.authoritative && nextGate?.authoritative;
  if (authoritative) {
    result.gateMinutes = span / 60000;
    if (gate.state === 'OVERLOADED') {
      result.overloadedMinutes = span / 60000;
      record('admission_gate_closed', 'host', a, b.t,
        `authoritative res heavy-check: load=${gate.load1m}, available=${(gate.availableBytes / GIB).toFixed(2)} GiB (${gate.availableBasis}); blocks >12 / <16 GiB; sampled interval, transitions may occur between probes`, [...new Set((a.heavyRoots ?? []).map((p) => who(p.owner)))]);
    }
  }
  if (!a.heavyLocks?.complete || !b.heavyLocks?.complete) return result;
  result.lockMinutes = span / 60000;
  for (const l of a.heavyLocks.locks) {
    const q = b.heavyLocks.locks.find((v) => v.id === l.id && v.pid === l.pid && v.startMs === l.startMs && v.holder === l.holder);
    if (l.stale === true && q?.stale === true) record('stale_heavy_lock', `${l.id}/${l.pid}/${l.startMs}`, a, b.t,
      `${l.id} holder=${l.holder ?? 'unknown'}, PID=${l.pid}, local host=${l.host}, age=${l.ageSeconds ?? 'unknown'}s; STALE >600s may be reclaimed by res wait only, never this sampler`, [who(l)]);
  }
  const nextRoots = new Map((b.heavyRoots ?? []).map((p) => [p.id, p]));
  const compliant = [], bypass = [];
  if (a.processComplete && b.processComplete) for (const p of a.heavyRoots ?? []) {
    const q = nextRoots.get(p.id); if (!q || !['package', 'lane'].includes(p.workload?.class) || q.workload?.class !== p.workload.class) continue;
    const checks = p.workload.class === 'package' ? ['buildLock', 'laneLock'] : ['laneLock'];
    const missing = checks.filter((key) => p[key]?.state === 'UNMATCHED' && q[key]?.state === 'UNMATCHED');
    if (missing.length) {
      bypass.push(p);
      record('heavy_build_without_lock', `${p.id}/${missing.join(',')}`, a, b.t,
        `PID ${p.pid} (${p.kind}, ${p.workload.class} candidate) has no matching holder for ${missing.join('+')}; ${p.workload.reason}; verify scope before enforcement`, [who(p.owner)]);
    } else if (checks.every((key) => p[key]?.state === 'MATCHED' && q[key]?.state === 'MATCHED')) compliant.push(p);
  }
  if (bypass.length) result.bypassMinutes = span / 60000;
  const sameSource = authoritative && gate.availableBasis === nextGate.availableBasis;
  const pressureKnown = ['normal', 'warning', 'critical'].includes(a.memory?.pressure) && ['normal', 'warning', 'critical'].includes(b.memory?.pressure);
  const swapKnown = finite(a.memory?.swapUsedBytes) && finite(b.memory?.swapUsedBytes);
  const waiters = a.heavyLocks.waiters ?? [];
  const waitingFree = a.heavyLocks.waitersComplete && b.heavyLocks.waitersComplete && waiters.some((w) =>
    (b.heavyLocks.waiters ?? []).some((q) => q.id === w.id && q.resource === w.resource) && a.heavyLocks.locks.find((l) => l.id === w.resource)?.state === 'FREE' && b.heavyLocks.locks.find((l) => l.id === w.resource)?.state === 'FREE');
  const comparable = sameSource && pressureKnown && swapKnown && finite(a.cpu?.idle) && finite(b.cpu?.idle) && a.processComplete && b.processComplete && (waitingFree || compliant.length > 0) && !bypass.length;
  if (comparable) result.comparableMinutes = span / 60000;
  if (comparable && waitingFree && gate.state === 'OVERLOADED' && nextGate.state === 'OVERLOADED' && a.cpu.idle >= 60 && b.cpu.idle >= 60 && a.memory.pressure === 'normal' && b.memory.pressure === 'normal' && b.memory.swapUsedBytes <= a.memory.swapUsedBytes) {
    result.strictMinutes = span / 60000;
    record('gate_possibly_too_strict', 'host', a, b.t, 'res wait observed at both endpoints for a FREE resource, authoritative gate closed, >=60% CPU idle, normal pressure, no swap growth; correlation, not proof that relaxing is safe', [...new Set(waiters.map(who))]);
  }
  if (comparable && compliant.length > 0 && gate.state === 'OK' && nextGate.state === 'OK' && ['warning', 'critical'].includes(a.memory.pressure) && ['warning', 'critical'].includes(b.memory.pressure) && b.memory.swapUsedBytes - a.memory.swapUsedBytes > GIB) {
    result.looseMinutes = span / 60000;
    record('gate_possibly_too_loose', 'host', a, b.t, 'matching-holder heavy build under an open authoritative gate, sustained pressure and >1 GiB swap allocation growth; investigate fan-out/JVM/cache first, not proof of threshold causation', [...new Set(compliant.map((p) => who(p.owner)))]);
  }
  return result;
}

export function assessThresholds(samples, stats, { loadGate, memoryGateGiB, approvedRanges, approvalEvidence, since }) {
  const direction = stats.strictMinutes > 0 && stats.looseMinutes > 0 ? 'conflicting' : stats.strictMinutes > 0 ? 'possibly-too-strict' : stats.looseMinutes > 0 ? 'possibly-too-loose' : 'insufficient-evidence';
  const daily = new Map();
  for (const entry of stats.comparableIntervals) {
    let t = entry.start;
    while (t < entry.end) {
      const date = new Date(t), day = date.toISOString().slice(0, 10), end = Math.min(entry.end, Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
      daily.set(day, (daily.get(day) ?? 0) + (end - t) / 60000); t = end;
    }
  }
  // Comparable intervals (same estimator, observed waits/compliant builds) must cover >=80% of three full UTC days.
  const wellCoveredDays = [...daily].filter(([day, n]) => Date.parse(day + 'T00:00:00Z') >= since && n >= 1152).length;
  const range = (key) => Array.isArray(approvedRanges?.[key]) && approvedRanges[key].length === 2 && approvedRanges[key].every(finite) && approvedRanges[key][0] > 0 && approvedRanges[key][1] >= approvedRanges[key][0];
  const approvalDate = typeof approvalEvidence === 'string' ? approvalEvidence.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] : null;
  const approvalEpoch = approvalDate ? Date.parse(approvalDate + 'T00:00:00Z') : NaN;
  const datedApproval = finite(approvalEpoch) && new Date(approvalEpoch).toISOString().slice(0, 10) === approvalDate && approvalEpoch <= (samples.at(-1)?.t ?? -Infinity);
  const authorized = range('loadGate') && range('memoryGateGiB') && datedApproval;
  const consistentPolicy = loadGate === 12 && memoryGateGiB === 16;
  const candidate = ['possibly-too-strict', 'possibly-too-loose'].includes(direction) ? {
    loadGate: loadGate + (direction === 'possibly-too-strict' ? 1 : -1),
    memoryGateGiB: memoryGateGiB + (direction === 'possibly-too-strict' ? -1 : 1),
  } : null;
  const inside = candidate && authorized && ['loadGate', 'memoryGateGiB'].every((key) => candidate[key] >= approvedRanges[key][0] && candidate[key] <= approvedRanges[key][1]);
  const consistentEstimator = new Set(samples.filter((s) => s.t >= since && s.heavyGate?.authoritative).map((s) => s.heavyGate.availableBasis)).size === 1;
  const adequate = wellCoveredDays >= 3 && stats.bypassMinutes === 0 && consistentPolicy && consistentEstimator;
  const eligible = !!(candidate && inside && adequate);
  const askUser = !!candidate && (!authorized || !inside || !adequate);
  const action = eligible ? 'Nightly review may propose one gate change within approved ranges, with task comparison and rollback evidence. Shared controller owner must acknowledge/apply; sampler never changes enforcement.'
    : askUser ? 'Retain 12/16. Ask the user before any change: approval/range/comparable coverage or discipline evidence is insufficient.'
      : 'Retain 12/16: no consistent strict/loose candidate established; missing data is not evidence that thresholds are correct.';
  return { loadGate, memoryGateGiB, heavyPackageSlots: 1, heavyTaskLanes: 2, approvedRanges, approvalEvidence, direction,
    strictCandidateMinutes: stats.strictMinutes, looseCandidateMinutes: stats.looseMinutes, bypassCandidateMinutes: stats.bypassMinutes,
    comparableMinutes: stats.comparableMinutes, wellCoveredComparableDays: wellCoveredDays, automaticRangeAuthorized: authorized,
    observationPolicyMatchesController: consistentPolicy, consistentEstimator, candidate, candidateWithinApprovedRanges: !!inside, nightlyAdjustmentEligible: eligible, askUser,
    decisionCard: askUser ? `资源阈值复盘：当前 load >12 或可用内存 <16 GiB 排队。观测到${direction === 'possibly-too-strict' ? '可能过严' : '可能过松'}的相关证据（${stats.strictMinutes || stats.looseMinutes} 分钟），但不能证明因果。候选 load=${candidate.loadGate} / 内存=${candidate.memoryGateGiB} GiB；可比且充分覆盖 ${wellCoveredDays} 天，锁绕过候选 ${stats.bypassMinutes} 分钟。是否授权试点及范围？请指定回滚条件；未获批准保持 12/16，由共享 res 负责人实施。` : null,
    note: 'Candidates are correlated diagnostic steps, not proven optimal settings. Change one gate at a time, compare like tasks and wall/wait times. Bypasses, estimator drift and thin/conflicting coverage disqualify automatic tuning.', action };
}
