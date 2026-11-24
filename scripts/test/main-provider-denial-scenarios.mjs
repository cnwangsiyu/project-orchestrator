import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { activeMainProviderDenial, isUsageLimitExceeded, recordMainProviderDenial } from '../lib/main-provider-denial.mjs';
import { assertExclusiveNewThread } from '../lib/personal-launch-admission.mjs';
import { transportQuotaBlock } from '../lib/worker-transport-retry.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'main-provider-denial-'));
const now = Date.now(), week = 7 * 86400000;
let count = 0;
const check = (name, run) => { run(); count++; console.log(`PASS ${name}`); };
const main = { name: 'main', kind: 'chatgpt', live: true, healthy: true, allowed: true, models: ['gpt-6.2-sol'], seenAt: now,
  windows: [{ used: 98, resetsAt: now + week, windowMins: 10080 }] };
const denied = { codexErrorInfo: 'usageLimitExceeded', message: 'Provider denied usage at 98 percent.' };
const readRows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
try {
  check('structured usageLimitExceeded is a denial, not a percentage or concurrency inference', () => {
    assert.equal(isUsageLimitExceeded(denied), true);
    assert.equal(isUsageLimitExceeded({ code: 'usageLimitExceeded' }), true);
    assert.equal(isUsageLimitExceeded({ message: '98% of the week used' }), false);
    assert.equal(isUsageLimitExceeded({ message: '429 concurrency rate limit' }), false);
  });
  check('98% reading remains informative; receipt survives unchanged fresh readings until actual recovery', () => {
    const shared = path.join(tmp, 'receipt'); fs.mkdirSync(shared);
    assert.equal(activeMainProviderDenial({ shared, observation: main, now }), null);
    assert.equal(recordMainProviderDenial({ shared, error: { message: '429' }, observation: main, now }), null);
    const receipt = recordMainProviderDenial({ shared, error: denied, observation: main, thread: 'thread', turn: 'turn', now });
    assert.equal(receipt.resetsAt, now + week);
    assert.equal(activeMainProviderDenial({ shared, observation: { ...main, seenAt: now + 1 }, now: now + 1 }).code, 'usageLimitExceeded');
    assert.ok(activeMainProviderDenial({ shared, observation: main, now: now + week + 1 }), 'elapsed reset alone cannot prove capacity');
    const restored = { ...main, seenAt: now + 2, windows: [{ ...main.windows[0], used: 0 }] };
    assert.equal(activeMainProviderDenial({ shared, observation: restored, now: now + 2 }), null);
    const cache = path.join(shared, 'quota.json'); fs.writeFileSync(cache, JSON.stringify({ codexAccounts: [main] }));
    assert.throws(() => assertExclusiveNewThread({ account: 'main', shared, cache, time: now + 1 }, false), /usageLimitExceeded/);
    fs.writeFileSync(cache, JSON.stringify({ codexAccounts: [restored] }));
    assert.doesNotThrow(() => assertExclusiveNewThread({ account: 'main', shared, cache, time: now + 2 }, false));
    recordMainProviderDenial({ shared, error: denied, observation: restored, thread: 'thread', turn: 'turn', now: now + 3 });
    assert.equal(activeMainProviderDenial({ shared, observation: restored, now: now + 3 }), null, 'reattaching the old failed turn cannot undo a confirmed recovery');
    assert.equal(JSON.parse(fs.readFileSync(path.join(shared, 'main-provider-denial.json'))).at, now);
    const withoutAt = { ...restored }; delete withoutAt.seenAt;
    fs.writeFileSync(cache, JSON.stringify({ checkedAt: now + 2, codexAccounts: [withoutAt] }));
    assert.doesNotThrow(() => assertExclusiveNewThread({ account: 'main', shared, cache, time: now + 3 }, false));
  });
  check('main transport continuation ignores percentage ceilings but keeps a provider denial', () => {
    const payload = { rateLimits: { primary: { usedPercent: 100 } } };
    assert.equal(transportQuotaBlock({ account: 'main', payload }), null);
    assert.equal(transportQuotaBlock({ account: 'main', payload: { ...payload, ordinaryUsageAllowed: false } }), 'lane provider denied quota');
    assert.equal(transportQuotaBlock({ account: 'other', payload }), 'lane quota exhausted');
  });
  check('simultaneous exhausted turns keep distinct terminal receipts; recovery has no percentage ceiling', () => {
    const shared = path.join(tmp, 'concurrent'); fs.mkdirSync(shared);
    const low = { ...main, windows: [{ ...main.windows[0], used: 70 }] };
    recordMainProviderDenial({ shared, error: denied, observation: low, thread: 'first', turn: 'one', now });
    recordMainProviderDenial({ shared, error: denied, observation: low, thread: 'second', turn: 'two', now: now + 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, 'main-provider-denial.json'))).receipts.map(row => row.thread), ['first', 'second']);
    assert.ok(activeMainProviderDenial({ shared, observation: { ...low, seenAt: now + 2 }, now: now + 2 }));
    assert.equal(activeMainProviderDenial({ shared, observation: { ...low, seenAt: now + 2, windows: [{ ...low.windows[0], used: 0 }] }, now: now + 2 }), null);
  });
  for (const unknownHub of [false, true]) check(`main terminal denial ${unknownHub ? 'does not duplicate an unconfirmed turn' : 'hands completed work to the best company lane immediately'}`, () => {
    const dir = path.join(tmp, `worker-${unknownHub}`), bin = path.join(dir, 'bin'); fs.mkdirSync(bin, { recursive: true });
    for (const executable of ['codex', 'claude']) fs.writeFileSync(path.join(bin, executable), '#!/bin/sh\nprintf \'%s\\n\' \'{"models":[]}\'\n', { mode: 0o755 });
    const profiles = {}, accounts = [{ ...main, home: path.join(dir, 'main') },
      { name: 'trae', kind: 'trae', live: true, healthy: true, models: ['gpt-6.2-sol'], seenAt: now,
        home: path.join(dir, 'trae'), windows: [], load: { 'gpt-6.2-sol': { percent: 10, t: now } },
        quota: { sampledAt: now, daily: { 'gpt-6.2-sol': { used: 1, limit: 80, remaining: 79, depleted: false, resetsAt: now + 3600000 } } } },
      { ...main, name: 'b', home: path.join(dir, 'b'), windows: [{ ...main.windows[0], used: 0 }] }];
    for (const account of accounts) { fs.mkdirSync(account.home); profiles[account.name] = { kind: account.kind, home: account.home, hub: 'ws://127.0.0.1:1' }; }
    const cache = path.join(dir, 'quota.json'), registry = path.join(dir, 'accounts.json'), rpc = path.join(dir, 'rpc.jsonl');
    fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, codexAccounts: accounts, history: {}, errors: {}, claude: null }));
    fs.writeFileSync(registry, JSON.stringify(profiles));
    const routeArgs = ['implement', '--impact', 'service', '--project', 'p', '--name', 'denial', '--cwd', dir, '--task-dir', dir, '--no-local-build'];
    const env = { ...process.env, HOME: dir, CODEX_HOME: accounts[0].home, CODEX_ACCOUNTS: registry, CODEX_HUB: 'ws://127.0.0.1:1',
      RULES_SHARED: dir, QUOTA_CACHE: cache, ROUTE_LOG_FILE: path.join(dir, 'routes.jsonl'), QUOTA_LOG_FILE: path.join(dir, 'empty-quota'),
      ROUTE_NOW: String(now + 1), QUOTA_LOG: '0', ROUTE_SNAPSHOT_FILE: '', TRAE_PROBE: '0', NODE_OPTIONS: '',
      ORCHESTRATOR_OWNER: '', CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '', PATH: `${bin}:${process.env.PATH}`,
      MAIN_DENIAL_FIXTURE: JSON.stringify({ rpc, unknownHub }) };
    const result = spawnSync(process.execPath, ['--import', path.join(scripts, 'test/fixtures/main-provider-denial-transport.mjs'),
      path.join(scripts, 'codex-worker.mjs'), '--account', 'main', 'start', '--cwd', dir, '--project', 'p', '--name', 'denial',
      '--sandbox', 'read-only', '--model', 'gpt-6.2-sol', '--effort', 'high', '--route-args', JSON.stringify(routeArgs),
      '--owner', '053283ad-1bc8-5a31-ad44-d68e6b199eb6', '--out', path.join(dir, 'final.md'), 'Continue scoped fixture work.'],
    { encoding: 'utf8', env, timeout: 20000 });
    assert.equal(result.error, undefined, result.stderr + result.stdout);
    assert.match(result.stdout, /main provider usageLimitExceeded denial/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'main-provider-denial.json'))).code, 'usageLimitExceeded');
    const starts = readRows(rpc).filter(row => row.method === 'turn/start');
    assert.deepEqual(starts.map(row => row.account), unknownHub ? ['main'] : ['main', 'trae'], `worker exit=${result.status}`);
    if (!unknownHub) {
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const recovery = JSON.parse(fs.readFileSync(path.join(dir, 'reroute.json')));
      assert.equal(recovery.route.pick.company, true);
      assert.equal(recovery.route.plan.task.qualityFailures, 0);
      assert.match(recovery.recovery.continuationPrompt, /preserve its completed and uncommitted work/);
      assert.ok(recovery.routeArgs.includes('main'));
    } else assert.equal(result.status, 1);
  });
  console.log(`${count} scenarios passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
