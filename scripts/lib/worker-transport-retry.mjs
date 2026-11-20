import fs from 'node:fs';
import path from 'node:path';
import { rulesShared } from './global-rules.mjs';
import { poolOf } from './trae-health.mjs';

export const TRANSPORT_BACKOFF_MS = 60000;
export const TRANSPORT_CONTINUE_MESSAGE = 'The previous turn was cut off by a network/stream error. Continue the task from where you stopped; do not redo finished steps; re-check the state of anything you were changing.';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return e.code === 'ENOENT' ? {} : null; } };
export const transportHealthBlock = ({ home, model, now = Date.now() }) => {
  const health = read(path.join(home,'worker-health.json'));
  const lanes = read(path.join(home,'lane-state.json')), queues = read(path.join(home,'queue-state.json'));
  if (!health || !lanes || !queues) return 'lane health metadata unreadable';
  const family = poolOf(model), id = String(model ?? '').toLowerCase();
  for (const row of [health,health.pools?.[family],health.modelPauses?.[id]].filter(Boolean))
    if (row.pausedUntil > now || row.kind === 'hard' && row.pausedUntil) return 'lane paused or awaiting a recovery probe';
  for (const row of [lanes[id],queues[family]].filter(Boolean)) {
    const at = row.t ?? row.at;
    if (at <= now && now - at <= 30 * 60000 && (row.stalled || row.state === 'stalled'
      || ['waiting','queued'].includes(row.state) && (row.progress === false || row.position > 0 && row.drainPerMin <= 0))) return 'lane stalled';
  }
  return null;
};
export const transportQuotaBlock = ({ kind, payload, account, now = Date.now(), cache }) => {
  if (kind === 'trae') {
    const usage = payload?.usage;
    if (usage?.is_depleted === true || usage?.quota_remaining != null && Number(usage.quota_remaining) <= 0) return 'lane quota exhausted';
    if (usage?.quota_remaining != null && Number(usage.quota_remaining) > 0) return null;
    return 'lane quota unknown';
  }
  if (kind === 'ttadk') {
    const data = cache ?? read(process.env.QUOTA_CACHE || path.join(rulesShared(),'quota.json'));
    const row = data?.codexAccounts?.find(r => r.name === account), sampledAt = row?.usage?.sampledAt ?? row?.seenAt ?? data?.checkedAt;
    if (!row || !(sampledAt <= now && now - sampledAt <= 15 * 60000) || !(row.usage?.resetsAt > now)) return 'lane quota unknown or stale';
    if (row.healthy === false || row.live === false || row.providerDenied || !(row.usage.used < row.usage.limit)) return 'lane unavailable or quota exhausted';
    return null;
  }
  const buckets = payload?.rateLimitsByLimitId ?? (payload?.rateLimits ? { codex:payload.rateLimits } : {});
  const bucket = buckets.codex;
  if (!bucket) return 'lane quota unknown';
  if (bucket.credits?.unlimited === true) return null;
  const windows = [bucket.primary,bucket.secondary].filter(r => r && Number.isFinite(r.usedPercent));
  if (!windows.length) return 'lane quota unknown';
  return windows.some(r => r.usedPercent >= 100) ? 'lane quota exhausted' : null;
};
export async function boundedTransportRead(readQuota, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([readQuota(),new Promise((_,reject) => { timer = setTimeout(() => reject(Error('quota read timed out')),timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
