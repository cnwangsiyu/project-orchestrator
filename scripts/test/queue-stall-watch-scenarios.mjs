#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createPoolStallMonitor, createQueueStallMonitor, fallbackRouteArgs, queueStallText } from '../lib/queue-stall-watch.mjs';
import { appendEvent, readEvents } from '../lib/worker-events.mjs';
import { saveQueue } from '../lib/worker-queue.mjs';
import { queueDecisionFile } from '../lib/queue-decision.mjs';
import { saveLaunch } from '../lib/worker-launch.mjs';
import { parseTaskSpec } from '../lib/pipeline/taskspec.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-stall-'));
const scripts = fileURLToPath(new URL('../', import.meta.url));
const min = 60000, now = Date.now(), owner = '654340f6-99c4-5443-b024-020342e6b320';
Object.assign(process.env, { HOME: tmp, RULES_SHARED: tmp, RES_DIR: tmp, CODEX_ACCOUNTS: path.join(tmp, 'accounts.json') });
const profiles = { trae: { home: tmp, kind: 'trae' } };
const row = { owner, account: 'trae', name: 'queue-probe', project: 'fixture', thread: 'thread-1',
  turn: 'turn-1', runId: 'run-1', model: 'gpt-6.2-sol', pid: process.pid, t: now - 30 * min };
const policy = { enabled: true, queueWaitMinutes: 5, allowHardPersonalAstra: true };
const quota = { codexAccounts: [
  { name: 'trae', quota: { daily: { [row.model]: { depleted: true, resetsAt: now + 30 * min } } } },
  { name: 'ttadk', kind: 'ttadk', usage: { used: 95, limit: 100, resetsAt: now + 45 * min } }
] };
const argv = ['implement', '--name', row.name, '--project', row.project, '--impact', 'service',
  '--task-dir', path.join(tmp, "work's brief"), '--verbose', '--exclude-account', 'other', '--no-local-build', '--user-ok', 'old-approval'];
const defaults = { owner, 'route-args': JSON.stringify(argv), 'routed-seat': JSON.stringify({ tier: 'normal' }) };
const launch = { t: row.t, defaults };
const wait = (since, position = 244) => ({ state: 'waiting', since, position, turnId: row.turn });
const samples = [];
let queue = wait(now - 6 * min);
const monitor = () => createQueueStallMonitor(owner, { statusOf: () => queue, launchOf: () => launch,
  quotaOf: () => quota, holdsOf: () => false, policyOf: () => policy, emit: event => (samples.push(event), event) });

try {
  // Exercise the host's idle-wake contract with a live fixture follower and no watch.
  const hook = JSON.parse(fs.readFileSync(new URL('../../templates/stop-hook.json', import.meta.url)))
    .hooks.Stop.flatMap(group => group.hooks).find(entry => entry.asyncRewake);
  assert.match(hook.command, /queue-rewake-hook/);
  const idleOwner = 'idle-owner';
  process.env.RULES_SHARED = path.join(tmp, 'rewake-fixture');
  appendEvent({ ...row, owner: idleOwner, event: 'running' });
  const listener = spawn(process.execPath, [path.join(scripts, 'queue-rewake-hook.mjs')]);
  let reminder = '';
  listener.stderr.on('data', chunk => { reminder += chunk; });
  listener.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: idleOwner }));
  const closed = new Promise(resolve => listener.once('close', resolve));
  try {
    const lock = path.join(process.env.RULES_SHARED, 'queue-rewake', idleOwner + '.lock');
    for (let i = 0; i < 200 && !fs.existsSync(lock); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(lock), 'idle listener armed');
    for (const recipient of ['other-owner', idleOwner])
      appendEvent({ ...row, owner: recipient, event: 'message', wake: true, kind: 'queue-stalled', text: 'queue for ' + recipient });
    assert.equal(await closed, 2);
    assert.match(reminder, /queue for idle-owner/);
    assert.doesNotMatch(reminder, /other-owner/);
  } finally { listener.kill(); process.env.RULES_SHARED = tmp; }
  const [first] = await monitor().poll([row], [], now);
  assert.equal(first.kind, 'queue-stalled'); assert.equal(first.severity, 'risk'); assert.equal(first.wake, true);
  assert.match(first.text, /task=queue-probe thread=thread-1 turn=turn-1.*queued 6.0 min position=244/);
  assert.ok(first.options.some(o=>o.id==='wait'));
  assert.match(first.options.find(o=>o.id==='wait').command,/queue-choice.*--owner.*--option wait/);
  assert.ok(!first.text.includes('old-approval'));
  assert.equal((await monitor().poll([row], [], now + min)).length, 0, 'restart deduplicates the same episode');
  const noticeFile = queueDecisionFile(row), midTurn = { ...queue, workStarted: true };
  assert.equal(JSON.parse(fs.readFileSync(noticeFile, 'utf8')).status, 'waiting');
  queue = midTurn;
  assert.equal((await monitor().poll([row], [], now + min)).length, 0, 'a mid-turn re-queue is left to its follower');
  assert.equal(JSON.parse(fs.readFileSync(noticeFile, 'utf8')).status, 'waiting', 'a mid-turn re-queue keeps its open notice usable');
  queue = { state: 'ready' };
  await monitor().poll([row], [], now + 2 * min);
  queue = wait(now + 3 * min, 100);
  for (let minute = 3; minute < 8; minute++) {
    queue.position -= 10;
    assert.equal((await monitor().poll([row], [], now + minute * min)).length, 0);
  }
  assert.equal((await monitor().poll([row], [], now + 9 * min)).length, 1);
  assert.equal(samples.length, 2);
  queue = wait(now + 10 * min);
  assert.equal((await monitor().poll([row], [], now + 10 * min)).length, 0, 'changed since re-arms even if ready was between polls');
  assert.equal((await monitor().poll([row], [], now + 16 * min)).length, 1);
  console.log('PASS queue episodes remain deduplicated across watcher restarts, re-arm, and ignore fast drain under the threshold');

  const presented = queueStallText(row, wait(now - 6 * min), { now, quota, launch, policy, holds: false });
  assert.ok(!presented.commands.approval.includes('--astra'));
  const hard = { ...launch, defaults: { ...defaults, 'routed-seat': '{"tier":"hard"}' } };
  assert.match(queueStallText(row, wait(now - 6 * min), { now, quota, launch: hard, policy, holds: false }).commands.approval, /--account main --astra/);
  const args = fallbackRouteArgs(launch).args;
  const parse = args => parseTaskSpec(args, { taskId: row.name, requestId: 'fixture', sandboxCeiling: 'danger-full-access' });
  assert.equal(parse(args).flags.owner, owner);
  assert.equal(parse(args).flags.failures, '0');
  assert.equal(parse(args).flags.verbose, true);
  const fromShell = command => {
    const r = spawnSync('/bin/sh', ['-c', 'set -- ' + command + '; printf "%s\\0" "$@"'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\0').slice(0, -1);
  };
  const addCommand = fromShell(presented.commands.approval);
  const rerouteCommand = fromShell(presented.commands.reroute);
  const approvalArgs = addCommand.slice(addCommand.indexOf('--') + 1);
  assert.deepEqual(rerouteCommand.slice(2, -2), approvalArgs);
  assert.equal(parse(rerouteCommand.slice(2)).constraintHash, parse(approvalArgs).constraintHash);
  assert.equal(parse(approvalArgs).flags['task-dir'], path.join(tmp, "work's brief"));
  console.log('PASS saved argument and shell quoting round-trip matches approval scope; Astra only for hard tier');

  fs.writeFileSync(path.join(tmp, 'resources.tsv'), 'testslot\tpool\tmanaged\t-\tfixture\n');
  fs.mkdirSync(path.join(tmp, 'locks'));
  const done = { ...row, event: 'message', kind: 'progress', text: 'DONE. Work finished and resources returned.' };
  const wrap = options => queueStallText(row, wait(now - 13 * min), { now, launch, quota, policy, ...options });
  assert.match(wrap({ notes: [done] }).text, /likely final report only — let it finish; do not interrupt$/);
  assert.equal(wrap({ notes: [done] }).commands, undefined);
  for (const annotation of [{ ...done, kind: 'quota-warning', text: 'quota crossed 90%' },
    { ...done, kind: 'info', alertId: 'quota-refresh-failure:fixture', text: 'numeric quota unavailable' }])
    assert.equal(wrap({ notes: [done, annotation] }).wrapUp, true, 'quota annotations cannot replace worker progress');
  const lock = path.join(tmp, 'locks/testslot.d');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'info'), 'project\tfixture\ntask\tqueue-probe\n');
  assert.equal(wrap({ notes: [done] }).wrapUp, undefined, 'an owned hold prevents wrap-up inference');
  fs.rmSync(lock, { recursive: true });
  const out = path.join(tmp, 'codex-last.md');
  fs.writeFileSync(out, 'Finished.\n');
  const fresh = { ...launch, defaults: { ...defaults, out } };
  assert.equal(wrap({ launch: fresh, now: Date.now() }).wrapUp, true);
  const old = new Date(now - 20 * min);
  fs.utimesSync(out, old, old);
  assert.equal(wrap({ launch: fresh }).wrapUp, undefined);
  console.log('PASS final-report protection uses a progress note or fresh output, with confirmed returned holds');

  fs.writeFileSync(process.env.CODEX_ACCOUNTS, JSON.stringify(profiles));
  fs.writeFileSync(path.join(tmp, 'quota.json'), JSON.stringify(quota));
  saveLaunch('trae', row.thread, { ...defaults, project: row.project }, owner, { turn: row.turn });
  saveQueue(tmp, row.thread, wait(Date.now() - 13 * min));
  appendEvent({ ...row, event: 'running' });
  appendEvent(done);
  const run = (script, args = []) => spawnSync(process.execPath, [path.join(scripts, script), ...args],
    { encoding: 'utf8', timeout: 8000 });
  const status = run('quota.mjs', ['--running']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /QUEUE-STALLED 13 min @244/);
  const watcher = run('codex-worker.mjs', ['watch', '--owner', owner, '--debounce-sec', '0']);
  assert.equal(watcher.status, 0, watcher.stderr);
  assert.match(watcher.stdout, /^\[queue-stalled\].*notes \[queue-stalled\].*likely final report only — let it finish; do not interrupt/m);
  assert.ok(watcher.stdout.includes('likely final report only — let it finish; do not interrupt'));
  const events = readEvents().filter(event => event.kind === 'queue-stalled');
  assert.equal(events.length, 1);
  assert.equal(events[0].wrapUp, true);
  console.log('PASS the real watcher exits via owner risk-note delivery and quota --running shows the active queue');
  const poolWait = { key: 'devbox-cn/waiter.fixture', holder: 'fixture-s1', project: row.project, task: row.name,
    worker_owner: owner, worker_account: row.account, worker_thread: row.thread, self_restricted: '192.0.2.2,192.0.2.3',
    exclude_reason: 'fixture binding', started_at: (now - 10 * min) / 1000, heartbeat: now / 1000 };
  const poolMonitor = options => createPoolStallMonitor(owner, { waitsOf: () => [{ ...poolWait, ...options }], emit: appendEvent });
  assert.deepEqual(await poolMonitor()([row], [], now), [], 'exactly ten minutes is too early');
  assert.deepEqual(await poolMonitor({ exclude_reason: '' })([row], [], now + min), [], 'soft filters do not alert');
  assert.deepEqual(await poolMonitor({ worker_owner: 'different-owner' })([row], [], now + min), [], 'foreign owner does not alert');
  assert.deepEqual(await poolMonitor({ self_restricted: '' })([row], [], now + min), [], 'no eligible free alternatives do not alert');
  const dir = path.join(tmp, 'pool-waiters/devbox-cn/waiter.fixture');
  fs.mkdirSync(dir, { recursive: true });
  const metadata = { ...poolWait, started_at: Date.now() / 1000 - 601, heartbeat: Date.now() / 1000 };
  fs.writeFileSync(path.join(dir, 'info'), Object.entries(metadata).map(([key, value]) => key + '\t' + value + '\n').join(''));
  const poolWatcher = run('codex-worker.mjs', ['watch', '--owner', owner, '--debounce-sec', '0']);
  assert.equal(poolWatcher.status, 0, poolWatcher.stderr);
  assert.match(poolWatcher.stdout, /notes \[pool-stalled\].*fixture-s1 \(fixture\/queue-probe\).*fixture binding.*192\.0\.2\.2,192\.0\.2\.3/);
  assert.deepEqual(await poolMonitor()([row], [], now + min), [], 'persisted waiter episode suppresses repeat notifications');
  assert.equal(readEvents().filter(event => event.kind === 'pool-stalled').length, 1);
  console.log('PASS hard devbox waits wake their owner once with holder, task, reason and available hosts');
  console.log('Example: ' + events[0].text);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
