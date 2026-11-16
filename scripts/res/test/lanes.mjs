#!/usr/bin/env node
// Lane starvation, FIFO, gate suspension and build priority, using scratch holds only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.join(process.env.RES_TEST_ROOT, 'lanes');
const state = path.join(root, 'state'), mocks = path.join(root, 'mocks');
fs.mkdirSync(path.join(state, 'locks'), { recursive: true }); fs.mkdirSync(mocks, { recursive: true });
fs.writeFileSync(path.join(state, 'resources.tsv'), ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3']
  .map((id) => `${id}\tslot\topen\t-\tfixture`).join('\n') + '\n');
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
for (const command of ['adb', 'idevice_id', 'xcrun']) fs.writeFileSync(path.join(mocks, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'ps'), `#!/bin/sh
case "$*" in
  '-p '*) kill -0 "$2" 2>/dev/null || exit 1; echo "$2";;
  '-axo pid=') echo "$PPID";;
  *) exit 2;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'sleep'), `#!/bin/sh
if [ -n "\${PAUSE_MARK:-}" ] && [ "$1" = 1 ]; then
  touch "$PAUSE_MARK"
  while [ ! -f "$PAUSE_MARK.release" ]; do /bin/sleep 0.02; done
fi
if [ -n "\${PAUSE_ON_SECOND:-}" ] && [ "$1" = 2 ]; then
  touch "$PAUSE_ON_SECOND"
  while [ ! -f "$PAUSE_ON_SECOND.release" ]; do /bin/sleep 0.02; done
fi
exec /bin/sleep 0.03
`, { mode: 0o755 });
const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`, RES_TEST_METRICS: '1',
  RES_TEST_LOAD1M: '8', RES_TEST_MEMORYSTATUS_LEVEL: '50', RES_TEST_MEMSIZE: '68719476736',
  RES_TEST_SWAPUSAGE: 'used = 0M', RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.' };
const args = (by, project) => ['--by', by, '--project', project, '--for', 'fixture', '--pid', String(process.pid)];
const lock = (id) => path.join(state, 'locks', `${id}.d`);
const field = (file, key) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}\\t(.*)$`, 'm'))?.[1] : undefined;
const holder = (id) => field(path.join(lock(id), 'info'), 'by');
const waiterDirs = (kind = 'lane') => fs.existsSync(path.join(state, `${kind}-waiters`))
  ? fs.readdirSync(path.join(state, `${kind}-waiters`)).filter((name) => name.startsWith('waiter.')).map((name) => path.join(state, `${kind}-waiters`, name)) : [];
let count = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); count++; };
const ok = (a, msg) => { assert.ok(a, msg); count++; };
const run = (argv, extra = {}) => {
  const r = spawnSync(process.env.RES_SOURCE, argv, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
};
const take = (id, by, project = 'A') => { const r = run(['take', id, ...args(by, project)]); eq(r.code, 0, r.text); };
const release = (id, by) => eq(run(['return', id, '--by', by]).code, 0);
const children = new Set();
function start(command, by, project, extra = {}) {
  const child = spawn(process.env.RES_SOURCE, [command, ...args(by, project), '--timeout', '1'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.text = ''; child.stdout.on('data', (b) => { child.text += b; }); child.stderr.on('data', (b) => { child.text += b; });
  child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => { children.delete(child); resolve(code); }); });
  children.add(child); return child;
}
async function until(predicate, child) {
  const deadline = Date.now() + 60000;
  while (!predicate()) {
    if (Date.now() > deadline || child && !children.has(child)) throw Error(`scenario did not reach expected state: ${child?.text ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function stop(child, signal = 'SIGTERM') { child.kill(signal); eq(await child.done, { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }[signal]); }
function manual(name, project, { gate = 0, pid = process.pid, heartbeat = Math.floor(Date.now() / 1000), host = os.hostname(), kind = 'lane', order = '00000000000000000001' } = {}) {
  const dir = path.join(state, `${kind}-waiters`, `waiter.${name}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'info'), `holder\t${name}\nproject\t${project}\ntask\tfixture\npid\t${pid}\nhost\t${host}\nsince\tnow\nstart\t1\norder\t${order}\nheartbeat\t${heartbeat}\nblocked\tlane\ngate_streak\t${gate}\nlane\t\nlane3\tOPEN\n`);
  return dir;
}

try {
  // With no waiter a single project may use all lanes, including the optional one.
  for (const [id, by] of [['heavy-lane-1', 'A1'], ['heavy-lane-2', 'A2'], ['heavy-lane-3', 'A3']]) take(id, by);
  const pause = path.join(root, 'B-paused');
  const waiting = start('wait-lane', 'B1', 'B', { PAUSE_MARK: pause });
  await until(() => waiterDirs().length === 1 && fs.existsSync(pause), waiting);
  const info = fs.readFileSync(path.join(waiterDirs()[0], 'info'), 'utf8');
  for (const key of ['holder', 'project', 'task', 'pid', 'host', 'start', 'order', 'heartbeat', 'gate_streak']) ok(info.includes(`${key}\t`));
  ok(run(['status', 'heavy-lane-1']).text.includes('Waiting lanes:'));
  release('heavy-lane-3', 'A3');
  let denied = run(['take', 'heavy-lane-3', ...args('A-again', 'A')]);
  eq(denied.code, 2); ok(denied.text.includes("project 'A' already holds a lane")); eq(fs.existsSync(lock('heavy-lane-3')), false);
  fs.writeFileSync(`${pause}.release`, 'go'); eq(await waiting.done, 0); eq(holder('heavy-lane-3'), 'B1'); eq(waiterDirs(), []);
  const log = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8');
  ok(log.includes('\twaiter-start\theavy-lane-any\tB1 ')); ok(log.includes('\twaiter-acquire\theavy-lane-any\tB1 '));
  release('heavy-lane-3', 'B1'); take('heavy-lane-3', 'A3');
  for (const [id, by] of [['heavy-lane-1', 'A1'], ['heavy-lane-2', 'A2'], ['heavy-lane-3', 'A3']]) release(id, by);

  // Dead, expired and gate-blocked records cannot reserve or cap a project.
  take('heavy-lane-1', 'anchor');
  for (const [name, extra] of [['dead', { pid: 2147483647 }], ['expired', { heartbeat: Math.floor(Date.now() / 1000) - 46 }], ['gated', { gate: 3 }]]) {
    const dir = manual(name, 'B', extra); take('heavy-lane-2', 'uncapped'); release('heavy-lane-2', 'uncapped');
    if (name === 'gated') fs.rmSync(dir, { recursive: true }); else eq(waiterDirs(), []);
  }
  const remote = manual('remote', 'B', { host: 'remote-host', pid: 2147483647 });
  eq(run(['take', 'heavy-lane-2', ...args('remote-cap', 'A')]).code, 2); fs.rmSync(remote, { recursive: true });
  release('heavy-lane-1', 'anchor');

  // A capped older project yields FIFO position; it cannot block a project with no lane.
  take('heavy-lane-1', 'cap-anchor', 'A');
  const capped = manual('older-A', 'A');
  const younger = start('wait-lane', 'younger-B', 'B'); eq(await younger.done, 0);
  eq(holder('heavy-lane-2'), 'younger-B'); release('heavy-lane-2', 'younger-B'); fs.rmSync(capped, { recursive: true }); release('heavy-lane-1', 'cap-anchor');

  // Review #1: A and B already hold lanes. Returning C's lane must let the
  // oldest ready waiter use it, even while B's younger waiter also waits.
  take('heavy-lane-1', 'cycle-A1', 'A'); take('heavy-lane-2', 'cycle-B1', 'B'); take('heavy-lane-3', 'cycle-C1', 'C');
  const cycleA = path.join(root, 'cycle-A-paused'), cycleB = path.join(root, 'cycle-B-paused');
  const cycleRetry = path.join(root, 'cycle-younger-paused');
  const a2 = start('wait-lane', 'cycle-A2', 'A', { PAUSE_MARK: cycleA });
  await until(() => fs.existsSync(cycleA), a2);
  const b2 = start('wait-lane', 'cycle-B2', 'B', { PAUSE_MARK: cycleB, PAUSE_ON_SECOND: cycleRetry });
  await until(() => fs.existsSync(cycleB), b2);
  release('heavy-lane-3', 'cycle-C1'); fs.writeFileSync(`${cycleB}.release`, 'go');
  await until(() => fs.existsSync(cycleRetry), b2);
  ok(b2.text.includes('FIFO')); eq(fs.existsSync(lock('heavy-lane-3')), false);
  fs.writeFileSync(`${cycleA}.release`, 'go'); eq(await a2.done, 0); eq(holder('heavy-lane-3'), 'cycle-A2');
  eq(holder('heavy-lane-1'), 'cycle-A1'); eq(holder('heavy-lane-2'), 'cycle-B1');
  fs.writeFileSync(`${cycleRetry}.release`, 'go'); await stop(b2);
  release('heavy-lane-3', 'cycle-A2'); release('heavy-lane-1', 'cycle-A1'); release('heavy-lane-2', 'cycle-B1'); eq(waiterDirs(), []);

  // FIFO even when the younger waiter runs first after a return.
  for (const [id, by] of [['heavy-lane-1', 'F1'], ['heavy-lane-2', 'F2'], ['heavy-lane-3', 'F3']]) take(id, by, 'F');
  const firstPause = path.join(root, 'first-paused');
  const first = start('wait-lane', 'first', 'B', { PAUSE_MARK: firstPause });
  await until(() => fs.existsSync(firstPause), first);
  const secondPause = path.join(root, 'second-paused'), fifoPause = path.join(root, 'fifo-paused');
  const second = start('wait-lane', 'second', 'C', { PAUSE_MARK: secondPause, PAUSE_ON_SECOND: fifoPause });
  await until(() => waiterDirs().length === 2 && fs.existsSync(secondPause), second);
  release('heavy-lane-1', 'F1');
  fs.writeFileSync(`${secondPause}.release`, 'go');
  await until(() => fs.existsSync(fifoPause), second); ok(second.text.includes('FIFO')); eq(fs.existsSync(lock('heavy-lane-1')), false);
  denied = run(['take', 'heavy-lane-1', ...args('non-waiter', 'D')]); eq(denied.code, 2); ok(denied.text.includes('reserved for waiting lane first'));
  fs.writeFileSync(`${firstPause}.release`, 'go'); eq(await first.done, 0); eq(holder('heavy-lane-1'), 'first');
  release('heavy-lane-1', 'first'); fs.writeFileSync(`${fifoPause}.release`, 'go');
  eq(await second.done, 0); eq(holder('heavy-lane-1'), 'second'); release('heavy-lane-1', 'second');
  release('heavy-lane-2', 'F2'); release('heavy-lane-3', 'F3'); eq(waiterDirs(), []);

  // Real gate-blocked polls reach the suspension threshold, then clean on every signal.
  take('heavy-lane-1', 'gate-anchor');
  const gated = start('wait-lane', 'gated-live', 'B', { RES_TEST_LOAD1M: '21' });
  await until(() => waiterDirs().some((dir) => Number(field(path.join(dir, 'info'), 'gate_streak')) >= 3), gated);
  take('heavy-lane-2', 'gate-pass'); release('heavy-lane-2', 'gate-pass');
  fs.writeFileSync(path.join(state, 'machine.conf.next'), 'LOAD_LIMIT=30\nLOAD_LIMIT_WITH_LANES=30\n');
  fs.renameSync(path.join(state, 'machine.conf.next'), path.join(state, 'machine.conf'));
  eq(await gated.done, 0); eq(waiterDirs(), []); eq(holder('heavy-lane-2'), 'gated-live'); release('heavy-lane-2', 'gated-live');
  fs.rmSync(path.join(state, 'machine.conf'));
  release('heavy-lane-1', 'gate-anchor');

  // The existing oldest blocking build retains priority over an older lane queue.
  take('heavy-lane-1', 'P1', 'P'); take('heavy-lane-2', 'P2', 'P'); take('heavy-lane-3', 'P3', 'P');
  const lanePause = path.join(root, 'priority-lane');
  const laneWaiting = start('wait-lane', 'lane-head', 'L', { PAUSE_MARK: lanePause }); await until(() => fs.existsSync(lanePause), laneWaiting);
  const buildWaiting = start('wait-build', 'build-head', 'P'); await until(() => waiterDirs('build').length === 1 && buildWaiting.text.includes('retry in'), buildWaiting);
  release('heavy-lane-1', 'P1'); eq(await buildWaiting.done, 0); eq(holder('heavy-lane-1'), 'build-head'); eq(holder('heavy-build'), 'build-head');
  eq(run(['return-build', '--by', 'build-head']).code, 0);
  fs.writeFileSync(`${lanePause}.release`, 'go'); eq(await laneWaiting.done, 0); release('heavy-lane-1', 'lane-head');
  release('heavy-lane-2', 'P2'); release('heavy-lane-3', 'P3');

  for (const [id, by] of [['heavy-lane-1', 'S1'], ['heavy-lane-2', 'S2'], ['heavy-lane-3', 'S3']]) take(id, by);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const child = start('wait-lane', signal, 'B'); await until(() => waiterDirs().length === 1 && child.text.includes('retry in'), child);
    await stop(child, signal); eq(waiterDirs(), []);
  }
  eq(run(['wait-lane', ...args('timeout', 'B'), '--timeout', '0']).code, 2); eq(waiterDirs(), []);
  ok(fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').includes('\twaiter-timeout\theavy-lane-any\ttimeout '));
  for (const [id, by] of [['heavy-lane-1', 'S1'], ['heavy-lane-2', 'S2'], ['heavy-lane-3', 'S3']]) release(id, by);
  const same = run(['wait-lane', ...args('same', 'B'), '--timeout', '0']); eq(same.code, 0);
  const sameInfo = fs.readFileSync(path.join(lock('heavy-lane-1'), 'info'), 'utf8');
  eq(run(['wait-lane', ...args('same', 'B'), '--timeout', '0']).code, 0); eq(waiterDirs(), []);
  eq(fs.readFileSync(path.join(lock('heavy-lane-1'), 'info'), 'utf8'), sameInfo); release('heavy-lane-1', 'same');
} finally {
  // Release paused helpers before stopping their owned controllers.
  for (const name of fs.readdirSync(root)) if (name.includes('paused') || name === 'priority-lane') fs.writeFileSync(path.join(root, `${name}.release`), 'cleanup');
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map((child) => child.done));
}
console.log(`ALL ${count} ASSERTIONS PASSED`);
