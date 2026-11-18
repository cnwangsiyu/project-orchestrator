import { median } from '../eta.mjs';
import { known } from './common.mjs';

export const RUN_USAGE_HISTORY_MS = 14 * 86400000;

export function ttadkReserve(task, snapshot, account) {
  if (account.kind !== 'ttadk') return null;
  const quota = known(account.quota.find(q => q.bucketId === 'ttadk-daily' && q.unit === 'tokens')?.usage);
  if (!quota || quota.resetsAt <= snapshot.decisionAt) return null;
  const recent = (snapshot.runUsage ?? []).filter(r => r.accountId === account.id && r.category === task.category);
  const p50 = recent.length ? median(recent.map(r => r.cumulativeInput)) : 0;
  const remaining = Math.max(0, quota.limit - quota.used);
  const reserve = Math.max(quota.limit * 0.05, p50);
  if (remaining >= reserve) return null;
  return `TTADK (${account.id}) near-exhausted until ${new Date(quota.resetsAt).toISOString()}: ${remaining} input tokens remaining, below the ${Math.ceil(reserve)}-token reserve for new ${task.category} routes (${p50 > quota.limit * 0.05 ? 'recent finished-run p50' : '5% of daily limit'}).`;
}
