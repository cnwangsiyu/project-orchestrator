import { EFFORTS, company, adversarial, compare, freeze, stable } from './common.mjs';
import { candidateParts } from './candidates.mjs';
import { matchingApproval } from './filters.mjs';

const preference = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'kimi-k3', 'deepseek-v4.1-flash', 'opus', 'sonnet', 'haiku'];
export function orderCandidates(task, snapshot, rows) {
  // Effort is an approved quality stage, not a speed/expiry bidding dimension.
  const minimum = new Map();
  for (const { candidate: c } of rows) minimum.set(c.modelId, Math.min(minimum.get(c.modelId) ?? Infinity, EFFORTS.indexOf(c.effort)));
  let cohort = rows.filter(({ candidate: c }) => EFFORTS.indexOf(c.effort) === minimum.get(c.modelId));
  if (adversarial(task) && cohort.length) {
    const lock = (r) => ['kimi-k3', 'deepseek-v4.1-flash', 'opus'].indexOf(r.candidate.modelId);
    const first = Math.min(...cohort.map(lock));
    cohort = cohort.filter((r) => lock(r) === first);
  }
  const companyClass = (r) => company(candidateParts(snapshot, r.candidate).account)
    || matchingApproval(task, snapshot, r.candidate, 'personal-quota', true) ? 0 : 1;
  if (cohort.some((r) => companyClass(r) === 0)) cohort = cohort.filter((r) => companyClass(r) === 0);
  const freeLight = !task.background && task.tier === 'light' && cohort.some((r) => company(candidateParts(snapshot, r.candidate).account) && r.estimate.noPrioritySpend === true);
  if (freeLight) cohort = cohort.filter((r) => r.estimate.noPrioritySpend === true);
  const costShape = (r) => r.estimate.costs.map((c) => [c.bucketId, c.unit]);
  const costComparable = cohort.length > 0 && cohort[0].estimate.costs.length > 0 && cohort.every((r) => stable(costShape(r)) === stable(costShape(cohort[0]))
    && r.estimate.costs.every((c) => c.normalizedShare !== null));
  const terms = (r) => {
    const c = r.candidate, e = r.estimate;
    const lock = adversarial(task) ? ['kimi-k3', 'deepseek-v4.1-flash', 'opus'].indexOf(c.modelId) : 0;
    const quotaClass = e.expiryOpportunity === true ? 0 : e.noPrioritySpend === true ? 1 : 2;
    const cost = costComparable ? e.costs.map((c) => c.normalizedShare) : [];
    const common = [lock, companyClass(r)];
    const scheduling = task.background ? [quotaClass, ...cost, e.expiryOpportunity === true ? 0 : 1, e.completionMin]
      : [e.completionMin, e.noPrioritySpend === true ? 0 : 1, e.expiryOpportunity === true ? 0 : 1, ...cost];
    const pref = preference.indexOf(c.modelId);
    return [...common, ...scheduling, pref < 0 ? preference.length : pref, c.accountId, c.laneId, EFFORTS.indexOf(c.effort), c.id];
  };
  const decorated = cohort.map((r) => ({ ...r, orderingTerms: terms(r) }));
  decorated.sort((a, b) => {
    for (let i = 0; i < a.orderingTerms.length; i++) { const n = compare(a.orderingTerms[i], b.orderingTerms[i]); if (n) return n; }
    return 0;
  });
  return freeze({ rows: decorated, winner: decorated[0] ?? null, runnerUp: decorated[1] ?? null,
    terms: { costComparable, freeLight, policyLock: adversarial(task) ? 'kimi-deepseek-scoped-opus' : null, background: task.background } });
}
export const choose = (task, snapshot, rows) => orderCandidates(task, snapshot, rows).winner;
