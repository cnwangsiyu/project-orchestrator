import { known } from './common.mjs';

export function lowPriorityStart(lane) {
  if (known(lane.ownWaiting)) return { minutes:null, reason:'another turn is waiting on this model' };
  const family = known(lane.familyQueue);
  const queues = [known(lane.lowQueue), family?.lowPriority === true && family].filter(q => q?.position > 0 || q?.position === 0 && q.drainPerMin > 0);
  if (queues.some(q => !(Number.isFinite(q.position) && Number.isFinite(q.drainPerMin) && q.drainPerMin > 0)))
    return { minutes:null, reason:'low-priority queue has no measured drain' };
  if (queues.length) {
    const slowest = queues.reduce((a,b) => a.position/a.drainPerMin >= b.position/b.drainPerMin ? a : b);
    return { minutes:slowest.position/slowest.drainPerMin, basis:'queue', position:slowest.position, drainPerMin:slowest.drainPerMin };
  }
  const minutes = known(lane.lowStart);
  return minutes === null ? { minutes:null, reason:'low-priority start unmeasured' } : { minutes,basis:'observed-start' };
}

// Only TRAE model buckets describe a provider low-priority lane. TTADK's
// authoritative daily denial covers the account and cannot be opted into.
export function dayExhaustion(account, lane, now) {
  if (account.kind === 'ttadk' && account.fallbackUnavailable?.kind === 'quota-exhausted')
    return { until: account.fallbackUnavailable.until };
  if (account.kind !== 'trae') return null;
  const bucket = account.quota.find(q => q.bucketId === lane.modelId), usage = known(bucket?.usage);
  const until = usage?.resetsAt ?? known(bucket?.partialReset);
  if (until != null && until <= now) return null;
  if (usage ? usage.used >= usage.limit || usage.depleted === true || usage.remaining === 0 : known(bucket?.priority) === 'depleted')
    return { until: until ?? null };
  return null;
}
