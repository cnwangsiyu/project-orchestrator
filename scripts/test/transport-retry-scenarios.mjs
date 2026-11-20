#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completionKind, transportLaneFailures } from '../lib/worker-completion.mjs';
import { recordWorkerOutcome } from '../lib/worker-outcome.mjs';

const errors = [
  'stream disconnected before completion: Transport error: network error: error decoding response body',
  'stream disconnected before completion: Transport error: network error: connection reset by peer',
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-retry-'));
let count = 0;
const check = (label, run) => { run(); count++; console.log(`PASS ${label}`); };
try {
  check('real stream errors and exhausted provider errors are transport failures', () => {
    for (const error of [...errors, 'ECONNRESET', 'HTTP 500 after retries', 'provider 503', 'provider overloaded after retries'])
      assert.equal(completionKind({ status: 'failed', error: { message: error } }), 'transport-failed');
    for (const status of ['completed', 'interrupted', 'BLOCKED', 'TRUNCATED'])
      assert.equal(completionKind({ status, error: errors[0] }), status);
    assert.equal(completionKind({ status: 'failed', error: 'test assertions failed' }), 'failed');
  });
  check('transport outcome is durable, idempotent, and distinct from quality or partial final prose', () => {
    const log = path.join(tmp, 'outcomes.jsonl');
    const base = { project: 'p', name: 'task', category: 'implement', thread: 'thread', turn: 'turn',
      account: 'a', actualModel: 'gpt-6.1-sol', effort: 'high', command: 'start', terminal: true,
      status: 'failed', error: errors[0], exit: 1, final: 'BLOCKED: partial task report', log };
    const row = recordWorkerOutcome(base);
    assert.equal(row.result, 'transport-failed'); assert.equal(row.failureKind, 'transport-failed');
    assert.equal(row.cause, 'transport'); assert.equal(row.rounds, 0);
    assert.equal(recordWorkerOutcome(base), null);
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).result, 'transport-failed');
    const success = recordWorkerOutcome({ ...base, turn: 'continued', command: 'turn', status: 'completed', exit: 0, final: 'DONE' });
    assert.equal(success.result, 'pass'); assert.equal(success.rounds, 0);
  });
  console.log(`${count} scenarios passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
