#!/usr/bin/env node
// Review reproductions: fixtures only, no real hubs/accounts/credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEvent, compactWorkerEvents, createEventTail, readEvents, readAck, eventFile, ackFile, inbox,
  hasWatcher, watch, deliverAsync, auditWorkerEvents, ACK_RECEIPTS, RETENTION_MS, ROTATE_BYTES, TRANSACTION_RETRY_MS } from '../lib/worker-events.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-inbox-fixes-'));
const previous = process.env.RULES_SHARED;
process.env.RULES_SHARED = tmp;
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: path.join(tmp, 'accounts.json'),
  ORCHESTRATOR_OWNER: '', CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '' };
fs.writeFileSync(env.CODEX_ACCOUNTS, '{}');
const hook = path.join(scripts, 'worker-inbox-hook.mjs'), worker = path.join(scripts, 'codex-worker.mjs');
const transport = path.join(scripts, 'test/fixtures/worker-events-transport.mjs');
const children = new Set();
// Functional assertions must not race the production fail-open deadline under filesystem/CPU load.
// Dedicated deadline probes below retain the real 220 ms budget.
const functionalClock = path.join(tmp, 'functional-clock.mjs');
fs.writeFileSync(functionalClock, `const timeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 220 ? 10000 : ms, ...args);
`);
const input = (owner, extra = {}) => ({ session_id: owner, hook_event_name: 'Stop', session_title: 'Fix fixture 主对话', cwd: tmp,
  stop_hook_active: false, ...extra });
const hookRun = (owner, extra = {}, nodeOptions = {}) => {
  const imports = [...(nodeOptions.realDeadline ? [] : [functionalClock]), ...(nodeOptions.import ? [nodeOptions.import] : [])];
  const r = spawnSync(process.execPath, [...imports.flatMap((file) => ['--import', file]), hook], {
    env: { ...env, ...nodeOptions.env }, input: JSON.stringify(input(owner, extra)), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr + r.error?.message); assert.equal(r.stderr, '');
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const assertBlock = (result, label) => {
  assert.ok(result, `${label}: expected output, not a deadline-dependent silent exit`);
  assert.equal(result.decision, 'block', label); return result;
};
const record = (owner, event = 'finished', extra = {}) => appendEvent({ owner, event, runId: `${owner}-${event}`, name: `${owner}-worker`,
  thread: null, account: 'fixture', model: 'fixture', outFile: path.join(tmp, `${owner}.md`), finalLine: 'DONE review fixture',
  launcher: { sessionId: owner }, ...extra });
const until = async (test, label) => {
  const end = Date.now() + 10000;
  while (!test()) { if (Date.now() >= end) throw Error(`timeout: ${label}`); await new Promise((r) => setTimeout(r, 20)); }
};
const startWatch = (owner, extra = {}) => {
  const child = spawn(process.execPath, [worker, 'watch', '--debounce-sec', '0', '--owner', owner], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code) => { clearTimeout(timer); children.delete(child); resolve({ code, stdout, stderr }); });
  });
  return { child, done, output: () => stdout };
};
try {
  const fault = path.join(tmp, 'ack-fault.mjs');
  fs.writeFileSync(fault, `import fs from 'node:fs/promises';
const open = fs.open, rename = fs.rename;
fs.open = async (file, ...args) => {
  if (String(file).includes('/worker-acks/') && args[0] === 'w' && process.env.ACK_FAULT === 'ENOSPC')
    throw Object.assign(new Error('fixture ENOSPC'), {code:'ENOSPC'});
  return open(file, ...args);
};
fs.rename = async (...args) => {
  if (String(args[1]).includes('/worker-acks/') && process.env.ACK_FAULT === 'EIO')
    throw Object.assign(new Error('fixture EIO'), {code:'EIO'});
  return rename(...args);
};
`);
  for (const code of ['ENOSPC', 'EIO']) {
    const owner = `ack-failure-${code}`, row = record(owner);
    for (const active of [false, true, true]) assert.equal(hookRun(owner, { stop_hook_active: active }, { import: fault, env: { ACK_FAULT: code } }), null);
    assert.equal(inbox(readEvents(), owner, readAck(owner)).pending.length, 1);
    assert.equal(readAck(owner).delivered[row.id], undefined);
    assertBlock(hookRun(owner), 'delivery recovers without a lost event');
    assert.equal(inbox(readEvents(), owner, readAck(owner)).pending.length, 0, 'recovery commits after output');
    record(owner, 'finished', { runId: 'new-after-block' });
    assert.equal(hookRun(owner, { stop_hook_active: true }), null);
    assert.equal(inbox(readEvents(), owner, readAck(owner)).pending.length, 1);
  }
  const lockedOwner = 'ack-lock'; record(lockedOwner); record(lockedOwner, 'running');
  fs.mkdirSync(`${ackFile(lockedOwner)}.lock`);
  assert.equal(hookRun(lockedOwner), null, 'ack contention must not fall through to a watcher block');
  fs.rmdirSync(`${ackFile(lockedOwner)}.lock`);
  const printFailure = 'async-print-failure'; record(printFailure);
  await assert.rejects(deliverAsync(printFailure, async () => { throw Error('closed output'); }), /closed output/);
  assert.equal(inbox(readEvents(), printFailure, readAck(printFailure)).pending.length, 1, 'a failed print rolls back its acknowledgement');
  const rollbackOwner = 'compaction-rollback', rollbackEvent = record(rollbackOwner);
  for (let i = 0; i < 70; i++) record('rollback-padding', 'finished', { runId: `padding-${i}` });
  await assert.rejects(deliverAsync(rollbackOwner, async () => {
    compactWorkerEvents();
    assert.ok(readEvents().some((row) => row.id === rollbackEvent.id), 'compaction cannot prune an in-flight acknowledgement');
    throw Error('print failed after compaction');
  }), /print failed after compaction/);
  assert.equal(inbox(readEvents(), rollbackOwner, readAck(rollbackOwner)).pending.length, 1);
  let prints = 0;
  await deliverAsync(rollbackOwner, () => { prints++; });
  await deliverAsync(rollbackOwner, () => { prints++; });
  assert.equal(prints, 1, 'repeated delivery is idempotent');
  console.log('PASS Stop guard before all blocks, ENOSPC/EIO/lock fail-open, recovery and print rollback');

  const expireTransaction = (owner) => {
    const ack = readAck(owner); assert.ok(ack.transaction, `${owner}: pending intent exists`);
    fs.writeFileSync(ackFile(owner), JSON.stringify({ ...ack, transaction: { ...ack.transaction, t: Date.now() - TRANSACTION_RETRY_MS - 1 } }));
  };
  const leaseOwner = 'transaction-lease', leaseRow = record(leaseOwner);
  let resumeOutput;
  const lateDelivery = deliverAsync(leaseOwner, () => new Promise((resolve) => { resumeOutput = resolve; }));
  await until(() => !!resumeOutput, 'first delivery persisted intent and entered output');
  assert.equal(readAck(leaseOwner).highWater, 0, 'intent does not acknowledge output that has not completed');
  assert.equal(readAck(leaseOwner).delivered[leaseRow.id], undefined);
  assert.deepEqual(readAck(leaseOwner).transaction.events, [{ id: leaseRow.id, seq: leaseRow.seq }]);
  assert.equal(fs.existsSync(`${ackFile(leaseOwner)}.lock`), false, 'output does not hold the acknowledgement lock');
  const realNow = Date.now, preparedAt = readAck(leaseOwner).transaction.t;
  Date.now = () => preparedAt;
  try {
    const deferred = await deliverAsync(leaseOwner, () => assert.fail('a fresh live intent is not stolen'));
    assert.equal(deferred.failed, true);
  } finally { Date.now = realNow; }
  expireTransaction(leaseOwner); compactWorkerEvents();
  assert.ok(readAck(leaseOwner).transaction, 'compaction preserves a recoverable intent');
  let retried = 0; await deliverAsync(leaseOwner, () => { retried++; });
  const committed = readAck(leaseOwner);
  resumeOutput(); await lateDelivery;
  assert.equal(retried, 1); assert.deepEqual(readAck(leaseOwner), committed, 'a late writer cannot overwrite the newer commit');
  assert.equal(committed.transaction, null); assert.equal(committed.highWater, leaseRow.seq);

  const commitOwner = 'commit-failure', commitRow = record(commitOwner), originalRename = fsp.rename;
  let renames = 0, commitPrints = 0;
  fsp.rename = async (from, to) => {
    if (to === ackFile(commitOwner) && ++renames === 2) throw Object.assign(Error('commit EIO'), { code: 'EIO' });
    return originalRename(from, to);
  };
  try { await assert.rejects(deliverAsync(commitOwner, () => { commitPrints++; }), /commit EIO/); }
  finally { fsp.rename = originalRename; }
  assert.equal(commitPrints, 1); assert.equal(readAck(commitOwner).highWater, 0);
  assert.equal(inbox(readEvents(), commitOwner, readAck(commitOwner)).pending.length, 1, 'failed final commit leaves output retryable');
  expireTransaction(commitOwner); await deliverAsync(commitOwner, () => { commitPrints++; });
  assert.equal(commitPrints, 2); assert.equal(readAck(commitOwner).highWater, commitRow.seq);

  const batchOwner = 'bounded-transaction';
  const batchIds = Array.from({ length: 130 }, (_, i) => record(batchOwner, 'finished', { runId: `tx-batch-${i}` }).id);
  const printedIds = [];
  await deliverAsync(batchOwner, (rows) => {
    const ack = readAck(batchOwner);
    assert.ok(ack.transaction.events.length <= ACK_RECEIPTS, 'intent is bounded even for a large watcher batch');
    assert.ok(Object.keys(ack.delivered).length <= ACK_RECEIPTS);
    printedIds.push(...rows.map((row) => row.id));
  }, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(printedIds, batchIds); assert.equal(readAck(batchOwner).transaction, null);
  assert.equal(inbox(readEvents(), batchOwner, readAck(batchOwner)).pending.length, 0);
  const deadLockOwner = 'dead-intent-lock', deadLockRow = record(deadLockOwner);
  fs.writeFileSync(ackFile(deadLockOwner), JSON.stringify({ owner: deadLockOwner, highWater: 0, delivered: {}, transaction: {
    token: 'dead-fixture', pid: 2147483647, t: Date.now(), events: [{ id: deadLockRow.id, seq: deadLockRow.seq }] } }));
  fs.mkdirSync(`${ackFile(deadLockOwner)}.lock`);
  fs.writeFileSync(path.join(`${ackFile(deadLockOwner)}.lock`, 'writer.json'), JSON.stringify({ pid: 2147483647 }));
  const recoveredLock = await deliverAsync(deadLockOwner, () => {});
  assert.equal(recoveredLock.delivered.length, 1, 'a dead writer lock does not delay transaction recovery');
  assert.equal(readAck(deadLockOwner).transaction, null); assert.equal(fs.existsSync(`${ackFile(deadLockOwner)}.lock`), false);
  console.log('PASS two-phase intent/output/commit, lease expiry, late-writer fencing, commit failure recovery and bounded transaction batches');

  const hugeOwner = 'large-ack', now = Date.now();
  const legacy = Object.fromEntries(Array.from({ length: 55000 }, (_, i) => [`old-${String(i).padStart(36, '0')}`, { t: now, event: 'finished' }]));
  fs.writeFileSync(ackFile(hugeOwner), JSON.stringify({ owner: hugeOwner, delivered: legacy }));
  assert.ok(fs.statSync(ackFile(hugeOwner)).size > 4 * 1024 * 1024);
  record(hugeOwner);
  assertBlock(hookRun(hugeOwner), 'a valid oversized legacy ack does not disable delivery');
  assert.ok(fs.statSync(ackFile(hugeOwner)).size < 64 * 1024);
  assert.ok(Object.keys(readAck(hugeOwner).delivered).length <= ACK_RECEIPTS);
  record(hugeOwner, 'finished', { runId: 'second' }); assertBlock(hookRun(hugeOwner), 'second oversized-ack delivery');

  const legacyOwner = 'legacy-inbox';
  const legacyRows = Array.from({ length: 100 }, (_, i) => ({ id: `legacy-${i}`, runId: `legacy-${i}`, owner: legacyOwner,
    t: Date.now(), event: 'finished', name: i < 80 ? `already-delivered-${i}` : `new-legacy-${i}`, launcher: { sessionId: legacyOwner } }));
  fs.appendFileSync(eventFile(), legacyRows.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(ackFile(legacyOwner), JSON.stringify({ owner: legacyOwner,
    delivered: Object.fromEntries(legacyRows.slice(0, 80).map((row) => [row.id, { t: Date.now() }])) }));
  for (let i = 0; i < 2; i++) {
    const result = assertBlock(hookRun(legacyOwner), `legacy migration batch ${i + 1}`);
    assert.doesNotMatch(result.reason, /already-delivered/, 'migration never forgets older legacy receipts');
    assert.ok(Object.keys(readAck(legacyOwner).delivered).length <= ACK_RECEIPTS);
  }
  assert.equal(hookRun(legacyOwner), null, 'legacy deliveries do not cycle after receipt pruning');
  assert.equal(inbox(readEvents(), legacyOwner, readAck(legacyOwner)).pending.length, 0);

  const historyOwner = 'history-owner', historyNow = Date.now();
  const historyRows = Array.from({ length: 50000 }, (_, i) => ({ id: `history-${i}`, runId: `history-${i}`, owner: historyOwner,
    t: historyNow - 1000, event: 'finished', name: 'old-history', account: 'fixture', seq: i + 100000,
    launcher: { sessionId: historyOwner }, finalLine: 'x'.repeat(128) }));
  const historyAck = Object.fromEntries(historyRows.map((row) => [row.id, { t: historyNow, event: row.event }]));
  fs.writeFileSync(ackFile(historyOwner), JSON.stringify({ owner: historyOwner, delivered: historyAck }));
  fs.appendFileSync(eventFile(), historyRows.map(JSON.stringify).join('\n') + '\n');
  const oldPending = record('old-pending', 'finished', { t: historyNow - RETENTION_MS * 2 });
  record('live-old', 'running', { pid: process.pid });
  fs.writeFileSync(eventFile(), readEvents().map((row) => row.id === oldPending.id || row.owner === 'live-old'
    ? { ...row, t: historyNow - RETENTION_MS * 2 } : row).map(JSON.stringify).join('\n') + '\n');
  compactWorkerEvents();
  assert.ok(fs.statSync(eventFile()).size < ROTATE_BYTES, 'acknowledged history is off the hot path');
  assert.ok(readAck(historyOwner).highWater >= historyRows.at(-1).seq);
  assert.ok(Object.keys(readAck(historyOwner).delivered).length <= ACK_RECEIPTS);
  assert.ok(inbox(readEvents(), 'old-pending', readAck('old-pending')).pending.some((row) => row.id === oldPending.id));
  assert.equal(inbox(readEvents(), 'live-old').running.length, 1);
  const summary = auditWorkerEvents(undefined, historyNow - 10000).find((row) => row.owner === historyOwner);
  assert.equal(summary.acknowledged, historyRows.length, 'rotation preserves the seven-day audit window');
  assert.equal(summary.finishToAckMs.max, 1000);
  compactWorkerEvents(historyNow + RETENTION_MS * 2);
  assert.equal(fs.readdirSync(path.join(tmp, 'worker-event-history')).filter((name) => Number(name.split('-')[0]) < historyNow + RETENTION_MS).length, 0);
  assert.ok(inbox(readEvents(), 'old-pending').pending.length, 'retention never removes unacknowledged work');
  console.log('PASS >4MiB legacy acknowledgements, bounded high-water state, rotation, pending/live preservation and audit retention');

  const pausedPoll = path.join(tmp, 'watch-poll-gate.mjs');
  fs.writeFileSync(pausedPoll, `import fs from 'node:fs';
const timeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms !== 150 || !process.env.WATCH_POLL_GATE) return timeout(fn, ms, ...args);
  fs.writeFileSync(process.env.WATCH_POLL_RECEIPT, 'ready');
  const poll = () => fs.existsSync(process.env.WATCH_POLL_GATE) ? fn(...args) : timeout(poll, 20);
  return timeout(poll, 20);
};
`);
  const hookPoll = path.join(tmp, 'hook-poll'), hookGate = path.join(tmp, 'hook-gate');
  const watcher = startWatch('hook-wins', { NODE_OPTIONS: `--import ${pausedPoll}`, WATCH_POLL_RECEIPT: hookPoll, WATCH_POLL_GATE: hookGate });
  await until(() => hasWatcher('hook-wins'), 'watcher armed');
  await until(() => fs.existsSync(hookPoll), 'watcher parked before the race');
  record('hook-wins'); assertBlock(hookRun('hook-wins'), 'hook wins gated watcher race');
  fs.writeFileSync(hookGate, 'released');
  const woke = await watcher.done;
  assert.equal(woke.code, 0, woke.stderr); assert.match(woke.stdout, /hook-wins-worker.*acknowledged elsewhere/);
  assert.equal(hasWatcher('hook-wins'), false);
  const faultWatch = startWatch('watch-ack-failure', { NODE_OPTIONS: `--import ${fault}`, ACK_FAULT: 'ENOSPC' });
  await until(() => hasWatcher('watch-ack-failure'), 'ack failure watcher armed');
  record('watch-ack-failure');
  const faultWake = await faultWatch.done;
  assert.equal(faultWake.code, 0, faultWake.stderr); assert.match(faultWake.stdout, /watch-ack-failure-worker.*acknowledgement unavailable/);
  assert.equal(inbox(readEvents(), 'watch-ack-failure', readAck('watch-ack-failure')).pending.length, 1, 'a failed watcher ack retains pending delivery');
  const first = startWatch('singleton'); await until(() => hasWatcher('singleton'), 'singleton armed');
  const duplicate = await startWatch('singleton').done; assert.equal(duplicate.code, 0); assert.match(duplicate.stdout, /already-armed/);
  record('singleton'); assert.equal((await first.done).code, 0);
  const claims = path.join(tmp, 'worker-watchers');
  const claimFor = (owner) => path.join(claims, path.basename(ackFile(owner), '.json') + '.claim');
  const staleClaim = claimFor('stale-claim'); fs.mkdirSync(staleClaim);
  fs.writeFileSync(path.join(staleClaim, 'watcher.json'), JSON.stringify({ owner: 'stale-claim', pid: 2147483647, t: Date.now() }));
  fs.mkdirSync(`${staleClaim}.reap`); fs.utimesSync(`${staleClaim}.reap`, new Date(0), new Date(0));
  const recoveredWatch = startWatch('stale-claim'); await until(() => hasWatcher('stale-claim'), 'dead claim and stale reaper recovered');
  record('stale-claim'); assert.equal((await recoveredWatch.done).code, 0); assert.equal(fs.existsSync(staleClaim), false);
  record('watch-print-error');
  await assert.rejects(watch('watch-print-error', () => { throw Error('watch print failed'); }, { debounceSec: 0 }), /watch print failed/);
  assert.equal(fs.existsSync(claimFor('watch-print-error')), false, 'watch error releases its claim');
  assert.equal(inbox(readEvents(), 'watch-print-error', readAck('watch-print-error')).pending.length, 1);
  const heartbeatWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (String(file).includes(claimFor('watch-heartbeat-error'))) throw Object.assign(Error('claim ENOSPC'), { code: 'ENOSPC' });
    return heartbeatWrite(file, ...args);
  };
  try { await assert.rejects(watch('watch-heartbeat-error'), /claim ENOSPC/); }
  finally { fs.writeFileSync = heartbeatWrite; }
  assert.equal(fs.existsSync(claimFor('watch-heartbeat-error')), false, 'failed first heartbeat releases its claim');

  const tail = createEventTail('incremental-owner'); await tail.read();
  const initial = { ...tail.stats };
  for (let i = 0; i < 30; i++) await tail.read();
  assert.deepEqual(tail.stats, initial, 'unchanged polls do not reread or reparse history');
  const added = record('incremental-owner'); await tail.read();
  assert.deepEqual(tail.rows().map((row) => row.id), [added.id]);
  assert.ok(tail.stats.bytes - initial.bytes < 4096, 'only the appended bytes were read');
  record('unrelated-owner'); await tail.read(); assert.equal(tail.stats.parsed, initial.parsed + 1, 'other owners are prefiltered before JSON.parse');
  compactWorkerEvents(); await tail.read(); assert.equal(tail.rows().filter((row) => row.id === added.id).length, 1, 'rotation does not duplicate a cursor event');
  const rotationTail = createEventTail('rotation-settlement');
  const unresolved = record('rotation-settlement', 'failed', { mayRun: true, thread: 'rotation-thread' }); await rotationTail.read();
  record('rotation-settlement', 'observed', { runId: 'rotation-proof', thread: 'rotation-thread', mayRun: false });
  for (let i = 0; i < 70; i++) record('rotation-padding', 'finished', { runId: `rotation-padding-${i}` });
  compactWorkerEvents(); await rotationTail.read();
  assert.equal(rotationTail.rows().find((row) => row.id === unresolved.id).settled, true, 'rotation refreshes cached state for the same event ID');
  assert.equal(inbox(rotationTail.rows(), 'rotation-settlement').running.length, 0, 'a retained pending hint stays settled after its proof is archived');
  const retiringReceipt = path.join(tmp, 'retiring-poll'), retiringGate = path.join(tmp, 'retiring-gate');
  const retiringWatch = startWatch('retiring-worker', { NODE_OPTIONS: `--import ${pausedPoll}`,
    WATCH_POLL_RECEIPT: retiringReceipt, WATCH_POLL_GATE: retiringGate });
  record('retiring-worker', 'running', { thread: 'retiring-thread', pid: process.pid });
  await until(() => hasWatcher('retiring-worker'), 'running watcher armed');
  await until(() => fs.existsSync(retiringReceipt), 'watcher observed its running set');
  record('retiring-worker', 'observed', { runId: 'retiring-proof', thread: 'retiring-thread', mayRun: false });
  fs.writeFileSync(retiringGate, 'released');
  const retired = await retiringWatch.done; assert.equal(retired.code, 0); assert.match(retired.stdout, /workers-no-longer-running/);
  console.log('PASS hook/watcher acknowledgement race exits, singleton claims, incremental offsets, unchanged polls, owner prefilter and rotation');

  const invokeWorker = (args, config) => spawnSync(process.execPath, ['--import', transport, worker, ...args],
    { env: { ...env, WORKER_EVENTS_FIXTURE: JSON.stringify(config) }, encoding: 'utf8', timeout: 15000 });
  const lost = invokeWorker(['start', '--owner', 'lost-owner', '--name', 'lost', '--cwd', tmp, '--sandbox', 'read-only', '--effort', 'high', 'fixture'],
    { lostAtTurnStart: true, thread: 'lost-thread' });
  assert.equal(lost.status, 2); assert.equal(inbox(readEvents(), 'lost-owner').running.length, 1);
  const recovery = invokeWorker(['wait', '--owner', 'lost-owner', '--thread', 'lost-thread'], { status: 'completed', turn: 'recovered-turn' });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(inbox(readEvents(), 'lost-owner').running.length, 0, 'recovered completion settles a turn-less start hint');
  hookRun('lost-owner'); assert.equal(hookRun('lost-owner'), null, 'completed recovered work needs no watcher');
  record('orphan-owner', 'running', { pid: 2147483647, account: 'main', thread: 'orphan-thread', turn: 'orphan-turn' });
  const orphanRows = readEvents().map((row) => row.owner === 'orphan-owner' ? { ...row, t: Date.now() - 120000 } : row);
  fs.writeFileSync(eventFile(), orphanRows.map(JSON.stringify).join('\n') + '\n');
  assert.equal(hookRun('orphan-owner'), null, 'dead followers past the grace interval cannot demand empty watchers forever');
  const mine = invokeWorker(['mine', '--owner', 'orphan-owner'], { status: 'completed', turn: 'orphan-turn' });
  assert.equal(mine.status, 0, mine.stderr); assert.match(mine.stdout, /completed/);
  assert.equal(inbox(readEvents(), 'orphan-owner').running.length, 0, 'mine persists authoritative terminal hub observations');
  record('unknown-hub-owner', 'running', { pid: 2147483647, account: 'main', thread: 'unknown-thread', turn: 'unknown-turn' });
  const unknown = invokeWorker(['mine', '--owner', 'unknown-hub-owner'], { status: 'unknown', turn: 'unknown-turn' });
  assert.equal(unknown.status, 0, unknown.stderr); assert.match(unknown.stdout, /unknown/);
  assert.equal(inbox(readEvents(), 'unknown-hub-owner').running.length, 1, 'an unknown status is not proof of settlement');
  console.log('PASS lost turn/start reply plus recovery wait; dead follower grace and mine reconciliation');

  for (const source of ['fork', 'clear']) {
    const owner = `${source}-owner`, bridge = path.join(tmp, `${source}-env`);
    hookRun(owner, { hook_event_name: 'SessionStart', source }, { env: { CLAUDE_ENV_FILE: bridge } });
    assert.equal(fs.readFileSync(bridge, 'utf8'), `\nexport ORCHESTRATOR_OWNER='${owner}'\n`);
    const r = spawnSync(process.execPath, [worker, 'start', '--name', `${source}-worker`], { env: { ...env, ORCHESTRATOR_OWNER: owner }, encoding: 'utf8' });
    assert.equal(r.status, 2); assert.equal(hookRun(owner).decision, 'block', `${source} workers are delivered to the new session owner`);
  }
  const matcher = JSON.parse(fs.readFileSync(path.join(scripts, '../templates/session-start-hook.json'), 'utf8')).hooks.SessionStart[0].matcher;
  assert.ok(matcher.includes('fork') && matcher.includes('clear'));
  console.log('PASS fork/clear SessionStart bridge, owner isolation and template matchers');

  const deadlineFixture = path.join(tmp, 'deadline-fixture.mjs'), deadlineReceipt = path.join(tmp, 'deadline.json');
  fs.writeFileSync(deadlineFixture, `import fs from 'node:fs'; import fsp from 'node:fs/promises';
const timeout = globalThis.setTimeout, open = fsp.open, rename = fsp.rename;
globalThis.setTimeout = (fn, ms, ...args) => timeout(() => {
  if(ms===220) fs.writeFileSync(process.env.DEADLINE_RECEIPT, JSON.stringify({budget:ms}));
  fn(...args);
}, ms);
fsp.open = (file, ...args) => process.env.DEADLINE_MODE !== 'ack' && String(file).endsWith('worker-events.jsonl') ? new Promise(()=>{}) : open(file, ...args);
fsp.rename = (...args) => process.env.DEADLINE_MODE === 'ack' && String(args[1]).includes('/worker-acks/') ? new Promise(()=>{}) : rename(...args);
`);
  assert.equal(hookRun('deadline-owner', {}, { realDeadline: true, import: deadlineFixture, env: { DEADLINE_RECEIPT: deadlineReceipt } }), null);
  assert.equal(JSON.parse(fs.readFileSync(deadlineReceipt, 'utf8')).budget, 220, 'assert the internal deadline, not cold Node startup wall time');
  assert.equal(fs.existsSync(`${ackFile('deadline-owner')}.lock`), false, 'deadline cleanup does not leave acknowledgement contention behind');
  record('deadline-ack-owner');
  assert.equal(hookRun('deadline-ack-owner', {}, { realDeadline: true, import: deadlineFixture,
    env: { DEADLINE_RECEIPT: deadlineReceipt, DEADLINE_MODE: 'ack' } }), null);
  assert.equal(inbox(readEvents(), 'deadline-ack-owner', readAck('deadline-ack-owner')).pending.length, 1);
  assert.equal(fs.existsSync(`${ackFile('deadline-ack-owner')}.lock`), false, 'deadline during the ack transaction releases its lock');
  assert.deepEqual(fs.readdirSync(path.dirname(ackFile('deadline-ack-owner')))
    .filter((name) => name.startsWith(path.basename(ackFile('deadline-ack-owner')) + '.')), [], 'deadline removes its uncommitted acknowledgement temp file');

  const outputProbe = path.join(tmp, 'output-deadline-probe.mjs');
  fs.writeFileSync(outputProbe, `import fs from 'node:fs'; import fsp from 'node:fs/promises';
const timeout = globalThis.setTimeout, rename = fsp.rename;
let deadline, prepared = false;
// Arm the real 220 ms callback at the probed boundary, not before potentially slow fixture setup.
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms === 220) { deadline = () => { fs.writeFileSync(process.env.PROBE_DEADLINE, '220'); fn(...args); }; return undefined; }
  return timeout(fn, ms, ...args);
};
fsp.rename = async (from, to) => {
  const result = await rename(from, to);
  if (to === process.env.PROBE_ACK && !prepared) {
    prepared = true;
    fs.writeFileSync(process.env.PROBE_PREPARED, fs.readFileSync(to));
    timeout(deadline, 220);
    if (process.env.PROBE_MODE === 'rename') return new Promise(() => {});
  }
  return result;
};
if (process.env.PROBE_MODE === 'output') process.stdout.write = () => true;
`);
  for (const mode of ['rename', 'output']) for (const receiver of ['Stop', 'watch']) {
    const owner = `output-probe-${mode}-${receiver}`, row = record(owner);
    const preparedFile = path.join(tmp, `${owner}-prepared`), deadlineFile = path.join(tmp, `${owner}-deadline`);
    assert.equal(hookRun(owner, {}, { realDeadline: true, import: outputProbe,
      env: { PROBE_ACK: ackFile(owner), PROBE_PREPARED: preparedFile, PROBE_DEADLINE: deadlineFile, PROBE_MODE: mode } }), null);
    const preparedAck = JSON.parse(fs.readFileSync(preparedFile, 'utf8'));
    assert.equal(preparedAck.highWater, 0); assert.equal(preparedAck.transaction.events[0].id, row.id);
    assert.equal(fs.readFileSync(deadlineFile, 'utf8'), '220', 'deadline fired after the successful intent rename');
    assert.equal(inbox(readEvents(), owner, readAck(owner)).pending.length, 1, 'deadline cannot mark unseen output delivered');
    assert.equal(fs.existsSync(`${ackFile(owner)}.lock`), false);
    assert.equal(hookRun(owner, { stop_hook_active: true }), null);
    expireTransaction(owner);
    if (receiver === 'Stop') assert.match(assertBlock(hookRun(owner), 'Stop recovers the interrupted intent').reason, new RegExp(owner));
    else {
      const recovered = await startWatch(owner).done;
      assert.equal(recovered.code, 0, recovered.stderr); assert.match(recovered.stdout, new RegExp(owner));
    }
    assert.equal(inbox(readEvents(), owner, readAck(owner)).pending.length, 0);
    assert.equal(readAck(owner).transaction, null);
  }
  console.log('PASS successful rename plus stalled completion/output past deadline; next Stop and watcher redeliver and commit');
  console.log(`PASS internal 220ms hook deadline; fixtures: ${tmp}`);
} finally {
  for (const child of children) child.kill('SIGKILL');
  if (previous === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
}
