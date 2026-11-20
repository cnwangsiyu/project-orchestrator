#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-exclusive-'));
const shared = path.join(tmp, 'shared'); fs.mkdirSync(shared);
Object.assign(process.env, { HOME: tmp, RULES_SHARED: shared, TRAE_PROBE: '0', QUOTA_LOG: '0', ROUTE_LOG: '0', ORCHESTRATOR_OWNER: '' });
const { createTaskSpec, createSnapshot, routePure, renderPlan, validatePlan } = await import('../lib/pipeline/index.mjs');
const { personalPriorityWindow, activePersonalPriority, personalPriorityGuard } = await import('../lib/pipeline/personal-priority.mjs');
const { checkPersonalPriorityNotices } = await import('../lib/personal-priority-notices.mjs');
const { eventLine, readEvents, inbox } = await import('../lib/worker-events.mjs');
const { analyze, now: stateNow } = await import('../lib/state.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = stateNow, h = 3600000, SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6.2-astra';
const ref = 'standing:personal-priority-2026-11-20', owner = '00000000-0000-4000-8000-000000000001';
const fallback = JSON.parse(fs.readFileSync(path.join(root, 'references/personal-fallback.json'), 'utf8'));
const caps = { search: true, vision: true, 'claude-tools': true };
const window = extra => ({ account: 'main', mode: 'exclusive', from: new Date(NOW - 1000).toISOString(), until: null,
  userDecisionRef: ref, quote: 'synthetic user decision: main only until revoked', exhaustAtUsed: 99, revoked: false, ...extra });
const task = extra => createTaskSpec({ category: 'analysis', taskId: 'W-main', requestId: 'W-main-request', ...extra });
function fixture(used = 0, companyReady = false) {
  const accounts = [['main', 'chatgpt', [SOL, ASTRA]], ['b', 'chatgpt', [SOL, ASTRA]],
    ['ttadk', 'ttadk', [SOL]], ['trae', 'trae', [SOL]], ['claude', 'claude', ['sonnet', 'opus']]];
  return { decisionAt: NOW, collectedFrom: NOW, collectedThrough: NOW, personalPriority: window(), personalFallback: fallback,
    resources: { held: false, ownedReturned: true }, dependencies: [], approvals: [], health: [],
    accounts: accounts.map(([id, kind, catalog]) => ({ id, kind, catalog, auth: true, transport: true, health: true,
      capabilities: caps, providerDenied: ['ttadk', 'trae'].includes(kind) && !companyReady, denialResetAt: NOW + h,
      resets: { count: 3 }, budget: { underused: false, deadline: id === 'main' ? 168 : 100,
        weekly: { used: id === 'main' ? used : 0, projected: id === 'main' ? used : 0, resetsAt: NOW + 168 * h } } })),
    models: [...new Set(accounts.flatMap(a => a[2]))].map(id => ({ id, efforts: ['medium', 'high', 'xhigh', 'max'], capabilities: caps, largeOutput: true })),
    lanes: accounts.flatMap(([id, kind, catalog]) => catalog.map(modelId => ({ id: `${id}:${modelId}`, accountId: id, modelId,
      harness: kind === 'claude' ? 'claude-bg' : 'hub', efforts: ['medium', 'high', 'xhigh', 'max'], mode: kind === 'trae' ? 'priority' : 'standard',
      selectable: true, readyAt: NOW, position: 0, drainPerMin: 1, queueState: 'ready', loadPercent: 10, loadSource: 'model', capabilities: caps }))) };
}
function run(raw, t = task()) {
  const snapshot = createSnapshot(raw), plan = routePure(t, snapshot);
  return { snapshot, plan, view: renderPlan(plan, { snapshot, root, profiles: {}, owner }) };
}
let count = 0;
function check(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
try {
  check('exclusive accepts open-ended/account-bound windows; prefer-first still needs explicit expiry', () => {
    assert.equal(personalPriorityWindow(window()).until, null);
    assert.equal(personalPriorityWindow(window({ mode: 'prefer-first' })), null);
    for (const extra of [{ mode: 'unknown' }, { account: 'b' }, { from: 'bad' }, { until: 'bad' }, { exhaustAtUsed: 89 }])
      assert.equal(personalPriorityWindow(window(extra)), null);
    assert.ok(activePersonalPriority(window(), NOW + 30 * 24 * h));
    assert.equal(activePersonalPriority(window({ revoked: true }), NOW), null);
    const until = new Date(NOW + h).toISOString();
    assert.ok(activePersonalPriority(window({ until }), NOW));
    assert.equal(activePersonalPriority(window({ until }), NOW + h), null);
  });
  check('exclusive wins over healthy company lanes, b headroom and earlier deadline', () => {
    const raw = fixture(40, true), { plan, snapshot } = run(raw);
    assert.equal(plan.kind, 'launch'); assert.equal(plan.primary.candidate.accountId, 'main');
    assert.equal(validatePlan(plan, snapshot).ok, true);
    raw.accounts[1].budget.deadline = 167; raw.rotationState = 1;
    assert.equal(run(raw).plan.primary.candidate.accountId, 'main');
  });
  check('exactly 5% main headroom launches; insufficient headroom uses an eligible company lane', () => {
    assert.equal(run(fixture(95)).plan.primary.candidate.accountId, 'main');
    const { plan } = run(fixture(96, true));
    assert.equal(plan.kind, 'launch'); assert.ok(['ttadk', 'trae'].includes(plan.primary.candidate.accountId));
  });
  for (const used of [96, 99, 100]) check(`main ${used}% with company unavailable waits, despite idle b and Claude`, () => {
    const { plan, view } = run(fixture(used));
    assert.equal(plan.kind, 'defer'); assert.equal(plan.trigger, 'personal-main-capacity');
    assert.equal(plan.reason.text, `[personal-main-wait] main ${used}%: W-main waiting (redeem main card?)`);
    assert.equal(view.pick, null); assert.deepEqual(view.needsUserOK, []);
    assert.ok(view.tellUser.includes(plan.reason.text));
  });
  check('hard Astra, excluded main and unavailable main transport never select b', () => {
    const raw = fixture(96), hard = task({ category: 'implement-hard', impact: 'service' });
    assert.equal(run(raw, hard).plan.trigger, 'personal-main-capacity');
    assert.equal(run(fixture(), task({ flags: { 'exclude-account': 'main' } })).plan.trigger, 'personal-main-capacity');
    raw.accounts[0].budget.weekly.used = 0; raw.accounts[0].transport = false;
    assert.equal(run(raw).plan.trigger, 'personal-main-capacity');
    raw.accounts[2].providerDenied = false;
    assert.equal(run(raw).plan.primary.candidate.accountId, 'ttadk');
    const unknown = fixture(); unknown.accounts[0].kind = 'unknown';
    assert.equal(run(unknown).plan.trigger, 'personal-main-capacity');
  });
  check('fresh guard refuses stale telemetry without consuming the main-only restriction', () => {
    const raw = fixture(10);
    raw.accounts[0].budget = { status: 'KNOWN', value: raw.accounts[0].budget, sampledAt: NOW - 20 * 60000,
      receivedAt: NOW, maxAgeMs: 600000, source: 'last-good-stale' };
    const { plan, snapshot } = run(raw);
    assert.match(personalPriorityGuard(snapshot), /fresh weekly quota/);
    assert.equal(plan.trigger, 'personal-main-capacity');
  });
  check('manual main card redemption changes its reset without ending exclusive mode', () => {
    const raw = fixture(96); assert.equal(run(raw).plan.trigger, 'personal-main-capacity');
    raw.accounts[0].budget.weekly = { used: 0, projected: 0, resetsAt: NOW + 14 * 24 * h };
    raw.accounts[0].resets.count = 2;
    const resumed = run(raw);
    assert.equal(resumed.plan.primary.candidate.accountId, 'main'); assert.equal(personalPriorityGuard(resumed.snapshot), null);
    raw.personalPriority.until = new Date(NOW + 24 * h).toISOString();
    assert.equal(run(raw).plan.primary.candidate.accountId, 'main', 'explicit until is independent of the new reset');
  });
  check('revocation restores normal company selection and Claude-only tools retain their route', () => {
    const raw = fixture(0, true); raw.personalPriority.revoked = true;
    assert.ok(['ttadk', 'trae'].includes(run(raw).plan.primary.candidate.accountId));
    assert.equal(run(fixture(), task({ category: 'claude-tools' })).plan.primary.candidate.accountId, 'claude');
  });
  check('quota summary obeys exclusive even when main has no headroom or a stale reading', () => {
    const data = { checkedAt: NOW, claude: [], history: {}, personalPriority: window(), codexAccounts: ['main', 'b'].map(name => ({
      name, live: true, seenAt: NOW, windows: [{ label: 'week', windowMins: 10080, used: name === 'main' ? 96 : 0, resetsAt: NOW + 168 * h }] })) };
    assert.equal(analyze(data).codex.pick, null); assert.equal(analyze(data).codex.exclusiveWait, true);
    data.codexAccounts[0].windows[0].used = 20;
    assert.equal(analyze(data).codex.pick.a.name, 'main');
    data.codexAccounts[0].observationStale = true;
    assert.equal(analyze(data).codex.pick, null);
    data.codexAccounts[0].observationStale = false; data.codexAccounts[0].live = false;
    assert.equal(analyze(data).codex.pick, null);
  });
  check('90% notice is once per reset window across owners, and reopens after a manual reset', () => {
    const file = path.join(tmp, 'notices.json'), rows = [], emit = row => { rows.push(row); return row; };
    function notify(used, extra = {}) { const { snapshot, plan } = run(fixture(used));
      return checkPersonalPriorityNotices({ snapshot, plan, task: task(), owner, file, emit, ...extra }); }
    assert.deepEqual(notify(89), []); assert.equal(notify(90).length, 1);
    assert.equal(rows[0].text, `[personal-main-90] main 90% used, resets ${new Date(NOW + 168 * h).toISOString()}, cards 3`);
    assert.deepEqual(notify(91, { owner: 'another-fixture-owner' }), []);
    const raw = fixture(90); raw.accounts[0].budget.weekly.resetsAt += 7 * 24 * h; raw.accounts[0].resets.count = 2;
    const { snapshot, plan } = run(raw);
    assert.equal(checkPersonalPriorityNotices({ snapshot, plan, task: task(), owner, file, emit }).length, 1);
    assert.equal(rows.length, 2);
    assert.match(rows[1].text, /cards 2$/);
    assert.equal(eventLine({ ...rows[0], event: 'message' }), rows[0].text);
  });
  check('wait notices preserve the exact tag/text, deduplicate the task, and dry/missing-owner calls consume nothing', () => {
    const { snapshot, plan } = run(fixture(96)), file = path.join(tmp, 'wait-notices.json'), rows = [], emit = row => { rows.push(row); return row; };
    const args = { snapshot, plan, task: task(), owner, file, emit };
    assert.deepEqual(checkPersonalPriorityNotices({ ...args, dry: true }), []);
    assert.deepEqual(checkPersonalPriorityNotices({ ...args, owner: null }), []); assert.equal(fs.existsSync(file), false);
    assert.equal(checkPersonalPriorityNotices(args).length, 2); assert.equal(checkPersonalPriorityNotices(args).length, 0);
    const wait = rows.find(r => r.kind === 'personal-main-wait');
    assert.equal(eventLine(wait), plan.reason.text);
    assert.equal(checkPersonalPriorityNotices({ ...args, task: task({ taskId: 'W-next' }),
      plan: run(fixture(96), task({ taskId: 'W-next' })).plan }).length, 1);
  });
  check('stale usage cannot consume the 90% notice; a later fresh reading delivers it', () => {
    const raw = fixture(90), file = path.join(tmp, 'stale-notices.json'), rows = [], emit = row => { rows.push(row); return row; };
    raw.accounts[0].budget = { status: 'KNOWN', value: raw.accounts[0].budget, sampledAt: NOW, receivedAt: NOW,
      source: 'last-good-stale' };
    let result = run(raw);
    checkPersonalPriorityNotices({ ...result, task: task(), owner, file, emit });
    assert.equal(rows.some(row => row.kind === 'personal-main-90'), false);
    raw.accounts[0].budget.source = 'public-status-cache'; result = run(raw);
    checkPersonalPriorityNotices({ ...result, task: task(), owner, file, emit });
    assert.equal(rows.filter(row => row.kind === 'personal-main-90').length, 1);
  });
  check('CLI adds/inspects/revokes exclusive mode and keeps legacy prefer-first syntax', () => {
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/personal-priority.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }));
    const from = new Date(NOW - 1000).toISOString(), until = new Date(NOW + h).toISOString();
    const added = cli('add', from, 'none', ref, 'synthetic main-only decision', '--mode', 'exclusive', '--exhaust-at-used', '99');
    assert.equal(added.until, null); assert.equal(cli('inspect').window.mode, 'exclusive'); assert.equal(cli('inspect').active, true);
    cli('revoke', ref); assert.equal(cli('inspect').active, false);
    assert.equal(cli('add', from, until, ref, 'synthetic main-first decision').mode, 'prefer-first');
    const file = path.join(shared, 'personal-priority-window.json'), before = fs.readFileSync(file, 'utf8');
    assert.throws(() => cli('add', from, 'none', ref, 'synthetic main-only decision', '--mode', 'exclusive'), /Command failed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.throws(() => cli('add', from, 'none', 'standing:personal-priority-other', 'synthetic main-only decision', '--mode', 'exclusive', '--replace'), /Command failed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(cli('add', from, 'none', ref, 'synthetic main-only decision', '--mode', 'exclusive', '--replace').mode, 'exclusive');
    assert.equal(cli('inspect').active, true); assert.equal(cli('inspect').window.until, null);
    cli('revoke', ref);
  });
  check('router CLI emits durable main notices and never launches b while exclusive waits', () => {
    const raw = fixture(96), snap = path.join(tmp, 'snapshot.json'), registry = path.join(tmp, 'registry.json');
    fs.writeFileSync(snap, JSON.stringify(raw)); fs.writeFileSync(registry, '{}');
    const env = { ...process.env, ROUTE_SNAPSHOT_FILE: snap, CODEX_ACCOUNTS: registry, QUOTA_CACHE: path.join(tmp, 'quota.json'), ROUTE_LOG_FILE: path.join(tmp, 'route.log') };
    const cli = () => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/route.mjs'), 'analysis', '--json', '--owner', owner], { encoding: 'utf8', env }));
    const result = cli(); assert.equal(result.kind, 'defer'); assert.equal(result.pick, null);
    assert.ok(result.tellUser.some(text => text.startsWith('[personal-main-90]')));
    assert.ok(result.tellUser.includes('[personal-main-wait] main 96%: unnamed-task waiting (redeem main card?)'));
    cli(); const events = readEvents().filter(row => row.kind?.startsWith('personal-main-'));
    assert.equal(events.filter(row => row.kind === 'personal-main-90').length, 1);
    assert.equal(events.filter(row => row.kind === 'personal-main-wait').length, 1);
    assert.equal(inbox(events, owner).pending.length, 2);
    assert.ok(inbox(events, owner).pending.every(row => eventLine(row).startsWith(`[${row.kind}] `)));
  });
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  server.on('upgrade', (req, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = Date.now(), reset = at + 169 * h, hub = `ws://127.0.0.1:${server.address().port}`;
    const accounts = ['main', 'b'].map(name => {
      const home = path.join(tmp, name); fs.mkdirSync(home);
      return { name, home, hub, live: true, loggedIn: true, seenAt: at, models: [SOL], resets: { count: 3, credits: [1, 2, 3].map(id => ({ id: `${name}-${id}`, expiresAt: reset + 24 * h })) },
        windows: [{ label: 'week', windowMins: 10080, used: name === 'main' ? 90 : 0, resetsAt: reset }] };
    });
    const cache = path.join(tmp, 'quota-cli.json'), registry = path.join(tmp, 'quota-registry.json');
    fs.writeFileSync(registry, JSON.stringify(Object.fromEntries(accounts.map(a => [a.name, { home: a.home, hub }]))));
    fs.writeFileSync(path.join(shared, 'personal-priority-window.json'), JSON.stringify(window()));
    const env = { ...process.env, QUOTA_CACHE: cache, CODEX_ACCOUNTS: registry, ORCHESTRATOR_OWNER: owner,
      QUOTA_LOG_FILE: path.join(tmp, 'quota.log') };
    const exec = promisify(execFile), save = () => fs.writeFileSync(cache, JSON.stringify({ checkedAt: at, codexAccounts: accounts, claude: [], history: {}, errors: {} }));
    save();
    const first = JSON.parse((await exec(process.execPath, [path.join(root, 'scripts/quota.mjs'), '--json'], { env })).stdout);
    assert.equal(first.codexPick, 'main'); assert.equal(first.personalPriorityNotices.length, 1);
    assert.match(first.personalPriorityNotices[0], /\[personal-main-90\] main 90% used, resets .*cards 3/);
    const second = JSON.parse((await exec(process.execPath, [path.join(root, 'scripts/quota.mjs'), '--json'], { env })).stdout);
    assert.deepEqual(second.personalPriorityNotices, []);
    accounts[0].windows[0].used = 96; save();
    const waited = (await exec(process.execPath, [path.join(root, 'scripts/quota.mjs')], { env })).stdout;
    assert.match(waited, /budget:.*codex → wait main/);
    count++; console.log('PASS quota CLI respects exclusive main and delivers the 90% notice only once');
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log(`Personal exclusive scenarios: ${count} passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
