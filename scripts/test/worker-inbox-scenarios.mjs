#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEvent, eventFile, ackFile, readEvents, readAck, inbox, deliver, hasWatcher, auditWorkerEvents,
  launcherIdentity, resolveOwner } from '../lib/worker-events.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-inbox-'));
const original = process.env.RULES_SHARED;
process.env.RULES_SHARED = tmp;
const profiles = path.join(tmp, 'accounts.json'); fs.writeFileSync(profiles, '{}');
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: profiles, ORCHESTRATOR_OWNER: '',
  CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '', WORKER_EVENTS_FIXTURE: '{}' };
const worker = path.join(scripts, 'codex-worker.mjs'), hook = path.join(scripts, 'worker-inbox-hook.mjs');
const fixture = path.join(scripts, 'test/fixtures/worker-events-transport.mjs');
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
  const r = spawnSync(process.execPath, [hook], { env: { ...env, ...extra }, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 1000 });
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
  record('followers-owner', 'running', 'live-start', { thread: 'start-thread', pid: process.pid, followerCommand: 'start' });
  record('followers-owner', 'running', 'live-turn', { thread: 'turn-thread', pid: process.pid, followerCommand: 'turn' });
  const followers = [
    { command: `node "${worker}" --account fixture start --owner followers-owner --name live-start`, pid: process.pid },
    { command: `node "${worker}" --account fixture turn --owner followers-owner --thread turn-thread`, pid: process.pid }
  ];
  assert.equal(hookRun(input('followers-owner', { background_tasks: followers })).output, null);
  assert.match(hookRun(input('followers-owner', { background_tasks: followers.slice(0, 1) })).output.reason, /live-turn.*no matching tracked/);
  assert.match(hookRun(input('followers-owner')).output.reason, /live-start.*background_tasks missing/);
  for (const change of [{ pid: 2147483647 }, { status: 'completed' }, { command: followers[0].command + ' &' },
    { command: followers[0].command.replace('followers-owner', 'other-owner') }]) {
    assert.match(hookRun(input('followers-owner', { background_tasks: [{ ...followers[0], ...change }, followers[1]] })).output.reason, /live-start/);
  }
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
