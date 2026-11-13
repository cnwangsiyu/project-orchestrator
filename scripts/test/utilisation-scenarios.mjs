#!/usr/bin/env node
// Pure telemetry plus isolated real entry points. No live login, locks, hubs or host installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GIB, readRegistry } from '../lib/resource-data.mjs';
import { idleHints, writeIdleHints } from '../resource-idle-hint.mjs';
import { laneAdmission, lockSnapshot, observeWaiters, parseHeavyStatus, parseHeavyCheck, readLockJournal } from '../lib/resource-locks.mjs';
import { ttadkBurn, ttadkExpiringUnused, TTADK_EXPIRY_HINT } from '../lib/company-load.mjs';
import { quotaUtilisation } from '../lib/resource-utilisation.mjs';
import { collect } from '../resource-sample.mjs';
import { review, formatReview } from '../resource-review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'utilisation-test-'));
const now = Date.now(), h = 3600000, min = 60000, SOL = 'gpt-6.1-sol';
const ready = { project: 'p', task: 'T1', status: 'queued', ready: true, waitReason: null };
const locks = (third = false) => ({ complete: true, waitersComplete: true, waiters: [], locks: ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', ...(third ? ['heavy-lane-3'] : [])]
  .map((id) => ({ id, state: 'FREE', stale: false })) });
const sample = (t, extra = {}) => ({ schema: 1, host: 'fixture', t, at: new Date(t).toISOString(), complete: true,
  attributionComplete: true, processComplete: true, cpu: { idle: 80 }, load: [2, 2, 2], cores: 14,
  memory: { availableBytes: 40 * GIB, pressure: 'normal', swapUsedBytes: 0 }, projects: [{ project: 'p', orchestrator: 'P main' }],
  tasks: [ready], processes: [], heavyRoots: [], heavyLocks: locks(), heavyGate: { authoritative: true, state: 'OK', limit: 12, lanes_held: 0, availableBasis: 'fixture' }, ...extra });
const rows = [sample(now - 10 * min), sample(now - 5 * min), sample(now)];
try {
  assert.equal(idleHints(rows, { now }).length, 1);
  const chineseName = 'P \u4e3b\u5bf9\u8bdd';
  assert.equal(idleHints(rows.map((s) => ({ ...s, projects: [{ project: 'p', orchestrator: chineseName }] })), { now })[0].target, chineseName);
  for (const patch of [{ load: [6] }, { cpu: { idle: 50 } }, { cpu: null }, { complete: false }, { attributionComplete: false },
    { heavyLocks: { ...locks(), waiters: [{ id: 'wait' }] } }, { heavyLocks: { ...locks(), waitersComplete: false } },
    { tasks: [{ ...ready, status: 'running' }] }, { tasks: [{ ...ready, dispatched: true }] },
    { tasks: [{ ...ready, waitReason: 'user' }] }, { tasks: [{ ...ready, waitReason: 'quota' }] }, { projects: [] }])
    assert.equal(idleHints(rows.map((s, i) => i === 2 ? { ...s, ...patch } : s), { now }).length, 0, JSON.stringify(patch));
  assert.equal(idleHints(rows, { now: now + 7 * min }).length, 0);
  assert.equal(idleHints([rows[0], { ...rows[1], host: 'other' }, rows[2]], { now }).length, 0);
  assert.equal(idleHints([rows[0], { ...rows[1], t: now - 2 * min }, rows[2]], { now }).length, 0);
  const file = path.join(tmp, 'idle-hints.jsonl'), printed = [];
  assert.equal(writeIdleHints({ samples: rows, file, now, print: (s) => printed.push(s) }).length, 1);
  assert.equal(printed[0], `Target: P main\n${JSON.parse(fs.readFileSync(file, 'utf8')).message}`);
  const later = (delta) => rows.map((s) => ({ ...s, t: s.t + delta }));
  assert.equal(writeIdleHints({ samples: later(59 * min), file, now: now + 59 * min, print: () => {} }).length, 0);
  assert.equal(writeIdleHints({ samples: later(60 * min), file, now: now + 60 * min, print: () => {} }).length, 1);
  assert.equal(idleHints(rows.map((s) => ({ ...s, projects: [...s.projects, { project: 'q', orchestrator: 'P main' }], tasks: [...s.tasks, { ...ready, project: 'q' }] })), { now }).length, 1);
  fs.writeFileSync(`${file}.lock`, '');
  assert.throws(() => writeIdleHints({ samples: rows, file, now }), /EEXIST/); fs.unlinkSync(`${file}.lock`);
  const rotated = path.join(tmp, 'rotated'); fs.mkdirSync(rotated);
  const rotatedLog = path.join(rotated, 'resource-log.jsonl');
  fs.writeFileSync(`${rotatedLog}.1`, JSON.stringify(rows[0]) + '\n');
  fs.writeFileSync(rotatedLog, rows.slice(1).map((s) => JSON.stringify(s) + '\n').join(''));
  assert.equal(writeIdleHints({ log: rotatedLog, file: path.join(rotated, 'idle-hints.jsonl'), now, print: () => {} }).length, 1);
  console.log('PASS idle thresholds, evidence, exact delivery, 60-minute cooldown and non-dispatch');

  const ledgerRoot = path.join(tmp, 'ledgers'), projectDir = path.join(ledgerRoot, 'p'); fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'ledger.md'), 'Orchestrator session: "P main"\n### T1\n- status: ready\n### T2\n- status: pending\nSome READY prose\n### T3\n- status: ready waiting on user\n');
  let registry = await readRegistry({ roots: [ledgerRoot], routeFile: path.join(tmp, 'empty.jsonl') });
  assert.equal(registry.tasks.find((t) => t.task === 'T1').ready, true);
  assert.equal(registry.tasks.find((t) => t.task === 'T2').ready, false);
  assert.equal(registry.tasks.find((t) => t.task === 'T3').ready, false);
  fs.writeFileSync(path.join(tmp, 'route-log.jsonl'), JSON.stringify({ t: now, project: 'p', name: 'T1', kind: 'route' }) + '\n');
  registry = await readRegistry({ roots: [ledgerRoot], routeFile: path.join(tmp, 'route-log.jsonl') });
  assert.equal(registry.tasks.find((t) => t.task === 'T1').ready, false);
  console.log('PASS conservative ledger readiness and later dispatch clears ready');

  const leases = { complete: true, registered: ['heavy-build', 'heavy-lane-1', 'heavy-lane-2'], held: [], errors: [] };
  assert.equal(lockSnapshot(leases, [], { host: 'fixture', psStartedAt: now, now, processComplete: true }).complete, true);
  leases.registered.push('heavy-lane-3');
  assert.equal(lockSnapshot(leases, [], { host: 'fixture', psStartedAt: now, now, processComplete: true }).locks.length, 4);
  const status = leases.registered.map((id) => `${id} slot - - FREE`).join('\n');
  assert.equal(parseHeavyStatus(status).locks.length, 4); assert.equal(parseHeavyStatus(status).complete, true);
  const held = (id) => ({ id, state: 'HELD', stale: false, local: true, pidIdentity: 'observed', pid: id.endsWith('1') ? 1 : 2 });
  const snapshot = locks(true); snapshot.locks = snapshot.locks.map((l) => /lane-[12]$/.test(l.id) ? held(l.id) : l);
  assert.equal(laneAdmission(snapshot).thirdLaneOnly, true);
  assert.equal(laneAdmission(snapshot).state, 'KNOWN');
  assert.equal(laneAdmission(snapshot).lane3, null); // Legacy capacity is not lane-3 permission.
  const closed = { ...snapshot, lane3: 'CLOSED' }, open = { ...snapshot, lane3: 'OPEN' };
  assert.equal(laneAdmission(closed).thirdLaneOnly, true);
  assert.equal(laneAdmission(closed).state, 'NO_CAPACITY');
  assert.equal(laneAdmission(closed).loadGate, null);
  assert.equal(laneAdmission(open).state, 'KNOWN');
  assert.equal(laneAdmission(open).loadGate, 20);
  const v13Text = 'load1m=8.00 limit=20 lanes_held=2 avail=32.00GiB (memorystatus 50%) pages_headroom=0.00GiB swap_used=0.00GiB gate=OK lane3=CLOSED';
  const v13 = parseHeavyCheck(v13Text);
  assert.equal(v13.state, 'OK'); assert.equal(v13.lane3, 'CLOSED');
  assert.equal(v13.controllerPolicy, 'v1.3-lane-aware');
  assert.equal(parseHeavyCheck(v13Text.replace('CLOSED', 'OPEN')).lane3, 'OPEN');
  for (const observation of [snapshot, closed, open]) {
    const tuning = review([sample(now, { heavyLocks: observation, heavyGate: v13 })], { now }).tuning;
    assert.equal(tuning.entryObservations[0].thirdLaneOnly, true);
    assert.equal(tuning.entryObservations[0].controllerMatchesApprovedPolicy, null);
    assert.equal(tuning.nightlyAdjustmentEligible, false);
  }
  snapshot.locks[3] = held('heavy-lane-3'); assert.equal(laneAdmission(snapshot).state, 'NO_CAPACITY');
  snapshot.locks[1] = { id: 'heavy-lane-1', state: 'FREE', stale: false };
  assert.equal(laneAdmission(snapshot).thirdLaneOnly, false); assert.equal(laneAdmission(snapshot).loadGate, 20);
  assert.equal(laneAdmission({ ...snapshot, lane3: 'CLOSED' }).loadGate, 20); // Normal capacity is unchanged.
  const unregistered = { ...leases, registered: leases.registered.slice(0, 3),
    held: [{ id: 'heavy-lane-3', pid: 100, host: 'fixture', startMs: now - min }] };
  assert.equal(lockSnapshot(unregistered, [], { host: 'fixture', psStartedAt: now, now, processComplete: true }).complete, false);
  assert.equal(parseHeavyCheck('load1m=2.00 limit=20 lanes_held=2 headroom=40.00 GiB gate=OK').authoritative, true);
  const waitRows = [{ pid: 200, ppid: 100, elapsedSeconds: 60, _command: '/safe/res wait heavy-lane-3 --by fixture --project p --task T1 --pid 100 --timeout 20' }];
  assert.equal(observeWaiters(waitRows, [{ pid: 200, id: 'wait3' }], now)[0].resource, 'heavy-lane-3');
  const journalDir = path.join(tmp, 'journal'); fs.mkdirSync(journalDir);
  fs.writeFileSync(path.join(journalDir, 'log.tsv'), '2026-11-13 01:00\ttake\theavy-lane-3\tfixture (p/T1)\t\n');
  assert.equal(readLockJournal(journalDir).events[0].resource, 'heavy-lane-3');
  const event = { eventId: 'fixture:lane3', action: 'take', resource: 'heavy-lane-3', t: now - min,
    holder: 'fixture', project: 'p', task: 'T1', precisionMs: min };
  const timing = review([sample(now, { heavyLocks: { ...locks(true), journal: { events: [event] } } })], { now }).heavyLocks;
  assert.ok(timing.holdTimes.some((hold) => hold.resource === 'heavy-lane-3'));
  console.log('PASS optional third lane status, registry, capacity and gate compatibility');

  const policy = JSON.parse(fs.readFileSync(path.join(root, 'resource-policy.json'), 'utf8'));
  assert.deepEqual(policy.lane3Gate, { load1mMax: 8, availableMemoryGiBMin: 32 });
  assert.deepEqual(policy.heavyTaskLaneRange, [2, 3]);
  assert.equal(policy.heavyTaskLanes, 3); assert.equal(policy.thirdLaneGate, undefined);
  assert.equal(policy.loadGate, 12); assert.equal(policy.loadGateWithOneHeavyTask, 20); assert.equal(policy.memoryGateGiB, 16);
  assert.deepEqual(policy.idleHint, { loadBelow: 6, cpuIdleAbovePct: 50, samples: 3, cooldownMinutes: 60 });
  assert.deepEqual(policy.ttadkExpiry, { windowHours: 4, projectedShareBelow: 0.7 });
  console.log('PASS one lane-3 policy retains idle/expiry thresholds and ordinary gates');

  const account = { name: 'ttadk', usage: { used: 20, limit: 100, resetsAt: now + 3 * h } };
  const history = [{ t: now - h, ttadk: { name: 'ttadk', ...account.usage, used: 10 } }];
  const burn = ttadkBurn(history, account, now, now);
  assert.equal(burn.projectedAtReset, 50); assert.equal(ttadkExpiringUnused({ ...account, burn }, now), true);
  for (const [q, b] of [[{ ...account.usage, resetsAt: now + 4 * h }, burn], [account.usage, null],
    [account.usage, { ...burn, sampledAt: now - 31 * min }], [account.usage, { ...burn, projectedAtReset: 70 }],
    [{ ...account.usage, resetsAt: now }, burn]]) assert.equal(ttadkExpiringUnused({ usage: q, burn: b }, now), false);
  const zero = ttadkBurn([{ t: now - h, ttadk: { name: 'ttadk', ...account.usage } }], account, now, now);
  assert.equal(zero.projectedAtReset, 20); assert.equal(zero.beforeReset, false); assert.equal(ttadkExpiringUnused({ ...account, burn: zero }, now), true);
  console.log('PASS TTADK expiry strict boundaries, zero burn and missing/stale projection');

  const ttadk = { ...account, name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), healthy: true, live: true, seenAt: now, models: [SOL], windows: [] };
  const trae = { name: 'trae', kind: 'trae', home: path.join(tmp, 'trae'), healthy: true, live: true, models: [SOL, 'gpt-5.5'], windows: [],
    quota: { sampledAt: now, daily: { [SOL]: { used: 100, limit: 100, depleted: true, resetsAt: now + h } } } };
  fs.mkdirSync(trae.home);
  const cache = path.join(tmp, 'quota.json'), historyFile = path.join(tmp, 'history.jsonl');
  fs.writeFileSync(historyFile, history.map((s) => JSON.stringify(s) + '\n').join(''));
  const fixtureEnv = { ...process.env, HOME: tmp, CODEX_ACCOUNTS: path.join(tmp, 'none.json'), QUOTA_CACHE: cache, QUOTA_LOG_FILE: historyFile,
    ROUTE_LOG_FILE: path.join(tmp, 'no-routes.jsonl'), QUOTA_LOG: '0', ROUTE_LOG: '0', TRAE_PROBE: '0' };
  const writeCache = (tt = ttadk) => fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: null, codexAccounts: [tt, trae], errors: {}, history: {} }));
  const route = (args) => { const r = spawnSync(process.execPath, [path.join(root, 'route.mjs'), ...args, '--json'], { env: fixtureEnv, encoding: 'utf8', timeout: 5000 }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  writeCache();
  for (const args of [['analysis', '--background'], ['lookup'], ['review', '--background']]) {
    const r = route(args); assert.equal(r.pick.account, 'ttadk'); assert.ok(r.why.includes(TTADK_EXPIRY_HINT)); assert.ok(r.quota.includes(TTADK_EXPIRY_HINT));
  }
  assert.equal(route(['analysis', '--background', '--exclude-account', 'ttadk']).pick.account, 'trae');
  fs.writeFileSync(historyFile, '');
  const missing = route(['analysis', '--background']); assert.equal(missing.pick.account, 'trae'); assert.ok(!missing.why.includes(TTADK_EXPIRY_HINT));
  fs.writeFileSync(historyFile, history.map((s) => JSON.stringify(s) + '\n').join(''));
  writeCache({ ...ttadk, healthy: false }); assert.equal(route(['analysis', '--background']).pick.account, 'trae');
  writeCache();
  console.log('PASS real route expiry preference, lean hint, exclusions, unusable account and missing history');

  const rollover = now - 30 * min;
  const quotaRows = [{ t: rollover - min, ttadk: { name: 'ttadk', used: 25, limit: 100, resetsAt: rollover },
    trae: { name: 'trae', sampledAt: rollover - min, daily: { [SOL]: { used: 3, limit: 80, resetsAt: rollover } } } },
  { t: rollover + min, ttadk: { name: 'ttadk', used: 0, limit: 100, resetsAt: rollover + 24 * h },
    trae: { name: 'trae', sampledAt: rollover + min, daily: { [SOL]: { used: 0, limit: 80, resetsAt: rollover + 24 * h } } } }];
  const qr = quotaUtilisation([...quotaRows, quotaRows[1]], { since: now - h, now });
  assert.equal(qr.ttadk.tokensUnusedAtReset, 75); assert.equal(qr.trae.highPriorityUnitsUnusedAtResetByModel[SOL], 77); assert.equal(qr.ttadk.resets.length, 1);
  const staleQuota = structuredClone(quotaRows); staleQuota[0].t = rollover - h; staleQuota[0].trae.sampledAt = staleQuota[0].t;
  assert.equal(quotaUtilisation(staleQuota, { since: now - 2 * h, now }).ttadk.tokensUnusedAtReset, null);
  assert.equal(quotaUtilisation([], { since: now - h, now }).ttadk.tokensUnusedAtReset, null);
  const utilisationRows = Array.from({ length: 13 }, (_, i) => sample(now - h + i * 5 * min, { heavyLocks: locks(true), heavyGate: { authoritative: true, state: 'OVERLOADED' } }));
  for (const s of utilisationRows) s.heavyLocks.locks = s.heavyLocks.locks.map((l) => /lane-[13]$/.test(l.id) ? held(l.id) : l);
  const report = review(utilisationRows, { now, hours: 1, quotaRecords: quotaRows }), u = report.utilisation;
  assert.equal(u.cpu.hoursIdleAbove50WithReadyTasks, 1); assert.equal(u.cpu.hoursOverGate, 1);
  assert.equal(u.memory.meanAvailableGiB, 40); assert.equal(u.heavyLanes.occupancyPct, 66.6667);
  assert.equal(u.queue.hours, 1); assert.equal(u.topIdlenessCauses[0].cause, 'lock gate');
  assert.equal(u.quota.ttadk.tokensUnusedAtReset, 75); assert.match(formatReview(report), /TTADK=75 tokens/);
  const threeRoots = Array.from({ length: 3 }, (_, i) => ({ id: `root${i}`, pid: i + 100, kind: 'native', workload: { class: 'lane' }, owner: { project: `p${i}`, task: 'T1' } }));
  const overlapRows = [sample(now - 5 * min, { heavyLocks: locks(true), heavyRoots: threeRoots }), sample(now, { heavyLocks: locks(true), heavyRoots: threeRoots })];
  assert.ok(!review(overlapRows, { now }).badCases.some((c) => c.type === 'overlapping_heavy_workloads'));
  overlapRows[0].heavyRoots = [...threeRoots, { ...threeRoots[0], id: 'root4', pid: 400, owner: { project: 'p4', task: 'T1' } }];
  assert.ok(review(overlapRows, { now }).badCases.some((c) => c.type === 'overlapping_heavy_workloads'));
  const noData = review([sample(now, { attributionComplete: false })], { now }).utilisation;
  assert.equal(noData.cpu.hoursIdleAbove50WithReadyTasks, null); assert.equal(noData.heavyLanes.occupancyPct, null);
  for (const [cause, task] of [['no ready tasks', null], ['waiting on user', { ...ready, status: 'blocked', ready: false, waitReason: 'user' }],
    ['quota', { ...ready, status: 'blocked', ready: false, waitReason: 'quota' }], ['ready but undispatched', ready]]) {
    const data = [sample(now - 5 * min, { tasks: task ? [task] : [] }), sample(now, { tasks: task ? [task] : [] })];
    assert.equal(review(data, { now }).utilisation.topIdlenessCauses[0].cause, cause);
  }
  console.log('PASS utilisation CPU/memory/lanes/queue/causes and sampled per-model reset waste');

  const shared = path.join(tmp, '.claude/orchestrator/_shared'); fs.mkdirSync(shared, { recursive: true });
  const resourceLog = path.join(shared, 'resource-log.jsonl');
  fs.writeFileSync(`${resourceLog}.1`, utilisationRows.slice(0, 7).map((s) => JSON.stringify(s) + '\n').join(''));
  fs.writeFileSync(resourceLog, utilisationRows.slice(7).map((s) => JSON.stringify(s) + '\n').join(''));
  fs.writeFileSync(historyFile, quotaRows.map((s) => JSON.stringify(s) + '\n').join(''));
  fs.writeFileSync(path.join(shared, 'quota-log.jsonl'), quotaRows.map((s) => JSON.stringify(s) + '\n').join(''));
  // Both catalogs/CLI metadata are fixture binaries; even catalog inspection cannot reach a real account.
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fixture-cli\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o755 });
  const reviewEnv = { ...fixtureEnv, PATH: `${bin}:${process.env.PATH}`, RULES_LEDGER_ROOT: ledgerRoot };
  const entry = spawnSync(process.execPath, [path.join(root, 'review-data.mjs'), '--hours', '1', '--json'], { env: reviewEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(entry.status, 0, entry.stderr);
  const data = JSON.parse(entry.stdout);
  assert.ok(data.utilisation.cpu.hoursIdleAbove50WithReadyTasks > .99);
  assert.equal(data.utilisation.quota.ttadk.tokensUnusedAtReset, 75);
  assert.equal(data.utilisation.quota.trae.highPriorityUnitsUnusedAtResetByModel[SOL], 77);
  const textEntry = spawnSync(process.execPath, [path.join(root, 'review-data.mjs'), '--hours', '1'], { env: reviewEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(textEntry.status, 0, textEntry.stderr); assert.match(textEntry.stdout, /## utilisation\nUtilisation:/);
  const syntheticEntry = spawnSync(process.execPath, [path.join(root, 'resource-review.mjs'), '--hours', '1', '--input', resourceLog, '--json'], { env: reviewEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(syntheticEntry.status, 0, syntheticEntry.stderr);
  assert.equal(JSON.parse(syntheticEntry.stdout).utilisation.quota.ttadk.tokensUnusedAtReset, null);
  const defaultEntry = spawnSync(process.execPath, [path.join(root, 'resource-review.mjs'), '--hours', '1', '--json'], { env: reviewEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(defaultEntry.status, 0, defaultEntry.stderr); assert.equal(JSON.parse(defaultEntry.stdout).utilisation.quota.ttadk.tokensUnusedAtReset, 75);
  console.log('PASS real nightly review-data JSON/text, archives, quota join and synthetic-input isolation');

  const readings = { ps: '100 1 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 node fixture\n', cwd: 'p100\nn/tmp/test\n',
    CPU: 'CPU usage: 10% user, 20% sys, 70% idle', 'memory pages': 'page size of 16384 bytes\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n',
    'memory pressure': 'System-wide memory free percentage: 70%', swap: 'used = 0M', memorystatus: '50\n',
    'heavy-check': 'load1m=20.00 limit=20 lanes_held=1 headroom=40.00 GiB gate=OK', 'hub listeners': { stdout: '', exitCode: 1 },
    ccache: { stdout: '', exitCode: 'ENOENT' } };
  const options = { registry: { complete: true, errors: [], tasks: [], projects: [], mappings: [] }, leases, journal: { complete: true, events: [], errors: [] } };
  const starts = [];
  const slow = await collect({ ...options, probe: async (label, exe, args, { timeoutMs }) => {
    starts.push(label); assert.equal(timeoutMs, label === 'CPU' ? 4000 : 1750);
    if (label === 'CPU') await new Promise((resolve) => setTimeout(resolve, 2500));
    return readings[label];
  } });
  assert.equal(starts.length, 10); assert.equal(slow.complete, true); assert.ok(!slow.failedProbes.includes('ccache'));
  assert.equal(slow.ccache.complete, false); assert.equal(slow.heavyGate.load1m, 20); assert.ok(slow.durationMs >= 2500 && slow.durationMs < 4000);
  console.log('PASS independent 4s CPU budget survives a 2.5s probe at synthetic load 20; optional ccache UNKNOWN');

  for (const node of ['node', './node']) {
    const r = spawnSync(process.execPath, [path.join(root, 'render-hub-launchd.mjs'), '--out', path.join(tmp, 'invalid'), '--node', node], { encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /must be an absolute/);
  }
  const out = path.join(tmp, 'rendered');
  assert.equal(spawnSync(process.execPath, [path.join(root, 'render-hub-launchd.mjs'), '--out', out], { encoding: 'utf8' }).status, 0);
  assert.ok(fs.readFileSync(path.join(out, 'dev.project-orchestrator.hub.b.plist'), 'utf8').includes(process.execPath));
  console.log('PASS launchd renderer absolute runtime default and rejection of relative overrides');
  console.log('All utilisation scenarios passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
