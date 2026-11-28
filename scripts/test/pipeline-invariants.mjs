#!/usr/bin/env node
// Synthetic metadata only. No providers, sessions, signing, locks or devices.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { noteFailure, noteSuccess, claimProbes, probeResult, readPoolPauses } from '../lib/trae-health.mjs';
import { routePure, parseTaskSpec, createTaskSpec, deriveReview, createSnapshot, snapshotFromAnalyze, enumerateCandidates, validatePlan, renderPlan } from '../lib/pipeline/index.mjs';
import { evaluateCandidate, pAvailable, pCapabilities, pContent, pTierFloor, pModelFit, pSigning, pBackground, pScopedApproval, pPreviousFloor, pResourceScope, pDevice, pLaunchMatches, approvalScope, dominates } from '../lib/pipeline/filters.mjs';
import { estimateCandidate } from '../lib/pipeline/estimate.mjs';
import { resWorkerSandbox, resWorkerSandboxVerified } from '../lib/worker-launch.mjs';
import { orderCandidates } from '../lib/pipeline/choose.mjs';
import { VERSION, EFFORTS, stable } from '../lib/pipeline/common.mjs';

const NOW = 1800000000000, SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', FLASH = 'deepseek-v4.1-flash', KIMI = 'kimi-k3';
const clone = (x) => structuredClone(x);
const allCaps = () => Object.fromEntries(['search', 'browser', 'signed-in-browser', 'vision', 'desktop-tool', 'image-generation', 'claude-tools',
  'origin:https://example.test', 'app:com.example.calc', 'device:test-phone'].map((c) => [c, true]));
const model = (id, efforts = ['medium', 'high', 'xhigh', 'max']) => ({ id, efforts, capabilities: allCaps(), largeOutput: true });
const account = (id, kind, catalog) => ({ id, kind, catalog, auth: true, transport: true, quota: [], providerDenied: false, capabilities: allCaps() });
const lane = (accountId, modelId, mode = 'standard', extra = {}) => ({ id: `${accountId}:${modelId}`, accountId, modelId, harness: 'hub', efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  mode, selectable: true, readyAt: NOW, position: 0, drainPerMin: 0, capabilities: allCaps(), ...extra });
function fixture(spec = [['company-a', 'ttadk', [SOL]], ['company-b', 'trae', [SOL]], ['personal', 'chatgpt', [SOL]]]) {
  const ids = [...new Set(spec.flatMap((r) => r[2]))];
  return { schemaVersion: VERSION, policyVersion: VERSION, qualityRelationVersion: VERSION, collectedFrom: NOW - 1000, collectedThrough: NOW, decisionAt: NOW,
    accounts: spec.map(([id, kind, models]) => account(id, kind, models)), models: ids.map((id) => model(id)),
    lanes: spec.flatMap(([id, kind, models]) => models.map((m) => lane(id, m, kind === 'trae' ? 'priority' : 'standard'))),
    approvals: [], health: [], resources: { held: false, ownedReturned: true }, dependencies: [], etaHistory: [] };
}
const task = (category = 'analysis', extra = {}) => createTaskSpec({ taskId: 'task-1', requestId: 'request-1', project: 'fixture', owner: 'fixture-owner',
  category, ...(['implement', 'implement-hard', 'debug', 'science'].includes(category) ? { impact: 'service' } : {}), ...extra });
const run = (t, raw) => routePure(t, createSnapshot(raw));
const candidate = (s, accountId = s.accounts[0].id, modelId = s.accounts[0].catalog.value[0], effort = 'high') => enumerateCandidates(task(), s).candidates.find((c) => c.accountId === accountId && c.modelId === modelId && c.effort === effort);
const hasCode = (p, code) => (p.reasons ?? []).some((r) => r.code === code) || p.rejected.some((r) => r.reason?.code === code);
const noCommand = (p) => { assert.notEqual(p.kind, 'launch'); assert.equal(renderPlan(p).command, null); assert.equal(p.primary, undefined); assert.ok(p.reviewers.every((r) => !r.argv)); };
function approve(raw, t, c, action = 'personal-quota', bypass = false, extra = {}) {
  const id = `approval-${raw.approvals.length}`;
  const next = createTaskSpec({ ...t, approvalRefs: [...t.approvalRefs, id] });
  raw.approvals.push({ id, userDecisionRef: 'user-decision-1', grantedAt: NOW - 1000, expiresAt: NOW + 60000, revoked: false,
    scopes: [{ ...approvalScope(next, c, action), allowPersonalWithCompany: bypass }], ...extra });
  return next;
}
const attempt = (modelId = ASTRA, effort = 'xhigh', extra = {}) => ({ id: 'attempt-1', taskId: 'task-1', role: 'primary', state: 'failed', actualStatus: 'KNOWN',
  actual: { accountId: 'company-b', modelId, effort }, failureKind: 'infra', ...extra });
let fixed = 0;
function test(name, fn) { try { fn(); fixed++; console.log(`PASS ${name}`); } catch (e) { e.message = `${name}: ${e.message}`; throw e; } }

test('res checks preserve the bounded sandbox through routing and worker configuration', () => {
  const context = { taskId: 'task-1', requestId: 'request-1' };
  const lookup = parseTaskSpec(['lookup', '--needs-res'], context);
  assert.throws(() => parseTaskSpec(['lookup', '--needs-res'], { ...context, sandboxCeiling: 'read-only' }),
    {code: 'SANDBOX_CEILING'});
  assert.equal(lookup.sandbox, 'read-only');
  const check = parseTaskSpec(['build-run', '--read-only', '--needs-res'], context);
  assert.equal(check.sandbox, 'read-only');
  assert.equal(check.writes, false);
  assert.equal(parseTaskSpec(['build-run', '--needs-res'], context).sandbox, 'workspace-write');
  assert.throws(() => parseTaskSpec(['lookup', '--needs-res', '--needs-cli', 'adb'], context), {code: 'CONFLICTING_FLAGS'});

  for (const [kind, modelId] of [['chatgpt', 'gpt-6-luna'], ['ttadk', SOL], ['trae', 'gpt-5.6-terra']]) {
    const raw = fixture([['fixture-account', kind, [modelId]]]);
    raw.models[0].efforts.unshift('low');
    const snapshot = createSnapshot(raw);
    const plan = routePure(lookup, snapshot);
    assert.equal(plan.kind, 'launch', kind);
    assert.ok(plan.primary.argv.includes('--needs-res'));
    assert.ok(validatePlan(plan, snapshot).ok);
    const {pick} = renderPlan(plan, { snapshot, root: '/fixture' });
    assert.equal(pick.launcher, 'codex-worker');
    assert.equal(pick.sandbox, 'read-only');
    assert.ok(pick.workerArgs.includes('--needs-res'));
  }

  const directory = path.join(fs.realpathSync(os.tmpdir()), 'fixture-res-state');
  const scratch = path.join(directory, 'tmp/needs-res/task-1');
  const prior = process.env.RES_DIR;
  process.env.RES_DIR = directory;
  try {
    const config = resWorkerSandbox('read-only', { directory, task: 'task-1', network: false });
    assert.deepEqual(config.permissions[config.default_permissions], {
      extends: ':read-only', filesystem: { [scratch]: 'write' }, network: { enabled: false },
    });
    assert.equal(config.shell_environment_policy.set.RES_DIR, directory);
    assert.equal(config.shell_environment_policy.set.TMPDIR, scratch);
    assert.equal(resWorkerSandbox('workspace-write', { task: 'task-1' }).permissions[config.default_permissions].extends, ':workspace');
    assert.throws(() => resWorkerSandbox('danger-full-access', { task: 'task-1' }));
    assert.throws(() => resWorkerSandbox('read-only', { directory: path.dirname(directory), task: 'task-1' }));
    assert.throws(() => resWorkerSandbox('workspace-write', { cwd: path.dirname(directory), task: 'task-1' }));

    const activePermissionProfile = { id: config.default_permissions, extends: ':read-only' };
    const sandbox = { type: 'workspaceWrite', networkAccess: false, writableRoots: [scratch] };
    assert.equal(resWorkerSandboxVerified({ sandbox, activePermissionProfile }, config), true);
    assert.equal(resWorkerSandboxVerified({ sandbox }, config), null);
    assert.equal(resWorkerSandboxVerified({ sandbox: { ...sandbox, writableRoots: [directory] }, activePermissionProfile }, config), false);
    assert.equal(resWorkerSandboxVerified({ sandbox: { type: 'dangerFullAccess' }, activePermissionProfile }, config), false);
  } finally {
    if (prior === undefined) delete process.env.RES_DIR;
    else process.env.RES_DIR = prior;
  }
});

test('personal Luna image generation keeps its standing exception on a company device', () => {
  const raw = fixture([['company-a','ttadk',[SOL]],['company-b','trae',[SOL]],['personal','chatgpt',['gpt-6-luna',SOL]]]);
  for (const a of raw.accounts.filter(a=>a.kind!=='chatgpt')) a.capabilities['image-generation']=false;
  for (const l of raw.lanes.filter(l=>l.accountId!=='personal')) l.capabilities['image-generation']=false;
  raw.models.find(m=>m.id==='gpt-6-luna').efforts=['low','medium','high','xhigh','max'];
  const p=run(task('image-gen'),raw), view=renderPlan(p,{snapshot:createSnapshot(raw),root:'/fixture'});
  assert.equal(p.kind,'launch');assert.equal(p.primary.candidate.accountId,'personal');
  assert.equal(p.primary.candidate.modelId,'gpt-6-luna');assert.equal(p.primary.candidate.effort,'low');
  assert.deepEqual(view.needsUserOK,[]);assert.ok(view.pick.command);
  assert.match(view.pick.command,/run-tracked\.sh/);
  assert.match(view.pick.command,/--project fixture --task task-1 --task-dir/);
});

test('B2 ordinary full-access company signing works on both roles', () => {
  for (const role of ['primary', 'second']) { const p = run(task('build-run', { flags: { signing: true }, role, sandbox:'danger-full-access',sandboxCeiling:'danger-full-access' }), fixture()); assert.equal(p.kind,'launch'); assert.equal(p.primary.candidate.accountId,'company-a'); }
});
test('V02 hidden hard company witness survives exclusions', () => {
  const p = run(task('debug', { flags: { 'exclude-model': SOL } }), fixture([['a', 'ttadk', [SOL, FLASH]], ['b-company', 'trae', [ASTRA]]]));
  assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'b-company'); assert.equal(p.primary.candidate.modelId, ASTRA);
});
test('V03 catalog without Sol, unavailable efforts and unknown supervisor', () => {
  const raw = fixture([['a', 'ttadk', [FLASH]], ['b-company', 'trae', [SOL]]]); raw.accounts[1].transport = null;
  const p = run(task(), raw); assert.equal(p.primary.candidate.modelId, FLASH);
  const s = createSnapshot(raw), c = candidate(s, 'a', FLASH);
  assert.equal(pAvailable(task(), s, { ...c, effort: 'unsupported' }).reason.code, 'CATALOG_UNSUPPORTED');
});
test('V04 hidden-search selects capable TRAE', () => {
  const raw = fixture(); raw.accounts[0].capabilities.search = false;
  const p = run(task('research'), raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'company-b');
});
test('V05/V06 independent desktop tool and vision intersections', () => {
  for (const missing of ['desktop-tool', 'vision']) for (const part of ['accounts', 'models', 'lanes']) {
    const raw = fixture([['a', 'ttadk', [SOL]]]); raw[part][0].capabilities[missing] = false;
    const p = run(task('computer-use', { allowedApps: ['com.example.calc'] }), raw); noCommand(p);
    assert.ok(hasCode(p, `CAPABILITY_${missing.toUpperCase().replaceAll('-', '_')}`));
  }
});
test('V07 browser account rotation cannot overwrite capability', () => {
  const raw = fixture([['a', 'chatgpt', [SOL]], ['fixture-b', 'chatgpt', [SOL]]]); raw.accounts[0].capabilities.browser = false;
  let t = task('browser', { allowedOrigins: ['https://example.test'] }); const c = candidate(createSnapshot(raw), 'fixture-b', SOL, 'medium');
  t = approve(raw, t, c); const p = run(t, raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'fixture-b');
  const broken = clone(p); broken.primary.argv[broken.primary.argv.indexOf('--account') + 1] = 'a'; assert.equal(validatePlan(broken, createSnapshot(raw)).ok, false);
});
test('V08 personal with no company has standing permission', () => {
  const p = run(task('docs'), fixture([['p', 'chatgpt', [SOL]]]));
  assert.equal(p.kind,'launch');
  assert.ok(!p.gates.some(g=>g.kind==='personal-quota'));
});
test('BC-31 personal Astra requires its own approval; company Astra does not', () => {
  const raw=fixture([['p','chatgpt',[SOL,ASTRA]]]), t=task('implement-hard');
  const s=createSnapshot(raw), c=candidate(s,'p',ASTRA,'xhigh');
  assert.equal(pScopedApproval(t,s,c).reason.code,'PERSONAL_ASTRA_OK_REQUIRED');
  const approved=approve(raw,t,c,'astra');assert.equal(pScopedApproval(approved,createSnapshot(raw),c).ok,true);
  const max=candidate(s,'p',ASTRA,'max');assert.deepEqual(pScopedApproval(t,s,max).gates.map(g=>g.kind),['astra','max-effort']);
  const companyRaw=fixture([['p','chatgpt',[ASTRA]],['company','trae',[ASTRA]]]), companySnapshot=createSnapshot(companyRaw);
  assert.ok(pScopedApproval(t,companySnapshot,candidate(companySnapshot,'p',ASTRA,'xhigh')).gates.some(g=>g.kind==='astra'));
  assert.equal(pScopedApproval(t,companySnapshot,candidate(companySnapshot,'company',ASTRA,'xhigh')).ok,true);
  const prior=attempt(SOL,'high',{source:'explicit-actual',actual:{accountId:null,accountStatus:'UNKNOWN',modelId:SOL,effort:'high'}});
  assert.equal(run(task('implement-hard',{failures:1,previousAttempts:[prior]}),raw).kind,'launch');
  delete prior.source;noCommand(run(task('implement-hard',{failures:1,previousAttempts:[prior]}),raw));
});
test('V09 exact launch identity and fresh-state approval revocation', () => {
  const raw = fixture(), p = run(task(), raw), s = createSnapshot(raw);
  assert.equal(validatePlan(p, s).ok, true);
  assert.equal(validatePlan(p, s, { proposed: { ...p.primary.candidate, accountId: 'personal' } }).ok, false);
  const broken = clone(p); broken.primary.argv.push('--sandbox', 'full-access'); assert.equal(validatePlan(broken, s).ok, false);
  raw.accounts[0].auth = false; assert.equal(validatePlan(p, createSnapshot(raw)).ok, false);
});
test('V10/V11 real retry floor and missing history', () => {
  const raw = fixture([['b-company', 'trae', [SOL, ASTRA, 'gpt-5.6-sol']]]);
  let p = run(task('debug', { failures: 1, previousAttempts: [attempt()] }), raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.modelId, ASTRA);
  p = run(task('debug', { failures: 1 }), raw); assert.equal(p.kind,'launch');assert.ok(!hasCode(p,'PREVIOUS_ATTEMPT_UNKNOWN'));
  p = run(task('analysis', { previousAttempts: [attempt(SOL, 'high')] }), fixture([['a', 'ttadk', ['gpt-5.6-sol']]]));
  noCommand(p); assert.ok(hasCode(p, 'RETRY_BELOW_ACTUAL_FLOOR'));
});
test('V12 hard floor overrides low/background and Astra reservation', () => {
  const weak = fixture([['a', 'ttadk', ['gpt-5.6-sol', FLASH]]]);
  for (const flags of [{}, { background: true, stakes: 'low' }]) { const p = run(task('debug', { flags }), weak); noCommand(p); assert.ok(hasCode(p, 'TIER_QUALITY_FLOOR')); }
  for (const category of ['lookup', 'analysis']) { const p = run(task(category), fixture([['a', 'ttadk', [ASTRA]]])); noCommand(p); assert.ok(hasCode(p, 'ASTRA_SUBSTITUTION_HARD_ONLY')); }
});
test('V13 DeepSeek build/acceptance and vision-only output fit', () => {
  for (const role of ['primary', 'second']) for (const extra of [{ category: 'build-run' }, { requirements: { executableAcceptance: true } }, { runsTests: true }, { requirements: { authAcceptance: true } }, { requirements: { storageAcceptance: true } }]) {
    const p = run(task('analysis', { ...extra, role }), fixture([['a', 'ttadk', [FLASH]]])); noCommand(p); assert.ok(hasCode(p, 'MODEL_FIT_BUILD_ACCEPTANCE'));
  }
  noCommand(run(task(), fixture([['a', 'trae', ['seed-evolving']]])));
});
test('V14 adversarial excludes every GPT; ordinary policy code stays ordinary', () => {
  for (const kind of ['ttadk', 'trae', 'chatgpt']) { const p = run(task('review', { flags: { security: true,'review-class':'D','review-reason':'named adversarial review' } }), fixture([['a', kind, [SOL]]])); noCommand(p); assert.ok(hasCode(p, 'ADVERSARIAL_GPT_FORBIDDEN')); }
  const raw = fixture([['a', 'ttadk', [SOL]]]); assert.equal(run(task('review'), raw).kind, 'launch');
  assert.equal(run(task('review', { flags: { security: true, defensive: true } }), raw).kind, 'launch');
});
test('V15 required release review preserves content, scopes and exclusions', () => {
  const p = run(task('implement', { impact:'release', flags: { security: true,'review-class':'A','review-reason':'external irreversible release' }, allowedOrigins: ['https://example.test'] }), fixture([['a', 'ttadk', [SOL]]]));
  assert.equal(p.kind, 'launch'); assert.equal(p.followups.length, 1); assert.ok(p.followups[0].contentLabels.includes('adversarial'));
  assert.deepEqual(p.followups[0].allowedOrigins, p.task.allowedOrigins); assert.ok(p.gates.some((g) => g.phase === 'preaction'));
});
test('real CLI uses the same immutable pipeline and never launches a blocked proposal', () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pipeline-cli-'));
  try {
    const file=path.join(tmp,'snapshot.json'), route=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../route.mjs');
    const env={...process.env,HOME:tmp,RULES_SHARED:tmp,CODEX_ACCOUNTS:path.join(tmp,'registry.json'),QUOTA_CACHE:path.join(tmp,'cache.json'),
      ROUTE_LOG:'0',ROUTE_LOG_FILE:path.join(tmp,'routes.jsonl'),QUOTA_LOG_FILE:path.join(tmp,'quota.jsonl'),ROUTE_NOW:String(NOW),ROUTE_REQUEST_ID:'cli-1',ROUTE_SNAPSHOT_FILE:file};
    const cli=(args,raw)=>{fs.writeFileSync(file,JSON.stringify(raw));return JSON.parse(execFileSync(process.execPath,[route,...args,'--dry','--json'],{env,encoding:'utf8',maxBuffer:8<<20}));};
    for(const args of [['analysis'],['debug','--impact','service'],['lookup'],['research'],['review']]) {
      const raw=fixture(),o=cli(args,raw),p=routePure(o.plan.task,createSnapshot(raw));
      assert.equal(o.plan.planHash,p.planHash);assert.equal(o.kind,'launch');assert.ok(o.pick.command);assert.ok(o.why.length);
    }
    const companyUnavailable=fixture([['p','chatgpt',[SOL]],['company','ttadk',[SOL]]]);companyUnavailable.accounts[1].auth=false;
    for(const [args,raw,code] of [
      [['build-run','--signing','--sandbox','read-only'],fixture(),'SIGNING_FULL_ACCESS_REQUIRED'],
      [['computer-use'],fixture(),'APP_SCOPE_REQUIRED'],
      [['docs'],companyUnavailable,'PERSONAL_QUOTA_OK_REQUIRED']]) {
      const o=cli(args,raw);assert.equal(o.kind,'blocked');assert.equal(o.pick?.command??null,null);assert.ok(hasCode(o.plan,code));
    }
    const retry=cli(['debug','--impact','service','--actual',`codex:${ASTRA}:xhigh@company-b`],fixture([['company-b','trae',[SOL,ASTRA]]]));
    assert.equal(retry.pick.model,ASTRA);assert.ok(retry.why.length);
    for(const args of [['analysis','--exclude-models','gpt'],['analysis','--stakes'],['analysis','extra'],['analysis','--name','../private'],['analysis','--actual','malformed']]) {
      assert.throws(()=>execFileSync(process.execPath,[route,...args],{env,stdio:'pipe'}),(e)=>e.status===2);
    }
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
test('actual health storage rejects old success and superseded probe claims', () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pipeline-health-'));
  try {
    const now=NOW, day=(Math.floor(now/86400000)+1)*86400000;
    noteFailure(tmp,'Model access temporarily restricted (983)',now,SOL);
    for(const m of [SOL,FLASH,null]) noteSuccess(tmp,m);
    assert.ok(readPoolPauses(tmp,now).gpt);
    assert.equal(claimProbes(tmp,day-1).length,0);
    const [first]=claimProbes(tmp,day),[second]=claimProbes(tmp,day+11*60000);
    assert.equal(probeResult(tmp,SOL,true,'',day+12*60000,first.claim),false);
    noteFailure(tmp,'Model access temporarily restricted (983)',day+13*60000,SOL);
    assert.equal(probeResult(tmp,SOL,true,'',day+14*60000,second.claim),false);
    const [latest]=claimProbes(tmp,day+86400000);
    assert.equal(probeResult(tmp,SOL,true,'',day+86400000+1,latest.claim),true);
    assert.equal(readPoolPauses(tmp,day+86400000+2).gpt,undefined);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('V16 required two-family adversarial set and scarce reviewer gate', () => {
  const t = task('review-high', { flags: { security: true,'review-class':'D','review-reason':'named adversarial review' }, artifactRevision: 'artifact-1' });
  const raw = fixture([['a', 'ttadk', [KIMI]], ['b-company', 'trae', [FLASH]]]);
  const p = run(t, raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.modelId, KIMI); assert.equal(p.reviewers[0].candidate.modelId, FLASH);
  assert.equal(p.gates.some((g) => /GPT\/Claude/.test(g.reason.text)), false);
  const pending = run(t, fixture([['a', 'ttadk', [KIMI]]])); assert.equal(pending.kind,'launch');assert.ok(pending.gates.some(g=>g.phase==='acceptance'&&g.reason.code==='REVIEWER_PENDING'));
});
test('V17 approval role/time/revocation/effort scope, separate max action', () => {
  const raw = fixture([['p', 'chatgpt', [SOL]],['company','ttadk',[SOL]]]); raw.accounts[1].auth=false;
  let t = task(); const c = candidate(createSnapshot(raw), 'p', SOL, 'medium');
  t = approve(raw, t, c); assert.equal(run(t, raw).kind, 'launch');
  for (const change of [(a) => a.revoked = true, (a) => a.expiresAt = NOW, (a) => a.grantedAt = NOW + 1,
    (a) => a.scopes[0].roles = ['second'], (a) => a.scopes[0].taskId = 'wrong', (a) => a.scopes[0].efforts = ['max']]) {
    const copy = clone(raw); change(copy.approvals[0]); noCommand(run(t, copy));
  }
  const s = createSnapshot(fixture()), max = candidate(s, 'company-b', SOL, 'max');
  assert.equal(pScopedApproval(task(), s, max).ok, true);
  assert.equal(pScopedApproval(task(), s, candidate(s, 'company-a', SOL, 'max')).ok, true);
  const personal=createSnapshot(fixture([['p','chatgpt',[SOL]]]));
  assert.equal(pScopedApproval(task(),personal,candidate(personal,'p',SOL,'max')).reason.code,'MAX_EFFORT_OK_REQUIRED');
});
test('V18 old success does not clear a hard restriction generation', () => {
  const raw = fixture([['a', 'trae', [SOL]]]); raw.health = [{ accountId: 'a', family: 'gpt', restricted: true, until: NOW - 1, generation: 'g2', recovery: 'cleared', evidence: true,
    probe: { generation: 'g1', claimed: true, due: true, success: true, startedAt: NOW - 1, completedAt: NOW } }];
  noCommand(run(task(), raw)); raw.health[0].probe.generation = 'g2'; assert.equal(run(task(), raw).kind, 'launch');
});
test('V19 malformed optional cards, null health and observation chronology', () => {
  const raw = fixture(); raw.accounts[0].resets = { count: 1 }; assert.equal(run(task(), raw).kind, 'launch');
  raw.accounts[0].auth = { status: 'KNOWN', value: true, sampledAt: NOW - 500, receivedAt: NOW, maxAgeMs: 600000 };
  assert.equal(createSnapshot(raw).accounts[0].auth.status, 'KNOWN'); raw.accounts[0].auth.sampledAt = NOW + 1;
  assert.equal(createSnapshot(raw).accounts[0].auth.status, 'UNKNOWN'); raw.health = null;
  noCommand(run(task(), raw));
});
test('V20 local test build keeps preaction gate; remote has none', () => {
  const raw = fixture([['a', 'ttadk', [SOL]]]);
  let p = run(task('build-run', { flags: { env: 'test' } }), raw); assert.equal(p.kind, 'launch'); assert.ok(p.gates.some((g) => g.kind === 'local-resource-admission'));
  p = run(task('build-run', { flags: { env: 'test', 'no-local-build': true } }), raw); assert.equal(p.kind, 'launch'); assert.ok(!p.gates.some((g) => g.kind === 'local-resource-admission'));
});
test('V21 background uses no-company standing personal permission and scoped approval', () => {
  const raw = fixture([['p', 'chatgpt', [SOL]]]); let t = task('analysis', { background: true }); t = approve(raw, t, candidate(createSnapshot(raw), 'p', SOL, 'medium'));
  const p = run(t, raw); assert.equal(p.kind,'launch');assert.equal(p.primary.candidate.accountId,'p');
});
test('V22 device registration, own-app scope and bounded lease', () => {
  const raw = fixture([['a', 'ttadk', [SOL]]]), t = task('build-run', { deviceId: 'test-phone', ownTestApp: true });
  noCommand(run(t, raw)); raw.resources.devices = { 'test-phone': { registered: true, personal: false, ownTestApp: true, leaseMinutes: 120 } };
  assert.equal(run(t, raw).kind, 'launch'); raw.resources.devices['test-phone'].leaseMinutes = 121; noCommand(run(t, raw));
});
test('V23 live/cancel-unknown/resource-held hops cannot duplicate work', () => {
  for (const state of ['starting', 'running', 'queued', 'cancel-pending', 'UNKNOWN']) {
    const p = run(task('analysis', { previousAttempts: [attempt(SOL, 'medium', { state })] }), fixture()); noCommand(p); assert.ok(hasCode(p, 'ATTEMPT_RECONCILIATION_REQUIRED'));
  }
  const t = task('analysis', { autoRerouteDepth: 1, previousAttempts: [attempt(SOL, 'medium', { state: 'cancelled-no-work', usefulWork: false, cancellationEvidenceId: 'cancel-proof' })] });
  const raw = fixture(); assert.equal(run(t, raw).kind, 'launch'); raw.resources.held = true; noCommand(run(t, raw));
});
test('V24 pure module boundary and ambient clock denial', () => {
  const directory = fileURLToPath(new URL('../lib/pipeline/', import.meta.url));
  for (const f of fs.readdirSync(directory).filter((f) => f.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(directory, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:|Date\.now\s*\(|process\.(?:env|argv|cwd)|Math\.random\s*\(|\bfetch\s*\(/, f);
  }
  const before = Date.now; Date.now = () => { throw Error('ambient clock forbidden'); };
  try { assert.equal(run(task(), fixture()).kind, 'launch'); } finally { Date.now = before; }
});
test('V25 strict input fails before state access', () => {
  const context = { taskId: 't', requestId: 'r' };
  for (const [argv, code] of [[['review', '--exclude-models', 'gpt'], 'UNKNOWN_OPTION'], [['review', '--exclude-account'], 'MISSING_OPTION_VALUE'],
    [['review', '--exclude-account', '--json'], 'MISSING_OPTION_VALUE'], [['analysis', '--stakes', 'huge'], 'INVALID_ENUM'],
    [['analysis', '--failures', 'NaN'], 'INVALID_NUMBER'], [['review', '--json', '--json'], 'REPEATED_OPTION'],
    [['analysis', '--writes', '--read-only'], 'CONFLICTING_FLAGS'], [['build-run', '--execution', 'remote', '--shared-lock'], 'EXECUTION_CONFLICT'],
    [['analysis', '--json=true'], 'UNKNOWN_OPTION'], [['analysis', 'extra'], 'INVALID_CATEGORY']]) assert.throws(() => parseTaskSpec(argv, context), (e) => e.code === code && e.exitCode === 2);
  assert.equal(parseTaskSpec(['--table', '--json']).kind, 'table');
});

test('equal-quality company ETA and explicit personal bypass', () => {
  const raw = fixture(); raw.lanes[0].readyAt = NOW + 1000000;
  Object.assign(raw.lanes[1],{loadPercent:10,loadSource:'model'});
  assert.equal(run(task(), raw).primary.candidate.accountId, 'company-b');
  let t = task(); t = approve(raw, t, candidate(createSnapshot(raw), 'personal', SOL, 'medium'));
  assert.notEqual(run(t, raw).primary.candidate.accountId, 'personal');
  raw.lanes[1].readyAt = NOW + 2000000; raw.approvals[0].scopes[0].allowPersonalWithCompany = true;
  assert.equal(run(t, raw).primary.candidate.accountId, 'personal');
});
test('light zero-priority and background expiring TTADK policy', () => {
  const raw = fixture(); raw.lanes[1].mode = 'bucket-free'; raw.lanes[1].readyAt = NOW + 600000;
  assert.equal(run(task('lookup'), raw).primary.candidate.accountId, 'company-a'); // Foreground ETA retains the ready TTADK lane; Sol is not a light transfer candidate.
  assert.equal(run(task('analysis', { background: true }), raw).primary.candidate.accountId, 'company-a','ready company lane precedes delayed bucket-free lane');
  raw.accounts[0].quota = [{ bucketId: 'daily', unit: 'tokens', usage: { used: 10, limit: 100, resetsAt: NOW + 3600000 }, priority: 'available' }];
  raw.accounts[0].burn = { projectedAtReset: 40, resetsAt: NOW + 3600000 };
  assert.equal(run(task('analysis', { background: true }), raw).primary.candidate.accountId, 'company-a');
});
test('unknown ETA remains optimistic, bounded and explicitly uncertain', () => {
  const raw = fixture([['a', 'trae', [SOL]]]); raw.lanes[0].mode = 'low-priority'; raw.lanes[0].readyAt = null;
  const p = run(task(), raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.estimate.confidence, 'UNKNOWN');
  assert.equal(p.primary.estimate.startDelayMin, null); assert.equal(p.primary.estimate.patienceMin, 30);
});
test('fresh stalled lanes rank after runnable lanes and never get an optimistic ETA', () => {
  const raw=fixture([['a','ttadk',[SOL]],['b-company','trae',[ASTRA]]]);
  Object.assign(raw.lanes[1],{mode:'bucket-free',position:181,drainPerMin:0,state:'waiting',progressAt:null});
  for(const background of [false,true]) assert.equal(run(task('debug',{background}),raw).primary.candidate.accountId,'a');
  const snapshot=createSnapshot(raw),e=estimateCandidate(task('debug'),snapshot,candidate(snapshot,'b-company',ASTRA,'xhigh'));
  assert.equal(e.confidence,'STALLED');assert.equal(e.startDelayMin,null);assert.equal(e.completionMin,null);
  const only=fixture([['b-company','trae',[ASTRA]]]);Object.assign(only.lanes[0],raw.lanes[1],{id:'b:gpt-6-astra',accountId:'b-company'});
  const p=run(task('debug'),only);noCommand(p);assert.equal(p.kind,'defer');assert.equal(p.reason.code,'ETA_STALLED');
  const waiting=fixture([['b-company','trae',[ASTRA]]]);Object.assign(waiting.lanes[0],{position:null,drainPerMin:null,state:'waiting'});
  assert.equal(run(task('debug'),waiting).reason.code,'ETA_STALLED');
  const personal=fixture([['b-company','trae',[ASTRA]],['personal','chatgpt',[SOL]]]);Object.assign(personal.lanes[0],{position:181,drainPerMin:0,state:'waiting'});
  const approved=approve(personal,task('debug'),candidate(createSnapshot(personal),'personal',SOL,'xhigh'),'personal-quota',true);
  assert.equal(run(approved,personal).primary.candidate.accountId,'personal','scoped runnable personal capacity also ranks before a stalled company lane');
});
test('normal and light ladders use demonstrated free capacity; unknown load gains no free-lane preference', () => {
  const terra='gpt-5.6-terra', sol56='gpt-5.6-sol';
  const raw=fixture([['company-b','trae',[SOL,sol56,terra]]]);
  Object.assign(raw.lanes[0],{mode:'low-priority',progressAt:NOW,state:'ready'});
  Object.assign(raw.lanes[1],{mode:'low-priority',progressAt:NOW,state:'ready'});
  Object.assign(raw.lanes[2],{mode:'priority',loadPercent:20,loadSource:'model'});
  for(const category of ['analysis','research','implement','docs','review','lookup','extract','draft','build-run','browser']) {
    const p=run(task(category,category==='browser'?{allowedOrigins:['https://example.test']}:{}),raw);assert.equal(p.kind,'launch',category);
    assert.equal(p.primary.candidate.modelId,terra,category);
  }
  const depleted=clone(raw);depleted.lanes[2].mode='low-priority';
  assert.equal(run(task('analysis'),depleted).primary.candidate.modelId,SOL);
  const congested=clone(raw);congested.lanes[2].loadPercent=70;
  assert.equal(run(task('analysis'),congested).primary.candidate.modelId,SOL,'congested priority cannot displace a progressing lane');
  const hard=fixture([['company-b','trae',[SOL,ASTRA,terra]]]);
  Object.assign(hard.lanes[0],{mode:'low-priority',progressAt:NOW,state:'ready'});
  assert.equal(run(task('debug'),hard).primary.candidate.modelId,SOL,'hard work never demotes to priority Terra');
});
test('light work keeps its ladder when depleted Sol would finish sooner', () => {
  const raw=fixture([['company-b','trae',[SOL,'gpt-5.6-terra']]]);
  Object.assign(raw.lanes[0],{mode:'low-priority',progressAt:NOW,state:'ready'});
  Object.assign(raw.lanes[1],{mode:'priority',position:20,drainPerMin:4});
  const p=run(task('lookup'),raw);assert.equal(p.primary.candidate.modelId,'gpt-5.6-terra');
});
test('runnable measured company queue beats reset; auth cannot project recovery', () => {
  const raw = fixture([['a', 'ttadk', [SOL]], ['b-company', 'trae', [SOL]]]); raw.accounts[0].providerDenied = true; raw.accounts[0].denialResetAt = NOW + 600000;
  Object.assign(raw.lanes[1], { mode: 'low-priority', position: 500, drainPerMin: 1 });
  let p = run(task(), raw); assert.equal(p.kind, 'launch');assert.equal(p.primary.candidate.accountId,'b-company');
  raw.accounts[0].auth = false; p = run(task(), raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'b-company');
  raw.accounts[0].auth = true; raw.accounts[0].providerDenied = false; raw.accounts[0].quota = [{ bucketId: 'daily', unit: 'tokens', usage: { used: 100, limit: 100, resetsAt: NOW + 600000 }, priority: 'depleted' }];
  assert.equal(run(task(), raw).primary.candidate.accountId, 'a');
});
test('expected finish only compares work with sufficient own account/model history', () => {
  // Pure snapshots and scoped fixture approvals: no caller home, policy or outcomes.
  const main = 'gpt-6.2-astra', companySol = 'gpt-6.2-sol';
  const replay = ({ company = [], companyStart = 0, lowStart = false, companySolRuns = [], pooled = [] } = {}) => {
    const raw = fixture([['main', 'chatgpt', [main]], ['trae', 'trae', [ASTRA, ...(companySolRuns.length ? [companySol] : [])]]]);
    for (const l of raw.lanes.filter(l => l.accountId === 'trae'))
      Object.assign(l, { loadPercent: 10, loadSource: 'model' });
    if (companyStart && !lowStart) Object.assign(raw.lanes[1], { position: companyStart * 10, drainPerMin: 10, state: 'queued' });
    if (lowStart) {
      Object.assign(raw.lanes[1], { mode: 'low-priority', lowStart: companyStart });
      raw.accounts[1].quota = [{ bucketId: ASTRA, usage: { used: 58, limit: 58, remaining: 0, resetsAt: NOW + 60 * 60000 } }];
    }
    const outcomes = (accountId, modelId, times, attributed = true) => times.map((minutes, i) => ({
      attemptId: `eta-${accountId}-${modelId}-${attributed}-${i}`, accountId, modelId, attributed, minutes,
      category: 'implement-hard', effort: 'xhigh',
    }));
    raw.etaHistory = [...outcomes('main', main, [50, 51.5, 53]), ...outcomes('trae', ASTRA, company),
      ...outcomes('trae', companySol, companySolRuns), ...outcomes('trae', ASTRA, pooled, false)];
    let t = task('implement-hard');
    const c = candidate(createSnapshot(raw), 'main', main, 'xhigh');
    t = approve(raw, t, c, 'personal-quota', true);
    t = approve(raw, t, c, 'astra');
    const snapshot = createSnapshot(raw), plan = routePure(t, snapshot);
    assert.equal(plan.kind, 'launch');
    const lane = (accountId, modelId) => plan.trace.candidates.find(r => r.candidate.accountId === accountId
      && r.candidate.modelId === modelId && r.candidate.effort === 'xhigh');
    assert.ok(lane('main', main).predicates.every(p => p.ok), 'main is a qualified competitor');
    assert.ok(lane('trae', ASTRA).predicates.every(p => p.ok), 'company Astra is a qualified competitor');
    const { accountId, modelId } = plan.primary.candidate;
    return { pick: [accountId, modelId], estimate: lane('trae', ASTRA).estimate,
      why: renderPlan(plan, { snapshot, root: '/fixture' }).why.join(' ') };
  };
  const observed = replay({ companySolRuns: [70, 72.7, 75], pooled: Array(7).fill(76.8) });
  assert.deepEqual(observed.pick, ['trae', ASTRA]);
  assert.equal(observed.estimate.workBasis, 'category history');
  assert.equal(observed.estimate.workMin, 76.8);
  assert.match(observed.why, /work time not compared.*trae\/gpt-6-astra \(pooled estimate\).*start delay only/);
  assert.match(observed.why, /work time compared between lanes with measured account\/model history/);
  const insufficient = replay({ company: [90, 95], pooled: [99] });
  assert.deepEqual(insufficient.pick, ['trae', ASTRA]);
  assert.equal(insufficient.estimate.confidence, 'fallback', 'unattributed samples cannot satisfy the own-history minimum');
  const slower = replay({ company: [54, 55, 56] });
  assert.equal(slower.estimate.confidence, 'measured');
  assert.deepEqual(slower.pick, ['main', main], 'measured company work over 3 minutes slower loses');
  assert.doesNotMatch(slower.why, /work time not compared/);
  assert.deepEqual(replay({ company: [53, 54.5, 56] }).pick, ['trae', ASTRA], 'the 3-minute company band is inclusive');
  assert.deepEqual(replay({ company: [44, 45, 46] }).pick, ['trae', ASTRA], 'faster measured company work wins');
  for (const [lowStart, basis] of [[false, 'queue'], [true, 'observed-start']]) {
    const delayed = replay({ companyStart: 4, lowStart, pooled: [1, 2, 3] });
    assert.equal(delayed.estimate.basis, basis);
    assert.equal(delayed.estimate.startDelayMin, 4);
    assert.deepEqual(delayed.pick, ['main', main], 'startup greater than 3 minutes loses even with an optimistic pooled estimate');
  }
});
test('incomparable costs omit term for the entire cohort and sort transitively', () => {
  const raw = fixture([['a', 'ttadk', [SOL]], ['b-company', 'ttadk', [SOL]], ['c', 'ttadk', [SOL]]]);
  raw.lanes.forEach((l, i) => l.costs = [{ bucketId: i === 1 ? 'other' : 'one', unit: 'tokens', normalizedShare: 0.3 - i * 0.1 }]);
  const s = createSnapshot(raw), t = task(), rows = enumerateCandidates(t, s).candidates.filter((c) => c.effort === 'medium').map((c) => ({ candidate: c, estimate: estimateCandidate(t, s, c) }));
  const expected = ['a', 'b-company', 'c'];
  for (const perm of [rows, [...rows].reverse(), [rows[1], rows[2], rows[0]]]) { const ordered = orderCandidates(t, s, perm); assert.equal(ordered.terms.costComparable, false); assert.deepEqual(ordered.rows.map((r) => r.candidate.accountId), expected); }
});
test('direct progress overrides coarse congested family load', () => {
  const raw = fixture([['a', 'trae', [SOL]]]); Object.assign(raw.lanes[0], { mode: 'low-priority', progressAt: NOW, loadPercent: 99, loadSource: 'family' });
  const p = run(task(), raw); assert.equal(p.primary.estimate.basis, 'progressing');
});
test('analyze adapter never invents auth or drops registered company peers', () => {
  const raw = fixture(); delete raw.accounts;
  const s = snapshotFromAnalyze({ codex: { ttadk: { name: 'legacy', kind: 'ttadk', usable: true, models: [SOL] }, rows: [] } }, raw);
  assert.equal(s.accounts[0].auth.status, 'UNKNOWN'); assert.ok(s.diagnostics.length);
});
test('analyze quota and direct lane timestamps survive adaptation without freshening', () => {
  const metadata = fixture([['a', 'ttadk', [SOL]]]); delete metadata.accounts[0].quota; delete metadata.accounts[0].catalog;
  delete metadata.lanes[0].position; delete metadata.lanes[0].drainPerMin;
  metadata.analysisSampledAt = NOW - 600001;
  metadata.laneTelemetry = { a: { [SOL]: { t: NOW - 100, position: 50, drainPerMin: 2, lastProgressAt: NOW - 50 } } };
  const analyzed = { codex: { ttadk: { name: 'a', kind: 'ttadk', models: [SOL], usage: { used: 10, limit: 100, resetsAt: NOW + 3600000 } } } };
  let s = snapshotFromAnalyze(analyzed, metadata); assert.equal(s.accounts[0].catalog.status, 'UNKNOWN'); assert.equal(s.accounts[0].quota[0].usage.status, 'UNKNOWN');
  assert.equal(s.lanes[0].position.value, 50); assert.equal(s.lanes[0].position.sampledAt, NOW - 100);
  metadata.analysisSampledAt = NOW; s = snapshotFromAnalyze(analyzed, metadata); assert.equal(s.accounts[0].quota[0].usage.value.used, 10);
});
test('snapshots/tasks are frozen and aliases/order have identical plans', () => {
  const raw = fixture(), t = task(), s = createSnapshot(raw), before = stable(raw), p = routePure(t, s);
  assert.throws(() => s.accounts.push({})); assert.throws(() => t.flags.security = true); assert.equal(stable(raw), before);
  raw.accounts.reverse(); raw.models.reverse(); raw.lanes.reverse(); raw.accounts.forEach((a) => a.catalog = a.catalog.map((id) => id.toUpperCase())); raw.models.forEach((m) => m.id = m.id.toUpperCase()); raw.lanes.forEach((l) => l.modelId = l.modelId.toUpperCase());
  assert.deepEqual(run(t, raw), p);
});
test('UNKNOWN schemas and malformed observation components never become healthy', () => {
  for (const raw of [null, 7, [], { accounts: null }, { models: 'bad', lanes: 3 }, Object.freeze({ schemaVersion: VERSION, id: 'fake', accounts: null })]) assert.doesNotThrow(() => routePure(task(), raw));
  for (const bad of [null, 7, [], 'bad', { status: 'KNOWN', value: true }, { status: 'KNOWN', value: true, sampledAt: NOW - 600001, receivedAt: NOW }]) {
    const raw = fixture([['a', 'ttadk', [SOL]]]); raw.accounts[0].auth = bad;
    assert.equal(createSnapshot(raw).accounts[0].auth.status, 'UNKNOWN'); noCommand(run(task(), raw));
  }
  const raw = fixture(); raw.schemaVersion = 'unsupported'; noCommand(run(task(), raw));
  raw.schemaVersion = VERSION; raw.health = [null]; noCommand(run(task(), raw));
});
test('retained snapshot JSON replays exactly and real quality failures raise the code tier', () => {
  const raw = fixture(), t = task(), s = createSnapshot(raw);
  assert.deepEqual(routePure(t, JSON.parse(JSON.stringify(s))), routePure(t, s));
  const retry = task('implement', { failures: 0, previousAttempts: [attempt(SOL, 'high', { failureKind: 'quality' })] });
  assert.equal(retry.failures, 1); assert.equal(retry.tier, 'hard');
  const p = run(retry, raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.effort, 'xhigh');
  assert.equal(task('implement', { previousAttempts: [attempt(SOL, 'high')] }).failures, 0);
});
test('fresh approval cannot authorize another task, changed scopes or a future reviewer', () => {
  const raw = fixture([['p', 'chatgpt', [SOL]],['company','ttadk',[SOL]]]); raw.accounts[1].auth=false;
  let t = task('browser', { allowedOrigins: ['https://example.test'] });
  t = approve(raw, t, candidate(createSnapshot(raw), 'p', SOL, 'medium'));
  assert.equal(run(t, raw).kind, 'launch');
  for (const patch of [{ role: 'second' }, { taskId: 'new-task' }, { allowedOrigins: ['https://different.test'] }, { artifactRevision: 'different-artifact' }]) noCommand(run(createTaskSpec({ ...t, ...patch }), raw));
  const s = createSnapshot(raw), c = candidate(s, 'p', SOL, 'max'), missing = pScopedApproval(t, s, c);
  assert.deepEqual(missing.gates.map((g) => g.kind), ['personal-quota', 'max-effort']);
});
test('approved single-family exception is explicit; required reviewer is not silently dropped', () => {
  const raw = fixture([['a', 'ttadk', [KIMI]]]); let t = task('review-high', { flags: { security: true,'review-class':'D','review-reason':'named adversarial review' }, artifactRevision: 'artifact-1' });
  const c = candidate(createSnapshot(raw), 'a', KIMI, 'high'); t = approve(raw, t, c, 'scarce-reviewer');
  assert.equal(run(t, raw).kind, 'launch');
  const unapproved = createTaskSpec({ ...t, approvalRefs: [] });const pending=run(unapproved, raw);assert.equal(pending.kind,'launch');assert.ok(pending.gates.some(g=>g.phase==='acceptance'&&g.reason.code==='REVIEWER_PENDING'));
});
test('unresolved history, exhausted repeats, partial relations and explicit escalation', () => {
  const raw = fixture([['a', 'ttadk', [SOL, ASTRA]]]);
  noCommand(run(parseTaskSpec(['analysis', '--previous-attempt', 'missing'], { taskId: 'task-1', requestId: 'r' }), raw));
  const s = createSnapshot(raw), c = candidate(s, 'a', SOL, 'high');
  assert.equal(pPreviousFloor(task('analysis', { previousAttempts: [attempt(SOL, 'high', { failureKind: 'quality' })] }), s, c).reason.code, 'QUALITY_REPEAT_REQUIRES_DECISION');
  assert.equal(dominates(c, { modelId: KIMI, effort: 'high' }, s), false);
  raw.qualityRelations = [{ from: `${KIMI}:high`, to: `${SOL}:high`, version: VERSION, evidenceId: 'approved-transition' }];
  assert.equal(dominates(c, { modelId: KIMI, effort: 'high' }, createSnapshot(raw)), true);
  const escalated = task('analysis', { selectionCause: 'quality-escalation', qualityEscalation: { modelId: ASTRA, policyVersion: VERSION, evidenceId: 'approved-existing-stage' } });
  assert.equal(pTierFloor(escalated, s, candidate(s, 'a', ASTRA)).ok, true);
});
test('canonical launch tuple rejects forged model family and constraint hashes', () => {
  const raw = fixture(), s = createSnapshot(raw), t = task(), c = candidate(s);
  assert.equal(pAvailable(t, s, { ...c, family: 'kimi' }).ok, false);
  const p = run(t, raw), copy = clone(p); copy.primary.task.constraintHash = 'unrelated';
  assert.equal(validatePlan(copy, s).ok, false);
  assert.equal(validatePlan(p, s, { proposed: { ...p.primary.candidate, taskId: t.taskId, routeId: p.routeId, planHash: p.planHash, role: t.role, sandbox: t.sandbox } }).ok, true);
});
test('adversarial policy lock precedes light conservation and ETA', () => {
  const raw = fixture([['a', 'ttadk', [KIMI]], ['b-company', 'trae', [FLASH]]]); raw.lanes[0].readyAt = NOW + 600000; raw.lanes[1].mode = 'bucket-free';
  const p = run(task('lookup', { flags: { adversarial: true } }), raw); assert.equal(p.primary.candidate.modelId, KIMI);
  const sameRung=fixture([['a','ttadk',[FLASH]],['b-company','trae',[FLASH]]]);
  Object.assign(sameRung.lanes[1],{mode:'low-priority',progressAt:NOW,drainPerMin:5,queueState:'ready',loadPercent:70,loadSource:'model'});
  const hot=run(task('review',{flags:{adversarial:true}}),sameRung);assert.equal(hot.primary.candidate.accountId,'a');
  sameRung.lanes[1].loadPercent=40;
  const free=run(task('review',{flags:{adversarial:true}}),sameRung);assert.equal(free.primary.candidate.accountId,'b-company');
});
test('ordinary class-A release preserves the pending independent strong family obligation', () => {
  const raw=fixture([['a','ttadk',[SOL]],['p','claude',['opus']]]);
  const p=run(task('review',{flags:{'review-class':'A','review-reason':'external irreversible release'},impact:'release',artifactRevision:'artifact-1'}),raw);
  assert.equal(p.kind,'launch');assert.equal(p.primary.candidate.family,'gpt');
  assert.equal(p.reviewers.length,0);assert.equal(p.reviewerProposals[0].candidate.family,'claude');
  assert.ok(p.gates.some(g=>g.kind==='independent-review'&&g.phase==='acceptance'));assert.ok(p.gates.some(g=>g.kind==='personal-quota'));
});

// Product oracle is deliberately separate from enumerateCandidates.
function productOracle(raw) {
  const out = [];
  for (const a of raw.accounts) for (const id of a.catalog) for (const l of raw.lanes) if (l.accountId === a.id && l.modelId === id) {
    const m = raw.models.find((m) => m.id === id);
    for (const effort of m.efforts) if (l.efforts.includes(effort)) out.push([a.id, id, l.id, l.harness, effort].join('|'));
  }
  return out.sort();
}
const rand = (seed) => { let x = seed >>> 0; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; };
const seeds = Number(process.env.PIPELINE_SEEDS ?? 10000);
let generated = 0, launches = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const r = rand(seed), choice = (xs) => xs[Math.floor(r() * xs.length)];
  const cat = choice(['lookup', 'analysis', 'research', 'debug', 'build-run', 'browser', 'computer-use', 'review']);
  const ids = [SOL, ASTRA, FLASH, 'gpt-5.6-terra'];
  const spec = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => [`a${i}`, choice(['ttadk', 'trae', 'chatgpt']), ids.filter(() => r() > 0.5)]);
  const raw = fixture(spec), extra = { role: choice(['primary', 'second', 'finisher']), background: r() < 0.2,
    allowedApps: cat === 'computer-use' ? ['com.example.calc'] : [], allowedOrigins: cat === 'browser' ? ['https://example.test'] : [],
    flags: r() < 0.2 ? { adversarial: true } : {}, requirements: r() < 0.2 ? { executableAcceptance: true } : {} };
  if (r() < 0.2) extra.previousAttempts = [attempt(choice(ids), choice(['medium', 'high', 'xhigh']), { role: extra.role })];
  for (const a of raw.accounts) { a.auth = choice([true, true, false, null]); a.transport = choice([true, true, false, null]); for (const key of ['search', 'browser', 'vision', 'desktop-tool']) a.capabilities[key] = choice([true, true, false, null]); }
  for (const l of raw.lanes) { l.mode = choice(['priority', 'low-priority', 'bucket-free', 'UNKNOWN']); l.readyAt = choice([NOW, NOW + 600000, null]); }
  const t = task(cat, extra);
  try {
    const s = createSnapshot(raw), enumeration = enumerateCandidates(t, s);
    assert.deepEqual(enumeration.candidates.map((c) => [c.accountId, c.modelId, c.laneId, c.harness, c.effort].join('|')).sort(), productOracle(raw));
    const p = routePure(t, s);
    if (p.kind === 'launch') launches++;
    for (const seat of p.kind === 'launch' ? [p.primary, ...p.reviewers] : []) {
      const c = seat.candidate, a = raw.accounts.find((a) => a.id === c.accountId), st = seat.task;
      assert.ok(!raw.accounts.some(a=>['ttadk','trae'].includes(a.kind))||['ttadk','trae'].includes(a.kind),
        'without approvals, personal launches require a device with no company account');
      if(a.kind==='chatgpt') assert.notEqual(c.modelId,ASTRA,'personal Astra never launches without its own scoped approval');
      if (st.contentLabels.includes('adversarial')) assert.notEqual(c.family, 'gpt');
      if (st.category === 'build-run' || st.requirements.executableAcceptance) assert.notEqual(c.family, 'deepseek');
      if (st.tier !== 'hard') assert.notEqual(c.modelId, ASTRA);
      for (const prior of st.previousAttempts) if (prior.actual.modelId === c.modelId) assert.ok(EFFORTS.indexOf(c.effort) >= EFFORTS.indexOf(prior.actual.effort));
      if (st.previousAttempts.some((a) => a.actual.modelId === ASTRA)) assert.equal(c.modelId, ASTRA);
      for (const cap of st.capabilitiesNeeded) assert.equal(a.capabilities[cap], true);
      assert.ok(validatePlan(p, s).ok);
    }
    if (p.kind !== 'launch') noCommand(p);
    // Reordering every 20th generated input verifies full plan equality, not
    // just the winner. All other seeds exercise the exact product and rules.
    if (seed % 20 === 0) { const reversed = clone(raw); reversed.accounts.reverse(); reversed.models.reverse(); reversed.lanes.reverse(); assert.deepEqual(run(t, reversed), p); }
    // Optional malformed observations must not crash or remove good components.
    if (seed % 10 === 0) {
      const broken = clone(raw); if (broken.accounts[0]) broken.accounts[0].resets = choice([null, 7, { credits: null }, { credits: 'x' }]);
      assert.doesNotThrow(() => run(t, broken));
    }
    generated++;
    if (seed % 2500 === 0) console.log(`Generated snapshots: ${seed}/${seeds}; launch controls: ${launches}`);
  } catch (error) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-failure-'));
    fs.writeFileSync(path.join(out, 'case.json'), JSON.stringify({ seed, task: t, snapshot: raw, expected: 'generated hard invariants' }, null, 2));
    throw new Error(`Generated seed ${seed} failed; sanitized reproduction ${out}: ${error.stack}`);
  }
}
if (seeds >= 10000) assert.ok(launches > 100, 'generated invariants need positive launch controls');

// Stateful planner sequences: changing catalogs/quota/account health cannot
// erase the strongest *actual* attempt, and policy-block content is sticky.
const sequences = Number(process.env.PIPELINE_SEQUENCES ?? 1000);
let transitions = 0;
for (let seed = 1; seed <= sequences; seed++) {
  const r = rand(seed * 7919), steps = 1 + Math.floor(r() * 30);
  const attempts = [attempt(seed % 2 ? ASTRA : SOL, seed % 2 ? 'xhigh' : 'high')];
  let strongest = attempts[0].actual.modelId, floorEffort = EFFORTS.indexOf(attempts[0].actual.effort);
  for (let step = 0; step < steps; step++) {
    const raw = fixture([['a', 'ttadk', [SOL, ASTRA]], ['b-company', 'trae', [ASTRA]]]);
    raw.accounts[0].auth = r() > 0.15; raw.accounts[1].transport = r() > 0.15;
    raw.accounts[0].catalog = r() > 0.3 ? [SOL, ASTRA] : [SOL]; raw.accounts[1].catalog = r() > 0.3 ? [ASTRA] : [];
    raw.lanes[2].mode = r() > 0.5 ? 'priority' : 'low-priority';
    if (seed % 7 === 0 && step === 2) attempts.push(attempt(strongest, EFFORTS[floorEffort], { id: `policy-${seed}`, failureKind: 'policy-block' }));
    const t = task('debug', { previousAttempts: attempts }), p = run(t, raw);
    if (attempts.some((a) => a.failureKind === 'policy-block')) { noCommand(p); assert.ok(p.task.contentLabels.includes('adversarial')); }
    if (p.kind === 'launch') {
      const c = p.primary.candidate;
      if (strongest === ASTRA) assert.equal(c.modelId, ASTRA, `sequence ${seed}/${step}`);
      assert.ok(EFFORTS.indexOf(c.effort) >= floorEffort, `sequence effort ${seed}/${step}`);
      strongest = c.modelId; floorEffort = EFFORTS.indexOf(c.effort);
      attempts.push(attempt(c.modelId, c.effort, { id: `actual-${seed}-${step}`, actual: { ...c } }));
    }
    transitions++;
  }
}
console.log(`Pipeline: ${fixed} fixed cases, ${generated} generated snapshots (${launches} launch controls), ${sequences} sequences / ${transitions} transitions PASS.`);
