#!/usr/bin/env node
// Replay the T87 incident using scratch locks, metrics and owned subprocesses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { observeWaiters, parseHeavyStatus } from '../../lib/resource-locks.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.env.RES_TEST_ROOT, 'build');
const state = path.join(root, 'scratch'), mocks = path.join(root, 'mocks');
const res = process.env.RES_SOURCE, wrapper = path.resolve(base, '../../heavy-build.sh');
const ids = ['heavy-build', 'heavy-lane-1', 'heavy-lane-2', 'heavy-lane-3'];
fs.mkdirSync(path.join(state, 'locks'), { recursive: true }); fs.mkdirSync(mocks, { recursive: true });
const registry = ids.map((id) => `${id}\tslot\topen\t-\tscratch ${id}`).join('\n') + '\n';
fs.writeFileSync(path.join(state, 'resources.tsv'), registry);
fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'date'), `#!/bin/bash
if [ "\${BLOCK_ON_LANE:-0}" = 1 ] && [ -d "$RES_DIR/locks/heavy-lane-1.d" ] && [ ! -f "$RES_TEST_ROOT/build/mid-acquisition" ]; then
  touch "$RES_TEST_ROOT/build/mid-acquisition"
  sleep 30
fi
exec /bin/date "$@"
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'mkdir'), `#!/bin/bash
if [ "\${RACE_LANE:-0}" = 1 ] && [[ "$*" = *'/heavy-lane-1.d' ]] && [ ! -f "$RES_TEST_ROOT/build/lane-race" ]; then
  touch "$RES_TEST_ROOT/build/lane-race"
  while [ ! -f "$RES_TEST_ROOT/build/lane-race-release" ]; do sleep 0.02; done
fi
/bin/mkdir "$@" || exit $?
if [ "\${BLOCK_ON_MKDIR:-0}" = 1 ] && [[ "$*" = *'/heavy-build.d' ]]; then
  touch "$RES_TEST_ROOT/build/mid-mkdir"
  sleep 0.5
fi
`, { mode: 0o755 });
const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`,
  RES_TEST_METRICS: '1', RES_TEST_LOAD1M: '8', RES_TEST_MEMORYSTATUS_LEVEL: '50',
  RES_TEST_MEMSIZE: '68719476736', RES_TEST_SWAPUSAGE: 'used = 0M',
  RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.' };
let count = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); count++; };
const ok = (a, message) => { assert.ok(a, message); count++; };
const run = (args, extra = {}, exe = res) => {
  const r = spawnSync(exe, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr, text: `${r.stdout}${r.stderr}` };
};
const args = (by = 'builder') => ['--by', by, '--project', 'scratch', '--for', 'incident replay', '--task', 'T87'];
const lock = (id) => path.join(state, 'locks', `${id}.d`);
const info = (id) => fs.readFileSync(path.join(lock(id), 'info'), 'utf8');
const field = (id, key) => info(id).match(new RegExp(`^${key}\\t(.*)$`, 'm'))?.[1];
const held = () => ids.filter((id) => fs.existsSync(lock(id)));
const release = (id, by = 'blocker') => eq(run(['return', id, '--by', by]).code, 0);
const pairRelease = (by = 'builder') => eq(run(['return-build', '--by', by]).code, 0);
const occupy = (id) => eq(run(['take', id, ...args('blocker')]).code, 0);
const children = new Set();
function start(exe, argv, extra = {}) {
  const child = spawn(exe, argv, { env: { ...env, ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.text = '';
  child.stdout.on('data', (b) => { child.text += b; }); child.stderr.on('data', (b) => { child.text += b; });
  child.done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  children.add(child); return child;
}
async function until(predicate, message, child) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline || (child && !children.has(child))) throw Error(`${message}: ${child?.text ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function stop(child, signal = 'SIGTERM', group = true) {
  if (!children.has(child)) return child.done;
  if (group) process.kill(-child.pid, signal); else child.kill(signal);
  let timer;
  try {
    return await Promise.race([child.done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`child did not stop: ${child.text}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
const wrapperEnv = { RES_COMMAND: res, HEAVY_BUILD_BY: 'wrapped', HEAVY_BUILD_PROJECT: 'scratch',
  HEAVY_BUILD_TASK: 'T87', HEAVY_BUILD_TIMEOUT: '0.2', HEAVY_BUILD_LANE: '' };
const wrapped = (command = ['/bin/sh', '-c', 'exit 7'], extra = {}) => start('/bin/bash', [wrapper, ...command], { ...wrapperEnv, ...extra });

try {
  // Pinned incident: lane 2 belongs to another task; no build hold during backoff.
  occupy('heavy-lane-2'); const originalLane2 = info('heavy-lane-2');
  const pinned = start(res, ['wait-build', ...args(), '--lane', 'heavy-lane-2', '--timeout', '0.1']);
  await until(() => pinned.text.includes('retry in 1s'), 'pinned build did not retry', pinned);
  eq(held(), ['heavy-lane-2']);
  eq(run(['take', 'heavy-build', ...args('unrelated')]).code, 0); release('heavy-build', 'unrelated');
  eq((await pinned.done).code, 2); eq(held(), ['heavy-lane-2']); eq(info('heavy-lane-2'), originalLane2);
  // Default selection immediately finds lane 1 and reports it for reverse return.
  const free = run(['take-build', ...args()]); eq(free.code, 0, free.text);
  ok(free.out.includes('build-lane=heavy-lane-1')); eq(held(), ['heavy-build', 'heavy-lane-1', 'heavy-lane-2']);
  eq(field('heavy-build', 'pid'), String(process.pid)); eq(field('heavy-lane-1', 'task'), 'T87');
  pairRelease(); eq(info('heavy-lane-2'), originalLane2);
  const journal = fs.readFileSync(path.join(state, 'log.tsv'), 'utf8').trim().split('\n').map((s) => s.split('\t'));
  eq(journal.filter((r) => r[1] === 'return' && r[3] === 'builder').map((r) => r[2]), ['heavy-lane-1', 'heavy-build']);
  // Wrapper pin preserves the same no-hold backoff; default reaches the free lane.
  const pinWrapper = wrapped(undefined, { HEAVY_BUILD_LANE: 'heavy-lane-2', HEAVY_BUILD_TIMEOUT: '0.1' });
  await until(() => pinWrapper.text.includes('retry in 1s'), 'wrapper pin did not retry', pinWrapper);
  eq(held(), ['heavy-lane-2']); eq((await pinWrapper.done).code, 2); eq(held(), ['heavy-lane-2']);
  const freeWrapper = wrapped(); eq((await freeWrapper.done).code, 7, freeWrapper.text);
  ok(freeWrapper.text.includes('took heavy-lane-1')); eq(held(), ['heavy-lane-2']); release('heavy-lane-2');
  // Slot occupied: a competing builder must leave every lane free.
  occupy('heavy-build'); eq(run(['take-build', ...args()]).code, 2); eq(held(), ['heavy-build']); release('heavy-build');
  // All lanes occupied or lane 3 closed: acquire nothing, including with zero timeout.
  occupy('heavy-lane-1'); occupy('heavy-lane-2');
  eq(run(['wait-build', ...args(), '--timeout', '0'], { RES_TEST_LOAD1M: '9' }).code, 2);
  eq(held(), ['heavy-lane-1', 'heavy-lane-2']);
  const third = run(['take-build', ...args()]); eq(third.code, 0); ok(third.out.includes('build-lane=heavy-lane-3'));
  pairRelease(); occupy('heavy-lane-3');
  eq(run(['take-build', ...args()]).code, 2); eq(held(), ids.slice(1));
  for (const id of ids.slice(1)) release(id);
  // wait-lane selects the next free lane without acquiring the full-build slot.
  occupy('heavy-lane-1'); const second = run(['wait-lane', ...args(), '--timeout', '0']);
  eq(second.code, 0); ok(second.out.includes('lane=heavy-lane-2')); eq(held(), ids.slice(1, 3));
  release('heavy-lane-2', 'builder'); occupy('heavy-lane-2');
  const lane3 = run(['wait-lane', ...args(), '--timeout', '0']); eq(lane3.code, 0); ok(lane3.out.includes('lane=heavy-lane-3'));
  release('heavy-lane-3', 'builder');
  eq(run(['wait-lane', ...args(), '--timeout', '0'], { RES_TEST_LOAD1M: '9' }).code, 2);
  release('heavy-lane-1'); release('heavy-lane-2');
  // Bad metrics and overload fail closed; take-build retains nonblocking gate exit 5.
  eq(run(['take-build', ...args()], { RES_TEST_LOAD1M: 'bad' }).code, 1); eq(held(), []);
  eq(run(['take-build', ...args()], { RES_TEST_LOAD1M: '21' }).code, 5); eq(held(), []);
  eq(run(['wait-build', ...args(), '--timeout', '0'], { RES_TEST_LOAD1M: '21' }).code, 2); eq(held(), []);
  for (const argv of [['wait-build', ...args()], ['wait-lane', ...args(), '--timeout', '-1'],
    ['take-build', ...args(), '--lane', 'heavy-lane-4'], ['wait-build', ...args(), '--timeout', '0', '--timeout', '1']])
    eq(run(argv).code, 1);
  // Two builders race repeatedly: exactly one owns the pair, no loser owns a lane.
  for (let round = 0; round < 4; round++) {
    const builders = ['A', 'B'].map((by) => start(res, ['take-build', ...args(by)]));
    const outcomes = await Promise.all(builders.map((child) => child.done));
    eq(outcomes.map((r) => r.code).sort(), [0, 2]);
    const winner = outcomes[0].code === 0 ? 'A' : 'B';
    eq(held(), ['heavy-build', 'heavy-lane-1']);
    eq(field('heavy-build', 'by'), winner); eq(field('heavy-lane-1', 'by'), winner);
    pairRelease(winner); eq(held(), []);
  }
  // Observe a waiting builder, then release the first pair. No hold while waiting.
  eq(run(['take-build', ...args('first')]).code, 0);
  const follower = start(res, ['wait-build', ...args('second'), '--timeout', '0.1']);
  await until(() => follower.text.includes('retry in 1s'), 'second builder did not retry', follower);
  eq(field('heavy-build', 'by'), 'first'); eq(field('heavy-lane-1', 'by'), 'first');
  pairRelease('first'); eq((await follower.done).code, 0); pairRelease('second'); eq(held(), []);
  // A lane-only legacy caller wins after the builder's free-lane precheck.
  // The partial slot must be returned, and retry must retain the task metadata.
  const laneRace = start(res, ['wait-build', ...args(), '--lane', 'heavy-lane-1', '--timeout', '0.2'], { RACE_LANE: '1' });
  await until(() => fs.existsSync(path.join(root, 'lane-race')), 'missing lane contention witness', laneRace);
  occupy('heavy-lane-1'); fs.writeFileSync(path.join(root, 'lane-race-release'), 'release\n');
  await until(() => laneRace.text.includes('retry in 1s'), 'partial pair was not rolled back', laneRace);
  eq(held(), ['heavy-lane-1']); eq(field('heavy-lane-1', 'by'), 'blocker');
  release('heavy-lane-1'); eq((await laneRace.done).code, 0, laneRace.text);
  eq(field('heavy-build', 'task'), 'T87'); eq(field('heavy-build', 'project'), 'scratch');
  pairRelease(); eq(held(), []);
  // Signal exactly after mkdir creates the slot, before the shell sees success.
  const beforeFlag = start(res, ['take-build', ...args()], { BLOCK_ON_MKDIR: '1' });
  await until(() => fs.existsSync(path.join(root, 'mid-mkdir')), 'missing mkdir window witness', beforeFlag);
  eq(held(), ['heavy-build']); eq((await stop(beforeFlag)).code, 143); eq(held(), []);
  // Stop inside lane metadata publication, after BOTH mkdirs, on every supported signal.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    fs.rmSync(path.join(root, 'mid-acquisition'), { force: true });
    const mid = start(res, ['wait-build', ...args(), '--timeout', '0.1'], { BLOCK_ON_LANE: '1' });
    await until(() => fs.existsSync(path.join(root, 'mid-acquisition')), 'missing mid-acquisition witness', mid);
    eq(held(), ['heavy-build', 'heavy-lane-1']);
    const stopped = await stop(mid, signal); ok([129, 130, 143].includes(stopped.code), mid.text); eq(held(), []);
  }
  // PID that is dead at take time warns immediately without slowing plain take.
  const dead = 2147483647, began = Date.now();
  const deadTake = run(['take', 'heavy-build', ...args('old-account'), '--pid', String(dead)]);
  eq(deadTake.code, 0); ok(Date.now() - began < 1500); ok(deadTake.err.includes('is not a long-lived process'));
  ok(deadTake.err.includes("pass the wrapper's $$")); eq(field('heavy-build', 'pid_warning'), 'short-lived pid');
  const statusBefore = info('heavy-build'), warned = run(['status', 'heavy-build']);
  ok(warned.text.includes('STALE?(short-lived pid)')); ok(warned.err.includes('use scripts/heavy-build.sh'));
  eq(info('heavy-build'), statusBefore); release('heavy-build', 'old-account');
  // Holder alive at take, killed before the one delayed check: warn and mark BOTH locks.
  for (const command of ['take-build', 'wait']) {
    const holder = start('/bin/sleep', ['30']);
    const argv = command === 'take-build' ? [command, ...args('old-account'), '--pid', String(holder.pid)]
      : [command, 'heavy-build', ...args('old-account'), '--pid', String(holder.pid), '--timeout', '0'];
    const transient = start(res, argv);
    await until(() => transient.text.includes(command === 'take-build' ? 'took heavy-lane-1' : 'took heavy-build'), 'holder take did not begin', transient);
    await stop(holder);
    eq((await transient.done).code, 0, transient.text); ok(transient.text.includes('is not a long-lived process'));
    eq(field('heavy-build', 'pid_warning'), 'short-lived pid');
    if (command === 'take-build') eq(field('heavy-lane-1', 'pid_warning'), 'short-lived pid');
    pairRelease('old-account'); eq(held(), []);
  }
  // A signal sent just to the controller PID also unwinds the pair.
  const pidSignal = start(res, ['take-build', ...args(), '--pid', String(process.pid)]);
  await until(() => pidSignal.text.includes('took heavy-lane-1'), 'PID signal acquisition did not begin', pidSignal);
  eq((await stop(pidSignal, 'SIGTERM', false)).code, 143); eq(held(), []);
  // Actual usage error: a standalone tool shell exits only AFTER plain take returns.
  eq(run(['-c', '"$RES_SOURCE" take heavy-build --by tool-shell --project scratch --for fixture --task T87 --pid $$; :'], {}, '/bin/bash').code, 0);
  const standalone = run(['status', 'heavy-build']); ok(standalone.text.includes('STALE?(short-lived pid)'));
  ok(standalone.err.includes('use scripts/heavy-build.sh')); release('heavy-build', 'tool-shell');
  // Quota takeover: verify same project/task and local STALE; return predecessor, re-take.
  eq(run(['take-build', ...args('old-account'), '--pid', String(dead)]).code, 0);
  eq(run(['wait-build', ...args('new-account'), '--timeout', '0']).code, 2); // young STALE is not auto-reclaimed
  for (const id of ['heavy-lane-1', 'heavy-build']) {
    eq(field(id, 'task'), 'T87'); eq(field(id, 'project'), 'scratch');
    ok(run(['status', id]).text.includes('STALE?(short-lived pid) old-account'));
    release(id, 'old-account');
  }
  eq(run(['take-build', ...args('new-account')]).code, 0); eq(field('heavy-build', 'by'), 'new-account');
  eq(field('heavy-build', 'pid_warning'), undefined); pairRelease('new-account');
  // Reusing a holder name fails without letting wrapper cleanup return the old run.
  eq(run(['take-build', ...args('wrapped')]).code, 0);
  const nested = wrapped(); eq((await nested.done).code, 1); eq(held(), ['heavy-build', 'heavy-lane-1']);
  eq(field('heavy-build', 'pid'), String(process.pid)); pairRelease('wrapped');
  // Parent watch terminates the owned command and descendants, and returns both holds.
  const worker = start('/bin/sleep', ['30']);
  const commandFile = path.join(root, 'command-started'), descendantFile = path.join(root, 'descendant-pid');
  const watched = wrapped(['--watch-pid', String(worker.pid), '/bin/bash', '-c',
    'sleep 30 & descendant=$!; echo "$descendant" >"$DESCENDANT_FILE"; touch "$COMMAND_FILE"; wait'],
  { COMMAND_FILE: commandFile, DESCENDANT_FILE: descendantFile });
  await until(() => fs.existsSync(commandFile), 'watched command did not start', watched);
  eq(held(), ['heavy-build', 'heavy-lane-1']); eq(field('heavy-build', 'pid'), String(watched.pid));
  const descendant = Number(fs.readFileSync(descendantFile, 'utf8'));
  await stop(worker); eq((await watched.done).code, 143, watched.text); eq(held(), []);
  let descendantAlive = true; try { process.kill(descendant, 0); } catch { descendantAlive = false; }
  eq(descendantAlive, false); ok(watched.text.includes('watched worker'));
  // Worker dies during acquisition/backoff, before the build command starts.
  occupy('heavy-lane-2');
  const waitingWorker = start('/bin/sleep', ['30']);
  const watchedWait = wrapped(['--watch-pid', String(waitingWorker.pid), '/bin/sh', '-c', 'exit 99'], { HEAVY_BUILD_LANE: 'heavy-lane-2' });
  await until(() => watchedWait.text.includes('retry in 1s'), 'watched acquisition did not retry', watchedWait);
  await stop(waitingWorker); eq((await watchedWait.done).code, 143); eq(held(), ['heavy-lane-2']); release('heavy-lane-2');
  eq(run([wrapper, '--watch-pid', String(dead), '/bin/true'], wrapperEnv, '/bin/bash').code, 143); eq(held(), []);
  // Wrapper signals during the delayed PID validation unwind the already acquired pair.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const interrupted = wrapped(['/bin/sleep', '30']);
    await until(() => interrupted.text.includes('took heavy-lane-1'), 'wrapper pair not acquired', interrupted);
    eq((await stop(interrupted, signal, false)).code, code); eq(held(), []);
  }
  // Observers retain correct STALE identity and see both new waiter forms.
  const parsed = parseHeavyStatus('heavy-build slot open - STALE?(short-lived pid) old (scratch/T87) 2026-11-13 18:00 → ?');
  eq(parsed.locks[0].stale, true); eq(parsed.locks[0].holder, 'old'); eq(parsed.locks[0].task, 'T87');
  for (const [command, resource] of [['wait-build', 'heavy-build'], ['wait-lane', 'heavy-lane-any']]) {
    const waits = observeWaiters([{ pid: 100, ppid: 10, _command: `res ${command} --by builder --task T87 --pid 10 --timeout 1` }], [{ pid: 100, id: 'fixture' }], 1000);
    eq(waits.length, 1); eq(waits[0].resource, resource); eq(waits[0].holderPid, 10);
  }
  eq(fs.readdirSync(path.join(state, 'locks')), []);
  console.log(`ALL ${count} ASSERTIONS PASSED`);
} finally {
  for (const child of [...children]) {
    try { await stop(child); } catch { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await child.done; }
  }
}
