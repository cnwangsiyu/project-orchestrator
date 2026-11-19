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
  sleeper=''
  trap 'trap "" INT TERM HUP; [ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null; wait "$sleeper" 2>/dev/null; exit 143' INT TERM HUP
  /bin/sleep 3 & sleeper=$!
  wait "$sleeper"
fi
exec /bin/date "$@"
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'mkdir'), `#!/bin/bash
if [ "\${RACE_LANE:-0}" = 1 ] && [[ "$*" = *'/heavy-lane-1.d' ]] && [ ! -f "$RES_TEST_ROOT/build/lane-race" ]; then
  touch "$RES_TEST_ROOT/build/lane-race"
  while [ ! -f "$RES_TEST_ROOT/build/lane-race-release" ]; do sleep 0.02; done
fi
if [ "\${SELF_RACE_LANE:-0}" = 1 ] && [[ "$*" = *'/heavy-lane-1.d' ]] && [ ! -f "$RES_TEST_ROOT/build/self-lane-race-\${SELF_RACE_KEY:-default}" ]; then
  touch "$RES_TEST_ROOT/build/self-lane-race-\${SELF_RACE_KEY:-default}"
  /bin/mkdir "$@" || exit $?
  printf 'by\tblocker\nproject\tscratch\ntask\tother\nfor\trollback fixture\npid\t1\nhost\tfixture\nstart\t1\n' > "$1/info"
  exit 1
fi
/bin/mkdir "$@" || exit $?
if [ "\${BLOCK_ON_MKDIR:-0}" = 1 ] && [[ "$*" = *'/heavy-build.d' ]]; then
  touch "$RES_TEST_ROOT/build/mid-mkdir"
  sleep 0.5
fi
`, { mode: 0o755 });
const unexpectedSleep = path.join(root, 'unexpected-sleep');
fs.writeFileSync(path.join(mocks, 'sleep'), `#!/bin/sh
if [ "\${FAIL_ON_SLEEP:-0}" = 1 ]; then touch "$RES_TEST_ROOT/build/unexpected-sleep"; exit 97; fi
exec /bin/sleep "$@"
`, { mode: 0o755 });
fs.writeFileSync(path.join(mocks, 'rm'), `#!/bin/bash
if [ "\${FAIL_ON_ROLLBACK:-0}" = 1 ] && [[ "$*" = *'/heavy-'*'.d' ]]; then
  echo 'fixture: rollback removal failed' >&2
  exit 1
fi
if [ "\${REPLACE_AFTER_ROLLBACK:-0}" = 1 ] && [[ "$*" = *'/heavy-build.d' ]] && [ ! -f "$RES_DIR/rollback-wait-sent" ]; then
  target="\${!#}"
  /bin/rm "$@" || exit $?
  /bin/mkdir "$target" || exit $?
  printf 'by\\t%s\\nproject\\tscratch\\ntask\\tother\\nfor\\treacquired slot\\npid\\t1\\nhost\\tfixture\\nstart\\t1\\n' "\${ROLLBACK_REPLACEMENT_BY:-replacement}" > "$target/info"
  if [ "\${INTERRUPT_ROLLBACK_WAIT:-0}" = 1 ]; then
    touch "$RES_DIR/rollback-wait-sent"
    kill -s "$RACE_SIGNAL" "$ROLLBACK_CONTROLLER_PID"
  fi
  exit 0
fi
exec /bin/rm "$@"
`, { mode: 0o755 });
const signalDriver = path.join(root, 'signal-driver.sh');
fs.writeFileSync(signalDriver, `set -T
hit=0
target_command="$1"
export ROLLBACK_CONTROLLER_PID="$$"
pause_rollback_verdict() {
  [ "$RACE_STAGE" = rollback_wait_verdict ] && [ "$BASH_SUBSHELL" -eq 0 ] || return 0
  case "\${FUNCNAME[*]}" in *protected_rollback_created*) ;; *) return 0 ;; esac
  case "$1" in 'kill -0 '* ) /bin/sleep 2 ;; esac
}
inject_rollback_startup() {
  local cmd="$1" starts=0 group_signal=
  case "$RACE_STAGE" in rollback_startup|rollback_restart) ;; *) return 0 ;; esac
  [ "$BASH_SUBSHELL" -eq 1 ] && [ "$cmd" = "trap '' INT TERM HUP" ] || return 0
  case "\${FUNCNAME[*]}" in *protected_rollback_created*) ;; *) return 0 ;; esac
  [ ! -f "$RES_DIR/rollback-startups" ] || read -r starts < "$RES_DIR/rollback-startups"
  starts=$((starts + 1))
  printf '%s\\n' "$starts" > "$RES_DIR/rollback-startups"
  case "$starts" in
    1) group_signal="\${RACE_GROUP_SIGNAL:-$RACE_SIGNAL}" ;;
    2) [ "$RACE_STAGE" != rollback_restart ] || group_signal=SIGHUP ;;
  esac
  [ -n "$group_signal" ] || return 0
  printf 'rollback-child-startup=%s\\n' "$starts"
  kill -s "$group_signal" -- "-$$"
}
inject_signal() {
  local cmd="$1"
  [ "$hit" -eq 0 ] || return 0
  case "$RACE_STAGE" in
    slot_mkdir) [ "$cmd" = 'TAKE_CREATED=1' ] && [ "\${current_id:-}" = heavy-build ] ;;
    lane_mkdir) [ "$cmd" = 'TAKE_CREATED=1' ] && [[ "\${current_id:-}" = heavy-lane-* ]] ;;
    slot_transfer) [ "$cmd" = 'build_created="$TAKE_CREATED"' ] ;;
    lane_transfer) [ "$cmd" = 'lane_created="$TAKE_CREATED"' ] ;;
    wait_mkdir) [ "$target_command" = wait ] && [ "$cmd" = 'TAKE_CREATED=1' ] ;;
    mkdir_repeat) [ "$cmd" = 'TAKE_CREATED=1' ] ;;
    wait_after_take) [ "$cmd" = 'CHECK_FRESH="$TAKE_CREATED"' ] ;;
    diagnostic) [ "$cmd" = 'sleep 2' ] ;;
    result) [[ "$cmd" = printf*build-lane* || "$cmd" = printf*lane=* ]] ;;
    commit) [ "$cmd" = 'TRANSACTION_COMMITTED=1' ] ;;
    final_exit) [ "$cmd" = 'exit 0' ] && [ "\${TRANSACTION_COMMITTED:-0}" -eq 1 ] ;;
    rollback) [ "\${TRANSACTION_CLEANING:-0}" -eq 1 ] && [ "$cmd" = 'protected_rollback_created heavy-build "$BY"' ] ;;
    rollback_restart) [ "\${TRANSACTION_CLEANING:-0}" -eq 1 ] && [ "$cmd" = 'protected_rollback_created heavy-build "$BY"' ] ;;
    rollback_failure) [ "$cmd" = 'TRANSACTION_COMMITTED=1' ] ;;
    *) return 0 ;;
  esac || return 0
  hit=1
  kill -s "$RACE_SIGNAL" "$$"
  [ "$RACE_STAGE" != mkdir_repeat ] || kill -s "$RACE_SECOND_SIGNAL" "$$"
}
if [ "$RACE_STAGE" = rollback_wait_verdict ]; then
  trap 'pause_rollback_verdict "$BASH_COMMAND"' DEBUG
else
  trap 'inject_rollback_startup "$BASH_COMMAND"; inject_signal "$BASH_COMMAND"' DEBUG
fi
source "$RES_SOURCE" "$@"
`, { mode: 0o755 });
const env = { ...process.env, RES_DIR: state, PATH: `${mocks}:${process.env.PATH}`,
  RES_TEST_METRICS: '1', RES_TEST_LOAD1M: '8', RES_TEST_MEMORYSTATUS_LEVEL: '50',
  RES_TEST_MEMSIZE: '68719476736', RES_TEST_SWAPUSAGE: 'used = 0M',
  RES_TEST_VM_STAT: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.' };
let count = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); count++; };
const ok = (a, message) => { assert.ok(a, message); count++; };
// Allow the owner return plus another gate/acquisition round trip on busy hosts.
const recoveryTimeout = '0.5';
const run = (args, extra = {}, exe = res) => {
  const r = spawnSync(exe, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
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
  child.exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  child.done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  children.add(child); return child;
}
async function until(predicate, message, child) {
  const deadline = Date.now() + 30000;
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
      timer = setTimeout(() => reject(Error(`child did not stop: ${child.text}`)), 60000);
    })]);
  } finally { clearTimeout(timer); }
}
const wrapperEnv = { RES_COMMAND: res, HEAVY_BUILD_BY: 'wrapped', HEAVY_BUILD_PROJECT: 'scratch',
  HEAVY_BUILD_TASK: 'T87', HEAVY_BUILD_TIMEOUT: '0.2', HEAVY_BUILD_LANE: '' };
const wrapped = (command = ['/bin/sh', '-c', 'exit 7'], extra = {}) => start('/bin/bash', [wrapper, ...command], { ...wrapperEnv, ...extra });

try {
  // Pinned incident: lane 2 belongs to another task; no build hold during backoff.
  occupy('heavy-lane-2'); const originalLane2 = info('heavy-lane-2');
  const pinned = start(res, ['wait-build', ...args(), '--lane', 'heavy-lane-2', '--timeout', recoveryTimeout]);
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
  const pinWrapper = wrapped(undefined, { HEAVY_BUILD_LANE: 'heavy-lane-2', HEAVY_BUILD_TIMEOUT: recoveryTimeout });
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
  // Re-invoking wait-lane with the same holder identity is idempotent.
  const laneHolder = ['--by', 'lane-idem', '--project', 'scratch', '--for', 'idempotence', '--task', 'T87', '--pid', String(process.pid)];
  const laneFirst = run(['wait-lane', ...laneHolder, '--timeout', '0']); eq(laneFirst.code, 0, laneFirst.text);
  const laneFirstInfo = info('heavy-lane-1');
  const laneAgain = run(['wait-lane', ...laneHolder, '--timeout', '0']); eq(laneAgain.code, 0, laneAgain.text);
  ok(laneAgain.out.includes('lane=heavy-lane-1')); eq(held(), ['heavy-lane-1']); eq(info('heavy-lane-1'), laneFirstInfo);
  release('heavy-lane-1', 'lane-idem');
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
  const follower = start(res, ['wait-build', ...args('second'), '--timeout', recoveryTimeout]);
  await until(() => follower.text.includes('retry in 1s'), 'second builder did not retry', follower);
  eq(field('heavy-build', 'by'), 'first'); eq(field('heavy-lane-1', 'by'), 'first');
  pairRelease('first'); eq((await follower.done).code, 0); pairRelease('second'); eq(held(), []);
  // A lane-only caller arriving after the builder's free-lane precheck now
  // yields the final admitted lane; the waiting builder completes directly.
  const laneRace = start(res, ['wait-build', ...args(), '--lane', 'heavy-lane-1', '--timeout', recoveryTimeout], { RACE_LANE: '1' });
  await until(() => fs.existsSync(path.join(root, 'lane-race')), 'missing lane contention witness', laneRace);
  const laneContender = run(['take', 'heavy-lane-1', ...args('blocker')]);
  eq(laneContender.code, 2); ok(laneContender.text.includes('reserved for waiting build builder'), laneContender.text);
  fs.writeFileSync(path.join(root, 'lane-race-release'), 'release\n');
  eq((await laneRace.done).code, 0, laneRace.text);
  eq(held(), ['heavy-build', 'heavy-lane-1']); eq(field('heavy-lane-1', 'by'), 'builder');
  eq(field('heavy-build', 'task'), 'T87'); eq(field('heavy-build', 'project'), 'scratch');
  pairRelease(); eq(held(), []);
  // Signal exactly after mkdir creates the slot, before the shell sees success.
  const beforeFlag = start(res, ['take-build', ...args()], { BLOCK_ON_MKDIR: '1' });
  await until(() => fs.existsSync(path.join(root, 'mid-mkdir')), 'missing mkdir window witness', beforeFlag);
  eq(held(), ['heavy-build']); eq((await stop(beforeFlag)).code, 143); eq(held(), []);
  // Stop inside lane metadata publication, after BOTH mkdirs, on every supported signal.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    fs.rmSync(path.join(root, 'mid-acquisition'), { force: true });
    const mid = start(res, ['wait-build', ...args(), '--timeout', recoveryTimeout], { BLOCK_ON_LANE: '1' });
    await until(() => fs.existsSync(path.join(root, 'mid-acquisition')), 'missing mid-acquisition witness', mid);
    eq(held(), ['heavy-build', 'heavy-lane-1']);
    const stopped = await stop(mid, signal); ok([129, 130, 143].includes(stopped.code), mid.text); eq(held(), []);
  }
  // Every handoff gap in all four acquisition commands is cancellation-safe.
  const signalCodes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
  const interruptionCases = [
    ['take-build', ['slot_mkdir', 'slot_transfer', 'lane_mkdir', 'lane_transfer', 'mkdir_repeat', 'diagnostic', 'result', 'commit', 'final_exit', 'rollback', 'rollback_startup', 'rollback_restart', 'rollback_failure']],
    ['wait-build', ['slot_mkdir', 'slot_transfer', 'lane_mkdir', 'lane_transfer', 'mkdir_repeat', 'diagnostic', 'result', 'commit', 'final_exit', 'rollback', 'rollback_startup', 'rollback_restart', 'rollback_failure']],
    ['wait-lane', ['lane_mkdir', 'lane_transfer', 'mkdir_repeat', 'diagnostic', 'result', 'commit', 'final_exit', 'rollback_failure']],
    ['wait', ['wait_mkdir', 'wait_after_take', 'mkdir_repeat', 'diagnostic', 'commit', 'final_exit', 'rollback_failure']],
  ];
  const interruptionJobs = [];
  let interruptionIndex = 0;
  for (const [command, stages] of interruptionCases) for (const stage of stages) for (const [signal, expected] of Object.entries(signalCodes)) {
    const caseKey = String(interruptionIndex++), caseState = path.join(root, 'signal-cases', caseKey);
    fs.mkdirSync(path.join(caseState, 'locks'), { recursive: true });
    fs.writeFileSync(path.join(caseState, 'resources.tsv'), registry);
    interruptionJobs.push(async () => {
      const explicitPid = stage === 'diagnostic' ? ['--pid', String(process.pid)] : [];
      const argv = command === 'wait' ? [command, 'heavy-build', ...args(), ...explicitPid, '--timeout', '0']
        : [command, ...args(), ...explicitPid, ...(command === 'take-build' ? [] : ['--timeout', '0'])];
      const child = start('/bin/bash', [signalDriver, ...argv], { RES_DIR: caseState, RACE_STAGE: stage, RACE_SIGNAL: signal,
        RACE_GROUP_SIGNAL: stage === 'rollback_restart' ? 'SIGTERM' : signal,
        RACE_SECOND_SIGNAL: signal === 'SIGHUP' ? 'SIGTERM' : 'SIGHUP',
        FAIL_ON_ROLLBACK: stage === 'rollback_failure' ? '1' : '0',
        SELF_RACE_KEY: caseKey, SELF_RACE_LANE: ['rollback', 'rollback_startup', 'rollback_restart'].includes(stage) ? '1' : '0' });
      let timer, interrupted;
      try {
        // Error probes have no blocking descendants; drain their diagnostic
        // before checking it instead of racing stderr against the exit event.
        const completion = stage === 'rollback_failure' ? child.done : child.exited;
        interrupted = await Promise.race([completion, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`${command} ${stage} ${signal} exceeded 60s: ${child.text}`)), 60000);
        })]);
      } catch (error) {
        try { await stop(child); } catch {}
        throw error;
      } finally { clearTimeout(timer); }
      // Exit is authoritative for the controller. Do not let a late mock or
      // cleanup descendant holding a copied stdio fd turn this into a clock test.
      children.delete(child); child.stdout.destroy(); child.stderr.destroy();
      eq(interrupted.code, stage === 'rollback_failure' ? 1 : expected, `${command} ${stage} ${signal}: ${child.text}`);
      const caseHeld = ids.filter((id) => fs.existsSync(path.join(caseState, 'locks', `${id}.d`)));
      if (stage === 'rollback_failure') {
        eq(caseHeld, command === 'wait-lane' ? ['heavy-lane-1'] : command === 'wait' ? ['heavy-build'] : ['heavy-build', 'heavy-lane-1']);
        ok(child.text.includes('rollback removal failed'), 'real cleanup error is not hidden by cancellation');
        fs.rmSync(path.join(caseState, 'locks'), { recursive: true });
      } else if (['rollback', 'rollback_startup', 'rollback_restart'].includes(stage)) {
        eq(caseHeld, ['heavy-lane-1'], `${command} ${stage} ${signal}`);
        const blockerInfo = fs.readFileSync(path.join(caseState, 'locks/heavy-lane-1.d/info'), 'utf8');
        eq(blockerInfo, 'by\tblocker\nproject\tscratch\ntask\tother\nfor\trollback fixture\npid\t1\nhost\tfixture\nstart\t1\n');
      } else eq(caseHeld, [], `${command} ${stage} ${signal}`);
      if (['rollback_startup', 'rollback_restart'].includes(stage)) {
        const startups = Number(fs.readFileSync(path.join(caseState, 'rollback-startups'), 'utf8'));
        eq(startups, stage === 'rollback_restart' ? 3 : (signal === 'SIGINT' ? 1 : 2),
          `${command} ${stage} ${signal}: helper restarts before release`);
        const returns = fs.readFileSync(path.join(caseState, 'log.tsv'), 'utf8').trim().split('\n')
          .map((line) => line.split('\t')).filter((row) => row[1] === 'return').map((row) => row[2]);
        eq(returns, ['heavy-build'], 'release once before cancelled exit');
      }
    });
  }
  // Isolated states make cases independent; bounded parallel batches keep the
  // exhaustive matrix comfortably inside the per-suite deadline on busy hosts.
  const batchSize = process.env.RES_TEST_SERIAL_CASES === '1' ? 1 : 8;
  for (let i = 0; i < interruptionJobs.length; i += batchSize)
    await Promise.all(interruptionJobs.slice(i, i + batchSize).map((job) => job()));
  // Pinning the removed directory's identity must also support relative state
  // roots, and must not confuse a replacement holder with an unreleased hold.
  for (const replacement of [false, true]) {
    const caseKey = replacement ? 'replacement' : 'relative', caseState = path.join(root, caseKey);
    fs.mkdirSync(path.join(caseState, 'locks'), { recursive: true });
    fs.writeFileSync(path.join(caseState, 'resources.tsv'), registry);
    const cancelled = run([signalDriver, 'take-build', ...args()], {
      RES_DIR: replacement ? caseState : path.relative(process.cwd(), caseState),
      RACE_STAGE: 'rollback', RACE_SIGNAL: 'SIGTERM', SELF_RACE_LANE: '1', SELF_RACE_KEY: caseKey,
      REPLACE_AFTER_ROLLBACK: replacement ? '1' : '0',
    }, '/bin/bash');
    eq(cancelled.code, 143, cancelled.text);
    eq(ids.filter((id) => fs.existsSync(path.join(caseState, 'locks', `${id}.d`))),
      replacement ? ['heavy-build', 'heavy-lane-1'] : ['heavy-lane-1']);
    if (replacement) eq(fs.readFileSync(path.join(caseState, 'locks/heavy-build.d/info'), 'utf8'),
      'by\treplacement\nproject\tscratch\ntask\tother\nfor\treacquired slot\npid\t1\nhost\tfixture\nstart\t1\n');
    const returns = fs.readFileSync(path.join(caseState, 'log.tsv'), 'utf8').trim().split('\n')
      .map((line) => line.split('\t')).filter((row) => row[1] === 'return').map((row) => row[2]);
    eq(returns, ['heavy-build']);
  }
  // An interrupted wait is not a failed helper: cleanup may finish and a new
  // holder acquire the path before the parent checks child liveness.
  for (const command of ['take-build', 'wait-build']) for (const [signal, expected] of Object.entries(signalCodes))
    for (const replacementBy of ['replacement', 'builder']) {
      const caseKey = `wait-verdict-${command}-${signal}-${replacementBy}`, caseState = path.join(root, caseKey);
      fs.mkdirSync(path.join(caseState, 'locks'), { recursive: true });
      fs.writeFileSync(path.join(caseState, 'resources.tsv'), registry);
      const child = start('/bin/bash', [signalDriver, command, ...args(), '--lane', 'heavy-lane-1',
        ...(command === 'wait-build' ? ['--timeout', '0'] : [])], {
        RES_DIR: caseState, RACE_STAGE: 'rollback_wait_verdict', RACE_SIGNAL: signal,
        SELF_RACE_LANE: '1', SELF_RACE_KEY: caseKey, REPLACE_AFTER_ROLLBACK: '1',
        INTERRUPT_ROLLBACK_WAIT: '1', ROLLBACK_REPLACEMENT_BY: replacementBy,
      });
      eq((await child.done).code, expected, `${command} completed rollback ${signal}: ${child.text}`);
      eq(ids.filter((id) => fs.existsSync(path.join(caseState, 'locks', `${id}.d`))), ['heavy-build', 'heavy-lane-1']);
      eq(fs.readFileSync(path.join(caseState, 'locks/heavy-build.d/info'), 'utf8'),
        `by\t${replacementBy}\nproject\tscratch\ntask\tother\nfor\treacquired slot\npid\t1\nhost\tfixture\nstart\t1\n`);
      eq(fs.existsSync(path.join(caseState, 'rollback-wait-sent')), true, 'signal interrupted the parent wait');
      const returns = fs.readFileSync(path.join(caseState, 'log.tsv'), 'utf8').trim().split('\n')
        .map((line) => line.split('\t')).filter((row) => row[1] === 'return').map((row) => row[2]);
      eq(returns, ['heavy-build'], 'the replacement holder is never returned');
    }
  // An interrupted idempotent wait must not return the caller's older hold.
  const idemWaitArgs = ['--by', 'wait-idem', '--project', 'scratch', '--for', 'idempotence', '--task', 'T87', '--pid', String(process.pid)];
  eq(run(['take', 'heavy-build', ...idemWaitArgs]).code, 0);
  const idemWaitInfo = info('heavy-build');
  for (const [signal, expected] of Object.entries(signalCodes)) {
    const interrupted = run([signalDriver, 'wait', 'heavy-build', ...idemWaitArgs, '--timeout', '0'],
      { RACE_STAGE: 'wait_after_take', RACE_SIGNAL: signal }, '/bin/bash');
    eq(interrupted.code, expected, `idempotent wait ${signal}: ${interrupted.text}`);
    eq(held(), ['heavy-build']); eq(info('heavy-build'), idemWaitInfo);
  }
  release('heavy-build', 'wait-idem');
  // PID that is dead at take time warns immediately without slowing plain take.
  const dead = 2147483647;
  fs.rmSync(unexpectedSleep, { force: true });
  const deadTake = run(['take', 'heavy-build', ...args('old-account'), '--pid', String(dead)], { FAIL_ON_SLEEP: '1' });
  eq(deadTake.code, 0); eq(fs.existsSync(unexpectedSleep), false); ok(deadTake.err.includes('is not a long-lived process'));
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
  const watchedWait = wrapped(['--watch-pid', String(waitingWorker.pid), '/bin/sh', '-c', 'exit 99'],
    { HEAVY_BUILD_LANE: 'heavy-lane-2', HEAVY_BUILD_TIMEOUT: recoveryTimeout });
  await until(() => watchedWait.text.includes('retry in 1s'), 'watched acquisition did not retry', watchedWait);
  await stop(waitingWorker); eq((await watchedWait.done).code, 143); eq(held(), ['heavy-lane-2']); release('heavy-lane-2');
  eq(run([wrapper, '--watch-pid', String(dead), '/bin/true'], wrapperEnv, '/bin/bash').code, 143); eq(held(), []);
  // Wrapper signals during the delayed PID validation unwind the already acquired pair.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const interrupted = wrapped(['/bin/sleep', '30']);
    // Acquisition stdout is buffered by heavy-build.sh until its PID check ends.
    // Observe this wrapper's published pair to interrupt the intended PID-check window.
    await until(() => {
      try { return field('heavy-build', 'pid') === String(interrupted.pid) &&
        field('heavy-lane-1', 'pid') === String(interrupted.pid); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'wrapper pair not acquired (' + signal + ')', interrupted);
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
