#!/usr/bin/env node
// Temporary homes and fake hub only; run independently from worker-inbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEvents, inbox, readAck, deliver, openQuestions, hasWatcher, compactWorkerEvents,
  replyFile, contextFile } from '../lib/worker-events.mjs';

const owners = { trae: '1be5e1ea-b928-566d-8b57-991d2b507b6e', ttadk: '5c5a00d0-2f02-5ba1-af93-9898f8807636', chatgpt: '6d9f214e-0eaa-5187-8ade-d189301d4d00' };
const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worker = path.join(scripts, 'codex-worker.mjs'), fixture = path.join(scripts, 'test/fixtures/worker-events-transport.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-talkback-'));
const original = process.env.RULES_SHARED;
process.env.RULES_SHARED = tmp;
const profiles = path.join(tmp, 'accounts.json');
fs.writeFileSync(profiles, JSON.stringify(Object.fromEntries(['trae', 'ttadk', 'chatgpt'].map((kind) => [kind,
  { kind, home: path.join(tmp, kind), hub: 'ws://127.0.0.1:1' }]))));
const env = { ...process.env, HOME: tmp, CODEX_ACCOUNTS: profiles, RULES_SHARED: tmp, NODE_OPTIONS: '',
  ORCHESTRATOR_OWNER: '', CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '',
  CODEX_WORKER_THREAD: '', CODEX_WORKER_ACCOUNT: '', CODEX_WORKER_OWNER: '', CODEX_WORKER_NAME: '',
  CODEX_THREAD_ID: '', TRAECLI_THREAD_ID: '', WORKER_EVENTS_FIXTURE: '{}' };
const children = new Set();
const run = (args, extra = {}) => spawnSync(process.execPath, ['--import', fixture, worker, ...args],
  { env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000 });
const start = (args, extra = {}) => {
  const child = spawn(process.execPath, ['--import', fixture, worker, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', (b) => stdout += b); child.stderr.on('data', (b) => stderr += b);
  const done = new Promise((resolve) => child.on('close', (code) => { children.delete(child); resolve({ code, stdout, stderr }); }));
  return { child, done, output: () => stdout };
};
const until = async (test, label) => {
  const deadline = Date.now() + 5000;
  while (!test()) { if (Date.now() > deadline) throw Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 25)); }
};
const hook = (owner, event = 'Stop') => {
  const r = spawnSync(process.execPath, [path.join(scripts, 'worker-inbox-hook.mjs')], { env, encoding: 'utf8', timeout: 2000,
    input: JSON.stringify({ session_id: owner, hook_event_name: event, source: 'resume', session_title: 'Fixture 主对话', cwd: tmp, stop_hook_active: false }) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const launch = (kind, thread, owner, config = {}, flags = []) => {
  const rpc = path.join(tmp, `${thread}-rpc.jsonl`);
  const args = ['--account', kind, 'start', '--cwd', tmp, '--sandbox', 'read-only', '--effort', 'high', '--model', 'fixture',
    '--owner', owner, '--name', thread, ...flags, 'Follow the fake brief.'];
  const extra = { WORKER_EVENTS_FIXTURE: JSON.stringify({ thread, rpc, ...config }) };
  return { args, extra, rpc };
};
const rpcRows = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const pending = (owner) => inbox(readEvents(), owner, readAck(owner)).pending;
try {
  const identities = {};
  for (const kind of ['trae', 'ttadk', 'chatgpt']) {
    const l = launch(kind, `${kind}-thread`, owners[kind]), result = run(l.args, l.extra);
    assert.equal(result.status, 0, result.stderr);
    const resume = rpcRows(l.rpc).find((row) => row.method === 'thread/resume');
    const set = resume.params.config.shell_environment_policy.set;
    assert.deepEqual(set, { BYTEDCLI_NO_AUTO_UPGRADE: '1', CODEX_WORKER_THREAD: `${kind}-thread`, CODEX_WORKER_ACCOUNT: kind,
      CODEX_WORKER_OWNER: owners[kind], CODEX_WORKER_NAME: `${kind}-thread`, CODEX_WORKER_TASK_DIR: '', RULES_SHARED: tmp });
    // The instructions carry ready-to-run commands with the identity baked in (TRAE does not pass per-thread env).
    assert.match(resume.params.developerInstructions, new RegExp(`--account ${kind} note --thread ${kind}-thread`));
    assert.match(resume.params.developerInstructions, new RegExp(`--account ${kind} ask --thread ${kind}-thread`));
    assert.equal(JSON.parse(fs.readFileSync(contextFile(kind, `${kind}-thread`))).owner, owners[kind]);
    identities[kind] = set;
    deliver(owners[kind], () => {});
    const note = run(['note', '--kind', 'risk', `${kind} milestone`], set);
    assert.equal(note.status, 0, note.stderr);
    assert.equal(pending(owners[kind]).at(-1).text, `${kind} milestone`);
    deliver(owners[kind], () => {});
  }
  // Thread continuation refreshes identity/config through the same supported RPC.
  const turnRpc = path.join(tmp, 'turn-rpc.jsonl');
  const turn = run(['--account', 'ttadk', 'turn', '--thread', 'ttadk-thread', '--effort', 'high', '--model', 'fixture', 'Continue.'],
    { WORKER_EVENTS_FIXTURE: JSON.stringify({ thread: 'ttadk-thread', rpc: turnRpc }) });
  assert.equal(turn.status, 0, turn.stderr);
  assert.equal(rpcRows(turnRpc).find((r) => r.method === 'thread/resume').params.config.shell_environment_policy.set.CODEX_WORKER_OWNER, '5c5a00d0-2f02-5ba1-af93-9898f8807636');
  deliver('5c5a00d0-2f02-5ba1-af93-9898f8807636', () => {});
  const rejected = launch('trae', 'fallback-thread', '6dfeb901-8648-5c87-8068-8db0a72f5725', { rejectContext: true });
  assert.equal(run(rejected.args, rejected.extra).status, 0);
  assert.match(JSON.stringify(rpcRows(rejected.rpc).find((r) => r.method === 'turn/start').params.input), /thread=fallback-thread account=trae/);
  assert.equal(run(['note', '--thread', 'fallback-thread', '--account', 'trae', 'Explicit identity']).status, 0);

  // Two watchers, two owners: only the launcher gets the talkback wake-up.
  // Consume the separate rules-push skip notice for the completed fixtures
  // before measuring the exact talkback payload and which watcher wakes.
  for (const owner of ['1be5e1ea-b928-566d-8b57-991d2b507b6e', '5c5a00d0-2f02-5ba1-af93-9898f8807636'])
    assert.equal(run(['rules-push', '--owner', owner]).status, 0);
  const a = start(['watch', '--debounce-sec', '0', '--owner', '1be5e1ea-b928-566d-8b57-991d2b507b6e']), b = start(['watch', '--debounce-sec', '0', '--owner', '5c5a00d0-2f02-5ba1-af93-9898f8807636']);
  await until(() => hasWatcher('1be5e1ea-b928-566d-8b57-991d2b507b6e') && hasWatcher('5c5a00d0-2f02-5ba1-af93-9898f8807636'), 'watchers armed');
  assert.equal(run(['note', '--kind', 'scope', 'Need scope decision'], identities.ttadk).status, 0);
  const awake = await b.done; assert.equal(awake.code, 0); assert.match(awake.stdout, /^worker ttadk-thread notes \[scope\]: Need scope decision\n$/);
  await new Promise((r) => setTimeout(r, 200)); assert.equal(a.output(), '');
  assert.equal(run(['note', '--kind', 'info', 'Owner A milestone'], identities.trae).status, 0);
  assert.equal(run(['note', '--kind', 'progress', 'Peer milestone'], identities.trae).status, 0);
  compactWorkerEvents();
  await new Promise((r) => setTimeout(r, 250)); assert.equal(a.output(), '', 'info never wakes watch');
  const deferredContext = hook('1be5e1ea-b928-566d-8b57-991d2b507b6e', 'SessionStart').hookSpecificOutput.additionalContext;
  assert.match(deferredContext, /Owner A milestone/); assert.match(deferredContext, /Peer milestone/);
  await new Promise((r) => setTimeout(r, 250)); assert.equal(a.output(), '', 'info receipt never wakes watch');
  assert.equal(run(['note', '--wake', '--kind', 'info', 'Changes peer work now'], identities.trae).status, 0);
  assert.equal((await a.done).code, 0);
  assert.equal(hook('5c5a00d0-2f02-5ba1-af93-9898f8807636'), null, 'already delivered note never reappears');

  deliver('6dfeb901-8648-5c87-8068-8db0a72f5725', () => {});
  const riskWatch = start(['watch', '--debounce-sec', '0', '--owner', '6dfeb901-8648-5c87-8068-8db0a72f5725']);
  await until(() => hasWatcher('6dfeb901-8648-5c87-8068-8db0a72f5725'), 'risk watcher armed');
  assert.equal(run(['note', '--account', 'trae', '--thread', 'fallback-thread', '--kind', 'risk', 'Risk needs action']).status, 0);
  assert.match((await riskWatch.done).stdout, /notes \[risk\]: Risk needs action/);

  // Six per rolling hour, retained across compaction; excess is still recorded.
  for (let i = 0; i < 6; i++) assert.equal(run(['note', '--kind', 'risk', `risk-${i}`], identities.chatgpt).status, 0);
  const notes = readEvents().filter((row) => row.event === 'message' && row.account === 'chatgpt');
  assert.equal(notes.filter((row) => row.wake).length, 6);
  assert.equal(notes.at(-1).wake, false); // first identity-test note used one of the six slots
  const reason = hook('6d9f214e-0eaa-5187-8ade-d189301d4d00').reason;
  assert.match(reason, /worker chatgpt-thread notes \[risk\]: risk-0/);
  assert.match(reason, /risk-5/, 'rate-limited notes are delivered on the next natural wake');
  assert.equal(hook('6d9f214e-0eaa-5187-8ade-d189301d4d00'), null);
  compactWorkerEvents();
  assert.match(run(['note', 'still suppressed'], identities.chatgpt).stdout, /next natural wake/);
  assert.match(hook('6d9f214e-0eaa-5187-8ade-d189301d4d00').reason, /still suppressed/);
  assert.equal(run(['note', '--kind', 'risk', 'x'.repeat(501)], identities.trae).status, 0);
  const long = readEvents().filter((row) => row.event === 'message').at(-1);
  assert.equal(long.text.length, 500); assert.equal(long.wake, false); assert.equal(long.truncated, true);

  hook('1be5e1ea-b928-566d-8b57-991d2b507b6e');
  const asking = start(['ask', '--default', 'Keep the baseline', 'Which baseline?'], identities.chatgpt);
  await until(() => openQuestions(readEvents(), { owner: '6d9f214e-0eaa-5187-8ade-d189301d4d00' }).length === 1, 'question recorded');
  const question = openQuestions(readEvents(), { owner: '6d9f214e-0eaa-5187-8ade-d189301d4d00' })[0];
  assert.equal(question.timeoutMin, 20);
  assert.equal(hook('5c5a00d0-2f02-5ba1-af93-9898f8807636'), null);
  const askLine = hook('6d9f214e-0eaa-5187-8ade-d189301d4d00', 'SessionStart').hookSpecificOutput.additionalContext;
  assert.match(askLine, /worker chatgpt-thread asks \(id .*\): Which baseline\?/);
  assert.match(askLine, /--thread chatgpt-thread --account chatgpt --question/);
  assert.equal(hook('6d9f214e-0eaa-5187-8ade-d189301d4d00'), null);
  compactWorkerEvents();
  const mine = run(['mine', '--owner', '6d9f214e-0eaa-5187-8ade-d189301d4d00']);
  assert.equal(mine.status, 0, mine.stderr); assert.match(mine.stdout, /Which baseline/);
  const wrongOwner = run(['reply', '--account', 'chatgpt', '--thread', 'chatgpt-thread', '--owner', '5c5a00d0-2f02-5ba1-af93-9898f8807636', 'Wrong owner']);
  assert.equal(wrongOwner.status, 2); assert.equal(fs.existsSync(replyFile('chatgpt', 'chatgpt-thread', question.questionId)), false);
  const answer = run(['reply', '--account', 'chatgpt', '--thread', 'chatgpt-thread', '--owner', '6d9f214e-0eaa-5187-8ade-d189301d4d00', 'Use baseline B']);
  assert.equal(answer.status, 0, answer.stderr);
  const answered = await asking.done; assert.equal(answered.code, 0); assert.equal(answered.stdout, 'Use baseline B\n');
  assert.equal(openQuestions(readEvents(), { owner: '6d9f214e-0eaa-5187-8ade-d189301d4d00' }).length, 0);
  assert.equal(pending('6d9f214e-0eaa-5187-8ade-d189301d4d00').length, 0, 'answer events do not wake or settle the worker');
  compactWorkerEvents();
  assert.equal(openQuestions(readEvents(), { owner: '6d9f214e-0eaa-5187-8ade-d189301d4d00' }).length, 0);

  const first = start(['ask', '--timeout-min', '1', '--default', 'First default', 'First choice?'], identities.ttadk);
  await until(() => openQuestions(readEvents(), { owner: '5c5a00d0-2f02-5ba1-af93-9898f8807636' }).length === 1, 'first question');
  const firstId = openQuestions(readEvents(), { owner: '5c5a00d0-2f02-5ba1-af93-9898f8807636' })[0].questionId;
  const second = start(['ask', '--timeout-min', '1', '--default', 'Second default', 'Second choice?'], identities.ttadk);
  await until(() => openQuestions(readEvents(), { owner: '5c5a00d0-2f02-5ba1-af93-9898f8807636' }).length === 2, 'second question');
  assert.equal(run(['reply', '--account', 'ttadk', '--thread', 'ttadk-thread', 'Newest answer']).status, 0);
  assert.equal((await second.done).stdout, 'Newest answer\n');
  assert.equal(openQuestions(readEvents(), { owner: '5c5a00d0-2f02-5ba1-af93-9898f8807636' })[0].questionId, firstId);
  assert.equal(run(['reply', '--account', 'ttadk', '--thread', 'ttadk-thread', '--question', firstId, 'First answer']).status, 0);
  assert.equal((await first.done).stdout, 'First answer\n');
  deliver('5c5a00d0-2f02-5ba1-af93-9898f8807636', () => {});

  for (const withDefault of [true, false]) {
    const timeout = run(['ask', '--timeout-min', '0.003', ...(withDefault ? ['--default', 'Proceed with baseline'] : []), 'Timeout question'], identities.chatgpt);
    assert.equal(timeout.status, withDefault ? 3 : 4, timeout.stderr);
    assert.equal(timeout.stdout, withDefault ? 'Proceed with baseline\n' : 'no answer\n');
    assert.equal(openQuestions(readEvents(), { owner: '6d9f214e-0eaa-5187-8ade-d189301d4d00' }).length, 0);
  }
  const fallbackRpc = path.join(tmp, 'reply-fallback-rpc.jsonl');
  // A new resumed turn must not reuse the already-completed launch's turn ID.
  const fallback = run(['reply', '--account', 'chatgpt', '--thread', 'chatgpt-thread', 'Continue with baseline'],
    { WORKER_EVENTS_FIXTURE: JSON.stringify({ rpc: fallbackRpc, turn: 'reply-fallback-turn' }) });
  assert.equal(fallback.status, 0, fallback.stderr); assert.match(fallback.stdout, /no open question; falling back to steer/);
  assert.ok(rpcRows(fallbackRpc).some((row) => row.method === 'turn/steer'));
  const legacy = run(['reply', '--thread', 'legacy-thread', 'Continue']);
  assert.equal(legacy.status, 0, legacy.stderr); assert.match(legacy.stdout, /falling back to steer/);

  const held = launch('trae', 'held-thread', '9dddc733-24b5-57c2-96a7-492ea316cd9c', { hold: true, commandRunning: true, stallProbe: true }, ['--stall-min', '1']);
  const follower = start(held.args, held.extra);
  await until(() => follower.output().includes('thread=held-thread'), 'held follower started');
  await until(() => follower.output().includes('quiet:'), 'deterministic stalled-command probe ran');
  const heldAsk = start(['ask', '--thread', 'held-thread', '--account', 'trae', '--timeout-min', '1', '--default', 'Keep baseline', 'Need decision']);
  await until(() => openQuestions(readEvents(), { owner: '9dddc733-24b5-57c2-96a7-492ea316cd9c' }).length === 1, 'held question');
  assert.ok(follower.child.exitCode === null, 'running ask shell is not stalled');
  assert.equal(inbox(readEvents(), '9dddc733-24b5-57c2-96a7-492ea316cd9c', readAck('9dddc733-24b5-57c2-96a7-492ea316cd9c')).running.length, 1, 'talkback never settles the running turn');
  assert.equal(run(['reply', '--account', 'trae', '--thread', 'held-thread', 'Continue']).status, 0);
  assert.equal((await heldAsk.done).code, 0);
  follower.child.kill('SIGTERM'); await follower.done;

  const out = path.join(tmp, 'deliverable.md');
  const conflict = launch('chatgpt', 'conflict-thread', 'f9f8f505-5092-54e4-81e7-5efcff2be6b8', { writeOut: out }, ['--out', out]);
  const overwritten = run(conflict.args, conflict.extra);
  assert.equal(overwritten.status, 0, overwritten.stderr);
  assert.equal(overwritten.stderr.split('\n').filter((line) => line.startsWith('output-conflict:')).length, 1);
  assert.match(fs.readFileSync(out, 'utf8'), /DONE fixture/);
  const clean = launch('chatgpt', 'clean-thread', '6bba0c2f-f1db-511f-adfc-a7164b298411', {}, ['--out', out]);
  assert.doesNotMatch(run(clean.args, clean.extra).stderr, /output-conflict:/);
  await import('./worker-talkback-relay-scenarios.mjs');
  console.log('PASS worker talkback: identity/config for TRAE, TTADK, ChatGPT; owner isolation, notes/limits/compaction, hook lines, ask/reply/timeouts, steer fallback, deterministic command stall guard, BC-44');
} finally {
  const exits = [...children].map((child) => new Promise((resolve) => { child.once('close', resolve); child.kill('SIGTERM'); }));
  await Promise.all(exits);
  if (original === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = original;
  fs.rmSync(tmp, { recursive: true, force: true });
}
