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
const { analyze, now: stateNow } = await import('../lib/state.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = stateNow, h = 3600000, SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6.2-astra';
const ref = 'standing:personal-priority-2026-11-20', owner = '00000000-0000-4000-8000-000000000001';
const fallback = JSON.parse(fs.readFileSync(path.join(root, 'references/personal-fallback.json'), 'utf8'));
const caps = { search: true, vision: true, 'claude-tools': true };
const window = extra => ({ account: 'main', mode: 'exclusive', from: new Date(NOW - 1000).toISOString(), until: null,
  userDecisionRef: ref, quote: 'synthetic user decision: personal overflow on main only until revoked', exhaustAtUsed: 99, revoked: false, ...extra });
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
    for (const extra of [{ mode: 'unknown' }, { account: 'other' }, { from: 'bad' }, { until: 'bad' }, { exhaustAtUsed: 89 }])
      assert.equal(personalPriorityWindow(window(extra)), null);
    assert.ok(activePersonalPriority(window(), NOW + 30 * 24 * h));
    assert.equal(activePersonalPriority(window({ revoked: true }), NOW), null);
    const until = new Date(NOW + h).toISOString();
    assert.ok(activePersonalPriority(window({ until }), NOW));
    assert.equal(activePersonalPriority(window({ until }), NOW + h), null);
  });
  check('by-quota chooses the available weekly capacity per hour until reset', () => {
    const raw = fixture(40);
    raw.personalPriority.account = 'by-quota';
    const [main, b] = raw.accounts;
    assert.equal(run(raw).view.pick.account, 'b');
    b.budget.weekly.used = 40;
    assert.equal(run(raw).view.pick.account, 'main');
    b.budget.weekly.resetsAt -= 24 * h;
    assert.equal(run(raw).view.pick.account, 'b');
    delete b.budget.weekly;
    assert.equal(run(raw).view.pick.account, 'main');
    main.providerDenied = true;
    assert.equal(run(raw).view.pick.account, 'b');
    b.providerDenied = true;
    raw.accounts[2].providerDenied = false;
    assert.equal(run(raw).view.pick.account, 'ttadk');
  });
  check('company headroom wins during exclusive despite main and b headroom and earlier deadlines', () => {
    const raw = fixture(40, true), { plan, snapshot, view } = run(raw);
    assert.equal(plan.kind, 'launch'); assert.equal(plan.primary.candidate.accountId, 'trae');
    assert.equal(validatePlan(plan, snapshot).ok, true);
    assert.match(view.why.join('\n'), /company lanes first; personal overflow/);
    raw.accounts[1].budget.deadline = 167; raw.rotationState = 1;
    assert.equal(run(raw).plan.primary.candidate.accountId, 'trae');
    raw.accounts.find(a => a.id === 'trae').providerDenied = true;
    assert.equal(run(raw).plan.primary.candidate.accountId, 'ttadk');
  });
  check('company quota exhausted uses main as the only personal overflow account', () => {
    const raw = fixture(40), { plan, view, snapshot } = run(raw);
    assert.equal(plan.kind, 'launch'); assert.equal(plan.primary.candidate.accountId, 'main');
    assert.equal(validatePlan(plan, snapshot).ok, true);
    assert.equal(view.pick.approvalRef, ref);
    assert.match(view.why.join('\n'), /company lanes first; personal overflow/);
    raw.accounts[1].budget.deadline = 1;
    assert.equal(run(raw).plan.primary.candidate.accountId, 'main');
  });
  check('ChatGPT-only capability uses main despite healthy company quota and idle b', () => {
    const raw = fixture(0, true), capability = 'chatgpt-only';
    for (const a of raw.accounts) a.capabilities = { ...a.capabilities, [capability]: a.kind === 'chatgpt' };
    for (const m of raw.models) m.capabilities = { ...m.capabilities, [capability]: true };
    for (const l of raw.lanes) l.capabilities = { ...l.capabilities, [capability]: true };
    const t = task({ capabilitiesNeeded: [capability] }), { plan, snapshot } = run(raw, t);
    assert.equal(plan.kind, 'launch'); assert.equal(plan.primary.candidate.accountId, 'main');
    assert.equal(validatePlan(plan, snapshot).ok, true);
    raw.accounts[0].transport = false;
    assert.notEqual(run(raw,t).plan.kind,'launch');
  });
  check('short company queues stay company; queues beyond the standing threshold overflow to main', () => {
    const raw = fixture(0, true);
    raw.accounts.find(a => a.id === 'ttadk').providerDenied = true;
    for (const l of raw.lanes.filter(l => l.accountId === 'trae')) {
      Object.assign(l, { mode: 'low-priority', readyAt: null, position: 5, drainPerMin: 1, queueState: 'queued' });
    }
    assert.equal(run(raw).plan.primary.candidate.accountId, 'main');
    for (const l of raw.lanes.filter(l => l.accountId === 'trae')) l.position = 6;
    assert.equal(run(raw).plan.primary.candidate.accountId, 'main');
  });
  check('W746 infra retry: unavailable company capacity overflows to healthy main, not b', () => {
    const raw = fixture(46, true), companyAstra = 'gpt-6-astra', companySol = 'gpt-6.2-sol';
    const ttadk = raw.accounts.find(a => a.id === 'ttadk');
    ttadk.providerDenied = true;
    const b = raw.accounts.find(a => a.id === 'b');
    Object.assign(b.budget.weekly, { used: 15, projected: 15 });
    const trae = raw.accounts.find(a => a.id === 'trae'), sol = raw.lanes.find(l => l.accountId === 'trae');
    trae.catalog = [companyAstra, companySol];
    raw.models.push({ ...raw.models.find(m => m.id === ASTRA), id: companyAstra },
      { ...raw.models.find(m => m.id === SOL), id: companySol });
    const astra = { ...sol, id: `trae:${companyAstra}`, modelId: companyAstra };
    raw.lanes.push(astra);
    Object.assign(sol, { id: `trae:${companySol}`, modelId: companySol, mode: 'low-priority',
      readyAt: null, loadPercent: null, position: 501, drainPerMin: 0, queueState: 'queued' });
    raw.transportFailures = [1, 2, 3].map(i => ({ t: NOW - i * 60000, account: 'trae', modelId: companyAstra, thread: 'fixture', turn: `turn-${i}` }));
    const retry = task({ category: 'implement-hard', impact: 'service', sandboxCeiling: 'danger-full-access', flags: {
      failures: 2, 'failure-kind': 'infra', 'exclude-account': 'ttadk', 'needs-cli': 'ssh,bytedcli' } });
    const checkOverflow = () => {
      const { plan, snapshot, view } = run(raw, retry);
      assert.equal(plan.task.qualityFailures, 0);
      assert.equal(plan.kind, 'launch'); assert.equal(view.pick.account, 'main');
      assert.equal(view.pick.model, ASTRA); assert.equal(view.pick.effort, 'xhigh');
      assert.equal(view.pick.approvalRef, ref); assert.equal(view.pick.astraApprovalRef, fallback.hardAstraDecisionRef);
      assert.equal(validatePlan(plan, snapshot).ok, true);
      assert.ok(plan.rejected.some(p => p.reason?.code === 'PERSONAL_EXCLUSIVE_ACCOUNT'));
      assert.doesNotMatch(view.tellUser.join('\n'), /personal-main-wait|redeem main card/);
    };
    Object.assign(astra, { readyAt: null, position: 501, drainPerMin: 0, queueState: 'queued' });
    checkOverflow(); // Stalled rows can pass eligibility predicates but cannot serve the retry.
    Object.assign(astra, { readyAt: NOW, position: 0, drainPerMin: 1, queueState: 'ready' });
    Object.assign(sol, { position: null, drainPerMin: null, queueState: null });
    checkOverflow(); // An unmeasured Sol start does not block the approved retry.
    Object.assign(sol, { position: 5, drainPerMin: 1, queueState: 'queued' });
    checkOverflow();
    sol.position = 6;
    checkOverflow();
    Object.assign(sol, { loadPercent: 42, position: 0, queueState: 'ready' });
    const ready = run(raw, retry).view.pick;
    assert.equal(ready.account, 'trae'); assert.equal(ready.model, companySol);
    raw.transportFailures = [];
    assert.equal(run(raw, retry).view.pick.model, companyAstra, 'healthy free Astra still wins');
  });
  check('exactly 5% main headroom launches; insufficient headroom uses an eligible company lane', () => {
    assert.equal(run(fixture(95)).plan.primary.candidate.accountId, 'main');
    const { plan } = run(fixture(96, true));
    assert.equal(plan.kind, 'launch'); assert.ok(['ttadk', 'trae'].includes(plan.primary.candidate.accountId));
  });
  for (const used of [96,99,100]) check(`main ${used}% remains available until provider denial`, () => {
    const raw = fixture(used), {plan,view} = run(raw);
    assert.equal(plan.primary.candidate.accountId,'main');
    assert.ok(!view.tellUser.includes(`main at ${used}% of the week, projected ${raw.accounts[0].budget.weekly.projected}% at reset`));
    raw.accounts[0].providerDenied = true;
    raw.accounts[2].providerDenied = false;
    const fallback = run(raw);
    assert.equal(fallback.view.pick.account,'ttadk');
    raw.accounts[0].transport = false;
    assert.equal(run(raw).view.pick.account,'ttadk');
  });
  check('manual main card redemption changes its reset without ending exclusive mode', () => {
    const raw = fixture(96); assert.equal(run(raw).view.pick.account,'main');
    raw.accounts[0].budget.weekly = { used: 0, projected: 0, resetsAt: NOW + 14 * 24 * h };
    raw.accounts[0].resets.count = 2;
    const resumed = run(raw);
    assert.equal(resumed.plan.primary.candidate.accountId, 'main'); assert.equal(personalPriorityGuard(resumed.snapshot), null);
    raw.personalPriority.until = new Date(NOW + 24 * h).toISOString();
    assert.equal(run(raw).plan.primary.candidate.accountId, 'main', 'explicit until is independent of the new reset');
  });
  check('a reported reset shifting by 1m42s does not pause exclusive or admit b', () => {
    const raw = fixture(3), original = raw.accounts[0].budget.weekly.resetsAt;
    raw.personalPriority.until = new Date(original).toISOString();
    assert.equal(run(raw).plan.primary.candidate.accountId, 'main');
    raw.accounts[0].budget.weekly.resetsAt += 102000;
    const { plan, snapshot, view } = run(raw);
    assert.equal(snapshot.personalPriority.mode, 'exclusive'); assert.equal(personalPriorityGuard(snapshot), null);
    assert.equal(plan.primary.candidate.accountId, 'main'); assert.equal(view.pick.approvalRef, ref);
    assert.ok(!view.why.some(text => text.includes('fresh weekly quota for this reset is unavailable')));
  });
  check('exclusive keeps qualified company alternatives before hard personal Astra overflow', () => {
    const raw = fixture(3, true), companyAstra = 'gpt-6-astra';
    raw.accounts.find(a => a.id === 'trae').catalog.push(companyAstra);
    raw.models.push({ ...raw.models.find(m => m.id === ASTRA), id: companyAstra });
    raw.lanes.push({ ...raw.lanes.find(l => l.accountId === 'trae'), id: `trae:${companyAstra}`,
      modelId: companyAstra, mode: 'low-priority', readyAt: null, position: 501, drainPerMin: 0, queueState: 'queued' });
    const hard = task({ category: 'implement-hard', impact: 'service' }), result = run(raw, hard);
    assert.equal(result.plan.kind, 'launch'); assert.ok(['ttadk', 'trae'].includes(result.view.pick.account));
    for (const a of raw.accounts.filter(a => ['ttadk', 'trae'].includes(a.kind))) a.providerDenied = true;
    const overflow = run(raw, hard);
    assert.equal(overflow.view.pick.account, 'main');
    assert.equal(overflow.view.pick.model, ASTRA); assert.equal(overflow.view.pick.effort, 'xhigh');
    assert.equal(overflow.view.pick.approvalRef, ref);
    assert.match(overflow.view.why.join('\n'), /company lanes first; personal overflow/);
    for (const a of raw.accounts.filter(a => ['ttadk', 'trae'].includes(a.kind))) a.providerDenied = false;
    raw.accounts[0].budget.weekly.used = 96;
    assert.ok(['ttadk', 'trae'].includes(run(raw, hard).view.pick.account));
    for (const a of raw.accounts.filter(a => ['ttadk', 'trae'].includes(a.kind))) a.providerDenied = true;
    assert.equal(run(raw,hard).view.pick.account,'main');
  });
  check('revocation restores normal company selection and Claude-only tools retain their route', () => {
    const raw = fixture(0, true); raw.personalPriority.revoked = true;
    assert.ok(['ttadk', 'trae'].includes(run(raw).plan.primary.candidate.accountId));
    assert.equal(run(fixture(), task({ category: 'claude-tools' })).plan.primary.candidate.accountId, 'claude');
  });
  check('quota summary obeys exclusive even when main has no headroom or a stale reading', () => {
    const data = { checkedAt: NOW, claude: [], history: {}, personalPriority: window(), codexAccounts: ['main', 'b'].map(name => ({
      name, live: true, seenAt: NOW, windows: [{ label: 'week', windowMins: 10080, used: name === 'main' ? 96 : 0, resetsAt: NOW + 168 * h }] })) };
    assert.equal(analyze(data).codex.pick.a.name,'main'); assert.equal(analyze(data).codex.exclusiveWait,false);
    data.codexAccounts[0].windows[0].used = 20;
    assert.equal(analyze(data).codex.pick.a.name, 'main');
    data.codexAccounts[0].observationStale = true;
    assert.equal(analyze(data).codex.pick.a.name,'main');
    data.codexAccounts[0].observationStale = false; data.codexAccounts[0].live = false;
    assert.equal(analyze(data).codex.pick, null);
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
  check('router CLI selects a legacy window account without usage notices', () => {
    const raw = fixture(96), snap = path.join(tmp, 'snapshot.json'), registry = path.join(tmp, 'registry.json');
    fs.writeFileSync(snap, JSON.stringify(raw)); fs.writeFileSync(registry, '{}');
    const env = { ...process.env, ROUTE_SNAPSHOT_FILE: snap, CODEX_ACCOUNTS: registry, QUOTA_CACHE: path.join(tmp, 'quota.json'), ROUTE_LOG_FILE: path.join(tmp, 'route.log') };
    const cli = () => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/route.mjs'), 'analysis', '--json', '--owner', owner], { encoding: 'utf8', env }));
    const result = cli(); assert.equal(result.kind,'launch'); assert.equal(result.pick.account,'main');
    assert.doesNotMatch(result.tellUser.join(' '), /personal-main-90|% of the week/);
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
    assert.equal(first.codexPick, 'main'); assert.equal(first.personalPriorityNotices.length, 0);
    const second = JSON.parse((await exec(process.execPath, [path.join(root, 'scripts/quota.mjs'), '--json'], { env })).stdout);
    assert.deepEqual(second.personalPriorityNotices, []);
    accounts[0].windows[0].used = 96; save();
    const waited = (await exec(process.execPath, [path.join(root, 'scripts/quota.mjs')], { env })).stdout;
    assert.match(waited, /budget:.*codex → main/);
    count++; console.log('PASS quota CLI respects exclusive main without emitting usage notices');
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log(`Personal exclusive scenarios: ${count} passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
