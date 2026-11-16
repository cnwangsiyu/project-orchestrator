#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEvent, eventFile, ackFile, readEvents, readAck, inbox, deliver, hasWatcher, auditWorkerEvents,
  launcherIdentity, resolveOwner } from '../lib/worker-events.mjs';
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
  const args = ['--import', fixture, worker, command, '--owner', 'worker-owner', '--name', name,
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
  assert.equal(resolveOwner('override', { CLAUDE_SESSION_ID: 'env-owner' }), 'override');
  assert.equal(resolveOwner(null, { ORCHESTRATOR_OWNER: 'bridge' }), 'bridge');
  assert.equal(resolveOwner(null, { CLAUDE_JOB_DIR: '/tmp/jobs/job-fallback' }), 'job-fallback');
  assert.deepEqual(launcherIdentity(null, { API_KEY: 'do-not-record', CLAUDECODE: '1' }).env, { CLAUDECODE: '1' });
  fs.writeFileSync(path.join(tmp, 'final.md'), 'DONE first final line\nsecond line\n');
  const waiting = start(worker, ['watch', '--debounce-sec', '0', '--owner', 'owner-A']);
  await until(() => hasWatcher('owner-A'), 'watch armed');
  record('owner-B', 'finished', 'B');
  await new Promise((r) => setTimeout(r, 220)); assert.equal(waiting.output(), '', 'watch blocks, owner B does not wake A');
  const a = record('owner-A', 'finished', 'A');
  const wake = await waiting.done; assert.equal(wake.code, 0); assert.match(wake.stdout, /A\tfinished.*DONE first final line/);
  assert.ok(readAck('owner-A').delivered[a.id]); assert.equal(hasWatcher('owner-A'), false);
  assert.equal(inbox(readEvents(), 'owner-B', readAck('owner-B')).pending.length, 1);
  assert.equal(inbox(readEvents(), 'owner-A', readAck('owner-A')).pending.length, 0);
  const printing = record('print-owner', 'finished', 'print-fail');
  assert.throws(() => deliver('print-owner', () => { throw Error('closed stdout'); }));
  assert.equal(readAck('print-owner').delivered[printing.id], undefined);

  const hookEvent = record('hook-owner', 'finished', 'hook-finished');
  const blocked = hookRun(input('hook-owner')); assert.equal(blocked.output.decision, 'block');
  assert.match(blocked.output.reason, /hook-finished.*read/); assert.ok(readAck('hook-owner').delivered[hookEvent.id]);
  assert.ok(blocked.ms < 2000, `hook: ${blocked.ms}ms (settings timeout)`);
  assert.equal(hookRun(input('hook-owner')).output, null);
  record('running-owner', 'running', 'running-worker');
  assert.match(hookRun(input('running-owner')).output.reason, /arm the watcher:.*watch --owner running-owner/);
  assert.equal(hookRun(input('running-owner', { stop_hook_active: true })).output, null, 'block watcher request once');
  record('running-owner', 'finished', 'new-result');
  assert.equal(hookRun(input('running-owner', { stop_hook_active: true })).output, null, 'new completions never bypass the stop-cycle guard');
  hookRun(input('running-owner'));
  const armed = start(worker, ['watch', '--debounce-sec', '0', '--owner', 'running-owner']);
  await until(() => hasWatcher('running-owner'), 'second watcher armed');
  assert.equal(hookRun(input('running-owner')).output, null);
  assert.match(hookRun(input('running-owner', { background_tasks: [] })).output.reason, /arm the watcher/, 'an untracked live watcher is not enough when the registry is available');
  assert.equal(hookRun(input('running-owner', { background_tasks: [{ type: 'shell', command: `node '${worker}' watch --owner 'running-owner'` }] })).output, null);
  assert.match(hookRun(input('running-owner', { background_tasks: [{ type: 'shell', command: `node '${worker}' watch --owner running-owner-other` }] })).output.reason, /arm the watcher/);
  // BC-56: the node path, the task type label and an env-supplied owner must not hide an armed watcher; the block says which check failed.
  for (const task of [{ type: 'local_bash', command: `/usr/local/Cellar/node/26.12.0/bin/node "${worker}" watch --owner running-owner 2>&1` },
    { type: 'shell', command: `cd /tmp && node ${worker} --account trae watch --owner=running-owner` },
    { command: `ORCHESTRATOR_OWNER=running-owner node ${worker} watch` },
    { type: 'shell', command: `node ${worker} watch --owner running-owner; echo "watch exit $?"` }])
    assert.equal(hookRun(input('running-owner', { background_tasks: [task] })).output, null, task.command);
  assert.match(hookRun(input('running-owner', { background_tasks: [] })).output.reason, /watcher claim live; background tasks 0 listed, 0 run a watcher/);
  armed.child.kill('SIGTERM'); assert.equal((await armed.done).code, 143); assert.equal(hasWatcher('running-owner'), false);
  // Live followers cover completion notifications only when their tracked launches match every worker.
  record('followers-owner', 'running', 'live-start', { thread: 'start-thread', pid: process.pid, followerCommand: 'start', launcher: { sessionId: 'followers-owner', env: { CLAUDE_CODE_TASK_ID: 'start-task' } } });
  record('followers-owner', 'running', 'live-turn', { thread: 'turn-thread', pid: process.pid, followerCommand: 'turn', launcher: { sessionId: 'followers-owner', env: { CLAUDE_CODE_TASK_ID: 'turn-task' } } });
  const followers = [
    { command: `node "${worker}" --account fixture start --owner followers-owner --name live-start`, id: 'start-task' },
    { command: `node "${worker}" --account fixture turn --owner followers-owner --thread turn-thread`, id: 'turn-task' }
  ];
  assert.equal(hookRun(input('followers-owner', { background_tasks: followers })).output, null);
  assert.match(hookRun(input('followers-owner', { background_tasks: followers.slice(0, 1) })).output.reason, /live-turn.*no matching tracked/);
  assert.match(hookRun(input('followers-owner')).output.reason, /live-start.*background_tasks missing/);
  for (const change of [{ pid: 2147483647 }, { status: 'completed' }, { command: followers[0].command + ' &' },
    { id: 'another-project-task' }]) {
    assert.match(hookRun(input('followers-owner', { background_tasks: [{ ...followers[0], ...change }, followers[1]] })).output.reason, /live-start/);
  }
  assert.equal(hookRun(input('followers-owner', { background_tasks: [
    { id: 'start-task', command: 'bash /fixture/task/launch.sh', status: 'running' },
    { id: 'turn-task', command: `node ${worker} --account trae turn --thread turn-thread`, status: 'running' }
  ] })).output, null, 'wrappers and direct turns use recorded task identity');
  assert.match(hookRun(input('followers-owner', { background_tasks: [
    { command: followers[0].command }, followers[1]
  ] })).output.reason, /live-start/, 'matching command text without task identity cannot prove coverage');
  assert.match(hookRun(input('followers-owner', { background_tasks: [null, followers[1]] })).output.reason, /live-start/, 'malformed registry entries cannot establish follower coverage');
  const wrapper = record('wrapper-owner', 'running', 'wrapper-worker', { thread: 'wrapper-thread', pid: process.pid,
    followerCommand: 'start', outFile: '/x/task-foo/report.md', logFile: '/x/task-foo/worker.jsonl' });
  assert.equal(hookRun(input('wrapper-owner', { background_tasks: [{ command: 'bash /x/task-foo/launch.sh' }] })).output, null,
    'command-only background task is matched to the recorded task directory');
  assert.ok(await matchingBackgroundTask(wrapper, [{ command: 'bash /x/task-foo/launch.sh; echo finished' }], 'wrapper-owner'),
    'a shell separator after the wrapper path preserves coverage');
  const launchDirRow = { ...wrapper, outFile: null, logFile: null, launcher: { sessionId: 'wrapper-owner', taskDir: '/x/task-foo' } };
  assert.ok(await matchingBackgroundTask(launchDirRow, [{ command: 'bash /x/task-foo/launch.sh' }], 'wrapper-owner'), 'explicit launch-record task directory covers its wrapper');
  assert.ok(await matchingBackgroundTask({ ...launchDirRow, ancestorPids: {} }, [{ command: 'bash /x/task-foo/launch.sh' }], 'wrapper-owner'),
    'malformed optional ancestry does not prevent matching the recorded task path');
  assert.ok(await matchingBackgroundTask(launchDirRow, [{ command: 'bash /x/task-foo/scripts/run.sh' }], 'wrapper-owner'),
    'an explicitly recorded task directory covers its nested wrapper');
  assert.equal(await matchingBackgroundTask(wrapper, [{ command: 'bash /x/task-foo/task-other/launch.sh' }], 'wrapper-owner'), null,
    'an inferred output directory cannot cover another nested task');
  assert.match(hookRun(input('wrapper-owner', { background_tasks: [{ command: 'bash /x/task-foobar/launch.sh' }] })).output.reason, /arm the watcher/,
    'a task directory prefix does not cover another task');
  assert.match(hookRun(input('wrapper-owner', { background_tasks: [{ command: 'bash /x/task-foo/launch.sh', status: 'completed' }] })).output.reason, /arm the watcher/);
  const directTurn = record('direct-owner', 'running', 'direct-worker', { thread: 'direct-thread', pid: process.pid,
    followerCommand: 'turn', outFile: null });
  assert.equal(hookRun(input('direct-owner', { background_tasks: [{ unknown_type: 'shell', command: `node ${worker} turn --thread direct-thread` }] })).output, null);
  assert.match(hookRun(input('direct-owner', { background_tasks: [{ command: `node ${worker} turn --thread direct-thread-other` }] })).output.reason, /arm the watcher/);
  // Exercise live ps ancestry without recorded ancestorPids or a matching output directory.
  const nested = start(path.join(scripts, 'test/fixtures/worker-background-child.mjs'), []);
  await until(() => nested.output().includes('ready'), 'nested follower ready');
  const childPid = Number(nested.output().trim().split(' ')[1]);
  const ancestorRow = { ...wrapper, pid: childPid, parentPid: undefined, ancestorPids: [], outFile: null, logFile: null };
  assert.ok(await matchingBackgroundTask(ancestorRow, [{ id: String(nested.child.pid) }], 'wrapper-owner', { ancestryTimeoutMs: 3000 }), 'numeric task id matches live process ancestry');
  assert.ok(await matchingBackgroundTask(ancestorRow, [{ command: `${process.execPath} ${path.join(scripts, 'test/fixtures/worker-background-child.mjs')}` }], 'wrapper-owner', { ancestryTimeoutMs: 3000 }),
    'registered wrapper command matches live parent command');
  nested.child.kill('SIGTERM'); await nested.done;

  const capture = path.join(tmp, 'hook-capture/last-stop.json');
  assert.equal(fs.existsSync(capture), false, 'capture is off by default');
  hookRun(input('capture-owner', { background_tasks: [{ id: 'public-id', command: 'x'.repeat(400), status: 'running',
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
  const question = record('followers-owner', 'question', 'live-start', { thread: 'start-thread', questionId: 'open-choice',
    timeoutMin: 20, expiresAt: Date.now() + 1200000, text: 'Which choice?' });
  deliver('followers-owner', () => {}); // Acknowledgement does not answer an ask.
  assert.match(hookRun(input('followers-owner', { background_tasks: followers })).output.reason, /live-start.*open ask open-choice/);
  record('followers-owner', 'answered', 'live-start', { thread: 'start-thread', questionId: question.questionId, text: 'Proceed' });
  assert.equal(hookRun(input('followers-owner', { background_tasks: followers })).output, null);

  // One process exit batches three completions; default notes join the batch without triggering it.
  const burst = start(worker, ['watch', '--owner', 'burst-owner', '--debounce-sec', '0.8']);
  await until(() => hasWatcher('burst-owner'), 'burst watcher armed');
  record('burst-owner', 'message', 'info-peer', { kind: 'info', text: 'Deferred finding', wake: false });
  await new Promise((r) => setTimeout(r, 200)); assert.equal(burst.output(), '');
  const burstAt = Date.now();
  record('burst-owner', 'finished', 'finish-one');
  await new Promise((r) => setTimeout(r, 180));
  record('burst-owner', 'finished', 'finish-two');
  await new Promise((r) => setTimeout(r, 180));
  record('burst-owner', 'finished', 'finish-three');
  assert.equal(burst.output(), '', 'watch stays alive during the debounce');
  const burstResult = await burst.done;
  assert.equal(burstResult.code, 0); assert.ok(Date.now() - burstAt >= 800);
  assert.equal(burstResult.stdout.trim().split('\n').length, 4);
  for (const name of ['finish-one', 'finish-two', 'finish-three', 'Deferred finding']) assert.ok(burstResult.stdout.includes(name));
  assert.equal(inbox(readEvents(), 'burst-owner', readAck('burst-owner')).pending.length, 0);

  // A short ask arriving after a risk caps the existing window to leave 80% of its timeout.
  const shortAskWatch = start(worker, ['watch', '--owner', 'short-ask-owner', '--debounce-sec', '45']);
  await until(() => hasWatcher('short-ask-owner'), 'short ask watcher armed');
  record('short-ask-owner', 'message', 'risk-worker', { kind: 'risk', wake: true, text: 'Decision now' });
  await new Promise((r) => setTimeout(r, 200));
  const shortAsk = record('short-ask-owner', 'question', 'asking-worker', { thread: 'asking-thread', questionId: 'short-choice',
    timeoutMin: 0.05, expiresAt: Date.now() + 3000, text: 'Short choice?', default: 'Continue' });
  const askResult = await shortAskWatch.done;
  assert.equal(askResult.code, 0); assert.match(askResult.stdout, /Short choice/); assert.match(askResult.stdout, /Decision now/);
  assert.ok(Date.now() <= shortAsk.expiresAt - 2400 + 150, 'short ask keeps at least 80% of timeout, within scheduler tolerance');
  const legacyAskWatch = start(worker, ['watch', '--owner', 'legacy-ask-owner', '--debounce-sec', '45']);
  await until(() => hasWatcher('legacy-ask-owner'), 'legacy ask watcher armed');
  record('legacy-ask-owner', 'question', 'legacy-asking-worker', { questionId: 'legacy-choice', text: 'Legacy ask', expiresAt: Date.now() + 3000 });
  const legacyAt = Date.now();
  assert.match((await legacyAskWatch.done).stdout, /Legacy ask/);
  assert.ok(Date.now() - legacyAt < 1500, 'missing deadline metadata flushes rather than stranding the watcher');
  const immediateAt = Date.now();
  record('immediate-owner', 'finished', 'immediate-finish');
  const immediate = await start(worker, ['watch', '--owner', 'immediate-owner', '--debounce-sec', '0']).done;
  assert.match(immediate.stdout, /immediate-finish/); assert.ok(Date.now() - immediateAt < 1500);
  const missingDebounce = await start(worker, ['watch', '--owner', 'invalid-owner', '--debounce-sec']).done;
  assert.equal(missingDebounce.code, 1); assert.match(missingDebounce.stderr, /nonnegative finite/);
  for (const bad of ['-1', 'NaN', 'Infinity']) {
    const invalid = await start(worker, ['watch', '--owner', 'invalid-owner', '--debounce-sec', bad]).done;
    assert.equal(invalid.code, 1); assert.match(invalid.stderr, /nonnegative finite/);
  }
  record('regular-owner', 'finished', 'not-an-orchestrator');
  assert.equal(hookRun(input('regular-owner', { session_title: 'worker' })).output, null);
  assert.equal(inbox(readEvents(), 'regular-owner', readAck('regular-owner')).pending.length, 1);
  for (const malformed of ['{', 'null', '[]', '{"session_id":"../../oops"}', 'x'.repeat(70000)]) assert.equal(hookRun(malformed).output, null);
  const idleStart = performance.now(), idleHook = start(hook, []);
  const idleResult = await idleHook.done;
  assert.equal(idleResult.code, 0); assert.equal(idleResult.stdout, ''); assert.equal(idleResult.stderr, '');
  assert.ok(performance.now() - idleStart < 2000, 'unterminated stdin is bounded by the settings timeout');
  const stalledIO = path.join(tmp, 'inbox-stalled-io.mjs');
  fs.writeFileSync(stalledIO, `import fs from 'node:fs/promises';
const open = fs.open;
fs.open = (file, ...args) => String(file).endsWith('worker-events.jsonl') ? new Promise(() => {}) : open(file, ...args);
`);
  const stalledStart = performance.now();
  const ioResult = spawnSync(process.execPath, ['--import', stalledIO, hook], { env, input: JSON.stringify(input('stalled-io')), encoding: 'utf8', timeout: 1000 });
  assert.equal(ioResult.status, 0); assert.equal(ioResult.stdout, ''); assert.equal(ioResult.stderr, '');
  assert.ok(performance.now() - stalledStart < 2000, 'stalled event I/O is bounded by the settings timeout');
  assert.equal(fs.existsSync(`${ackFile('stalled-io')}.lock`), false, 'the hard deadline releases its acknowledgement lock');
  const bridgeFile = path.join(tmp, 'session-env');
  record('resume-owner', 'finished', 'resume-result');
  assert.match(hookRun(input('resume-owner', { hook_event_name: 'SessionStart', source: 'resume' }), { CLAUDE_ENV_FILE: bridgeFile }).output.hookSpecificOutput.additionalContext, /resume-result/);
  assert.equal(fs.readFileSync(bridgeFile, 'utf8'), "\nexport ORCHESTRATOR_OWNER='resume-owner'\n");
  record('compact-owner', 'finished', 'compact-result');
  assert.equal(hookRun(input('compact-owner', { hook_event_name: 'SessionStart', source: 'compact' })).output.hookSpecificOutput.hookEventName, 'SessionStart');
  fs.appendFileSync(eventFile(), '{bad\n{"torn":');
  record('torn-owner', 'finished', 'recovered');
  assert.equal(inbox(readEvents(), 'torn-owner', readAck('torn-owner')).pending.length, 1);
  fs.mkdirSync(`${eventFile()}.lock`);
  fs.writeFileSync(path.join(`${eventFile()}.lock`, 'writer.json'), '{"pid":2147483647}');
  const recoveredAt = Date.now(); record('dead-lock-owner', 'finished', 'dead-lock-recovered');
  assert.ok(Date.now() - recoveredAt < 300, 'a dead writer cannot suppress the next completion for the stale timeout');
  record('locked-owner', 'finished', 'locked');
  fs.mkdirSync(`${ackFile('locked-owner')}.lock`);
  assert.equal(hookRun(input('locked-owner')).output, null); assert.equal(readAck('locked-owner').delivered.locked, undefined);
  fs.rmdirSync(`${ackFile('locked-owner')}.lock`);
  for (let i = 0; i < 12; i++) record('batch-owner', 'finished', `batch-${i}`);
  hookRun(input('batch-owner'));
  assert.equal(inbox(readEvents(), 'batch-owner', readAck('batch-owner')).pending.length, 2, 'acknowledge only the printed batch');
  hookRun(input('batch-owner', { stop_hook_active: true }));
  assert.equal(inbox(readEvents(), 'batch-owner', readAck('batch-owner')).pending.length, 2, 'continuation leaves the remaining events pending');
  hookRun(input('batch-owner'));
  assert.equal(inbox(readEvents(), 'batch-owner', readAck('batch-owner')).pending.length, 0);
  fs.writeFileSync(ackFile('malformed-ack-owner'), '{"owner":"malformed-ack-owner","delivered":null}');
  record('malformed-ack-owner', 'finished', 'malformed-ack');
  assert.equal(hookRun(input('malformed-ack-owner')).output.decision, 'block');
  const writerModule = path.join(scripts, 'lib/worker-events.mjs');
  const writers = Array.from({ length: 5 }, (_, n) => start('--input-type=module', ['-e',
    `import { appendEvent } from ${JSON.stringify(writerModule)}; for (let i=0;i<4;i++) appendEvent({owner:'concurrent-owner',runId:'${n}-'+i,event:'finished',name:'concurrent'});`]));
  for (const writer of writers) assert.equal((await writer.done).code, 0);
  assert.equal(inbox(readEvents(), 'concurrent-owner', readAck('concurrent-owner')).pending.length, 20);
  const raceA = start(worker, ['watch', '--debounce-sec', '0', '--owner', 'race-owner']), raceB = start(worker, ['watch', '--debounce-sec', '0', '--owner', 'race-owner']);
  await until(() => hasWatcher('race-owner'), 'racing watchers armed');
  record('race-owner', 'finished', 'race-event');
  await until(() => (raceA.output() + raceB.output()).includes('race-event'), 'one racing watcher delivered');
  await new Promise((r) => setTimeout(r, 180));
  assert.equal((raceA.output() + raceB.output()).split('race-event').length - 1, 1, 'one claimed watcher delivers; the redundant watcher exits');
  assert.equal((await raceA.done).code, 0); assert.equal((await raceB.done).code, 0);

  for (const command of ['start', 'turn', 'wait']) {
    const r = follow(`success-${command}`, command, command === 'wait' ? { status: 'completed' } : {});
    assert.equal(r.status, 0, r.stderr); assert.equal(r.event.event, 'finished'); assert.equal(r.event.owner, 'worker-owner');
  }
  assert.equal(follow('failed-turn', 'start', { fail: true }).event.event, 'failed');
  const lost = follow('lost-before-reply', 'start', { lostAtTurnStart: true, thread: 'lost-thread' });
  assert.equal(lost.event.event, 'failed'); assert.equal(lost.event.mayRun, true, 'losing the start reply does not prove the hub stopped');
  assert.equal(follow('blocked-turn', 'start', { final: 'BLOCKED missing user input' }).event.event, 'needs-user');
  assert.equal(follow('stalled-turn', 'start', { hold: true, fastStall: true }, ['--stall-min', '0.001']).event.event, 'stalled');
  const invalid = spawnSync(process.execPath, [worker, 'start', '--owner', 'worker-owner', '--name', 'invalid'], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.equal(readEvents().filter((row) => row.name === 'invalid').at(-1).event, 'failed');
  const fallback = spawnSync(process.execPath, [worker, 'start', '--name', 'fallback-identity'], { env: { ...env, CLAUDE_JOB_DIR: '/tmp/jobs/job-only' }, encoding: 'utf8' });
  assert.equal(fallback.status, 2);
  const fallbackEvent = readEvents().filter((row) => row.name === 'fallback-identity').at(-1);
  assert.equal(fallbackEvent.owner, 'job-only'); assert.equal(fallbackEvent.launcher.sessionId, null);
  const rpc = path.join(tmp, 'sigterm-rpc.jsonl');
  const sig = start('--import', [fixture, worker, 'start', '--owner', 'worker-owner', '--name', 'term', '--cwd', tmp,
    '--sandbox', 'read-only', '--effort', 'high', '--model', 'fixture', 'Follow the fixture brief.'], { WORKER_EVENTS_FIXTURE: JSON.stringify({ hold: true, rpc, thread: 'term-thread', turn: 'term-turn' }) });
  await until(() => sig.output().includes('thread=term-thread turn=term-turn'), 'follower attached'); sig.child.kill('SIGTERM');
  assert.equal((await sig.done).code, 143);
  const ended = readEvents().filter((row) => row.name === 'term').at(-1);
  assert.equal(ended.event, 'follower-ended'); assert.equal(ended.mayRun, true);
  const mine = spawnSync(process.execPath, ['--import', fixture, worker, 'mine', '--owner', 'worker-owner'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(mine.status, 0, mine.stderr); assert.match(mine.stdout, /term\trunning \(hub\)/);
  const settledRows = [{ owner: 'settled', runId: 'old', id: 'old', event: 'follower-ended', account: 'main', thread: 'same', turn: 'turn', mayRun: true },
    { owner: 'settled', runId: 'new', id: 'new', event: 'finished', account: 'main', thread: 'same', turn: 'turn', mayRun: false }];
  assert.equal(inbox(settledRows, 'settled').running.length, 0);

  for (const [name, command, code] of [['exec-ok', [process.execPath, '-e', 'process.exit(0)'], 0],
    ['exec-fail', [process.execPath, '-e', 'process.exit(5)'], 5], ['exec-spawn-fail', ['/nonexistent/fixture-executable'], 1]]) {
    const r = spawnSync('/bin/sh', [path.join(scripts, 'run-tracked.sh'), '--name', name, '--owner', 'exec-owner', '--account', 'fixture', '--model', 'fixture', '--', ...command], { env, encoding: 'utf8' });
    assert.equal(r.status, code, r.stderr);
    const rows = readEvents().filter((row) => row.name === name); assert.equal(rows.length, 2);
    assert.equal(rows.at(-1).exit, code); assert.equal(rows.at(-1).event, code === 0 ? 'finished' : 'failed');
  }
  const tracked = path.join(scripts, 'run-tracked.mjs');
  const staleOut = path.join(tmp, 'stale-exec.md'); fs.writeFileSync(staleOut, 'BLOCKED previous run\n');
  const stale = spawnSync(process.execPath, [tracked, '--name', 'stale-exec', '--owner', 'exec-owner', '--out', staleOut,
    '--', '/nonexistent/fixture-executable'], { env, encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.equal(readEvents().filter((row) => row.name === 'stale-exec').at(-1).event, 'failed', 'do not reuse an earlier final message');
  assert.equal(readEvents().filter((row) => row.name === 'stale-exec').at(-1).finalLine, '');
  const execTerm = start(tracked, ['--name', 'exec-term', '--owner', 'exec-owner', '--', process.execPath, '-e', 'setInterval(()=>{}, 1000); console.log("ready")']);
  await until(() => execTerm.output().includes('ready'), 'tracked child ready'); execTerm.child.kill('SIGTERM');
  assert.equal((await execTerm.done).code, 143);
  assert.equal(readEvents().filter((row) => row.name === 'exec-term').at(-1).event, 'follower-ended');
  const audit = auditWorkerEvents();
  assert.equal(audit.find((row) => row.owner === 'owner-A').acknowledged, 1);
  assert.equal(audit.find((row) => row.owner === 'owner-B').unacknowledged, 1);
  assert.ok(audit.find((row) => row.owner === 'owner-A').finishToAckMs.max >= 0);
  const old = record('old-owner', 'finished', 'old-event', { launcher: {} });
  const oldAudit = auditWorkerEvents([{ ...old, t: 1 }, { ...old, id: 'launch', event: 'running', t: Date.now() }], Date.now() - 1000);
  assert.equal(oldAudit[0].totalUnacknowledged, 1); assert.equal(oldAudit[0].unacknowledged, 0); assert.equal(oldAudit[0].launchesWithoutIdentity, 1);
  console.log(`PASS worker inbox: durable exits, owners, watch/ack, Stop/SessionStart, loop guard, malformed/torn input, SIGTERM/hub mine, exec errors, audit; hook ${blocked.ms.toFixed(1)}ms`);
} finally {
  for (const child of children) child.kill('SIGTERM');
  if (original === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = original;
  fs.rmSync(tmp, { recursive: true, force: true });
}
