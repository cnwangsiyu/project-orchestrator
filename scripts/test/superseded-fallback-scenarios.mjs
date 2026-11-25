#!/usr/bin/env node
// Synthetic replay of 2026-11-23 18:45 PT. No provider calls or live state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSnapshot, createTaskSpec, routePure, enumerateCandidates, validatePlan } from '../lib/pipeline/index.mjs';
import { queueOptions, queueOptionPlan } from '../lib/queue-decision.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-fallback-'));
const now = Date.parse('2026-11-24T02:45:00Z'), reset = Date.parse('2026-11-24T22:00:00Z');
const latest = 'gpt-6.2-sol', previous = 'gpt-6.1-sol', efforts = ['medium', 'high', 'xhigh', 'max'];
const caps = { search: true, vision: true };
const policy = JSON.parse(fs.readFileSync(path.join(root, 'references/personal-fallback.json')));
const task = (extra = {}) => createTaskSpec({ taskId: 'release-replay', requestId: 'replay', category: 'implement-hard', impact: 'service',
  project: 'fixture', owner: 'fixture-owner', ...extra });
function fixture(ids = [latest, previous], kind = 'trae') {
  return { schemaVersion: 'pipeline-v1', collectedFrom: now, collectedThrough: now, decisionAt: now,
    personalFallback: policy, personalPriority: { account: 'main', mode: 'exclusive', from: '2026-11-21T08:00:00Z', until: null,
      revoked: false, quote: 'fixture company before main', userDecisionRef: 'standing:personal-priority-fixture' },
    resources: { held: false, ownedReturned: true }, health: [], approvals: [], dependencies: [],
    accounts: [[kind, kind, ids], ['main', 'chatgpt', ids], ['b', 'chatgpt', ids]].map(([id, kind, catalog]) => ({
      id, kind, catalog, auth: true, transport: true, health: true, providerDenied: false, capabilities: caps,
      budget: { weekly: { used: 46, projected: 50, resetsAt: reset }, deadline: 20 },
      quota: catalog.map(bucketId => ({ bucketId, unit: 'requests', priority: 'available', usage: { used: 0, limit: 80, remaining: 80, depleted: false, resetsAt: reset } })) })),
    models: ids.map(id => ({ id, efforts, capabilities: caps, largeOutput: true })),
    lanes: [kind, 'main', 'b'].flatMap(accountId => ids.map(modelId => ({ id: `${accountId}:${modelId}`, accountId, modelId,
      harness: 'hub', efforts, mode: 'priority', selectable: true, readyAt: now, queueState: 'ready', position: 0, drainPerMin: 0,
      loadPercent: 25, loadSource: 'model', capabilities: caps }))) };
}
function exhaust(raw, id = raw.accounts[0].catalog[0]) {
  Object.assign(raw.accounts[0].quota.find(q => q.bucketId === id).usage, { used: 80, remaining: 0, depleted: true });
  Object.assign(raw.lanes.find(l => l.accountId === raw.accounts[0].id && l.modelId === id),
    { mode: 'low-priority', position: 58, drainPerMin: 0, queueState: 'queued', readyAt: null });
  return raw;
}
const run = (raw, t = task()) => routePure(t, createSnapshot(raw));
const rowFor = (p, account, model, effort = 'xhigh') => p.trace.candidates.find(r => r.candidate.accountId === account && r.candidate.modelId === model && r.candidate.effort === effort);
const rejected = r => r.predicates.filter(p => !p.ok).map(p => p.reason.code);
const cli = (raw, routeRoot = root) => {
  fs.writeFileSync(path.join(tmp, 'snapshot.json'), JSON.stringify(raw));
  return JSON.parse(execFileSync(process.execPath, [path.join(routeRoot, 'scripts/route.mjs'), 'implement-hard', '--impact', 'service', '--name', 'release-replay', '--dry', '--json'], {
    encoding: 'utf8', maxBuffer: 16 << 20, env: { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: path.join(tmp, 'accounts.json'),
      QUOTA_CACHE: path.join(tmp, 'quota.json'), ROUTE_SNAPSHOT_FILE: path.join(tmp, 'snapshot.json'), ROUTE_NOW: String(now), ROUTE_LOG: '0',
      ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl'), QUOTA_LOG_FILE: path.join(tmp, 'quota.jsonl'), TRAE_PROBE: '0' } }));
};
try {
  if (process.argv.includes('--replay')) {
    const result = cli(exhaust(fixture()), process.argv[process.argv.indexOf('--replay') + 1]);
    console.log(JSON.stringify({ at: '2026-11-23 18:45 PT', kind: result.kind, pick: result.pick && { account: result.pick.account, model: result.pick.model, effort: result.pick.effort },
      reason: result.why.filter(s => /previous release|waiting|stalled/.test(s)), previousRejections: rejected(rowFor(result.plan, 'trae', previous)) }, null, 2));
  } else {
    for (const record of JSON.parse(fs.readFileSync(path.join(root,'scripts/test/fixtures/depleted-sol-routes.json')))) {
      const raw = exhaust(fixture([record.model]));
      raw.decisionAt = raw.collectedFrom = raw.collectedThrough = record.t;
      Object.assign(raw.lanes[0], {position:0, readyAt:record.t, progressAt:record.t, queueState:'ready', familyQueue:record.familyQueue});
      for (const modelId of record.readyMainModels.filter(m=>m!==record.model)) {
        raw.accounts[1].catalog = [...raw.accounts[1].catalog,modelId];
        raw.models.push({...raw.models[0],id:modelId});
        raw.lanes.push({...raw.lanes[1],id:`main:${modelId}`,modelId});
      }
      const plan = run(raw,task({taskId:record.name,category:record.category,impact:record.impact}));
      assert.deepEqual([plan.primary.candidate.accountId,plan.primary.candidate.modelId,plan.primary.candidate.effort],
        ['main',record.readyMainModels[0],record.effort],record.name);
      assert.ok(plan.trace.candidates.filter(r=>r.candidate.accountId==='trae').every(r=>rejected(r).includes('DAY_QUOTA_EXHAUSTED')),record.name);
    }
    const timed = fixture([latest]);
    timed.etaHistory = ['trae','main'].flatMap(accountId=>[1,2,3].map(i=>({attemptId:`${accountId}-${i}`,accountId,modelId:latest,
      category:'implement-hard',effort:'xhigh',attributed:true,minutes:accountId==='main'?5:20})));
    assert.equal(run(timed).primary.candidate.accountId,'main');
    timed.etaHistory.filter(r=>r.accountId==='trae').forEach(r=>r.minutes=8);
    assert.equal(run(timed).primary.candidate.accountId,'trae');
    // Replay the two original route-log inputs, before the manual account exclusions.
    const terra = 'gpt-5.6-terra', astra = 'gpt-6-astra';
    for (const [name, project, category, impact, at, expected] of [
      ['R-res-place', 'orchestrator', 'implement-hard', 'service', 1795508010853, ['main', 'gpt-6.2-astra', 'xhigh']],
      ['T174-clock-device-recheck', 'lynx-view', 'build-run', 'throwaway', 1795511144639, ['main', latest, 'medium']],
    ]) {
      const raw = fixture([latest, previous, astra, 'gpt-5.6-sol', terra]);
      raw.collectedFrom = raw.collectedThrough = raw.decisionAt = at;
      for (const id of [latest, previous, astra, 'gpt-5.6-sol']) {
        exhaust(raw, id);
        Object.assign(raw.lanes.find(l => l.accountId === 'trae' && l.modelId === id),
          { position: null, drainPerMin: null, queueState: null, loadPercent: null });
      }
      const main = raw.accounts.find(a => a.id === 'main');
      main.budget.weekly.used = 68;
      main.catalog.push('gpt-6.2-astra');
      raw.models.push({ ...raw.models.find(m => m.id === astra), id: 'gpt-6.2-astra' });
      raw.lanes.push({ ...raw.lanes.find(l => l.modelId === astra && l.accountId === 'main'),
        id: 'main:gpt-6.2-astra', modelId: 'gpt-6.2-astra' });
      raw.personalPriority.userDecisionRef = 'standing:personal-priority-2026-11-20b';
      const ttReset = Date.parse('2026-11-24T16:00:00Z');
      raw.accounts.push({ ...structuredClone(main), id: 'ttadk', kind: 'ttadk', providerDenied: true, denialResetAt: ttReset });
      raw.lanes.push(...raw.lanes.filter(l => l.accountId === 'main').map(l => ({ ...l, id: 'ttadk:' + l.modelId, accountId: 'ttadk' })));
      const flags = { name, project, impact, ...(category === 'implement-hard' ? { 'exclude-account': 'ttadk' } : {}) };
      const spec = task({ category, flags, project, impact });
      const pick = run(raw, spec).primary.candidate;
      assert.deepEqual([pick.accountId, pick.modelId, pick.effort], expected, name);
      const opted = run(raw, task({ category, flags: { ...flags, 'allow-low-priority-queue': true }, project, impact })).primary.candidate;
      assert.deepEqual([opted.accountId, opted.modelId, opted.effort], category === 'build-run' ? ['trae', terra, 'medium'] : expected);
      if (category === 'build-run') {
        const predecessor = structuredClone(raw);
        const q = predecessor.accounts[0].quota.find(q => q.bucketId === previous);
        Object.assign(q.usage,{used:1,remaining:79,depleted:false});
        predecessor.lanes.find(l => l.accountId === 'trae' && l.modelId === previous).mode='priority';
        assert.equal(run(predecessor,spec).primary.candidate.accountId,'main','ready main takes precedence over the measured Terra downgrade');
        predecessor.accounts.find(a => a.id === 'main').transport = false;
        assert.equal(run(predecessor,spec).primary.candidate.modelId,terra,'measured ready Terra precedes an unmeasured previous release when main is unavailable');
      }
      main.transport = false;
      raw.lanes = raw.lanes.filter(l => l.accountId !== 'trae' || l.modelId !== terra);
      const deferred = run(raw, spec);
      assert.equal(deferred.kind, 'defer');
      assert.equal(deferred.deferUntil, category === 'implement-hard' ? reset : ttReset);
      assert.equal(run(raw, task({ category, project, impact, flags: { ...flags, 'allow-low-priority-queue': true } })).primary.candidate.accountId, 'trae');
    }
    for (const condition of ['unknown', 'expired', 'expired-partial', 'sibling']) {
      const raw = fixture();
      const q = raw.accounts[0].quota[0];
      if (condition === 'unknown') { q.usage = null; q.priority = null; raw.lanes[0].mode = 'UNKNOWN'; }
      if (condition === 'expired') { exhaust(raw); q.usage.resetsAt=now; raw.lanes[0].queueState='ready'; raw.lanes[0].position=0; }
      if (condition === 'expired-partial') { q.usage = { resetsAt: now - 1 }; q.priority = 'depleted'; }
      if (condition === 'sibling') exhaust(raw,previous);
      const plan = run(raw);
      assert.ok(!rejected(rowFor(plan, 'trae', latest)).includes('DAY_QUOTA_EXHAUSTED'), condition);
      assert.equal(plan.kind, 'launch', condition);
      assert.deepEqual([plan.primary.candidate.accountId, plan.primary.candidate.modelId], ['trae', latest], condition);
    }
    for (const [label, telemetry, expected] of [
      ['ready without submit evidence', { position: 0, queueState: 'ready' }, previous],
      ['observed low-priority start', { position:0,queueState:'ready',lowStart: 2 }, latest],
      ['own waiter', { lowStart: 1, ownWaiting: true }, previous],
      ['unmeasured family wait', { lowStart: 1, familyQueue: {lowPriority:true,position:157} }, previous],
      ['at threshold', { position: 10, drainPerMin: 2, lowQueue:{position:10,drainPerMin:2} }, latest],
      ['over threshold', { position: 11, drainPerMin: 2 }, previous],
      ['flat', { position: 301, drainPerMin: 0 }, previous],
      ['unmeasured', { position: null, queueState: null }, previous],
      ['stale', { position: {status:'KNOWN',value:2,sampledAt:now-1860000,receivedAt:now}, drainPerMin:2 }, previous],
    ]) {
      const raw = exhaust(fixture());
      Object.assign(raw.lanes[0], telemetry);
      const plan = run(raw);
      assert.equal(plan.primary.candidate.modelId, expected, label);
    }
    for (const quota of ['unknown', 'healthy']) {
      const raw = fixture([latest]);
      if (quota === 'unknown') raw.accounts[0].quota = [];
      Object.assign(raw.lanes[0], { mode:'low-priority', position:null, queueState:null, readyAt:null, drainPerMin:null });
      const plan = run(raw);
      assert.equal(plan.primary.candidate.accountId, 'main', quota);
      assert.ok(!rejected(rowFor(plan, 'trae', latest)).includes('DAY_QUOTA_EXHAUSTED'), quota);
    }
    let p = run(fixture());
    assert.equal(p.primary.candidate.modelId, latest);
    assert.ok(rejected(rowFor(p, 'trae', previous)).includes('MODEL_SUPERSEDED'));
    const raw = exhaust(fixture()); p = run(raw);
    assert.equal(p.kind, 'launch'); assert.equal(p.primary.candidate.accountId, 'trae'); assert.equal(p.primary.candidate.modelId, previous);
    assert.equal(p.primary.candidate.effort, 'xhigh'); assert.equal(validatePlan(p, createSnapshot(raw)).ok, true);
    assert.ok(rejected(rowFor(p, 'trae', previous, 'high')).includes('TIER_EFFORT_FLOOR'));
    assert.ok(rejected(rowFor(p, 'main', previous)).includes('MODEL_SUPERSEDED'));
    assert.ok(rowFor(p, 'b', latest));
    const view = cli(raw);
    assert.equal(view.kind, 'launch'); assert.equal(view.pick.model, previous); assert.equal(view.pick.effort, 'xhigh');
    assert.ok(view.why.some(s => s.includes(`${latest} day quota exhausted until`) && s.includes(`using previous release ${previous}`)));
    for (const change of [
      r => r.health.push({ accountId: 'trae', modelId: latest, restricted: true }),
      r => r.health.push({ accountId: 'trae', modelId: latest, restricted: false, recovery: 'awaiting-probe' }),
      r => Object.assign(r.lanes[0], { mode: 'low-priority' }),
      r => Object.assign(r.lanes[0], { queueState: 'waiting', position: 55, drainPerMin: 0, readyAt: null }),
      r => Object.assign(r.lanes[0], { queueState: 'queued', position: 55, drainPerMin: 1, readyAt: null }),
    ]) { const r = fixture(); change(r); assert.equal(run(r).primary.candidate.modelId, previous); }
    for (const flag of ['exclude-model', 'exclude-lane']) {
      const t = task({ flags: { [flag]: flag === 'exclude-lane' ? `trae:${latest}` : latest } });
      assert.equal(run(fixture(), t).primary.candidate.modelId, previous);
    }
    for (const change of [
      r => r.accounts[0].quota.splice(1, 1),
      r => r.accounts[0].quota[1].usage.resetsAt = now - 1,
      r => exhaust(r, previous),
      r => r.health.push({ accountId: 'trae', modelId: previous, restricted: true }),
      r => r.health.push({ accountId: 'trae', family: 'gpt', restricted: true }),
      r => r.accounts[0].transport = false,
      r => Object.assign(r.lanes[1], { queueState: 'waiting', position: 1, drainPerMin: 0, readyAt: null }),
    ]) { const r = exhaust(fixture()); change(r); assert.ok(rejected(rowFor(run(r), 'trae', previous)).length); }
    const three = exhaust(fixture(['gpt-6.3-sol', latest, previous]));
    assert.equal(run(three).primary.candidate.modelId, latest);
    assert.ok(rejected(rowFor(run(three), 'trae', previous)).includes('MODEL_SUPERSEDED'));
    const olderAstra = exhaust(fixture(['gpt-6.2-astra', 'gpt-6-astra']));
    assert.equal(run(olderAstra).primary.candidate.modelId, 'gpt-6-astra');
    const tt = exhaust(fixture([latest, previous], 'ttadk')); assert.equal(run(tt).primary.candidate.modelId, previous);
    const mixed = exhaust(fixture());
    mixed.accounts.push({ ...structuredClone(mixed.accounts[0]), id: 'ttadk', kind: 'ttadk', quota: [] });
    mixed.lanes.push({ ...structuredClone(fixture().lanes[0]), id: `ttadk:${latest}`, accountId: 'ttadk' });
    assert.equal(run(mixed).primary.candidate.accountId, 'ttadk');
    const attempt = { id: 'prior', taskId: 'release-replay', role: 'primary', actualStatus: 'KNOWN', actual: { accountId: 'trae', modelId: latest, effort: 'xhigh' },
      state: 'cancelled-no-work', usefulWork: false, cancellationEvidenceId: 'fixture-cancel', failureKind: 'infra' };
    assert.equal(run(raw, task({ previousAttempts: [attempt] })).primary.candidate.modelId, previous);
    for (const extra of [{ state: 'running' }, { state: 'failed', failureKind: 'quality' }, { cancellationEvidenceId: null }])
      assert.ok(rejected(rowFor(run(raw, task({ previousAttempts: [{ ...attempt, ...extra }] })), 'trae', previous)).length);
    const context = { task: task(), snapshot: createSnapshot(raw), root, now };
    const row = { owner: 'fixture-owner', account: 'trae', model: latest, effort: 'xhigh', thread: 'fixture', turn: 'turn' };
    const queue = { state: 'queued', since: now - 25 * 60000, position: 58, drainPerMin: 0 };
    const mixedOptions = queueOptions(row, queue, {}, now, { ...context, snapshot: createSnapshot(mixed) });
    const currentIndex = mixedOptions.findIndex(o => o.account === 'ttadk' && o.model === latest);
    const previousIndex = mixedOptions.findIndex(o => o.account === 'trae' && o.model === previous);
    assert.ok(currentIndex >= 0 && currentIndex < previousIndex, 'healthy company newest release comes before the previous release in a notice');
    for (const workStarted of [false, true]) {
      const options = queueOptions(row, { ...queue, workStarted }, {}, now, context);
      const option = options.find(o => o.account === 'trae' && o.model === previous);
      assert.equal(option.effort, 'xhigh'); assert.equal(option.context, 'same thread / resume'); assert.ok(option.releaseFallback);
      assert.ok(options.indexOf(option) < options.findIndex(o => o.account === 'main'));
      assert.equal(queueOptionPlan(context, row, { ...queue, workStarted }, option.candidateId, 'fixture-choice').kind, 'launch');
      const high = enumerateCandidates(context.task, context.snapshot).candidates.find(c => c.accountId === 'trae' && c.modelId === previous && c.effort === 'high');
      assert.equal(queueOptionPlan(context, row, { ...queue, workStarted }, high.id, 'fixture-choice').kind, 'blocked');
      assert.equal(queueOptions(row, { ...queue, workStarted }, { requestBufferExceededAt: now }, now, context).find(o => o.model === previous && o.account === 'trae').context, 'fresh worker with the same brief');
    }
    console.log('PASS company previous-release fallback, quota/health/exclusion guards, effort/actual floors, newest preference, queue options and 18:45 CLI replay');
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
