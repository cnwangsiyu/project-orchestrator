#!/usr/bin/env node
// Machine gates, device snapshots and journal episode regressions in scratch state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseHeavyCheck, RES_CONTRACT_VERSION } from '../../lib/resource-locks.mjs';
import { assessThresholds, inspectLockInterval, reviewLockTiming } from '../../lib/resource-lock-review.mjs';
import { formatReview, review } from '../../resource-review.mjs';

const root = path.join(process.env.RES_TEST_ROOT, 'followups');
const state = path.join(root, 'state'), mocks = path.join(root, 'mocks');
fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
fs.mkdirSync(mocks, { recursive: true });
fs.writeFileSync(path.join(state, 'resources.tsv'),
  ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3'].map((id) => `${id}\tslot\topen\t-\tfixture`).join('\n') + '\nphone\tdevice\topen\tfixture-phone\tfixture\n');
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\necho "${TEST_PLATFORM:-Darwin}"\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'awk'), `#!/bin/sh
case "$*" in
  *' /proc/loadavg') echo "$RES_TEST_LOAD1M";;
  *' /proc/meminfo') echo "$RES_TEST_LINUX_AVAILABLE";;
  *) exec /usr/bin/awk "$@";;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'adb'), `#!/bin/sh
if [ "\${CLIENT_PROBE_HANG:-0}" = 1 ]; then
  if [ -d "$RES_DIR/locks/phone.d" ]; then echo held; else echo clear; fi >"$RES_DIR/adb-lease-before"
  /usr/bin/awk -F '\\t' '$2=="take" && $3=="phone" && index($4,"hung-snapshot ")==1 {n++} END {print n+0}' "$RES_DIR/log.tsv" >"$RES_DIR/adb-take-before"
  echo "$$" >"$RES_DIR/adb-probe-pid"; touch "$RES_DIR/adb-probe-entered"; exec /bin/sleep 60
fi
[ "\${CLIENT_PROBE_FAIL:-0}" = 0 ] || exit 9
printf 'List of devices attached\\nfixture-secret-serial device product:private-data\\nfixture-other offline\\n\\n'
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'ps'), `#!/bin/sh
case "$*" in
  '-axo pid=,comm=')
    if [ "\${CLIENT_PROBE_HANG:-0}" = 1 ]; then
      if [ -d "$RES_DIR/locks/phone.d" ]; then echo held; else echo clear; fi >"$RES_DIR/ps-lease-before"
      /usr/bin/awk -F '\\t' '$2=="take" && $3=="phone" && index($4,"hung-snapshot ")==1 {n++} END {print n+0}' "$RES_DIR/log.tsv" >"$RES_DIR/ps-take-before"
      echo "$$" >"$RES_DIR/ps-probe-pid"; touch "$RES_DIR/ps-probe-entered"; exec /bin/sleep 60
    fi
    [ "\${CLIENT_PROBE_FAIL:-0}" = 0 ] || exit 9
    printf '111 /opt/android/adb\\n222 /usr/bin/devicectl\\n333 /bin/other-secret-name\\n';;
  '-p '*)
    if [ "\${CLIENT_PROBE_HANG:-0}" = 1 ]; then
      if [ -d "$RES_DIR/locks/phone.d" ]; then echo held; else echo clear; fi >"$RES_DIR/pid-lease-before"
      /usr/bin/awk -F '\\t' '$2=="take" && $3=="phone" && index($4,"hung-snapshot ")==1 {n++} END {print n+0}' "$RES_DIR/log.tsv" >"$RES_DIR/pid-take-before"
      echo "$$" >"$RES_DIR/pid-probe-pid"; touch "$RES_DIR/pid-probe-entered"; exec /bin/sleep 60
    fi
    kill -0 "$2" 2>/dev/null || exit 1; echo "$2";;
  '-axo pid=') echo "$PPID";;
  *) exit 2;;
esac
`, { mode: 0o755 });
const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`,
  RES_TEST_METRICS: '1', RES_TEST_LOAD1M: '8', RES_TEST_MEMORYSTATUS_LEVEL: '50',
  RES_TEST_MEMSIZE: '68719476736', RES_TEST_SWAPUSAGE: 'used = 0M',
  RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.' };
let count = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); count++; };
const ok = (a, msg) => { assert.ok(a, msg); count++; };
const run = (args, extra = {}) => {
  const r = spawnSync(process.env.RES_SOURCE, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
};
const config = (text) => {
  const staged = path.join(state, 'machine.conf.next');
  fs.writeFileSync(staged, text); fs.renameSync(staged, path.join(state, 'machine.conf'));
};
const take = (id, extra = {}) => run(['take', id, '--by', 'fixture', '--project', 'fixture', '--for', 'fixture', '--offline'], extra);
const release = (id) => eq(run(['return', id, '--by', 'fixture']).code, 0);
const check = (extra = {}) => run(['heavy-check', '--pid', String(process.pid)], extra);

// Review #2: MIN_AVAIL_GIB=3 is an unfinished prefix of 32. Reject it;
// staged edits leave the previous complete configuration active until rename.
const conf = path.join(state, 'machine.conf'), nextConf = `${conf}.next`;
const twentyGiB = { RES_TEST_MEMSIZE: '42949672960' };
config('MIN_AVAIL_GIB=3');
let incomplete = check(twentyGiB); eq(incomplete.code, 1); ok(incomplete.text.includes('incomplete machine.conf'));
ok(incomplete.text.includes('defaults retained')); eq(take('heavy-lane-3', twentyGiB).code, 1);
fs.writeFileSync(nextConf, 'MIN_AVAIL_GIB=32\n'); fs.renameSync(nextConf, conf);
eq(check(twentyGiB).code, 5);
fs.writeFileSync(nextConf, 'MIN_AVAIL_GIB=3');
const duringEdit = check(twentyGiB); eq(duringEdit.code, 5); ok(duringEdit.text.includes('MIN_AVAIL_GIB=32'));
fs.writeFileSync(nextConf, 'MIN_AVAIL_GIB=32\n'); fs.renameSync(nextConf, conf); eq(check(twentyGiB).code, 5);
config(''); eq(check(twentyGiB).code, 1); fs.rmSync(conf);

// Review #4: existing invalid entries must fail promptly for both checks and
// heavy takes. Only a missing entry selects defaults; a regular target is valid.
const heavyArgs = (id) => ['take', id, '--by', 'fixture', '--project', 'fixture', '--for', 'fixture'];
for (const kind of ['fifo', 'directory', 'dangling', 'nonregular-target']) {
  if (kind === 'fifo') {
    const made = spawnSync('/usr/bin/mkfifo', [conf]); eq(made.status, 0);
  } else if (kind === 'directory') fs.mkdirSync(conf);
  else fs.symlinkSync(kind === 'dangling' ? path.join(root, 'missing-conf') : '/dev/null', conf);
  try {
    for (const argv of [['heavy-check'], heavyArgs('heavy-lane-3'), heavyArgs('heavy-lane-1'), heavyArgs('heavy-build')]) {
      const r = spawnSync(process.env.RES_SOURCE, argv, { env, encoding: 'utf8', timeout: 10000 });
      if (r.error) throw r.error;
      eq(r.status, 1, `${kind}: ${r.stdout}${r.stderr}`); ok(r.stderr.includes('machine.conf'));
    }
    eq(fs.readdirSync(path.join(state, 'locks')), []);
  } finally { fs.rmSync(conf, { recursive: kind === 'directory' }); }
}
fs.writeFileSync(nextConf, 'MIN_AVAIL_GIB=16\n'); fs.symlinkSync(nextConf, conf);
eq(check().code, 0); fs.rmSync(conf); fs.rmSync(nextConf);

eq(fs.existsSync(path.join(state, 'machine.conf')), false);
let gate = check(); eq(gate.code, 0); eq(parseHeavyCheck(gate.text).thresholds,
  { LOAD_LIMIT: 12, LOAD_LIMIT_WITH_LANES: 20, MIN_AVAIL_GIB: 16, LANE3_LOAD: 8, LANE3_AVAIL_GIB: 32, source: 'defaults' });
eq(fs.existsSync(path.join(state, 'machine.conf')), false);
config('# smaller machine\n LOAD_LIMIT = 6.5\nLOAD_LIMIT_WITH_LANES=10.5\nMIN_AVAIL_GIB=8\nLANE3_LOAD=4.5\nLANE3_AVAIL_GIB=16\n');
gate = check(); eq(gate.code, 5); eq(parseHeavyCheck(gate.text, gate.code).loadGate, 6.5);
const configuredGate = parseHeavyCheck(gate.text, gate.code);
eq(parseHeavyCheck(gate.text, gate.code).memoryGateGiB, 8);
eq(parseHeavyCheck(gate.text, gate.code).thresholds.source, 'machine.conf');
eq(check({ RES_TEST_LOAD1M: '6.5', RES_TEST_MEMORYSTATUS_LEVEL: '12.5' }).code, 1); // metrics percentages stay integers
eq(check({ RES_TEST_LOAD1M: '6.5', RES_TEST_MEMSIZE: '17179869184' }).code, 0);
eq(check({ RES_TEST_LOAD1M: '6.5001' }).code, 5);
eq(check({ RES_TEST_LOAD1M: '6.5', RES_TEST_MEMSIZE: '17179869183' }).code, 5);
eq(take('heavy-lane-3', { RES_TEST_LOAD1M: '4.5', RES_TEST_MEMSIZE: '34359738368' }).code, 0); release('heavy-lane-3');
eq(take('heavy-lane-3', { RES_TEST_LOAD1M: '4.50001' }).code, 5);
eq(take('heavy-lane-3', { RES_TEST_LOAD1M: '4.5', RES_TEST_MEMSIZE: '34359738367' }).code, 5);
eq(take('heavy-lane-1').code, 0);
gate = run(['heavy-check', '--pid', String(process.ppid)], { RES_TEST_LOAD1M: '10.5' }); eq(gate.code, 0); eq(parseHeavyCheck(gate.text).loadGate, 10.5);
release('heavy-lane-1');
gate = check({ TEST_PLATFORM: 'Linux', RES_TEST_LOAD1M: '6.5', RES_TEST_LINUX_AVAILABLE: '8589934592' });
eq(gate.code, 0); eq(parseHeavyCheck(gate.text).availableBasis, 'Linux MemAvailable'); eq(parseHeavyCheck(gate.text).memoryGateGiB, 8);
eq(check({ TEST_PLATFORM: 'Linux', RES_TEST_LOAD1M: '6.5001', RES_TEST_LINUX_AVAILABLE: '8589934592' }).code, 5);
eq(take('heavy-lane-3', { TEST_PLATFORM: 'Linux', RES_TEST_LOAD1M: '4.5', RES_TEST_LINUX_AVAILABLE: '17179869184' }).code, 0); release('heavy-lane-3');
eq(take('heavy-lane-3', { TEST_PLATFORM: 'Linux', RES_TEST_LOAD1M: '4.5', RES_TEST_LINUX_AVAILABLE: '17179869183' }).code, 5);
for (const text of ['LOAD_LIMIT=0\n', 'LOAD_LIMIT=-1\n', 'LOAD_LIMIT=1025\n', 'MIN_AVAIL_GIB=65537\n',
  'LOAD_LIMIT=oops\n', 'LOAD_LIMIT=10\nLOAD_LIMIT=11\n', 'UNKNOWN=12\n', 'LOAD_LIMIT=21\n',
  'LANE3_LOAD=13\n', 'LANE3_AVAIL_GIB=15\n', 'LOAD_LIMIT=$(touch nope)\n', 'LOAD_LIMIT=12=13\n']) {
  config(text); eq(check().code, 1); eq(take('heavy-lane-3').code, 1);
  eq(fs.existsSync(path.join(state, 'locks/heavy-lane-3.d')), false);
}
config('MIN_AVAIL_GIB=8\n'); gate = check(); eq(gate.code, 0); eq(parseHeavyCheck(gate.text).loadGate, 12);
eq(parseHeavyCheck(gate.text).memoryGateGiB, 8);
config('LOAD_LIMIT=6.500001\nLANE3_LOAD=4\n'); gate = check({ RES_TEST_LOAD1M: '6.500001' });
eq(gate.code, 0); eq(parseHeavyCheck(gate.text).loadGate, 6.500001);
fs.rmSync(path.join(state, 'machine.conf')); eq(check().code, 0);

// A snapshot failure cannot fail or alter device admission. Idempotence retains evidence.
for (const fail of ['0', '1']) {
  const result = take('phone', { CLIENT_PROBE_FAIL: fail }); eq(result.code, 0, result.text);
  const info = fs.readFileSync(path.join(state, 'locks/phone.d/info'), 'utf8');
  ok(info.includes(`adb_device_lines\t${fail === '0' ? '4' : 'unknown'}\n`));
  ok(info.includes(`device_clients\t${fail === '0' ? '111:adb,222:devicectl' : 'unknown'}\n`));
  eq(take('phone', { CLIENT_PROBE_FAIL: fail === '0' ? '1' : '0' }).code, 0);
  eq(fs.readFileSync(path.join(state, 'locks/phone.d/info'), 'utf8'), info);
  const journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
  ok(journal.includes(`adb_device_lines=${fail === '0' ? '4' : 'unknown'}`));
  ok(!/secret-serial|private-data|other-secret-name/.test(info + journal + result.text));
  release('phone');
}

// Review #3: block both snapshot probes and the explicit-PID check. No probe
// checkpoint may have a lease; timeouts then permit complete info/log publication.
const snapshot = spawn(process.env.RES_SOURCE, ['take', 'phone', '--by', 'hung-snapshot', '--project', 'fixture', '--for', 'fixture', '--offline', '--pid', String(process.pid)],
  { env: { ...env, CLIENT_PROBE_HANG: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let snapshotText = '';
snapshot.stdout.on('data', (b) => { snapshotText += b; }); snapshot.stderr.on('data', (b) => { snapshotText += b; });
const snapshotDone = new Promise((resolve, reject) => { snapshot.on('error', reject); snapshot.on('close', (code) => resolve(code)); });
let snapshotTimer;
try {
  for (const probe of ['adb', 'ps', 'pid']) {
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(path.join(state, `${probe}-probe-entered`))) {
      if (snapshot.exitCode !== null || Date.now() > deadline) throw Error(`missing ${probe} checkpoint: ${snapshotText}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    eq(fs.readFileSync(path.join(state, `${probe}-lease-before`), 'utf8').trim(), 'clear');
    eq(fs.readFileSync(path.join(state, `${probe}-take-before`), 'utf8').trim(), '0');
  }
  const code = await Promise.race([snapshotDone, new Promise((_, reject) => {
    snapshotTimer = setTimeout(() => reject(Error(`snapshot did not finish: ${snapshotText}`)), 30000);
  })]);
  eq(code, 0, snapshotText);
  const info = fs.readFileSync(path.join(state, 'locks/phone.d/info'), 'utf8');
  ok(info.includes('adb_device_lines\tunknown\n')); ok(info.includes('device_clients\tunknown\n'));
  ok(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('adb_device_lines=unknown device_clients=unknown'));
  for (const probe of ['adb', 'ps', 'pid']) {
    const pid = Number(fs.readFileSync(path.join(state, `${probe}-probe-pid`), 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    eq(alive, false, `${probe} probe was not reaped`);
  }
} finally {
  clearTimeout(snapshotTimer);
  if (snapshot.exitCode === null && snapshot.signalCode === null) { try { process.kill(-snapshot.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  await snapshotDone;
  eq(run(['return', 'phone', '--by', 'hung-snapshot']).code, 0);
}

const t = Date.parse('2026-11-15T12:00:00Z');
const event = (id, action, when) => ({ eventId: id, action, t: t + when, resource: 'heavy-lane-1', holder: 'same', project: 'fixture', task: 'same' });
const held = (when, start, pid = 34199) => ({ t: t + when, heavyLocks: { locks: [{ id: 'heavy-lane-1', state: 'HELD', holder: 'same', project: 'fixture', task: 'same', pid, startMs: t + start }] } });
const timing = (samples) => reviewLockTiming(samples, { since: t, now: t + 600000, maxGapMs: 600000 });
// A return from an older episode's minute window cannot absorb a later same-name/PID hold.
let result = timing([{ t, heavyLocks: { journal: { events: [event('old-take', 'take', 0), event('old-return', 'return', 60000)] } } }, held(180000, 30000)]);
eq(result.holdTimes.length, 2); eq(result.holdTimes.find((h) => h.pid === 34199).endAt, null);
// A missing intervening take must not let a later reused-name return close the older episode.
result = timing([{ t, heavyLocks: { journal: { events: [event('older-take', 'take', 0), event('later-return', 'return', 180000)] } } }, held(150000, 120000)]);
eq(result.holdTimes.length, 2); eq(result.holdTimes[0].validity, 'INVALID'); eq(result.holdTimes[0].endAt, null);
eq(result.holdTimes[0].durationMinutesUpper, null); eq(result.holdTimes[1].endAt, null);
const invalidResult = result;
// The older take's minute upper bound is exclusive: equality is a newer episode.
result = timing([{ t, heavyLocks: { journal: { events: [event('boundary-take', 'take', 0), event('boundary-return', 'return', 120000)] } } }, held(90000, 60000)]);
eq(result.holdTimes[0].validity, 'INVALID'); eq(result.holdTimes[0].endAt, null);
eq(result.holdTimes[0].durationMinutesUpper, null); eq(result.holdTimes[1].endAt, null);
// PID changes within a coarse minute are distinct episodes even when names match.
result = timing([held(10000, 5000, 34199), held(20000, 15000, 34200)]);
eq(result.holdTimes.length, 2);
// Review #5: take at second 10, HELD at 15, return in the same minute. The
// return's lower bound is zero, but its upper bound permits this valid episode.
result = timing([{ t, heavyLocks: { journal: { events: [event('take', 'take', 0), event('return', 'return', 0)] } } }, held(15000, 10000)]);
eq(result.holdTimes.length, 1); eq(result.holdTimes[0].validity, 'VALID');
eq(result.holdTimes[0].durationMinutesLower, 0.08); eq(result.holdTimes[0].durationMinutesUpper, 0.83);
eq(result.holdTimes[0].endAt, new Date(t).toISOString());
// Repeat the reviewer's valid sequence at seconds 30/35/40 in the same
// minute. A newer take inside a release window does not prove impossibility.
result = timing([{ t, heavyLocks: { journal: { events: [event('first-take', 'take', 0), event('first-return', 'return', 0),
  event('second-take', 'take', 0), event('second-return', 'return', 0)] } } }, held(15000, 10000, 34199), held(35000, 30000, 34200)]);
eq(result.holdTimes.map((h) => h.validity), ['VALID', 'VALID']);
eq(result.holdTimes[0].durationMinutesUpper, 0.83); eq(result.holdTimes[1].durationMinutesUpper, 0.5);
const formatted = formatReview({ ...review([], { now: t, hours: 1 }), heavyLocks: invalidResult });
ok(formatted.includes('INVALID')); ok(!formatted.includes('v1.2 live')); ok(formatted.includes(`Source contract v${RES_CONTRACT_VERSION}`));
eq(RES_CONTRACT_VERSION, '1.9');
const configuredSample = { t, heavyGate: configuredGate, heavyLocks: { complete: true, locks: ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3'].map((id) => ({ id, state: 'FREE' })) } };
const assessed = assessThresholds([configuredSample], { strictMinutes: 0, looseMinutes: 0, bypassMinutes: 0, comparableIntervals: [] },
  { since: t, loadGate: 12, loadGateWithOneHeavyTask: 20, memoryGateGiB: 16 });
eq(assessed.controllerMismatchObservations, []); eq(assessed.entryObservations[0].loadGate, 6.5); eq(assessed.observationPolicyMatchesController, false);
const diagnostics = [];
const interval = inspectLockInterval(configuredSample, { ...configuredSample, t: t + 60000 }, { span: 60000, record: (...values) => diagnostics.push(values) });
eq(interval.gateMinutes, 1); eq(interval.comparableMinutes, 0); ok(diagnostics[0][4].includes('memory=8 GiB'));
// Coarse valid journal episodes and an exact metadata episode retain useful bounds.
result = timing([{ t, heavyLocks: { journal: { events: [event('ok-take', 'take', 0), event('ok-return', 'return', 120000)] } } }, held(30000, 5000)]);
eq(result.holdTimes.length, 1); eq(result.holdTimes[0].validity, 'VALID'); eq(result.holdTimes[0].durationMinutesLower, 1.92);
console.log(`ALL ${count} ASSERTIONS PASSED`);
