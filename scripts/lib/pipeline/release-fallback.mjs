import { company, known, matchesModel, newestRelease, policyModel } from './common.mjs';
import { candidateParts } from './candidates.mjs';
import { estimateCandidate } from './estimate.mjs';

const quotaFor = (account, id) => account.quota.find(q => q.bucketId === id)
  ?? (account.kind === 'ttadk' ? account.quota[0] : null);
const restricted = (snapshot, c) => snapshot.health.some(h => h.accountId === c.accountId
  && (!h.modelId || h.modelId === c.modelId) && (!h.family || h.family === c.family)
  && (h.restricted || h.recovery === 'awaiting-probe'));

// A capacity exception for the immediately previous release, never a new
// quality ordering or permission to step down after a rejected answer.
export function releaseUnavailable(task, snapshot, c) {
  const { account, lane } = candidateParts(snapshot, c);
  if (task.exclusions.some(e => (!e.companyOnly || company(account)) && (!e.accountId || e.accountId === c.accountId)
    && (e.scope === 'account' ? e.value === c.accountId : e.scope === 'family' ? e.value === c.family : matchesModel(e.value, c.modelId))))
    return 'excluded by flag';
  if (restricted(snapshot, c)) return 'restricted or awaiting a recovery probe';
  const q = quotaFor(account, c.modelId), usage = known(q?.usage);
  if (usage?.resetsAt > snapshot.decisionAt && (usage.used >= usage.limit || usage.depleted === true || usage.remaining === 0))
    return `day quota exhausted until ${new Date(usage.resetsAt).toISOString()}`;
  if (known(q?.priority) === 'depleted' || lane.mode === 'low-priority') return 'in the provider low-priority queue';
  const estimate = estimateCandidate(task, snapshot, c);
  if (estimate.stalled) return 'queue stalled with no observed progress';
  if (estimate.patienceMin !== null && estimate.startDelayMin > estimate.patienceMin)
    return `queue start exceeds ${estimate.patienceMin} min patience`;
  return null;
}

export function previousReleaseFallback(task, snapshot, c) {
  const { account } = candidateParts(snapshot, c), rung = policyModel(c.modelId);
  if (!company(account) || !['sol', 'astra'].includes(rung)) return null;
  const catalog = known(account.catalog) ?? [], newest = newestRelease(catalog, rung);
  if (c.modelId === newest || c.modelId !== newestRelease(catalog.filter(id => id !== newest), rung)) return null;
  const usage = known(quotaFor(account, c.modelId)?.usage);
  if (!usage || usage.resetsAt <= snapshot.decisionAt || !(usage.limit > usage.used) || usage.depleted === true
    || usage.remaining != null && !(usage.remaining > 0) || releaseUnavailable(task, snapshot, c)) return null;
  const latestLanes = snapshot.lanes.filter(l => l.accountId === c.accountId && l.modelId === newest
    && known(l.efforts)?.includes(c.effort) && (l.selectable || l.evidenced));
  if (!latestLanes.length) return null;
  const reasons = latestLanes.map(l => releaseUnavailable(task, snapshot, { ...c, modelId: newest, laneId: l.id, harness: l.harness }));
  if (reasons.some(why => !why)) return null;
  return { newest, previous: c.modelId, text: `${newest} ${reasons[0]}; using previous release ${c.modelId} on the same company account ${account.id}` };
}
