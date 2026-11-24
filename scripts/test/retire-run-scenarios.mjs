import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-run-'));
const shared = path.join(root, 'shared');
const task = path.join(root, 'task');
const owner = '1c4bda11-327e-4d6e-93a7-7d46e99b4279';
const previous = { ...process.env };
let wrapper, childPid;
let wrapperDone;
const until = async (test, label) => {
  const deadline = Date.now() + 10_000;
  while (!test()) {
    if (Date.now() > deadline) throw Error(`timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

try {
  fs.mkdirSync(task, { recursive: true });
  Object.assign(process.env, { HOME: root, RULES_SHARED: shared, ORCHESTRATOR_OWNER: '', CODEX_ACCOUNTS: path.join(root, 'accounts.json') });
  const child = path.join(scripts, 'test/fixtures/retire-run-child.mjs');
  wrapper = spawn(process.execPath, [path.join(scripts, 'run-tracked.mjs'), '--account', 'main', '--owner', owner,
    '--project', 'fixture', '--task', 'R-cleanup', '--name', 'R-cleanup', '--task-dir', task, '--out', path.join(task, 'codex-last.md'),
    '--log', path.join(task, 'codex.jsonl'), '--', process.execPath, child, task], { env: process.env, stdio: 'ignore' });
  wrapperDone = new Promise(resolve => wrapper.once('close', resolve));
  await until(() => fs.existsSync(path.join(task, 'ready.json')), 'fixture report');
  const { readEvents, appendEvent } = await import('../lib/worker-events.mjs');
  const { processIdentity } = await import('../lib/process-identity.mjs');
  // The child can report ready before the wrapper has appended its running event (the identity probe blocks briefly).
  await until(() => readEvents().some(row => row.event === 'running' && row.name === 'R-cleanup' && row.childIdentity), 'running event with child identity');
  const active = readEvents().findLast(row => row.event === 'running' && row.name === 'R-cleanup');
  assert.ok(active?.pidIdentity && active.childIdentity && active.childPgid === active.childPid, 'exec launch records proven wrapper and child identities');
  childPid = active.childPid;
  const retired = spawnSync(process.execPath, [path.join(scripts, 'codex-worker.mjs'), '--account', 'main', 'retire', '--run', active.runId, '--owner', owner],
    { env: process.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(retired.status, 0, retired.stderr);
  assert.match(retired.stdout, /TERM pid=\d+ name=/); assert.match(retired.stdout, /KILL pid=\d+ name=/);
  await wrapperDone;
  assert.equal(readEvents().findLast(row => row.runId === active.runId).event, 'retired');

  appendEvent({ account: 'main', owner, runId: 'foreign-run', event: 'running', followerCommand: 'exec', pid: process.pid,
    pidIdentity: { ...processIdentity(process.pid), started: 'not-this-process' }, name: 'foreign', t: Date.now() });
  const refused = spawnSync(process.execPath, [path.join(scripts, 'codex-worker.mjs'), '--account', 'main', 'retire', '--run', 'foreign-run', '--owner', owner],
    { env: process.env, encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /identity no longer belongs/);
  console.log('PASS retire --run proves exec ownership, stops only its tree, clears tracking and rejects reused PIDs');
} finally {
  try { wrapper?.kill('SIGKILL'); } catch {}
  if (childPid) try { process.kill(-childPid, 'SIGKILL'); } catch {}
  await new Promise(resolve => setTimeout(resolve, 50));
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
