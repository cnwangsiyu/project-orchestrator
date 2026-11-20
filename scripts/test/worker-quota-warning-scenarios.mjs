#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkQuotaWarnings, quotaBurn, readQuotaWarnings, dailyWarningBuckets } from '../lib/worker-quota-warnings.mjs';
import { appendEvent, appendWorkerQuotaAlert, workerRunStates, readEvents, eventLine, hookEventLine } from '../lib/worker-events.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-quota-warning-'));
const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const savedShared = process.env.RULES_SHARED;
process.env.RULES_SHARED = tmp;
const minute = 60000, now = Date.now(), reset = now + 86400000;
const owner = '053283ad-1bc8-5a31-ad44-d68e6b199eb6';
const row = { runId: 'running-one', event: 'running', account: 'company', thread: 'thread-one', turn: 'turn-one',
  pid: process.pid, owner, name: 'worker-one', model: 'GPT-6.1-Sol' };
const data = (used, t = now, resetsAt = reset, kind = 'ttadk') => ({ checkedAt: t, codexAccounts: [{
  name: 'company', kind, ...(kind === 'ttadk' ? { usage: { used, limit: 1000, resetsAt } }
    : { quota: { sampledAt: t, daily: { 'gpt-6.1-sol': { used, limit: 1000, resetsAt } } } }) }] });
const publish = rows => {
  for (const { row } of workerRunStates(readEvents()).values()) {
    if (row.event === 'running' && !rows.some(next => next.runId === row.runId))
      appendEvent({ ...row, event: 'finished', settled: true });
  }
  for (const row of rows) {
    const current = [...workerRunStates(readEvents()).values()].find(state => state.row.runId === row.runId)?.row;
    if (!current || [...Object.keys(row), 'reporting', 'settled', 'status'].some(field => current[field] !== row[field])) appendEvent(row);
  }
};
const check = (snapshot, rows = [row], options = {}) => {
  publish(rows);
  return checkQuotaWarnings({ data: snapshot, rows, now: snapshot.checkedAt, ...options });
};
try {
  assert.equal(check(data(790)).length, 0);
  assert.equal(check(data(800, now + minute)).length, 1);
  assert.equal(check(data(850, now + 2 * minute)).length, 0);
  assert.equal(check(data(900, now + 3 * minute)).length, 1);
  assert.equal(check(data(1000, now + 4 * minute)).length, 0);
  let warnings = readEvents().filter(event => event.kind === 'quota-warning');
  assert.deepEqual(warnings.map(event => [event.threshold, event.wake, event.severity]), [[80, false, 'info'], [90, true, 'risk']]);
  assert.match(warnings[0].text, /800\/1000.*burn=.*exhaustion=.*reset=.*worker-one thread-one\/turn-one/);
  assert.equal(Object.values(readQuotaWarnings().buckets)[0].notices[owner][90].warningId, warnings[1].warningId);
  console.log('PASS thresholds once per owner and reset period, with durable warning details');

  const second = { ...row, runId: 'two', thread: 'thread-two', name: 'worker-two' };
  const other = { ...row, runId: 'other', thread: 'other-thread', owner: 'another-owner' };
  const reopened = now + 86400000;
  assert.equal(check(data(950, reopened, reset + 86400000), [row, second, other]).length, 4);
  warnings = readEvents().filter(event => event.kind === 'quota-warning');
  assert.deepEqual(warnings.at(-4).turns.map(turn => turn.thread), ['thread-one', 'thread-two']);
  assert.equal(check(data(960, reopened + minute, reset + 86400000), [row, second, other]).length, 0);
  console.log('PASS reset reopens thresholds, each owner gets one warning listing both running turns');

  const noWorkers = path.join(tmp, 'no-workers.json');
  assert.equal(check(data(990), [], { file: noWorkers }).length, 0);
  assert.equal(check(data(990), [{ ...row, event: 'finished', settled: true }], { file: noWorkers }).length, 0);
  assert.equal(check(data(990), [row], { file: noWorkers, alive: () => false }).length, 0);
  assert.equal(Object.keys(readQuotaWarnings(noWorkers).buckets).length, 1);
  console.log('PASS no note for finished turns, dead followers, or owners with no running turn');

  for (const extra of [{ reporting: true }, { status: 'completed' }]) {
    assert.equal(check(data(950), [{ ...row, ...extra }], { file: path.join(tmp, `reporting-${Object.keys(extra)[0]}.json`) }).length, 0);
  }
  const raceFile = path.join(tmp, 'finish-before-append.json');
  let raced = false;
  assert.equal(check(data(950, now, reset + 2 * 86400000), [row], { file: raceFile, emit: (alert, id, options) => {
    if (!raced) { raced = true; appendEvent({ ...row, event: 'finished', settled: true }); }
    return appendWorkerQuotaAlert(alert, id, options);
  } }).length, 0);
  assert.deepEqual(Object.values(readQuotaWarnings(raceFile).buckets)[0].notices, {});
  assert.equal(check(data(950, now, reset + 2 * 86400000), [row], { file: raceFile }).length, 2,
    'a suppressed warning must not consume either threshold notice');
  const pair = { ...row, runId: 'race-pair', thread: 'race-pair-thread', name: 'remaining-worker' };
  const pairWarnings = check(data(950, now, reset + 3 * 86400000), [row, pair], { file: path.join(tmp, 'remaining-turn.json'), emit: (alert, id, options) => {
    appendEvent({ ...row, reporting: true });
    return appendWorkerQuotaAlert(alert, id, options);
  } });
  assert.equal(pairWarnings.length, 2);
  assert.deepEqual(pairWarnings[0].turns.map(turn => turn.thread), [pair.thread]);
  assert.ok(!pairWarnings[0].text.includes('worker-one thread-one'));
  appendEvent({ ...pair, event: 'finished', settled: true });
  console.log('PASS reporting rows and finish-before-append suppress warnings without consuming notices; remaining turn details are current');

  const modelFile = path.join(tmp, 'models.json');
  assert.equal(check(data(810, now, reset, 'trae'), [row, { ...second, model: 'DeepSeek-V4.1-Flash' }], { file: modelFile }).length, 1);
  assert.equal(check(data(810, now, reset, 'trae'), [{ ...row, model: 'DeepSeek-V4.1-Flash' }], { file: path.join(tmp, 'wrong-model.json') }).length, 0);
  assert.equal(dailyWarningBuckets(data(900, now - 16 * minute), now).length, 0);
  assert.equal(dailyWarningBuckets(data(900, now, now - 1), now).length, 0);
  console.log('PASS TRAE warnings match the model bucket; stale or expired numeric snapshots are excluded');

  const burn = quotaBurn([{ t: now - 45 * minute, used: 500 }, { t: now - 10 * minute, used: 800 }],
    { t: now, used: 950, limit: 1000 });
  assert.equal(burn.perMinute, 10); assert.equal(burn.windowMinutes, 45); assert.equal(burn.exhaustionMinutes, 5);
  assert.equal(quotaBurn([{ t: now - 20 * minute, used: 750 }], { t: now, used: 900, limit: 1000 }).perMinute, null);
  assert.equal(quotaBurn([], { t: now, used: 1000, limit: 1000 }).exhaustionMinutes, 0);
  assert.equal(quotaBurn([{ t: now - 61 * minute, used: 500 }], { t: now, used: 900, limit: 1000 }).perMinute, null);
  assert.equal(quotaBurn([{ t: now - 40 * minute, used: 900 }], { t: now, used: 900, limit: 1000 }).exhaustionMinutes, null);
  assert.equal(quotaBurn([{ t: now - 40 * minute, used: 900 }], { t: now, used: 800, limit: 1000 }).perMinute, null);
  console.log('PASS burn rate and exhaustion maths use a sparse 30–60 minute span, excluding insufficient or decreasing samples');

  const driver = path.join(tmp, 'follower.mjs'), concurrentState = path.join(tmp, 'concurrent.json');
  const concurrentRows = [row, second].map(row => ({ ...row, owner: 'concurrent-owner' }));
  fs.writeFileSync(driver, `import {checkQuotaWarnings} from ${JSON.stringify(path.join(scripts, 'lib/worker-quota-warnings.mjs'))};
    checkQuotaWarnings(${JSON.stringify({ data: data(910), rows: concurrentRows, now, file: concurrentState })});`);
  const follow = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => errors += chunk);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(errors)));
  });
  publish(concurrentRows);
  const before = readEvents().length;
  await Promise.all([follow(), follow()]);
  assert.equal(readEvents().length - before, 2);
  assert.equal(check(data(910), concurrentRows, { file: concurrentState }).length, 0);
  // Emulate a crash after alert delivery but before the warning state rename.
  fs.unlinkSync(concurrentState);
  check(data(910), concurrentRows, { file: concurrentState });
  assert.equal(readEvents().length - before, 2);
  console.log('PASS two followers and a restarted follower deduplicate, including crash recovery after alert append');

  appendEvent(row);
  const profiles = path.join(tmp, 'accounts.json'); fs.writeFileSync(profiles, '{}');
  const result = spawnSync(process.execPath, [path.join(scripts, 'quota.mjs'), '--running', '--json'], {
    env: { ...process.env, CODEX_ACCOUNTS: profiles, QUOTA_CACHE: path.join(tmp, 'absent-cache.json') }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Object.values(JSON.parse(result.stdout).quotaWarnings.buckets).some(bucket => bucket.notices[owner]?.[90]));
  const longText = 'x'.repeat(2500);
  assert.ok(eventLine({ event: 'message', kind: 'quota-warning', text: longText }).includes(longText));
  const printed = eventLine({ event: 'message', kind: 'quota-warning', text: 'delivery skipped finished' });
  assert.match(printed, /^\[quota-warning\]/); assert.ok(printed.includes('delivery skipped finished'));
  assert.match(hookEventLine({ event: 'message', kind: 'quota-warning', text: 'delivered skipped finished' }), /^\[quota-warning\]/);
  console.log('PASS quota --running displays durable per-account warning state without a credential query; owner note preserves long turn lists');
  console.log('all pass');
} finally {
  if (savedShared === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = savedShared;
  fs.rmSync(tmp, { recursive: true, force: true });
}
