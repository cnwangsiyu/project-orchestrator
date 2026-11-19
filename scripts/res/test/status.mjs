#!/usr/bin/env node
// Every command and mutation is confined to runner-created scratch state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = path.join(process.env.RES_TEST_ROOT, 'status');
const state = path.join(root, 'state'), mocks = path.join(root, 'mocks');
fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
fs.mkdirSync(mocks, { recursive: true });
const registry = path.join(state, 'resources.tsv');
fs.writeFileSync(registry, 's21\tdevice\topen\tfixture-android\tfixture phone\n' +
  'iphone8\tdevice\topen\tfixture-ios\tfixture phone\n' +
  'checkout\tcheckout\topen\t-\tfixture checkout\n' +
  'churn\tcheckout\topen\t-\tfixture churn\n' +
  'devbox-cn-1\tremote\topen\t-\tfixture runner@192.0.2.1 caps=node\n');
for (const name of ['adb', 'idevice_id', 'xcrun', 'pymobiledevice3']) {
  fs.writeFileSync(path.join(mocks, name), `#!/bin/bash
printf '%s\\n' '${name}' >>"$PROBE_CALLS"
if [ "\${PROBE_DELAY:-0}" != 0 ]; then /bin/sleep "$PROBE_DELAY"; fi
case '${name}' in
  adb) printf 'List of devices attached\\nfixture-android\\t%s\\n' "\${ADB_STATE:-device}" ;;
  idevice_id) [ "\${IOS_NOT_SEEN:-0}" = 1 ] || printf 'fixture-ios\\n' ;;
  xcrun) printf 'Fixture fixture-ios (UDID) available  physical\\n' ;;
esac
exit "\${PROBE_EXIT:-0}"
`, { mode: 0o755 });
}
// Old device status discovers all files, then runs ps, then opens them in awk.
// Return a discovered unrelated lease at exactly that boundary.
fs.writeFileSync(path.join(mocks, 'ps'), `#!/bin/bash
if [ "$*" = '-axo pid=' ] && [ -n "\${RACE_MARK:-}" ] && [ ! -f "$RACE_MARK" ]; then
  touch "$RACE_MARK"
  "$RES_SOURCE" return churn --by churn >/dev/null
fi
exec "$FIXTURE_PS" "$@"
`, { mode: 0o755 });
const calls = path.join(root, 'probe-calls');
const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`,
  PROBE_CALLS: calls, FIXTURE_PS: path.join(process.env.RES_TEST_ROOT, 'bin/ps') };
let count = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); count++; };
const ok = (value, message) => { assert.ok(value, message); count++; };
const run = (args, extra = {}) => {
  const start = performance.now();
  const r = spawnSync(process.env.RES_SOURCE, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr, ms: performance.now() - start };
};
const args = by => ['--by', by, '--project', 'fixture', '--for', 'fixture', '--pid', String(process.pid), '--offline'];
const take = (id, by = id) => { const r = run(['take', id, ...args(by)]); eq(r.code, 0, r.err); };
const release = (id, by = id) => { const r = run(['return', id, '--by', by]); eq(r.code, 0, r.err); };
const info = id => path.join(state, 'locks', `${id}.d`, 'info');
const clearProbes = () => fs.writeFileSync(calls, '');
const probes = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [];
const clearCache = () => fs.rmSync(path.join(state, 'status-cache'), { recursive: true, force: true });
function connected(id, extra = {}) {
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    clearCache(); clearProbes(); result = run(['status', id], extra);
    eq(result.code, 0, result.err);
    if (result.out.includes('connected')) return result;
    ok(result.out.includes('unknown') || result.out.includes('connected'), result.out);
  }
  assert.fail(`host never scheduled a fixture probe within its budget: ${result.out}`);
}
function profile(label, argv, extra = {}) {
  const samples = Array.from({ length: 3 }, () => run(argv, extra));
  console.log(`TIMING ${label}: ${samples.map(r => `${r.ms.toFixed(1)}ms/exit${r.code}`).join(', ')}`);
  return samples;
}
// Wall-clock targets are opt-in: this shared host can deschedule even `python3 -c pass`.
// Hung fixture commands still exceed run()'s hard watchdog if probe bounding regresses.
function target(label, samples, milliseconds) {
  const best = Math.min(...samples.map(r => r.ms));
  console.log(`TARGET ${label}: best=${best.toFixed(1)}ms target<${milliseconds}ms ${best < milliseconds ? 'met' : 'host-stalled'}`);
  if (process.env.RES_STATUS_STRICT_TIMING === '1') ok(best < milliseconds, `${label} wall-clock target`);
}

take('s21', 'guard'); take('checkout'); take('churn');
clearProbes();
profile('device/all-transports-delayed', ['status', 's21'], { PROBE_DELAY: '2' });
profile('checkout', ['status', 'checkout']);
profile('remote', ['status', 'devbox-cn-1']);
const race = run(['status', 's21'], { RACE_MARK: path.join(root, 'race') });
console.log(`RACE discovered unrelated lease returned: exit=${race.code}; ${race.err.trim()}`);
if (process.env.RES_STATUS_BASELINE === '1') {
  eq(race.code, 2, 'baseline must reproduce the awk open race');
  console.log(`ALL ${count} ASSERTIONS PASSED`);
  process.exit(0);
}
eq(race.code, 0, race.err);
ok(race.out.includes('guard (fixture)'), race.out);
eq(run(['status', 'unknown']).code, 1);
eq(run(['holder', '../checkout']).code, 1);
eq(run(['status', 's21', 'extra']).code, 1);

clearCache(); clearProbes();
const cold = connected('s21');
target('cold device', [cold], 1000); ok(cold.out.includes('connected'));
eq(probes(), ['adb'], 'Android status must not enumerate iOS');
const warm = profile('device/cached', ['status', 's21']);
ok(warm.every(r => r.code === 0));
target('cached device', warm, 300);
ok(probes().every(name => name === 'adb'), 'cache expiry may reprobe ADB, never iOS');
clearCache(); clearProbes();
const hung = run(['status', 's21'], { PROBE_DELAY: '30' });
eq(hung.code, 0, hung.err); target('bounded device', [hung], 1000);
ok(hung.out.includes('unknown'), hung.out); ok(probes().every(name => name === 'adb'));
clearCache(); clearProbes();
const unavailable = run(['status', 's21'], { PROBE_EXIT: '7' });
eq(unavailable.code, 0, unavailable.err); ok(unavailable.out.includes('unknown'));
clearCache(); clearProbes();
const locked = run(['status', 's21'], { ADB_STATE: 'offline' });
eq(locked.code, 0); ok(locked.out.includes('offline'));
clearCache(); clearProbes();
connected('iphone8'); eq(probes(), ['idevice_id']);
connected('iphone8', { IOS_NOT_SEEN: '1' }); eq(probes(), ['idevice_id', 'xcrun']);

clearProbes();
const holder = (id = 's21', by = 'guard') => {
  const r = run(['holder', id, '--by', by]); eq(r.code, 0, r.err);
  eq(r.out.trim().split('\n').length, 1);
  return JSON.parse(r.out);
};
const own = holder();
eq(own.holder, 'guard'); eq(own.mine, 'yes'); eq(own.waiters, 0); eq(own['yield-requested'], 'no');
eq(own.project, 'fixture'); eq(own.task, ''); ok(own.since); eq(own.until, '');
eq(holder('s21', 'other').mine, 'no');
eq(probes(), [], 'holder must never run connectivity/process probes');
const guards = profile('holder', ['holder', 's21', '--by', 'guard']);
ok(guards.every(r => r.code === 0)); target('holder', guards, 300);
const before = fs.readFileSync(info('s21'), 'utf8');
fs.mkdirSync(path.join(state, 'locks/incomplete.d'));
fs.appendFileSync(registry, 'incomplete\tcheckout\topen\t-\tfixture incomplete\n');
eq(holder('incomplete').state, 'pending');
fs.writeFileSync(info('incomplete'), 'broken metadata\n');
eq(run(['holder', 'incomplete']).code, 1); eq(run(['status', 'incomplete']).code, 1);
fs.unlinkSync(info('incomplete'));
fs.writeFileSync(info('incomplete'), 'by\tpartially-published'); eq(holder('incomplete').state, 'pending');
fs.unlinkSync(info('incomplete'));
fs.mkdirSync(path.join(state, 'locks/unrelated.d'));
fs.writeFileSync(info('unrelated'), 'broken unrelated metadata\n');
eq(run(['status', 'checkout']).code, 0, 'single checkout must not inspect unrelated corrupt leases');
eq(run(['status', 's21']).code, 0, 'single device must not inspect unrelated corrupt leases');
fs.appendFileSync(registry, 'off-limits\tdevice\tnever\tfixture-never\tfixture never policy\n');
clearProbes();
const offLimits = run(['status', 'off-limits']); eq(offLimits.code, 0); ok(offLimits.out.includes('not probed')); eq(probes(), []);
const oldRegistry = fs.readFileSync(registry, 'utf8');
fs.appendFileSync(registry, 'invalid registry\n');
eq(run(['status', 's21']).code, 1); eq(run(['holder', 's21']).code, 1);
fs.writeFileSync(registry, oldRegistry);

const children = new Set();
function start(argv, extra = {}) {
  const child = spawn(process.env.RES_SOURCE, argv, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.text = ''; child.stdout.on('data', b => { child.text += b; }); child.stderr.on('data', b => { child.text += b; });
  child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { children.delete(child); resolve(code); }); });
  children.add(child); return child;
}
try {
  // Include real waiting/taking controllers, not only a simulated busy guard file.
  const waiter = start(['wait', 'checkout', ...args('waiting'), '--timeout', '1']);
  const churner = start(['wait', 'churn', ...args('churning'), '--timeout', '1']);
  run(['status', 's21']); clearProbes();
  await new Promise(resolve => setTimeout(resolve, 200));
  const samples = await Promise.all(Array.from({ length: 12 }, (_, i) => {
    const child = start([i % 2 ? 'holder' : 'status', 's21']);
    return child.done.then(code => ({ code, text: child.text }));
  }));
  ok(samples.every(r => r.code === 0 && r.text.includes('guard')), JSON.stringify(samples));
  ok(probes().every(name => name === 'adb'), 'concurrent device statuses can refresh only their own transport');
  clearProbes();
  eq(fs.readFileSync(info('s21'), 'utf8'), before, 'guard observations never rewrite the lease');
  waiter.kill('SIGTERM'); churner.kill('SIGTERM');
  await Promise.all([waiter.done, churner.done]);
  // Metadata published shortly after mkdir is retried internally, never FREE.
  const pending = start(['holder', 'incomplete', '--by', 'publishing']);
  setTimeout(() => fs.writeFileSync(info('incomplete'), 'by\tpublishing\nsince\tfixture\n'), 30);
  eq(await pending.done, 0, pending.text); eq(JSON.parse(pending.text).holder, 'publishing');
  release('checkout');
  eq(holder('checkout').state, 'free');
  eq(probes(), [], 'non-device/holder concurrent reads remain probe-free');
  const queue = path.join(state, 'pool-waiters/devbox-cn/waiter.fixture');
  fs.mkdirSync(queue, { recursive: true });
  const queued = { holder: 'requester', project: 'fixture', task: 'wait', pid: String(process.pid),
    host: 'fixture-remote-host', since: 'fixture wait start', start: '1', order: '1', heartbeat: String(Math.floor(Date.now() / 1000)) };
  const publishWaiter = () => fs.writeFileSync(path.join(queue, 'info'), Object.entries(queued).map(([name, value]) => `${name}\t${value}\n`).join(''));
  publishWaiter();
  const requested = holder('devbox-cn-1');
  eq(requested.waiters, 1); eq(requested['yield-requested'], 'yes');
  eq(requested['oldest-waiter'], { holder: 'requester', since: 'fixture wait start' });
  queued.need = 'android'; publishWaiter(); eq(holder('devbox-cn-1').waiters, 0);
  queued.need = ''; queued.exclude_slots = 'devbox-cn-1'; publishWaiter(); eq(holder('devbox-cn-1').waiters, 0);
  queued.exclude_slots = ''; queued.exclude_hosts = '192.0.2.1'; publishWaiter(); eq(holder('devbox-cn-1').waiters, 0);
  queued.exclude_hosts = '';
  queued.need = ''; queued.heartbeat = '1'; publishWaiter(); eq(holder('devbox-cn-1').waiters, 0);
  ok(fs.existsSync(queue), 'holder must not sweep stale waiter records');
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map(child => child.done));
}
console.log(`ALL ${count} ASSERTIONS PASSED`);
