// Tick reads use only the requested company's normal signed-in hub interface.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readProfiles, traeQuota, selectDailyQuota } from './state.mjs';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';

const numeric = bucket => Number.isFinite(bucket?.used) && bucket.used >= 0
  && Number.isFinite(bucket.limit) && bucket.limit > 0 && Number.isFinite(bucket.resetsAt);
export function readRequestedCompanyQuota({ accounts = [], profiles = readProfiles(),
  execute = execFileSync, now = Date.now() } = {}) {
  const updates = [], statuses = {};
  for (const name of new Set(accounts)) {
    const profile = profiles[name];
    if (!['trae', 'ttadk'].includes(profile?.kind)) { statuses[name] = 'unavailable'; continue; }
    try {
      // No account-wide refresh, export command, or direct login-file read.
      const payload = JSON.parse(execute(process.execPath, [new URL('../codex-worker.mjs', import.meta.url).pathname,
        '--account', name, 'usage'], { encoding: 'utf8', timeout: 25000, maxBuffer: 2 << 20,
        stdio: ['ignore', 'pipe', 'ignore'] }));
      if (profile.kind === 'trae') {
        const quota = traeQuota(payload, now);
        if (!Object.values(quota?.daily ?? {}).some(numeric)) { statuses[name] = 'unavailable'; continue; }
        updates.push({ name, quota, quotaError: null });
      } else {
        const usage = selectDailyQuota(payload.quotas ?? payload.data ?? payload).usage;
        if (!numeric(usage)) { statuses[name] = 'unavailable'; continue; }
        updates.push({ name, usage, usageSeenAt: now, usageError: null });
      }
      statuses[name] = 'ok';
    } catch { statuses[name] = 'unavailable'; }
  }
  if (updates.length) {
    const file = process.env.QUOTA_CACHE || path.join(rulesShared(), 'quota.json');
    withLock(file, () => {
      let cached;
      try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; cached = {}; }
      cached.codexAccounts ??= [];
      for (const update of updates) {
        const account = cached.codexAccounts.find(account => account.name === update.name);
        if (account) Object.assign(account, update);
        else cached.codexAccounts.push({ ...update, kind: profiles[update.name].kind });
      }
      // Numeric sampling does not freshen routing status or other accounts.
      writeJson(file, cached);
    }, { timeoutMs: 200, retryMs: 20, ownerPid: true });
  }
  return { status: Object.values(statuses).every(status => status === 'ok') ? 'ok' : 'unavailable', accounts: statuses };
}
