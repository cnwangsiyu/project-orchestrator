#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTurnState, readTurnState, reconcileTurnEvents } from '../lib/worker-turn.mjs';
import { runningWorkers } from '../lib/running-workers.mjs';
import { inbox } from '../lib/worker-events.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'live-turn-status-')));
const worker = path.join(scripts, 'codex-worker.mjs'), transport = path.join(scripts, 'test/fixtures/live-turn-transport.mjs');
const owner = '73cffdc8-909e-43d7-a7bb-aab202c6be57', otherOwner = 'a4f6014f-88e9-4306-9128-9d6aace682b6';
const children = new Set();
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const saveHub = (f, state) => {
  const tmp = `${f.state}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, f.state);
};
const until = async (test, label) => {
  const deadline = Date.now() + 10000;
  while (!test()) {
    if (Date.now() >= deadline) throw Error(`timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const fixture = label => {
  const dir = path.join(tmp, label), home = path.join(dir, 'home'), profiles = path.join(dir, 'accounts.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(profiles, JSON.stringify({ fixture: { kind: 'trae', home, hub: 'ws://127.0.0.1:1' } }));
  const state = path.join(dir, 'hub.json'), rpc = path.join(dir, 'rpc.jsonl');
  fs.writeFileSync(state, JSON.stringify({ persisted: [{ id: 'old-turn', status: 'completed', items: [] }] }));
  return { dir, home, state, rpc, events: path.join(dir, 'worker-events.jsonl'), env: { ...process.env,
    HOME: home, CODEX_HOME: home, CODEX_HUB: 'ws://127.0.0.1:1', CODEX_ACCOUNTS: profiles, RULES_SHARED: dir,
    ORCH_ROOT: path.join(dir, 'projects'), ORCHESTRATOR_OWNER: '', ORCHESTRATOR_PROJECT: '', NODE_OPTIONS: '',
    ROUTE_LOG_FILE: path.join(dir, 'route.jsonl'), RULES_DIGEST: path.join(scripts, '../references/global-rules.md'),
    LIVE_TURN_FIXTURE: JSON.stringify({ state, rpc, thread: 'existing-thread', turn: 'resumed-turn' }) } };
};
const args = (command, flags = []) => ['--import', transport, worker, '--account', 'fixture', command,
  ...(command === 'mine' ? ['--owner', owner] : ['--thread', 'existing-thread']), ...flags];
const cli = (f, command, flags = []) => {
  const result = spawnSync(process.execPath, args(command, flags), { env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, result.stderr);
  return result;
};
const start = async f => {
  const child = spawn(process.execPath, args('turn', ['--owner', owner, '--name', 'resumed-worker', '--effort', 'high',
    '--model', 'fixture', '--stall-min', '0', '--out', path.join(f.dir, 'final.md'), 'Follow the isolated fixture.']),
  { cwd: f.dir, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { children.delete(child); resolve({ code, stdout, stderr }); });
  });
  await until(() => rows(f.events).some(row => row.event === 'running' && row.turn === 'resumed-turn'), 'resumed follower');
  return { child, done };
};
const status = f => {
  const result = cli(f, 'status'); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
};
const finish = f => {
  const state = JSON.parse(fs.readFileSync(f.state, 'utf8'));
  state.live = { ...state.live, status: 'completed', items: [{ type: 'agentMessage', text: 'DONE resumed fixture' }] };
  saveHub(f, state);
};
try {
  const active = { account: 'fixture', thread: 'existing-thread', turn: 'resumed-turn', runId: 'resumed-run',
    event: 'running', pid: process.pid, owner, t: 2, mayRun: true };
  const old = { ...active, turn: 'old-turn', runId: 'old-run', t: 1 };
  const resolve = extra => resolveTurnState({ account: active.account, thread: active.thread, rows: [active],
    result: { thread: { turns: [{ id: 'old-turn', status: 'completed' }] } }, ...extra });
  assert.equal(resolve({ liveThread: { turns: [{ id: 'old-turn', status: 'inProgress' }] } }).turn.id, 'resumed-turn');
  assert.equal(resolve({ rows: [old, active, { ...old, event: 'finished', mayRun: false, t: 3 }] }).turn.id, 'resumed-turn');
  assert.equal(resolve({ rows: [old, active, { ...active, event: 'finished', mayRun: false, t: 3 },
    { ...old, event: 'finished', mayRun: false, t: 4 }] }).turn.id, 'resumed-turn');
  assert.equal(resolve({ alive: () => false }).turn.status, 'unknown', 'a dead PID alone never proves a live turn');
  assert.equal(resolve({ alive: () => false, result: { thread: { turns: [{ id: 'resumed-turn', status: 'inProgress' }] } } })
    .turn.status, 'inProgress', 'a detached follower can still use a hub-confirmed running turn');
  assert.equal(resolve({ rows: [], context: active }).turn.id, 'resumed-turn', 'live follower context survives missing events');
  assert.equal(resolve({ rows: [], context: active, alive: () => false }).turn.id, 'old-turn');
  assert.equal(resolve({ rows: [{ ...active, followerCommand: 'exec' }] }).turn.id, 'old-turn');
  assert.equal(resolve({ rows: [{ ...active, account: 'other' }] }).turn.id, 'old-turn');
  const completed = { ...active, event: 'finished', mayRun: false, status: 'completed' };
  assert.equal(resolve({ rows: [completed], result: { thread: { turns: [{ id: 'resumed-turn', status: 'inProgress' }] } } }).turn.status, 'completed');
  assert.equal(resolve({ result: { thread: { turns: [{ id: 'resumed-turn', status: 'completed' }] } } }).turn.status, 'completed');
  assert.equal(resolve({ rows: [], result: { thread: { turns: [{ id: 'old-turn', status: 'completed' }],
    activeTurn: { id: 'hub-live-turn', status: 'inProgress' } } } }).turn.id, 'hub-live-turn');
  assert.equal(resolve({ rows: [completed], result: { thread: { turns: [{ id: 'resumed-turn', status: 'completed' },
    { id: 'new-untracked-turn', status: 'inProgress' }] } } }).turn.id, 'new-untracked-turn');
  assert.equal(resolve({ rows: [completed], result: { thread: { turns: [{ id: 'new-untracked-turn', status: 'inProgress' }] } } })
    .turn.id, 'new-untracked-turn', 'a finished follower does not mask a later untracked hub turn');
  const poisoned = { ...active, event: 'observed', turn: 'old-turn', status: 'completed', mayRun: false };
  assert.equal(resolve({ rows: [poisoned], context: active }).turn.id, 'resumed-turn');
  for (const context of [{ ...active, runId: 'other-run' }, { ...active, owner: otherOwner },
    { ...active, account: 'other' }, { ...active, thread: 'other-thread' }])
    assert.equal(reconcileTurnEvents([poisoned], { contextFor: () => context })[0].event, 'observed');
  const started = Date.now();
  const slow = await readTurnState({ account: active.account, thread: active.thread, rows: [active],
    readThread: () => new Promise(() => {}), readTimeoutMs: 20 });
  assert.equal(slow.turn.id, 'resumed-turn'); assert.equal(slow.turn.status, 'inProgress');
  assert.ok(Date.now() - started < 2000, 'live tracker does not wait for hung persisted history');
  console.log('PASS live sources, same-turn settlement, stale resume, late old completion, dead/exec/account guards and history fallback');

  const f = fixture('resumed'), follower = await start(f);
  assert.equal(status(f).last.id, 'resumed-turn');
  assert.equal(status(f).last.status, 'inProgress');
  assert.equal(status(f).turns, 2);
  fs.writeFileSync(path.join(f.home, 'queue-status.json'), JSON.stringify({ 'existing-thread':
    { turnId: 'resumed-turn', state: 'waiting', position: 3, since: 123 } }));
  assert.deepEqual(status(f).queue, { state: 'waiting', position: 3, since: 123 });
  for (let i = 0; i < 2; i++) {
    const mine = cli(f, 'mine'); assert.equal(mine.status, 0, mine.stderr);
    assert.match(mine.stdout, /resumed-worker\trunning/);
    assert.ok(!rows(f.events).some(row => row.event === 'observed'), 'old persisted completion never settles the live run');
  }
  const steer = cli(f, 'steer', ['Fixture steer']); assert.equal(steer.status, 0, steer.stderr);
  assert.equal(rows(f.rpc).findLast(row => row.method === 'turn/steer').params.expectedTurnId, 'resumed-turn');
  assert.ok(!cli(f, 'mine', ['--owner', otherOwner]).stdout.includes('resumed-worker'), 'mine stays owner-scoped');
  finish(f);
  assert.equal((await follower.done).code, 0);
  assert.equal(status(f).last.id, 'resumed-turn');
  assert.equal(status(f).last.status, 'completed', 'completion beats the stale old persisted turn');
  assert.equal(status(f).queue, 'no queue info');
  assert.ok(!cli(f, 'mine').stdout.includes('resumed-worker\trunning'));
  assert.equal(cli(f, 'steer', ['After completion']).status, 3);
  console.log('PASS resumed turn is visible to status/steer/mine and retires after completion');

  const interrupted = fixture('interrupt'), interruptedFollower = await start(interrupted);
  const stop = cli(interrupted, 'interrupt'); assert.equal(stop.status, 0, stop.stderr);
  assert.equal(rows(interrupted.rpc).findLast(row => row.method === 'turn/interrupt').params.turnId, 'resumed-turn');
  assert.equal((await interruptedFollower.done).code, 1);
  assert.equal(status(interrupted).last.status, 'interrupted');
  assert.ok(!cli(interrupted, 'mine').stdout.includes('resumed-worker\trunning'));
  console.log('PASS interrupt targets the resumed turn, not the old persisted turn');

  const stale = fixture('stale-observation'), staleFollower = await start(stale);
  const running = rows(stale.events).findLast(row => row.event === 'running');
  fs.appendFileSync(stale.events, JSON.stringify({ ...running, id: 'old-observation', event: 'observed', t: Date.now(),
    turn: 'old-turn', status: 'completed', mayRun: false }) + '\n');
  assert.match(cli(stale, 'mine').stdout, /resumed-worker\trunning/);
  assert.equal(status(stale).last.id, 'resumed-turn');
  assert.equal(inbox(rows(stale.events), owner).running.length, 1);
  const live = await runningWorkers({ rows: rows(stale.events), activityOf: () => null });
  assert.equal(live.byAccount.fixture.length, 1, 'board/quota view retains the resumed follower');
  finish(stale); await staleFollower.done;
  assert.equal((await runningWorkers({ rows: rows(stale.events), activityOf: () => null })).threads.length, 0);
  console.log('PASS stale observations for another turn cannot hide a live follower');

  const compacted = fixture('compacted-observation'), compactedFollower = await start(compacted);
  const attached = rows(compacted.events).findLast(row => row.event === 'running');
  const contextFile = path.join(compacted.dir, 'worker-context/fixture/existing-thread.json');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8')); delete context.pid;
  fs.writeFileSync(contextFile, JSON.stringify(context));
  fs.writeFileSync(compacted.events, JSON.stringify({ ...attached, id: 'compacted-old-observation', event: 'observed',
    turn: 'old-turn', status: 'completed', mayRun: false }) + '\n');
  const before = fs.readFileSync(compacted.events, 'utf8');
  assert.equal(status(compacted).last.id, 'resumed-turn');
  assert.match(cli(compacted, 'mine').stdout, /resumed-worker\trunning/);
  assert.equal(fs.readFileSync(compacted.events, 'utf8'), before, 'recovery does not rewrite tracker files');
  finish(compacted); await compactedFollower.done;
  assert.equal(status(compacted).last.status, 'completed');
  assert.ok(!cli(compacted, 'mine').stdout.includes('resumed-worker\trunning'));
  console.log('PASS public context recovers a compacted stale observation without mutating records');

  const unavailable = fixture('read-unavailable'), unavailableFollower = await start(unavailable);
  const hub = JSON.parse(fs.readFileSync(unavailable.state, 'utf8')); hub.readError = true;
  saveHub(unavailable, hub);
  assert.equal(status(unavailable).last.status, 'inProgress');
  assert.equal(cli(unavailable, 'steer', ['Known live follower']).status, 0);
  assert.match(cli(unavailable, 'mine').stdout, /resumed-worker\trunning/);
  finish(unavailable); await unavailableFollower.done;
  assert.equal(status(unavailable).last.status, 'completed');
  console.log('PASS tracker remains usable when persisted thread reads fail');
} finally {
  for (const child of children) child.kill('SIGTERM');
  await until(() => children.size === 0, 'fixture cleanup');
  fs.rmSync(tmp, { recursive: true, force: true });
}
