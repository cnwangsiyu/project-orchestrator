#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardFile, readBoard, setTask, linkTask, removeTask, refreshBoard } from '../lib/task-board.mjs';
import { acquireLock, withLock } from '../lib/shared-file.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-contention-'));
const previous = { ...process.env }, root = path.join(tmp, 'orchestrator'), shared = path.join(root, '_shared');
Object.assign(process.env, { HOME: tmp, ORCH_ROOT: root, RULES_SHARED: shared, ORCHESTRATOR_PROJECT: '',
  CODEX_ACCOUNTS: path.join(shared, 'accounts.json') });
fs.mkdirSync(shared, { recursive: true }); fs.writeFileSync(process.env.CODEX_ACCOUNTS, '{}');
const children = new Set();
const log = path.join(tmp, 'rollout.jsonl'), signal = path.join(tmp, 'parsing'), preload = path.join(tmp, 'slow-read.mjs');
const now = Date.now();
const launch = { account: 'fixture', thread: 'thread', t: now, defaults: { project: 'contention', name: 'auto-worker', log } };
const running = { id: 'running', runId: 'run', account: 'fixture', thread: 'thread', t: now, project: 'contention', name: 'auto-worker', event: 'running', pid: process.pid };
const facts = { launches: [launch], events: [running], live: { threads: [], unresolved: [] } };
const waitFor = async test => {
  const deadline = Date.now() + 10000;
  while (!test()) {
    if (Date.now() > deadline) throw Error('fixture readiness timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
try {
  fs.writeFileSync(log, JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Slow fixture' } } }) + '\n');
  const launches = path.join(shared, 'worker-launches/fixture'); fs.mkdirSync(launches, { recursive: true });
  fs.writeFileSync(path.join(launches, 'thread.json'), JSON.stringify(launch));
  fs.writeFileSync(path.join(shared, 'worker-events.jsonl'), JSON.stringify(running) + '\n');
  // The first rollout read holds the single-flight marker, but not the board lock.
  fs.writeFileSync(preload, `import fs from 'node:fs';
const open = fs.openSync, read = fs.readSync, close = fs.closeSync, fds = new Set();
fs.openSync = (file, ...args) => { const fd = open(file, ...args); if (file === ${JSON.stringify(log)}) fds.add(fd); return fd; };
fs.closeSync = fd => { fds.delete(fd); return close(fd); };
fs.readSync = (...args) => {
  if (fds.has(args[0])) {
    if (fs.existsSync(${JSON.stringify(`${boardFile('contention')}.lock`)})) throw Error('rollout read under board lock');
    fs.appendFileSync(${JSON.stringify(signal)}, process.pid + '\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  return read(...args);
};
`);
  const runs = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ['--import', preload, path.join(scripts, 'board.mjs'), 'refresh', '--background', '--project', 'contention'], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let stderr = ''; child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes; });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGTERM'), 12000);
      child.on('error', reject);
      child.on('close', code => { clearTimeout(timer); children.delete(child); code === 0 ? resolve() : reject(Error(stderr || `exit ${code}`)); });
    });
  });
  const completed = Promise.all(runs);
  await waitFor(() => fs.existsSync(signal));
  const started = Date.now();
  for (let i = 0; i < 16; i++) {
    const at = Date.now();
    const result = spawnSync(process.execPath, [path.join(scripts, 'board.mjs'), 'set', `T${i}`, '--project', 'contention', '--next', `step-${i}`], {
      env: process.env, encoding: 'utf8', timeout: 2500 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - at < 2300, 'one set must not wait behind rollout parsing');
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `16 sequential sets took ${elapsed}ms`);
  // A completion written after discovery must be caught by the coalesced follow-up.
  fs.appendFileSync(path.join(shared, 'worker-events.jsonl'), JSON.stringify({ ...running, id: 'finished', event: 'finished', t: now + 1 }) + '\n');
  await completed;
  const board = readBoard('contention');
  for (let i = 0; i < 16; i++) assert.equal(board.tasks.find(task => task.id === `T${i}`).next, `step-${i}`);
  assert.equal(board.tasks.find(task => task.id === 'auto-worker').state, 'review');
  assert.equal(fs.readFileSync(signal, 'utf8').trim().split('\n').length, 2, 'one stale snapshot retry, not eight concurrent parses');
  assert.ok(!fs.existsSync(`${boardFile('contention')}.refresh.lock`));
  console.log(`PASS 16 sequential sets with 8 refresh children: ${elapsed}ms, outside-lock parsing, single flight and late-event follow-up`);

  // Inject mutations during parsing to exercise optimistic retries deterministically.
  facts.events.push({ ...running, id: 'restart', t: now + 2 });
  const originalRead = fs.readSync;
  const dirtyLog = () => fs.appendFileSync(log, '\n');
  const duringRead = async action => {
    dirtyLog(); let injected = false;
    fs.readSync = (...args) => {
      assert.ok(!fs.existsSync(`${boardFile('contention')}.lock`));
      if (!injected) { injected = true; action(); }
      return originalRead(...args);
    };
    try { await refreshBoard('contention', { facts, now: now + 10 }); } finally { fs.readSync = originalRead; }
    assert.ok(injected);
  };
  await duringRead(() => linkTask('contention', 'linked', 'thread'));
  assert.equal(readBoard('contention').tasks.find(task => task.id === 'auto-worker'), undefined);
  assert.equal(readBoard('contention').tasks.find(task => task.id === 'linked').auto.workers.length, 1);
  dirtyLog(); let removal;
  fs.readSync = (...args) => {
    if (!removal) removal = removeTask('contention', 'linked', { force: true, facts, now: now + 20 });
    return originalRead(...args);
  };
  try { await refreshBoard('contention', { facts, now: now + 21 }); await removal; } finally { fs.readSync = originalRead; }
  assert.ok(!readBoard('contention').tasks.some(task => ['linked', 'auto-worker'].includes(task.id)), 'refresh cannot resurrect a concurrent removal');
  console.log('PASS concurrent link/remove edits survive optimistic refresh retries');

  const lock = `${boardFile('contention')}.lock`; fs.mkdirSync(lock);
  const at = Date.now();
  assert.throws(() => setTask('contention', 'busy', {}), /lock busy/);
  assert.ok(Date.now() - at < 2200);
  fs.rmdirSync(lock);
  fs.mkdirSync(lock); fs.utimesSync(lock, new Date(now - 60000), new Date(now - 60000));
  setTask('contention', 'recovered', {}); assert.ok(!fs.existsSync(lock));
  const generic = path.join(tmp, 'generic');
  assert.throws(() => withLock(generic, () => { throw Error('fixture'); }), /fixture/);
  assert.ok(!fs.existsSync(`${generic}.lock`));
  const marker = path.join(tmp, 'single-flight');
  const release = acquireLock(marker, { timeoutMs: 0, ownerPid: true });
  fs.utimesSync(`${marker}.lock`, new Date(now - 60000), new Date(now - 60000));
  assert.equal(acquireLock(marker, { timeoutMs: 0, ownerPid: true }), null, 'a slow live refresh cannot be evicted');
  release();
  fs.mkdirSync(`${marker}.lock`); fs.writeFileSync(path.join(`${marker}.lock`, 'pid'), '0');
  fs.utimesSync(`${marker}.lock`, new Date(now - 60000), new Date(now - 60000));
  const recovered = acquireLock(marker, { timeoutMs: 0, ownerPid: true });
  assert.equal(typeof recovered, 'function'); recovered();
  console.log('PASS bounded mutation lock wait, stale-lock recovery and exception cleanup');
  console.log('Board contention scenarios: all passed');
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map(child => new Promise(resolve => child.on('close', resolve))));
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
