#!/usr/bin/env node
// Astra-first trial: public fixture snapshots only, with no hub or shared-state access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskSpec, createSnapshot, routePure } from '../lib/pipeline/index.mjs';

const route = new URL('../route.mjs', import.meta.url).pathname;
const base = JSON.parse(fs.readFileSync(new URL('./fixtures/free-trae-fresh-ttadk-2026-11-15.json', import.meta.url), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-first-'));
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', now = base.decisionAt;
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, ROUTE_NOW: String(now),
  ROUTE_SNAPSHOT_FILE: path.join(tmp, 'snapshot.json'), CODEX_ACCOUNTS: path.join(tmp, 'accounts.json'),
  QUOTA_CACHE: path.join(tmp, 'cache.json'), QUOTA_LOG_FILE: path.join(tmp, 'quota-log.jsonl'),
  ROUTE_LOG_FILE: path.join(tmp, 'route-log.jsonl'), ROUTE_RR: path.join(tmp, 'rotation'),
  ROUTE_LOG: '0', TRAE_PROBE: '0', ROUTE_REQUEST_ID: 'astra-first' };
const copy = () => structuredClone(base);
const lane = (s, model, account = 'trae') => s.lanes.find(l => l.accountId === account && l.modelId === model);
const bucket = (s, model) => s.accounts.find(a => a.id === 'trae').quota.find(q => q.bucketId === model);
const cli = (args, s = base) => {
  fs.writeFileSync(env.ROUTE_SNAPSHOT_FILE, JSON.stringify(s));
  return JSON.parse(execFileSync(process.execPath, [route, ...args, '--dry', '--json'], { env, encoding: 'utf8', maxBuffer: 16 << 20 }));
};
const hard = ['implement-hard', '--impact', 'service'];
let checks = 0;
const pick = (args, s, model, account, effort) => {
  const o = cli(args, s);
  assert.equal(o.kind, 'launch', args.join(' '));
  assert.equal(o.pick.model, model); assert.equal(o.pick.account, account);
  if (effort) assert.equal(o.pick.effort, effort);
  assert.ok(o.pick.command); assert.ok(!o.plan.gates.some(g => ['astra', 'max-effort', 'personal-quota'].includes(g.kind)));
  checks++; return o;
};
const unavailable = (s, model, state) => {
  const l = lane(s, model);
  if (state === 'hot') l.loadPercent.value = 60;
  else if (state === 'unknown') {
    for (const key of ['readyAt', 'position', 'drainPerMin', 'queueState', 'progressAt', 'loadPercent', 'familyQueue']) l[key].value = null;
  } else {
    l.readyAt.value = null; l.position.value = 10; l.progressAt.value = null;
    l.queueState.value = state === 'waiting' ? 'waiting' : 'queued';
    l.drainPerMin.value = state === 'stalled' || state === 'waiting' ? 0 : 5;
  }
};
try {
  // Both models have observed free low-priority lanes in this fixture.
  for (const args of [hard, ['debug', '--impact', 'service'], ['science', '--impact', 'service'],
    ['design'], ['analysis', '--stakes', 'high'], [...hard, '--background']]) pick(args, base, ASTRA, 'trae');
  const fresh = copy(), q = bucket(fresh, ASTRA), l = lane(fresh, ASTRA);
  q.usage.value = { used: 0, limit: 58, remaining: 58, depleted: false, resetsAt: now + 3600000 };
  q.priority.value = 'available'; l.mode = 'priority'; l.modeEvidence.value = 'priority';
  l.bucketIds = [ASTRA]; l.costs = [{ bucketId: ASTRA, unit: 'model-bucket', amount: 1, prioritySpend: true }];
  const free = pick(hard, fresh, ASTRA, 'trae');
  assert.equal(free.plan.primary.estimate.expiryEvidence.modelId, ASTRA);
  assert.equal(free.plan.primary.estimate.expiryEvidence.unit, 'model-bucket');
  assert.equal(free.plan.primary.estimate.noPrioritySpend, false);
  assert.equal(pick(hard, base, ASTRA, 'trae').plan.primary.estimate.noPrioritySpend, true);
  for (const s0 of [base, fresh]) for (const state of ['hot', 'queued', 'stalled', 'waiting', 'unknown']) {
    const s = structuredClone(s0); unavailable(s, ASTRA, state);
    const quotaOnly=s0===fresh&&state==='unknown';
    pick(hard, s, quotaOnly?ASTRA:SOL, 'trae');
    unavailable(s, SOL, 'hot'); pick(hard, s, quotaOnly?ASTRA:SOL, quotaOnly?'trae':'ttadk');
  }
  // Matching concrete Sol versions across accounts is unnecessary: each account
  // ranks its own newest release in the same workhorse position.
  const mixed = copy(), newSol = 'gpt-6.2-sol';
  const main = mixed.accounts.find(a => a.id === 'main');
  const addSol = account => {
    account.catalog.value.push(newSol);
    const old = lane(mixed, SOL, account.id);
    mixed.lanes.push({ ...old, id: old.id.replace(SOL, newSol), modelId: newSol });
  };
  mixed.models.push({ ...mixed.models.find(m => m.id === SOL), id: newSol });
  addSol(main);
  pick(['analysis'], mixed, SOL, 'trae');
  const personalOnly = structuredClone(mixed);
  personalOnly.accounts = personalOnly.accounts.filter(a => a.id === 'main');
  personalOnly.lanes = personalOnly.lanes.filter(l => l.accountId === 'main');
  pick(['analysis'], personalOnly, newSol, 'main');
  addSol(mixed.accounts.find(a => a.id === 'trae'));
  pick(['analysis'], mixed, newSol, 'trae');
  const exclusion = copy(); pick([...hard, '--exclude-model', ASTRA], exclusion, SOL, 'trae');
  const incapable = copy(); lane(incapable, ASTRA).capabilities.search.value = false;
  pick(['research', '--stakes', 'high'], incapable, SOL, 'trae');
  const ttExpiring = copy(), tt = ttExpiring.accounts.find(a => a.id === 'ttadk');
  tt.quota[0].usage.value.resetsAt = now + 3 * 3600000;
  tt.burn.value = { resetsAt: tt.quota[0].usage.value.resetsAt, projectedAtReset: 50000000 };
  pick(hard, ttExpiring, ASTRA, 'trae'); // expiry does not displace the chosen model
  unavailable(ttExpiring, ASTRA, 'hot'); pick(hard, ttExpiring, SOL, 'trae');
  unavailable(ttExpiring, SOL, 'hot'); pick(hard, ttExpiring, SOL, 'ttadk');
  const approved = copy(), decision = cli(['design', '--urgent'], approved);
  const scopes = decision.plan.trace.candidates.flatMap(r => r.predicates.flatMap(p => p.gates ?? []))
    .filter(g => g.kind === 'personal-quota').map(g => ({ ...g.scope, allowPersonalWithCompany: true }));
  approved.approvals = [{ id: 'personal-yes', userDecisionRef: 'synthetic-user-decision',
    grantedAt: now - 1000, expiresAt: now + 60000, revoked: false, scopes }];
  const approvedArgs = ['design', '--urgent', '--user-ok', 'personal-yes'];
  pick(approvedArgs, approved, ASTRA, 'trae');
  unavailable(approved, ASTRA, 'hot'); pick(approvedArgs, approved, SOL, 'trae');
  unavailable(approved, SOL, 'hot'); pick(approvedArgs, approved, SOL, 'ttadk');
  const unknown = structuredClone(fresh);
  unknown.accounts = unknown.accounts.filter(a => ['trae', 'claude'].includes(a.id));
  for (const a of unknown.accounts) a.catalog.value = a.id === 'trae' ? [ASTRA] : ['opus'];
  unknown.lanes = unknown.lanes.filter(l => l.accountId === 'trae' && l.modelId === ASTRA || l.accountId === 'claude' && l.modelId === 'opus');
  bucket(unknown, ASTRA).usage.value.resetsAt = now + 12 * 3600000;
  bucket(unknown, ASTRA).usage.sampledAt = now - 30 * 60000 - 1;
  unavailable(unknown, ASTRA, 'unknown'); lane(unknown, 'opus', 'claude').readyAt.value = null;
  const unknownDecision = cli(['design', '--urgent'], unknown);
  const unknownScopes = unknownDecision.plan.trace.candidates.flatMap(r => r.predicates.flatMap(p => p.gates ?? []))
    .filter(g => g.kind === 'personal-quota').map(g => ({ ...g.scope, allowPersonalWithCompany: true }));
  unknown.approvals = [{ id: 'personal-yes', userDecisionRef: 'synthetic-user-decision',
    grantedAt: now - 1000, expiresAt: now + 60000, revoked: false, scopes: unknownScopes }];
  assert.equal(cli(approvedArgs, unknown).pick.vendor, 'claude', 'unobserved Astra retains the pre-trial approved personal fallback'); checks++;
  for (const variant of [{ state: 'planned' }, { role: 'reviewer' }, { taskId: 'another-task' }]) {
    const prior = { id: 'ignored', taskId: 'ignored-history', role: 'primary', state: 'failed', actualStatus: 'KNOWN',
      actual: { accountId: 'trae', modelId: SOL, effort: 'xhigh' }, ...variant };
    const task = createTaskSpec({ taskId: 'ignored-history', requestId: 'ignored-history', project: 'fixture', owner: 'fixture-owner',
      category: 'implement-hard', impact: 'service', previousAttempts: [prior] });
    const o = routePure(task, createSnapshot(base));
    assert.equal(o.primary.candidate.modelId, ASTRA, 'records outside the actual retry floor do not displace free Astra'); checks++;
  }
  console.log('PASS hard: free/depleted Astra, exact daily units, congestion >=60%, queue/stall/unknown, Sol TRAE/TTADK fallback, exclusions/capabilities/expiry');

  for (const [previous, expected] of [['high', 'xhigh'], ['xhigh', 'max']]) {
    const args = [...hard, '--failures', '1', '--actual', `codex:${ASTRA}:${previous}@trae`];
    const o = pick(args, base, ASTRA, 'trae', expected);
    assert.ok(o.plan.trace.candidates.filter(r => r.candidate.modelId === SOL)
      .every(r => r.predicates.some(p => p.reason?.code === 'RETRY_BELOW_ACTUAL_FLOOR')));
  }
  const exhausted = cli([...hard, '--failures', '1', '--actual', `codex:${ASTRA}:max@trae`]);
  assert.equal(exhausted.kind, 'blocked'); assert.equal(exhausted.pick, null); checks++;
  for (const [previous, expected] of [['high', 'xhigh'], ['xhigh', 'max']]) {
    const args = [...hard, '--failures', '1', '--actual', `codex:${SOL}:${previous}@trae`];
    pick(args, base, SOL, 'trae', expected);
    const hotSol = copy(); unavailable(hotSol, SOL, 'hot'); pick(args, hotSol, SOL, 'ttadk', expected);
  }
  pick([...hard, '--failures', '1', '--actual', `codex:${SOL}:max@trae`], base, ASTRA, 'trae', 'max');
  const ttOnly = copy(); ttOnly.accounts = ttOnly.accounts.filter(a => a.id === 'ttadk');
  ttOnly.lanes = ttOnly.lanes.filter(l => l.accountId === 'ttadk');
  pick([...hard, '--failures', '1'], ttOnly, SOL, 'ttadk', 'max');
  const aliased = createTaskSpec({ taskId: 'alias', requestId: 'alias', project: 'fixture', owner: 'fixture-owner',
    category: 'implement-hard', impact: 'service', failures: 1,
    previousAttempts: [{ id: 'actual', taskId: 'alias', role: 'primary', state: 'failed', actualStatus: 'KNOWN', failureKind: 'quality',
      actual: { accountId: 'trae', modelId: 'GPT-6.1-Sol', effort: 'xhigh' } }] });
  const aliasRetry = routePure(aliased, createSnapshot(base));
  assert.equal(aliasRetry.primary.candidate.modelId, SOL); assert.equal(aliasRetry.primary.candidate.effort, 'max'); checks++;
  console.log('PASS retries: Astra high/xhigh/max floor, exhausted max blocks, retained Sol xhigh/max on both company accounts, then Astra max');

  for (const args of [['analysis'], ['implement', '--impact', 'service'], ['docs'], ['review'], ['image-read'], ['image-read', '--stakes', 'high']]) pick(args, base, SOL, 'trae');
  const quality = JSON.parse(fs.readFileSync(new URL('./fixtures/quality-first-2026-11-15.json', import.meta.url), 'utf8'));
  for (const args of [['lookup'], ['extract'], ['draft'], ['analysis', '--background']]) pick(args, quality, 'gpt-5.6-terra', 'ttadk');
  const mac = copy(); mac.accounts = mac.accounts.filter(a => !['trae', 'ttadk'].includes(a.kind));
  mac.lanes = mac.lanes.filter(l => mac.accounts.some(a => a.id === l.accountId));
  const personal = cli(hard, mac);
  assert.equal(personal.kind, 'launch'); assert.equal(personal.pick.model, SOL);
  assert.ok(!personal.plan.gates.some(g => g.kind === 'astra')); checks++;
  for (const s of [base, mac]) {
    const o = cli([...hard, '--exclude-account', 'trae,ttadk', '--failures', '1', '--actual', `codex:${SOL}:xhigh@main`], s);
    assert.equal(o.kind, 'blocked'); assert.equal(o.pick.model, ASTRA); assert.equal(o.pick.command, null);
    assert.ok(o.plan.gates.some(g => g.kind === 'astra')); checks++;
  }
  const adversarial = cli(['review', '--adversarial'], base);
  assert.equal(adversarial.pick.model, 'kimi-k3'); checks++;
  console.log('PASS normal/light, image-read including hard stakes, MacBook personal Sol default, personal Astra approval on both device types, adversarial order');
  console.log(`Astra-first: ${checks} scenarios passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
