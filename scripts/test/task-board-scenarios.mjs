#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardFile, readBoard, setTask, linkTask, archiveTasks, refreshBoard, resolveProject, rolloutFields, resultFields,
  workerFacts } from '../lib/task-board.mjs';
import { addQuestion, updateQuestion, readQueue, queueFile, deliverAnswers } from '../lib/user-queue.mjs';
import { projectStatus, statusMismatches, parseResourceHolds } from '../lib/task-status.mjs';
import { iso, maskSecrets } from '../lib/task-storage.mjs';
import { saveLaunch, inheritedLaunch } from '../lib/worker-launch.mjs';
import { appendEvent } from '../lib/worker-events.mjs';
import { parseTaskSpec } from '../lib/pipeline/taskspec.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-board-scenarios-'));
const root = path.join(tmp, 'orchestrator'), shared = path.join(root, '_shared'), owner = '36f5a9fd-1a0a-49b7-8baa-165a6cba0995';
const previous = { ...process.env };
Object.assign(process.env, { HOME: tmp, ORCH_ROOT: root, RULES_SHARED: shared, RES_DIR: shared,
  CODEX_ACCOUNTS: path.join(shared, 'accounts.json'), ORCHESTRATOR_OWNER: owner, ORCHESTRATOR_PROJECT: '' });
fs.mkdirSync(shared, { recursive: true }); fs.writeFileSync(process.env.CODEX_ACCOUNTS, '{}');
const env = { ...process.env, CODEX_WORKER_THREAD: '', CODEX_WORKER_ACCOUNT: '', CODEX_WORKER_OWNER: '', CLAUDECODE: '',
  CLAUDE_JOB_DIR: '', CLAUDE_SESSION_ID: '', WORKER_EVENTS_FIXTURE: '{}' };
const cli = (script, args, extra = {}) => {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, `${script}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${script}: ${result.stderr}`); return result.stdout;
};
const launch = (project, task, name, thread, time, extra = {}) => {
  const dir = path.join(shared, 'worker-launches/fixture'); fs.mkdirSync(dir, { recursive: true });
  const row = { account: 'fixture', thread, t: time, defaults: { project, task, name, owner, ...extra }, effectiveModel: 'gpt-6.1-sol', effort: 'high' };
  fs.writeFileSync(path.join(dir, `${thread}.json`), JSON.stringify(row)); return row;
};
const event = (project, name, thread, type, time, extra = {}) => ({ id: `${thread}-${type}-${time}`, runId: thread,
  account: 'fixture', project, name, owner, thread, event: type, t: time, pid: process.pid, model: 'gpt-6.1-sol', effort: 'high', ...extra });
const facts = (launches, events, live = []) => ({ launches, events, live: { threads: live, unresolved: [] } });
const taskOf = (project, task) => readBoard(project).tasks.find(row => row.id === task);
const children = new Set();
const until = async (test, label) => {
  const deadline = Date.now() + 10000;
  while (!test()) { if (Date.now() >= deadline) throw Error(`timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const asyncCli = (script, args) => {
  const child = spawn(process.execPath, [path.join(scripts, script), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timeout); children.delete(child); code === 0 ? resolve() : reject(Error(stderr || `exit ${code}`)); });
  });
};
try {
  const now = Date.now(), old = now - 3 * 86400000;
  cli('board.mjs', ['set', 'T1', '--project', 'alpha', '--title', 'Task One', '--state', 'queued', '--next', 'test', '--deps', 'T2,T3', '--note', 'owned']);
  let shown = JSON.parse(cli('board.mjs', ['show', '--project', 'alpha', '--task', 'T1', '--json']));
  assert.equal(shown.schemaVersion, 1); assert.equal(shown.tasks.length, 1); assert.deepEqual(shown.tasks[0].deps, ['T2', 'T3']);
  setTask('alpha', 'T-old', { state: 'done' }, old); setTask('alpha', 'T-new', { state: 'done' }, now);
  assert.deepEqual(archiveTasks('alpha', 2, now).map(task => task.id), ['T-old']);
  assert.equal(taskOf('alpha', 'T-old'), undefined); assert.match(fs.readFileSync(path.join(root, 'alpha/board-archive.jsonl'), 'utf8'), /T-old/);
  assert.deepEqual(archiveTasks('alpha', 2, now), []);
  assert.throws(() => setTask('alpha', '../escape', {})); assert.throws(() => setTask('alpha', 'T1', { auto: {} }));
  assert.throws(() => setTask('alpha', 'T1', { state: 'invalid' })); assert.throws(() => setTask('alpha', 'T1', { deadline: 'tomorrow' }));
  console.log('PASS board set/show/archive, schema and orchestrator-only validation');

  const log = path.join(tmp, 'codex.jsonl'), out = path.join(tmp, 'codex-last.md');
  fs.writeFileSync(log, [
    { type: 'response_item', timestamp: iso(now), payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test -w app-ui --token fake-secret-123' }) } },
    { method: 'thread/tokenUsage/updated', params: { threadId: 'th1', tokenUsage: { total: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 } } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const started = now - 1000;
  const l1 = launch('beta', 'T-build', 'exact-worker-name', 'th1', started, { log, out });
  const e1 = event('beta', 'exact-worker-name', 'th1', 'running', started);
  await refreshBoard('beta', { facts: facts([l1], [e1]), now });
  let worker = taskOf('beta', 'T-build').auto.workers[0];
  assert.equal(taskOf('beta', 'T-build').state, 'running'); assert.equal(taskOf('beta', 'T-build').title, 'exact-worker-name');
  assert.equal(worker.thread, 'th1'); assert.equal(worker.model, 'gpt-6.1-sol'); assert.equal(worker.effort, 'high');
  assert.equal(worker.currentStep, 'running: npm test -w app-ui --token [MASKED]'); assert.equal(worker.tokens.input, 12);
  assert.ok(!JSON.stringify(readBoard('beta')).includes('fake-secret-123'));
  const cache = worker._rollout, originalRead = fs.readSync;
  const boardMtime = fs.statSync(boardFile('beta')).mtimeMs;
  fs.readSync = (...args) => { assert.fail('unchanged rollout must not be read/parsed'); return originalRead(...args); };
  try { await refreshBoard('beta', { facts: facts([l1], [e1]), now }); } finally { fs.readSync = originalRead; }
  assert.deepEqual(taskOf('beta', 'T-build').auto.workers[0]._rollout, cache);
  assert.equal(fs.statSync(boardFile('beta')).mtimeMs, boardMtime, 'unchanged refresh does not rewrite the board');
  setTask('beta', 'T-build', { next: 'review changes', note: 'manual note' }, now);
  assert.equal(taskOf('beta', 'T-build').auto.workers[0].thread, 'th1');
  const progress = event('beta', 'exact-worker-name', 'th1', 'message', now + 10, { kind: 'info', text: 'Validated build token=fake-secret-123' });
  await refreshBoard('beta', { facts: facts([l1], [e1, progress]), now: now + 11 });
  assert.equal(taskOf('beta', 'T-build').auto.workers[0].lastProgress, 'Validated build token=[MASKED]');
  assert.equal(taskOf('beta', 'T-build').next, 'review changes');
  setTask('beta', 'T-build', { state: 'waiting-user' }, now + 20);
  await refreshBoard('beta', { facts: facts([l1], [e1, progress]), now: now + 21 });
  assert.equal(taskOf('beta', 'T-build').state, 'waiting-user');
  const restart = event('beta', 'exact-worker-name', 'th1', 'running', now + 30);
  await refreshBoard('beta', { facts: facts([l1], [e1, restart]), now: now + 31 });
  assert.equal(taskOf('beta', 'T-build').state, 'running');
  setTask('beta', 'T-build', { state: 'blocked', blocker: 'orchestrator judgement' }, now + 50);
  const failed = event('beta', 'exact-worker-name', 'th1', 'failed', now + 40, { reason: 'compile error token=fake-secret-123' });
  await refreshBoard('beta', { facts: facts([l1], [e1, failed]), now: now + 51 });
  assert.equal(taskOf('beta', 'T-build').blocker, 'orchestrator judgement');
  const stalled = event('beta', 'exact-worker-name', 'th1', 'stalled', now + 60, { reason: 'quiet password=fake-secret-123' });
  await refreshBoard('beta', { facts: facts([l1], [e1, stalled]), now: now + 61 });
  assert.match(taskOf('beta', 'T-build').blocker, /^worker stalled: quiet password=\[MASKED\]/);
  fs.writeFileSync(out, '# Result\n\n## Summary\nImplemented the board safely.\n\n## Tests\n8 passed, 0 failed\nCommit: abc1234def567890\n');
  const finished = event('beta', 'exact-worker-name', 'th1', 'finished', now + 70);
  await refreshBoard('beta', { facts: facts([l1], [e1, finished]), now: now + 71 });
  worker = taskOf('beta', 'T-build').auto.workers[0];
  assert.equal(taskOf('beta', 'T-build').state, 'review'); assert.equal(worker.result.summary, 'Implemented the board safely.');
  assert.equal(worker.result.commit, 'abc1234def567890'); assert.deepEqual(worker.result.tests, { passed: 8, failed: 0 });
  assert.equal(worker.finishedAt, iso(now + 70));
  setTask('beta', 'T-build', { state: 'done' }, now + 80);
  await refreshBoard('beta', { facts: facts([l1], [e1, finished]), now: now + 81 });
  assert.equal(taskOf('beta', 'T-build').state, 'done');
  archiveTasks('beta', 0, now + 90);
  await refreshBoard('beta', { facts: facts([l1], [e1, finished]), now: now + 100 });
  assert.equal(taskOf('beta', 'T-build'), undefined, 'reads must not resurrect archived workers');
  assert.ok(rolloutFields(JSON.stringify({ method: 'item/completed', params: { item: { type: 'fileChange', changes: [{ path: 'scripts/res/res' }] } } })).currentStep.includes('editing scripts/res/res'));
  assert.equal(rolloutFields(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Preparing checks' }] } })).currentStep, 'Preparing checks');
  assert.ok(rolloutFields(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'x'.repeat(500) }] } })).currentStep.length <= 120);
  assert.equal(resultFields('First paragraph.\n\nSecond paragraph.').summary, 'First paragraph.');
  for (const text of ['password=fake-secret-123', '--token fake-secret-123', 'API_KEY="fake-secret-123"', 'credential: fake-secret-123']) assert.ok(!maskSecrets(text).includes('fake-secret-123'));
  console.log('PASS auto creation, tail cache/tool/message extraction/masking/tokens/progress, state precedence, finished result, archive tombstones');

  const fallback = launch('gamma', undefined, 'fallback-exact', 'fallback-thread', now + 1);
  const fallbackEvent = event('gamma', 'fallback-exact', 'fallback-thread', 'running', now + 1);
  await refreshBoard('gamma', { facts: facts([fallback], [fallbackEvent]) });
  assert.ok(taskOf('gamma', 'fallback-exact'));
  linkTask('gamma', 'manual-task', 'fallback-thread');
  await refreshBoard('gamma', { facts: facts([fallback], [fallbackEvent]) });
  assert.equal(taskOf('gamma', 'manual-task').auto.workers[0].thread, 'fallback-thread');
  assert.equal(taskOf('gamma', 'fallback-exact').auto.workers.length, 0);
  assert.equal(resolveProject(undefined, [l1, fallback]), 'gamma');
  assert.equal(resolveProject('alpha', [l1, fallback]), 'alpha');
  process.env.ORCHESTRATOR_PROJECT = 'env-project'; assert.equal(resolveProject(undefined, []), 'env-project'); process.env.ORCHESTRATOR_PROJECT = '';
  saveLaunch('fixture', 'inherit-thread', { name: 'inherit-name', task: 'explicit-task', project: 'gamma', effort: 'high' }, owner);
  assert.equal(inheritedLaunch('fixture', { thread: 'inherit-thread' }).task, 'explicit-task');
  assert.equal(parseTaskSpec(['implement', '--impact', 'service', '--project', 'gamma', '--task', 'explicit-task'], { taskId: 'route-task', requestId: 'request' }).flags.task, 'explicit-task');
  console.log('PASS exact-name fallback, manual links, owner/env project defaults, launch task inheritance, router task option');
  const handoff1 = launch('handoff', 'H1', 'handoff-worker', 'handoff-old', now);
  const handoff2 = launch('handoff', 'H1', 'handoff-worker', 'handoff-new', now + 10);
  await refreshBoard('handoff', { facts: facts([handoff1, handoff2], [event('handoff', 'handoff-worker', 'handoff-old', 'running', now),
    event('handoff', 'handoff-worker', 'handoff-old', 're-routed', now + 5), event('handoff', 'handoff-worker', 'handoff-new', 'finished', now + 20)]) });
  assert.equal(taskOf('handoff', 'H1').state, 'review', 'an inactive rerouted predecessor cannot keep a finished task running');

  setTask('queue-project', 'Q1', { state: 'queued' }, now);
  const questionArgs = { project: 'queue-project', question: 'Choose deployment', options: ['A', 'B'], recommended: 'A', default: 'Stay queued',
    deadline: iso(now + 86400000), task: 'Q1', raisedBy: owner };
  const q1 = addQuestion(questionArgs), q2 = addQuestion({ ...questionArgs, question: 'Choose region' });
  assert.equal(taskOf('queue-project', 'Q1').state, 'waiting-user');
  updateQuestion(q1, 'card'); updateQuestion(q1, 'answer', { choice: 'Use A exactly, with my wording.', note: 'Proceed' });
  assert.equal(readQueue().find(item => item.id === q1).choice, 'Use A exactly, with my wording.');
  let prints = 0;
  assert.deepEqual(await deliverAnswers({ owner: 'different-owner', print: () => { prints++; } }), []);
  await assert.rejects(deliverAnswers({ owner, print: () => { throw Error('closed stdout'); } }), /closed stdout/);
  assert.equal(readQueue().find(item => item.id === q1).acknowledgedAt, undefined);
  await deliverAnswers({ owner, print: items => { prints++; assert.equal(items[0].choice, 'Use A exactly, with my wording.'); } });
  assert.equal(taskOf('queue-project', 'Q1').state, 'waiting-user', 'other open question still waits');
  await deliverAnswers({ owner, print: () => { prints++; } }); assert.equal(prints, 1);
  updateQuestion(q2, 'answer', { choice: 'B' });
  fs.mkdirSync(`${queueFile()}.lock`);
  assert.deepEqual(await deliverAnswers({ owner, print: () => assert.fail('locked queue cannot deliver') }), []);
  fs.rmdirSync(`${queueFile()}.lock`);
  await deliverAnswers({ owner, print: () => { prints++; } }); assert.equal(taskOf('queue-project', 'Q1').state, 'queued');
  const projectQuestion = addQuestion({ ...questionArgs, raisedBy: undefined }); updateQuestion(projectQuestion, 'answer', { choice: 'A' });
  assert.deepEqual(await deliverAnswers({ owner, project: 'wrong', print: () => assert.fail('wrong project') }), []);
  await deliverAnswers({ owner, project: 'queue-project', print: () => { prints++; } });
  assert.ok(readQueue().find(item => item.id === projectQuestion).acknowledgedAt);
  const closeId = addQuestion({ ...questionArgs, task: 'Q-close' }); updateQuestion(closeId, 'close');
  assert.equal(taskOf('queue-project', 'Q-close').state, 'queued');
  const runningQuestion = addQuestion({ ...questionArgs, task: 'Q-running' }, now + 200);
  const runningLaunch = launch('queue-project', 'Q-running', 'queue-worker', 'queue-thread', now + 100);
  const queueRunning = event('queue-project', 'queue-worker', 'queue-thread', 'running', now + 300);
  await refreshBoard('queue-project', { facts: facts([runningLaunch], [queueRunning]), now: now + 301 });
  assert.equal(taskOf('queue-project', 'Q-running').state, 'waiting-user', 'new worker events cannot release an unanswered queue item');
  updateQuestion(runningQuestion, 'answer', { choice: 'A' });
  await deliverAnswers({ owner, print: () => {} }); assert.equal(taskOf('queue-project', 'Q-running').state, 'running');
  assert.throws(() => updateQuestion(q1, 'answer', { choice: 'replace' }));
  assert.equal(JSON.parse(cli('user-queue.mjs', ['list', '--open', '--project', 'queue-project', '--json'])).length, 0);
  assert.ok(JSON.parse(cli('user-queue.mjs', ['list', '--all', '--json'])).length >= 4);
  assert.ok(fs.readFileSync(queueFile(), 'utf8').split('\n').filter(Boolean).length > readQueue().length, 'queue has append-only lifecycle records');
  console.log('PASS user queue add/card/verbatim answer/close, owner/project delivery once, print rollback, multiple-question waiting transitions');

  // Real hook subprocess, isolated from autoupdate/hubs; functional deadlines widened only for this check.
  const clock = path.join(tmp, 'hook-clock.mjs');
  fs.writeFileSync(clock, 'const timeout = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 220 ? 10000 : ms, ...args);\n');
  const hookQuestion = addQuestion({ ...questionArgs, task: 'Q-hook' }); updateQuestion(hookQuestion, 'answer', { choice: 'Hook answer' });
  const hookInput = { session_id: owner, hook_event_name: 'Stop', session_title: 'Board Fixture 主对话', cwd: tmp, stop_hook_active: false };
  const runHook = input => {
    const result = spawnSync(process.execPath, ['--import', clock, path.join(scripts, 'worker-inbox-hook.mjs')], { env,
      input: JSON.stringify(input), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout ? JSON.parse(result.stdout) : null;
  };
  assert.equal(runHook({ ...hookInput, stop_hook_active: true }), null); assert.equal(readQueue().find(item => item.id === hookQuestion).acknowledgedAt, undefined);
  assert.match(runHook(hookInput).reason, /User answered: Hook answer/);
  assert.equal(runHook(hookInput), null); assert.equal(taskOf('queue-project', 'Q-hook').state, 'queued');
  const startQuestion = addQuestion({ ...questionArgs, task: 'Q-session' }); updateQuestion(startQuestion, 'answer', { choice: 'SessionStart answer' });
  const startResult = runHook({ ...hookInput, hook_event_name: 'SessionStart', source: 'resume' });
  assert.match(startResult.hookSpecificOutput.additionalContext, /SessionStart answer/);
  assert.equal(runHook(hookInput), null);
  console.log('PASS Stop/SessionStart hook delivery once, output format and stop-cycle guard');

  const stale = now - 2 * 86400000;
  setTask('status-project', 'S-running', { state: 'running' }, stale);
  setTask('status-project', 'S-review', { state: 'review' }, stale);
  setTask('status-project', 'S-wait', { state: 'waiting-user' }, stale);
  setTask('status-project', 'S-overdue', { deadline: iso(now - 10000) });
  const live = [{ name: 'orphan', thread: 'orphan-thread', account: 'fixture', startedAt: now, lastActivityAt: now }];
  const mismatches = statusMismatches({ board: readBoard('status-project'), live, queue: [], now });
  assert.deepEqual(new Set(mismatches.map(row => row.kind)), new Set(['running-without-worker', 'old-review', 'waiting-without-question', 'overdue', 'unlinked-worker']));
  assert.equal(statusMismatches({ board: { tasks: [{ id: 'fresh', state: 'running', stateUpdatedAt: iso(now - 1000), auto: { workers: [] } }] }, live: [], queue: [], now }).length, 0);
  const holdText = 'heavy-lane-1 slot manual - owner (status-project/S-running) 2026-11-16 10:00 - test\niphone11 device allow connected somebody (other) 2026-11-16 10:00\n';
  assert.equal(parseResourceHolds(holdText, 'status-project').length, 1); assert.equal(parseResourceHolds(holdText, 'status').length, 0);
  assert.equal(parseResourceHolds(holdText.replace('owner (status-project', 'owner (session) (status-project'), 'status-project').length, 1);
  const page = await projectStatus('status-project', { facts: facts([], [], []), queue: [], resources: { state: 'KNOWN', holds: parseResourceHolds(holdText, 'status-project') }, now });
  assert.equal(page.mismatches.length, 4); assert.equal(page.resources.holds[0].id, 'heavy-lane-1');
  const status = JSON.parse(cli('status.mjs', ['--project', 'status-project', '--json']));
  assert.equal(status.project, 'status-project'); assert.equal(status.resources.state, 'UNKNOWN'); assert.equal(status.mismatches.length, 4);
  assert.match(cli('status.mjs', ['--project', 'status-project']), /Live Workers:[\s\S]*User Queue:[\s\S]*Resource Holds[\s\S]*Mismatches:/);
  const resBin = path.join(tmp, 'res-fixture'), calls = path.join(tmp, 'res-calls');
  fs.writeFileSync(path.join(shared, 'resources.tsv'), 'fixture\n');
  fs.writeFileSync(resBin, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.at(-1)!=='status')process.exit(2);fs.appendFileSync(process.env.RES_FIXTURE_CALLS,'status\\n');console.log(${JSON.stringify(holdText)});\n`, { mode: 0o755 });
  const resourcePage = JSON.parse(cli('status.mjs', ['--project', 'status-project', '--json'], { RES_BIN: resBin, RES_FIXTURE_CALLS: calls }));
  assert.equal(resourcePage.resources.state, 'KNOWN'); assert.equal(resourcePage.resources.holds.length, 1);
  fs.writeFileSync(calls, ''); cli('status.mjs', ['--json'], { RES_BIN: resBin, RES_FIXTURE_CALLS: calls });
  assert.equal(fs.readFileSync(calls, 'utf8'), 'status\n', 'all-project view captures res status once');
  fs.unlinkSync(path.join(shared, 'resources.tsv'));
  console.log('PASS compact status + all five mismatch classes, grace periods, exact-project resource holds, JSON');

  await Promise.all([asyncCli('board.mjs', ['set', 'C1', '--project', 'concurrent', '--next', 'one']),
    asyncCli('board.mjs', ['set', 'C2', '--project', 'concurrent', '--next', 'two'])]);
  assert.deepEqual(new Set(readBoard('concurrent').tasks.map(task => task.id)), new Set(['C1', 'C2']));
  const args = ['add', '--project', 'concurrent', '--question', 'Choose', '--option', 'A', '--option', 'B', '--default', 'Wait', '--deadline', iso(now + 86400000)];
  await Promise.all([asyncCli('user-queue.mjs', args), asyncCli('user-queue.mjs', args)]);
  assert.equal(readQueue().filter(item => item.project === 'concurrent').length, 2);
  console.log('PASS concurrent board and queue writers preserve both updates');

  const transport = path.join(scripts, 'test/fixtures/worker-events-transport.mjs');
  const workerArgs = ['--import', transport, path.join(scripts, 'codex-worker.mjs'), 'start', '--account', 'main', '--owner', owner,
    '--cwd', tmp, '--sandbox', 'read-only', '--effort', 'high', '--model', 'fixture', '--project', 'worker-project', '--task', 'worker-task',
    '--name', 'worker-name', '--log', path.join(tmp, 'worker.jsonl'), '--out', path.join(tmp, 'worker-last.md'), 'Follow fixture.'];
  let workerResult = spawnSync(process.execPath, workerArgs, { env: { ...env, WORKER_EVENTS_FIXTURE: JSON.stringify({ thread: 'live-fixture', final: '## Summary\nFixture completed.\n\n2 passed, 0 failed\nCommit: abc1234567890' }) }, encoding: 'utf8', timeout: 20000 });
  assert.equal(workerResult.status, 0, workerResult.stderr);
  const finalBoard = JSON.parse(cli('board.mjs', ['show', '--project', 'worker-project', '--json']));
  assert.equal(finalBoard.tasks[0].id, 'worker-task'); assert.equal(finalBoard.tasks[0].state, 'review'); assert.equal(finalBoard.tasks[0].auto.workers.length, 1, 'provisional start collapses into thread');
  assert.equal(finalBoard.tasks[0].auto.workers[0].result.summary, 'Fixture completed.');
  const holdArgs = workerArgs.map(value => value === 'worker-task' ? 'auto-only-task' : value === 'worker-name' ? 'auto-only-name' : value);
  const held = spawn(process.execPath, holdArgs, { env: { ...env, WORKER_EVENTS_FIXTURE: JSON.stringify({ thread: 'auto-only-thread', hold: true }) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(held); held.stdout.resume(); held.stderr.resume();
  const heldDone = new Promise(resolve => held.on('close', () => { children.delete(held); resolve(); }));
  await until(() => taskOf('worker-project', 'auto-only-task')?.auto.workers.some(worker => worker.thread === 'auto-only-thread'), 'start event auto refresh without show');
  assert.equal(taskOf('worker-project', 'auto-only-task').state, 'running');
  cli('codex-worker.mjs', ['--account', 'main', 'note', '--thread', 'auto-only-thread', '--kind', 'info', 'Automatic fixture progress']);
  await until(() => taskOf('worker-project', 'auto-only-task')?.auto.workers.some(worker => worker.lastProgress === 'Automatic fixture progress'), 'note event auto refresh without show');
  held.kill('SIGTERM'); await heldDone;
  fs.mkdirSync(path.join(root, 'broken-project'), { recursive: true }); fs.writeFileSync(boardFile('broken-project'), 'not JSON');
  const brokenArgs = workerArgs.map(value => value === 'worker-project' ? 'broken-project' : value === 'worker-task' ? 'broken-task' : value);
  workerResult = spawnSync(process.execPath, brokenArgs, { env: { ...env, WORKER_EVENTS_FIXTURE: JSON.stringify({ thread: 'broken-fixture' }) }, encoding: 'utf8', timeout: 20000 });
  assert.equal(workerResult.status, 0, 'board refresh failure never fails the worker');
  assert.equal(fs.readFileSync(boardFile('broken-project'), 'utf8'), 'not JSON', 'refresh does not overwrite corrupt data');
  appendEvent({ ...event('worker-project', 'worker-name', 'live-fixture', 'message', Date.now()), kind: 'info', text: 'Fixture info' });
  const observed = await workerFacts(); assert.ok(observed.events.length); assert.equal(observed.live.threads.length, 0);
  console.log('PASS codex-worker task lifecycle/result integration, provisional collapse, refresh failure fail-open, no hub reads');
  console.log('Task board scenarios: all passed');
} finally {
  for (const child of children) child.kill('SIGTERM');
  // Short-lived refresh children have only this fixture root; retain it until their bounded exits.
  await new Promise(resolve => setTimeout(resolve, 6000));
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
