import { workMinutes, requestsFor, laneEta, ttadkEta, patienceMinutes, ETA } from '../eta.mjs';
import { known, freeze, reason } from './common.mjs';
import { company, policyModel, isAstra } from './common.mjs';
import { modelPreference } from './policy.mjs';
import { candidateParts } from './candidates.mjs';

export function estimateCandidate(task, snapshot, candidate, { capacityReset = false } = {}) {
  const { account: a, lane: l } = candidateParts(snapshot, candidate), now = snapshot.decisionAt;
  // Use the established category/effort median, with its actual provenance.
  // It is a heuristic across models/accounts, not proof of equivalent speed.
  const rows = snapshot.etaHistory.filter((r) => r.category === task.category && r.effort === candidate.effort && r.minutes > 0
    && !['queue-too-slow', 'cancelled-no-work', 'infra', 'policy-block'].includes(r.cause));
  const history = rows.map((r) => ({ ...r, actual: [{ effort: r.effort }] }));
  const workMin = workMinutes(task.category, task.tier, history, candidate.effort), requests = requestsFor(task.category, task.tier);
  const ready = known(l.readyAt), position = known(l.position), drainPerMin = known(l.drainPerMin);
  const progressing = known(l.progressAt) !== null, directReady=position===0&&known(l.queueState)==='ready',directClear=progressing||directReady;
  // Direct progress wins over coarse congested-sibling/account load evidence.
  const load = l.loadSource === 'model' ? known(l.loadPercent) : null, congested = (load !== null && load >= 60)
    || (position !== null && position > 300);
  const dq=known(a.quota.find(q=>q.bucketId===candidate.modelId)?.usage), fq=known(l.familyQueue);
  const familyCongested=!directClear&&(fq?.position>300||(fq?.high?.position>300&&fq.high.t<=now&&now-fq.high.t<=1800000));
  const queued=position>0||['queued','waiting'].includes(known(l.queueState))
    ||!directClear&&(fq?.position>0||['queued','waiting'].includes(fq?.state));
  const recentAstraQueue=a.kind==='trae'&&isAstra(candidate.modelId)&&known(l.recentQueue)?.blocked===true;
  // Astra's catalog commonly omits load. Fresh unused units and a healthy hub,
  // with no lane/family/recent-turn queue signal, supply its alternative evidence.
  const astraNoLoad=!!(a.kind==='trae'&&isAstra(candidate.modelId)&&load===null
    &&known(a.auth)===true&&known(a.transport)===true&&known(a.health)===true
    &&(l.hubHealthy?known(l.hubHealthy)===true:known(a.health)===true)
    &&dq&&dq.resetsAt>now&&dq.used<dq.limit&&dq.depleted!==true
    &&(dq.remaining==null||typeof dq.remaining==='number'&&dq.remaining>0)
    &&!queued&&!familyCongested&&!recentAstraQueue);
  const resetAt = known(a.denialResetAt);
  const raw = capacityReset ? ttadkEta({ account: { usable: false, quotaOut: { resetsAt: resetAt } }, now, workMin })
    : laneEta({ workMin, requests, position, drainPerMin, state: known(l.queueState), bucketDepleted: l.mode === 'low-priority'&&!astraNoLoad, congested, progressing,
      unknown: ready === null && !directClear && !(position !== null && drainPerMin > 0) && !astraNoLoad, startDelayMin: ready === null ? 0 : Math.max(0, (ready - now) / 60000) });
  const stalled = raw?.stalled === true;
  const unknown = !stalled && (!raw || raw.unknown);
  const uncertainty = [];
  if (stalled) uncertainty.push(reason('estimate', 'ETA_STALLED', 'Fresh queue telemetry reports zero drain or waiting without progress; no finite start/completion estimate.', [candidate.id]));
  if (unknown) uncertainty.push(reason('estimate', 'ETA_UNKNOWN', 'Optimistic fallback; start delay is unmeasured and queue patience is bounded.', [candidate.id]));
  if (rows.length < ETA.historyMin) uncertainty.push(reason('estimate', 'WORK_HEURISTIC', 'Work time uses the versioned tier/category fallback.', [candidate.id]));
  if (rows.length >= ETA.historyMin && rows.some((r) => r.modelId !== candidate.modelId || r.accountId !== candidate.accountId))
    uncertainty.push(reason('estimate', 'WORK_COHORT_FALLBACK', 'Category/effort history spans other models or accounts.', rows.map((r) => r.attemptId)));
  const noPrioritySpend = a.kind === 'trae' && ['bucket-free', 'low-priority'].includes(l.mode) ? true
    : a.kind === 'trae' && l.mode === 'priority' ? false : null;
  const costs = l.costs.map((c) => ({ ...c, prioritySpend: noPrioritySpend === true ? false : c.prioritySpend }));
  const q = a.quota.map((q) => known(q.usage)).find((q) => q && q.resetsAt > now), burn = known(a.burn);
  const ttExpiryOpportunity = a.kind === 'ttadk' && q && burn && q.resetsAt === burn.resetsAt
    ? q.used < q.limit && q.resetsAt - now < 4 * 3600000 && burn.projectedAtReset / q.limit < 0.7 : null;
  if (a.kind === 'trae') uncertainty.push(reason('estimate', 'TRAE_WEEKLY_SEMANTICS_UNKNOWN', 'Weekly pool admission semantics remain unverified.', [a.id]));
  if (a.kind === 'ttadk' && q?.used >= q?.limit && known(a.providerDenied) !== true)
    uncertainty.push(reason('estimate', 'DASHBOARD_PROVIDER_DISAGREEMENT', 'Dashboard depletion is not authoritative provider denial.', [a.id]));
  const nextReset = snapshot.accounts.filter(a=>company(a)&&known(a.auth)===true&&known(a.transport)===true&&known(a.catalog)?.some(id=>modelPreference(task,a).includes(policyModel(id)))&&task.capabilitiesNeeded.every(cap=>known(a.capabilities?.[cap])===true)).map(a=>known(a.denialResetAt)).filter((v) => v > now).sort((a, b) => a - b)[0];
  const tt=snapshot.accounts.find((a)=>a.kind==='ttadk'), tq=tt?.quota.map((q)=>known(q.usage)).find(Boolean), tb=known(tt?.burn);
  const remainingShare=dq&&dq.resetsAt>now?Math.max(0,(dq.limit-dq.used)/dq.limit):null;
  const ttShare=tq&&tq.resetsAt>now?(tq.limit-tq.used)/tq.limit:null;
  const lowTask=task.tier==='light'||task.stakes==='low'||task.impact==='throwaway';
  const reserveOK=l.mode==='bucket-free'||l.mode==='priority'&&remainingShare>=.15;
  const congestionOK=!stalled&&!congested&&!familyCongested&&!recentAstraQueue&&(load!==null||lowTask||astraNoLoad);
  const projectedOut=!!(tq&&tb&&tb.resetsAt===tq.resetsAt&&tb.projectedAtReset>=tq.limit);
  const expiresSoon=remainingShare!==null&&ttShare!==null&&dq.resetsAt-now<6*3600000&&remainingShare>ttShare;
  const triggers=[lowTask&&'low-priority task',projectedOut&&'TTADK projected to run out',expiresSoon&&'TRAE daily quota expires soon'].filter(Boolean);
  const traeExpiry=a.kind==='trae'&&l.mode==='priority'&&dq&&dq.limit>0&&dq.used<dq.limit&&dq.resetsAt>now&&dq.resetsAt-now<6*3600000;
  const expiryOpportunity=a.kind==='ttadk'?ttExpiryOpportunity:a.kind==='trae'?!!traeExpiry:null;
  const expiryEvidence=expiryOpportunity?{modelId:candidate.modelId,bucketId:a.kind==='ttadk'?'ttadk-daily':candidate.modelId,unit:a.kind==='ttadk'?'tokens':'model-bucket',resetsAt:(a.kind==='ttadk'?q:dq).resetsAt,used:(a.kind==='ttadk'?q:dq).used,limit:(a.kind==='ttadk'?q:dq).limit}:null;
  const freeNow=!capacityReset&&!stalled&&!familyCongested&&!recentAstraQueue&&!raw?.unknown&&raw?.startDelayMin===0
    &&(load!==null&&load<60||astraNoLoad)&&!queued;
  const balance=a.kind==='trae'?{model:candidate.modelId,family:candidate.family,bucketFree:l.mode==='bucket-free',reserveOK,remainingShare,ttadkRemainingShare:ttShare,
    load:load===null?null:{percent:load,source:l.loadSource},queue:fq,queued,freeNow,
    astraUnitsEvidence:astraNoLoad?{used:dq.used,limit:dq.limit}:null,
    congestion:congested||familyCongested?'high':load!==null||astraNoLoad?'low':'unknown',congestionOK,
    burn:tb?{...tb,beforeReset:projectedOut}:null,
    projectedOut,expiresSoon,triggers,eligible:reserveOK&&congestionOK&&triggers.length>0,reasons:[!reserveOK&&(l.mode==='low-priority'?'daily bucket depleted':'daily quota unknown (missing, stale or expired) or below 15% reserve'),
      stalled&&'lane stalled in fresh telemetry',queued&&'queue observed',recentAstraQueue&&'recent Astra queue or stall observed',familyCongested&&'family queue above 300',load>=60&&`${candidate.modelId} load ${load}% is at least 60`,!congestionOK&&load===null&&`${candidate.modelId} has no fresh model load reading`,!triggers.length&&'no balancing trigger'].filter(Boolean)}:null;
  return freeze({ candidateId: candidate.id, startDelayMin: unknown ? null : raw.startDelayMin,
    completionMin: stalled ? null : raw?.completionMin ?? workMin, stalled, basis: raw?.basis ?? 'unknown', confidence: stalled ? 'STALLED' : unknown ? 'UNKNOWN'
      : rows.length >= ETA.historyMin && !uncertainty.some((r) => r.code === 'WORK_COHORT_FALLBACK') ? 'measured' : 'fallback',
    workMin, requests, sampleIds: rows.length >= ETA.historyMin ? rows.map((r) => r.attemptId) : [], costs, noPrioritySpend, expiryOpportunity,expiryEvidence,
    uncertainty, patienceMin: a.company&&(unknown||raw?.basis==='queue'||raw?.startDelayMin>0||l.mode==='low-priority') ? patienceMinutes({ now, nextAvailableAt:nextReset }) : null,
    inputAges: { readyAt: l.readyAt.ageMs, position: l.position.ageMs, drainPerMin: l.drainPerMin.ageMs, progressAt: l.progressAt.ageMs, loadPercent: l.loadPercent.ageMs },
    balance, capacityReset, deferUntil: capacityReset ? resetAt : null });
}
