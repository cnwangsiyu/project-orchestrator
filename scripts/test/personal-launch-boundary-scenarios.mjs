#!/usr/bin/env node
// Public policy/quota fixtures and the existing in-memory worker transport only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditLaunch } from '../lib/global-rules.mjs';
import { acquireRoute } from '../lib/route-data.mjs';
import { parseTaskSpec } from '../lib/pipeline/index.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'personal-launch-boundary-')));
const readRows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const policy = () => ({ account: 'main', mode: 'exclusive', from: new Date(Date.now() - 1000).toISOString(), until: null,
  exhaustAtUsed: 99, revoked: false, userDecisionRef: 'standing:personal-priority-boundary', quote: 'synthetic decision: main only' });
function fixture(label, used = 0) {
  const dir = path.join(tmp, label), home = path.join(dir, 'home'), shared = path.join(dir, 'shared');
  fs.mkdirSync(shared, { recursive: true }); fs.mkdirSync(home);
  const profiles = {};
  for (const account of ['main', 'b', 'fixture-peer', 'ttadk']) {
    const accountHome = path.join(home, account); fs.mkdirSync(accountHome);
    profiles[account] = { kind: account === 'ttadk' ? 'ttadk' : 'chatgpt', home: accountHome, hub: 'ws://127.0.0.1:1', modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol' } };
  }
  const registry = path.join(dir, 'accounts.json'), quota = path.join(shared, 'quota.json'), log = path.join(shared, 'route.jsonl');
  const rpc = path.join(dir, 'rpc.jsonl'), windowFile = path.join(shared, 'personal-priority-window.json');
  fs.writeFileSync(registry, JSON.stringify(profiles));
  const now = Date.now(), data = { checkedAt: now, history: {}, codexAccounts: [{ name: 'main', kind: 'chatgpt',
    live: true, loggedIn: true, allowed: true, seenAt: now, models: ['gpt-6.1-sol'],
    windows: [{ label: 'week', used, windowMins: 10080, resetsAt: now + 7 * 86400000 }] }] };
  fs.writeFileSync(quota, JSON.stringify(data));
  const tuple = account => ({ vendor: 'codex', account, company: account === 'ttadk', model: 'gpt-6.1-sol', effort: 'high', sandbox: 'read-only' });
  const route = { t: now - 10000, kind: 'route', name: 'old-worker', project: 'boundary', category: 'analysis',
    executable: true, approvalRef: 'synthetic-previous-approval', pick: tuple('b'), second: tuple('b') };
  fs.writeFileSync(log, JSON.stringify(route) + '\n');
  return { dir, home, shared, profiles, registry, quota, log, rpc, windowFile, data, route, tuple,
    env: { ...process.env, HOME: home, RULES_SHARED: shared, CODEX_ACCOUNTS: registry, QUOTA_CACHE: quota,
      ROUTE_LOG_FILE: log, PERSONAL_FALLBACK_FILE: path.join(dir, 'missing-fallback.json'),
      ORCHESTRATOR_OWNER: '', CODEX_HOME: '', CODEX_HUB: '', NODE_OPTIONS: '', CLAUDECODE: '', CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '' } };
}
function launch(f, account = 'b', { role, cmd = 'start', preload, name = 'old-worker', transport } = {}) {
  const messages = [{ method: 'thread/usage/updated', params: { threadId: 'guard-thread', turnId: 'guard-turn', context: { model: 'GPT-6.1-Sol' } } }];
  const args = [...(preload ? ['--import', preload] : []), path.join(scripts, 'codex-worker.mjs'), '--account', account, cmd,
    ...(cmd === 'start' ? ['--cwd', f.dir, '--sandbox', 'read-only'] : ['--thread', 'guard-thread']),
    '--model', 'gpt-6.1-sol', '--effort', 'high', '--name', name, '--project', 'boundary', ...(role ? ['--role', role] : []), 'Follow the synthetic brief.'];
  const transportFixture = path.join(scripts, 'test/fixtures/worker-guards-transport.mjs');
  const result = spawnSync(process.execPath, args, { env: { ...f.env, NODE_OPTIONS: `--import=${transportFixture}`,
    WORKER_GUARDS_FIXTURE: JSON.stringify({ thread: 'guard-thread', rpc: f.rpc, messages, ...transport }) },
    encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.stderr);
  return { ...result, calls: readRows(f.rpc), records: readRows(f.log) };
}
function exclusiveMain(label, { stale = false, ...fields } = {}) {
  const f = fixture(label);
  f.route.pick = f.tuple('main');
  delete f.data.codexAccounts[0].models; // the default main profile has no saved catalog
  if (stale) f.data.codexAccounts[0].seenAt -= 20 * 60000;
  Object.assign(f.data.codexAccounts[0], fields);
  fs.writeFileSync(f.quota, JSON.stringify(f.data));
  fs.writeFileSync(f.log, JSON.stringify(f.route) + '\n');
  fs.writeFileSync(f.windowFile, JSON.stringify(policy()));
  return f;
}
const readLimits = result => result.calls.filter(c => c.method === 'account/rateLimits/read').length;
function rateLimits(used) {
  return { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: {
    usedPercent: used, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 604800,
  } } };
}
let count = 0;
function check(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
try {
  check('saved b primary route is refused after exclusive activates, before any new-thread RPC', () => {
    const f = fixture('old-primary'); fs.writeFileSync(f.windowFile, JSON.stringify(policy()));
    const r = launch(f);
    assert.equal(r.status, 1); assert.match(r.stderr, /personal-exclusive-launch-refused.*b.*re-route/);
    assert.equal(r.calls.some(c => c.method === 'thread/start'), false);
    assert.ok(r.records.some(row => row.kind === 'launch' && row.blocked && row.admissionReason === 'PERSONAL_EXCLUSIVE_LAUNCH_REFUSED'));
  });
  check('saved second seat and reviewer routes cannot start a new b thread', () => {
    for (const name of ['old-worker-second', 'boundary-old-worker-second']) {
      const f = fixture(name); fs.writeFileSync(f.windowFile, JSON.stringify(policy()));
      const r = launch(f, 'b', { role: 'second', name });
      assert.equal(r.status, 1); assert.match(r.stderr, /re-route/);
      assert.equal(r.calls.some(c => c.method === 'thread/start'), false);
    }
  });
  check('policy activation during hub setup is rechecked immediately before thread/start', () => {
    const f = fixture('activation-during-setup'), preload = path.join(f.dir, 'activate.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs'; const Base=globalThis.WebSocket;
      globalThis.WebSocket=class extends Base { send(raw) {
        if(JSON.parse(raw).method==='initialize') fs.writeFileSync(${JSON.stringify(f.windowFile)},${JSON.stringify(JSON.stringify(policy()))});
        super.send(raw);
      }};`);
    f.route.pick = f.tuple('fixture-peer'); fs.writeFileSync(f.log, JSON.stringify(f.route) + '\n');
    const r = launch(f, 'fixture-peer', { preload });
    assert.ok(r.calls.some(c => c.method === 'initialize'));
    assert.equal(r.status, 1); assert.match(r.stderr, /re-route/);
    assert.equal(r.calls.some(c => c.method === 'thread/start'), false);
  });
  check('existing b thread continuation remains allowed after exclusive activates', () => {
    const f = fixture('continuation'); const before = 0;
    fs.writeFileSync(f.windowFile, JSON.stringify(policy()));
    const resumed = launch(f, 'b', { cmd: 'turn' });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.calls.filter(c => c.method === 'thread/start').length, before);
    assert.ok(resumed.calls.some(c => c.method === 'thread/resume'));
  });
  check('main headroom changing during hub setup is rechecked at thread/start', () => {
    const f = fixture('headroom-during-setup'), preload = path.join(f.dir, 'quota-change.mjs');
    f.route.pick = f.tuple('main'); fs.writeFileSync(f.log, JSON.stringify(f.route) + '\n');
    fs.writeFileSync(f.windowFile, JSON.stringify(policy()));
    const changed = structuredClone(f.data); changed.codexAccounts[0].windows[0].used = 96;
    fs.writeFileSync(preload, `import fs from 'node:fs'; const Base=globalThis.WebSocket;
      globalThis.WebSocket=class extends Base { send(raw) {
        if(JSON.parse(raw).method==='initialize') fs.writeFileSync(${JSON.stringify(f.quota)},${JSON.stringify(JSON.stringify(changed))});
        super.send(raw);
      }};`);
    const r = launch(f, 'main', { preload });
    assert.ok(r.calls.some(c => c.method === 'initialize'));
    assert.equal(r.status, 1); assert.match(r.stderr, /below launch headroom 5%.*re-route/);
    assert.equal(r.calls.some(c => c.method === 'thread/start'), false);
  });
  check('main launches only with fresh current headroom', () => {
    for (const [label, used, want] of [['ready', 95, 0], ['low', 96, 1], ['reset-shift', 3, 0]]) {
      const f = fixture('main-' + label, used); f.route.pick = f.tuple('main');
      const current = policy();
      if (label === 'reset-shift') {
        current.until = new Date(f.data.codexAccounts[0].windows[0].resetsAt).toISOString();
        f.data.codexAccounts[0].windows[0].resetsAt += 102000; fs.writeFileSync(f.quota, JSON.stringify(f.data));
      }
      fs.writeFileSync(f.log, JSON.stringify(f.route) + '\n'); fs.writeFileSync(f.windowFile, JSON.stringify(current));
      const r = launch(f, 'main'); assert.equal(r.status, want, r.stderr);
      assert.equal(readLimits(r), 0);
      assert.equal(r.calls.some(c => c.method === 'thread/start'), want === 0);
      if (want) assert.match(r.stderr, /re-route/);
    }
  });
  check('live routing publishes a new main observation for launch even without a saved model catalog', () => {
    const f = exclusiveMain('route-publishes-main', { stale: true });
    const company = { name: 'ttadk', kind: 'ttadk', live: true, healthy: true, models: ['gpt-6.1-sol'] };
    f.data.codexAccounts.push(company);
    fs.writeFileSync(f.quota, JSON.stringify(f.data));
    const parsed = parseTaskSpec(['analysis', '--name', 'old-worker', '--project', 'boundary'],
      { taskId: 'route-publishes-main', requestId: 'route-publishes-main' });
    acquireRoute(parsed, { env: f.env, root: path.dirname(scripts), readClaude: () => [],
      readAccount: account => {
        assert.equal(account, 'main');
        return { ...f.data.codexAccounts[0], windows: [{ ...f.data.codexAccounts[0].windows[0], used: 20 }] };
      } });
    const cache = JSON.parse(fs.readFileSync(f.quota, 'utf8'));
    assert.equal(cache.checkedAt, f.data.checkedAt);
    assert.deepEqual(cache.codexAccounts.find(a => a.name === 'ttadk'), company);
    assert.equal(cache.codexAccounts.find(a => a.name === 'main').windows[0].used, 20);
    const r = launch(f, 'main');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readLimits(r), 0);
  });
  check('stale main quota refreshes once before starting a thread', () => {
    const f = exclusiveMain('refresh-stale', { stale: true });
    const r = launch(f, 'main', { transport: { rateLimits: rateLimits(10) } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readLimits(r), 1);
    const methods = r.calls.map(c => c.method);
    assert.ok(methods.includes('thread/start'));
    assert.ok(methods.indexOf('account/rateLimits/read') < methods.indexOf('thread/start'));
  });
  check('failed main quota refresh attempts once and keeps the original refusal', () => {
    const f = exclusiveMain('failed-refresh', { stale: true });
    const r = launch(f, 'main', { transport: { rpcFailure: 'account/rateLimits/read' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[personal-exclusive-launch-refused\] fresh main quota and availability telemetry is unavailable \(refresh quota\.mjs --fresh\); re-route/);
    assert.equal(readLimits(r), 1);
    assert.equal(r.calls.some(c => c.method === 'thread/start'), false);
  });
  check('refreshed main quota still has to pass the weekly guard', () => {
    const f = exclusiveMain('refresh-weekly-guard', { stale: true });
    const r = launch(f, 'main', { transport: { rateLimits: rateLimits(96) } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /below launch headroom 5%/);
    assert.equal(readLimits(r), 1);
    assert.equal(r.calls.some(c => c.method === 'thread/start'), false);
  });
  check('logged-out, unhealthy and throttled main refusals do not refresh', () => {
    const cases = [
      ['logged-out', { stale: true, loggedIn: false }, /fresh main quota and availability telemetry is unavailable/],
      ['unhealthy', { stale: true, healthy: false }, /fresh main quota and availability telemetry is unavailable/],
      ['denied', { stale: true, allowed: false }, /fresh main quota and availability telemetry is unavailable/],
      ['throttled', {}, /main short quota window is throttled/],
    ];
    for (const [label, fields, message] of cases) {
      const f = exclusiveMain(label, fields);
      if (label === 'throttled') {
        f.data.codexAccounts[0].windows.push({ used: 95, windowMins: 300, resetsAt: Date.now() + 3600000 });
        fs.writeFileSync(f.quota, JSON.stringify(f.data));
      }
      const r = launch(f, 'main');
      assert.equal(r.status, 1);
      assert.match(r.stderr, message);
      assert.equal(readLimits(r), 0);
      assert.equal(r.calls.some(c => c.method === 'thread/start'), false);
    }
  });
  check('company launches and revoked windows retain normal admission', () => {
    const company = fixture('company'); company.route.pick = company.tuple('ttadk');
    fs.writeFileSync(company.log, JSON.stringify(company.route) + '\n'); fs.writeFileSync(company.windowFile, JSON.stringify(policy()));
    assert.equal(launch(company, 'ttadk').status, 0);
    const revoked = fixture('revoked'); fs.writeFileSync(revoked.windowFile, JSON.stringify({ ...policy(), revoked: true }));
    assert.equal(launch(revoked).status, 1, 'revocation never enables b');
    revoked.route.pick = revoked.tuple('fixture-peer'); fs.writeFileSync(revoked.log, JSON.stringify(revoked.route) + '\n');
    assert.equal(launch(revoked, 'fixture-peer').status, 0);
  });
  check('auditLaunch checks the current window for both roles while continuations remain admitted', () => {
    const f = fixture('audit-api'); fs.writeFileSync(f.windowFile, JSON.stringify(policy()));
    const prior = { RULES_SHARED: process.env.RULES_SHARED, CODEX_ACCOUNTS: process.env.CODEX_ACCOUNTS, QUOTA_CACHE: process.env.QUOTA_CACHE };
    Object.assign(process.env, { RULES_SHARED: f.shared, CODEX_ACCOUNTS: f.registry, QUOTA_CACHE: f.quota });
    try {
      for (const role of ['primary', 'second']) assert.throws(() => auditLaunch({ name: 'old-worker', project: 'boundary',
        account: 'b', model: 'gpt-6.1-sol', effort: 'high', sandbox: 'read-only', role, log: f.log }), /re-route/);
      assert.throws(() => auditLaunch({ name: 'old-worker', project: 'boundary', account: 'b',
        model: 'gpt-6.1-sol', effort: 'high', sandbox: 'read-only', time: f.route.t + 1, log: f.log }), /re-route/);
      assert.ok(auditLaunch({ name: 'old-worker', project: 'boundary', account: 'b', model: 'gpt-6.1-sol',
        effort: 'high', sandbox: 'read-only', continuation: 'guard-thread', log: f.log }));
    } finally { for (const [k, value] of Object.entries(prior)) if (value === undefined) delete process.env[k]; else process.env[k] = value; }
  });
  console.log(`Personal launch boundary scenarios: ${count} passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); }
