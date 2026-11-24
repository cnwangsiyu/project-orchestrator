#!/usr/bin/env node
// Synthetic snapshots, public cache fixtures and launch audits; no provider/hub calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTaskSpec, createSnapshot, routePure, renderPlan, enumerateCandidates, validatePlan } from '../lib/pipeline/index.mjs';
import { personalFallbackPolicy } from '../lib/pipeline/personal-fallback.mjs';
import { pScopedApproval } from '../lib/pipeline/filters.mjs';
import { acquireRoute } from '../lib/route-data.mjs';
import { VERSION } from '../lib/pipeline/common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-fallback-'));
const NOW = Date.now(), SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6.2-astra';
const policy = JSON.parse(fs.readFileSync(path.join(root, 'references/personal-fallback.json'), 'utf8'));
for (const [configured, expected] of [[undefined,1],[0,0],[3,3],[-1,0],[1.5,0]]) {
  assert.equal(personalFallbackPolicy({...policy,queueAutoChoiceAfterNotices:configured},NOW).queueAutoChoiceAfterNotices,expected);
}
const ref = 'standing:personal-fallback-2026-11-17';
const caps = { search: true, vision: true };
const task = extra => createTaskSpec({ category: 'analysis', taskId: 'pfb', requestId: 'pfb-request', project: 'fixture', ...extra });
function fixture(personalModels = [SOL], personalKind = 'chatgpt') {
  const accounts = [['ttadk', 'ttadk', [SOL]], ['trae', 'trae', [SOL]], ['main', personalKind, personalModels]];
  return { schemaVersion: VERSION, collectedFrom: NOW, collectedThrough: NOW, decisionAt: NOW,
    personalFallback: policy, health: [], approvals: [], dependencies: [], resources: { held: false, ownedReturned: true },
    accounts: accounts.map(([id, kind, catalog]) => ({ id, kind, catalog, auth: true, transport: true, health: true,
      capabilities: caps, providerDenied: false, quota: [] })),
    models: [...new Set(accounts.flatMap(a => a[2]))].map(id => ({ id, efforts: ['medium', 'high', 'xhigh', 'max'], capabilities: caps, largeOutput: true })),
    lanes: accounts.flatMap(([id, kind, catalog]) => catalog.map(modelId => ({ id: `${id}:${modelId}`, accountId: id, modelId,
      harness: 'hub', efforts: ['medium', 'high', 'xhigh', 'max'], mode: kind === 'trae' ? 'priority' : 'standard',
      selectable: true, readyAt: NOW, position: 0, drainPerMin: 1, queueState: 'ready', loadPercent: 10, loadSource: 'model', capabilities: caps }))) };
}
function deny(raw, id) {
  Object.assign(raw.accounts.find(a => a.id === id), { providerDenied: true, denialResetAt: NOW + 3600000 });
}
function queued(raw, minutes, extra = {}) {
  Object.assign(raw.lanes.find(l => l.accountId === 'trae'), { mode: 'low-priority', readyAt: null,
    position: minutes, drainPerMin: 1, queueState: 'queued', ...extra });
}
function companyAstra(raw, extra = {}, id = 'trae', model = 'gpt-6-astra') {
  const a=raw.accounts.find(a=>a.id===id),lane=raw.lanes.find(l=>l.accountId===id);
  a.catalog.push(model);
  if(!raw.models.some(m=>m.id===model))raw.models.push({...raw.models[0],id:model});
  const added={...lane,id:`${id}:${model}`,modelId:model,mode:'low-priority',readyAt:null,
    queueState:'queued',position:501,drainPerMin:0,...extra};
  raw.lanes.push(added);return added;
}
const run = (raw, t = task()) => routePure(t, createSnapshot(raw));
const view = (p, raw) => renderPlan(p, { snapshot: createSnapshot(raw), root, profiles: {} });
let count = 0;
function check(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
function launchesPersonal(raw, t = task()) {
  const p = run(raw, t), v = view(p, raw);
  assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'main');
  assert.equal(v.pick.approvalRef, ref); assert.ok(v.pick.command); assert.ok(!v.pick.workerArgs?.includes('--user-ok'));
  assert.ok(!p.gates.some(g => g.kind === 'personal-quota')); assert.deepEqual(v.needsUserOK, []);
  assert.ok(v.why.some(s => s.startsWith('personal fallback (standing user OK 2026-11-17):')));
  const validation = validatePlan(p, createSnapshot(raw));
  assert.equal(validation.ok, true, JSON.stringify(validation.checks.filter(c => !c.ok)));
  return { p, v };
}
try {
  check('TTADK remains available above zero regardless of remaining share or prior run cost', () => {
    const raw = fixture();
    raw.accounts[0].quota = [{ bucketId:'ttadk-daily',unit:'tokens',usage:{used:980,limit:1000,resetsAt:NOW+3600000} }];
    raw.runUsage = [80,130,300].map(cumulativeInput=>({t:NOW-1000,accountId:'ttadk',category:'analysis',cumulativeInput}));
    queued(raw,12);
    assert.equal(run(raw).primary.candidate.accountId,'ttadk');
  });
  check('company exhausted: personal Codex launches without task approval', () => {
    const raw = fixture(); deny(raw, 'ttadk'); deny(raw, 'trae'); launchesPersonal(raw);
  });
  check('hard task with company out launches personal Astra under standing permission', () => {
    const raw = fixture([SOL, 'gpt-6-astra', ASTRA]); deny(raw, 'ttadk'); deny(raw, 'trae');
    const { p, v } = launchesPersonal(raw, task({ category: 'implement-hard', impact: 'service' }));
    assert.equal(p.primary.candidate.modelId, ASTRA); assert.equal(p.task.tier, 'hard');
    assert.equal(v.pick.astraApprovalRef, 'standing:hard-astra-2026-11-17');
    assert.match(v.why.join('\n'), /personal Astra for hard-tier task.*standing user OK/);
    assert.ok(!p.gates.some(g => g.kind === 'astra'));
  });
  check('hard personal Astra requires the same long-queue fallback conditions', () => {
    for (const minutes of [4, 5, 6]) {
      const raw = fixture([ASTRA]); deny(raw, 'ttadk'); queued(raw, minutes);
      const t = task({ category: 'debug', impact: 'service', tier: 'hard' });
      if (minutes > 5) assert.equal(launchesPersonal(raw, t).p.primary.candidate.modelId, ASTRA);
      else assert.equal(run(raw, t).primary.candidate.accountId, 'trae');
    }
  });
  check('standing hard Astra applies to the hard tier across task categories', () => {
    for (const category of ['analysis', 'lookup', 'build-run']) {
      const raw = fixture([SOL, ASTRA]); deny(raw, 'ttadk'); deny(raw, 'trae');
      const { p } = launchesPersonal(raw, task({ category, stakes: 'high', impact: 'service' }));
      assert.equal(p.primary.candidate.modelId, ASTRA);
    }
  });
  check('hard personal Astra does not displace a ready company lane', () => {
    const raw = fixture([ASTRA]); queued(raw, 45);
    assert.equal(run(raw, task({ category: 'implement-hard', impact: 'service' })).primary.candidate.accountId, 'ttadk');
  });
  for(const condition of ['stalled','late','exhausted','restricted'])check(`hard Astra fallback beats ready lower-class company Sol: ${condition}`,()=>{
    const raw=fixture([SOL,ASTRA]),lane=companyAstra(raw);
    if(condition==='late')lane.drainPerMin=10;
    if(condition==='exhausted') {
      Object.assign(lane,{readyAt:NOW,queueState:'ready',position:0});
      raw.accounts[1].quota=[{bucketId:lane.modelId,usage:{used:58,limit:58,depleted:true,resetsAt:NOW+3600000}}];
    }
    if(condition==='restricted')raw.health=[{accountId:'trae',modelId:lane.modelId,restricted:true,generation:'astra-only',until:NOW+3600000}];
    const {p,v}=launchesPersonal(raw,task({category:'implement-hard',impact:'service'}));
    assert.equal(p.primary.candidate.modelId,ASTRA);assert.equal(p.primary.personalFallback.preferOverLowerCompany,true);
    assert.match(v.why.join('\n'),/personal Astra for hard task: company Astra.*company gpt-6.1-sol available as lower-class alternative/);
    assert.match(v.why.join('\n'),/task estimate.*chosen lane: personal.*start now.*alternatives:.*start now/);
    assert.ok(v.notes.some(s=>/task estimate.*lane: start now/.test(s)));
    assert.ok(!v.why.some(s=>/est\. ~|estimated completion/.test(s)));
    assert.ok(['ttadk','trae'].includes(run(raw).primary.candidate.accountId),'non-hard tasks still use a startable company row');
  });
  check('any ready or short-wait company Astra vetoes personal Astra, across accounts and releases',()=>{
    for(const wait of [0,4,5]) {
      const raw=fixture([ASTRA]);companyAstra(raw);
      companyAstra(raw,{readyAt:wait?null:NOW,position:wait,drainPerMin:1,queueState:wait?'queued':'ready',mode:'standard'},'ttadk','gpt-6.2-astra');
      assert.ok(['ttadk','trae'].includes(run(raw,task({category:'implement-hard',impact:'service'})).primary.candidate.accountId));
    }
  });
  check('unknown top-class ETA, absent Astra catalog, and manual exclusion are not stalled evidence',()=>{
    for(const condition of ['unknown','absent','excluded']) {
      const raw=fixture([ASTRA]);
      if(condition!=='absent')companyAstra(raw,condition==='unknown'?{position:null,drainPerMin:null}:{});
      const t=task({category:'implement-hard',impact:'service',...(condition==='excluded'?{flags:{'exclude-model':'gpt-6-astra'}}:{})});
      assert.ok(['ttadk','trae'].includes(run(raw,t).primary.candidate.accountId));
    }
  });
  check('hard-class fallback keeps max/reset, classified review and content gates',()=>{
    for(const condition of ['max','reset','review','security','adversarial','disabled']) {
      const raw=fixture([ASTRA]);companyAstra(raw);
      if(condition==='max')raw.lanes.find(l=>l.accountId==='main').efforts=['max'];
      if(condition==='disabled')raw.personalFallback={...policy,allowHardPersonalAstra:false};
      const t=task({category:'implement-hard',impact:'service',
        ...(condition==='reset'?{requirements:{resetRedemption:true}}:{}),
        ...(condition==='review'?{reviewClass:'B',reviewReason:'fixture classified review'}:{}),
        ...(['security','adversarial'].includes(condition)?{contentLabels:[condition]}:{})});
      const p=run(raw,t);assert.notEqual(p.primary?.candidate.accountId,'main');
    }
  });
  check('hard personal Astra keeps UNKNOWN company status gated', () => {
    const raw = fixture([ASTRA]); deny(raw, 'ttadk'); raw.accounts[1].auth = null;
    const p = run(raw, task({ category: 'implement-hard', impact: 'service' }));
    assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === 'astra'));
  });
  check('unknown account kinds cannot establish a personal-only device', () => {
    const raw = fixture([ASTRA]); for (const a of raw.accounts.slice(0, 2)) a.kind = 'UNKNOWN';
    const p = run(raw, task({ category: 'implement-hard', impact: 'service', flags: { 'exclude-account': 'ttadk,trae' } }));
    assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === 'astra'));
  });
  check('hard personal Astra cannot re-enable b, including on a personal-only device', () => {
    for (const personalOnly of [false, true]) {
      const raw = fixture([ASTRA]); deny(raw, 'ttadk'); deny(raw, 'trae');
      raw.accounts.find(a => a.id === 'main').id = 'b';
      for (const l of raw.lanes.filter(l => l.accountId === 'main')) { l.accountId = 'b'; l.id = `b:${l.modelId}`; }
      if (personalOnly) { raw.accounts = raw.accounts.filter(a => a.id === 'b'); raw.lanes = raw.lanes.filter(l => l.accountId === 'b'); }
      const p = run(raw, task({ category: 'implement-hard', impact: 'service' }));
      assert.notEqual(p.kind, 'launch');
      assert.ok(p.rejected.some(p => p.reason?.code === 'PERSONAL_B_REFUSED'));
    }
  });
  check('hard personal Astra disabled policy restores both decision gates', () => {
    for (const personalFallback of [{ ...policy, enabled: false }, { ...policy, allowHardPersonalAstra: false }]) {
      const raw = fixture([ASTRA]); deny(raw, 'ttadk'); deny(raw, 'trae'); raw.personalFallback = personalFallback;
      const p = run(raw, task({ category: 'implement-hard', impact: 'service' }));
      assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === 'astra'));
    }
  });
  check('hard personal Astra retains max-effort and reset gates', () => {
    for (const gate of ['max-effort', 'reset-redemption']) {
      const raw = fixture([ASTRA]); deny(raw, 'ttadk'); deny(raw, 'trae');
      if (gate === 'max-effort') raw.lanes.find(l => l.accountId === 'main').efforts = ['max'];
      const t = task({ category: 'implement-hard', impact: 'service', ...(gate === 'reset-redemption' ? { requirements: { resetRedemption: true } } : {}) });
      const p = run(raw, t); assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === gate));
      assert.ok(!p.gates.some(g => g.kind === 'astra'), 'standing Astra permission leaves the separate decision gate');
    }
  });
  check('separate max/reset approvals remain the spending reference for hard Astra', () => {
    for (const gate of ['max-effort', 'reset-redemption']) {
      const raw = fixture([ASTRA]); deny(raw, 'ttadk'); deny(raw, 'trae');
      if (gate === 'max-effort') raw.lanes.find(l => l.accountId === 'main').efforts = ['max'];
      const t = task({ category: 'implement-hard', impact: 'service', flags: { 'user-ok': 'separate-card' },
        ...(gate === 'reset-redemption' ? { requirements: { resetRedemption: true } } : {}) });
      const before = run(raw, t);
      raw.approvals = [{ id: 'separate-card', userDecisionRef: 'fixture-separate-decision', grantedAt: NOW - 1, expiresAt: NOW + 60000,
        revoked: false, scopes: before.gates.filter(g => g.scope).map(g => ({ ...g.scope, allowPersonalWithCompany: true })) }];
      const p = run(raw, t); assert.equal(p.kind, 'launch');
      const v = view(p, raw); assert.equal(v.pick.approvalRef, 'separate-card');
      assert.equal(v.pick.astraApprovalRef, 'standing:hard-astra-2026-11-17');
    }
  });
  check('authoritative TTADK daily exhaustion overrides nominal cached ready', () => {
    const raw = fixture(); deny(raw, 'trae');
    raw.accounts[0].quota = [{ bucketId: 'ttadk-daily', unit: 'tokens', authoritative: true,
      usage: { used: 100, limit: 100, resetsAt: NOW + 3600000 } }];
    assert.match(launchesPersonal(raw).v.why.join('\n'), /daily quota exhausted until/);
  });
  for (const minutes of [4, 5, 6, 45]) check(`TRAE low-priority predicted start ${minutes} min (threshold 5)`, () => {
    const raw = fixture(); deny(raw, 'ttadk'); queued(raw, minutes);
    if (minutes > 5) assert.match(launchesPersonal(raw).v.why.join('\n'), new RegExp(`predicted start ~${minutes} min.*> 5 min`));
    else { const p = run(raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'trae'); }
  });
  for (const extra of [{ drainPerMin: 0 }, { queueState: 'waiting', position: 0 }]) check(`flat/stalled low-priority queue: ${JSON.stringify(extra)}`, () => {
    const raw = fixture(); deny(raw, 'ttadk'); queued(raw, 1, extra);
    assert.match(launchesPersonal(raw).v.why.join('\n'), /flat\/stalled queue.*> 5 min/);
  });
  check('fast TTADK wins over slow TRAE', () => {
    const raw = fixture(); queued(raw, 45); const p = run(raw);
    assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'ttadk');
  });
  check('ready depleted TRAE remains company capacity', () => {
    const raw = fixture(); deny(raw, 'ttadk'); raw.lanes[1].mode = 'low-priority';
    const p = run(raw); assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'trae');
  });
  check('priority queues do not receive the low-priority exception', () => {
    const raw = fixture(); deny(raw, 'ttadk'); queued(raw, 45, { mode: 'priority' });
    assert.equal(run(raw).primary.candidate.accountId, 'trae');
  });
  check('faster company fallback model prevents personal spend', () => {
    const raw = fixture(); deny(raw, 'ttadk'); queued(raw, 45);
    const terra = 'gpt-5.6-terra'; raw.accounts[1].catalog.push(terra);
    raw.models.push({ ...raw.models[0], id: terra });
    raw.lanes.push({ ...raw.lanes[1], id: `trae:${terra}`, modelId: terra, mode: 'bucket-free', readyAt: NOW, position: 0, queueState: 'ready' });
    const p = run(raw); assert.equal(p.primary.candidate.accountId, 'trae'); assert.equal(p.primary.candidate.modelId, terra);
  });
  check('restricted and excluded company lanes support fallback', () => {
    const raw = fixture(); raw.health = [{ accountId: 'trae', restricted: true, generation: 'restriction-1', until: NOW + 3600000 }];
    launchesPersonal(raw, task({ exclusions: [{ scope: 'account', value: 'ttadk', cause: 'infrastructure' }] }));
  });
  check('infrastructure lane exclusions support standing fallback', () => {
    const raw = fixture(); launchesPersonal(raw, task({ flags: { 'exclude-lane': `ttadk:${SOL},trae:${SOL}` } }));
  });
  check('manual exclusions of healthy company accounts retain the quota gate', () => {
    const raw = fixture(); const p = run(raw, task({ flags: { 'exclude-account': 'ttadk,trae' } }));
    assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === 'personal-quota'));
  });
  check('disabled policy restores personal quota question', () => {
    const raw = fixture(); deny(raw, 'ttadk'); deny(raw, 'trae'); raw.personalFallback = { ...policy, enabled: false };
    const p = run(raw); assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === 'personal-quota'));
  });
  check('missing threshold defaults to 5, configurable threshold is respected', () => {
    const raw = fixture(); deny(raw, 'ttadk'); queued(raw, 6); raw.personalFallback = { ...policy }; delete raw.personalFallback.queueWaitMinutes;
    assert.equal(createSnapshot(raw).personalFallback.queueWaitMinutes, 5); launchesPersonal(raw);
    raw.personalFallback.queueWaitMinutes = 7; assert.equal(run(raw).primary.candidate.accountId, 'trae');
  });
  check('UNKNOWN-only company status keeps quota question', () => {
    for (const field of ['auth', 'transport', 'health', 'catalog']) {
      const raw = fixture(); for (const a of raw.accounts.slice(0, 2)) a[field] = { status: 'UNKNOWN', value: null };
      const p = run(raw); assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === 'personal-quota'));
    }
  });
  check('all marked-stale status does not authorize a long-queue fallback', () => {
    const raw = fixture(); deny(raw, 'ttadk'); queued(raw, 45);
    for (const a of raw.accounts.slice(0, 2)) a.auth = { status: 'KNOWN', value: true, sampledAt: NOW,
      receivedAt: NOW, source: 'last-good-stale' };
    const p = run(raw); assert.notEqual(p.primary?.candidate.accountId, 'main');
    assert.ok(p.trace.candidates.filter(r => r.candidate.accountId === 'main').some(r => r.predicates.some(p => p.gates?.some(g => g.kind === 'personal-quota'))));
  });
  check('infrastructure exclusions do not launder UNKNOWN-only status', () => {
    for (const [field, value] of [['auth', null], ['health', null], ['health', false]]) {
      const raw = fixture(); for (const a of raw.accounts.slice(0, 2)) a[field] = value === null ? { status: 'UNKNOWN', value: null } : value;
      const p = run(raw, task({ exclusions: ['ttadk', 'trae'].map(value => ({ scope: 'account', value, cause: 'infrastructure' })) }));
      assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === 'personal-quota'));
    }
  });
  check('persistent model restrictions support fallback despite stale status', () => {
    const raw = fixture(); for (const a of raw.accounts.slice(0, 2)) a.auth = null;
    raw.health = ['ttadk', 'trae'].map(accountId => ({ accountId, modelId: SOL, restricted: true, generation: 'model-restriction', until: NOW + 3600000 }));
    launchesPersonal(raw);
  });
  check('UNKNOWN company plus one exhausted account still asks', () => {
    const raw = fixture(); deny(raw, 'ttadk'); raw.accounts[1].catalog = null;
    assert.equal(run(raw).kind, 'blocked');
  });
  check('unknown queue ETA does not imply a long queue', () => {
    const raw = fixture(); deny(raw, 'ttadk'); queued(raw, 45, { position: null, drainPerMin: null });
    const p = run(raw); assert.equal(p.primary.candidate.accountId, 'trae'); assert.equal(p.primary.personalFallback, null);
  });
  check('stale explicit exhaustion survives status TTL, never its reset', () => {
    const raw = fixture(); for (const a of raw.accounts.slice(0, 2)) {
      a.auth = null; a.providerDenied = { status: 'KNOWN', value: true, sampledAt: NOW - 3600000, receivedAt: NOW - 3600000 };
      a.denialResetAt = NOW + 3600000;
    }
    launchesPersonal(raw); for (const a of raw.accounts.slice(0, 2)) a.denialResetAt = NOW - 1;
    assert.equal(run(raw).kind, 'blocked');
  });
  check('stale status without exhaustion does not grant standing approval', () => {
    const raw = fixture(); for (const a of raw.accounts.slice(0, 2)) a.auth = { status: 'KNOWN', value: true, sampledAt: NOW - 3600000, receivedAt: NOW - 3600000 };
    assert.equal(run(raw).kind, 'blocked');
  });
  check('fresh recovery clears retained negative capacity evidence', () => {
    const raw = fixture([SOL, ASTRA]); deny(raw, 'ttadk'); deny(raw, 'trae');
    const recovered = structuredClone(createSnapshot(raw));
    recovered.accounts.find(a => a.id === 'ttadk').providerDenied = { status: 'KNOWN', value: false, sampledAt: NOW, receivedAt: NOW };
    const s = createSnapshot(recovered);
    assert.equal(s.accounts.find(a => a.id === 'ttadk').fallbackUnavailable, null);
    assert.equal(routePure(task(), s).primary.candidate.accountId, 'ttadk');
  });
  check('invalid, absent and future policy data keep the quota gate', () => {
    for (const value of [null, { ...policy, queueWaitMinutes: -1 }, { ...policy, userDecisionRef: 'unrecorded' }, { ...policy, since: '2099-01-01' }]) {
      const raw = fixture(); deny(raw, 'ttadk'); deny(raw, 'trae'); raw.personalFallback = value;
      assert.equal(run(raw).kind, 'blocked');
    }
  });
  for (const [models, kind, extra, gate] of [
    [['opus'], 'claude', {}, 'personal-quota'], [['fable'], 'claude', { category: 'debug', impact: 'service' }, 'fable'],
    [[SOL], 'chatgpt', {}, 'max-effort'],
    [[ASTRA], 'chatgpt', { category: 'image-read', tier: 'normal', selectionCause: 'quality-escalation',
      qualityEscalation: { modelId: ASTRA, policyVersion: VERSION, evidenceId: 'fixture-escalation' } }, 'astra'],
    [[SOL], 'chatgpt', { requirements: { resetRedemption: true } }, 'reset-redemption'],
    [[SOL], 'chatgpt', { reviewClass: 'B', reviewReason: 'fixture classified change' }, 'personal-quota'],
    [[SOL], 'chatgpt', { flags: { security: true } }, 'personal-quota'],
  ]) check(`separate ${gate} gate remains for ${models}/${kind}`, () => {
    const raw = fixture(models, kind); deny(raw, 'ttadk'); deny(raw, 'trae');
    if (gate === 'max-effort') raw.lanes.find(l => l.accountId === 'main').efforts = ['max'];
    const t = task(extra), s = createSnapshot(raw);
    const c = enumerateCandidates(t, s).candidates.find(c => c.accountId === 'main' && c.effort === (gate === 'max-effort' ? 'max' : 'xhigh'));
    assert.ok(pScopedApproval(t, s, c).gates.some(g => g.kind === gate));
    const p = run(raw, t); assert.equal(p.kind, 'blocked'); assert.ok(p.gates.some(g => g.kind === gate));
  });
  check('fallback CLI records standing reference and audit accepts without --user-ok', () => {
    for (const hard of [false, true]) {
      const raw = fixture(hard ? [SOL, ASTRA] : [SOL]); deny(raw, 'ttadk'); deny(raw, 'trae');
      const name = hard ? 'pfb-cli-hard' : 'pfb-cli';
      const snapshotFile = path.join(tmp, name + '.json'), log = path.join(tmp, name + '.jsonl'), profiles = path.join(tmp, 'accounts.json');
      fs.writeFileSync(snapshotFile, JSON.stringify(raw)); fs.writeFileSync(profiles, JSON.stringify({ main: { kind: 'chatgpt' } }));
      const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, ROUTE_SNAPSHOT_FILE: snapshotFile, ROUTE_NOW: String(NOW),
        CODEX_ACCOUNTS: profiles, QUOTA_CACHE: path.join(tmp, 'quota.json'), ROUTE_LOG_FILE: log, ROUTE_LOG: '1', QUOTA_LOG: '0',
        QUOTA_LOG_FILE: path.join(tmp, 'quota-log.jsonl'), TRAE_PROBE: '0' };
      const cli = (script, args) => spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { env, encoding: 'utf8', timeout: 10000 });
      const routed = cli('route.mjs', [hard ? 'implement-hard' : 'analysis', ...(hard ? ['--impact', 'service'] : []), '--name', name, '--project', 'fixture', '--json']);
      assert.equal(routed.status, 0, routed.stderr); const v = JSON.parse(routed.stdout);
      assert.equal(v.kind, 'launch'); assert.equal(v.pick.approvalRef, ref); assert.doesNotMatch(v.pick.command, /--user-ok/);
      const record = JSON.parse(fs.readFileSync(log, 'utf8').trim()); assert.equal(record.approvalRef, ref); assert.equal(record.personalApproved, true);
      if (hard) { assert.equal(v.pick.model, ASTRA); assert.equal(record.astraApprovalRef, 'standing:hard-astra-2026-11-17'); }
      const audited = cli('launch-audit.mjs', ['--name', name, '--project', 'fixture', '--account', 'main', '--model', v.pick.model,
        '--effort', v.pick.effort, '--sandbox', v.pick.sandbox]);
      assert.equal(audited.status, 0, audited.stderr);
      const audit = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
      assert.equal(audit.routeApprovalRef, ref); assert.equal(audit.blocked, false);
    }
  });
  check('acquisition uses shipped policy and shared disable override, fixtures only', () => {
    const home = path.join(tmp, 'acquisition'); fs.mkdirSync(home);
    const registry = path.join(home, 'accounts.json'), cache = path.join(home, 'quota.json'); fs.writeFileSync(registry, '{}');
    fs.writeFileSync(cache, JSON.stringify({ checkedAt: NOW, codexAccounts: [
      { name: 'ttadk', kind: 'ttadk', live: true, healthy: false, home, models: [SOL], quotaOut: { resetsAt: NOW + 3600000 } },
      { name: 'main', kind: 'chatgpt', live: true, home, windows: [] }], claude: [] }));
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6.2-sol' }, { slug: SOL }, { slug: ASTRA }, { slug: 'gpt-6-astra' }, { slug: 'gpt-7-astra', visibility: 'hide' },
    ] }));
    const env = { RULES_SHARED: home, CODEX_ACCOUNTS: registry, QUOTA_CACHE: cache, ROUTE_NOW: String(NOW),
      ROUTE_LOG_FILE: path.join(home, 'routes.jsonl'), QUOTA_LOG_FILE: path.join(home, 'quota-log.jsonl') };
    const context = acquireRoute(task(), { env, now: NOW, root });
    assert.equal(context.snapshot.personalFallback.enabled, true); assert.equal(context.snapshot.personalFallback.queueWaitMinutes, 5);
    const personal = routePure(context.task, context.snapshot);
    assert.equal(personal.kind, 'launch');
    assert.deepEqual([personal.primary.candidate.accountId, personal.primary.candidate.modelId], ['main', 'gpt-6.2-sol']);
    const hard = acquireRoute(task({ category: 'implement-hard', impact: 'service' }), { env, now: NOW, root });
    const seat = routePure(hard.task, hard.snapshot).primary;
    assert.deepEqual([seat.candidate.accountId, seat.candidate.modelId], ['main', ASTRA]);
    fs.unlinkSync(path.join(home, 'models_cache.json'));
    fs.writeFileSync(path.join(home, 'model-catalog.json'), JSON.stringify({ codex: [{ slug: ASTRA }] }));
    const fromShared = acquireRoute(hard.task, { env, now: NOW, root });
    assert.deepEqual(fromShared.snapshot.accounts.find(a => a.id === 'main').catalog.value.filter(id => id.endsWith('-astra')), [ASTRA]);
    assert.ok(!fromShared.snapshot.accounts.find(a => a.id === 'ttadk').catalog.value.includes(ASTRA));
    fs.writeFileSync(path.join(home, 'personal-fallback.json'), JSON.stringify({ ...policy, enabled: false }));
    const disabled = acquireRoute(task(), { env, now: NOW, root }); assert.equal(disabled.snapshot.personalFallback.enabled, false);
    assert.equal(routePure(disabled.task, disabled.snapshot).kind, 'blocked');
    fs.writeFileSync(path.join(home, 'personal-fallback.json'), 'invalid json');
    assert.equal(acquireRoute(task(), { env, now: NOW, root }).snapshot.personalFallback, null);
  });
  console.log(`PASS personal fallback: ${count} scenarios`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
