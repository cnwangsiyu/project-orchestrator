#!/usr/bin/env node
// Synthetic catalogs and public status fixtures only; no provider calls or launches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createTaskSpec, createSnapshot, routePure, renderPlan, validatePlan, enumerateCandidates } from '../lib/pipeline/index.mjs';
import { pScopedApproval } from '../lib/pipeline/filters.mjs';
import { mandatoryClaudeApprovalRef, mandatoryClaudeDecision } from '../lib/pipeline/policy.mjs';
import { projectReviewPolicy } from '../lib/review-policy-data.mjs';
import { routeFixture } from './helpers/route-fixture.mjs';

const now = 1800000000000, SOL = 'gpt-6.1-sol', FLASH = 'deepseek-v4.1-flash';
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const task = (flags = {}, category = 'review') => createTaskSpec({ taskId: 'mandatory-review', requestId: 'fixture',
  project: 'fixture', category, flags: Object.fromEntries(Object.entries({ name: 'mandatory-review', ...flags }).filter(([, v]) => v !== undefined)) });
const required = (extra = {}, category = 'review') => task({ 'review-class': 'B', 'review-reason': 'fixture class basis', author: 'codex', ...extra }, category);
const fixture = () => {
  const accounts = [['trae', 'trae', [SOL, FLASH]], ['ttadk', 'ttadk', [SOL, 'kimi-k3']],
    ['main', 'chatgpt', [SOL]], ['claude', 'claude', ['haiku', 'sonnet', 'opus', 'fable']]];
  return { schemaVersion: 'pipeline-v1', collectedFrom: now, collectedThrough: now, decisionAt: now,
    accounts: accounts.map(([id, kind, catalog]) => ({ id, kind, catalog, auth: true, transport: true, health: true,
      providerDenied: false, capabilities: {}, budget: { status: 'under', deadline: 168 } })),
    models: [...new Set(accounts.flatMap(a => a[2]))].map(id => ({ id, efforts, capabilities: {} })),
    lanes: accounts.flatMap(([accountId, kind, models]) => models.map(modelId => ({ id: `${accountId}:${modelId}`,
      accountId, modelId, harness: kind === 'claude' ? 'claude-bg' : 'hub', efforts, capabilities: {},
      mode: kind === 'trae' ? 'priority' : 'standard', selectable: true, readyAt: now, position: 0, loadPercent: 1 }))),
    resources: { held: false, ownedReturned: true }, health: [], approvals: [], projectProfiles: {}, reviewHistory: [] };
};
const route = (t, raw = fixture()) => {
  const snapshot = createSnapshot(raw), plan = routePure(t, snapshot);
  if (plan.kind === 'launch') assert.equal(validatePlan(plan, snapshot).ok, true);
  return renderPlan(plan, { snapshot, root: '/fixture', owner: 'fixture-owner' });
};
const checkClaude = view => {
  assert.equal(view.kind, 'launch', JSON.stringify(view.plan.reasons));
  assert.equal(view.pick.model, 'opus'); assert.equal(view.pick.effort, 'medium');
  assert.equal(view.pick.approvalRef, mandatoryClaudeApprovalRef);
  assert.equal(view.needsUserOK.length, 0); assert.ok(view.why.some(s => s.includes(mandatoryClaudeDecision)));
  assert.match(view.pick.command, /launch-audit\.mjs/); assert.match(view.pick.command, /launch-claude-worker\.mjs/);
  assert.match(view.pick.command, /claude --bg --remote-control --permission-mode bypassPermissions/);
  assert.match(view.pick.command, /--model opus --effort medium/);
};
for (const reviewClass of ['A', 'B', 'C']) for (const authorFlag of ['author', 'against']) {
  for (const category of ['review', 'review-high', 'second-opinion']) {
    if (category === 'second-opinion' && authorFlag !== 'against') continue;
    checkClaude(route(required({ author: undefined, [authorFlag]: 'codex', 'review-class': reviewClass }, category)));
  }
}
for (const flags of [{ stakes: 'high' }, { stakes: 'low' }, { background: true }, { 'auto-check': true }, { 'runs-tests': true }])
  checkClaude(route(required(flags)));
const exclusive = fixture();
exclusive.personalPriority = { account: 'main', mode: 'exclusive', from: new Date(now - 1000).toISOString(), until: null,
  revoked: false, userDecisionRef: 'standing:personal-priority-fixture', quote: 'fixture priority' };
assert.equal(createSnapshot(exclusive).personalPriority?.mode, 'exclusive');
checkClaude(route(required(), exclusive));
console.log('PASS mandatory A/B/C author/against routes: approved Opus medium, executable command, fixed effort and main-only window');

for (const flags of [{ author: 'codex' }, { against: 'codex' }, { author: 'codex', impact: 'release' },
  { author: 'codex', 'review-required': 'optional request' }]) {
  const view = route(task(flags)); assert.equal(view.pick.model, FLASH); assert.equal(view.pick.effort, 'high');
  assert.ok(!view.why.some(s => s.includes(mandatoryClaudeDecision)));
  assert.equal(view.pick.approvalRef, null);
  if (flags.impact) assert.equal(view.plan.task.impact, 'service');
}
for (const author of ['claude', undefined]) {
  const view = route(required({ author })); assert.notEqual(view.pick.vendor, 'claude');
}
assert.throws(() => task({ 'review-class': 'B', author: 'claude' }), /review-reason/);
const implementation = route(required({ author: undefined, impact: 'service' }, 'implement'));
assert.notEqual(implementation.pick.vendor, 'claude');
console.log('PASS optional reviews, unclassified release, Claude/unspecified author, missing reason and implementation retain existing routing');

const t = required(), s = createSnapshot(fixture());
for (const c of enumerateCandidates(t, s).candidates.filter(c => c.family === 'claude')) {
  const gate = pScopedApproval(t, s, c, { companyEligible: true });
  if (c.modelId === 'opus' && c.effort === 'medium') assert.equal(gate.ok, true);
  else {
    assert.equal(gate.ok, false, `${c.modelId}/${c.effort} keeps its quota gate`);
    assert.ok(gate.gates.some(g => g.kind === 'personal-quota'));
    if (c.effort === 'max') assert.ok(gate.gates.some(g => g.kind === 'max-effort'));
    if (c.modelId === 'fable') assert.ok(gate.gates.some(g => g.kind === 'fable'));
  }
}
for (const flags of [{ security: true }, { security: true, defensive: true }, { adversarial: true }]) {
  const secure = task({ author: 'codex', ...flags }), view = route(secure);
  assert.notEqual(view.pick?.approvalRef, mandatoryClaudeApprovalRef);
  const opus = enumerateCandidates(secure, s).candidates.find(c => c.modelId === 'opus' && c.effort === 'medium');
  assert.equal(pScopedApproval(secure, s, opus).ok, false);
  checkClaude(route(required(flags)));
}
for (const authorFlag of ['author', 'against']) {
  const view = route(required({ author: undefined, [authorFlag]: 'codex', 'review-class': 'D' }));
  assert.equal(view.adversarial, true); assert.equal(view.security, true);
  assert.equal(view.pick.model, 'kimi-k3'); assert.equal(view.secondOpinion.model, 'opus');
  assert.equal(view.secondOpinion.effort, 'medium'); assert.equal(view.secondOpinion.approvalRef, mandatoryClaudeApprovalRef);
  assert.equal(view.needsUserOK.length, 0); assert.ok(view.why.some(s => s.includes(mandatoryClaudeDecision)));
  assert.ok(!view.why.some(s => s.includes('unavailable or denied')));
  assert.match(view.secondOpinion.command, /--model opus --effort medium/);
  const fallback = route(required({ 'review-class': 'D', 'exclude-account': 'claude' }));
  assert.equal(fallback.pick.model, 'kimi-k3'); assert.equal(fallback.secondOpinion.model, FLASH);
  assert.match(fallback.why.join(' '), /unavailable or denied/);
}
console.log('PASS class D keeps security labels and independent pair with approved Claude second; unclassified security, other models, max and Fable keep gates');

for (const [label, mutate, flags] of [
  ['provider denial', raw => { raw.accounts.find(a => a.id === 'claude').providerDenied = true; }, {}],
  ['transport unavailable', raw => { raw.accounts.find(a => a.id === 'claude').transport = false; }, {}],
  ['missing catalog seat', raw => { raw.accounts.find(a => a.id === 'claude').catalog = ['sonnet']; }, {}],
  ['excluded lane', () => {}, { 'exclude-lane': 'claude:opus' }],
  ['excluded account', () => {}, { 'exclude-account': 'claude' }],
  ['medium unsupported', raw => { raw.lanes.find(l => l.id === 'claude:opus').efforts = ['high', 'xhigh', 'max']; }, {}],
]) {
  const raw = fixture(); mutate(raw); const view = route(required(flags), raw);
  assert.notEqual(view.pick?.approvalRef, mandatoryClaudeApprovalRef, label);
  assert.match(view.why.join(' '), /Claude Opus 5\.5 medium unavailable or denied.*previous review routing behavior/, label);
  assert.equal(view.pick.model, FLASH, label);
}
const priorFloor = route(createTaskSpec({ ...required(), previousAttempts: [{ id: 'prior-review', taskId: 'mandatory-review',
  role: 'primary', state: 'failed', actualStatus: 'KNOWN', failureKind: 'quality',
  actual: { accountId: 'claude', modelId: 'opus', effort: 'xhigh' } }] }));
assert.notEqual(priorFloor.pick?.approvalRef, mandatoryClaudeApprovalRef);
assert.ok(priorFloor.plan.rejected.some(p => p.reason?.code === 'RETRY_BELOW_ACTUAL_FLOOR'));
const capped = fixture();
capped.reviewHistory = ['mandatory-review-R', 'mandatory-review-R2'].map(name => ({ name, category: 'review', project: 'fixture', t: now - 1000 }));
const blocked = route(required(), capped);
assert.equal(blocked.kind, 'blocked'); assert.equal(blocked.plan.reasons[0].code, 'REVIEW_ROUND_CAP');
for (const [project, target] of [['video-agent', 10], ['vesdk-mainline', 20], ['webview', 20]])
  assert.equal(projectReviewPolicy(project).reviewTargetPct, target);
console.log('PASS unavailable/denied Claude fallback reason, prior floor, two-round cap and share targets');

// Whitelist the child environment like 9dc1bba; no caller registry, overrides or loader.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mandatory-claude-review-'));
try {
  const fixtureHome = path.join(tmp, 'home'), shared = path.join(fixtureHome, '.claude/orchestrator/_shared');
  fs.mkdirSync(shared, { recursive: true });
  const registry = path.join(tmp, 'accounts.json'), cache = path.join(tmp, 'quota.json');
  const approvals = path.join(tmp, 'approvals.json'), fallback = path.join(tmp, 'fallback.json');
  fs.writeFileSync(registry, '{}'); fs.writeFileSync(approvals, '[]'); fs.writeFileSync(fallback, '{"enabled":false}');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now,
    claude: [{ used: 10, windowMins: 10080, resetsAt: now + 7 * 86400000 }],
    codexAccounts: [{ name: 'trae', kind: 'trae', home: fixtureHome, healthy: true, live: true, models: [SOL, FLASH],
      windows: [], load: { [SOL]: { t: now, percent: 10 }, [FLASH]: { t: now, percent: 10 } } }], errors: {}, history: {} }));
  fs.writeFileSync(path.join(fixtureHome, 'queue-state.json'), JSON.stringify({ deepseek: { t: now, position: 0, state: 'ready' } }));
  const env = { PATH: process.env.PATH, HOME: fixtureHome, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    RULES_SHARED: shared, CODEX_ACCOUNTS: registry, QUOTA_CACHE: cache, ROUTE_APPROVAL_FILE: approvals,
    PERSONAL_FALLBACK_FILE: fallback, ROUTE_NOW: String(now), ROUTE_LOG: '0', QUOTA_LOG: '0', TRAE_PROBE: '0',
    ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl'), ORCHESTRATOR_OWNER: '' };
  const script = new URL('../route.mjs', import.meta.url).pathname;
  const run = args => JSON.parse(execFileSync(process.execPath, [script, ...args, '--json'], { env, encoding: 'utf8', timeout: 15000 }));
  const args = ['review', '--review-class', 'B', '--review-reason', 'x', '--author', 'codex'];
  checkClaude(run(args));
  assert.equal(run(['review', '--author', 'codex']).pick.model, FLASH);
  assert.notEqual(run(['review', '--review-class', 'B', '--review-reason', 'x', '--author', 'claude']).pick.vendor, 'claude');
  const missingReason = spawnSync(process.execPath, [script, 'review', '--review-class', 'B', '--author', 'claude'], { env, encoding: 'utf8' });
  assert.equal(missingReason.status, 2); assert.match(missingReason.stderr, /review-reason/);
  const approved = JSON.parse(routeFixture(script, ['review', '--author', 'codex', '--exclude-model', FLASH, '--json'],
    { env, dir: tmp, approve: true, timeout: 15000 }));
  assert.equal(approved.pick.launcher, run(args).pick.launcher);
  assert.match(approved.pick.command, /launch-claude-worker\.mjs/);
  const poison = { HOME: '/fixture-caller', RULES_SHARED: '/fixture-caller/shared', ROUTE_SNAPSHOT_FILE: '/fixture-caller/not-read.json',
    ROUTE_APPROVAL_FILE: '/fixture-caller/not-read-approvals.json', NODE_OPTIONS: '--import=/fixture-caller/not-a-loader.mjs' };
  const original = Object.fromEntries(Object.keys(poison).map(name => [name, process.env[name]]));
  try { Object.assign(process.env, poison); checkClaude(run(args)); }
  finally { for (const [name, value] of Object.entries(original)) value === undefined ? delete process.env[name] : process.env[name] = value; }
  console.log('PASS real CLI catalog, existing approved-Claude launcher, required reason, and poisoned caller isolation');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
