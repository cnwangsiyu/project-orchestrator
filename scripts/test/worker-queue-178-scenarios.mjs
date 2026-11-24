#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTaskSpec, createSnapshot, routePure, validatePlan } from '../lib/pipeline/index.mjs';
import { eventLine, hookEventLine } from '../lib/worker-events.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-queue-178-'));
const source = JSON.parse(fs.readFileSync(new URL('./fixtures/free-trae-fresh-ttadk-2026-11-15.json', import.meta.url), 'utf8'));
const ASTRA = 'gpt-6-astra', SOL = 'gpt-6.1-sol';
const policy = { enabled: true, since: '2026-11-14', userDecisionRef: 'standing:personal-fallback-2026-11-14',
  queueWaitMinutes: 5, allowHardPersonalAstra: true, hardAstraDecisionRef: 'standing:hard-astra-2026-11-14' };
const fixture = ({ astraQuotaAvailable = false } = {}) => {
  const raw = structuredClone(source); raw.personalFallback = policy;
  const lane = raw.lanes.find(lane => lane.accountId === 'trae' && lane.modelId === ASTRA);
  if (astraQuotaAvailable) {
    // Isolate unknown catalog/health/queue evidence from a positive daily limit.
    const bucket = raw.accounts.find(a => a.id === 'trae').quota.find(q => q.bucketId === ASTRA);
    Object.assign(bucket.usage.value, { used: 1, remaining: bucket.usage.value.limit - 1, depleted: false });
    bucket.priority.value = 'available';
    lane.mode = lane.modeEvidence.value = 'priority';
  }
  lane.readyAt.value = null; lane.position.value = 1399; lane.drainPerMin.value = 0;
  lane.queueState.value = 'waiting'; lane.progressAt.value = null;
  return raw;
};
const task = (model = ASTRA, effort = 'xhigh', excluded = false) => createTaskSpec({ category: 'implement-hard', impact: 'service',
  taskId: 'bc178', requestId: 'bc178', failures: 1, flags: excluded ? { 'exclude-account': 'trae,ttadk' } : {},
  previousAttempts: [{ id: 'actual', taskId: 'bc178', role: 'primary', state: 'failed', failureKind: 'quality',
    actualStatus: 'KNOWN', actual: { accountId: 'trae', modelId: model, effort } }] });
let active;
try {
  for (const model of [SOL, ASTRA]) for (const excluded of [false, true]) for (const failures of [1, 9]) {
    const scopedTask = structuredClone(task(model, 'xhigh', excluded)); scopedTask.qualityFailures = failures;
    const snapshot = createSnapshot(fixture()), plan = routePure(scopedTask, snapshot);
    assert.equal(plan.kind, 'launch'); assert.equal(plan.primary.candidate.accountId, 'b');
    assert.equal(plan.primary.candidate.modelId, ASTRA); assert.equal(plan.primary.candidate.effort, 'xhigh');
    assert.equal(plan.primary.personalFallback.maxUnavailable, true);
    assert.match(plan.primary.personalFallback.text, /max was unavailable.*xhigh on personal Astra instead/);
    assert.ok(plan.primary.personalFallback.alternatives.some(lane => lane.account === 'trae' && lane.effort === 'max' && lane.position === 1399));
    assert.equal(validatePlan(plan, snapshot).ok, true);
    const personalMax = plan.trace.candidates.filter(row => ['main', 'b'].includes(row.candidate.accountId) && row.candidate.effort === 'max');
    assert.ok(personalMax.every(row => row.predicates.some(predicate => predicate.gates?.some(gate => gate.kind === 'max-effort'))));
  }
  console.log('PASS BC-178: escalated max with stalled company Astra uses approved personal xhigh, including excluded-company retry; max remains gated');

  for (const variant of ['unknown-status', 'unknown-catalog', 'unknown-account-kind', 'missing-advertised-astra-lane']) {
    const raw = fixture({ astraQuotaAvailable: true });
    if (variant === 'unknown-status') raw.accounts.find(account => account.id === 'trae').auth.status = 'UNKNOWN';
    if (variant === 'unknown-catalog') raw.accounts.find(account => account.id === 'ttadk').catalog.status = 'UNKNOWN';
    if (variant === 'unknown-account-kind') {
      const account = raw.accounts.find(account => account.id === 'ttadk');
      account.kind = 'UNKNOWN'; account.catalog.status = 'UNKNOWN';
    }
    if (variant === 'missing-advertised-astra-lane') raw.accounts.find(account => account.id === 'ttadk').catalog.value.push(ASTRA);
    const plan = routePure(task(), createSnapshot(raw));
    assert.equal(plan.kind, 'blocked', variant);
    assert.ok(plan.trace.candidates.filter(row => ['main', 'b'].includes(row.candidate.accountId))
      .every(row => !row.predicates.find(predicate => predicate.ruleId === 'pScopedApproval')?.personalFallback?.maxUnavailable), variant);
  }
  console.log('PASS unresolved company status/catalog and a missing advertised Astra lane stay blocked; no quality-repeat exemption');
  for (const field of ['auth', 'transport', 'health', 'catalog']) {
    const raw = fixture({ astraQuotaAvailable: true }); raw.accounts.find(account => account.id === 'trae')[field].source = 'last-good-stale';
    assert.equal(routePure(task(), createSnapshot(raw)).kind, 'blocked', field);
  }
  console.log('PASS last-good-stale account or catalog observations cannot attest current company capacity');
  for (const source of ['unreadable recent-turn queue metadata', 'unreadable recent-turn health metadata']) {
    const raw = fixture({ astraQuotaAvailable: true }), lane = raw.lanes.find(lane => lane.accountId === 'trae' && lane.modelId === ASTRA);
    lane.position.value = null; lane.queueState.value = null; lane.drainPerMin.value = null;
    lane.recentQueue = { status: 'KNOWN', value: { blocked: true, sources: [source] }, source: 'recent-turn-summary',
      sampledAt: raw.decisionAt, receivedAt: raw.decisionAt, maxAgeMs: 1800000 };
    const plan = routePure(task(), createSnapshot(raw));
    assert.equal(plan.kind, 'launch'); assert.equal(plan.primary.candidate.accountId, 'trae');
    assert.equal(plan.primary.candidate.effort, 'max');
  }
  console.log('PASS unreadable queue or health metadata cannot prove a company stall or enable personal quota');

  const available = structuredClone(source); available.personalFallback = policy;
  const ready = routePure(task(), createSnapshot(available));
  assert.equal(ready.primary.candidate.accountId, 'trae'); assert.equal(ready.primary.candidate.effort, 'max');
  const fast = fixture(), fastLane = fast.lanes.find(lane => lane.accountId === 'trae' && lane.modelId === ASTRA);
  fastLane.position.value = 1; fastLane.drainPerMin.value = 100; fastLane.progressAt.value = fast.decisionAt;
  const draining = routePure(task(), createSnapshot(fast));
  assert.equal(draining.primary.candidate.accountId, 'trae'); assert.equal(draining.primary.candidate.effort, 'max');
  const denied = structuredClone(available); denied.accounts.find(account => account.id === 'trae').providerDenied.value = true;
  const unavailableProvider = routePure(task(), createSnapshot(denied));
  assert.equal(unavailableProvider.primary.candidate.accountId, 'b'); assert.equal(unavailableProvider.primary.candidate.effort, 'xhigh');
  const alreadyMax = routePure(task(ASTRA, 'max'), createSnapshot(fixture()));
  assert.notEqual(alreadyMax.kind, 'launch', 'an executed max quality floor cannot be lowered');
  for (const variant of [{ state: 'planned' }, { role: 'second' }, { taskId: 'another-task' }]) {
    const scoped = structuredClone(task());
    scoped.previousAttempts.push({ ...scoped.previousAttempts[0], id: 'ignored-max', actual: { accountId: 'trae', modelId: ASTRA, effort: 'max' }, ...variant });
    assert.equal(routePure(scoped, createSnapshot(fixture())).primary.candidate.effort, 'xhigh');
  }
  const priorPersonal = structuredClone(task()); priorPersonal.previousAttempts[0].actual.accountId = 'b';
  const repeated = routePure(priorPersonal, createSnapshot(fixture()));
  assert.notEqual(repeated.kind, 'launch', 'standing approval does not repeat a failed personal quality step');
  const disabled = fixture(); disabled.personalFallback = { ...policy, enabled: false };
  assert.notEqual(routePure(task(), createSnapshot(disabled)).kind, 'launch');
  const recent = structuredClone(createSnapshot(fixture()));
  const recentLane = recent.lanes.find(lane => lane.accountId === 'trae' && lane.modelId === ASTRA);
  recentLane.position.value = null; recentLane.queueState.value = null; recentLane.drainPerMin.value = null;
  recentLane.recentQueue = { status: 'KNOWN', value: { blocked: true }, source: 'synthetic-queue',
    sampledAt: recent.decisionAt, receivedAt: recent.decisionAt, maxAgeMs: 1800000 };
  assert.equal(routePure(task(), recent).primary.candidate.effort, 'xhigh');
  console.log('PASS ready max-capable company lane stays at max; executed max and failed personal xhigh floors remain protected; disabled policy stays gated');

  const profiles = path.join(tmp, 'accounts.json');
  const accountMap = Object.fromEntries(source.accounts.filter(account => account.kind !== 'claude').map(account =>
    [account.id, { kind: account.kind, home: path.join(tmp, account.id), hub: 'ws://127.0.0.1:1' }]));
  fs.writeFileSync(profiles, JSON.stringify(accountMap));
  const snapshotFile = path.join(tmp, 'snapshot.json'); fs.writeFileSync(snapshotFile, JSON.stringify(fixture()));
  const route = spawnSync(process.execPath, [path.join(scripts, 'route.mjs'), 'implement-hard', '--impact', 'service', '--failures', '1',
    '--actual', `codex:${ASTRA}:xhigh@trae`, '--exclude-account', 'trae,ttadk', '--dry', '--json'], {
    env: { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: profiles, ROUTE_SNAPSHOT_FILE: snapshotFile,
      ROUTE_NOW: String(source.decisionAt), ROUTE_LOG_FILE: path.join(tmp, 'route.log'), ROUTE_LOG: '0',
      QUOTA_CACHE: path.join(tmp, 'cache.json'), TRAE_PROBE: '0', NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30000, maxBuffer: 16 << 20 });
  assert.equal(route.status, 0, route.stderr + String(route.error ?? ''));
  const view = JSON.parse(route.stdout); assert.equal(view.pick.effort, 'xhigh');
  assert.ok(view.tellUser.some(line => /max was unavailable.*xhigh on personal Astra instead/.test(line)));
  console.log('PASS route CLI emits the explicit max-unavailable tell line and stalled max alternatives');

  const owner = '053283ad-1bc8-5a31-ad44-d68e6b199eb6', shared = path.join(tmp, 'queue');
  fs.mkdirSync(shared); const home = path.join(shared, 'account'); fs.mkdirSync(home);
  const queueProfiles = path.join(shared, 'accounts.json');
  fs.writeFileSync(queueProfiles, JSON.stringify({ fixture: { kind: 'trae', home, hub: 'ws://127.0.0.1:1' } }));
  const queuePolicy = path.join(shared, 'policy.json'); fs.writeFileSync(queuePolicy, JSON.stringify({ ...policy, queueWaitMinutes: 0.001 }));
  const quota = path.join(shared, 'quota.json'); fs.writeFileSync(quota, JSON.stringify({ checkedAt: Date.now(), codexAccounts: [] }));
  const badSnapshot = path.join(shared, 'snapshot.json'); fs.writeFileSync(badSnapshot, '{}');
  const rpc = path.join(shared, 'rpc.log');
  const env = { ...process.env, HOME: shared, RULES_SHARED: shared, RES_DIR: shared, CODEX_ACCOUNTS: queueProfiles,
    CODEX_HOME: home, NODE_OPTIONS: '', PERSONAL_FALLBACK_FILE: queuePolicy, QUOTA_CACHE: quota, ROUTE_SNAPSHOT_FILE: badSnapshot,
    ROUTE_LOG_FILE: path.join(shared, 'route.log'), CLAUDE_JOB_DIR: '', CLAUDECODE: '', ORCHESTRATOR_OWNER: '',
    WORKER_GUARDS_FIXTURE: JSON.stringify({ thread: 'guard-thread', rpc, quiet: true,
      messages: [{ method: 'queue/status', params: { threadId: 'guard-thread', turnId: 'guard-turn',
        state: 'waiting', position: 1399, modelQuotaLowPriority: true } }] }) };
  active = spawn(process.execPath, ['--import', path.join(scripts, 'test/fixtures/worker-guards-transport.mjs'), path.join(scripts, 'codex-worker.mjs'),
    '--account', 'fixture', 'start', '--cwd', shared, '--sandbox', 'read-only', '--owner', owner, '--name', 'bc178-queue',
    '--model', ASTRA, '--effort', 'max', '--background', 'Follow the synthetic queue brief.'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; active.stdout.on('data', chunk => output += chunk); active.stderr.on('data', chunk => output += chunk);
  const exit = new Promise(resolve => active.once('close', code => resolve(code)));
  const eventsFile = path.join(shared, 'worker-events.jsonl');
  let notice;
  for (let i = 0; i < 60 && !notice; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (fs.existsSync(eventsFile)) notice = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(row => row.kind === 'queue-stalled');
  }
  assert.ok(notice?.wake, output);
  const printed = eventLine({ ...notice, text: notice.text + ' delivery skipped finished' });
  assert.match(printed, /^\[queue-stalled\]/); assert.ok(printed.endsWith(' delivery skipped finished'));
  assert.match(hookEventLine(notice), /^\[queue-stalled\]/);
  for (const option of notice.options) assert.ok(printed.includes(option.command));
  const command = 'node /tmp/delivery/scripts/codex-worker.mjs --out /tmp/finished-review.out --log /tmp/delivery-review.log turn --thread skipped-worker';
  for (const kind of ['queue-stalled', 'quota-warning']) {
    const row = { event: 'message', kind, name: 'finished-worker', text: command };
    assert.ok(eventLine(row).includes(command)); assert.ok(hookEventLine(row).includes(command));
    assert.ok(eventLine(row).includes('finished-worker'));
  }
  const queue = JSON.parse(fs.readFileSync(path.join(home, 'queue-status.json'), 'utf8'))['guard-thread'];
  assert.equal(queue.position, 1399); assert.equal(queue.modelQuotaLowPriority, true);
  const display = spawnSync(process.execPath, [path.join(scripts, 'quota.mjs'), '--running'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(display.status, 0, display.stderr); assert.match(display.stdout, /QUEUED position=1399 low-priority/);
  active.kill('SIGTERM'); await exit; active = null;
  console.log('PASS fresh waiting/low-priority transport emits an owner notice at max effort with background and no explicit patience; --running shows QUEUED position');
  console.log('all pass');
} finally { if (active) active.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); }
