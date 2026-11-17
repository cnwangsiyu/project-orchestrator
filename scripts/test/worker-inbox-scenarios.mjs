#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEvent, eventFile, ackFile, readEvents, readAck, inbox, deliver, hasWatcher, auditWorkerEvents,
  launcherIdentity, resolveOwner, watchDeadline } from '../lib/worker-events.mjs';
import { matchingBackgroundTask } from '../lib/worker-background.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-inbox-'));
const original = process.env.RULES_SHARED;
process.env.RULES_SHARED = tmp;
const profiles = path.join(tmp, 'accounts.json'); fs.writeFileSync(profiles, '{}');
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: profiles, ORCHESTRATOR_OWNER: '',
  CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '', WORKER_EVENTS_FIXTURE: '{}' };
const worker = path.join(scripts, 'codex-worker.mjs'), hook = path.join(scripts, 'worker-inbox-hook.mjs');
const fixture = path.join(scripts, 'test/fixtures/worker-events-transport.mjs');
// Functional checks do not race the host's ps/IO scheduling; the idle and stalled-IO probes below use the real budget.
const functionalClock = path.join(tmp, 'hook-functional-clock.mjs');
fs.writeFileSync(functionalClock, `const timeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 220 ? 10000 : ms, ...args);
`);
const children = new Set();
const start = (script, args, extra = {}) => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
  const done = new Promise((resolve) => child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); }));
  return { child, done, output: () => stdout };
};
const until = async (test, label) => {
  const end = Date.now() + 4000;
  while (!test()) { if (Date.now() > end) throw Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 20)); }
};
const record = (owner, event, name, extra = {}) => appendEvent({ owner, runId: name, event, name, thread: null, account: 'fixture', model: 'fixture',
  exit: event === 'running' ? null : 0, outFile: path.join(tmp, 'final.md'), logFile: null, launcher: { sessionId: owner, jobId: null, cwd: tmp }, ...extra });
const hookRun = (input, extra = {}) => {
  const time = performance.now();
  const r = spawnSync(process.execPath, ['--import', functionalClock, hook], { env: { ...env, ...extra }, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  return { output: r.stdout ? JSON.parse(r.stdout) : null, ms: performance.now() - time };
};
const input = (owner, extra = {}) => ({ session_id: owner, hook_event_name: 'Stop', session_title: 'Fixture 主对话', cwd: tmp, stop_hook_active: false, ...extra });
const follow = (name, command = 'start', config = {}, flags = []) => {
  const args = ['--import', fixture, worker, command, '--owner', '47ba610f-34a8-5362-a84d-d009bffc3f5f', '--name', name,
    ...(command === 'start' ? ['--cwd', tmp, '--sandbox', 'read-only'] : ['--thread', 'thread-fixture']),
    ...(command === 'wait' ? [] : ['--effort', 'high', '--model', 'fixture']), '--log', path.join(tmp, `${name}.jsonl`), '--out', path.join(tmp, `${name}.md`), ...flags,
    ...(command === 'wait' ? [] : ['Follow the fixture brief.'])];
  const r = spawnSync(process.execPath, args, { env: { ...env, WORKER_EVENTS_FIXTURE: JSON.stringify(config) }, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.error, undefined, `${name}: ${r.stderr}`);
  const rows = readEvents().filter((row) => row.name === name);
  assert.ok(rows.some((row) => row.event === 'running'), name);
  assert.equal(rows.filter((row) => row.event !== 'running').length, 1, `${name} has exactly one exit event`);
  return { ...r, event: rows.at(-1) };
};
try {
  const fullOwner = '2b03d1f3-a36c-4c5d-b393-446ce7e05d81';
  assert.equal(resolveOwner('2b03d1f3', { ORCHESTRATOR_OWNER: fullOwner }), fullOwner);
  assert.equal(resolveOwner(fullOwner, { ORCHESTRATOR_OWNER: 'another-owner' }), fullOwner);
  assert.equal(resolveOwner(null, { ORCHESTRATOR_OWNER: fullOwner }), fullOwner);
  for (const candidateEnv of [{}, { ORCHESTRATOR_OWNER: '11111111-a36c-4c5d-b393-446ce7e05d81' },
    { CLAUDE_SESSION_ID: fullOwner }, { CLAUDE_CODE_SESSION_ID: fullOwner }])
    assert.throws(() => resolveOwner('2b03d1f3', candidateEnv), error => error.exitCode === 2
      && error.message === 'pass the full session id (or omit --owner to use ORCHESTRATOR_OWNER)');
  assert.equal(resolveOwner(null, { CLAUDE_JOB_DIR: '/tmp/jobs/job-fallback' }), null);
  assert.deepEqual(launcherIdentity(null, { API_KEY: 'do-not-record', CLAUDECODE: '1' }).env, { CLAUDECODE: '1' });
  const ownerCommand = (command, owner, ownerEnv = {}, flags = []) => spawnSync(process.execPath,
    ['--import', fixture, worker, command, '--owner', owner, ...flags],
    { env: { ...env, ...ownerEnv, WORKER_EVENTS_FIXTURE: JSON.stringify({ thread: 'owner-prefix-thread' }) },
      encoding: 'utf8', timeout: 10000 });
  for (const command of ['start', 'turn', 'watch', 'mine', 'note', 'ask']) {
    for (const ownerEnv of [{}, { ORCHESTRATOR_OWNER: '11111111-a36c-4c5d-b393-446ce7e05d81' }]) {
      const before = fs.existsSync(eventFile()) ? fs.readFileSync(eventFile(), 'utf8') : '';
      const rejected = ownerCommand(command, '2b03d1f3', ownerEnv);
      assert.equal(rejected.status, 2, `${command}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /pass the full session id \(or omit --owner to use ORCHESTRATOR_OWNER\)/);
      assert.equal(fs.existsSync(eventFile()) ? fs.readFileSync(eventFile(), 'utf8') : '', before,
        `${command} rejects unresolved owners before appending events`);
    }
  }
  for (const command of ['start', 'turn', 'note', 'ask', 'mine', 'watch']) {
    const flags = command === 'start' ? ['--cwd', tmp, '--sandbox', 'read-only', '--effort', 'high', 'Fixture']
      : command === 'turn' ? ['--thread', 'owner-prefix-thread', '--effort', 'high', 'Fixture']
        : command === 'note' ? ['--thread', 'owner-prefix-thread', 'Owner fixture finding']
          : command === 'ask' ? ['--thread', 'owner-prefix-thread', '--timeout-min', '0.003', '--default', 'Continue', 'Owner fixture question']
            : command === 'watch' ? ['--debounce-sec', '0'] : [];
    const accepted = ownerCommand(command, '2b03d1f3', { ORCHESTRATOR_OWNER: fullOwner }, flags);
    assert.equal(accepted.status, command === 'ask' ? 3 : 0, `${command}: ${accepted.stderr}`);
    assert.ok(readEvents().filter(row => row.thread === 'owner-prefix-thread').every(row => row.owner === fullOwner));
  }
  console.log('PASS BC-71 full UUID owners and prefix expansion; mismatches/no env refused before events for start/turn/watch/mine/note/ask');
  fs.writeFileSync(path.join(tmp, 'final.md'), 'DONE first final line\nsecond line\n');
  const waiting = start(worker, ['watch', '--debounce-sec', '0', '--owner', '59970f96-5c74-5706-97c4-fa55b3438de4']);
  await until(() => hasWatcher('59970f96-5c74-5706-97c4-fa55b3438de4'), 'watch armed');
  record('43a535be-2703-585a-a301-ed7fb53ad82c', 'finished', 'B');
  await new Promise((r) => setTimeout(r, 220)); assert.equal(waiting.output(), '', 'watch blocks, owner B does not wake A');
  const a = record('59970f96-5c74-5706-97c4-fa55b3438de4', 'finished', 'A');
  const wake = await waiting.done; assert.equal(wake.code, 0); assert.match(wake.stdout, /A\tfinished.*DONE first final line/);
  assert.ok(readAck('59970f96-5c74-5706-97c4-fa55b3438de4').delivered[a.id]); assert.equal(hasWatcher('59970f96-5c74-5706-97c4-fa55b3438de4'), false);
  assert.equal(inbox(readEvents(), '43a535be-2703-585a-a301-ed7fb53ad82c', readAck('43a535be-2703-585a-a301-ed7fb53ad82c')).pending.length, 1);
  assert.equal(inbox(readEvents(), '59970f96-5c74-5706-97c4-fa55b3438de4', readAck('59970f96-5c74-5706-97c4-fa55b3438de4')).pending.length, 0);
  const printing = record('734d9636-2094-521d-a731-81e1bfa10f7a', 'finished', 'print-fail');
  assert.throws(() => deliver('734d9636-2094-521d-a731-81e1bfa10f7a', () => { throw Error('closed stdout'); }));
  assert.equal(readAck('734d9636-2094-521d-a731-81e1bfa10f7a').delivered[printing.id], undefined);

  const hookEvent = record('41069376-dac9-51ec-8186-ec91cd349335', 'finished', 'hook-finished');
  const blocked = hookRun(input('41069376-dac9-51ec-8186-ec91cd349335')); assert.equal(blocked.output.decision, 'block');
  assert.match(blocked.output.reason, /hook-finished.*read/); assert.ok(readAck('41069376-dac9-51ec-8186-ec91cd349335').delivered[hookEvent.id]);
  assert.ok(blocked.ms < 2000, `hook: ${blocked.ms}ms (settings timeout)`);
  assert.equal(hookRun(input('41069376-dac9-51ec-8186-ec91cd349335')).output, null);
  record('f6868a96-07f4-5382-b200-13ac087f9fda', 'running', 'running-worker');
  assert.match(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda')).output.reason, /arm the watcher:.*watch --owner f6868a96-07f4-5382-b200-13ac087f9fda/);
  assert.equal(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda', { stop_hook_active: true })).output, null, 'block watcher request once');
  record('f6868a96-07f4-5382-b200-13ac087f9fda', 'finished', 'new-result');
  assert.equal(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda', { stop_hook_active: true })).output, null, 'new completions never bypass the stop-cycle guard');
  hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda'));
  const armed = start(worker, ['watch', '--debounce-sec', '0', '--owner', 'f6868a96-07f4-5382-b200-13ac087f9fda']);
  await until(() => hasWatcher('f6868a96-07f4-5382-b200-13ac087f9fda'), 'second watcher armed');
  assert.equal(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda')).output, null);
  assert.match(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda', { background_tasks: [] })).output.reason, /arm the watcher/, 'an untracked live watcher is not enough when the registry is available');
  assert.equal(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda', { background_tasks: [{ type: 'shell', command: `node '${worker}' watch --owner 'f6868a96-07f4-5382-b200-13ac087f9fda'` }] })).output, null);
  assert.match(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda', { background_tasks: [{ type: 'shell', command: `node '${worker}' watch --owner f6868a96-07f4-5382-b200-13ac087f9fda-other` }] })).output.reason, /arm the watcher/);
  // BC-56: the node path, the task type label and an env-supplied owner must not hide an armed watcher; the block says which check failed.
  for (const task of [{ type: 'local_bash', command: `/usr/local/Cellar/node/26.12.0/bin/node "${worker}" watch --owner f6868a96-07f4-5382-b200-13ac087f9fda 2>&1` },
    { type: 'shell', command: `cd /tmp && node ${worker} --account trae watch --owner=f6868a96-07f4-5382-b200-13ac087f9fda` },
    { command: `ORCHESTRATOR_OWNER=f6868a96-07f4-5382-b200-13ac087f9fda node ${worker} watch` },
    { type: 'shell', command: `node ${worker} watch --owner f6868a96-07f4-5382-b200-13ac087f9fda; echo "watch exit $?"` }])
    assert.equal(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda', { background_tasks: [task] })).output, null, task.command);
  assert.match(hookRun(input('f6868a96-07f4-5382-b200-13ac087f9fda', { background_tasks: [] })).output.reason, /watcher claim live; background tasks 0 listed, 0 run a watcher/);
  armed.child.kill('SIGTERM'); assert.equal((await armed.done).code, 143); assert.equal(hasWatcher('f6868a96-07f4-5382-b200-13ac087f9fda'), false);
  // Live followers cover completion notifications only when their tracked launches match every worker.
  record('d64c0df5-e473-5bde-89e1-ef3e50df1846', 'running', 'live-start', { thread: 'start-thread', pid: process.pid, followerCommand: 'start', launcher: { sessionId: 'd64c0df5-e473-5bde-89e1-ef3e50df1846', env: { CLAUDE_CODE_TASK_ID: 'start-task' } } });
  record('d64c0df5-e473-5bde-89e1-ef3e50df1846', 'running', 'live-turn', { thread: 'turn-thread', pid: process.pid, followerCommand: 'turn', launcher: { sessionId: 'd64c0df5-e473-5bde-89e1-ef3e50df1846', env: { CLAUDE_CODE_TASK_ID: 'turn-task' } } });
  const followers = [
    { command: `node "${worker}" --account fixture start --owner d64c0df5-e473-5bde-89e1-ef3e50df1846 --name live-start`, id: 'start-task' },
    { command: `node "${worker}" --account fixture turn --owner d64c0df5-e473-5bde-89e1-ef3e50df1846 --thread turn-thread`, id: 'turn-task' }
  ];
  assert.equal(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846', { background_tasks: followers })).output, null);
  assert.match(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846', { background_tasks: followers.slice(0, 1) })).output.reason, /live-turn.*no matching tracked/);
  assert.match(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846')).output.reason, /live-start.*background_tasks missing/);
  for (const change of [{ pid: 2147483647 }, { status: 'completed' }, { command: followers[0].command + ' &' },
    { id: 'another-project-task' }]) {
    assert.match(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846', { background_tasks: [{ ...followers[0], ...change }, followers[1]] })).output.reason, /live-start/);
  }
  assert.equal(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846', { background_tasks: [
    { id: 'start-task', command: 'bash /fixture/task/launch.sh', status: 'running' },
    { id: 'turn-task', command: `node ${worker} --account trae turn --thread turn-thread`, status: 'running' }
  ] })).output, null, 'wrappers and direct turns use recorded task identity');
  assert.match(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846', { background_tasks: [
    { command: followers[0].command }, followers[1]
  ] })).output.reason, /live-start/, 'matching command text without task identity cannot prove coverage');
  assert.match(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846', { background_tasks: [null, followers[1]] })).output.reason, /live-start/, 'malformed registry entries cannot establish follower coverage');
  const wrapper = record('52687770-a558-570a-91ba-436ab759fa5c', 'running', 'wrapper-worker', { thread: 'wrapper-thread', pid: process.pid,
    followerCommand: 'start', outFile: '/x/task-foo/report.md', logFile: '/x/task-foo/worker.jsonl' });
  assert.equal(hookRun(input('52687770-a558-570a-91ba-436ab759fa5c', { background_tasks: [{ command: 'bash /x/task-foo/launch.sh' }] })).output, null,
    'command-only background task is matched to the recorded task directory');
  assert.ok(await matchingBackgroundTask(wrapper, [{ command: 'bash /x/task-foo/launch.sh; echo finished' }], '52687770-a558-570a-91ba-436ab759fa5c'),
    'a shell separator after the wrapper path preserves coverage');
  const launchDirRow = { ...wrapper, outFile: null, logFile: null, launcher: { sessionId: '52687770-a558-570a-91ba-436ab759fa5c', taskDir: '/x/task-foo' } };
  assert.ok(await matchingBackgroundTask(launchDirRow, [{ command: 'bash /x/task-foo/launch.sh' }], '52687770-a558-570a-91ba-436ab759fa5c'), 'explicit launch-record task directory covers its wrapper');
  assert.ok(await matchingBackgroundTask({ ...launchDirRow, ancestorPids: {} }, [{ command: 'bash /x/task-foo/launch.sh' }], '52687770-a558-570a-91ba-436ab759fa5c'),
    'malformed optional ancestry does not prevent matching the recorded task path');
  assert.ok(await matchingBackgroundTask(launchDirRow, [{ command: 'bash /x/task-foo/scripts/run.sh' }], '52687770-a558-570a-91ba-436ab759fa5c'),
    'an explicitly recorded task directory covers its nested wrapper');
  assert.equal(await matchingBackgroundTask(wrapper, [{ command: 'bash /x/task-foo/task-other/launch.sh' }], '52687770-a558-570a-91ba-436ab759fa5c'), null,
    'an inferred output directory cannot cover another nested task');
  assert.match(hookRun(input('52687770-a558-570a-91ba-436ab759fa5c', { background_tasks: [{ command: 'bash /x/task-foobar/launch.sh' }] })).output.reason, /arm the watcher/,
    'a task directory prefix does not cover another task');
  assert.match(hookRun(input('52687770-a558-570a-91ba-436ab759fa5c', { background_tasks: [{ command: 'bash /x/task-foo/launch.sh', status: 'completed' }] })).output.reason, /arm the watcher/);
  const directTurn = record('f5e015a5-8dfa-5afd-b8f1-d1b9b483e684', 'running', 'direct-worker', { thread: 'direct-thread', pid: process.pid,
    followerCommand: 'turn', outFile: null });
  assert.equal(hookRun(input('f5e015a5-8dfa-5afd-b8f1-d1b9b483e684', { background_tasks: [{ unknown_type: 'shell', command: `node ${worker} turn --thread direct-thread` }] })).output, null);
  assert.match(hookRun(input('f5e015a5-8dfa-5afd-b8f1-d1b9b483e684', { background_tasks: [{ command: `node ${worker} turn --thread direct-thread-other` }] })).output.reason, /arm the watcher/);
  // Exercise live ps ancestry without recorded ancestorPids or a matching output directory.
  const nested = start(path.join(scripts, 'test/fixtures/worker-background-child.mjs'), []);
  await until(() => nested.output().includes('ready'), 'nested follower ready');
  const childPid = Number(nested.output().trim().split(' ')[1]);
  const ancestorRow = { ...wrapper, pid: childPid, parentPid: undefined, ancestorPids: [], outFile: null, logFile: null };
  assert.ok(await matchingBackgroundTask(ancestorRow, [{ id: String(nested.child.pid) }], '52687770-a558-570a-91ba-436ab759fa5c', { ancestryTimeoutMs: 3000 }), 'numeric task id matches live process ancestry');
  assert.ok(await matchingBackgroundTask(ancestorRow, [{ command: `${process.execPath} ${path.join(scripts, 'test/fixtures/worker-background-child.mjs')}` }], '52687770-a558-570a-91ba-436ab759fa5c', { ancestryTimeoutMs: 3000 }),
    'registered wrapper command matches live parent command');
  nested.child.kill('SIGTERM'); await nested.done;

  const capture = path.join(tmp, 'hook-capture/last-stop.json');
  assert.equal(fs.existsSync(capture), false, 'capture is off by default');
  hookRun(input('8ddf2508-7a01-5b4a-ad5e-58e68b572a43', { background_tasks: [{ id: 'public-id', command: 'x'.repeat(400), status: 'running',
    task_description: 'public description', unrelated: 'not captured', nested: { command: 'not captured' } }] }), { ORCH_HOOK_CAPTURE: '1' });
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [{ id: 'public-id', command: 'x'.repeat(300), status: 'running', task_description: 'public description' }]);
  assert.equal(fs.statSync(capture).mode & 0o777, 0o600);

  for (const status of ['completed', 'finished']) {
    const owner = `reported-${status}`;
    const row = record(owner, 'finished', 'already-reported', { thread: `${owner}-thread`, followerCommand: 'turn', pid: 2147483647,
      launcher: { sessionId: owner, env: { CLAUDE_CODE_TASK_ID: 'reported-task' } } });
    assert.equal(hookRun(input(owner, { background_tasks: [{ id: 'reported-task', command: 'bash /x/launch.sh', status }] })).output, null);
    assert.equal(inbox(readEvents(), owner, readAck(owner)).pending.length, 0, 'reported completion is durably acknowledged');
    assert.ok(readAck(owner).delivered[row.id]);
  }
  for (const current of [true, false]) {
    const owner = `continued-report-${current}`, task = { id: 'current-task', command: 'bash /x/task-continued/launch.sh', status: 'running' };
    const live = record(owner, 'running', 'continued-result', { thread: 'continued-thread', followerCommand: 'turn', pid: process.pid,
      outFile: '/x/task-continued/report.md', logFile: '/x/task-continued/worker.jsonl' });
    assert.equal(hookRun(input(owner, { background_tasks: [task] })).output, null);
    record(owner, 'finished', 'continued-result', { ...live, event: 'finished', pid: 2147483647, exit: 0 });
    const result = hookRun(input(owner, { background_tasks: [{ ...task, id: current ? 'current-task' : 'previous-task', status: 'completed' }] })).output;
    if (current) assert.equal(result, null, 'a verified live registration matches completion even without a launcher task-id env');
    else assert.match(result.reason, /continued-result.*read/, 'an older completed task with the same command cannot acknowledge the new turn');
  }
  const goneOwner = 'gone-owner', goneTask = { id: 'gone-task', command: 'bash /x/task-gone/launch.sh', status: 'running' };
  const gone = record(goneOwner, 'running', 'gone-worker', { thread: 'gone-thread', followerCommand: 'start', pid: process.pid,
    launcher: { sessionId: goneOwner, env: { CLAUDE_CODE_TASK_ID: 'gone-task' } } });
  assert.equal(hookRun(input(goneOwner, { background_tasks: [goneTask] })).output, null);
  const finish = record(goneOwner, 'finished', 'gone-worker', { ...gone, id: undefined, seq: undefined, t: Date.now() - 100,
    event: 'finished', pid: 2147483647, exit: 0 });
  // A continuation Stop saw the clean exit while the task was still listed, without delivering or acknowledging again.
  assert.equal(hookRun(input(goneOwner, { stop_hook_active: true, background_tasks: [goneTask] })).output, null);
  assert.equal(inbox(readEvents(), goneOwner, readAck(goneOwner)).pending.length, 1);
  assert.equal(hookRun(input(goneOwner, { background_tasks: [] })).output, null);
  assert.ok(readAck(goneOwner).delivered[finish.id]);
  const freshOwner = 'fresh-exit-owner';
  const fresh = record(freshOwner, 'running', 'fresh-exit-worker', { thread: 'fresh-thread', followerCommand: 'start', pid: process.pid,
    launcher: { sessionId: freshOwner, env: { CLAUDE_CODE_TASK_ID: 'fresh-task' } } });
  assert.equal(hookRun(input(freshOwner, { background_tasks: [{ id: 'fresh-task', status: 'running' }] })).output, null);
  record(freshOwner, 'finished', 'fresh-exit-worker', { ...fresh, event: 'finished', pid: 2147483647, exit: 0 });
  assert.match(hookRun(input(freshOwner, { background_tasks: [] })).output.reason, /fresh-exit-worker.*read/,
    'an exit after the previous Stop cannot be silently acknowledged merely because its task disappeared');
  const mixedOwner = 'mixed-finish-owner';
  record(mixedOwner, 'finished', 'reported-result', { thread: 'reported-thread', followerCommand: 'start', pid: 2147483647,
    launcher: { sessionId: mixedOwner, env: { CLAUDE_CODE_TASK_ID: 'mixed-task' } } });
  record(mixedOwner, 'finished', 'unknown-result');
  const mixedOutput = hookRun(input(mixedOwner, { background_tasks: [{ id: 'mixed-task', status: 'completed' }] })).output;
  assert.match(mixedOutput.reason, /unknown-result.*read/);
  assert.doesNotMatch(mixedOutput.reason, /reported-result/);
  assert.equal(inbox(readEvents(), mixedOwner, readAck(mixedOwner)).pending.length, 0, 'mixed batches commit both reported and newly delivered results');
  const malformedOwner = 'malformed-stop-state';
  const malformed = record(malformedOwner, 'finished', 'malformed-state-result', { thread: 'malformed-thread', followerCommand: 'turn', pid: 2147483647 });
  fs.writeFileSync(path.join(tmp, 'worker-stop-state', path.basename(ackFile(malformedOwner))),
    JSON.stringify({ stopAt: Date.now() + 1000, registrations: { [malformed.runId]: 'invalid registration' } }));
  assert.match(hookRun(input(malformedOwner, { background_tasks: [] })).output.reason, /malformed-state-result.*read/,
    'invalid saved registrations never silently acknowledge a completion');
  for (const [label, tasks, changes] of [
    ['unknown-registry', undefined, {}], ['unmatched-task', [{ id: 'other', status: 'completed' }], {}],
    ['still-running', [{ id: 'reported-task', status: 'running' }], {}],
    ['command-only-report', [{ command: `node ${worker} turn --thread uncertain-thread`, status: 'completed' }], {}],
    ['uncertain-exit', [{ id: 'reported-task', status: 'completed' }], { mayRun: true }],
    ['failed-exit', [{ id: 'reported-task', status: 'completed' }], { exit: 1 }],
  ]) {
    const owner = `uncertain-${label}`;
    record(owner, 'finished', label, { thread: 'uncertain-thread', followerCommand: 'turn', pid: 2147483647,
      launcher: { sessionId: owner, env: { CLAUDE_CODE_TASK_ID: 'reported-task' } }, ...changes });
    assert.match(hookRun(input(owner, { background_tasks: tasks })).output.reason, new RegExp(`${label}.*read`), 'uncertain completions must be delivered');
  }
  console.log('PASS wrapper paths, command-only turns, live ancestry, opt-in capture and reported/uncertain completion acknowledgements');
  const question = record('d64c0df5-e473-5bde-89e1-ef3e50df1846', 'question', 'live-start', { thread: 'start-thread', questionId: 'open-choice',
    timeoutMin: 20, expiresAt: Date.now() + 1200000, text: 'Which choice?' });
  deliver('d64c0df5-e473-5bde-89e1-ef3e50df1846', () => {}); // Acknowledgement does not answer an ask.
  assert.match(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846', { background_tasks: followers })).output.reason, /live-start.*open ask open-choice/);
  record('d64c0df5-e473-5bde-89e1-ef3e50df1846', 'answered', 'live-start', { thread: 'start-thread', questionId: question.questionId, text: 'Proceed' });
  assert.equal(hookRun(input('d64c0df5-e473-5bde-89e1-ef3e50df1846', { background_tasks: followers })).output, null);

  // One process exit batches three completions; default notes join the batch without triggering it.
  const burst = start(worker, ['watch', '--owner', '9788877b-1811-5b8a-9707-0047ae923d8e', '--debounce-sec', '0.8']);
  await until(() => hasWatcher('9788877b-1811-5b8a-9707-0047ae923d8e'), 'burst watcher armed');
  record('9788877b-1811-5b8a-9707-0047ae923d8e', 'message', 'info-peer', { kind: 'info', text: 'Deferred finding', wake: false });
  await new Promise((r) => setTimeout(r, 200)); assert.equal(burst.output(), '');
  const burstAt = Date.now();
  record('9788877b-1811-5b8a-9707-0047ae923d8e', 'finished', 'finish-one');
  await new Promise((r) => setTimeout(r, 180));
  record('9788877b-1811-5b8a-9707-0047ae923d8e', 'finished', 'finish-two');
  await new Promise((r) => setTimeout(r, 180));
  record('9788877b-1811-5b8a-9707-0047ae923d8e', 'finished', 'finish-three');
  assert.equal(burst.output(), '', 'watch stays alive during the debounce');
  const burstResult = await burst.done;
  assert.equal(burstResult.code, 0); assert.ok(Date.now() - burstAt >= 800);
  assert.equal(burstResult.stdout.trim().split('\n').length, 4);
  for (const name of ['finish-one', 'finish-two', 'finish-three', 'Deferred finding']) assert.ok(burstResult.stdout.includes(name));
  assert.equal(inbox(readEvents(), '9788877b-1811-5b8a-9707-0047ae923d8e', readAck('9788877b-1811-5b8a-9707-0047ae923d8e')).pending.length, 0);

  // A short ask arriving after a risk caps the existing window to leave 80% of its timeout.
  const shortAskWatch = start(worker, ['watch', '--owner', '39884b13-e4df-585b-b363-f58e5dcf13d8', '--debounce-sec', '45']);
  await until(() => hasWatcher('39884b13-e4df-585b-b363-f58e5dcf13d8'), 'short ask watcher armed');
  record('39884b13-e4df-585b-b363-f58e5dcf13d8', 'message', 'risk-worker', { kind: 'risk', wake: true, text: 'Decision now' });
  await new Promise((r) => setTimeout(r, 200));
  const shortAsk = record('39884b13-e4df-585b-b363-f58e5dcf13d8', 'question', 'asking-worker', { thread: 'asking-thread', questionId: 'short-choice',
    timeoutMin: 0.05, expiresAt: Date.now() + 3000, text: 'Short choice?', default: 'Continue' });
  const askResult = await shortAskWatch.done;
  assert.equal(askResult.code, 0); assert.match(askResult.stdout, /Short choice/); assert.match(askResult.stdout, /Decision now/);
  // Check the deadline used by the watcher, independent of child exit/IO scheduling.
  const scheduled = watchDeadline(shortAsk.t + 45000, [shortAsk]);
  assert.equal(scheduled, shortAsk.expiresAt - 2400, 'short ask schedules delivery with at least 80% of its timeout reserved');
  assert.equal(watchDeadline(scheduled - 1, [shortAsk]), scheduled - 1, 'an earlier batch deadline is never extended');
  assert.equal(watchDeadline(scheduled + 100, [shortAsk, { ...shortAsk, expiresAt: shortAsk.expiresAt - 50 }]),
    scheduled - 50, 'every late ask can shorten the existing batch deadline');
  const legacyAskWatch = start(worker, ['watch', '--owner', 'c496ca32-27f9-52e7-9bd0-ee6639810512', '--debounce-sec', '45']);
  await until(() => hasWatcher('c496ca32-27f9-52e7-9bd0-ee6639810512'), 'legacy ask watcher armed');
  record('c496ca32-27f9-52e7-9bd0-ee6639810512', 'question', 'legacy-asking-worker', { questionId: 'legacy-choice', text: 'Legacy ask', expiresAt: Date.now() + 3000 });
  const legacyAt = Date.now();
  assert.match((await legacyAskWatch.done).stdout, /Legacy ask/);
  assert.ok(Date.now() - legacyAt < 1500, 'missing deadline metadata flushes rather than stranding the watcher');
  const immediateAt = Date.now();
  record('33e4fb54-b15d-5147-a38b-037ff95cd47a', 'finished', 'immediate-finish');
  const immediate = await start(worker, ['watch', '--owner', '33e4fb54-b15d-5147-a38b-037ff95cd47a', '--debounce-sec', '0']).done;
  assert.match(immediate.stdout, /immediate-finish/); assert.ok(Date.now() - immediateAt < 1500);
  const missingDebounce = await start(worker, ['watch', '--owner', '4a001394-5dd5-5074-957e-ebc89e5b23b7', '--debounce-sec']).done;
  assert.equal(missingDebounce.code, 1); assert.match(missingDebounce.stderr, /nonnegative finite/);
  for (const bad of ['-1', 'NaN', 'Infinity']) {
    const invalid = await start(worker, ['watch', '--owner', '4a001394-5dd5-5074-957e-ebc89e5b23b7', '--debounce-sec', bad]).done;
    assert.equal(invalid.code, 1); assert.match(invalid.stderr, /nonnegative finite/);
  }
  record('95f8112e-5c9c-5c4d-838c-4a0b726da928', 'finished', 'not-an-orchestrator');
  assert.equal(hookRun(input('95f8112e-5c9c-5c4d-838c-4a0b726da928', { session_title: 'worker' })).output, null);
  assert.equal(inbox(readEvents(), '95f8112e-5c9c-5c4d-838c-4a0b726da928', readAck('95f8112e-5c9c-5c4d-838c-4a0b726da928')).pending.length, 1);
  for (const malformed of ['{', 'null', '[]', '{"session_id":"../../oops"}', 'x'.repeat(70000)]) assert.equal(hookRun(malformed).output, null);
  const idleStart = performance.now(), idleHook = start(hook, []);
  const idleResult = await idleHook.done;
  assert.equal(idleResult.code, 0); assert.equal(idleResult.stdout, ''); assert.equal(idleResult.stderr, '');
  assert.ok(performance.now() - idleStart < 2000, 'unterminated stdin is bounded by the settings timeout');
  const stalledIO = path.join(tmp, 'inbox-6fadc195-4335-5258-9dff-7aeeede10d33.mjs');
  fs.writeFileSync(stalledIO, `import fs from 'node:fs/promises';
const open = fs.open;
fs.open = (file, ...args) => String(file).endsWith('worker-events.jsonl') ? new Promise(() => {}) : open(file, ...args);
`);
  const stalledStart = performance.now();
  const ioResult = spawnSync(process.execPath, ['--import', stalledIO, hook], { env, input: JSON.stringify(input('6fadc195-4335-5258-9dff-7aeeede10d33')), encoding: 'utf8', timeout: 1000 });
  assert.equal(ioResult.status, 0); assert.equal(ioResult.stdout, ''); assert.equal(ioResult.stderr, '');
  assert.ok(performance.now() - stalledStart < 2000, 'stalled event I/O is bounded by the settings timeout');
  assert.equal(fs.existsSync(`${ackFile('6fadc195-4335-5258-9dff-7aeeede10d33')}.lock`), false, 'the hard deadline releases its acknowledgement lock');
  const bridgeFile = path.join(tmp, 'session-env');
  record('a6f5dce8-4000-5b6d-bee3-14d80d401e3c', 'finished', 'resume-result');
  assert.match(hookRun(input('a6f5dce8-4000-5b6d-bee3-14d80d401e3c', { hook_event_name: 'SessionStart', source: 'resume' }), { CLAUDE_ENV_FILE: bridgeFile }).output.hookSpecificOutput.additionalContext, /resume-result/);
  assert.equal(fs.readFileSync(bridgeFile, 'utf8'), "\nexport ORCHESTRATOR_OWNER='a6f5dce8-4000-5b6d-bee3-14d80d401e3c'\n");
  record('d3d36a45-a238-5c7d-a389-bb44cce77108', 'finished', 'compact-result');
  assert.equal(hookRun(input('d3d36a45-a238-5c7d-a389-bb44cce77108', { hook_event_name: 'SessionStart', source: 'compact' })).output.hookSpecificOutput.hookEventName, 'SessionStart');
  fs.appendFileSync(eventFile(), '{bad\n{"torn":');
  record('dfdf7132-3852-5215-89aa-a70df04f2739', 'finished', 'recovered');
  assert.equal(inbox(readEvents(), 'dfdf7132-3852-5215-89aa-a70df04f2739', readAck('dfdf7132-3852-5215-89aa-a70df04f2739')).pending.length, 1);
  fs.mkdirSync(`${eventFile()}.lock`);
  fs.writeFileSync(path.join(`${eventFile()}.lock`, 'writer.json'), '{"pid":2147483647}');
  const recoveredAt = Date.now(); record('dfad3748-cb1e-58f6-bb58-1c5e4e30ba44', 'finished', 'dead-lock-recovered');
  assert.ok(Date.now() - recoveredAt < 300, 'a dead writer cannot suppress the next completion for the stale timeout');
  record('1998e3ab-77f8-576f-bed8-c43d41ee569c', 'finished', 'locked');
  fs.mkdirSync(`${ackFile('1998e3ab-77f8-576f-bed8-c43d41ee569c')}.lock`);
  assert.equal(hookRun(input('1998e3ab-77f8-576f-bed8-c43d41ee569c')).output, null); assert.equal(readAck('1998e3ab-77f8-576f-bed8-c43d41ee569c').delivered.locked, undefined);
  fs.rmdirSync(`${ackFile('1998e3ab-77f8-576f-bed8-c43d41ee569c')}.lock`);
  for (let i = 0; i < 12; i++) record('52c19b1c-eb39-564a-ad8a-0135bad11c25', 'finished', `batch-${i}`);
  hookRun(input('52c19b1c-eb39-564a-ad8a-0135bad11c25'));
  assert.equal(inbox(readEvents(), '52c19b1c-eb39-564a-ad8a-0135bad11c25', readAck('52c19b1c-eb39-564a-ad8a-0135bad11c25')).pending.length, 2, 'acknowledge only the printed batch');
  hookRun(input('52c19b1c-eb39-564a-ad8a-0135bad11c25', { stop_hook_active: true }));
  assert.equal(inbox(readEvents(), '52c19b1c-eb39-564a-ad8a-0135bad11c25', readAck('52c19b1c-eb39-564a-ad8a-0135bad11c25')).pending.length, 2, 'continuation leaves the remaining events pending');
  hookRun(input('52c19b1c-eb39-564a-ad8a-0135bad11c25'));
  assert.equal(inbox(readEvents(), '52c19b1c-eb39-564a-ad8a-0135bad11c25', readAck('52c19b1c-eb39-564a-ad8a-0135bad11c25')).pending.length, 0);
  fs.writeFileSync(ackFile('e1f0407e-aaac-58ab-939a-605afe27cc89'), '{"owner":"e1f0407e-aaac-58ab-939a-605afe27cc89","delivered":null}');
  record('e1f0407e-aaac-58ab-939a-605afe27cc89', 'finished', 'malformed-ack');
  assert.equal(hookRun(input('e1f0407e-aaac-58ab-939a-605afe27cc89')).output.decision, 'block');
  const writerModule = path.join(scripts, 'lib/worker-events.mjs');
  const writers = Array.from({ length: 5 }, (_, n) => start('--input-type=module', ['-e',
    `import { appendEvent } from ${JSON.stringify(writerModule)}; for (let i=0;i<4;i++) appendEvent({owner:'122a109b-2a61-5825-8365-fac5be9ea130',runId:'${n}-'+i,event:'finished',name:'concurrent'});`]));
  for (const writer of writers) assert.equal((await writer.done).code, 0);
  assert.equal(inbox(readEvents(), '122a109b-2a61-5825-8365-fac5be9ea130', readAck('122a109b-2a61-5825-8365-fac5be9ea130')).pending.length, 20);
  const raceA = start(worker, ['watch', '--debounce-sec', '0', '--owner', '2b854d9d-5960-5be6-a93a-a2c354a39b99']), raceB = start(worker, ['watch', '--debounce-sec', '0', '--owner', '2b854d9d-5960-5be6-a93a-a2c354a39b99']);
  await until(() => hasWatcher('2b854d9d-5960-5be6-a93a-a2c354a39b99'), 'racing watchers armed');
  record('2b854d9d-5960-5be6-a93a-a2c354a39b99', 'finished', 'race-event');
  await until(() => (raceA.output() + raceB.output()).includes('race-event'), 'one racing watcher delivered');
  await new Promise((r) => setTimeout(r, 180));
  assert.equal((raceA.output() + raceB.output()).split('race-event').length - 1, 1, 'one claimed watcher delivers; the redundant watcher exits');
  assert.equal((await raceA.done).code, 0); assert.equal((await raceB.done).code, 0);

  for (const command of ['start', 'turn', 'wait']) {
    const r = follow(`success-${command}`, command, command === 'wait' ? { status: 'completed' } : {});
    assert.equal(r.status, 0, r.stderr); assert.equal(r.event.event, 'finished'); assert.equal(r.event.owner, '47ba610f-34a8-5362-a84d-d009bffc3f5f');
  }
  assert.equal(follow('failed-turn', 'start', { fail: true }).event.event, 'failed');
  const lost = follow('lost-before-reply', 'start', { lostAtTurnStart: true, thread: 'lost-thread' });
  assert.equal(lost.event.event, 'failed'); assert.equal(lost.event.mayRun, true, 'losing the start reply does not prove the hub stopped');
  assert.equal(follow('blocked-turn', 'start', { final: 'BLOCKED missing user input' }).event.event, 'needs-user');
  assert.equal(follow('stalled-turn', 'start', { hold: true, fastStall: true }, ['--stall-min', '0.001']).event.event, 'stalled');
  const invalid = spawnSync(process.execPath, [worker, 'start', '--owner', '47ba610f-34a8-5362-a84d-d009bffc3f5f', '--name', 'invalid'], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.equal(readEvents().filter((row) => row.name === 'invalid').at(-1).event, 'failed');
  const fallback = spawnSync(process.execPath, [worker, 'start', '--name', 'fallback-identity'], { env: { ...env, CLAUDE_JOB_DIR: '/tmp/jobs/job-only' }, encoding: 'utf8' });
  assert.equal(fallback.status, 2);
  const fallbackEvent = readEvents().filter((row) => row.name === 'fallback-identity').at(-1);
  assert.equal(fallbackEvent.owner, null); assert.equal(fallbackEvent.launcher.sessionId, null);
  assert.equal(fallbackEvent.launcher.jobId, 'job-only', 'job directories remain launcher metadata, never session owners');
  const rpc = path.join(tmp, 'sigterm-rpc.jsonl');
  const sig = start('--import', [fixture, worker, 'start', '--owner', '47ba610f-34a8-5362-a84d-d009bffc3f5f', '--name', 'term', '--cwd', tmp,
    '--sandbox', 'read-only', '--effort', 'high', '--model', 'fixture', 'Follow the fixture brief.'], { WORKER_EVENTS_FIXTURE: JSON.stringify({ hold: true, rpc, thread: 'term-thread', turn: 'term-turn' }) });
  await until(() => sig.output().includes('thread=term-thread turn=term-turn'), 'follower attached'); sig.child.kill('SIGTERM');
  assert.equal((await sig.done).code, 143);
  const ended = readEvents().filter((row) => row.name === 'term').at(-1);
  assert.equal(ended.event, 'follower-ended'); assert.equal(ended.mayRun, true);
  const mine = spawnSync(process.execPath, ['--import', fixture, worker, 'mine', '--owner', '47ba610f-34a8-5362-a84d-d009bffc3f5f'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(mine.status, 0, mine.stderr); assert.match(mine.stdout, /term\trunning \(hub\)/);
  const settledRows = [{ owner: '1e4cc373-42f2-56c1-9c01-6a1a5fc5d8b5', runId: 'old', id: 'old', event: 'follower-ended', account: 'main', thread: 'same', turn: 'turn', mayRun: true },
    { owner: '1e4cc373-42f2-56c1-9c01-6a1a5fc5d8b5', runId: 'new', id: 'new', event: 'finished', account: 'main', thread: 'same', turn: 'turn', mayRun: false }];
  assert.equal(inbox(settledRows, '1e4cc373-42f2-56c1-9c01-6a1a5fc5d8b5').running.length, 0);

  for (const [name, command, code] of [['exec-ok', [process.execPath, '-e', 'process.exit(0)'], 0],
    ['exec-fail', [process.execPath, '-e', 'process.exit(5)'], 5], ['exec-spawn-fail', ['/nonexistent/fixture-executable'], 1]]) {
    const r = spawnSync('/bin/sh', [path.join(scripts, 'run-tracked.sh'), '--name', name, '--owner', 'b8daa022-ad98-5b75-865f-894a749982dd', '--account', 'fixture', '--model', 'fixture', '--', ...command], { env, encoding: 'utf8' });
    assert.equal(r.status, code, r.stderr);
    const rows = readEvents().filter((row) => row.name === name); assert.equal(rows.length, 2);
    assert.equal(rows.at(-1).exit, code); assert.equal(rows.at(-1).event, code === 0 ? 'finished' : 'failed');
  }
  const tracked = path.join(scripts, 'run-tracked.mjs');
  const staleOut = path.join(tmp, 'stale-exec.md'); fs.writeFileSync(staleOut, 'BLOCKED previous run\n');
  const stale = spawnSync(process.execPath, [tracked, '--name', 'stale-exec', '--owner', 'b8daa022-ad98-5b75-865f-894a749982dd', '--out', staleOut,
    '--', '/nonexistent/fixture-executable'], { env, encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.equal(readEvents().filter((row) => row.name === 'stale-exec').at(-1).event, 'failed', 'do not reuse an earlier final message');
  assert.equal(readEvents().filter((row) => row.name === 'stale-exec').at(-1).finalLine, '');
  const execTerm = start(tracked, ['--name', 'exec-term', '--owner', 'b8daa022-ad98-5b75-865f-894a749982dd', '--', process.execPath, '-e', 'setInterval(()=>{}, 1000); console.log("ready")']);
  await until(() => execTerm.output().includes('ready'), 'tracked child ready'); execTerm.child.kill('SIGTERM');
  assert.equal((await execTerm.done).code, 143);
  assert.equal(readEvents().filter((row) => row.name === 'exec-term').at(-1).event, 'follower-ended');
  const audit = auditWorkerEvents();
  assert.equal(audit.find((row) => row.owner === '59970f96-5c74-5706-97c4-fa55b3438de4').acknowledged, 1);
  assert.equal(audit.find((row) => row.owner === '43a535be-2703-585a-a301-ed7fb53ad82c').unacknowledged, 1);
  assert.ok(audit.find((row) => row.owner === '59970f96-5c74-5706-97c4-fa55b3438de4').finishToAckMs.max >= 0);
  const old = record('ebb69aa7-c442-5a3d-a152-0ce3dec3bd96', 'finished', 'old-event', { launcher: {} });
  const oldAudit = auditWorkerEvents([{ ...old, t: 1 }, { ...old, id: 'launch', event: 'running', t: Date.now() }], Date.now() - 1000);
  assert.equal(oldAudit[0].totalUnacknowledged, 1); assert.equal(oldAudit[0].unacknowledged, 0); assert.equal(oldAudit[0].launchesWithoutIdentity, 1);
  console.log(`PASS worker inbox: durable exits, owners, watch/ack, Stop/SessionStart, loop guard, malformed/torn input, SIGTERM/hub mine, exec errors, audit; hook ${blocked.ms.toFixed(1)}ms`);
} finally {
  for (const child of children) child.kill('SIGTERM');
  if (original === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = original;
  fs.rmSync(tmp, { recursive: true, force: true });
}
