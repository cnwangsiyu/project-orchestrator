#!/usr/bin/env node
// Controlled subprocess contention on synthetic telemetry files only; no hubs, providers or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withLock, writeJson } from '../lib/shared-file.mjs';
import { saveQueue, readQueue } from '../lib/worker-queue.mjs';
import { noteFailure, noteSuccess, readPoolPauses, claimProbes, probeResult, liftAuthPause } from '../lib/trae-health.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-state-'));
const healthURL = new URL('../lib/trae-health.mjs', import.meta.url).href;
const queueURL = new URL('../lib/worker-queue.mjs', import.meta.url).href;
const now = Date.now(), min = 60000;
const children = new Set();
const run = (source) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child);
  let stderr = ''; child.stderr.on('data', (s) => { stderr += s; });
  const done = once(child, 'close').then(([code]) => {
    children.delete(child); assert.equal(code, 0, stderr);
  });
  return { child, done };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = async (promise) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('shared-state fixture timed out')), 5000);
  })]); } finally { clearTimeout(timer); }
};

// Hold one reader after it has read the old file. The competing writer must not read until the lock is released.
const contend = async (file, first, second) => {
  const release = `${file}.release`;
  const holder = run(`
    import fs from 'node:fs';
    const read = fs.readFileSync;
    fs.readFileSync = (...args) => {
      const value = read(...args);
      if (String(args[0]) === ${JSON.stringify(file)}) {
        process.send('read');
        const end = Date.now() + 4000;
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() > end) throw Error('holder timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return value;
    };
    ${first}
    process.disconnect();
  `);
  await timeout(once(holder.child, 'message'));
  const contender = run(`
    import fs from 'node:fs';
    const read = fs.readFileSync;
    fs.readFileSync = (...args) => {
      const value = read(...args);
      if (String(args[0]) === ${JSON.stringify(file)}) process.send('read');
      return value;
    };
    process.send('started');
    ${second}
    process.disconnect();
  `);
  const messages = [];
  contender.child.on('message', (m) => messages.push(m));
  await timeout(once(contender.child, 'message'));
  try {
    await delay(150);
    assert.deepEqual(messages, ['started'], 'competing read must wait for the shared lock');
  } finally { fs.writeFileSync(release, 'release'); }
  await timeout(Promise.all([holder.done, contender.done]));
  assert.deepEqual(messages, ['started', 'read']);
};

try {
  const health = path.join(tmp, 'worker-health.json');
  noteFailure(tmp, 'request queue size is exceed', now - min, 'gemini-3.1-pro-preview');
  await contend(health,
    `const {noteSuccess} = await import(${JSON.stringify(healthURL)}); noteSuccess(${JSON.stringify(tmp)}, 'gpt-6.1-sol');`,
    `const {noteFailure} = await import(${JSON.stringify(healthURL)}); noteFailure(${JSON.stringify(tmp)}, 'request queue size is exceed', ${now}, 'gemini-3.1-pro-preview');`);
  assert.ok(readPoolPauses(tmp, now).gemini, 'GPT success must preserve the concurrent Gemini overflow pause');
  const writers = Array.from({ length: 8 }, () => run(`
    const {noteSuccess} = await import(${JSON.stringify(healthURL)});
    noteSuccess(${JSON.stringify(tmp)}, 'gpt-6.1-sol'); process.disconnect();
  `));
  writers.push(run(`
    const {noteFailure} = await import(${JSON.stringify(healthURL)});
    noteFailure(${JSON.stringify(tmp)}, 'request queue size is exceed', ${now + 1}, 'gemini-3.1-pro-preview'); process.disconnect();
  `));
  await timeout(Promise.all(writers.map((w) => w.done)));
  assert.ok(readPoolPauses(tmp, now).gemini);
  console.log('ok   controlled and 8-success/1-failure contention preserves the other family pause');

  const queue = path.join(tmp, 'queue-status.json');
  saveQueue(tmp, 'existing', { state: 'waiting', position: 30 });
  await contend(queue,
    `const {saveQueue} = await import(${JSON.stringify(queueURL)}); saveQueue(${JSON.stringify(tmp)}, 'first', {state:'queued',position:1000});`,
    `const {saveQueue} = await import(${JSON.stringify(queueURL)}); saveQueue(${JSON.stringify(tmp)}, 'second', {state:'waiting',position:42});`);
  assert.equal(readQueue(tmp, 'existing').position, 30);
  assert.equal(readQueue(tmp, 'first').position, 1000); assert.equal(readQueue(tmp, 'second').position, 42);
  const queueWriters = Array.from({ length: 16 }, (_, i) => run(`
    const {saveQueue} = await import(${JSON.stringify(queueURL)});
    saveQueue(${JSON.stringify(tmp)}, 'thread-${i}', {state:'queued',position:${i}}); process.disconnect();
  `));
  await timeout(Promise.all(queueWriters.map((w) => w.done)));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(queue, 'utf8'))).length, 19);
  console.log('ok   per-thread queue updates retain every entry during concurrent writes');

  const stale = (file) => {
    const lock = `${file}.lock`; fs.mkdirSync(lock);
    fs.utimesSync(lock, new Date(now - min), new Date(now - min));
  };
  for (const mutate of [() => noteSuccess(tmp, 'gpt-6.1-sol'),
    () => noteFailure(tmp, 'quota exhausted', now - 31 * min, 'deepseek-v4.1-flash'),
    () => claimProbes(tmp, now), () => probeResult(tmp, 'deepseek-v4.1-flash', false, 'quota exhausted', now),
    () => liftAuthPause(tmp)]) {
    stale(health); mutate(); assert.ok(!fs.existsSync(`${health}.lock`));
  }
  assert.ok(readPoolPauses(tmp, now).gemini);
  assert.ok(readPoolPauses(tmp, now).deepseek);
  stale(queue); saveQueue(tmp, 'stale-recovered', { state: 'ready', position: null });
  assert.equal(readQueue(tmp, 'stale-recovered').state, 'ready');
  const bounded = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`old-${i}`, { position: i }]));
  writeJson(queue, bounded); saveQueue(tmp, 'new', { position: 201 });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(queue, 'utf8'))).length, 200);
  assert.equal(readQueue(tmp, 'old-0'), null); assert.equal(readQueue(tmp, 'new').position, 201);
  const cleanup = path.join(tmp, 'cleanup.json');
  assert.throws(() => withLock(cleanup, () => { throw Error('fixture'); }), /fixture/);
  fs.mkdirSync(cleanup);
  assert.throws(() => writeJson(cleanup, {}));
  assert.ok(!fs.existsSync(`${cleanup}.${process.pid}`));
  assert.ok(!fs.readdirSync(tmp).some((s) => s.endsWith('.lock') || /\.\d+$/.test(s)));
  console.log('ok   stale-lock recovery for every health writer, queue retention and failure cleanup');
  console.log('\nall pass');
} finally {
  for (const child of children) child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
