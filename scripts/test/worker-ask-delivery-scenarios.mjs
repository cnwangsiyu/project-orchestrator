#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { appendEvent, hasWatcher, openQuestions, readEvents, saveWorkerContext } from '../lib/worker-events.mjs';
import { loadDigest } from '../lib/global-rules.mjs';
import { resolveTalkbackIdentity } from '../lib/worker-talkback.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-ask-delivery-'));
const worker = fileURLToPath(new URL('../codex-worker.mjs', import.meta.url));
const transport = fileURLToPath(new URL('./fixtures/worker-events-transport.mjs', import.meta.url));
const owner = 'aa025977-7b07-4d9d-9a3f-11a1a3f74191';
const thread = 'fixture-main-thread', turn = 'continued-turn';
const profiles = path.join(dir, 'accounts.json'), clock = path.join(dir, 'clock.mjs');
process.env.RULES_SHARED = dir;
const env = { ...process.env, RULES_SHARED: dir, CODEX_ACCOUNTS: profiles, NODE_OPTIONS: '', ORCHESTRATOR_OWNER: '',
  CODEX_WORKER_THREAD: '', CODEX_WORKER_ACCOUNT: '', CODEX_THREAD_ID: thread, TRAECLI_THREAD_ID: '',
  WORKER_EVENTS_FIXTURE: JSON.stringify({ thread, turn }) };
const children = new Map();
const watchArgs = ['watch', '--owner', owner, '--debounce-sec', '0'];
const start = (args, at) => {
  const child = spawn(process.execPath, ['--import', transport, ...(at ? ['--import', clock] : []), worker, ...args], {
    env: { ...env, FIXTURE_TIME: String(at ?? '') }, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise(resolve => child.once('close', code => {
    children.delete(child);
    resolve({ code, stdout, stderr });
  }));
  children.set(child, done);
  return { child, done, output: () => stdout };
};
const run = args => spawnSync(process.execPath, ['--import', transport, worker, ...args],
  { env, cwd: dir, encoding: 'utf8', timeout: 5000 });
const until = async predicate => {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await pause(20);
  }
  assert.fail('watch or ask did not become ready');
};
const done = async operation => {
  const limit = setTimeout(() => operation.child.kill(), 7500);
  try {
    const result = await operation.done;
    assert.equal(result.code, 0, result.stderr);
    return result;
  } finally { clearTimeout(limit); }
};

try {
  fs.writeFileSync(profiles, '{}');
  fs.writeFileSync(clock, 'Date.now = () => Number(process.env.FIXTURE_TIME);\n');
  const initialWatch = start(watchArgs);
  await until(() => hasWatcher(owner));

  // T120 used an account from an earlier attempt on the current main thread.
  const current = { owner, account: 'main', thread, turn, runId: 'current-attempt', cwd: dir, pid: process.pid,
    name: 'T120-fixture', followerCommand: 'turn', rulesVersion: loadDigest().version };
  saveWorkerContext(current);
  appendEvent({ ...current, event: 'running' });
  const ask = start(['--account', 'trae', 'ask', '--thread', thread, '--timeout-min', '30', '--default', 'Stop', 'Registry entry ready?']);
  const initial = await done(initialWatch);
  assert.match(initial.stdout, /Registry entry ready\?.*--account main/);
  const [question] = openQuestions(readEvents(), { owner });
  assert.equal(question.runId, current.runId);
  const deadline = new Date(question.expiresAt).toISOString();
  assert.ok(initial.stdout.includes(deadline));
  const pending = run(['mine', '--owner', owner]);
  assert.equal(pending.status, 0, pending.stderr);
  assert.ok(pending.stdout.includes(`deadline ${deadline}`));

  const midway = question.expiresAt - 900000;
  const half = await done(start(watchArgs, midway));
  assert.match(half.stdout, /reminder: half of the timeout has elapsed/);
  assert.ok(half.stdout.includes(question.questionId));
  const rearmed = start(watchArgs, midway + 1000);
  await until(() => hasWatcher(owner));
  await pause(350);
  assert.equal(rearmed.child.exitCode, null);
  assert.equal(rearmed.output(), '');
  rearmed.child.kill();
  await rearmed.done;
  const lastFive = await done(start(watchArgs, question.expiresAt - 300000));
  assert.match(lastFive.stdout, /reminder: deadline is within five minutes/);
  assert.ok(lastFive.stdout.includes(question.questionId) && lastFive.stdout.includes(deadline));

  const reply = run(['reply', '--account', 'main', '--thread', thread, '--question', question.questionId, 'Ready']);
  assert.equal(reply.status, 0, reply.stderr);
  const answer = await done(ask);
  assert.equal(answer.stdout, 'Ready\n');
  assert.match(answer.stderr, /corrected account trae -> main/);
  assert.equal(openQuestions(readEvents(), { owner }).length, 0);
  assert.doesNotMatch(run(['mine', '--owner', owner]).stdout, /Registry entry ready/);

  assert.throws(() => resolveTalkbackIdentity({ account: 'trae', thread, cwd: dir, env: {} }), /no launching owner/);
  const duplicate = { ...current, account: 'b', runId: 'duplicate-attempt' };
  saveWorkerContext(duplicate);
  appendEvent({ ...duplicate, event: 'running' });
  assert.throws(() => resolveTalkbackIdentity({ account: 'trae', thread, cwd: dir, env }), /identity ambiguous/);
  assert.equal(resolveTalkbackIdentity({ account: 'main', thread, cwd: dir, env }).account, 'main');
  console.log('PASS T120 account mismatch, armed watcher delivery, UTC mine deadline, both durable reminders and ambiguity handling');
} finally {
  for (const [child] of children) child.kill();
  await Promise.all(children.values());
  fs.rmSync(dir, { recursive: true, force: true });
}
