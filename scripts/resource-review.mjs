#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIB, LOG, readJsonl, TERMINAL } from './lib/resource-data.mjs';
import { assessThresholds, inspectLockInterval, reviewLockTiming } from './lib/resource-lock-review.mjs';
import { reviewExtras } from './lib/resource-extras.mjs';

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const ownerKey = (o) => o?.project ? `${o.project}/${o.task ?? '(project only)'}` : '(unknown)';
export function review(input, { hours = 24, now = Date.now(), maxGapMs = 600000, loadGate = 12, memoryGateGiB = 16, approvedRanges = null, approvalEvidence = null } = {}) {
  const since = now - hours * 3600000, samples = [...new Map(input.filter((s) => s.schema === 1 && finite(s.t) && s.t >= since - maxGapMs && s.t <= now).map((s) => [`${s.host}/${s.t}`, s])).values()].sort((a, b) => a.t - b.t);
  const hosts = new Set(samples.map((s) => s.host));
  if (hosts.size > 1) return { hours, coverage: { observedMinutes: 0, reason: 'mixed hosts refused; review each machine separately' }, badCases: [], resourceShares: [], suggestions: [] };
  const series = new Map(), shares = new Map(), counters = { cpuMinutes: 0, cpuIdleMinutes: 0, processMinutes: 0, contentionMinutes: 0, underuseMinutes: 0, possibleUnderuseMinutes: 0 };
  const lockStats = { gateMinutes: 0, overloadedMinutes: 0, lockMinutes: 0, strictMinutes: 0, looseMinutes: 0, bypassMinutes: 0, comparableMinutes: 0, comparableIntervals: [] };
  let observedMs = 0, gaps = 0;
  const record = (type, key, a, end, evidence, owners = []) => {
    const id = `${type}:${key}`, list = series.get(id) ?? [], last = list.at(-1);
    if (last && last.end === a.t) { last.end = end; last.minutes = (end - last.start) / 60000; last.observations++; last.evidence = evidence; }
    else list.push({ type, caseKey: key, start: Math.max(a.t, since), end, minutes: (end - Math.max(a.t, since)) / 60000, owners, evidence, observations: 2 });
    series.set(id, list);
  };
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i], b = samples[i + 1], gap = b.t - a.t;
    if (gap <= 0 || gap > maxGapMs) { gaps++; continue; }
    const span = b.t - Math.max(a.t, since); if (span <= 0) continue;
    const minutes = span / 60000; observedMs += span;
    const stats = inspectLockInterval(a, b, { span, record });
    for (const key of Object.keys(stats)) lockStats[key] += stats[key];
    if (stats.comparableMinutes) lockStats.comparableIntervals.push({ start: Math.max(a.t, since), end: b.t });
    const waiting = (a.tasks ?? []).filter((t) => ['queued', 'waiting', 'blocked'].includes(t.status) && !['dependency', 'user', 'network'].includes(t.waitReason));
    const ready = waiting.filter((t) => t.ready === true && ['resource', 'load', 'memory', 'heavy-build'].includes(t.waitReason));
    const owners = [...new Set(waiting.map(ownerKey))];
    if (finite(a.cpu?.idle) && finite(b.cpu?.idle)) {
      counters.cpuMinutes += minutes; counters.cpuIdleMinutes += a.cpu.idle / 100 * minutes;
      if (a.cpu.idle >= 60 && waiting.length) {
        const type = ready.length ? 'underuse' : 'possible_underuse';
        counters[ready.length ? 'underuseMinutes' : 'possibleUnderuseMinutes'] += minutes;
        record(type, owners.join(','), a, b.t, `${a.cpu.idle}% CPU idle with ${waiting.length} waiting task(s); readiness ${ready.length ? 'resource-ready' : 'unverified'}`, owners);
      }
    }
    const loadContention = finite(a.load?.[0]) && finite(a.cores) && a.load[0] > a.cores;
    const pressure = ['critical', 'warning'].includes(a.memory?.pressure);
    if (loadContention || pressure) {
      counters.contentionMinutes += minutes;
      const active = [...new Set((a.heavyRoots ?? []).map((p) => ownerKey(p.owner)))];
      record('contention', active.join(','), a, b.t, `load=${a.load?.[0] ?? 'unknown'} / cores=${a.cores}; memory pressure=${a.memory?.pressure ?? 'unknown'} (free-percentage heuristic)`, active);
    }
    if (!a.heavyGate?.authoritative && (finite(a.load?.[0]) && a.load[0] > 12 || finite(a.memory?.availableBytes) && a.memory.availableBytes < 16 * GIB)) {
      record('admission_gate_estimate', 'host', a, b.t, `non-authoritative legacy/sample estimate only: load=${a.load?.[0] ?? 'unknown'}, available=${finite(a.memory?.availableBytes) ? (a.memory.availableBytes / GIB).toFixed(1) + ' GiB' : 'unknown'}; heavy-check UNKNOWN, not an established gate closure`);
    }
    if (finite(a.memory?.swapUsedBytes) && finite(b.memory?.swapUsedBytes) && b.memory.swapUsedBytes - a.memory.swapUsedBytes > GIB) record('swap_growth', 'host', a, b.t, `swap allocation grew ${((b.memory.swapUsedBytes - a.memory.swapUsedBytes) / GIB).toFixed(2)} GiB; not swap I/O bytes`);
    const packages = (a.heavyRoots ?? []).filter((p) => p.workload ? p.workload.class === 'package' : ['xcodebuild', 'gradle'].includes(p.kind));
    if (a.processComplete && b.processComplete && packages.length > 1) record('overlapping_package_builds', packages.map((p) => p.id).sort().join(','), a, b.t, `${packages.length} independent package roots; PIDs ${packages.map((p) => p.pid).join(',')}; compiler children excluded`, [...new Set(packages.map((p) => ownerKey(p.owner)))]);
    const heavyOwners = [...new Set((a.heavyRoots ?? []).filter((p) => (!p.workload || ['package', 'lane'].includes(p.workload.class)) && p.owner?.project && p.owner?.task).map((p) => ownerKey(p.owner)))];
    if (a.processComplete && b.processComplete && heavyOwners.length > 2) record('overlapping_heavy_workloads', heavyOwners.join(','), a, b.t, `${heavyOwners.length} owners with independent build/test roots; verify two-lane leases and workload classification before calling this a violation`, heavyOwners);
    if (!a.processComplete || !b.processComplete) continue;
    counters.processMinutes += minutes;
    const next = new Map((b.processes ?? []).map((p) => [p.id, p]));
    for (const p of a.processes ?? []) {
      const q = next.get(p.id); if (!q) continue;
      const delta = q.cpuSeconds - p.cpuSeconds, cpuPct = delta * 100000 / gap;
      if (!finite(delta) || delta < 0 || delta > gap / 1000 * Math.max(a.cores ?? 1, 1) * 1.2) continue;
      const key = ownerKey(p.owner), share = shares.get(key) ?? { owner: key, cpuSeconds: 0, rssByteSeconds: 0, observedSeconds: 0 };
      share.cpuSeconds += delta * span / gap; share.rssByteSeconds += p.rssBytes * span / 1000; share.observedSeconds += span / 1000; shares.set(key, share);
      if (p.kind === 'worker' && cpuPct <= .5) record('idle_worker', p.id, a, b.t, `PID ${p.pid} alive, CPU increment=${delta.toFixed(2)} seconds; idle model/network wait is not automatically waste`, [key]);
      if (TERMINAL.has(p.owner?.status) && TERMINAL.has(q.owner?.status) && cpuPct <= .5 && finite(p.owner?.changedAt) && a.t - p.owner.changedAt >= 7200000 && (!finite(p.owner?.activityAt) || a.t - p.owner.activityAt >= 7200000)) record('possible_orphan_tree', p.id, a, b.t, `PID ${p.pid}; owner status=${p.owner.status}; terminal ledger plus idle CPU; cleanup must recheck activity, live workers, leases and releases`, [key]);
      if (p.kind === 'chrome' && cpuPct >= 100) record('suspected_hung_chrome', p.id, a, b.t, `PID ${p.pid}, sustained CPU >=100%; responsiveness not measured, ask owner before restart`, [key]);
      if (p.kind === 'simulator') record('simulator_left_running', p.id, a, b.t, `PID ${p.pid}; running service is not proof of an unused booted simulator; report only`, [key]);
    }
  }
  const limits = { idle_worker: 120, possible_orphan_tree: 120, suspected_hung_chrome: 60, simulator_left_running: 120 };
  const extras = reviewExtras(samples, { since, maxGapMs, record });
  const badCases = [...series.values()].flat().filter((c) => c.minutes >= (limits[c.type] ?? 0)).sort((a, b) => a.start - b.start).map((c) => ({ ...c, startAt: new Date(c.start).toISOString(), endAt: new Date(c.end).toISOString(), minutes: +c.minutes.toFixed(2) }));
  const allShares = [...shares.values()], totalCpu = allShares.reduce((n, s) => n + s.cpuSeconds, 0), totalRss = allShares.reduce((n, s) => n + s.rssByteSeconds, 0);
  const resourceShares = allShares.map((s) => ({ owner: s.owner, sampledCpuSeconds: +s.cpuSeconds.toFixed(2), cpuSharePct: totalCpu ? +(s.cpuSeconds / totalCpu * 100).toFixed(2) : null, sampledRssSharePct: totalRss ? +(s.rssByteSeconds / totalRss * 100).toFixed(2) : null })).sort((a, b) => b.sampledCpuSeconds - a.sampledCpuSeconds);
  const diskSamples = samples.filter((s) => s.t >= since && finite(s.disk?.freeBytes));
  const firstDisk = diskSamples[0], lastDisk = diskSamples.at(-1);
  const suggestions = [];
  const has = (type) => badCases.some((c) => c.type === type);
  if (has('overlapping_package_builds') || has('overlapping_heavy_workloads')) suggestions.push('Audit wrapper adoption of the ONE machine-wide heavy-build slot and TWO heavy-task lanes; do not kill competing builds.');
  if (has('heavy_build_without_lock')) suggestions.push('Fix matching-wrapper heavy-build/lane adoption before blaming thresholds; verify workload exemptions with the exact owner.');
  if (has('stale_heavy_lock')) suggestions.push('Ask the recorded holder/controller owner to inspect STALE PID holds; only res wait may reclaim eligible >600s holds. Review never returns/reclaims locks.');
  if (has('hub_outage') || has('hub_partial_outage') || extras.hubs.outageObservations.length) suggestions.push('Report hub listener outages to the routing/global-rules owner with probe time/ports. Daemon restart causality and application health need owner confirmation; never auto-restart hubs here.');
  if (has('contention') || has('swap_growth')) suggestions.push('Keep package builds serial; compare compiler/test fan-out and JVM limits before reducing concurrency or tightening gates.');
  if (has('underuse')) suggestions.push('Dispatch ready lightweight work while heavy work waits; compare admission estimates with the installed heavy-check before proposing a small gate change.');
  if (has('possible_underuse')) suggestions.push('Ask owners for resource-tasks.json readiness/wait reasons; CPU idle during network/user/dependency waits is not actionable under-use.');
  if (has('possible_orphan_tree') || has('suspected_hung_chrome')) suggestions.push('Send owners the exact time/PID cases; dry-run guarded cleanup with fresh inventory and every orchestrator release.');
  if (lastDisk && lastDisk.disk.freeBytes < 10 ** 12) suggestions.push('Disk below 1 TB: only registered self-made build clones/templates may enter guarded cleanup, never source worktrees or user files.');
  return { schema: 1, hours, window: { since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    coverage: { samples: samples.filter((s) => s.t >= since).length, observedMinutes: +(observedMs / 60000).toFixed(2), requestedMinutes: hours * 60, coveragePct: +(observedMs / (hours * 3600000) * 100).toFixed(2), gaps, cpuMinutes: counters.cpuMinutes, processMinutes: counters.processMinutes, heavyGateMinutes: lockStats.gateMinutes, heavyLockMinutes: lockStats.lockMinutes, hubMinutes: extras.hubs.observedMinutes, ccacheMinutes: extras.ccache.observedMinutes, incompleteSamples: samples.filter((s) => !s.complete).length,
      note: 'Intervals require two samples <=10 min apart; no extrapolation through gaps, before first sample or after last. CPU/RSS omit short-lived processes between samples.' },
    utilisation: { meanCpuIdlePct: counters.cpuMinutes ? +(counters.cpuIdleMinutes / counters.cpuMinutes * 100).toFixed(2) : null, contentionMinutes: observedMs ? counters.contentionMinutes : null, underuseMinutes: counters.cpuMinutes ? counters.underuseMinutes : null, possibleUnderuseMinutes: counters.cpuMinutes ? counters.possibleUnderuseMinutes : null },
    diskTrend: firstDisk && lastDisk && lastDisk.t > firstDisk.t ? { startAt: firstDisk.at, endAt: lastDisk.at, freeBytesStart: firstDisk.disk.freeBytes, freeBytesEnd: lastDisk.disk.freeBytes, changeBytes: lastDisk.disk.freeBytes - firstDisk.disk.freeBytes } : null,
    resourceShares, resourceShareNote: 'CPU share is cumulative process CPU deltas; RSS share is sampled RSS*time (shared pages double-count), not ownership of physical RAM.', badCases, suggestions,
    heavyLocks: reviewLockTiming(samples, { since, now, maxGapMs }),
    ...extras,
    heavyGate: { loadGate: 12, memoryGateGiB: 16, authoritativeMinutes: lockStats.gateMinutes,
      overloadedMinutes: lockStats.gateMinutes ? lockStats.overloadedMinutes : null,
      openMinutes: lockStats.gateMinutes ? lockStats.gateMinutes - lockStats.overloadedMinutes : null,
      unknownMinutes: (observedMs / 60000) - lockStats.gateMinutes,
      overloadPeriods: badCases.filter((c) => c.type === 'admission_gate_closed'), note: 'res heavy-check state/exit 0 or 5 is authoritative, not page estimates. Durations are sampled interval estimates; gate transitions between endpoints are not timestamped.' },
    tuning: assessThresholds(samples, lockStats, { loadGate, memoryGateGiB, approvedRanges, approvalEvidence, since }) };
}
export function formatReview(r) {
  const lines = [`# Machine resources: last ${r.hours}h`, `Coverage: ${r.coverage.observedMinutes} observed minutes; ${r.coverage.samples ?? 0} samples; CPU=${r.coverage.cpuMinutes ?? 0} min, processes=${r.coverage.processMinutes ?? 0} min. Missing data is UNKNOWN.`, `CPU idle: ${r.utilisation?.meanCpuIdlePct ?? 'UNKNOWN'}%; contention: ${r.utilisation?.contentionMinutes ?? 'UNKNOWN'} min.`, ''];
  lines.push(`Heavy gate >12 / <16 GiB: overloaded=${r.heavyGate?.overloadedMinutes ?? 'UNKNOWN'} min; open=${r.heavyGate?.openMinutes ?? 'UNKNOWN'} min; authoritative=${r.coverage.heavyGateMinutes ?? 0} min, locks=${r.coverage.heavyLockMinutes ?? 0} min.`);
  const bounds = (v) => `${v.durationMinutesLower ?? 0}..${v.durationMinutesUpper ?? 'UNKNOWN'} min`;
  for (const h of r.heavyLocks?.holdTimes ?? []) lines.push(`Lock hold ${h.resource}: holder=${h.holder ?? 'unknown'}, owner=${h.owner}, start=${h.startAt ?? 'UNKNOWN'}, end=${h.endAt ?? h.lastObservedAt ?? 'UNKNOWN'}, duration=${bounds(h)}, censored=${h.leftCensored}/${h.rightCensored}; ${h.source}; ${h.endReason}`);
  for (const w of r.heavyLocks?.waitTimes ?? []) lines.push(`Lock wait ${w.resource}: holder=${w.holder ?? 'unknown'}, owner=${w.owner}, PID=${w.pid}, start=${w.startAt ?? 'UNKNOWN'}, last=${w.lastObservedAt}, duration=${bounds(w)}, timeout=${w.timeoutMinutes ?? 'UNKNOWN'} min; ${w.outcome}`);
  for (const l of r.heavyLocks?.staleLocks ?? []) lines.push(`STALE observation: ${l.at}, ${l.resource}, holder=${l.holder ?? 'unknown'}, owner=${l.owner}, PID=${l.pid}, age=${l.ageSeconds ?? 'UNKNOWN'}s`);
  lines.push(r.heavyLocks?.note ?? 'Lock timings UNKNOWN: no contract observations.');
  lines.push(`Hub ports 47321-47324: observed=${r.hubs?.observedMinutes ?? 0} min; all missing=${r.hubs?.allMissingMinutes ?? 'UNKNOWN'} min; partial=${r.hubs?.partialMissingMinutes ?? 'UNKNOWN'} min.`);
  for (const h of r.hubs?.outageObservations ?? []) lines.push(`Hub outage observation: ${h.at}; ${h.state}; missing ports=${h.missingPorts.join(',')}; duration unknown from this observation alone.`);
  for (const h of r.hubs?.transitions ?? []) lines.push(`Hub transition ${h.from} -> ${h.to}: bounded between ${h.earliestAt} and ${h.latestAt}; missing ports at end=${h.missingPortsAtEnd.join(',')}.`);
  lines.push(`ccache: available=${r.ccache?.latestObservation?.available ?? 'UNKNOWN'}; window hit rate=${r.ccache?.windowHitRatePct ?? 'UNKNOWN'}%; hits=${r.ccache?.sampledHits ?? 'UNKNOWN'}, misses=${r.ccache?.sampledMisses ?? 'UNKNOWN'}, resets=${r.ccache?.counterResetIntervals ?? 0}; latest cumulative hit rate=${r.ccache?.latest?.hitRatePct ?? 'UNKNOWN'}%.`, r.ccache?.note ?? 'ccache stats unavailable.');
  for (const c of r.badCases) lines.push(`${c.type}: ${c.startAt} -> ${c.endAt} (${c.minutes} min), owners=${c.owners.join(',') || '(unknown)'}, key=${c.caseKey}; ${c.evidence}`);
  if (!r.badCases.length) lines.push('No bad cases established in observed intervals (not a clean bill of health).');
  lines.push('', 'Resource shares: sampled cumulative CPU / sampled RSS, not physical RAM');
  for (const s of r.resourceShares) lines.push(`${s.owner}: ${s.sampledCpuSeconds}s CPU; CPU share ${s.cpuSharePct ?? 'unknown'}%; RSS share ${s.sampledRssSharePct ?? 'unknown'}%`);
  lines.push('', `Disk trend: ${r.diskTrend ? (r.diskTrend.changeBytes / GIB).toFixed(2) + ' GiB free-space change' : 'UNKNOWN'}`, ...r.suggestions.map((s) => `Suggestion: ${s}`),
    `Threshold assessment: ${r.tuning?.direction ?? 'UNKNOWN'}; strict=${r.tuning?.strictCandidateMinutes ?? 0} min, loose=${r.tuning?.looseCandidateMinutes ?? 0} min; nightly adjustment eligible=${r.tuning?.nightlyAdjustmentEligible ?? false}.`,
    r.tuning?.action ?? r.coverage.reason, ...(r.tuning?.decisionCard ? [r.tuning.decisionCard] : []));
  return lines.join('\n');
}
async function main() {
  const args = process.argv.slice(2); let hours = 24, file = LOG, stdin = false, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hours') hours = Number(args[++i]);
    else if (args[i] === '--input') file = args[++i];
    else if (args[i] === '--stdin') stdin = true;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--read-only') continue;
    else throw Error(`unknown option: ${args[i]}`);
  }
  if (!(hours > 0 && hours <= 336)) throw Error('--hours must be >0 and <=336');
  let rows = [], errors = [];
  if (stdin) { let s = ''; for await (const c of process.stdin) s += c; for (const line of s.split('\n').filter((x) => x.trim())) rows.push(JSON.parse(line)); }
  else {
    if (!file) throw Error('--input needs a JSONL path');
    const files = [file, ...Array.from({ length: 6 }, (_, i) => `${file}.${i + 1}`)].filter((f) => fs.existsSync(f));
    // Archive names retain the .jsonl suffix when passed to the generic reader via streams below.
    for (const f of files) {
      const read = await readJsonl([f], Date.now() - hours * 3600000 - 600000); rows.push(...read.rows); errors.push(...read.errors);
    }
    if (!files.length) errors.push('resource log absent; sampler not installed or no retained samples');
  }
  const policy = JSON.parse(fs.readFileSync(new URL('./resource-policy.json', import.meta.url), 'utf8'));
  const r = review(rows, { ...policy, hours }); r.readErrors = errors;
  console.log(json ? JSON.stringify(r, null, 2) : formatReview(r) + (errors.length ? `\nRead errors: ${errors.join('; ')}` : ''));
  if (!r.coverage.observedMinutes || errors.length) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`BLOCKED: ${e.message}`); process.exitCode = 2; });
