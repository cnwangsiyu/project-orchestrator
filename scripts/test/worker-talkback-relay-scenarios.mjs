import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEvent, saveWorkerContext, readEvents, openQuestions } from '../lib/worker-events.mjs';
import { createTalkbackRelay, TALKBACK_MARKER, resolveTalkbackIdentity } from '../lib/worker-talkback.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worker = path.join(scripts, 'codex-worker.mjs'), fixture = path.join(scripts, 'test/fixtures/worker-events-transport.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'talkback-relay-')), previous = process.env.RULES_SHARED;
process.env.RULES_SHARED = tmp;
const project = path.join(tmp, 'project'), childDir = path.join(project, 'sub'), other = path.join(tmp, 'other');
for (const dir of [childDir, other]) fs.mkdirSync(dir, { recursive: true });
const accounts = path.join(tmp, 'accounts.json');
fs.writeFileSync(accounts, JSON.stringify(Object.fromEntries(['trae', 'ttadk', 'alt'].map((name) => [name,
  { kind: name === 'alt' ? 'chatgpt' : name, home: path.join(tmp, name), hub: 'ws://127.0.0.1:1' }]))));
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: accounts, NODE_OPTIONS: '',
  ORCHESTRATOR_OWNER: '', CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '',
  CODEX_WORKER_THREAD: '', CODEX_WORKER_ACCOUNT: '', CODEX_WORKER_OWNER: '', CODEX_WORKER_NAME: '', WORKER_EVENTS_FIXTURE: '{}' };
const run = (args, extra = {}, cwd = project) => spawnSync(process.execPath, ['--import', fixture, worker, ...args],
  { env: { ...env, ...extra }, cwd, encoding: 'utf8', timeout: 8000 });
const children = new Set();
const start = (args, config = {}, cwd = project) => {
  const processEnv = { ...env, WORKER_EVENTS_FIXTURE: JSON.stringify(config) };
  const child = spawn(process.execPath, ['--import', fixture, worker, ...args], { env: processEnv, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', (b) => stdout += b); child.stderr.on('data', (b) => stderr += b);
  const done = new Promise((resolve) => child.on('close', (code) => { children.delete(child); resolve({ code, stdout, stderr }); }));
  return { child, done, output: () => stdout };
};
const until = async (fn, label) => {
  const deadline = Date.now() + 8000;
  while (!fn()) { if (Date.now() > deadline) throw Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 30)); }
};
const seed = (thread, cwd, startedAt, event = 'running') => {
  const metadata = { account: 'alt', thread, owner: '642e45a7-f078-50b2-8e47-185a17d3d0cf', name: thread, runId: `${thread}-run`,
    turn: `${thread}-turn`, cwd, startedAt, pid: process.pid };
  saveWorkerContext(metadata); appendEvent({ ...metadata, event, mayRun: event === 'running' }); return metadata;
};
const rows = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
try {
  const old = seed('one-thread', project, 1);
  const one = run(['note', '--kind', 'info', 'bare one'], {}, childDir);
  assert.equal(one.status, 0, one.stderr); assert.match(one.stderr, /talkback: using thread one-thread \(account alt\)/);
  assert.equal(readEvents().filter((r) => r.event === 'message').at(-1).thread, old.thread);
  const oneAsk = run(['ask', '--timeout-min', '0.003', '--default', 'banana', 'one-context question'], {}, childDir);
  assert.equal(oneAsk.status, 3, oneAsk.stderr); assert.equal(oneAsk.stdout, 'banana\n');
  assert.match(oneAsk.stderr, /using thread one-thread/);
  seed('unrelated-thread', other, 999);
  seed('completed-thread', project, 9999, 'finished');
  const newest = seed('new-thread', childDir, 2);
  const several = run(['note', 'bare newest']);
  assert.equal(several.status, 0, several.stderr); assert.match(several.stderr, /using thread new-thread.*newest of 2/);
  assert.equal(resolveTalkbackIdentity({ account: 'alt', cwd: project }).thread, newest.thread);
  const ask = start(['ask', '--timeout-min', '1', '--default', 'banana', 'bare decision?']);
  await until(() => openQuestions(readEvents(), { thread: newest.thread }).length === 1, 'bare discovered question');
  const reply = run(['--account', 'alt', 'reply', '--thread', newest.thread, '--owner', newest.owner, 'pear']);
  assert.equal(reply.status, 0, reply.stderr);
  const result = await ask.done; assert.equal(result.code, 0); assert.equal(result.stdout, 'pear\n'); assert.match(result.stderr, /using thread new-thread/);
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
  const none = run(['note', 'no matching thread'], { RULES_SHARED: empty });
  assert.equal(none.status, 2); assert.match(none.stderr, /identity not found.*--account NAME.*--thread ID/);
  assert.doesNotMatch(none.stderr, /invalid public account\/thread identifier/);
  const noneAsk = run(['ask', '--default', 'banana', 'no matching question'], { RULES_SHARED: empty });
  assert.equal(noneAsk.status, 2); assert.match(noneAsk.stderr, /identity not found/);
  const malformed = run(['note', '--thread', '../bad', 'malformed']);
  assert.equal(malformed.status, 2); assert.match(malformed.stderr, /invalid public account\/thread identifier/);

  // A real env subprocess exercises the fake hub's shell policy, without inheriting
  // the test runner's environment. It is evidence for the fixture, not a live hub.
  for (const [account, mode] of [['alt', 'apply'], ['ttadk', 'apply'], ['trae', 'ignore']]) {
    const captureEnv = path.join(tmp, `${account}-env.txt`), thread = `env-${account}`, rpc = path.join(tmp, `${thread}-rpc.jsonl`);
    const r = run(['--account', account, 'start', '--cwd', project, '--sandbox', 'danger-full-access', '--owner', 'daab37a9-7727-55d2-8931-df08878ab2b6',
      '--effort', 'high', '--model', 'fixture', '--name', thread, 'Capture fixture environment.'],
    { WORKER_EVENTS_FIXTURE: JSON.stringify({ thread, captureEnv, rpc, shellEnvMode: mode }) });
    assert.equal(r.status, 0, r.stderr + r.stdout + String(r.error ?? '') + String(r.signal ?? ''));
    const captured = fs.readFileSync(captureEnv, 'utf8');
    if (mode === 'apply') {
      assert.match(captured, new RegExp(`CODEX_WORKER_THREAD=${thread}\\n`));
      assert.match(captured, new RegExp(`CODEX_WORKER_ACCOUNT=${account}\\n`));
      assert.match(captured, /CODEX_WORKER_OWNER=daab37a9-7727-55d2-8931-df08878ab2b6\n/);
    } else assert.doesNotMatch(captured, /CODEX_WORKER_/);
    const context = JSON.parse(fs.readFileSync(path.join(tmp, 'worker-context', account, `${thread}.json`)));
    assert.equal(context.cwd, project); assert.equal(context.turn, 'turn-fixture'); assert.ok(Number.isFinite(context.startedAt));
    const oldStart = context.startedAt;
    const turn = run(['--account', account, 'turn', '--thread', thread, '--effort', 'high', '--model', 'fixture', 'Continue fixture.'],
      { WORKER_EVENTS_FIXTURE: JSON.stringify({ thread }) });
    assert.equal(turn.status, 0, turn.stderr + turn.stdout);
    assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'worker-context', account, `${thread}.json`))).startedAt >= oldStart);
    assert.equal(rows(rpc).find((row) => row.method === 'thread/start').params.sandbox, 'danger-full-access');
  }

  for (const config of [
    { account: 'trae', sandbox: 'read-only', denyCode: 'EACCES', streamOutput: true },
    { account: 'ttadk', sandbox: 'workspace-write', denyCode: 'EPERM', streamOutput: true },
    { account: 'alt', sandbox: 'read-only', denyCode: 'EROFS', streamOutput: false },
  ]) {
    const thread = `restricted-${config.account}`, owner = randomUUID(), rpc = path.join(tmp, `${thread}-rpc.jsonl`);
    const shellResults = path.join(tmp, `${thread}-results.jsonl`);
    const follower = start(['--account', config.account, 'start', '--cwd', project, '--sandbox', config.sandbox,
      '--owner', owner, '--name', thread, '--effort', 'high', '--model', 'fixture', 'Run restricted fixture.'],
    { ...config, thread, rpc, shellResults, shellCwd: project, shellEnvMode: 'ignore', denyShared: true,
      shellSequence: [['note', '--kind', 'risk', 'Restricted milestone'], ['ask', '--timeout-min', '1', '--default', 'banana', 'Restricted decision?'],
        ...(!config.streamOutput ? [['ask', '--await', '@await-id']] : [])] });
    await until(() => openQuestions(readEvents(), { owner }).length === 1, `relayed question ${config.account}`);
    const question = openQuestions(readEvents(), { owner })[0];
    assert.equal(question.thread, thread); assert.equal(question.default, 'banana');
    const r = run(['--account', config.account, 'reply', '--owner', owner, '--thread', thread, 'pear']);
    assert.equal(r.status, 0, r.stderr);
    const finished = await follower.done; assert.equal(finished.code, 0, finished.stderr);
    const commands = rows(shellResults);
    assert.equal(commands[0].code, 0); assert.match(commands[0].output, /@@codex-worker-talkback /);
    assert.equal(commands[1].code, config.streamOutput ? 0 : 6);
    if (config.streamOutput) assert.match(commands[1].output, /pear\n/);
    else { assert.match(commands[1].output, /re-run .*ask --thread .*--await/); assert.equal(commands[2].code, 0); assert.match(commands[2].output, /pear\n/); }
    const own = readEvents().filter((row) => row.owner === owner);
    assert.equal(own.filter((row) => row.event === 'message').length, 1, 'delta plus completed output is delivered once');
    assert.equal(own.filter((row) => row.event === 'question').length, 1, 'await never creates a second question');
    assert.equal(rows(rpc).find((row) => row.method === 'thread/start').params.sandbox, config.sandbox);
  }

  const metadata = seed('parser-thread', project, 3), relay = createTalkbackRelay(metadata);
  const request = { version: 1, type: 'message', account: metadata.account, thread: metadata.thread, id: 'parser-message',
    kind: 'risk', text: 'Parser milestone', owner: 'fe77cb4a-c107-5359-85e8-ec299a8079c6' };
  const marker = TALKBACK_MARKER + JSON.stringify(request) + '\n';
  const delta = (threadId, turnId, value) => ({ method: 'item/commandExecution/outputDelta', params: { threadId, turnId, itemId: 'parser-command', delta: value } });
  relay(delta('other-thread', metadata.turn, marker)); relay(delta(metadata.thread, 'old-turn', marker));
  relay(delta(metadata.thread, metadata.turn, TALKBACK_MARKER + JSON.stringify({ ...request, thread: 'other-thread' }) + '\n'));
  relay({ method: 'item/completed', params: { threadId: metadata.thread, turnId: metadata.turn, item: { type: 'agentMessage', text: marker } } });
  assert.equal(readEvents().filter((row) => row.talkbackId === request.id).length, 0);
  relay(delta(metadata.thread, metadata.turn, marker.slice(0, 12)));
  relay(delta(metadata.thread, metadata.turn, marker.slice(12)));
  relay({ method: 'item/completed', params: { threadId: metadata.thread, turnId: metadata.turn,
    item: { type: 'commandExecution', id: 'parser-command', aggregatedOutput: marker } } });
  const recorded = readEvents().filter((row) => row.talkbackId === request.id);
  assert.equal(recorded.length, 1); assert.equal(recorded[0].owner, metadata.owner);
  for (let n = 0; n < 7; n++) relay(delta(metadata.thread, metadata.turn,
    TALKBACK_MARKER + JSON.stringify({ ...request, id: `rate-${n}`, text: `relay note ${n}` }) + '\n'));
  const notes = readEvents().filter((row) => row.event === 'message' && row.thread === metadata.thread);
  assert.equal(notes.filter((row) => row.wake).length, 6); assert.equal(notes.length, 8);

  for (const wake of [false, true]) {
    const id = `info-wake-${wake}`;
    relay(delta(metadata.thread, metadata.turn, TALKBACK_MARKER + JSON.stringify({ ...request, id, kind: 'info', wake }) + '\n'));
    // This thread exhausted its limit above, so use a fresh fixture context for explicit wake.
    const fresh = seed(`wake-thread-${wake}`, project, 4), freshRelay = createTalkbackRelay(fresh);
    freshRelay({ method: 'item/completed', params: { threadId: fresh.thread, turnId: fresh.turn,
      item: { type: 'commandExecution', id, aggregatedOutput: TALKBACK_MARKER + JSON.stringify({ ...request,
        account: fresh.account, thread: fresh.thread, id, kind: 'info', wake }) } } });
    assert.equal(readEvents().find((row) => row.thread === fresh.thread && row.talkbackId === id).wake, wake);
  }

  // Reattached wait followers also relay markers retained in the current turn's items.
  const waitThread = 'wait-thread', waitOwner = '93877d4c-b472-5c71-864f-94e29e3eb022', waitId = 'wait-question';
  const waitMarker = TALKBACK_MARKER + JSON.stringify({ version: 1, type: 'question', id: waitId, account: 'alt', thread: waitThread,
    text: 'Recovered question?', timeoutMin: 1, expiresAt: Date.now() + 60000, default: 'banana' }) + '\n';
  const waiting = start(['--account', 'alt', 'wait', '--thread', waitThread, '--owner', waitOwner], { thread: waitThread,
    items: [{ id: 'wait-command', type: 'commandExecution', aggregatedOutput: waitMarker }] });
  await until(() => openQuestions(readEvents(), { owner: waitOwner }).length === 1, 'wait relayed retained command output');
  waiting.child.kill('SIGTERM'); await waiting.done;
  console.log('PASS talkback fixes: bare identity one/newest/none, context lifecycle, real env through fake hub, denied-write markers, streaming/await replies, scope/dedup/rate limit, wait reattachment');
} finally {
  const exits = [...children].map((child) => new Promise((resolve) => { child.once('close', resolve); child.kill('SIGTERM'); }));
  await Promise.all(exits);
  if (previous === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
}
