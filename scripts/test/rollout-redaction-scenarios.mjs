// Synthetic durable histories only; never inspect or launch a real worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactRolloutFile, maskedRolloutFile, rolloutReadPath } from '../lib/rollout-redaction.mjs';
import { rolloutTurnModel } from '../lib/worker-model.mjs';
import { threadRollouts, threadSize } from '../lib/worker-thread-size.mjs';
import { redactLogFile } from '../lib/log-redaction.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-redaction-'));
const sharedBefore = process.env.RULES_SHARED;
process.env.RULES_SHARED = path.join(root, 'shared');
const { redactWorkerTurn } = await import('../lib/worker-redaction.mjs');
const { lifecycle, retireWorker, readEvents } = await import('../lib/worker-events.mjs');
const fake = 'synthetic-fixture-' + 'x'.repeat(100);
const owner = '47ba610f-34a8-5362-a84d-d009bffc3f5f';
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const unchanged = (file, text, stat) => {
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'durable history changed');
  const current = fs.statSync(file);
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(current[field], stat[field]);
};

try {
  for (const [account, layout] of [['trae', 'cli/sessions'], ['codex', 'sessions']]) {
    const home = path.join(root, account), dir = path.join(home, layout, '2026/11/21'), thread = `${account}-fake`;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-fixture-${thread}.jsonl`), copy = maskedRolloutFile(file);
    const initial = jsonl([{ output: `password=${fake}` },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1234 } } } },
      { type: 'turn_context', payload: { turn_id: 'one', model: 'gpt-fixture', effort: 'high' } }]);
    fs.writeFileSync(file, initial, { mode: 0o644 });
    let stat = fs.statSync(file);
    const tracker = lifecycle({ owner, account, name: thread, thread, followerCommand: 'turn', mayRun: false });
    const log = path.join(home, 'turn.out'), out = path.join(home, 'final.md'), output = [];
    fs.writeFileSync(log, `password=${fake}\n`); fs.writeFileSync(out, `password=${fake}\n`);
    const counts = await redactWorkerTurn({ home, thread, log, out, tracker, checkIdle: () => true, print: line => output.push(line) });
    assert.deepEqual(counts, { log: 1, rollout: 1, out: 1 });
    unchanged(file, initial, stat);
    for (const target of [log, out, copy]) assert.ok(!fs.readFileSync(target, 'utf8').includes(fake));
    assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
    assert.ok(!path.basename(copy).startsWith('rollout-') && !copy.endsWith('.jsonl'));
    assert.equal(rolloutReadPath(file), copy);
    assert.equal(redactLogFile(copy, { force: true }).masked, 0);
    assert.deepEqual(await threadRollouts(home, thread), [file]);
    assert.equal((await threadSize(home, thread)).bytes, stat.size, 'size guard measured the masked copy');
    assert.equal((await threadSize(home, thread)).inputTokens, 1234);
    assert.equal(rolloutTurnModel(home, file, thread, 'one').model, 'gpt-fixture');
    assert.deepEqual(output, ['redacted: log=1 rollout=1 out=1']);

    const copyStat = fs.statSync(copy);
    assert.equal(redactRolloutFile(file).masked, 0);
    assert.equal(fs.statSync(copy).ino, copyStat.ino);
    tracker.result('finished', { mayRun: false, settled: true });
    tracker.end(0);
    const ended = readEvents().filter(row => row.thread === thread && row.event === 'finished').at(-1);
    retireWorker(ended, 'fixture retired');
    assert.ok(!fs.readFileSync(copy, 'utf8').includes(fake), 'retirement lost masked reporting');
    unchanged(file, initial, stat);

    // The fake provider appends another turn, including after retirement.
    const addition = jsonl([{ output: `password=${fake}` },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2345 } } } },
      { type: 'turn_context', payload: { turn_id: 'two', model: 'gpt-second', effort: 'high' } }]);
    fs.appendFileSync(file, addition);
    const continued = initial + addition;
    stat = fs.statSync(file);
    assert.equal(rolloutReadPath(file), file, 'stale snapshot hid the second turn');
    assert.equal(rolloutTurnModel(home, file, thread, 'two').model, 'gpt-second');
    assert.equal((await threadSize(home, thread)).inputTokens, 2345);
    assert.equal(redactRolloutFile(file).masked, 2);
    unchanged(file, continued, stat);
    assert.equal(rolloutReadPath(file), copy);
    assert.ok(!fs.readFileSync(copy, 'utf8').includes(fake));
    assert.equal(rolloutTurnModel(home, file, thread, 'two').model, 'gpt-second');

    // Both exact paths and hard links can alias a --log/--out argument.
    const alias = path.join(home, 'alias.out'); fs.linkSync(file, alias);
    stat = fs.statSync(file);
    const aliases = await redactWorkerTurn({ home, thread, log: file, out: alias, checkIdle: () => true, print: () => {} });
    assert.deepEqual(aliases, { log: 0, rollout: 2, out: 0 });
    unchanged(file, continued, stat);
    console.log(`PASS ${account}: live bytes/inode, two turns, retirement, masked outputs/copy, readers, source size and aliases`);
  }

  const dir = path.join(root, 'unsafe'); fs.mkdirSync(dir);
  const file = path.join(dir, 'rollout-fixture-thread.jsonl'), copy = maskedRolloutFile(file), outside = path.join(dir, 'unowned.out');
  fs.writeFileSync(file, jsonl([{ output: `password=${fake}` }]));
  const original = fs.readFileSync(file, 'utf8'), stat = fs.statSync(file);
  fs.writeFileSync(outside, 'unowned fixture data\n'); fs.symlinkSync(outside, copy);
  assert.throws(() => redactRolloutFile(file));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unowned fixture data\n');
  assert.equal(rolloutReadPath(file), file);
  fs.unlinkSync(copy); fs.writeFileSync(copy, 'unowned fixture sidecar\n');
  assert.throws(() => redactRolloutFile(file));
  assert.equal(fs.readFileSync(copy, 'utf8'), 'unowned fixture sidecar\n');
  unchanged(file, original, stat);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  console.log('PASS unsafe/unowned sidecars refused without modifying source or unrelated files');

  fs.unlinkSync(copy);
  redactRolloutFile(file);
  const beforeCopy = fs.readFileSync(copy, 'utf8'), beforeCopyStat = fs.statSync(copy), write = fs.writeFileSync;
  fs.appendFileSync(file, jsonl([{ output: `password=${fake}` }]));
  try {
    fs.writeFileSync = function(target, ...args) {
      const result = write.call(this, target, ...args);
      if (typeof target === 'number') fs.appendFileSync(file, '\nfixture concurrent writer\n');
      return result;
    };
    assert.throws(() => redactRolloutFile(file), /changed before snapshot publication/);
  } finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(copy, 'utf8'), beforeCopy);
  assert.equal(fs.statSync(copy).ino, beforeCopyStat.ino);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  console.log('PASS concurrent source writer leaves the prior snapshot intact and removes temporary output');
} finally {
  if (sharedBefore === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = sharedBefore;
  fs.rmSync(root, { recursive: true, force: true });
}
