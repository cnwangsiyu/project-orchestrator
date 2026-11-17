#!/usr/bin/env node
// Deterministic build-waiter fairness scenarios; all state is scratch-owned.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.join(process.env.RES_TEST_ROOT, 'fairness');
const state = path.join(root, 'scratch'), mocks = path.join(root, 'mocks');
const res = process.env.RES_SOURCE;
fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
fs.mkdirSync(mocks, { recursive: true });
fs.writeFileSync(path.join(state, 'resources.tsv'),
  ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3']
    .map((id) => `${id}\tslot\topen\t-\tscratch ${id}`).join('\n') + '\n');
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
for (const command of ['idevice_id', 'adb', 'xcrun'])
  fs.writeFileSync(path.join(mocks, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'sleep'), `#!/bin/sh
if [ "\${PAUSE_BUILD_RETRY:-0}" = 1 ] && [ "$1" = 1 ]; then
  touch "${root}/build-retry-paused"
  while [ ! -f "${root}/release-build-retry" ]; do /bin/sleep 0.02; done
fi
exec /bin/sleep 0.05
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'mktemp'), `#!/bin/bash
if [ "\${PAUSE_WAITER_MKTEMP:-0}" = 1 ] && [[ "$*" = *'/build-waiters/.staging.'* ]]; then
  target=$(/usr/bin/mktemp "$@") || exit $?
  touch "${root}/staging-created"
  while [ ! -f "${root}/release-staging" ]; do /bin/sleep 0.02; done
  printf '%s\\n' "$target"
  exit 0
fi
exec /usr/bin/mktemp "$@"
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'ps'), `#!/bin/bash
if [ "$1" = -p ]; then kill -0 "$2" 2>/dev/null || exit 1; echo "$2"; exit 0; fi
if [ "$*" = '-axo pid=' ]; then
  for info in "$RES_DIR"/locks/*.d/info "$RES_DIR"/build-waiters/waiter.*/info; do
    [ -f "$info" ] || continue
    pid=$(/usr/bin/awk -F '\\t' '$1=="pid"{print $2}' "$info")
    kill -0 "$pid" 2>/dev/null && echo "$pid"
  done
  exit 0
fi
exit 2
`, { mode: 0o755 });

const baseEnv = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`,
  RES_TEST_METRICS: '1', RES_TEST_LOAD1M: '9', RES_TEST_MEMORYSTATUS_LEVEL: '50',
  RES_TEST_MEMSIZE: '68719476736', RES_TEST_SWAPUSAGE: 'used = 0M',
  RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.' };
const argv = (by, purpose = 'fairness') => ['--by', by, '--project', 'scratch', '--for', purpose, '--task', by];
const lock = (id) => path.join(state, 'locks', `${id}.d`);
const waiters = () => fs.existsSync(path.join(state, 'build-waiters'))
  ? fs.readdirSync(path.join(state, 'build-waiters')).filter((name) => name.startsWith('waiter.')) : [];
const stagedWaiters = () => fs.existsSync(path.join(state, 'build-waiters'))
  ? fs.readdirSync(path.join(state, 'build-waiters')).filter((name) => name.startsWith('.staging.')) : [];
const field = (id, key) => {
  const file = path.join(lock(id), 'info');
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}\\t(.*)$`, 'm'))?.[1];
};
const waiterField = (name, key) => {
  const file = path.join(state, 'build-waiters', name, 'info');
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}\\t(.*)$`, 'm'))?.[1];
};
let count = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); count++; };
const ok = (a, message) => { assert.ok(a, message); count++; };
function run(args, extra = {}) {
  const r = spawnSync(res, args, { env: { ...baseEnv, ...extra }, encoding: 'utf8', timeout: 30000 });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout}${r.stderr}`, out: r.stdout, err: r.stderr };
}
const children = new Set();
function start(args, extra = {}) {
  const child = spawn(res, args, { env: { ...baseEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.text = '';
  child.stdout.on('data', (b) => { child.text += b; });
  child.stderr.on('data', (b) => { child.text += b; });
  child.done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  children.add(child); return child;
}
async function until(predicate, message, child) {
  const deadline = Date.now() + 60000;
  while (!predicate()) {
    if (Date.now() >= deadline || (child && !children.has(child))) throw Error(`${message}: ${child?.text ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function stop(child, signal) {
  child.kill(signal); return child.done;
}
function take(id, by) { const r = run(['take', id, ...argv(by)]); eq(r.code, 0, r.text); }
function release(id, by) { eq(run(['return', id, '--by', by]).code, 0); }
function releaseBuild(by) { eq(run(['return-build', '--by', by]).code, 0); }
function manualWaiter(name, { holder, pid, heartbeat, host = os.hostname(), order = '00000000000000000001', gate = 0 }) {
  const dir = path.join(state, 'build-waiters', `waiter.${name}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'info'), `holder\t${holder}\nproject\tscratch\ntask\t${holder}\npid\t${pid}\nhost\t${host}\nsince\tnow\nstart\t1\norder\t${order}\nheartbeat\t${heartbeat}\nblocked\tlane\ngate_streak\t${gate}\nlane\t\nlane3\tCLOSED\n`);
}

try {
  // A status cleanup during mktemp cannot see or remove an incomplete waiter.
  take('heavy-lane-1', 'publish-1'); take('heavy-lane-2', 'publish-2');
  const publishing = start(['wait-build', ...argv('publishing'), '--timeout', '1'], { PAUSE_WAITER_MKTEMP: '1' });
  await until(() => fs.existsSync(path.join(root, 'staging-created')), 'waiter staging was not created', publishing);
  const publishingStatus = run(['status', 'heavy-build']); eq(publishingStatus.code, 0, publishingStatus.text);
  eq(waiters(), []); eq(stagedWaiters().length, 1);
  fs.writeFileSync(path.join(root, 'release-staging'), 'release\n');
  await until(() => waiters().length === 1 && publishing.text.includes('retry in'), 'staged waiter was not published', publishing);
  eq(stagedWaiters(), []); eq((await stop(publishing, 'SIGTERM')).code, 143); eq(waiters(), []);
  release('heavy-lane-1', 'publish-1'); release('heavy-lane-2', 'publish-2');

  // Reproduce lane churn: the first returned normal lane stays reserved and the
  // waiting build acquires it before another short lane-only task can retake it.
  take('heavy-lane-1', 'churn-1'); take('heavy-lane-2', 'churn-2');
  // Check reservation while the build is waiting, rather than racing its next
  // pair attempt's temporarily incomplete heavy-build metadata. Incomplete
  // foreign holds have a separate no-reservation assertion below.
  const starved = start(['wait-build', ...argv('oldest'), '--timeout', '1'], { PAUSE_BUILD_RETRY: '1' });
  await until(() => waiters().length === 1 && starved.text.includes('retry in 1s')
    && fs.existsSync(path.join(root,'build-retry-paused')), 'waiter was not published and paused', starved);
  const status = run(['status', 'heavy-build']);
  ok(status.text.includes('Waiting builds:') && status.text.includes('oldest') && status.text.includes('lane'), status.text);
  release('heavy-lane-1', 'churn-1');
  const churn = run(['take', 'heavy-lane-1', ...argv('short-task')]);
  eq(churn.code, 2); ok(churn.text.includes('reserved for waiting build oldest; retry or use wait-lane'), churn.text);
  fs.writeFileSync(path.join(root,'release-build-retry'),'release\n');
  await until(() => fs.existsSync(lock('heavy-build')) && field('heavy-build', 'by') === 'oldest',
    'oldest waiter did not acquire first return', starved);
  eq((await starved.done).code, 0); eq(field('heavy-lane-1', 'by'), 'oldest'); eq(waiters(), []);
  releaseBuild('oldest'); release('heavy-lane-2', 'churn-2');
  const log = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
  ok(log.includes('\twaiter-start\theavy-build\toldest ')); ok(log.includes('\twaiter-acquire\theavy-build\toldest '));

  // Dead and stale-heartbeat records cannot reserve a lane and are cleaned.
  take('heavy-lane-2', 'occupied');
  manualWaiter('dead', { holder: 'dead', pid: 2147483647, heartbeat: Math.floor(Date.now() / 1000) });
  const deadIgnored = run(['take', 'heavy-lane-1', ...argv('after-dead')]); eq(deadIgnored.code, 0, deadIgnored.text);
  eq(waiters(), []); release('heavy-lane-1', 'after-dead');
  manualWaiter('stale', { holder: 'stale', pid: process.pid, heartbeat: Math.floor(Date.now() / 1000) - 46 });
  const staleIgnored = run(['take', 'heavy-lane-1', ...argv('after-stale')]); eq(staleIgnored.code, 0, staleIgnored.text);
  eq(waiters(), []); release('heavy-lane-1', 'after-stale'); release('heavy-lane-2', 'occupied');

  // A fresh remote-host waiter lives by heartbeat, never the local PID table.
  take('heavy-lane-2', 'remote-occupied');
  manualWaiter('remote', { holder: 'remote', pid: 2147483647, host: 'remote-host', heartbeat: Math.floor(Date.now() / 1000) });
  const remoteReserved = run(['take', 'heavy-lane-1', ...argv('remote-contender')]);
  eq(remoteReserved.code, 2); ok(remoteReserved.text.includes('reserved for waiting build remote'), remoteReserved.text);
  eq(waiters(), ['waiter.remote']);
  const remoteInfo = path.join(state, 'build-waiters', 'waiter.remote', 'info');
  fs.writeFileSync(remoteInfo, fs.readFileSync(remoteInfo, 'utf8').replace(/^heartbeat\t.*$/m, `heartbeat\t${Math.floor(Date.now() / 1000) - 46}`));
  const remoteExpired = run(['take', 'heavy-lane-1', ...argv('after-remote-expiry')]); eq(remoteExpired.code, 0, remoteExpired.text);
  eq(waiters(), []); release('heavy-lane-1', 'after-remote-expiry'); release('heavy-lane-2', 'remote-occupied');

  // An incomplete non-stale build hold suspends reservation by default.
  take('heavy-lane-2', 'legacy-occupied');
  manualWaiter('slot-blocked', { holder: 'slot-blocked', pid: process.pid, heartbeat: Math.floor(Date.now() / 1000) });
  fs.mkdirSync(lock('heavy-build')); fs.writeFileSync(path.join(lock('heavy-build'), 'info'), 'by\tlegacy-build\n');
  const besideLegacyBuild = run(['take', 'heavy-lane-1', ...argv('beside-legacy-build')]); eq(besideLegacyBuild.code, 0, besideLegacyBuild.text);
  eq(waiters(), ['waiter.slot-blocked']);
  release('heavy-lane-1', 'beside-legacy-build'); fs.rmSync(lock('heavy-build'), { recursive: true });
  fs.rmSync(path.join(state, 'build-waiters', 'waiter.slot-blocked'), { recursive: true });
  release('heavy-lane-2', 'legacy-occupied');

  // Three consecutive gate-blocked polls suspend reservation until the gate can pass.
  take('heavy-lane-2', 'gate-occupant');
  const gated = start(['wait-build', ...argv('gated'), '--timeout', '1'], { RES_TEST_LOAD1M: '21' });
  await until(() => waiters().length === 1 && Number(waiterField(waiters()[0], 'gate_streak')) >= 3,
    'waiter did not reach three gate-blocked polls', gated);
  const whileGated = run(['take', 'heavy-lane-1', ...argv('gate-bypass')]); eq(whileGated.code, 0, whileGated.text);
  release('heavy-lane-1', 'gate-bypass');
  eq((await stop(gated, 'SIGTERM')).code, 143); eq(waiters(), []); release('heavy-lane-2', 'gate-occupant');

  // Multiple build waiters are FIFO even when the younger one polls first.
  take('heavy-lane-1', 'fifo-1'); take('heavy-lane-2', 'fifo-2');
  const first = start(['wait-build', ...argv('first'), '--timeout', '1']);
  await until(() => waiters().length === 1, 'first FIFO waiter missing', first);
  const second = start(['wait-build', ...argv('second'), '--timeout', '1']);
  await until(() => waiters().length === 2, 'second FIFO waiter missing', second);
  release('heavy-lane-1', 'fifo-1');
  await until(() => fs.existsSync(lock('heavy-build')) && field('heavy-build', 'by') === 'first', 'FIFO first did not acquire', first);
  eq((await first.done).code, 0); releaseBuild('first');
  await until(() => fs.existsSync(lock('heavy-build')) && field('heavy-build', 'by') === 'second', 'FIFO second did not acquire', second);
  eq((await second.done).code, 0); releaseBuild('second'); release('heavy-lane-2', 'fifo-2'); eq(waiters(), []);

  // A live waiter whose record was swept (slow pass > heartbeat) re-publishes with its original order.
  take('heavy-lane-1', 'rejoin-1'); take('heavy-lane-2', 'rejoin-2');
  const rejoining = start(['wait-build', ...argv('rejoin'), '--timeout', '1']);
  await until(() => waiters().length === 1 && rejoining.text.includes('retry in'), 'rejoin waiter missing', rejoining);
  const swept = waiters()[0], order = waiterField(swept, 'order');
  fs.rmSync(path.join(state, 'build-waiters', swept), { recursive: true, force: true });
  await until(() => waiters().length === 1, 'swept waiter did not re-publish', rejoining);
  eq(waiters()[0], swept); eq(waiterField(waiters()[0], 'order'), order);
  await until(() => fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('\twaiter-rejoin\theavy-build\t'),
    'waiter-rejoin not logged', rejoining);
  eq((await stop(rejoining, 'SIGTERM')).code, 143); eq(waiters(), []);
  release('heavy-lane-1', 'rejoin-1'); release('heavy-lane-2', 'rejoin-2');

  // INT, TERM and timeout all remove the published record.
  take('heavy-lane-1', 'signals-1'); take('heavy-lane-2', 'signals-2');
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const child = start(['wait-build', ...argv(signal), '--timeout', '1']);
    await until(() => waiters().length === 1 && child.text.includes('retry in'), `${signal} waiter missing`, child);
    eq((await stop(child, signal)).code, code); eq(waiters(), []);
  }
  const timed = run(['wait-build', ...argv('timeout'), '--timeout', '0']);
  eq(timed.code, 2); eq(waiters(), []);
  const takeWaitTimed = run(['take-build', '--wait', ...argv('take-wait-timeout'), '--timeout', '0']);
  eq(takeWaitTimed.code, 2); eq(waiters(), []);
  ok(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('\twaiter-timeout\theavy-build\ttimeout '));
  release('heavy-lane-1', 'signals-1'); release('heavy-lane-2', 'signals-2');
} finally {
  for (const child of children) child.kill('SIGKILL');
}

console.log(`ALL ${count} ASSERTIONS PASSED`);
