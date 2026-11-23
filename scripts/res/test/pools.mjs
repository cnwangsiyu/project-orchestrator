#!/usr/bin/env node
// Scratch remote capacity only: no live registry, devices, hubs or ssh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { testPoolIdentity } from './pool-identity.mjs';
import { testPoolSurplus } from './pool-surplus.mjs';

const root = path.join(process.env.RES_TEST_ROOT, 'pools');
const state = path.join(root, 'state'), mocks = path.join(root, 'mocks');
fs.mkdirSync(path.join(state, 'locks'), { recursive: true }); fs.mkdirSync(mocks, { recursive: true });
const hostA = '192.0.2.1', hostB = '192.0.2.2';
const row = (id, kind = 'remote') => {
  const first = ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-light'].includes(id);
  return `${id}\t${kind}\topen\t-\tfixture runner@${first ? hostA : hostB} caps=node,${first ? 'android' : 'chromium'}\n`;
};
fs.writeFileSync(path.join(state, 'resources.tsv'), ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-3', 'devbox-cn-4', 'devbox-cn-light', 'devbox-cn-light-2'].map(id => row(id)).join('') + row('devbox-cn-6', 'checkout') + row('devbox-cn-special'));
for (const command of ['adb', 'idevice_id', 'xcrun']) fs.writeFileSync(path.join(mocks, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// Any accidental heavy-check must fail, even though remote capacity is free.
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'ps'), '#!/bin/sh\ncase "$*" in\n  "-p "*) kill -0 "$2" 2>/dev/null || exit 1; echo "$2";;\n  *) exit 2;;\nesac\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'sleep'), `#!/bin/sh
if [ -n "\${PAUSE_MARK:-}" ] && [ "$1" = 1 ]; then
  touch "$PAUSE_MARK"
  while [ ! -f "$PAUSE_MARK.release" ]; do /bin/sleep 0.02; done
fi
if [ -n "\${SECOND_MARK:-}" ] && [ "$1" = 2 ]; then
  touch "$SECOND_MARK"
  while [ ! -f "$SECOND_MARK.release" ]; do /bin/sleep 0.02; done
fi
exec /bin/sleep 0.03
`, { mode: 0o755 });
const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`, RES_TEST_POOL_FAST_POLL: '1', RES_WAITER_STALE_SECONDS: '45' };
const args = (by) => ['--by', by, '--project', by, '--task', 'fixture', '--for', 'remote fixture', '--pid', String(process.pid)];
const locks = () => fs.readdirSync(path.join(state, 'locks')).filter(n => n.endsWith('.d')).sort();
const waiters = (pool = 'devbox-cn') => {
  const dir = path.join(state, 'pool-waiters', pool);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.startsWith('waiter.')).map(n => path.join(dir, n)) : [];
};
const field = (dir, key) => fs.readFileSync(path.join(dir, 'info'), 'utf8').match(new RegExp(`^${key}\\t(.*)$`, 'm'))?.[1];
const owner = id => field(path.join(state, 'locks', `${id}.d`), 'by');
let count = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); count++; };
const ok = (a, msg) => { assert.ok(a, msg); count++; };
const run = argv => {
  const r = spawnSync(process.env.RES_SOURCE, argv, { env, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
};
const take = (id, by = id) => { const r = run(['take', id, ...args(by)]); eq(r.code, 0, r.text); };
const release = (id, by = id) => { const r = run(['return', id, '--by', by]); eq(r.code, 0, r.text); };
const acquire = (by, pool = 'devbox-cn', extra = []) => run(['wait-pool', pool, ...args(by), '--timeout', '0', ...extra]);
const children = new Set();
function start(by, extra = {}, source = process.env.RES_SOURCE) {
  const child = spawn(source, ['wait-pool', 'devbox-cn', ...args(by), '--timeout', '2'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.text = ''; child.stdout.on('data', b => { child.text += b; }); child.stderr.on('data', b => { child.text += b; });
  child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { children.delete(child); resolve(code); }); });
  children.add(child); return child;
}
async function until(predicate, child) {
  const deadline = Date.now() + 60000;
  while (!predicate()) {
    if (Date.now() > deadline || child && !children.has(child)) throw Error(`scenario did not reach expected state: ${child?.text ?? ''}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const unblock = mark => fs.writeFileSync(`${mark}.release`, 'go');
try {
  for (const id of ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-3']) take(id);
  const free = acquire('any-free'); eq(free.code, 0, free.text); ok(free.text.includes('slot=devbox-cn-4'));
  eq(owner('devbox-cn-4'), 'any-free'); eq(waiters(), []);
  const before = fs.readFileSync(path.join(state, 'locks/devbox-cn-4.d/info'), 'utf8');
  const again = acquire('any-free', 'devbox-cn-'); eq(again.code, 0); ok(again.text.includes('slot=devbox-cn-4'));
  eq(fs.readFileSync(path.join(state, 'locks/devbox-cn-4.d/info'), 'utf8'), before);
  eq(acquire('wrong-pid', 'missing-pool').code, 1);
  const lightExcluded = acquire('excluded'); eq(lightExcluded.code, 2, lightExcluded.text); eq(waiters(), []);
  eq(locks(), ['devbox-cn-1.d', 'devbox-cn-2.d', 'devbox-cn-3.d', 'devbox-cn-4.d']);
  const light = acquire('light', 'devbox-cn-light'); eq(light.code, 0); ok(light.text.includes('slot=devbox-cn-light')); release('devbox-cn-light', 'light');
  const lightA = acquire('light-a', 'devbox-cn-light'); eq(lightA.code, 0); ok(/slot=devbox-cn-light\n/.test(lightA.text + '\n'));
  const lightB = acquire('light-b', 'devbox-cn-light'); eq(lightB.code, 0, lightB.text); ok(lightB.text.includes('slot=devbox-cn-light-2'));
  release('devbox-cn-light-2', 'light-b'); release('devbox-cn-light', 'light-a');

  const firstMark = path.join(root, 'first'), secondMark = path.join(root, 'second'), retryMark = path.join(root, 'retry');
  const first = start('first', { PAUSE_MARK: firstMark }); await until(() => fs.existsSync(firstMark), first);
  const second = start('second', { PAUSE_MARK: secondMark, SECOND_MARK: retryMark }); await until(() => fs.existsSync(secondMark) && waiters().length === 2, second);
  ok(run(['status', 'devbox-cn-4']).text.includes('Waiting pool devbox-cn:'));
  ok(run(['status']).text.includes('Waiting pool devbox-cn:'));
  release('devbox-cn-4', 'any-free'); unblock(secondMark);
  await until(() => fs.existsSync(retryMark), second); eq(locks().includes('devbox-cn-4.d'), false);
  const jump = run(['take', 'devbox-cn-4', ...args('jump')]); eq(jump.code, 2); ok(jump.text.includes('FIFO'));
  unblock(firstMark); eq(await first.done, 0, first.text); eq(owner('devbox-cn-4'), 'first');
  release('devbox-cn-4', 'first'); unblock(retryMark); eq(await second.done, 0, second.text); eq(owner('devbox-cn-4'), 'second'); eq(waiters(), []);

  const addedMark = path.join(root, 'added'); const added = start('added', { PAUSE_MARK: addedMark });
  await until(() => fs.existsSync(addedMark), added);
  fs.appendFileSync(path.join(state, 'resources.tsv'), row('devbox-cn-5'));
  unblock(addedMark); eq(await added.done, 0, added.text); ok(added.text.includes('slot=devbox-cn-5')); release('devbox-cn-5', 'added'); take('devbox-cn-5');

  const sweepMark = path.join(root, 'sweep'); const swept = start('swept', { PAUSE_MARK: sweepMark });
  await until(() => fs.existsSync(sweepMark), swept);
  const oldDir = waiters()[0], order = field(oldDir, 'order');
  const info = fs.readFileSync(path.join(oldDir, 'info'), 'utf8').replace(/^heartbeat\t.*$/m, 'heartbeat\t1');
  fs.writeFileSync(path.join(oldDir, 'info'), info);
  run(['status', 'devbox-cn-1']); eq(waiters(), []);
  // A younger live waiter stays queued behind the re-published original order.
  const youngerMark = path.join(root, 'younger'); const younger = start('younger', { PAUSE_MARK: youngerMark });
  await until(() => fs.existsSync(youngerMark), younger);
  unblock(sweepMark); await until(() => fs.existsSync(oldDir), swept); eq(field(oldDir, 'order'), order);
  release('devbox-cn-5'); eq(await swept.done, 0, swept.text); eq(owner('devbox-cn-5'), 'swept');
  younger.kill('SIGTERM'); unblock(youngerMark); eq(await younger.done, 143); eq(waiters(), []); release('devbox-cn-5', 'swept'); take('devbox-cn-5');

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const child = start(signal); await until(() => waiters().length === 1 && child.text.includes('retry in'), child);
    child.kill(signal); eq(await child.done, code); eq(waiters(), []);
  }
  eq(acquire('timeout').code, 2); eq(waiters(), []);
  const log = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
  for (const event of ['start', 'acquire', 'timeout', 'rejoin']) ok(log.includes(`\twaiter-${event}\tdevbox-cn-any\t`));
  eq(locks().filter(n => n.startsWith('heavy-')), []);
  const replacedRes = path.join(root, 'res-replaced'), replaceMark = path.join(root, 'replace');
  fs.copyFileSync(process.env.RES_SOURCE, replacedRes);
  for (const helper of ['dynamic_capacity.py', 'mini2_control.py', 'local_control.py']) {
    fs.copyFileSync(path.join(path.dirname(process.env.RES_SOURCE), helper), path.join(root, helper));
  }
  const waitingDuringUpdate = start('during-update', { PAUSE_MARK: replaceMark }, replacedRes);
  await until(() => fs.existsSync(replaceMark), waitingDuringUpdate);
  // Simulate unexpected bytes at the old file offset after an in-place copy.
  fs.appendFileSync(replacedRes, ')\n');
  release('devbox-cn-4', 'second'); unblock(replaceMark);
  eq(await waitingDuringUpdate.done, 0, waitingDuringUpdate.text);
  ok(waitingDuringUpdate.text.includes('slot=devbox-cn-4'));
  eq(owner('devbox-cn-4'), 'during-update'); release('devbox-cn-4', 'during-update');
  for (const id of ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-3', 'devbox-cn-5']) release(id);

  const healthFile = path.join(state, 'box-health.json');
  const health = () => JSON.parse(run(['box-health', '--json']).text);
  const quarantine = host => eq(run(['quarantine', host, '--reason', 'fixture maintenance']).code, 0);
  const clear = host => eq(run(['unquarantine', host]).code, 0);
  const infra = (id, kind = 'ssh') => eq(run(['report-infra', id, '--kind', kind]).code, 0);
  const expectSlot = (by, id, extra) => { const r = acquire(by, 'devbox-cn', extra); eq(r.code, 0, r.text); ok(r.text.includes(`slot=${id}\n`)); release(id, by); };
  expectSlot('preferred-host', 'devbox-cn-3', ['--prefer-host', hostB]);
  expectSlot('preferred-slot', 'devbox-cn-4', ['--prefer-slot', 'devbox-cn-4']);
  take('devbox-cn-4');
  expectSlot('preferred-slot-busy', 'devbox-cn-3', ['--prefer-slot', 'devbox-cn-4']);
  expectSlot('slot-host-before-explicit-host', 'devbox-cn-3', ['--prefer-slot', 'devbox-cn-4', '--prefer-host', hostA]);
  take('devbox-cn-3'); take('devbox-cn-5');
  expectSlot('preferred-host-busy', 'devbox-cn-1', ['--prefer-host', hostB]);
  expectSlot('preferred-slot-host-busy', 'devbox-cn-1', ['--prefer-slot', 'devbox-cn-4']);
  for (const id of ['devbox-cn-3', 'devbox-cn-4', 'devbox-cn-5']) release(id);
  expectSlot('all-caps', 'devbox-cn-3', ['--need', 'node,chromium', '--prefer-host', hostA]);
  expectSlot('caps-before-slot', 'devbox-cn-1', ['--need', 'node,android', '--prefer-slot', 'devbox-cn-4']);
  const impossible = acquire('impossible', 'devbox-cn', ['--need', 'android,chromium']);
  eq(impossible.code, 1); ok(impossible.text.includes('no open remote member')); eq(waiters(), []);
  eq(acquire('bad-caps', 'devbox-cn', ['--need', 'node,']).code, 1);
  const registryFile = path.join(state, 'resources.tsv'), registry = fs.readFileSync(registryFile, 'utf8');
  fs.writeFileSync(registryFile, registry.replace(row('devbox-cn-1'), row('devbox-cn-1').trimEnd() + ' prefer=android,vesdk\n'));
  expectSlot('generic-prefers-neutral', 'devbox-cn-2', ['--prefer-slot', 'devbox-cn-1']);
  expectSlot('unrelated-need', 'devbox-cn-2', ['--need', 'node']);
  expectSlot('prefer-tag-over-affinity', 'devbox-cn-1', ['--need', 'android', '--prefer-slot', 'devbox-cn-2']);
  const others = ['devbox-cn-2', 'devbox-cn-3', 'devbox-cn-4', 'devbox-cn-5'];
  for (const id of others) take(id);
  expectSlot('generic-uses-spare', 'devbox-cn-1', []);
  for (const id of others) release(id);
  expectSlot('exclude-slot', 'devbox-cn-3', ['--need', 'node', '--exclude-slot', 'devbox-cn-1,devbox-cn-2']);
  expectSlot('exclude-host', 'devbox-cn-3', ['--prefer-host', hostA, '--exclude-host', hostA]);
  eq(acquire('excluded-all', 'devbox-cn', ['--exclude-host', hostA + ',' + hostB]).code, 2);
  fs.writeFileSync(registryFile, registry.replace(row('devbox-cn-2'), row('devbox-cn-2').replace('caps=node,android', 'caps=node,vesdk-android')));
  expectSlot('per-slot-caps', 'devbox-cn-2', ['--need', 'vesdk-android', '--prefer-slot', 'devbox-cn-1']);
  fs.writeFileSync(registryFile, registry);
  fs.appendFileSync(registryFile, 'devbox-cn-9\tremote\task-user\t-\tfixture runner@192.0.2.9 caps=unique\n');
  eq(acquire('closed-caps', 'devbox-cn', ['--need', 'unique', '--force']).code, 1);
  fs.writeFileSync(registryFile, registry);
  const retained = acquire('retained-hold'); eq(retained.code, 0, retained.text);
  quarantine(hostA);
  const retainedAgain = acquire('retained-hold'); eq(retainedAgain.code, 0, retainedAgain.text); ok(retainedAgain.text.includes('slot=devbox-cn-1'));
  release('devbox-cn-1', 'retained-hold');
  expectSlot('quarantined-preference', 'devbox-cn-3', ['--prefer-host', hostA]);
  const lightHealthy = acquire('healthy-light', 'devbox-cn-light', ['--prefer-host', hostA]);
  eq(lightHealthy.code, 0, lightHealthy.text); ok(lightHealthy.text.includes('slot=devbox-cn-light-2')); release('devbox-cn-light-2', 'healthy-light');
  eq(acquire('quarantined-caps', 'devbox-cn', ['--need', 'android']).code, 2);
  for (const id of ['devbox-cn-3', 'devbox-cn-4', 'devbox-cn-5']) take(id);
  const healthyFirstMark = path.join(root, 'healthy-first'), healthySecondMark = path.join(root, 'healthy-second'), healthyRetry = path.join(root, 'healthy-retry');
  const healthyFirst = start('healthy-first', { PAUSE_MARK: healthyFirstMark }); await until(() => fs.existsSync(healthyFirstMark), healthyFirst);
  const healthySecond = start('healthy-second', { PAUSE_MARK: healthySecondMark, SECOND_MARK: healthyRetry }); await until(() => fs.existsSync(healthySecondMark), healthySecond);
  release('devbox-cn-3'); unblock(healthySecondMark); await until(() => fs.existsSync(healthyRetry), healthySecond);
  eq(locks().includes('devbox-cn-3.d'), false); eq(locks().includes('devbox-cn-1.d'), false);
  unblock(healthyFirstMark); eq(await healthyFirst.done, 0, healthyFirst.text); eq(owner('devbox-cn-3'), 'healthy-first');
  release('devbox-cn-3', 'healthy-first'); unblock(healthyRetry); eq(await healthySecond.done, 0, healthySecond.text); eq(owner('devbox-cn-3'), 'healthy-second');
  release('devbox-cn-3', 'healthy-second'); release('devbox-cn-4'); release('devbox-cn-5'); clear(hostA);
  infra('devbox-cn-1'); infra('devbox-cn-2', 'disk'); eq(health()[hostA].quarantined, false);
  infra('devbox-cn-light', 'upload'); eq(health()[hostA].quarantined, true); eq(health()[hostA].failures30m, 3);
  expectSlot('auto-skip', 'devbox-cn-3', ['--prefer-host', hostA]);
  let stored = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
  stored[hostA].quarantinedUntil = Date.now() / 1000 - 1;
  for (const f of stored[hostA].failures) f.at -= 3600;
  fs.writeFileSync(healthFile, JSON.stringify(stored));
  eq(health()[hostA].quarantined, false);
  expectSlot('expired-rejoin', 'devbox-cn-1', ['--prefer-host', hostA]);
  infra('devbox-cn-2'); eq(health()[hostA].quarantined, true); eq(health()[hostA].failures30m, 1); clear(hostA);
  infra('devbox-cn-1'); infra('devbox-cn-2');
  stored = JSON.parse(fs.readFileSync(healthFile, 'utf8')); for (const f of stored[hostA].failures) f.at -= 1801;
  fs.writeFileSync(healthFile, JSON.stringify(stored)); infra('devbox-cn-1'); eq(health()[hostA].quarantined, false); eq(health()[hostA].failures30m, 1); clear(hostA);
  const concurrent = ['ssh', 'disk', 'upload'].map(kind => new Promise((resolve, reject) => {
    const child = spawn(process.env.RES_SOURCE, ['report-infra', 'devbox-cn-1', '--kind', kind], { env, stdio: 'ignore' });
    child.on('error', reject); child.on('close', resolve);
  }));
  eq(await Promise.all(concurrent), [0, 0, 0]); eq(health()[hostA].failures30m, 3); clear(hostA);
  quarantine(hostA); quarantine(hostB); eq(acquire('all-unhealthy').code, 2); eq(waiters(), []); clear(hostA); clear(hostB);
  eq(run(['report-infra', 'devbox-cn-1', '--kind', 'test']).code, 1);
  eq(run(['quarantine', '192.0.2.99', '--reason', 'unknown']).code, 1);
  // Failure after reservation must release both the tentative hold and waiter.
  const python = spawnSync('python3', ['-B', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
  ok(path.isAbsolute(python));
  fs.writeFileSync(path.join(mocks, 'python3'), `#!/bin/sh\n[ "$1" != -B ] || shift\n[ "$3" != check ] || exit 1\nexec '${python.replaceAll("'", "'\\''")}' -B "$@"\n`, { mode: 0o755 });
  try {
    const failed = spawnSync(process.env.RES_SOURCE, ['wait-pool', 'devbox-cn', ...args('health-read-failed-after-reservation'), '--timeout', '0'],
      { env: { ...env, RES_TEST_POOL_REJECT: 'error' }, encoding: 'utf8' });
    eq(failed.status, 1, failed.stderr); eq(locks(), []); eq(waiters(), []);
  }
  finally { fs.unlinkSync(path.join(mocks, 'python3')); }
  fs.writeFileSync(healthFile, '{'); eq(acquire('malformed-health').code, 1); eq(locks(), []); eq(waiters(), []); fs.writeFileSync(healthFile, '{}');

  const hostsFile = path.join(state, 'devbox-hosts.json');
  const probe = (cores, freeGiB = 100, age = 0) => ({ cores, freeGiB, probedAt: new Date(Date.now() - age).toISOString() });
  const probes = (a = 4, b = 64) => fs.writeFileSync(hostsFile, JSON.stringify({ [hostA]: probe(a), [hostB]: probe(b) }));
  probes();
  expectSlot('capacity-before-id', 'devbox-cn-3', []);
  expectSlot('affinity-under-limit', 'devbox-cn-1', ['--prefer-host', hostA]);
  expectSlot('slot-before-host-capacity', 'devbox-cn-2', ['--prefer-slot', 'devbox-cn-2', '--prefer-host', hostB]);
  take('devbox-cn-1');
  expectSlot('affinity-at-limit', 'devbox-cn-2', ['--prefer-host', hostA]);
  expectSlot('busy-slot-host-at-limit', 'devbox-cn-2', ['--prefer-slot', 'devbox-cn-1']);
  take('devbox-cn-light');
  eq(health()[hostA].heldSlots, 2); eq(health()[hostA].score, 0.5); eq(health()[hostA].nextScore, 0.75);
  ok(run(['box-health']).text.includes('cores=4 score=0.5000 nextScore=0.7500'));
  const hostStatus = run(['status', 'devbox-cn-2']); eq(hostStatus.code, 0, hostStatus.text);
  ok(hostStatus.text.includes(`Host ${hostA} heldSlots=2 cores=4 score=0.5000`));
  ok(!hostStatus.text.includes(`Host ${hostB}`));
  ok(run(['status']).text.includes(`Host ${hostB} heldSlots=0 cores=64 score=0.0000`));
  fs.appendFileSync(registryFile, 'fixture-device\tdevice\tnever\tfixture-device-id\tsynthetic device status\n');
  const mixedStatus = run(['status']); eq(mixedStatus.code, 0, mixedStatus.text);
  ok(mixedStatus.text.includes(`Host ${hostA} heldSlots=2 cores=4 score=0.5000`));
  fs.writeFileSync(registryFile, registry);
  expectSlot('host-affinity-over-limit', 'devbox-cn-3', ['--prefer-host', hostA]);
  expectSlot('slot-affinity-over-limit', 'devbox-cn-3', ['--prefer-slot', 'devbox-cn-2']);
  expectSlot('busy-slot-host-over-limit', 'devbox-cn-3', ['--prefer-slot', 'devbox-cn-1']);
  release('devbox-cn-1'); release('devbox-cn-light');
  take('devbox-cn-3');
  const spread = acquire('spread'); eq(spread.code, 0, spread.text); ok(spread.text.includes('slot=devbox-cn-4\n'));
  eq(health()[hostB].heldSlots, 2); release('devbox-cn-4', 'spread'); release('devbox-cn-3');
  // Equal next scores prefer free disk space, then the original slot-id tie-break.
  fs.writeFileSync(hostsFile, JSON.stringify({ [hostA]: probe(8, 10), [hostB]: probe(8, 200) }));
  expectSlot('free-disk-tie', 'devbox-cn-3', []);
  probes(8, 8); expectSlot('slot-id-tie', 'devbox-cn-1', []);
  const affinityFile = path.join(state, 'devbox-affinity.json');
  const affinityKey = (project, branch) => `id-${createHash('sha256').update('project:' + project).digest('hex')}+${branch}`;
  const recent = age => new Date(Date.now() - age).toISOString();
  const affinityState = JSON.stringify({
    [affinityKey('warm-tie', 'main')]: { host: hostA, slot: 'devbox-cn-1', time: recent(60000) },
    [affinityKey('warm-tie', 'branch')]: { host: hostB, slot: 'devbox-cn-4', time: recent(30000) },
    [affinityKey('other-repo', 'main')]: { host: hostB, slot: 'devbox-cn-3', time: recent(1000) },
    [affinityKey('warm-small', 'main')]: { host: hostA, slot: 'devbox-cn-1', time: recent(1000) },
  });
  fs.writeFileSync(affinityFile, affinityState);
  expectSlot('warm-tie', 'devbox-cn-4', []);
  probes(8, 64); expectSlot('warm-small', 'devbox-cn-3', []);
  eq(fs.readFileSync(affinityFile, 'utf8'), affinityState); fs.unlinkSync(affinityFile);
  const hostC = '192.0.2.3';
  fs.appendFileSync(registryFile, `devbox-cn-21\tremote\topen\t-\tfixture runner@${hostC} caps=node\n`);
  fs.writeFileSync(hostsFile, JSON.stringify({ [hostA]: probe(8), [hostB]: probe(64), [hostC]: probe(64) }));
  const firstBig = acquire('first-big'); eq(firstBig.code, 0, firstBig.text); ok(firstBig.text.includes('slot=devbox-cn-21\n'));
  expectSlot('spread-across-big-hosts', 'devbox-cn-3', []); release('devbox-cn-21', 'first-big');
  fs.writeFileSync(registryFile, registry);
  probes();
  fs.writeFileSync(registryFile, registry.replace(row('devbox-cn-1'), row('devbox-cn-1').trimEnd() + ' prefer=node\n'));
  expectSlot('matching-tier-before-capacity', 'devbox-cn-1', ['--need', 'node', '--prefer-slot', 'devbox-cn-3']);
  expectSlot('generic-capacity-neutral', 'devbox-cn-3', []);
  const taggedBig = registry.split('\n').map(line => line.includes(`@${hostB} `) ? line + ' prefer=node' : line).join('\n');
  fs.writeFileSync(registryFile, taggedBig);
  expectSlot('neutral-before-big-tagged', 'devbox-cn-1', []);
  expectSlot('matching-big-tagged', 'devbox-cn-3', ['--need', 'node', '--prefer-slot', 'devbox-cn-1']);
  const described = registry.split('\n').map(line => line.includes(`@${hostB} `) ? line + ' cores=64' : line).join('\n');
  fs.writeFileSync(registryFile, described); fs.unlinkSync(hostsFile);
  expectSlot('missing-probes-description', 'devbox-cn-3', []);
  fs.writeFileSync(registryFile, registry);
  expectSlot('missing-probes-default', 'devbox-cn-1', []); eq(health()[hostA].cores, null); eq(health()[hostA].coresSource, 'unknown');
  fs.writeFileSync(registryFile, described);
  fs.writeFileSync(hostsFile, JSON.stringify({ [hostA]: probe(64, 500, 25 * 3600000), [hostB]: probe(4, 500, 25 * 3600000) }));
  expectSlot('stale-probes-retain-hardware', 'devbox-cn-1', []); eq(health()[hostA].cores, 64); eq(health()[hostA].coresSource, 'stale-probe'); eq(health()[hostA].freeGiB, null);
  for (const invalid of ['{', '[]', JSON.stringify({ [hostA]: { cores: 64 }, [hostB]: probe(0) }),
    JSON.stringify({ [hostA]: probe(64, 500, -3600000), [hostB]: probe(false) })]) {
    fs.writeFileSync(hostsFile, invalid); expectSlot('invalid-probes-fallback', 'devbox-cn-3', []);
  }
  fs.unlinkSync(hostsFile); fs.writeFileSync(registryFile, registry);

  // Exercise expiry and rollback with the controller’s in-process test hooks.
  {
    const ids = ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-3', 'devbox-cn-4', 'devbox-cn-5'];
    for (const id of ids) take(id);
    const expireMark = path.join(root, 'expire-head'), expireNextMark = path.join(root, 'expire-next');
    const expireLog = path.join(root, 'expire-checks');
    const head = start('expire-head', { PAUSE_MARK: expireMark, RES_TEST_POOL_REJECT: 'expire', RES_TEST_POOL_CHECK_LOG: expireLog });
    await until(() => fs.existsSync(expireMark), head);
    const next = start('expire-next', { PAUSE_MARK: expireNextMark });
    await until(() => fs.existsSync(expireNextMark) && waiters().length === 2, next);
    release('devbox-cn-1'); unblock(expireMark);
    eq(await head.done, 0, head.text); eq(owner('devbox-cn-1'), 'expire-head');
    eq(fs.readFileSync(expireLog, 'utf8').trim().split('\n'), ['devbox-cn-1']);
    ok(!fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('\treturn\tdevbox-cn-1\texpire-head\t'));
    release('devbox-cn-1', 'expire-head'); unblock(expireNextMark);
    eq(await next.done, 0, next.text); eq(owner('devbox-cn-1'), 'expire-next'); release('devbox-cn-1', 'expire-next');
    for (const id of ids.slice(1)) release(id);

    for (const id of ids) take(id);
    const rollbackMark = path.join(root, 'rollback-head'), nextMark = path.join(root, 'rollback-next'), rollbackRetry = path.join(root, 'rollback-retry');
    const rollbackLog = path.join(root, 'rollback-checks');
    const failing = start('rollback-head', { PAUSE_MARK: rollbackMark, SECOND_MARK: rollbackRetry,
      RES_TEST_POOL_REJECT: 'all', RES_TEST_POOL_CHECK_LOG: rollbackLog });
    await until(() => fs.existsSync(rollbackMark), failing);
    const successor = start('rollback-next', { PAUSE_MARK: nextMark });
    await until(() => fs.existsSync(nextMark) && waiters().length === 2, successor);
    const originalStart = field(waiters().find(dir => field(dir, 'holder') === 'rollback-head'), 'start');
    for (const id of ids) release(id);
    unblock(rollbackMark); await until(() => fs.existsSync(rollbackRetry), failing);
    eq(fs.readFileSync(rollbackLog, 'utf8').trim().split('\n').length, 3);
    ok(failing.text.includes('yielding pool')); eq(locks(), []);
    eq(field(waiters().find(dir => field(dir, 'holder') === 'rollback-head'), 'start'), originalStart);
    const queued = waiters().sort((a, b) => field(a, 'order').localeCompare(field(b, 'order')));
    eq(field(queued[0], 'holder'), 'rollback-next');
    unblock(nextMark); eq(await successor.done, 0, successor.text); eq(owner('devbox-cn-1'), 'rollback-next');
    eq(fs.readFileSync(rollbackLog, 'utf8').trim().split('\n').length, 3);
    failing.kill('SIGTERM'); unblock(rollbackRetry); eq(await failing.done, 143); eq(waiters(), []);
    release('devbox-cn-1', 'rollback-next');
    ok(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('\twaiter-yield\tdevbox-cn-any\trollback-head (rollback-head/fixture)\trollbacks=3'));
  }
  count += testPoolIdentity({ source: process.env.RES_SOURCE, root: path.join(root, 'identity') });
  count += await testPoolSurplus({ source: process.env.RES_SOURCE, root: path.join(root, 'surplus') });
  console.log(`ALL ${count} ASSERTIONS PASSED`);
} finally {
  // Release fixture pause hooks before signalling their parents on failure.
  for (const name of fs.readdirSync(root).filter(n => !n.endsWith('.release'))) {
    if (fs.statSync(path.join(root, name)).isFile()) unblock(path.join(root, name));
  }
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map(child => child.done));
}
