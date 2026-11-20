#!/usr/bin/env node
// Scratch quota/account metadata and loopback health probes only; no real hubs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-launch-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shared = path.join(tmp, 'shared'), h = 3600000, now = Date.now(), ASTRA = 'gpt-6.2-astra';
fs.mkdirSync(shared);
// Set before importing state: every incidental state read stays in this fixture.
Object.assign(process.env, { HOME: tmp, RULES_SHARED: shared, TRAE_PROBE: '0', QUOTA_LOG: '0', ROUTE_LOG: '0' });
const { analyze, leanLines, POLICY } = await import('../lib/state.mjs');
const { personalLaunchChoice } = await import('../lib/personal-launch.mjs');
const { acquireRoute } = await import('../lib/route-data.mjs');
const { createTaskSpec, createSnapshot, routePure, renderPlan } = await import('../lib/pipeline/index.mjs');
const exec = promisify(execFile);
const cache = path.join(shared, 'quota.json'), registry = path.join(shared, 'codex-accounts.json');
const env = { ...process.env, QUOTA_CACHE: cache, CODEX_ACCOUNTS: registry,
  QUOTA_LOG_FILE: path.join(tmp, 'quota.log'), ROUTE_LOG_FILE: path.join(tmp, 'route.log'),
  ROUTE_RR: path.join(tmp, 'rotation.txt'), ORCHESTRATOR_OWNER: '' };
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
server.on('upgrade', (req, socket) => socket.destroy());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const hub = `ws://127.0.0.1:${server.address().port}`;
function account(name, used, left, extra = {}) {
  const home = path.join(tmp, name); fs.mkdirSync(home, { recursive: true });
  return { name, home, hub, live: true, loggedIn: true, seenAt: now, models: [ASTRA],
    windows: [{ label: 'week', windowMins: 10080, used, resetsAt: now + left * h }],
    resets: { count: 3, credits: [1, 2, 3].map(id => ({ id: `${name}-${id}`, expiresAt: now + 30 * 24 * h })) }, ...extra };
}
function data(b = 98, main = 0, options = {}) {
  const d = { checkedAt: now, claude: [], history: {}, errors: {},
    codexAccounts: [account('b', b, options.bLeft ?? 110, options.b), account('main', main, options.mainLeft ?? 168, options.main)] };
  fs.writeFileSync(cache, JSON.stringify(d));
  fs.writeFileSync(registry, JSON.stringify(Object.fromEntries(d.codexAccounts.map(a => [a.name, { home: a.home, hub, models: a.models }]))));
  return d;
}
function route(d, rotation = 0) {
  fs.writeFileSync(cache, JSON.stringify(d)); fs.writeFileSync(env.ROUTE_RR, String(rotation));
  const context = acquireRoute(createTaskSpec({ category: 'implement-hard', impact: 'service', taskId: 'launch-fixture', requestId: 'launch-fixture' }),
    { root, env: { ...env, ROUTE_NOW: String(now) }, now });
  context.snapshot = createSnapshot({ ...context.snapshot, rotationState: rotation }, { now });
  const plan = routePure(context.task, context.snapshot);
  return renderPlan(plan, context);
}
let count = 0;
function check(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
try {
  assert.equal(POLICY.launchHeadroom, 5);
  assert.equal(POLICY.deadlineTieH, 6);
  for (const [label, b, main, want] of [['98/0', 98, 0, 'main'], ['90/0', 90, 0, 'b'], ['95/0 boundary', 95, 0, 'b'],
    ['both low, main has more', 98, 96, 'main'], ['both low, b has more', 96, 98, 'b']]) {
    check(`${label}: quota and hard Astra launch choose ${want}`, () => {
      const d = data(b, main), st = analyze(d), r = route(d);
      assert.equal(st.codex.pick.a.name, want); assert.equal(r.kind, 'launch');
      assert.equal(r.pick.account, want); assert.equal(r.pick.model, ASTRA); assert.equal(r.pick.effort, 'xhigh');
      assert.equal(st.codex.redeem, null); assert.deepEqual(r.needsUserOK, []);
      if (b > 95) {
        assert.match(r.why.join('\n'), /b 9[68]% used: below launch headroom 5%/);
        assert.match(leanLines(st, d).join('\n'), /below launch headroom 5%/);
      }
    });
  }
  check('stale high-use reading with a reachable hub still reserves launch headroom', () => {
    const d = data(98, 0, { b: { observationStale: true, seenAt: now - 20 * 60000 } });
    // Refresh-independent public transport/catalog evidence; stale weekly usage remains restrictive.
    assert.equal(analyze(d).codex.pick.a.name, 'main');
    assert.equal(route(d).pick.account, 'main');
  });
  check('main hub unreachable: b remains usable and explains its low headroom', () => {
    const d = data(98, 0, { main: { live: false } }), st = analyze(d), r = route(d);
    assert.equal(st.codex.pick.a.name, 'b'); assert.equal(r.pick.account, 'b');
    assert.match(r.why.join('\n'), /below launch headroom 5%.*no usable account.*most remaining.*-> b/);
  });
  check('company-device hard Astra fallback also switches from b to main', () => {
    const d = data();
    for (const name of ['ttadk', 'trae']) d.codexAccounts.push(account(name, 0, 168, {
      kind: name, healthy: false, reason: 'fixture quota depleted',
      quotaOut: { resetsAt: now + h, reason: 'fixture quota depleted' },
    }));
    const r = route(d);
    assert.equal(r.kind, 'launch'); assert.equal(r.pick.account, 'main');
    assert.equal(r.pick.model, ASTRA); assert.equal(r.pick.effort, 'xhigh');
    assert.match(r.why.join('\n'), /b 98% used: below launch headroom 5%.*-> main/);
    assert.deepEqual(r.needsUserOK, []);
  });
  check('fresh weekly resets one minute apart alternate as used share changes', () => {
    const d = data(0, 0, { bLeft: 168, mainLeft: 168 + 1 / 60 });
    d.codexAccounts[0].resets.count = 2;
    d.codexAccounts[0].resets.credits.pop();
    for (const [b, main, want] of [[0, 0, 'b'], [1, 0, 'main'], [1, 2, 'b']]) {
      d.codexAccounts[0].windows[0].used = b; d.codexAccounts[1].windows[0].used = main;
      assert.equal(analyze(d).codex.pick.a.name, want); assert.equal(route(d).pick.account, want);
      assert.match(route(d).why.join('\n'), /deadlines within 6h/);
    }
    assert.equal(d.codexAccounts[0].resets.count, 2); assert.equal(d.codexAccounts[1].resets.count, 3);
  });
  check('one-hour deadline tie spends main 10% before b 40%, including imminent resets', () => {
    for (const left of [20, 110]) {
      const d = data(40, 10, { bLeft: left, mainLeft: left + 1 });
      assert.equal(analyze(d).codex.pick.a.name, 'main'); assert.equal(analyze(d).codex.rotate, null);
      assert.equal(route(d, 0).pick.account, 'main'); assert.equal(route(d, 1).pick.account, 'main');
    }
  });
  check('six-hour tie boundary is inclusive; wider deadlines retain earliest-first order', () => {
    for (const [gap, want] of [[6, 'main'], [6.01, 'b'], [48, 'b']]) {
      const d = data(40, 10, { bLeft: 110, mainLeft: 110 + gap });
      assert.equal(analyze(d).codex.pick.a.name, want); assert.equal(route(d).pick.account, want);
    }
  });
  check('equal-usage ties prefer live hub, then name; tie groups do not chain past six hours', () => {
    const a = { id: 'b', used: 0, deadline: 100, live: false }, b = { id: 'main', used: 0, deadline: 100.01, live: true };
    assert.equal(personalLaunchChoice([a, b]).pick.id, 'main');
    a.live = true; assert.equal(personalLaunchChoice([b, a]).pick.id, 'b');
    const rows = [{ id: 'a', used: 80, deadline: 100, live: true }, { id: 'b', used: 20, deadline: 105, live: true },
      { id: 'c', used: 0, deadline: 110, live: true }];
    for (const input of [rows, [...rows].reverse(), [rows[1], rows[2], rows[0]]]) assert.equal(personalLaunchChoice(input).pick.id, 'b');
  });
  check('imminent reset rotation balances tie groups without choosing the higher-used member', () => {
    const d = data(40, 10, { bLeft: 20, mainLeft: 21 });
    d.codexAccounts.push(account('c', 20, 40));
    assert.deepEqual(analyze(d).codex.rotate.map(r => r.a.name), ['main', 'c']);
    assert.equal(route(d, 0).pick.account, 'main'); assert.equal(route(d, 1).pick.account, 'c');
  });
  check('two deadlines below 48h still rotate among accounts with headroom', () => {
    const d = data(90, 20, { bLeft: 20, mainLeft: 30 });
    assert.deepEqual(analyze(d).codex.rotate.map(r => r.a.name), ['b', 'main']);
    assert.equal(route(d, 0).pick.account, 'b'); assert.equal(route(d, 1).pick.account, 'main');
  });
  check('rotation excludes low headroom; all-low rotation uses most remaining', () => {
    for (const [b, main] of [[98, 20], [98, 96]]) {
      const d = data(b, main, { bLeft: 20, mainLeft: 30 });
      assert.equal(analyze(d).codex.rotate, null);
      assert.equal(route(d, 0).pick.account, 'main'); assert.equal(route(d, 1).pick.account, 'main');
    }
  });
  check('spent accounts retain card suggestions and never redeem automatically', () => {
    const d = data(99, 100), st = analyze(d), r = route(d);
    assert.equal(st.codex.pick, null); assert.ok(st.codex.redeem);
    assert.notEqual(r.kind, 'launch'); assert.ok(r.needsUserOK.some(s => /redeem|reset/i.test(s)));
  });
  const d = data();
  const quota = await exec(process.execPath, [path.join(root, 'scripts/quota.mjs')], { env, maxBuffer: 2 ** 20 });
  assert.match(quota.stdout, /budget:.*codex → main/);
  assert.match(quota.stdout, /b 98% used: below launch headroom 5%.*-> main/);
  count++; console.log('PASS quota CLI summary agrees with the hard personal launch');
  fs.writeFileSync(cache, JSON.stringify(d));
  const cli = await exec(process.execPath, [path.join(root, 'scripts/route.mjs'), 'implement-hard', '--impact', 'service', '--json'],
    { env: { ...env, ROUTE_NOW: String(now) }, maxBuffer: 2 ** 20 });
  const routed = JSON.parse(cli.stdout); assert.equal(routed.pick.account, 'main');
  assert.match(routed.why.join('\n'), /below launch headroom 5%.*-> main/);
  count++; console.log('PASS router CLI applies headroom on a new nondry launch');
  console.log(`Personal launch scenarios: ${count} passed`);
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
