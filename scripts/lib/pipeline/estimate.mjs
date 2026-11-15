import { workMinutes, requestsFor, laneEta, ttadkEta, patienceMinutes, ETA } from '../eta.mjs';
import { known, freeze, reason } from './common.mjs';
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
  const progressing = known(l.progressAt) !== null;
  // Direct progress wins over coarse congested-sibling/account load evidence.
  const load = l.loadSource === 'model' ? known(l.loadPercent) : null, congested = (load !== null && load >= 60)
    || (position !== null && position > 300);
  const resetAt = known(a.denialResetAt);
  const raw = capacityReset ? ttadkEta({ account: { usable: false, quotaOut: { resetsAt: resetAt } }, now, workMin })
    : laneEta({ workMin, requests, position, drainPerMin, state: known(l.queueState), bucketDepleted: l.mode === 'low-priority', congested, progressing,
      unknown: ready === null && !progressing && !(position !== null && drainPerMin > 0), startDelayMin: ready === null ? 0 : Math.max(0, (ready - now) / 60000) });
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
  const expiryOpportunity = a.kind === 'ttadk' && q && burn && q.resetsAt === burn.resetsAt
    ? q.used < q.limit && q.resetsAt - now < 4 * 3600000 && burn.projectedAtReset / q.limit < 0.7 : null;
  if (a.kind === 'trae') uncertainty.push(reason('estimate', 'TRAE_WEEKLY_SEMANTICS_UNKNOWN', 'Weekly pool admission semantics remain unverified.', [a.id]));
  if (a.kind === 'ttadk' && q?.used >= q?.limit && known(a.providerDenied) !== true)
    uncertainty.push(reason('estimate', 'DASHBOARD_PROVIDER_DISAGREEMENT', 'Dashboard depletion is not authoritative provider denial.', [a.id]));
  const nextReset = snapshot.accounts.filter((a) => a.kind === 'ttadk').map((a) => known(a.denialResetAt)).filter((v) => v > now).sort((a, b) => a - b)[0];
  const tt=snapshot.accounts.find((a)=>a.kind==='ttadk'), tq=tt?.quota.map((q)=>known(q.usage)).find(Boolean), tb=known(tt?.burn);
  const dq=known(a.quota.find((q)=>q.bucketId===candidate.modelId)?.usage), remainingShare=dq&&dq.resetsAt>now?Math.max(0,(dq.limit-dq.used)/dq.limit):null;
  const ttShare=tq&&tq.resetsAt>now?(tq.limit-tq.used)/tq.limit:null, fq=known(l.familyQueue);
  const familyCongested=!progressing&&(fq?.position>300||(fq?.high?.position>300&&fq.high.t<=now&&now-fq.high.t<=1800000));
  const lowTask=task.tier==='light'||task.stakes==='low'||task.impact==='throwaway';
  const reserveOK=l.mode==='bucket-free'||l.mode==='priority'&&remainingShare>=.15;
  const congestionOK=!stalled&&!congested&&!familyCongested&&(load!==null||lowTask);
  const projectedOut=!!(tq&&tb&&tb.resetsAt===tq.resetsAt&&tb.projectedAtReset>=tq.limit);
  const expiresSoon=remainingShare!==null&&ttShare!==null&&dq.resetsAt-now<6*3600000&&remainingShare>ttShare;
  const triggers=[lowTask&&'low-priority task',projectedOut&&'TTADK projected to run out',expiresSoon&&'TRAE daily quota expires soon'].filter(Boolean);
  const queued=position>0||['queued','waiting'].includes(known(l.queueState))
    ||!progressing&&(fq?.position>0||['queued','waiting'].includes(fq?.state));
  const freeNow=!capacityReset&&!stalled&&!familyCongested&&!raw?.unknown&&raw?.startDelayMin===0&&load!==null&&load<60&&!queued;
  const balance=a.kind==='trae'?{model:candidate.modelId,family:candidate.family,bucketFree:l.mode==='bucket-free',reserveOK,remainingShare,ttadkRemainingShare:ttShare,
    load:load===null?null:{percent:load,source:l.loadSource},queue:fq,queued,freeNow,congestion:congested||familyCongested?'high':load!==null?'low':'unknown',congestionOK,
    burn:tb?{...tb,beforeReset:projectedOut}:null,
    projectedOut,expiresSoon,triggers,eligible:reserveOK&&congestionOK&&triggers.length>0,reasons:[!reserveOK&&(l.mode==='low-priority'?'daily bucket depleted':'daily quota unknown (missing, stale or expired) or below 15% reserve'),
      stalled&&'lane stalled in fresh telemetry',queued&&'queue observed',familyCongested&&'family queue above 300',load>=60&&`${candidate.modelId} load ${load}% is at least 60`,!congestionOK&&load===null&&`${candidate.modelId} has no fresh model load reading`,!triggers.length&&'no balancing trigger'].filter(Boolean)}:null;
  return freeze({ candidateId: candidate.id, startDelayMin: unknown ? null : raw.startDelayMin,
    completionMin: stalled ? null : raw?.completionMin ?? workMin, stalled, basis: raw?.basis ?? 'unknown', confidence: stalled ? 'STALLED' : unknown ? 'UNKNOWN'
      : rows.length >= ETA.historyMin && !uncertainty.some((r) => r.code === 'WORK_COHORT_FALLBACK') ? 'measured' : 'fallback',
    workMin, requests, sampleIds: rows.length >= ETA.historyMin ? rows.map((r) => r.attemptId) : [], costs, noPrioritySpend, expiryOpportunity,
    uncertainty, patienceMin: unknown || l.mode === 'low-priority' ? patienceMinutes({ now, ttadk: { usage: { resetsAt: nextReset } } }) : null,
    inputAges: { readyAt: l.readyAt.ageMs, position: l.position.ageMs, drainPerMin: l.drainPerMin.ageMs, progressAt: l.progressAt.ageMs, loadPercent: l.loadPercent.ageMs },
    balance, capacityReset, deferUntil: capacityReset ? resetAt : null });
}
