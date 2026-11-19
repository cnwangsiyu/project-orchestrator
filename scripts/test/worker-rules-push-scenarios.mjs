#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDigest } from '../lib/global-rules.mjs';
import { appendEvent, compactWorkerEvents, inbox, readEvents, retireWorker } from '../lib/worker-events.mjs';
import { rememberWorkerRules, workerRulesMessage, workerRulesVersion } from '../lib/worker-rules-push.mjs';

const runFile = promisify(execFile);
const scripts = fileURLToPath(new URL('../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-rules-push-'));
const digestFile = path.join(dir, 'global-rules.md'), profiles = path.join(dir, 'accounts.json');
const fixture = path.join(dir, 'transport.mjs'), requests = path.join(dir, 'requests.jsonl');
const statuses = path.join(dir, 'statuses.json');
const bin = path.join(dir, 'bin'), owner = 'a1234567-abcd-4578-8987-123456789000';
const other = 'b1234567-abcd-4578-8987-123456789000';
const [v1, v2, v3, v4] = ['2030-01-01.8', '2030-01-01.9', '2030-01-01.10', '2030-01-01.11'];
const views = ['Unchanged worker sentence.', 'First change.', 'Second change.', 'Hook change.'];
const digestText = (version, index) => `# Global Rules\nversion: ${version}\n\n## Orchestrator Rules\n- Owner revision ${index}.\n\n## Worker Rules\n- ${views.slice(0, index + 1).join(' ')}\n`;
const publish = (version, index) => {
  fs.writeFileSync(digestFile + '.next', digestText(version, index));
  fs.renameSync(digestFile + '.next', digestFile);
};
const env = { ...process.env, RULES_SHARED: dir, RULES_DIGEST: digestFile, CODEX_ACCOUNTS: profiles,
  NODE_OPTIONS: `--import=${pathToFileURL(fixture).href}`, FIXTURE_REQUESTS: requests, FIXTURE_STATUSES: statuses,
  ORCHESTRATOR_OWNER: '', PATH: `${bin}:${process.env.PATH}` };
process.env.RULES_SHARED = dir;
process.env.RULES_DIGEST = digestFile;
const cli = async (args, extra = {}) => {
  try {
    const result = await runFile(process.execPath, [path.join(scripts, 'codex-worker.mjs'), ...args], {
      env: { ...env, ...extra }, timeout: 5000,
    });
    return { ...result, code: 0 };
  } catch (error) { return error; }
};
const tracked = (thread, fields = {}) => {
  const row = { runId: thread, event: 'running', pid: process.pid, owner, account: 'main', followerCommand: 'start',
    name: thread, thread, turn: `turn-${thread}`, rulesVersion: v1, ...fields };
  appendEvent(row);
  return row;
};
const snapshot = root => fs.readdirSync(root).sort().flatMap(name => {
  const file = path.join(root, name);
  return fs.statSync(file).isDirectory() ? snapshot(file) : [[path.relative(dir, file), fs.readFileSync(file).toString('base64')]];
});
const steers = () => fs.readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const until = async predicate => {
  for (let i = 0; i < 120; i++) {
    if (predicate()) return;
    await pause(50);
  }
  assert.fail('timed out waiting for the watcher');
};

let watch;
try {
  fs.writeFileSync(requests, '');
  fs.writeFileSync(statuses, '{}');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$*" = "agents --json" ] || exit 1\nprintf \'%s\\n\' \'[{"sessionId":"claude-live","status":"working"}]\'\n', { mode: 0o755 });
  const accounts = ['main', 'b', 'trae', 'ttadk'];
  fs.writeFileSync(profiles, JSON.stringify(Object.fromEntries(accounts.map((account, index) =>
    [account, { home: dir, hub: `ws://127.0.0.1:${5010 + index}` }]))));
  fs.writeFileSync(fixture, `
    import fs from 'node:fs';
    globalThis.WebSocket = class {
      handlers = {};
      constructor(url) { this.url = new URL(url); queueMicrotask(() => this.emit('open', {})); }
      addEventListener(event, handler) { this.handlers[event] = handler; }
      emit(event, value) { (this.handlers[event] ?? this['on' + event])?.(value); }
      close() {}
      send(raw) {
        const { id, method, params } = JSON.parse(raw);
        if (!id) return;
        let result = {}, error;
        if (method === 'turn/steer') {
          fs.appendFileSync(process.env.FIXTURE_REQUESTS, JSON.stringify({ port: this.url.port, ...params }) + '\\n');
          if (params.threadId === process.env.FIXTURE_FAIL) error = { code: -1, message: 'fixture failure' };
          else result = { turnId: params.expectedTurnId };
        }
        if (method === 'thread/read') {
          const state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATUSES, 'utf8'))[params.threadId] ?? {};
          if (state.timeout) return;
          result = { thread: { turns: [{ id: state.turn ?? 'turn-' + params.threadId, status: state.status ?? 'inProgress' }] } };
        }
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id, result, error }) }));
      }
    };
  `);
  const d1 = parseDigest(digestText(v1, 0));
  rememberWorkerRules(d1);
  const run = accounts.map(account => tracked(account, { account }));
  const failing = tracked('failing');
  tracked('already-current', { rulesVersion: v2 });
  const finished = tracked('finished');
  appendEvent({ ...finished, event: 'finished', settled: true });
  tracked('exec-live', { followerCommand: 'exec' });
  tracked('claude-live', { account: 'claude', followerCommand: 'claude', pid: null });
  tracked('claude-finished', { account: 'claude', followerCommand: 'claude', pid: null });
  const outside = tracked('other-owner', { owner: other });
  publish(v2, 1);
  const first = await cli(['rules-push', '--owner', owner], { FIXTURE_FAIL: failing.thread });
  assert.equal(first.code, 1, first.stderr);
  assert.equal(first.stdout.split('\n').filter(line => line.startsWith('delivered ')).length, 4);
  for (const thread of ['failing', 'exec-live', 'claude-live']) assert.match(first.stdout, new RegExp(`NOT DELIVERED .*thread=${thread}`));
  assert.doesNotMatch(first.stdout, /already-current|other-owner/);
  for (const thread of ['finished', 'claude-finished']) assert.match(first.stdout, new RegExp(`SKIPPED .*thread=${thread} .*not running:`));
  const initial = steers();
  assert.deepEqual(initial.map(row => row.port).sort(), ['5010', '5010', '5011', '5012', '5013']);
  for (const row of initial) {
    assert.equal(row.expectedTurnId, `turn-${row.threadId}`);
    assert.equal(row.input[0].text, `Worker rules changed ${v1} -> ${v2}\n- First change.`);
  }
  assert.equal(workerRulesVersion(failing), v1);
  for (const row of run) assert.equal(workerRulesVersion(row), v2);
  const retry = await cli(['rules-push', '--all']);
  assert.match(retry.stdout, /delivered .*thread=failing/);
  assert.match(retry.stdout, /delivered .*thread=other-owner/);
  assert.deepEqual(steers().slice(initial.length).map(row => row.threadId).sort(), ['failing', 'other-owner']);
  assert.equal(workerRulesVersion(outside), v2);
  assert.doesNotMatch(retry.stdout, /thread=finished\b|thread=claude-finished\b/);

  const unsteerable = tracked('unsteerable');
  const stale = tracked('stale-timeout', { pid: 2147483647, rulesVersion: null });
  const liveUnknown = tracked('live-timeout');
  fs.writeFileSync(statuses, JSON.stringify({ [stale.thread]: { timeout: true }, [liveUnknown.thread]: { timeout: true } }));
  const skippedOnce = await cli(['rules-push', '--owner', owner], { FIXTURE_FAIL: unsteerable.thread });
  assert.match(skippedOnce.stdout, /SKIPPED .*thread=stale-timeout .*not running: stale follower/);
  assert.match(skippedOnce.stdout, /UNCONFIRMED .*thread=live-timeout/);
  assert.match(skippedOnce.stdout, /NOT DELIVERED .*thread=unsteerable/);
  const repeated = await cli(['rules-push', '--owner', owner], { FIXTURE_FAIL: unsteerable.thread });
  assert.doesNotMatch(repeated.stdout, /thread=stale-timeout/);
  assert.match(repeated.stdout, /NOT DELIVERED .*thread=unsteerable/);
  const refused = await cli(['retire', '--thread', failing.thread, '--owner', owner]);
  assert.equal(refused.code, 2); assert.match(refused.stderr, /refused: a turn is running/);
  const unauthorized = await cli(['retire', '--thread', stale.thread, '--owner', other]);
  assert.equal(unauthorized.code, 2); assert.match(unauthorized.stderr, /no tracked worker/);
  const noOwner = await cli(['retire', '--thread', stale.thread]);
  assert.equal(noOwner.code, 2); assert.match(noOwner.stderr, /launching session/);
  const retired = await cli(['retire', '--thread', stale.thread, '--owner', owner, '--reason', 'finished stale follower']);
  assert.equal(retired.code, 0, retired.stderr); assert.match(retired.stdout, /retired .*thread=stale-timeout/);
  assert.ok(!inbox(readEvents(), owner).running.some(row => row.thread === stale.thread));
  const hidden = await cli(['mine', '--owner', owner], { MINE_STATUS_TIMEOUT_MS: '100' });
  assert.doesNotMatch(hidden.stdout, /thread=stale-timeout/);
  const all = await cli(['mine', '--owner', owner, '--all'], { MINE_STATUS_TIMEOUT_MS: '100' });
  assert.match(all.stdout, /stale-timeout\tretired/);
  const pendingRetire = tracked('retirement-race', { pid: 2147483647 });
  const oldRecord = readEvents().findLast(row => row.thread === pendingRetire.thread);
  tracked(pendingRetire.thread, { runId: 'retirement-race-new' });
  assert.throws(() => retireWorker(oldRecord, 'old state'), /worker state changed/);
  const beforeHelp = snapshot(dir);
  for (const args of [['--help'], ['start', '--help'], ['--account', 'missing', '--help'], ['help']]) {
    const help = await cli(args); assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /retire --thread/);
  }
  for (const args of [['invalid-command'], []]) {
    const usage = await cli(args); assert.equal(usage.code, 2); assert.match(usage.stderr, /usage:/);
  }
  assert.deepEqual(snapshot(dir), beforeHelp, 'help and usage errors leave all fixture bytes unchanged');
  appendEvent({ ...liveUnknown, event: 'finished', mayRun: false, settled: true });

  const later = tracked('watch-start');
  watch = spawn(process.execPath, [path.join(scripts, 'codex-worker.mjs'), 'watch', '--owner', owner], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let watchOutput = '';
  watch.stdout.on('data', chunk => { watchOutput += chunk; });
  await until(() => workerRulesVersion(later) === v2);
  publish(v3, 2);
  await until(() => workerRulesVersion(later) === v3 && watchOutput.includes(v3));
  assert.deepEqual(steers().filter(row => row.threadId === later.thread).map(row => row.input[0].text), [
    `Worker rules changed ${v1} -> ${v2}\n- First change.`,
    `Worker rules changed ${v2} -> ${v3}\n- Second change.`,
  ]);
  assert.doesNotMatch(watchOutput, /thread=stale-timeout|thread=finished\b|thread=claude-finished/);
  watch.kill();
  await once(watch, 'exit');
  watch = null;

  // Enough unrelated events/compaction must not forget retirement; a new tracked turn revives it.
  for (let i = 0; i < 70; i++) appendEvent({ runId: `noise-${i}`, event: 'finished', owner: other, account: 'main',
    followerCommand: 'exec', pid: 2147483647, settled: true, name: `noise-${i}` });
  compactWorkerEvents();
  assert.ok(readEvents().some(row => row.thread === stale.thread && row.event === 'retired'));
  const afterRetire = await cli(['rules-push', '--owner', owner]);
  assert.doesNotMatch(afterRetire.stdout, /thread=stale-timeout/);
  fs.writeFileSync(statuses, JSON.stringify({ [stale.thread]: { turn: 'new-stale-turn' } }));
  const revived = tracked(stale.thread, { runId: 'revived-stale', turn: 'new-stale-turn', rulesVersion: v1 });
  const revival = await cli(['rules-push', '--owner', owner]);
  assert.match(revival.stdout, /delivered .*thread=stale-timeout/);
  assert.equal(workerRulesVersion(revived), v3);
  assert.ok(inbox(readEvents(), owner).running.some(row => row.runId === revived.runId));
  // Once seen running again, a later finish is eligible for one fresh skip report.
  appendEvent({ ...revived, event: 'finished', settled: true, mayRun: false });
  const finishedAgain = await cli(['rules-push', '--owner', owner]);
  assert.match(finishedAgain.stdout, /SKIPPED .*thread=stale-timeout/);
  assert.doesNotMatch((await cli(['rules-push', '--owner', owner])).stdout, /thread=stale-timeout/);

  fs.writeFileSync(path.join(dir, 'rules-seen.json'), JSON.stringify({ [owner]: { version: v3, orchestrator: true },
    __versions: { [v3]: ['- Owner revision 2.', `- ${views.slice(0, 3).join(' ')}`] } }));
  publish(v4, 3);
  const hook = spawn(process.execPath, [path.join(scripts, 'worker-inbox-hook.mjs')], { env });
  let hookOutput = '';
  hook.stdout.on('data', chunk => { hookOutput += chunk; });
  hook.stdin.end(JSON.stringify({ session_id: owner, hook_event_name: 'Stop' }));
  assert.deepEqual(await once(hook, 'close'), [0, null]);
  const { reason } = JSON.parse(hookOutput);
  assert.match(reason, /delivered .*thread=watch-start/);
  assert.match(reason, /NOT DELIVERED .*thread=claude-live/);
  assert.equal(workerRulesVersion(later), v4);
  const mine = await cli(['mine', '--owner', owner]);
  assert.equal(mine.code, 0, mine.stderr);
  assert.match(mine.stdout, /watch-start.*rules=2030-01-01\.11/);
  assert.match(mine.stdout, /claude-live.*rules=2030-01-01\.8 \(stale/);

  const large = { version: v2, worker: `- Old rule.\n- ${'x'.repeat(6500)}.\n- You MUST stop.\n- Never spill.` };
  const capped = workerRulesMessage(v1, large, ['- Old rule.']);
  assert.match(capped, /global-rules\.md/);
  assert.match(capped, /MUST stop/);
  assert.match(capped, /Never spill/);
  assert.doesNotMatch(capped, /xxx|Old rule/);
  console.log('PASS owner/all scope, four hubs, skipped-once finished/stale workers, running failures repeat, retire ownership/liveness/races/compaction/revival, byte-identical help/usage, watch/Stop/mine and bounded deltas');
} finally {
  if (watch && watch.exitCode === null && watch.signalCode === null) {
    watch.kill();
    await once(watch, 'exit');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
