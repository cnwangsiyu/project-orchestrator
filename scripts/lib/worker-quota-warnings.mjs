// Numeric quota snapshots only; sampling remains owned by the existing quota reader.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';
import { readEvents, quotaRunningWorkers, followerAlive, appendWorkerQuotaAlert } from './worker-events.mjs';

const MINUTE = 60000;
export const quotaWarningFile = () => path.join(rulesShared(), 'worker-quota-warnings.json');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
  if (error.code === 'ENOENT') return { version: 1, buckets: {} }; throw error;
} };
export const readQuotaWarnings = (file = quotaWarningFile()) => read(file);
export const cachedWorkerQuota = () => {
  try { return JSON.parse(fs.readFileSync(process.env.QUOTA_CACHE || path.join(rulesShared(), 'quota.json'), 'utf8')); }
  catch { return null; }
};
const modelId = value => String(value ?? '').toLowerCase();
export const numericQuotaSampledAt = (account, data) => account.kind === 'ttadk'
  ? account.usageSeenAt ?? account.usage?.sampledAt ?? account.seenAt ?? data?.checkedAt
  : account.quota?.sampledAt ?? data?.checkedAt;
export function dailyWarningBuckets(data, now = Date.now()) {
  return (data?.codexAccounts ?? []).flatMap(account => {
    const buckets = account.kind === 'ttadk' ? [{ ...account.usage, model: null, sampledAt: numericQuotaSampledAt(account, data) }]
      : account.kind === 'trae' ? Object.entries(account.quota?.daily ?? {}).map(([model, bucket]) => ({
        ...bucket, model: modelId(model), sampledAt: numericQuotaSampledAt(account, data) })) : [];
    return buckets.filter(bucket => Number.isFinite(bucket.used) && bucket.used >= 0
      && Number.isFinite(bucket.limit) && bucket.limit > 0 && Number.isFinite(bucket.resetsAt) && bucket.resetsAt > now
      && Number.isFinite(bucket.sampledAt) && bucket.sampledAt <= now && now - bucket.sampledAt <= 15 * MINUTE)
      .map(bucket => ({ ...bucket, account: account.name, kind: account.kind,
        id: JSON.stringify([account.name, bucket.model]), period: bucket.resetsAt }));
  });
}
export function quotaBurn(samples, current) {
  const prior = samples.filter(sample => sample.t < current.t && sample.t >= current.t - 60 * MINUTE
    && current.t - sample.t >= 30 * MINUTE && sample.used <= current.used).sort((a, b) => a.t - b.t)[0];
  if (!prior) return { perMinute: null, windowMinutes: null, exhaustionMinutes: current.used >= current.limit ? 0 : null };
  const windowMinutes = (current.t - prior.t) / MINUTE;
  const perMinute = (current.used - prior.used) / windowMinutes;
  return { perMinute, windowMinutes, exhaustionMinutes: current.used >= current.limit ? 0
    : perMinute > 0 ? (current.limit - current.used) / perMinute : null };
}
const alertText = (bucket, threshold, burn, turns) => {
  const number = n => Number(n.toFixed(2));
  return `quota-warning: ${bucket.account}${bucket.model ? '/' + bucket.model : ''} crossed ${threshold}% used; `
    + `${bucket.used}/${bucket.limit}; burn=${burn.perMinute == null ? 'unknown (need 30–60m samples)' : `${number(burn.perMinute)}/min over ${number(burn.windowMinutes)}m`}; `
    + `exhaustion=${burn.exhaustionMinutes == null ? 'unknown' : `${number(burn.exhaustionMinutes)}m`}; reset=${new Date(bucket.resetsAt).toISOString()}; `
    + `running turns: ${turns.map(row => `${row.name ?? row.task ?? '?'} ${row.thread ?? 'launching'}/${row.turn ?? '?'}`).join(', ')}.`;
};
export function checkQuotaWarnings({ data = cachedWorkerQuota(), rows = readEvents(), now = Date.now(),
  file = quotaWarningFile(), emit = appendWorkerQuotaAlert, alive = followerAlive } = {}) {
  const buckets = dailyWarningBuckets(data, now);
  if (!buckets.length) return [];
  const running = quotaRunningWorkers(rows, alive);
  return withLock(file, () => {
    const state = read(file), emitted = [];
    state.buckets ??= {};
    for (const [id, bucket] of Object.entries(state.buckets)) if (bucket.resetsAt <= now) delete state.buckets[id];
    for (const bucket of buckets) {
      const old = state.buckets[bucket.id];
      // Ignore an out-of-order cache writer rather than reopening an already warned period.
      if (old && old.period > bucket.period) continue;
      const saved = old?.period === bucket.period ? old : { account: bucket.account, model: bucket.model,
        period: bucket.period, resetsAt: bucket.resetsAt, samples: [], notices: {} };
      const sample = { t: bucket.sampledAt, used: bucket.used, limit: bucket.limit };
      if (saved.samples.at(-1)?.t > sample.t) continue;
      if (saved.samples.at(-1)?.t !== sample.t) saved.samples.push(sample);
      saved.samples = saved.samples.filter(s => s.t >= sample.t - 60 * MINUTE).slice(-120);
      const burn = quotaBurn(saved.samples, sample);
      Object.assign(saved, { used: bucket.used, limit: bucket.limit, sampledAt: sample.t, burn });
      const matching = running.filter(row => row.account === bucket.account
        && (bucket.model == null || modelId(row.actualModel ?? row.model) === bucket.model));
      for (const owner of new Set(matching.map(row => row.owner))) {
        const turns = matching.filter(row => row.owner === owner);
        for (const threshold of [80, 90]) {
          if (bucket.used / bucket.limit * 100 < threshold || saved.notices[owner]?.[threshold]) continue;
          const warningId = createHash('sha256').update(JSON.stringify([bucket.id, bucket.period, owner, threshold])).digest('hex');
          const row = { ...turns[0], event: 'message', kind: 'quota-warning', severity: threshold === 90 ? 'risk' : 'info',
            wake: threshold === 90, warningId, threshold, used: bucket.used, limit: bucket.limit, burn,
            resetsAt: bucket.resetsAt, quotaModel: bucket.model,
            turns: turns.map(({ thread, turn, name }) => ({ thread, turn, name })), text: alertText(bucket, threshold, burn, turns) };
          const delivered = emit(row, warningId, { alive, format: turns => ({ text: alertText(bucket, threshold, burn, turns) }) });
          if (delivered === null) continue; // Suppression must leave the notice available for a later running turn.
          (saved.notices[owner] ??= {})[threshold] = { at: now, warningId };
          emitted.push(delivered ?? row);
        }
      }
      state.buckets[bucket.id] = saved;
    }
    writeJson(file, state);
    return emitted;
  }, { timeoutMs: 200, retryMs: 20, ownerPid: true });
}
