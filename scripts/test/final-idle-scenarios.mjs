import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'final-idle-'));
const shared = path.join(root, 'shared');
const task = path.join(root, 'task');
const owner = '1c4bda11-327e-4d6e-93a7-7d46e99b4279';
const previous = { ...process.env };
try {
  fs.mkdirSync(task, { recursive: true });
  Object.assign(process.env, { HOME: root, RULES_SHARED: shared, ORCHESTRATOR_OWNER: '', CODEX_WORKER_FINAL_IDLE_MIN: '0.001' });
  const child = spawn(process.execPath, [path.join(scripts, 'run-tracked.mjs'), '--account', 'main', '--owner', owner,
    '--project', 'fixture', '--task', 'R-idle', '--name', 'R-idle', '--task-dir', task, '--out', path.join(task, 'codex-last.md'),
    '--', process.execPath, path.join(scripts, 'test/fixtures/final-idle-child.mjs'), task], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.match(stderr, /final message idle/);
  const { readEvents } = await import('../lib/worker-events.mjs');
  const terminal = readEvents().findLast(row => row.name === 'R-idle');
  assert.equal(terminal.event, 'finished'); assert.equal(terminal.exit, 0);
  console.log('PASS a final exec message ends its idle follower and reports finished');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
