#!/usr/bin/env node
// Synthetic lock/host/cache fixtures only. No live res status, lease mutation, credentials or hub restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIB, readLeases } from '../lib/resource-data.mjs';
import { HEAVY_IDS, heavyLoadLimit, laneAdmission, lockSnapshot, matchBuildLock, observeWaiters, parseHeavyCheck, parseHeavyStatus, readLockJournal, workload } from '../lib/resource-locks.mjs';
import { parseCcacheStats, parseHubListeners } from '../lib/resource-extras.mjs';
import { collect } from '../resource-sample.mjs';
import { formatReview, review } from '../resource-review.mjs';

const tmp = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.resource-lock-'));
const T = Date.parse('2026-11-13T00:00:00Z'), host = 'fixture-host'; let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const gateText = (state = 'OK', load = 2, avail = 20) => `load1m=${load.toFixed(2)} avail=${avail.toFixed(2)}GiB (memorystatus 50%) pages_headroom=18.00GiB swap_used=0.00GiB gate=${state}`;
const v12Text = (state, load, avail, lanes) => gateText(state, load, avail).replace(' avail=', ` limit=${heavyLoadLimit(lanes)} lanes_held=${lanes} avail=`);
const gate = (state = 'OK') => parseHeavyCheck(gateText(state, state === 'OK' ? 2 : 13), state === 'OK' ? 0 : 5);
const lease = (extra = {}) => ({ id: 'heavy-build', holder: 'wrapper', project: 'p', task: 'T1', pid: 100, host, startMs: T - 1000000, ...extra });
const leases = (held = [], complete = true) => ({ held, registered: HEAVY_IDS, complete, errors: [] });
const snapshot = (held, rows = [{ pid: 100, ppid: 1, started: new Date(T - 2000000).toISOString() }], extra = {}) => lockSnapshot(leases(held), rows, { host, psStartedAt: T, now: T, processComplete: true, ...extra });
const freeLocks = () => ({ complete: true, locks: HEAVY_IDS.map((id) => ({ id, state: 'FREE', stale: false })), journal: { complete: true, events: [] }, waiters: [], waitersComplete: true });
const waiter = (extra = {}) => ({ resource: 'heavy-build', id: 'res:200:start', pid: 200, holderPid: 100, holder: 'wrapper', project: 'p', task: 'T1', startMs: T - 120000, timeoutMinutes: 20, ...extra });
const build = (extra = {}) => ({ id: 'build:300:start', pid: 300, kind: 'xcodebuild', owner: { project: 'p', task: 'T1' }, workload: { class: 'package', reason: 'full package candidate' }, buildLock: { state: 'MATCHED' }, laneLock: { state: 'MATCHED' }, ...extra });
const sample = (i, extra = {}) => ({ schema: 1, t: T + i * 300000, at: new Date(T + i * 300000).toISOString(), host,
  cores: 14, complete: true, processComplete: true, cpu: { idle: 80 }, memory: { availableBytes: 20 * GIB, pressure: 'normal', swapUsedBytes: 0 }, load: [2, 2, 2],
  tasks: [], processes: [], heavyRoots: [], heavyGate: gate(), heavyLocks: freeLocks(), ...extra });
const runReview = (logs, extra = {}) => review(logs, { now: logs.at(-1).t, ...extra });
const journalEvent = (action, resource, t, extra = {}) => ({ eventId: `${resource}:${action}:${t}`, action, resource, t, precisionMs: 60000, holder: 'wrapper', project: action === 'take' ? 'p' : null, task: action === 'take' ? 'T1' : null, ...extra });
const withEvents = (i, events, extra = {}) => sample(i, { heavyLocks: { ...freeLocks(), journal: { complete: true, events }, ...extra } });
try {
  await test('captured res status parses holder/project/task/STALE without purpose', () => {
    const held = 'a very long wrapper session name exceeding column width';
    const r = parseHeavyStatus(`ID KIND POLICY LINK HOLDER SINCE\nheavy-build      slot open - STALE ${held} (p/T1) 2026-11-13 10:28 \u2192 ? \u00b7 PRIVATE_PURPOSE\nheavy-lane-1 slot open - wrapper (p) 2026-11-13 10:29 \u2192 ?\nheavy-lane-2 slot open - FREE description\n`);
    assert.equal(r.complete, true); assert.equal(r.locks[0].holder, held); assert.equal(r.locks[0].stale, true);
    assert.equal(r.locks[0].project, 'p'); assert.equal(r.locks[0].task, 'T1'); assert.equal(r.locks[1].task, null);
    assert.equal(r.locks[1].stale, null); assert.equal(r.locks[2].state, 'FREE'); assert.ok(!JSON.stringify(r).includes('PRIVATE'));
    assert.equal(parseHeavyStatus('heavy-build slot open - FREE description').complete, false);
    assert.equal(parseHeavyStatus('heavy-build slot open - malformed').complete, false);
  });
  await test('authoritative Darwin/Linux gate, fallbacks, exit5 and metric errors', () => {
    const r = parseHeavyCheck(gateText('OVERLOADED', 13.57, 13.15), 5);
    assert.equal(r.authoritative, true); assert.equal(r.availableBytes, 13.15 * GIB);
    assert.equal(r.limit, 12); assert.equal(r.lanes_held, null); assert.equal(r.controllerPolicy, 'legacy-fixed-12');
    assert.equal(parseHeavyCheck('load1m=11.00 headroom=20.00 GiB gate=OK').availableBasis, 'Linux MemAvailable');
    assert.equal(parseHeavyCheck(gateText().replace('memorystatus 50%', 'memorystatus unavailable; pages fallback')).authoritative, true);
    assert.equal(parseHeavyCheck(gateText('OK', 12, 16)).state, 'OK');
    assert.equal(parseHeavyCheck(gateText('OVERLOADED', 12, 16), 5).state, 'OVERLOADED'); // Rounded boundary retains controller verdict.
    for (const [text, code] of [[gateText(), 5], [gateText(), 1], ['PRIVATE denied', 1], ['garbage', 0], [gateText().replace('50%', '101%'), 0]]) assert.equal(parseHeavyCheck(text, code).state, 'UNKNOWN');
  });
  await test('read-only lease metadata includes holder/epoch/host but not purpose', () => {
    const root = path.join(tmp, 'shared'); fs.mkdirSync(path.join(root, 'locks/heavy-build.d'), { recursive: true });
    fs.writeFileSync(path.join(root, 'resources.tsv'), HEAVY_IDS.map((id) => `${id}\tslot\topen\t-\tdescription`).join('\n'));
    fs.writeFileSync(path.join(root, 'locks/heavy-build.d/info'), 'by\twrapper\nproject\tp\ntask\tT1\npid\t100\nhost\tfixture-host\nstart\t1794527000\nsince\t2026-11-13 10:28\nfor\tPRIVATE_PURPOSE\n');
    const r = readLeases(root); assert.equal(r.complete, true); assert.equal(r.held[0].holder, 'wrapper'); assert.equal(r.held[0].startMs, 1794527000000); assert.ok(!JSON.stringify(r).includes('PRIVATE'));
    assert.equal(readLeases(path.join(tmp, 'missing')).complete, false);
  });
  await test('STALE is local dead PID only; denied/remote/legacy/new/reused PID stays unknown', () => {
    assert.equal(snapshot([lease()], []).locks[0].stale, true); assert.equal(snapshot([lease()], []).locks[0].reclaimEligibleObserved, true);
    assert.equal(snapshot([lease({ startMs: T - 600000 })], []).locks[0].reclaimEligibleObserved, false);
    for (const l of [lease({ host: 'remote' }), lease({ host: null }), lease({ pid: null }), lease({ startMs: T + 1 }), lease({ startMs: null })]) assert.equal(snapshot([l], []).locks[0].stale, null);
    assert.equal(snapshot([lease()], [], { processComplete: false }).locks[0].stale, null);
    assert.equal(snapshot([lease()], [{ pid: 100, started: new Date(T).toISOString() }]).locks[0].pidIdentity, 'reused/unknown');
    const incomplete = lockSnapshot({ ...leases(), registered: [] }, [], { host, psStartedAt: T, now: T, processComplete: true });
    assert.equal(incomplete.locks[0].state, 'UNKNOWN');
  });
  await test('build and lane match wrapper ancestry, never merely equal project/session names', () => {
    const rows = [{ pid: 100, ppid: 1, started: new Date(T - 2000000).toISOString() }, { pid: 300, ppid: 100 }, { pid: 400, ppid: 1 }];
    const s = snapshot([lease(), lease({ id: 'heavy-lane-2' })], rows);
    assert.equal(matchBuildLock(rows[1], rows, s, 'build').state, 'MATCHED'); assert.equal(matchBuildLock(rows[1], rows, s, 'lane').resource, 'heavy-lane-2');
    assert.equal(matchBuildLock(rows[2], rows, s, 'build').state, 'UNMATCHED');
    assert.equal(matchBuildLock({ pid: 500, ppid: 900 }, rows, s, 'build').state, 'UNKNOWN');
    assert.equal(matchBuildLock(rows[1], rows, snapshot([lease({ host: 'remote' })], rows), 'build').state, 'UNKNOWN');
    assert.equal(matchBuildLock(rows[1], rows, snapshot([lease({ startMs: null })], rows), 'build').state, 'UNKNOWN');
  });
  await test('workload exemptions and scope-dependent heavy candidates', () => {
    const w = (cmd, elapsedSeconds = 0, children = []) => workload({ pid: 1, _command: cmd, elapsedSeconds }, children);
    assert.equal(w('xcodebuild -list').class, 'exempt'); assert.equal(w('xcodebuild test-without-building').class, 'exempt');
    assert.equal(w('xcodebuild archive').class, 'package'); assert.equal(w('xcodebuild -exportArchive').class, 'lane');
    assert.equal(w('gradlew :app:assembleDebug').class, 'package'); assert.equal(w('gradlew test').class, 'unclassified');
    assert.equal(w('clang -c foo.c').class, 'unclassified'); assert.equal(w('node --test foo.test.js', 600).class, 'unclassified');
    assert.equal(w('node --test foo.test.js', 600, [{ ppid: 1, _command: 'node --test a.test.js' }, { ppid: 1, _command: 'node --test b.test.js' }]).class, 'lane');
    assert.equal(w('cmake -S .').class, 'unclassified'); assert.equal(w('cmake --build .').class, 'lane');
  });
  await test('bounded journal reads preserve stable event IDs, omit notes and partial rows', () => {
    const root = path.join(tmp, 'journal'); fs.mkdirSync(root); const file = path.join(root, 'log.tsv');
    fs.writeFileSync(file, '2026-11-13 10:28\ttake\theavy-build\twrapper (p/T1)\tPRIVATE\n2026-11-13 10:30\treturn\theavy-build\twrapper\tPRIVATE\n');
    const a = readLockJournal(root); assert.equal(a.events.length, 2); assert.ok(!JSON.stringify(a).includes('PRIVATE'));
    fs.appendFileSync(file, '2026-11-13 10:31\ttake\theavy-lane-1\twrapper (p/T1)\t');
    const b = readLockJournal(root); assert.equal(b.events[0].eventId, a.events[0].eventId); assert.equal(b.trailingPartial, true); assert.equal(b.events.length, 2);
    const tail = readLockJournal(root, 120); assert.equal(tail.historyComplete, false); assert.equal(tail.events.length, 1);
    fs.unlinkSync(file); fs.symlinkSync(path.join(tmp, 'unread-auth-file'), file); assert.equal(readLockJournal(root).complete, false);
  });
  await test('wait parsing observes direct scripts, deduplicates forked copies and drops private args', () => {
    const cmd = '/bin/bash /safe/res wait heavy-build --by "wrapper session" --project p --task T1 --pid 100 --timeout 20 --for PRIVATE';
    const rows = [{ pid: 200, ppid: 100, _command: cmd, elapsedSeconds: 120 }, { pid: 201, ppid: 200, _command: cmd, elapsedSeconds: 10 }, { pid: 202, ppid: 1, _command: 'bash -c "res wait heavy-build"', elapsedSeconds: 10 }];
    const r = observeWaiters(rows, rows.map((p) => ({ ...p, id: String(p.pid) })), T);
    assert.equal(r.length, 1); assert.equal(r[0].holder, 'wrapper session'); assert.equal(r[0].startMs, T - 120000); assert.equal(r[0].timeoutMinutes, 20); assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  });
  await test('journal hold durations are minute bounds, deduped across samples', () => {
    const events = [journalEvent('take', 'heavy-build', T), journalEvent('return', 'heavy-build', T + 600000)];
    const r = runReview([withEvents(0, events), withEvents(2, events)]);
    assert.equal(r.heavyLocks.holdTimes.length, 1); const h = r.heavyLocks.holdTimes[0];
    assert.equal(h.durationMinutesLower, 9); assert.equal(h.durationMinutesUpper, 11); assert.equal(h.rightCensored, false); assert.equal(h.owner, 'p/T1');
  });
  await test('metadata refines hold start; open/snapshot-only holds are right censored', () => {
    const events = [journalEvent('take', 'heavy-build', T - 60000)];
    const lock = lease({ state: 'HELD', stale: false, startMs: T - 30000 });
    const logs = [withEvents(0, events, { locks: [lock] }), withEvents(1, events, { locks: [lock] }), withEvents(2, events, { locks: [lock] })];
    const h = runReview(logs).heavyLocks.holdTimes;
    assert.equal(h.length, 1); assert.equal(h[0].durationMinutesLower, 10.5); assert.equal(h[0].durationMinutesUpper, null); assert.equal(h[0].startPrecisionSeconds, 0);
    logs.forEach((s) => { s.heavyLocks.journal.events = []; }); assert.equal(runReview(logs).heavyLocks.holdTimes.length, 1);
  });
  await test('unobserved takes/reclaims preserve censoring and old holder identity', () => {
    const events = [journalEvent('take', 'heavy-build', T), journalEvent('reclaim', 'heavy-build', T + 600000, { holder: 'reclaimer', project: null, task: null }), journalEvent('return', 'heavy-lane-1', T + 600000)];
    const r = runReview([withEvents(0, events), withEvents(2, events)]);
    assert.equal(r.heavyLocks.holdTimes[0].holder, 'wrapper'); assert.equal(r.heavyLocks.holdTimes[0].reclaimer, 'reclaimer');
    const h = r.heavyLocks.holdTimes[1]; assert.equal(h.leftCensored, true); assert.equal(h.durationMinutesUpper, null);
  });
  await test('metadata before a release recovers a missing journal take without duplicate hold', () => {
    const events = [journalEvent('return', 'heavy-build', T + 600000)];
    const logs = [withEvents(0, [], { locks: [lease({ state: 'HELD', startMs: T - 30000 })] }), withEvents(2, events)];
    const holds = runReview(logs).heavyLocks.holdTimes;
    assert.equal(holds.length, 1); assert.equal(holds[0].leftCensored, false); assert.equal(holds[0].durationMinutesLower, 10.5); assert.equal(holds[0].durationMinutesUpper, 11.5);
  });
  await test('wait duration bounds, disappearance uncertainty and matching-wrapper acquisition', () => {
    const logs = [sample(0, { heavyLocks: { ...freeLocks(), waiters: [waiter()] } }), sample(1, { heavyLocks: { ...freeLocks(), waiters: [waiter()] } }), sample(2)];
    let w = runReview(logs).heavyLocks.waitTimes[0]; assert.ok(w.durationMinutesLower > 6.9); assert.ok(w.durationMinutesUpper > 12); assert.match(w.outcome, /unknown/);
    w = runReview(logs.slice(0, 2)).heavyLocks.waitTimes[0]; assert.equal(w.rightCensored, true); assert.equal(w.durationMinutesUpper, null);
    logs[2].heavyLocks.locks[0] = lease({ state: 'HELD', startMs: T + 400000 });
    w = runReview(logs).heavyLocks.waitTimes[0]; assert.equal(w.outcome, 'matching wrapper acquired'); assert.ok(w.durationMinutesUpper < 9);
    assert.equal(runReview([sample(0), sample(1)]).heavyLocks.waitTimes.length, 0); // No journaled waits is not zero wait time.
  });
  await test('gate periods use authoritative readings; legacy/error readings remain unknown', () => {
    const logs = [sample(0, { heavyGate: gate('OVERLOADED') }), sample(1, { heavyGate: gate('OVERLOADED') }), sample(2, { heavyGate: { state: 'UNKNOWN' } })];
    const r = runReview(logs); assert.equal(r.heavyGate.overloadedMinutes, 5); assert.equal(r.heavyGate.unknownMinutes, 5);
    assert.equal(r.heavyGate.overloadPeriods.length, 1);
    const old = runReview([sample(0, { heavyGate: null, load: [20, 20, 20] }), sample(1, { heavyGate: null })]);
    assert.equal(old.heavyGate.overloadedMinutes, null); assert.ok(old.badCases.some((c) => c.type === 'admission_gate_estimate')); assert.ok(!old.badCases.some((c) => c.type === 'admission_gate_closed'));
  });
  await test('mixed-format overload analysis uses per-sample limits and never merges different limits', () => {
    const legacy = parseHeavyCheck(gateText('OVERLOADED', 17, 20), 5);
    const open = parseHeavyCheck(v12Text('OK', 17, 20, 1));
    const closed = parseHeavyCheck(v12Text('OVERLOADED', 21, 20, 1), 5);
    const logs = [legacy, open, closed, closed].map((heavyGate, i) => sample(i, { heavyGate }));
    const r = runReview(logs);
    assert.equal(r.heavyGate.overloadedMinutes, 10); assert.equal(r.heavyGate.openMinutes, 5);
    assert.equal(r.heavyGate.overloadPeriods.length, 2);
    assert.match(r.heavyGate.overloadPeriods[0].evidence, /limit=12, lanes_held=UNKNOWN/);
    assert.match(r.heavyGate.overloadPeriods[1].evidence, /limit=20, lanes_held=1/);
    const consecutive = runReview([legacy, closed, closed, open].map((heavyGate, i) => sample(i, { heavyGate })));
    assert.deepEqual(consecutive.heavyGate.overloadPeriods.map((p) => p.minutes), [5, 10]);
    assert.match(formatReview(consecutive), /limit=min\(20, 12 \+ 8 \* lanes held by others\)/);
    const canonical = { ...closed }; delete canonical.loadGate; delete canonical.lanesHeld;
    const historical = { ...closed }; delete historical.limit; delete historical.lanes_held;
    const one = snapshot([lease({ id: 'heavy-lane-1' })]);
    for (const observed of [canonical, historical]) {
      const report = runReview([0, 1].map((i) => sample(i, { heavyGate: observed, heavyLocks: one, heavyRoots: [build()] })));
      assert.equal(report.heavyGate.overloadedMinutes, 5); assert.equal(report.tuning.comparableMinutes, 5);
      assert.equal(report.tuning.entryObservations[0].observedLoadGate, 20);
      assert.equal(report.tuning.entryObservations[0].observedOtherLanes, 1);
    }
  });
  await test('bypass needs persistent candidate and unmatched holder; missing/exempt evidence is not guilt', () => {
    const p = build({ buildLock: { state: 'UNMATCHED' } });
    const logs = [sample(0, { heavyRoots: [p] }), sample(1, { heavyRoots: [p] })];
    assert.ok(runReview(logs).badCases.some((c) => c.type === 'heavy_build_without_lock'));
    for (const state of ['UNKNOWN', 'MATCHED']) { p.buildLock.state = state; assert.ok(!runReview(logs).badCases.some((c) => c.type === 'heavy_build_without_lock')); }
    p.buildLock.state = 'UNMATCHED'; p.workload.class = 'exempt'; assert.ok(!runReview(logs).badCases.some((c) => c.type === 'heavy_build_without_lock'));
    p.workload.class = 'package'; logs[1].heavyLocks.complete = false; assert.ok(!runReview(logs).badCases.some((c) => c.type === 'heavy_build_without_lock'));
  });
  await test('STALE single observations and sustained periods survive report; unknown is not stale', () => {
    const lock = lease({ stale: true, state: 'STALE', ageSeconds: 1000 });
    const logs = [sample(0, { heavyLocks: { ...freeLocks(), locks: [lock] } }), sample(1, { heavyLocks: { ...freeLocks(), locks: [lock] } })];
    assert.equal(runReview(logs).heavyLocks.staleLocks.length, 2); assert.ok(runReview(logs).badCases.some((c) => c.type === 'stale_heavy_lock'));
    assert.equal(runReview(logs.slice(0, 1)).heavyLocks.staleLocks.length, 1);
    lock.stale = null; assert.equal(runReview(logs).heavyLocks.staleLocks.length, 0);
  });
  await test('strict/loose diagnostic correlation, missing ranges and thin coverage ask user', () => {
    const strict = [0, 1].map((i) => sample(i, { heavyGate: gate('OVERLOADED'), heavyLocks: { ...freeLocks(), waiters: [waiter()] } }));
    let r = runReview(strict); assert.equal(r.tuning.direction, 'possibly-too-strict'); assert.equal(r.tuning.nightlyAdjustmentEligible, false); assert.equal(r.tuning.askUser, true); assert.match(r.tuning.decisionCard, /12\/20\/16/);
    const loose = [0, 1].map((i) => sample(i, { heavyRoots: [build()], memory: { pressure: 'warning', swapUsedBytes: i * 2 * GIB } }));
    r = runReview(loose); assert.equal(r.tuning.direction, 'possibly-too-loose'); assert.equal(r.tuning.looseCandidateMinutes, 5);
    strict[1].heavyGate = gate(); assert.equal(runReview(strict).tuning.direction, 'insufficient-evidence');
  });
  await test('approved 12/20 entry gates exclude STALE/own holds and detect legacy controller output', () => {
    const one = snapshot([lease({ id: 'heavy-lane-1' })]);
    assert.equal(laneAdmission(freeLocks()).loadGate, 12);
    assert.equal(laneAdmission(one).loadGate, 20);
    assert.equal(laneAdmission(one, { pid: 100 }).loadGate, 12);
    const stale = snapshot([lease({ id: 'heavy-lane-1', pid: 999 })]);
    assert.equal(laneAdmission(stale).loadGate, 12);
    const two = snapshot([lease({ id: 'heavy-lane-1' }), lease({ id: 'heavy-lane-2', pid: 101 })], [{ pid: 100, ppid: 1, started: new Date(T - 2000000).toISOString() }, { pid: 101, ppid: 1, started: new Date(T - 2000000).toISOString() }]);
    assert.equal(laneAdmission(two).state, 'NO_CAPACITY');
    assert.equal(laneAdmission(two, { pid: 100 }).loadGate, 20);
    assert.equal(laneAdmission(snapshot([lease({ id: 'heavy-lane-1', host: 'remote' })])).state, 'UNKNOWN');
    const logs = [0, 1].map((i) => sample(i, { heavyLocks: one, heavyGate: parseHeavyCheck(gateText('OVERLOADED', 17, 20), 5) }));
    const r = runReview(logs);
    assert.equal(r.tuning.entryObservations[0].approvedReading, 'OK');
    assert.equal(r.tuning.controllerMismatchObservations.length, 2);
    assert.equal(r.tuning.observationPolicyMatchesController, false);
    assert.match(formatReview(r), /Gate rollout mismatch.*approved gate=20, observed gate=12/);
    for (const [load, mem, expected] of [[20, 16, 'OK'], [20.01, 16, 'OVERLOADED'], [17, 15.99, 'OVERLOADED']]) {
      const observed = parseHeavyCheck(gateText('OVERLOADED', load, mem), 5);
      const entry = runReview([sample(0, { heavyLocks: one, heavyGate: observed })]).tuning.entryObservations[0];
      assert.equal(entry.approvedReading, expected);
    }
    const ownWait = { ...one, waiters: [waiter({ resource: 'heavy-lane-2' })] };
    assert.equal(runReview([sample(0, { heavyLocks: ownWait })]).tuning.entryObservations[0].otherLanes, 0);
  });
  await test('live v1.2 output captures lane-aware limits and preserves rounded controller verdicts', () => {
    const v12 = (state, load, mem, lanes) => gateText(state, load, mem).replace(' avail=', ` limit=${lanes ? 20 : 12} lanes_held=${lanes} avail=`);
    const one = snapshot([lease({ id: 'heavy-lane-1' })]);
    for (const [load, mem, state] of [[20, 16, 'OK'], [20, 16, 'OVERLOADED'], [20.01, 16, 'OVERLOADED'], [17, 15.99, 'OVERLOADED']]) {
      const observed = parseHeavyCheck(v12(state, load, mem, 1), state === 'OK' ? 0 : 5);
      assert.equal(observed.authoritative, true); assert.equal(observed.loadGate, 20); assert.equal(observed.lanesHeld, 1);
      assert.equal(observed.limit, 20); assert.equal(observed.lanes_held, 1);
      assert.equal(observed.controllerPolicy, 'v1.2-lane-aware');
      const r = runReview([sample(0, { heavyLocks: one, heavyGate: observed })]);
      assert.equal(r.tuning.entryObservations[0].approvedReading, state);
      assert.equal(r.tuning.controllerMismatchObservations.length, 0);
      assert.equal(r.tuning.observationPolicyMatchesController, true);
      const own = runReview([sample(0, { heavyLocks: { ...one, waiters: [waiter()] }, heavyGate: observed })]);
      assert.equal(own.tuning.entryObservations[0].controllerContextMatches, false);
      assert.equal(own.tuning.entryObservations[0].controllerMatchesApprovedPolicy, null);
    }
    assert.equal(parseHeavyCheck(v12('OK', 12, 16, 0)).loadGate, 12);
    for (const lanes of [0, 1, 2, 3]) {
      assert.equal(heavyLoadLimit(lanes), Math.min(20, 12 + 8 * lanes));
      assert.equal(parseHeavyCheck(v12Text('OK', 12, 16, lanes)).limit, Math.min(20, 12 + 8 * lanes));
      assert.equal(parseHeavyCheck(v12Text('OK', 12, 16, lanes)).lanes_held, lanes);
    }
    for (const lanes of [-1, 0.5, null, NaN]) assert.equal(heavyLoadLimit(lanes), null);
    assert.equal(parseHeavyCheck(v12('OK', 2, 20, 1).replace('limit=20', 'limit=12')).state, 'UNKNOWN');
    assert.equal(parseHeavyCheck(v12('OK', 2, 20, 0).replace('lanes_held=0', 'lanes_held=-1')).state, 'UNKNOWN');
    const linux = parseHeavyCheck('load1m=17.00 limit=20 lanes_held=1 avail=20.00GiB headroom=20.00 GiB gate=OK');
    assert.equal(linux.availableBasis, 'Linux MemAvailable'); assert.equal(linux.loadGate, 20);
    assert.equal(linux.limit, 20); assert.equal(linux.lanes_held, 1);
    assert.equal(parseHeavyCheck('load1m=17.00 limit=20 lanes_held=1 avail=20.00GiB headroom=19.00 GiB gate=OK').state, 'UNKNOWN');
    const drift = [sample(0, { heavyGate: parseHeavyCheck(v12('OVERLOADED', 21, 20, 0), 5), heavyLocks: { ...freeLocks(), waiters: [waiter()] } }),
      sample(1, { heavyGate: parseHeavyCheck(v12('OVERLOADED', 21, 20, 1), 5), heavyLocks: { ...one, waiters: [waiter()] } })];
    assert.equal(runReview(drift).tuning.comparableMinutes, 0);
    const uncertain = snapshot([lease({ id: 'heavy-lane-1', host: 'remote' })]);
    const unknown = [0, 1].map((i) => sample(i, { heavyGate: parseHeavyCheck(v12('OVERLOADED', 21, 20, 1), 5), heavyLocks: { ...uncertain, waiters: [waiter()] } }));
    assert.equal(runReview(unknown).tuning.comparableMinutes, 0);
    const ownContext = [0, 1].map((i) => sample(i, { heavyGate: parseHeavyCheck(v12('OVERLOADED', 21, 20, 1), 5), heavyLocks: { ...one, waiters: [waiter()] } }));
    assert.equal(runReview(ownContext).tuning.comparableMinutes, 0);
  });
  await test('three covered comparable days permit only dated authorized in-range tuning', () => {
    const logs = Array.from({ length: 865 }, (_, i) => sample(i, { heavyGate: gate('OVERLOADED'), heavyLocks: { ...freeLocks(), waiters: [waiter()] } }));
    const policy = { hours: 72, approvedRanges: { loadGate: [11, 13], memoryGateGiB: [15, 17] }, approvalEvidence: 'User-approved 2026-11-13 fixture only' };
    let r = runReview(logs, policy); assert.equal(r.tuning.wellCoveredComparableDays, 3); assert.equal(r.tuning.nightlyAdjustmentEligible, true);
    r = runReview(logs, { ...policy, approvedRanges: { loadGate: [11, 12], memoryGateGiB: [16, 17] } }); assert.equal(r.tuning.nightlyAdjustmentEligible, false); assert.equal(r.tuning.askUser, true);
    assert.equal(runReview(logs, { ...policy, approvalEvidence: 'no date' }).tuning.automaticRangeAuthorized, false);
    assert.equal(runReview(logs, { ...policy, loadGate: 13 }).tuning.nightlyAdjustmentEligible, false);
  });
  await test('bypass/estimator drift/gaps disqualify automatic threshold adjustment', () => {
    const logs = [0, 1].map((i) => sample(i, { heavyGate: gate('OVERLOADED'), heavyLocks: { ...freeLocks(), waiters: [waiter()] }, heavyRoots: [build({ buildLock: { state: 'UNMATCHED' } })] }));
    assert.equal(runReview(logs).tuning.strictCandidateMinutes, 0);
    logs.forEach((s) => { s.heavyRoots = []; }); logs[1].heavyGate.availableBasis = 'pages-fallback'; assert.equal(runReview(logs).tuning.comparableMinutes, 0);
    logs[1].t += 900000; assert.equal(runReview(logs).coverage.heavyGateMinutes, 0);
  });
  await test('conflicting strict/loose signals retain thresholds without an invented proposal', () => {
    const strict = [0, 1].map((i) => sample(i, { heavyGate: gate('OVERLOADED'), heavyLocks: { ...freeLocks(), waiters: [waiter()] } }));
    const loose = [2, 3].map((i) => sample(i, { heavyRoots: [build()], memory: { pressure: 'warning', swapUsedBytes: (i - 2) * 2 * GIB } }));
    const r = runReview([...strict, ...loose]); assert.equal(r.tuning.direction, 'conflicting'); assert.equal(r.tuning.candidate, null); assert.equal(r.tuning.nightlyAdjustmentEligible, false);
  });
  await test('hub listeners parse IPv4/IPv6/duplicates; exit1 empty is absent but denied is unknown', () => {
    const r = parseHubListeners('p100\nf27\nn127.0.0.1:47321\np101\nf28\nn[::1]:47322\nf29\nn*:47323\nf30\nn*:47324\n');
    assert.equal(r.state, 'ALL_LISTENING'); assert.equal(r.ports[1].pids[0], 101);
    assert.equal(parseHubListeners('', { exitCode: 1 }).state, 'ALL_MISSING');
    assert.equal(parseHubListeners('p100\nn*:47321\n').state, 'PARTIAL');
    assert.equal(parseHubListeners('', { exitCode: 1, stderr: 'permission denied PRIVATE' }).state, 'UNKNOWN');
    assert.equal(parseHubListeners('PRIVATE').state, 'UNKNOWN');
  });
  await test('hub outages flag missing ports without extrapolating isolated/denied/gap observations', () => {
    const up = parseHubListeners('p100\nn*:47321\nn*:47322\nn*:47323\nn*:47324\n'), down = parseHubListeners('', { exitCode: 1 });
    const logs = [sample(0, { hubs: up }), sample(1, { hubs: down }), sample(2, { hubs: down }), sample(3, { hubs: up })];
    const r = runReview(logs); assert.equal(r.hubs.allMissingMinutes, 5); assert.equal(r.hubs.outageObservations.length, 2); assert.equal(r.hubs.transitions.length, 2); assert.ok(r.badCases.some((c) => c.type === 'hub_outage'));
    assert.equal(runReview([logs[1]]).hubs.allMissingMinutes, null);
    assert.equal(runReview([sample(0, { hubs: { complete: false } }), sample(1, { hubs: { complete: false } })]).hubs.allMissingMinutes, null);
    logs[2].t += 900000; assert.ok(!runReview(logs).badCases.some((c) => c.type === 'hub_outage'));
  });
  await test('ccache modern/legacy counters, 0-call unknown and malformed/unavailable stats', () => {
    const modern = 'Cacheable calls: 100 / 101 (99%)\n  Hits: 90 / 100 (90%)\n    Direct: 80 / 90\n    Preprocessed: 10 / 90\n  Misses: 10 / 100\nLocal storage:\n  Hits: 900\n';
    assert.equal(parseCcacheStats(modern).hitRatePct, 90);
    assert.equal(parseCcacheStats('cache hit (direct) 1,000\ncache hit (preprocessed) 100\ncache miss 100\n').hitRatePct, 91.67);
    assert.equal(parseCcacheStats('Hits: 0\nMisses: 0\n').hitRatePct, null);
    assert.equal(parseCcacheStats('PRIVATE').complete, false); assert.equal(parseCcacheStats('', { exitCode: 'ENOENT' }).available, false);
    assert.equal(parseCcacheStats(modern.replace('Hits: 90', 'Hits: 91')).complete, false);
    const empty = parseCcacheStats('Local storage:\n  Cache size (GiB): 0.0 / 5.0 ( 0.00%)\n');
    assert.equal(empty.available, true); assert.equal(empty.hitRatePct, null); assert.equal(empty.countersPresent, false);
  });
  await test('ccache window deltas exclude resets/gaps/scope drift and retain latest cumulative rate', () => {
    const cache = (hits, misses) => ({ complete: true, available: true, scope: 'fixture', hits, misses, hitRatePct: hits / (hits + misses) * 100 });
    const logs = [sample(0, { ccache: cache(100, 100) }), sample(1, { ccache: cache(190, 110) }), sample(2, { ccache: cache(0, 0) }), sample(3, { ccache: cache(50, 0) })];
    const r = runReview(logs); assert.equal(r.ccache.windowHitRatePct, 93.33); assert.equal(r.ccache.counterResetIntervals, 1); assert.equal(r.ccache.latest.hitRatePct, 100);
    assert.equal(runReview([sample(0), sample(1)]).ccache.windowHitRatePct, null);
    logs[1].ccache.scope = 'other'; assert.equal(runReview(logs.slice(0, 2)).ccache.observedMinutes, 0);
    delete logs[0].ccache.scope; delete logs[1].ccache.scope; assert.equal(runReview(logs.slice(0, 2)).ccache.observedMinutes, 0);
    logs[0].ccache.scope = 'fixture'; logs[1].ccache.scope = 'fixture';
    assert.equal(runReview(logs.slice(0, 2), { hours: 1 / 24 }).ccache.sampledHits, null);
  });
  await test('sampler preserves overloaded stdout, metadata and hubs without status or private args', async () => {
    const labels = [], registry = { complete: true, errors: [], tasks: [], mappings: [], projects: [] };
    const probe = async (label, exe, args) => {
      labels.push({ label, exe, args });
      if (label === 'heavy-check') throw Object.assign(Error('overloaded'), { code: 5, stdout: gateText('OVERLOADED', 13, 15) });
      return { ps: '300 1 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 xcodebuild archive --token=PRIVATE\n', cwd: 'p300\nn/tmp/test\n', CPU: 'CPU usage: 10% user, 20% sys, 70% idle',
        'memory pages': 'page size of 16384 bytes\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n', 'memory pressure': 'System-wide memory free percentage: 70%', swap: 'used = 0M', memorystatus: '50\n',
        'hub listeners': { exitCode: 1, stdout: '', stderr: '' }, ccache: 'Hits: 0\nMisses: 10\n' }[label];
    };
    const r = await collect({ registry, leases: leases(), journal: { complete: true, events: [], errors: [] }, probe });
    assert.equal(r.heavyGate.state, 'OVERLOADED'); assert.equal(r.heavyRoots[0].buildLock.state, 'UNMATCHED'); assert.equal(r.hubs.state, 'ALL_MISSING'); assert.equal(r.ccache.hitRatePct, 0); assert.equal(r.complete, true);
    assert.equal(r.heavyGate.limit, 12); assert.equal(r.heavyGate.lanes_held, null);
    for (const state of ['OK', 'OVERLOADED']) {
      const current = await collect({ registry, leases: leases(), journal: { complete: true, events: [], errors: [] }, probe: (label, exe, args) => {
        if (label !== 'heavy-check') return probe(label, exe, args);
        const stdout = v12Text(state, state === 'OK' ? 17 : 21, 20, 1);
        if (state === 'OVERLOADED') throw Object.assign(Error('overloaded'), { code: 5, stdout });
        return stdout;
      } });
      assert.equal(current.complete, true); assert.equal(current.heavyGate.state, state);
      const persisted = JSON.parse(JSON.stringify(current));
      assert.equal(persisted.heavyGate.limit, 20); assert.equal(persisted.heavyGate.lanes_held, 1);
    }
    assert.ok(!labels.some((p) => p.args.includes('status'))); assert.ok(!JSON.stringify(r).includes('PRIVATE')); assert.ok(!JSON.stringify(r).includes('_command'));
    assert.match(formatReview(runReview([sample(0, { hubs: r.hubs }), sample(1, { hubs: r.hubs })])), /hub_outage/);
    const nestedPs = '100 1 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 node --test host.test.js\n300 100 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 xcodebuild archive\n400 300 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 clang -c file.c\n';
    const nested = await collect({ registry, leases: leases(), journal: { complete: true, events: [], errors: [] }, probe: (label, exe, args) => label === 'ps' ? nestedPs : probe(label, exe, args) });
    assert.equal(nested.heavyRoots.filter((p) => p.workload.class === 'package').length, 1); assert.equal(nested.heavyRoots.find((p) => p.pid === 300).buildLock.state, 'UNMATCHED');
  });
  await test('parallel sampler probes complete independently; stalled CPU cannot starve metadata', async () => {
    const registry = { complete: true, errors: [], tasks: [], mappings: [], projects: [] };
    const readings = { ps: '300 1 501 01:00 0.0 1024 S 00:00 Fri Nov 13 01:00:00 2026 node fixture\n', cwd: 'p300\nn/tmp/test\n',
      CPU: 'CPU usage: 10% user, 20% sys, 70% idle', 'memory pages': 'page size of 16384 bytes\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n',
      'memory pressure': 'System-wide memory free percentage: 70%', swap: 'used = 0M', memorystatus: '50\n',
      'heavy-check': gateText(), 'hub listeners': { exitCode: 1, stdout: '', stderr: '' }, ccache: 'Hits: 0\nMisses: 10\n' };
    const options = { registry, leases: leases(), journal: { complete: true, events: [], errors: [] }, budgetMs: 250, cpuBudgetMs: 350 };
    let starts = [], firstCompletionStarts = 0;
    const complete = await collect({ ...options, probe: async (label, exe, args, { timeoutMs, signal }) => {
      assert.equal(timeoutMs, label === 'CPU' ? 350 : 250); assert.equal(signal.aborted, false); starts.push(label);
      await new Promise((r) => setTimeout(r, label === 'CPU' ? 200 : 150));
      firstCompletionStarts ||= starts.length;
      return readings[label];
    } });
    assert.equal(firstCompletionStarts, 10); assert.equal(complete.complete, true); assert.deepEqual(complete.failedProbes, []);
    assert.ok(complete.durationMs < 600, `parallel completion: ${complete.durationMs}ms`);
    let cpuSignal; starts = [];
    const stalled = await collect({ ...options, probe: async (label, exe, args, { signal }) => {
      starts.push(label);
      if (label === 'CPU') { cpuSignal = signal; return new Promise(() => {}); }
      await new Promise((r) => setTimeout(r, 150)); return readings[label];
    } });
    assert.equal(starts.length, 10); assert.equal(cpuSignal.aborted, true);
    assert.deepEqual(stalled.failedProbes, ['CPU']); assert.equal(stalled.processComplete, true); assert.equal(stalled.cwdComplete, true);
    assert.equal(stalled.heavyGate.authoritative, true); assert.equal(stalled.hubs.complete, true); assert.equal(stalled.ccache.complete, true);
    assert.ok(stalled.durationMs < 700, `isolated CPU timeout: ${stalled.durationMs}ms`);
  });
  console.log(`resource lock/hub/cache scenarios: ${checks} groups all pass`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
