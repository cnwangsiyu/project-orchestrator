// eta-compat.mjs is an unchanged copy of the in-flight pure eta.mjs. After
// that branch lands, switch this import to ../eta.mjs (see README).
import { workMinutes, requestsFor, laneEta, ttadkEta, patienceMinutes, ETA } from './eta-compat.mjs';
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
  const load = known(l.loadPercent), congested = (load !== null && load >= 60 && (!progressing || l.loadSource === 'model'))
    || (position !== null && position > 300);
  const resetAt = known(a.denialResetAt);
  const raw = capacityReset ? ttadkEta({ account: { usable: false, quotaOut: { resetsAt: resetAt } }, now, workMin })
    : laneEta({ workMin, requests, position, drainPerMin, bucketDepleted: l.mode === 'low-priority', congested, progressing,
      unknown: ready === null && !progressing && !(position !== null && drainPerMin > 0), startDelayMin: ready === null ? 0 : Math.max(0, (ready - now) / 60000) });
  const unknown = !raw || raw.unknown || l.mode === 'UNKNOWN';
  const uncertainty = [];
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
  return freeze({ candidateId: candidate.id, startDelayMin: unknown ? null : raw.startDelayMin,
    completionMin: raw?.completionMin ?? workMin, basis: raw?.basis ?? 'unknown', confidence: unknown ? 'UNKNOWN'
      : rows.length >= ETA.historyMin && !uncertainty.some((r) => r.code === 'WORK_COHORT_FALLBACK') ? 'measured' : 'fallback',
    workMin, requests, sampleIds: rows.length >= ETA.historyMin ? rows.map((r) => r.attemptId) : [], costs, noPrioritySpend, expiryOpportunity,
    uncertainty, patienceMin: unknown || l.mode === 'low-priority' ? patienceMinutes({ now, ttadk: { usage: { resetsAt: nextReset } } }) : null,
    inputAges: { readyAt: l.readyAt.ageMs, position: l.position.ageMs, drainPerMin: l.drainPerMin.ageMs, progressAt: l.progressAt.ageMs, loadPercent: l.loadPercent.ageMs },
    capacityReset, deferUntil: capacityReset ? resetAt : null });
}
