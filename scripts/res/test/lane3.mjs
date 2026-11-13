#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { collect } from '../../resource-sample.mjs';
import { ALL_HEAVY_IDS, HEAVY_IDS, laneAdmission, lockSnapshot, observeWaiters, parseHeavyCheck, parseHeavyStatus, readLockJournal } from '../../lib/resource-locks.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.env.RES_TEST_ROOT, 'lane3');
const res = process.env.RES_SOURCE;
const state = path.join(root, 'scratch'), mocks = path.join(root, 'mocks');
fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
fs.mkdirSync(mocks, { recursive: true });
const registry = ALL_HEAVY_IDS.map((id) => `${id}\tslot\topen\t-\tscratch ${id}`).join('\n') + '\n';
fs.writeFileSync(path.join(state, 'resources.tsv'), registry);
fs.writeFileSync(path.join(root, 'epoch'), '1794564000\n');
fs.copyFileSync(path.join(base, 't88/legacy/mocks/date'), path.join(mocks, 'date'));
fs.chmodSync(path.join(mocks, 'date'), 0o755);
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\nprintf "%s\\n" "${RES_TEST_OS:-Darwin}"\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'awk'), `#!/bin/bash
case "$*" in
  *'/proc/loadavg') printf '%s\\n' "$RES_TEST_LOAD1M" ;;
  *'/proc/meminfo') printf '%s\\n' "$RES_TEST_LINUX_BYTES" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`, { mode: 0o755 });
const env = { ...process.env, PATH: `${mocks}:${process.env.PATH}`, RES_DIR: state, FIXTURE_DIR: root,
  RES_TEST_METRICS: '1', RES_TEST_LOAD1M: '8', RES_TEST_MEMORYSTATUS_LEVEL: '50',
  RES_TEST_MEMSIZE: '68719476736', RES_TEST_SWAPUSAGE: 'used = 0M',
  RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.' };
let count = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); count++; };
const ok = (value, message) => { assert.ok(value, message); count++; };
const run = (args, extra = {}, script = res) => {
  const r = spawnSync(script, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
};
const takeArgs = (id = 'heavy-lane-3', by = 'lane3-test', pid = process.pid) =>
  [id, '--by', by, '--project', 'scratch', '--for', 'fixture', '--pid', String(pid)];
const take = (extra = {}, id) => run(['take', ...takeArgs(id)], extra);
const wait = (extra = {}, timeout = '0', id) => run(['wait', ...takeArgs(id), '--timeout', timeout], extra);
const release = (id = 'heavy-lane-3', by = 'lane3-test') => eq(run(['return', id, '--by', by]).code, 0);
const lock = (id = 'heavy-lane-3') => path.join(state, 'locks', `${id}.d`);
const metadata = () => fs.readFileSync(path.join(lock(), 'info'), 'utf8');
const changeInfo = (key, value) => fs.writeFileSync(path.join(lock(), 'info'), metadata().replace(new RegExp(`^${key}\\t.*$`, 'm'), `${key}\t${value}`));

for (const [load, ram, expected] of [['8', '68719476736', 'OPEN'], ['8.001', '68719476736', 'CLOSED'],
  ['8', '68719476735', 'CLOSED'], ['7.999', '68719476736', 'OPEN'], ['8', '68719476737', 'OPEN']]) {
  const extra = { RES_TEST_LOAD1M: load, RES_TEST_MEMSIZE: ram };
  const check = run(['heavy-check'], extra);
  eq(check.code, 0); ok(check.text.endsWith(`lane3=${expected}\n`));
  eq(parseHeavyCheck(check.text).lane3, expected);
  eq(take(extra).code, expected === 'OPEN' ? 0 : 5);
  eq(fs.existsSync(lock()), expected === 'OPEN');
  if (expected === 'OPEN') release();
  eq(wait(extra).code, expected === 'OPEN' ? 0 : 2);
  if (expected === 'OPEN') release();
  eq(fs.existsSync(lock()), false);
}
for (const extra of [{ RES_TEST_LOAD1M: '21' }, { RES_TEST_MEMORYSTATUS_LEVEL: '24' }]) {
  eq(run(['heavy-check'], extra).code, 5); eq(take(extra).code, 5); eq(wait(extra).code, 2);
  eq(fs.existsSync(lock()), false);
}
for (const extra of [{ RES_TEST_LOAD1M: 'bad' }, { RES_TEST_MEMORYSTATUS_LEVEL: 'bad' }]) {
  eq(take(extra).code, 1); eq(wait(extra).code, 1); eq(fs.existsSync(lock()), false);
}
// Same memory basis as v1.2: only an explicitly missing sysctl permits pages fallback.
const pages32 = { RES_TEST_MEMORYSTATUS_LEVEL: 'missing',
  RES_TEST_VM_STAT: env.RES_TEST_VM_STAT.replace('Pages free: 0.', 'Pages free: 2097152.') };
eq(take(pages32).code, 0); release();
eq(take({ ...pages32, RES_TEST_VM_STAT: pages32.RES_TEST_VM_STAT.replace('2097152.', '2097151.') }).code, 5);
eq(take().code, 0); // Page headroom is zero, memorystatus still supplies 32 GiB.
const original = metadata(); eq(take().code, 0); eq(metadata(), original);
const originalJournal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
for (const extra of [{ RES_TEST_LOAD1M: '9' }, { RES_TEST_MEMORYSTATUS_LEVEL: '49' },
  { RES_TEST_LOAD1M: '21' }, { RES_TEST_LOAD1M: 'bad' }]) {
  eq(run(['take', ...takeArgs('heavy-lane-3', 'lane3-test', process.ppid)], extra).code, 0);
  eq(metadata(), original); eq(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8'), originalJournal);
  eq(run(['take', ...takeArgs('heavy-lane-3', 'other')], extra).code, extra.RES_TEST_LOAD1M === 'bad' ? 1 : 5);
  eq(metadata(), original);
}
ok(run(['status', 'heavy-lane-3']).text.includes('lane3-test (scratch)'));
eq(run(['take', ...takeArgs('heavy-lane-3', 'other')]).code, 2);
eq(wait({}, '0.02').code, 0); // Idempotent own hold is retained.
eq(metadata(), original); release();
eq(run(['take', ...takeArgs('heavy-lane-3', 'other')]).code, 0);
const timeoutStart = Date.now(); eq(wait({}, '0.02').code, 2);
ok(Date.now() - timeoutStart >= 1000); ok(metadata().includes('by\tother\n')); release('heavy-lane-3', 'other');

// Recovery uses real bounded wait/backoff and changes only scratch fixture readings.
fs.writeFileSync(path.join(mocks, 'sysctl'), `#!/bin/bash
case "$*" in
  '-n vm.loadavg') printf '{ %s 1 1 }\\n' "$(<"$FIXTURE_DIR/load")" ;;
  '-n kern.memorystatus_level') printf '%s\\n' "$(<"$FIXTURE_DIR/level")" ;;
  '-n hw.memsize') printf '68719476736\\n' ;;
  '-n vm.swapusage') printf 'used = 0M\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'vm_stat'), '#!/bin/sh\nprintf "%s\\n" "$RES_TEST_VM_STAT"\n', { mode: 0o755 });
for (const dimension of ['load', 'level']) {
  fs.writeFileSync(path.join(root, 'load'), dimension === 'load' ? '9\n' : '8\n');
  fs.writeFileSync(path.join(root, 'level'), dimension === 'level' ? '49\n' : '50\n');
  const child = spawn(res, ['wait', ...takeArgs(), '--timeout', '0.1'], { env: { ...env, RES_TEST_METRICS: '0' } });
  let output = '', timer;
  const retried = new Promise((resolve) => {
    const capture = (b) => { output += b; if (output.includes('retry in 1s')) resolve(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
  });
  const completion = once(child, 'close');
  try {
    // Open the gate only after the waiter has observed its closure, not after a startup guess.
    await Promise.race([retried, completion.then(([code]) => {
      throw Error(`waiter exited ${code} before retrying: ${output}`);
    }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`waiter did not retry: ${output}`)), 10000);
    })]);
    eq(fs.existsSync(lock()), false);
    fs.writeFileSync(path.join(root, dimension), dimension === 'load' ? '8\n' : '50\n');
    eq((await completion)[0], 0); ok(output.includes('retry in 1s')); release();
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await completion; }
  }
}
// Gate can close between wait's check and its internal take; keep waiting, don't return 5.
fs.writeFileSync(path.join(mocks, 'sysctl'), `#!/bin/bash
case "$*" in
  '-n vm.loadavg')
    n=0; [ ! -f "$FIXTURE_DIR/check-count" ] || n=$(<"$FIXTURE_DIR/check-count")
    n=$((n+1)); printf '%s' "$n" >"$FIXTURE_DIR/check-count"
    load=8; [ "$n" -ne 2 ] || load=9; printf '{ %s 1 1 }\\n' "$load" ;;
  '-n kern.memorystatus_level') printf '50\\n' ;;
  '-n hw.memsize') printf '68719476736\\n' ;;
  '-n vm.swapusage') printf 'used = 0M\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
const race = wait({ RES_TEST_METRICS: '0' }, '0.1');
eq(race.code, 0); ok(race.text.includes('retry in 1s')); release();

// STALE visibility never mutates. Reclaim requires an OPEN lane and age strictly >600s.
const dead = 2147483647;
eq(run(['take', ...takeArgs('heavy-lane-3', 'old', dead)]).code, 0);
changeInfo('start', 1794563400); const at600 = metadata();
ok(run(['status', 'heavy-lane-3']).text.includes('STALE old')); eq(metadata(), at600);
eq(wait().code, 2); eq(metadata(), at600);
changeInfo('start', 1794563399); const stale = metadata();
eq(wait({ RES_TEST_LOAD1M: '9' }).code, 2); eq(metadata(), stale);
eq(wait().code, 0); ok(metadata().includes(`pid\t${process.pid}\n`));
ok(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('\treclaim\theavy-lane-3\t')); release();
for (const kind of ['remote', 'legacy']) {
  eq(run(['take', ...takeArgs('heavy-lane-3', 'old', dead)]).code, 0);
  changeInfo('start', 1794563399);
  if (kind === 'remote') changeInfo('host', 'scratch-remote'); else changeInfo('pid', '');
  const before = metadata(); eq(wait().code, 2); eq(metadata(), before); release('heavy-lane-3', 'old');
}
eq(take().code, 0);
const other = run(['heavy-check', '--pid', String(process.ppid)], { RES_TEST_LOAD1M: '20' });
eq(other.code, 0); ok(other.text.includes('limit=20 lanes_held=1')); ok(other.text.includes('lane3=CLOSED'));
ok(run(['heavy-check', '--pid', String(process.pid)]).text.includes('limit=12 lanes_held=0')); release();
for (const id of ['heavy-lane-1', 'heavy-lane-2']) {
  eq(take({ RES_TEST_LOAD1M: '99', RES_TEST_MEMORYSTATUS_LEVEL: '0' }, id).code, 0); release(id);
}
// Real wrapper fallback reaches lane 3 without disturbing the two other holds.
for (const id of ['heavy-lane-1', 'heavy-lane-2']) eq(take({}, id).code, 0);
eq(take().code, 0);
const threeHeld = run(['heavy-check', '--pid', String(process.ppid)], { RES_TEST_LOAD1M: '20' });
eq(threeHeld.code, 0); ok(threeHeld.text.includes('limit=20 lanes_held=3')); release();
const laneInfo = (id) => fs.readFileSync(path.join(lock(id), 'info'), 'utf8');
const held1 = laneInfo('heavy-lane-1'), held2 = laneInfo('heavy-lane-2');
const wrapper = (extra = {}) => spawnSync('/bin/bash', [path.resolve(base, '../../heavy-build.sh'), '/bin/sh', '-c', 'exit 7'], {
  env: { ...env, RES_COMMAND: res, HEAVY_BUILD_BY: 'wrapper', HEAVY_BUILD_PROJECT: 'scratch',
    HEAVY_BUILD_TASK: 'lane3', HEAVY_BUILD_TIMEOUT: '0', HEAVY_BUILD_LANE: '', ...extra }, encoding: 'utf8', timeout: 20000 });
const wrapped = wrapper(); eq(wrapped.status, 7, wrapped.stderr);
ok(wrapped.stdout.includes('took heavy-lane-3'));
eq(fs.existsSync(lock()), false); eq(fs.existsSync(lock('heavy-build')), false);
eq(laneInfo('heavy-lane-1'), held1); eq(laneInfo('heavy-lane-2'), held2);
const wrapperReturns = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').split('\n')
  .map((line) => line.split('\t')).filter((row) => row[1] === 'return' && row[3] === 'wrapper').map((row) => row[2]);
eq(wrapperReturns, ['heavy-lane-3', 'heavy-build']);
eq(wrapper({ RES_TEST_LOAD1M: '8.001' }).status, 2);
eq(fs.existsSync(lock()), false); eq(fs.existsSync(lock('heavy-build')), false);
eq(laneInfo('heavy-lane-1'), held1); eq(laneInfo('heavy-lane-2'), held2);
eq(wrapper({ HEAVY_BUILD_LANE: 'heavy-lane-3' }).status, 7);
for (const id of ['heavy-lane-1', 'heavy-lane-2']) release(id);
eq(take().code, 0);
eq(run(['return', 'heavy-lane-3', '--by', 'lane3-test'], { RES_TEST_LOAD1M: '99', RES_TEST_MEMORYSTATUS_LEVEL: '0' }).code, 0);
for (const [load, bytes, expected] of [['8', '34359738368', 'OPEN'], ['8.001', '34359738368', 'CLOSED'], ['8', '34359738367', 'CLOSED']]) {
  const extra = { RES_TEST_OS: 'Linux', RES_TEST_LOAD1M: load, RES_TEST_LINUX_BYTES: bytes };
  const check = run(['heavy-check'], extra); eq(check.code, 0); eq(parseHeavyCheck(check.text).lane3, expected);
  eq(take(extra).code, expected === 'OPEN' ? 0 : 5); if (expected === 'OPEN') release();
}
// Existing CLI help, output ordering, exit codes and persisted formats vs exact v1.2.
const baseline = path.join(base, 'fixtures/v1.2-res');
// Missing optional lane 3 during rollout must still wait within the normal-lane budget.
const legacyRegistry = registry.split('\n').filter((line) => !line.startsWith('heavy-lane-3\t')).join('\n');
const rollout = path.join(root, 'rollout'); fs.mkdirSync(path.join(rollout, 'locks'), { recursive: true });
fs.writeFileSync(path.join(rollout, 'resources.tsv'), legacyRegistry);
for (const id of ['heavy-lane-1', 'heavy-lane-2'])
  eq(run(['take', ...takeArgs(id, 'rollout-owner')], { RES_DIR: rollout }).code, 0);
const rolloutInfo = fs.readFileSync(path.join(rollout, 'locks/heavy-lane-1.d/info'), 'utf8');
for (const source of [res, baseline]) {
  const started = Date.now();
  const timedOut = wrapper({ RES_DIR: rollout, RES_COMMAND: source, HEAVY_BUILD_TIMEOUT: '0.02' });
  eq(timedOut.status, 2, timedOut.stderr); ok(Date.now() - started >= 1000);
  ok(timedOut.stderr.includes('continuing bounded waits on lanes 1/2'));
  eq(fs.existsSync(path.join(rollout, 'locks/heavy-build.d')), false);
  eq(fs.readFileSync(path.join(rollout, 'locks/heavy-lane-1.d/info'), 'utf8'), rolloutInfo);
}
const fallback = spawn('/bin/bash', [path.resolve(base, '../../heavy-build.sh'), '/bin/sh', '-c', 'exit 7'], {
  env: { ...env, RES_DIR: rollout, RES_COMMAND: res, HEAVY_BUILD_BY: 'wrapper', HEAVY_BUILD_PROJECT: 'scratch',
    HEAVY_BUILD_TASK: 'rollout', HEAVY_BUILD_TIMEOUT: '0.2', HEAVY_BUILD_LANE: '' } });
let fallbackOutput = '', fallbackTimer;
const fallbackReady = new Promise((resolve) => {
  const capture = (b) => { fallbackOutput += b; if (fallbackOutput.includes('continuing bounded waits on lanes 1/2')) resolve(); };
  fallback.stdout.on('data', capture); fallback.stderr.on('data', capture);
});
const fallbackDone = once(fallback, 'close');
try {
  await Promise.race([fallbackReady, fallbackDone.then(([code]) => { throw Error(`fallback exited ${code}: ${fallbackOutput}`); }),
    new Promise((_, reject) => { fallbackTimer = setTimeout(() => reject(Error('fallback did not reach normal-lane wait')), 10000); })]);
  ok(fs.existsSync(path.join(rollout, 'locks/heavy-build.d')));
  eq(run(['return', 'heavy-lane-2', '--by', 'rollout-owner'], { RES_DIR: rollout }).code, 0);
  eq((await fallbackDone)[0], 7, fallbackOutput); ok(fallbackOutput.includes('took heavy-lane-2'));
} finally {
  clearTimeout(fallbackTimer);
  if (fallback.exitCode === null && fallback.signalCode === null) { fallback.kill('SIGTERM'); await fallbackDone; }
}
eq(fs.existsSync(path.join(rollout, 'locks/heavy-build.d')), false);
eq(fs.existsSync(path.join(rollout, 'locks/heavy-lane-2.d')), false);
eq(fs.readFileSync(path.join(rollout, 'locks/heavy-lane-1.d/info'), 'utf8'), rolloutInfo);
eq(wrapper({ RES_DIR: rollout, HEAVY_BUILD_LANE: 'heavy-lane-3' }).status, 1);
eq(run(['take', ...takeArgs('heavy-lane-2', 'rollout-owner')], { RES_DIR: rollout }).code, 0);
const errorRes = path.join(root, 'error-res');
fs.writeFileSync(errorRes, `#!/bin/bash
if [ "$1" = wait ] && [ "$2" = heavy-lane-3 ]; then echo 'res: cannot read lane-3 metrics' >&2; exit 1; fi
exec "$RES_SOURCE" "$@"
`, { mode: 0o755 });
const failedGate = wrapper({ RES_DIR: rollout, RES_COMMAND: errorRes });
eq(failedGate.status, 1); ok(!failedGate.stderr.includes('continuing bounded waits'));
eq(fs.existsSync(path.join(rollout, 'locks/heavy-build.d')), false);
for (const id of ['heavy-lane-1', 'heavy-lane-2'])
  eq(run(['return', id, '--by', 'rollout-owner'], { RES_DIR: rollout }).code, 0);
eq(run(['--help']).text, run(['--help'], {}, baseline).text);
const transcript = (script, name) => {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'resources.tsv'), registry);
  const output = [];
  const commands = [['help'], ['add', 'checkout', '--device', '-', '--for', 'fixture', '--policy', 'open'],
    ['note', 'checkout', '--by', 'owner', '--note', 'fixture'], ['take', ...takeArgs('checkout', 'owner')],
    ['take', ...takeArgs('checkout', 'other')], ['extend', 'checkout', '--by', 'owner', '--until', 'tomorrow'],
    ['status', 'checkout'], ['return', 'checkout', '--by', 'owner'], ['log', '3'], ['heavy-check'],
    ['wait', ...takeArgs('heavy-build'), '--timeout', '0'], ['return', 'heavy-build', '--by', 'lane3-test']];
  for (const args of commands) {
    const r = run(args, { RES_DIR: dir }, script);
    output.push(`$ ${args.join(' ')}\n${r.text.replaceAll(dir, 'SCRATCH').replace(/ lane3=(OPEN|CLOSED)(?=\n|$)/g, '')}exit=${r.code}\n`);
  }
  return { output: output.join(''), dir };
};
const before = transcript(baseline, 'before'), after = transcript(res, 'after');
fs.writeFileSync(path.join(root, 'compatibility-before.txt'), before.output);
fs.writeFileSync(path.join(root, 'compatibility-after.txt'), after.output);
eq(after.output, before.output);
for (const file of ['resources.tsv', 'log.tsv', 'notes/checkout.md'])
  eq(fs.readFileSync(path.join(after.dir, file), 'utf8'), fs.readFileSync(path.join(before.dir, file), 'utf8'));
fs.writeFileSync(path.join(root, 'compatibility.diff'), '');

// Sampler keeps the suffix authoritative (rounded 8/32 may still be CLOSED).
const sampleText = run(['heavy-check']).text;
eq(parseHeavyCheck(sampleText).controllerPolicy, 'v1.3-lane-aware');
eq(parseHeavyCheck(sampleText.replace('lane3=OPEN', 'lane3=CLOSED')).lane3, 'CLOSED');
eq(parseHeavyCheck(sampleText.replace('lane3=OPEN', 'lane3=bad')).state, 'UNKNOWN');
const statusText = ALL_HEAVY_IDS.map((id) => `${id} slot open - FREE description`).join('\n');
eq(parseHeavyStatus(statusText).locks.length, 4); eq(parseHeavyStatus(statusText).complete, true);
eq(parseHeavyStatus(statusText.split('\n').slice(0, 3).join('\n')).complete, true);
const snap = lockSnapshot({ complete: true, held: [], registered: ALL_HEAVY_IDS, errors: [] }, [],
  { host: 'scratch', psStartedAt: 1, now: 1, processComplete: true });
eq(snap.locks.length, 4);
eq(laneAdmission({ ...snap, locks: snap.locks.map((l) => l.id === 'heavy-lane-3'
  ? { ...l, state: 'HELD', stale: false, local: true, pidIdentity: 'observed', pid: 100 } : l) }).otherLanes, 1);
eq(observeWaiters([{ pid: 1, ppid: 0, _command: `res wait heavy-lane-3 --pid 100 --timeout 1`, elapsedSeconds: 1 }],
  [{ pid: 1, id: 'fixture' }], 1000).length, 1);
const journal = readLockJournal(state); ok(journal.events.some((e) => e.resource === 'heavy-lane-3'));
const sampled = await collect({ leases: { complete: true, held: [], registered: HEAVY_IDS, errors: [] },
  registry: { complete: true, errors: [], tasks: [], mappings: [], projects: [] }, journal: { complete: true, events: [], errors: [] },
  probe: async (label) => label === 'heavy-check' ? sampleText : '' });
eq(sampled.heavyGate.lane3, 'OPEN'); eq(sampled.heavyLocks.lane3, 'OPEN');

// Owner installer exercised only against fake shared state; tests are stubbed here.
const installState = path.join(root, 'install-state'), installBin = path.join(root, 'install-bin');
fs.mkdirSync(path.join(installState, 'locks'), { recursive: true }); fs.mkdirSync(installBin);
fs.symlinkSync(baseline, path.join(installState, 'res'));
const installRegistry = path.join(installState, 'resources.tsv');
fs.writeFileSync(installRegistry, legacyRegistry, { mode: 0o640 });
fs.writeFileSync(path.join(installState, 'log.tsv'), 'unchanged journal\n');
fs.writeFileSync(path.join(installBin, 'node'), `#!/bin/sh
if [ -n "\${INSTALL_TEST_PS_AFTER:-}" ]; then printf '%s\\n' "$INSTALL_TEST_PS_AFTER" >"$FIXTURE_DIR/install-ps-after"; fi
exit "\${INSTALL_TEST_EXIT:-0}"
`, { mode: 0o755 });
fs.writeFileSync(path.join(installBin, 'ps'), `#!/bin/sh
if [ -f "$FIXTURE_DIR/install-ps-after" ]; then cat "$FIXTURE_DIR/install-ps-after";
else printf '%s\\n' "\${INSTALL_TEST_PS:-1 /bin/launchd}"; fi
exit "\${INSTALL_PS_EXIT:-0}"
`, { mode: 0o755 });
fs.writeFileSync(path.join(installBin, 'mv'), `#!/bin/bash
if [[ "$*" = *'.resources-switch.'* ]] && [ "\${INSTALL_FAIL_REGISTRY:-0}" = 1 ] && [ ! -f "$FIXTURE_DIR/install-mv-failed" ]; then
  readlink "$RES_INSTALL_DIR/res" >"$FIXTURE_DIR/install-code-at-registry-publish"
  touch "$FIXTURE_DIR/install-mv-failed"
  exit 1
fi
exec /bin/mv "$@"
`, { mode: 0o755 });
const install = (args = [], extra = {}) => {
  const r = spawnSync('/bin/bash', [path.join(base, '../install.sh'), ...args], { env: { ...env,
    PATH: `${installBin}:${env.PATH}`, RES_INSTALL_DIR: installState, ...extra }, encoding: 'utf8', timeout: 10000 });
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
};
fs.mkdirSync(path.join(installState, 'locks/heavy-lane-3.d'));
eq(install().code, 2); eq(fs.readlinkSync(path.join(installState, 'res')), baseline);
fs.rmdirSync(path.join(installState, 'locks/heavy-lane-3.d'));
eq(install([], { INSTALL_TEST_PS: '123 /bin/bash /scratch/res wait iphone11 --timeout 1' }).code, 2);
for (const argv of ['env FOO=bar /scratch/res wait iphone11', 'nohup res wait heavy-build',
  "zsh -c '/scratch/res wait heavy-lane-3'", 'zsh -c \'exec env FOO=bar "/scratch/res" wait heavy-build\'',
  '/safe/project/scripts/res/res wait heavy-build'])
  eq(install([], { INSTALL_TEST_PS: `123 ${argv}` }).code, 2, argv);
eq(install([], { INSTALL_PS_EXIT: '1' }).code, 2);
eq(install([], { INSTALL_TEST_EXIT: '1' }).code, 1);
eq(install([], { INSTALL_TEST_PS_AFTER: '123 nohup /scratch/res wait heavy-build' }).code, 2);
fs.unlinkSync(path.join(root, 'install-ps-after'));
eq(fs.readlinkSync(path.join(installState, 'res')), baseline);
eq(fs.readFileSync(installRegistry, 'utf8'), legacyRegistry);
eq(install([], { INSTALL_FAIL_REGISTRY: '1' }).code, 1);
eq(fs.readFileSync(path.join(root, 'install-code-at-registry-publish'), 'utf8').trim(), res);
eq(fs.readlinkSync(path.join(installState, 'res')), baseline);
eq(fs.readFileSync(installRegistry, 'utf8'), legacyRegistry);
const nonWaiters = '1 /bin/launchd\n123 /scratch/res status\n124 /scratch/res waiter\n125 /scratch/resource wait\n126 zsh -c "res heavy-check"';
const switched = install([], { INSTALL_TEST_PS: nonWaiters }); eq(switched.code, 0); eq(fs.readlinkSync(path.join(installState, 'res')), res);
const backup = path.basename(path.dirname(switched.text.match(/^Backup: (.+)$/m)[1]));
eq(fs.readFileSync(path.join(installState, backup, 'res'), 'utf8'), fs.readFileSync(baseline, 'utf8'));
eq(fs.readFileSync(path.join(installState, backup, 'resources.tsv'), 'utf8'), legacyRegistry);
const installedRegistry = legacyRegistry + fs.readFileSync(path.join(base, '../resources-lane3.tsv'), 'utf8');
eq(fs.readFileSync(installRegistry, 'utf8'), installedRegistry);
eq(fs.statSync(installRegistry).mode & 0o777, 0o640);
const registryInode = fs.statSync(installRegistry).ino;
eq(install().code, 0); eq(fs.readFileSync(installRegistry, 'utf8'), installedRegistry);
eq(fs.statSync(installRegistry).ino, registryInode);
for (const badRow of [installedRegistry + fs.readFileSync(path.join(base, '../resources-lane3.tsv'), 'utf8'),
  installedRegistry.replace('heavy-lane-3\tslot\topen', 'heavy-lane-3\tslot\tnever')]) {
  fs.writeFileSync(installRegistry, badRow);
  eq(install().code, 2); eq(fs.readFileSync(installRegistry, 'utf8'), badRow);
  eq(fs.readlinkSync(path.join(installState, 'res')), res);
}
fs.writeFileSync(installRegistry, installedRegistry);
ok(switched.text.includes('Rollback')); ok(switched.text.includes('ln -sfn'));
const rollback = switched.text.split('\n').find((line) => line.startsWith('cp -p'));
eq(spawnSync('/bin/bash', ['-c', rollback]).status, 0);
eq(fs.readFileSync(path.join(installState, 'res'), 'utf8'), fs.readFileSync(baseline, 'utf8'));
eq(fs.readFileSync(installRegistry, 'utf8'), legacyRegistry);
eq(install(['--force'], { INSTALL_TEST_PS: '123 /scratch/res wait heavy-lane-3' }).code, 0);
eq(fs.readFileSync(installRegistry, 'utf8'), installedRegistry);
eq(fs.readFileSync(path.join(installState, 'log.tsv'), 'utf8'), 'unchanged journal\n');
eq(fs.readdirSync(installState).filter((name) => name.startsWith('.res-') || name.startsWith('.resources-')).length, 0);
eq(fs.readdirSync(path.join(state, 'locks')).length, 0);
console.log(`ALL ${count} ASSERTIONS PASSED`);
