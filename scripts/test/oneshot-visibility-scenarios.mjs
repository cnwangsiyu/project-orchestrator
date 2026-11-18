#!/usr/bin/env node
// Public fixture records only. Never use live hubs, accounts, registries or worker commands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-visibility-')));
const previous = { ...process.env }, owner = '1c4bda11-327e-4d6e-93a7-7d46e99b4279';
const root = path.join(tmp, 'projects'), shared = path.join(root, '_shared'), profiles = path.join(tmp, 'accounts.json');
fs.mkdirSync(shared, { recursive: true });
fs.writeFileSync(profiles, JSON.stringify(Object.fromEntries(['main', 'ttadk'].map(account => [account,
  { home: path.join(tmp, account), hub: 'ws://127.0.0.1:1' }]))));
Object.assign(process.env, { HOME: tmp, ORCH_ROOT: root, RULES_SHARED: shared, CODEX_ACCOUNTS: profiles,
  CODEX_HOME: path.join(tmp, 'main'), CODEX_HUB: 'ws://127.0.0.1:1', ORCHESTRATOR_OWNER: '', ORCHESTRATOR_PROJECT: '',
  CODEX_WORKER_OWNER: '', CODEX_WORKER_THREAD: '', CODEX_WORKER_ACCOUNT: '', NODE_OPTIONS: '',
  CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDE_CODE_TASK_ID: '', CLAUDECODE: '', ROUTE_LOG: '0',
  RULES_DIGEST: path.join(scripts, '../references/global-rules.md') });
const children = new Set(), childPids = new Set();
const cli = (script, args, input) => {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    env: process.env, input, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const until = async (test, label) => {
  const deadline = Date.now() + 10000;
  while (!test()) {
    if (Date.now() >= deadline) throw Error(`timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const start = async (account, project, name, task = name) => {
  const dir = path.join(root, project, 'tasks', name);
  fs.mkdirSync(dir, { recursive: true });
  const args = [path.join(scripts, 'run-tracked.sh'), '--account', account, '--model', 'gpt-6.1-sol', '--effort', 'medium',
    '--owner', owner, '--project', project, '--task', task, '--name', name, '--task-dir', dir, '--cwd', tmp,
    '--out', path.join(dir, 'codex-last.md'), '--log', path.join(dir, 'codex.jsonl'), '--', process.execPath,
    path.join(scripts, 'test/fixtures/oneshot-visibility-child.mjs'), dir];
  const child = spawn('/bin/sh', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, stderr }); });
  });
  await until(() => fs.existsSync(path.join(dir, 'ready.json')), `${name} child ready`);
  const pid = JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8')).pid;
  childPids.add(pid);
  return { child, done, dir, account, project, name, task,
    registration: { id: name, pid: child.pid, status: 'running', command: ['/bin/sh', ...args].map(arg => JSON.stringify(arg)).join(' ') } };
};
try {
  const { runningWorkers } = await import('../lib/running-workers.mjs');
  const { readEvents, inbox } = await import('../lib/worker-events.mjs');
  const { readBoard, boardFile } = await import('../lib/task-board.mjs');
  const { matchingBackgroundTask } = await import('../lib/worker-background.mjs');
  const { loadDigest } = await import('../lib/global-rules.mjs');
  const now = Date.now(), base = { account: 'main', owner, pid: 1, model: 'gpt-6.1-sol', effort: 'medium' };
  const row = (runId, event, t, extra = {}) => ({ ...base, runId, event, t, ...extra });
  const sample = await runningWorkers({ rows: [
    row('hub-run', 'running', now - 1000), row('hub-run', 'running', now, { thread: 'hub-thread' }),
    row('legacy-exec', 'running', now), row('dead-exec', 'running', now, { pid: 2 }),
    row('json-exec', 'running', now, { followerCommand: 'exec', thread: 'exec-session', pid: 2 }),
    row('observed-run', 'running', now, { thread: 'observed-thread' }),
    row('observed-run', 'observed', now + 1, { thread: 'observed-thread', mayRun: false }),
  ], alive: pid => pid === 1, knownThread: async () => assert.fail('dead exec must never probe a hub'),
  activityOf: () => null });
  assert.deepEqual(sample.threads.map(worker => worker.runId).sort(), ['hub-run', 'legacy-exec']);
  assert.equal(sample.threads.find(worker => worker.runId === 'hub-run').startedAt, now - 1000);
  assert.equal(sample.unresolved.length, 0);
  const concurrentRows = [row('exec-a', 'running', now, { followerCommand: 'exec', thread: 'shared-session' }),
    row('exec-b', 'running', now, { followerCommand: 'exec', thread: 'shared-session' }),
    row('hub-completion', 'finished', now + 1, { thread: 'shared-session' })];
  const concurrent = await runningWorkers({ rows: concurrentRows, alive: () => true, activityOf: () => null });
  assert.equal(concurrent.threads.length, 2, 'exec runs do not alias a session or a registered hub thread');
  assert.equal(inbox(concurrentRows.map(row => ({ ...row, pid: process.pid })), owner).running.length, 2);
  concurrentRows.push(row('exec-a', 'finished', now + 2, { followerCommand: 'exec', thread: 'shared-session' }));
  assert.deepEqual((await runningWorkers({ rows: concurrentRows, alive: () => true, activityOf: () => null })).threads.map(row => row.runId), ['exec-b']);
  console.log('PASS threadless legacy events, provisional hub collapse, authoritative observations and PID-only exec recovery');

  const a = await start('main', 'lynx-view', 'T104-synthetic', 'T104');
  const b = await start('ttadk', 'lynx-view', 'T96-lookup');
  const c = await start('main', 'other-project', 'T-other');
  const workers = [a, b, c];
  const live = JSON.parse(cli('quota.mjs', ['--running', '--json']));
  assert.equal(live.threads.length, 3); assert.equal(live.byAccount.main.length, 2); assert.equal(live.byAccount.ttadk.length, 1);
  for (const worker of workers) {
    const shown = live.threads.find(row => row.name === worker.name);
    assert.equal(shown.account, worker.account); assert.equal(shown.model, 'gpt-6.1-sol'); assert.equal(shown.effort, 'medium');
    assert.equal(shown.project, worker.project); assert.equal(shown.task, worker.task); assert.equal(shown.owner, owner);
    assert.ok(shown.startedAt > now); assert.equal(shown.thread, null); assert.equal(shown.followerCommand, 'exec');
  }
  const quotaText = cli('quota.mjs', ['--running']);
  assert.match(quotaText, /exec name=T104-synthetic.*effort=medium project=lynx-view task=T104 started=\d{4}-/);
  const mine = cli('codex-worker.mjs', ['mine', '--owner', owner]);
  for (const worker of workers) assert.ok(mine.includes(`${worker.name}\trunning\t`));
  assert.match(mine, /thread=exec account=main model=gpt-6.1-sol effort=medium project=lynx-view task=T104 owner=.* started=\d{4}-/);
  assert.equal(cli('codex-worker.mjs', ['mine', '--owner', '985376d0-957e-49c8-9b7c-d46cb13469fb']), '');

  // Event observer refreshes the board even when nobody runs show/status.
  await until(() => fs.existsSync(boardFile('lynx-view')) && readBoard('lynx-view').tasks.length === 2, 'automatic exec board refresh');
  const board = JSON.parse(cli('board.mjs', ['show', '--project', 'lynx-view', '--json']));
  assert.equal(board.tasks.length, 2); assert.ok(board.tasks.every(task => task.auto.workers.length === 1 && task.state === 'running'));
  assert.equal(board.tasks.find(task => task.id === 'T104').auto.workers[0].owner, owner);
  const lynx = JSON.parse(cli('status.mjs', ['--project', 'lynx-view', '--json']));
  const other = JSON.parse(cli('status.mjs', ['--project', 'other-project', '--json']));
  assert.deepEqual(lynx.liveWorkers.map(row => row.name).sort(), [a.name, b.name].sort());
  assert.deepEqual(other.liveWorkers.map(row => row.name), [c.name]);
  assert.equal(lynx.mismatches.length, 0); assert.equal(other.mismatches.length, 0);
  console.log('PASS main and TTADK execs in quota, owner mine, automatic board and project-isolated live counts with complete launch metadata');

  fs.writeFileSync(path.join(shared, 'rules-seen.json'), JSON.stringify({ [owner]: { orchestrator: true, version: loadDigest().version } }));
  const running = inbox(readEvents(), owner).running;
  for (const row of running) {
    assert.ok(await matchingBackgroundTask(row, workers.map(worker => worker.registration), owner));
    const worker = workers.find(worker => worker.name === row.name);
    assert.ok(await matchingBackgroundTask(row, [{ command: worker.registration.command }], owner));
    assert.equal(await matchingBackgroundTask(row, [{ ...worker.registration, pid: 2147483647 }], owner), null);
    assert.equal(await matchingBackgroundTask(row, [{ ...worker.registration, command: worker.registration.command + ' &' }], owner), null);
  }
  const stop = tasks => cli('worker-inbox-hook.mjs', [], JSON.stringify({ session_id: owner, hook_event_name: 'Stop',
    cwd: tmp, stop_hook_active: false, background_tasks: tasks }));
  assert.equal(stop(workers.map(worker => worker.registration)), '', 'all attached exec tasks cover their own completion wakes');
  const uncovered = JSON.parse(stop([b.registration, c.registration]));
  assert.match(uncovered.reason, /T104-synthetic.*no matching tracked/);
  console.log('PASS Stop recognises registered exec wrappers but still requires coverage for missing or detached launches');

  fs.writeFileSync(path.join(a.dir, 'exit-code'), '0');
  assert.equal((await a.done).code, 0);
  fs.writeFileSync(path.join(c.dir, 'exit-code'), '5');
  assert.equal((await c.done).code, 5);
  b.child.kill('SIGKILL');
  const killed = await b.done; assert.equal(killed.signal, 'SIGKILL');
  assert.equal(readEvents().filter(row => row.name === b.name).at(-1).event, 'running', 'SIGKILL wrote no terminal event');
  const after = JSON.parse(cli('quota.mjs', ['--running', '--json']));
  assert.equal(after.threads.length, 0); assert.equal(after.unresolved.length, 0);
  const afterMine = cli('codex-worker.mjs', ['mine', '--owner', owner]);
  assert.ok(!afterMine.includes('\trunning\t')); assert.match(afterMine, /T96-lookup\tfailed \(exec follower exited\)/);
  assert.match(afterMine, /T104-synthetic\tfinished\t/); assert.match(afterMine, /T-other\tfailed\t/);
  const afterLynx = JSON.parse(cli('status.mjs', ['--project', 'lynx-view', '--json']));
  assert.equal(afterLynx.liveWorkers.length, 0);
  assert.equal(afterLynx.board.tasks.find(task => task.id === 'T104').auto.workers[0].state, 'finished');
  assert.equal(afterLynx.board.tasks.find(task => task.id === b.task).auto.workers[0].state, 'failed');
  assert.equal(afterLynx.board.tasks.find(task => task.id === b.task).state, 'blocked');
  const afterOther = JSON.parse(cli('status.mjs', ['--project', 'other-project', '--json']));
  assert.equal(afterOther.liveWorkers.length, 0); assert.equal(afterOther.board.tasks[0].auto.workers[0].state, 'failed');
  assert.equal(stop([]).includes('arm the watcher'), false, 'a dead exec has no unmatched-running warning');
  console.log('PASS clean exit, failure and SIGKILL leave all live views immediately; crashed exec board state becomes failed');
  console.log('One-shot visibility scenarios: all passed');
} finally {
  for (const child of children) child.kill('SIGTERM');
  for (const pid of childPids) try { process.kill(pid, 'SIGTERM'); } catch {}
  await new Promise(resolve => setTimeout(resolve, 6000));
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
