// Reuse the quota reader in a bounded noninteractive child; never handle its login material here.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rulesShared } from './global-rules.mjs';
import { readProfiles } from './state.mjs';
import { withLock, writeJson } from './shared-file.mjs';
import { readEvents, workerRunStates, followerAlive, appendWorkerAlert } from './worker-events.mjs';
import { cachedWorkerQuota, checkQuotaWarnings } from './worker-quota-warnings.mjs';

const fileOf = () => path.join(rulesShared(), 'worker-quota-refresh.json');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
  if (error.code === 'ENOENT') return {}; throw error;
} };
export const readQuotaRefreshState = (file = fileOf()) => read(file);
export function refreshWorkerQuota({ timeoutMs = 30000, accounts = [] } = {}) {
  const source = `import {readRequestedCompanyQuota} from ${JSON.stringify(new URL('./worker-company-quota.mjs', import.meta.url).href)};
    console.log(JSON.stringify(readRequestedCompanyQuota({accounts:${JSON.stringify(accounts)}})));`;
  return new Promise(resolve => {
    let output = '', settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    // This awaited helper owns its process group, including synchronous CLI
    // children. It is never unref'ed; timeout/owner exit close the owned group.
    const cleanup = (signal = 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
      catch { child.kill(signal); }
    };
    const onExit = () => cleanup('SIGKILL');
    const timer = setTimeout(() => { cleanup('SIGKILL'); finish({ status: 'failed' }); }, timeoutMs);
    process.once('exit', onExit);
    child.stdout.on('data', chunk => { if (output.length < 4096) output += chunk; });
    child.once('error', () => { clearTimeout(timer); finish({ status: 'failed' }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      process.removeListener('exit', onExit);
      if (code !== 0 || signal) return finish({ status: 'failed' });
      try { const result = JSON.parse(output.trim()); finish(['ok', 'failed', 'unavailable'].includes(result.status) ? result : { status: 'failed' }); }
      catch { finish({ status: 'failed' }); }
    });
  });
}
export async function pollWorkerQuota({ owner, data = cachedWorkerQuota(), rows = readEvents(), now = Date.now(),
  file = fileOf(), profiles, alive = followerAlive, refresh = refreshWorkerQuota, emit = appendWorkerAlert,
  readSnapshot = cachedWorkerQuota } = {}) {
  try {
    if (!owner) return { status: 'idle' };
    profiles ??= readProfiles();
    const companies = new Set([...(data?.codexAccounts ?? []).filter(a => ['trae', 'ttadk'].includes(a.kind)).map(a => a.name),
      ...Object.entries(profiles).filter(([, p]) => ['trae', 'ttadk'].includes(p.kind)).map(([name]) => name)]);
    const running = [...workerRunStates(rows).values()].map(({ row }) => row).filter(row => row.owner === owner
      && companies.has(row.account) && row.event === 'running' && !row.settled && alive(row));
    if (!running.length) return { status: 'idle' };
    const requested = [...new Set(running.map(row => row.account))];
    const cacheAt = name => {
      const account = data?.codexAccounts?.find(account => account.name === name);
      return account?.quota?.sampledAt ?? account?.usageSeenAt ?? account?.seenAt ?? data?.checkedAt ?? null;
    };
    const stale = !Number.isFinite(data?.checkedAt) || now - data.checkedAt > 15 * 60000
      || (data?.codexAccounts ?? []).some(account => running.some(row => row.account === account.name)
        && Number.isFinite(account.quota?.sampledAt) && now - account.quota.sampledAt > 15 * 60000);
    if (!stale) { checkQuotaWarnings({ data, rows, now }); return { status: 'fresh' }; }
    let targets = requested;
    const claim = withLock(file, () => {
      const state = read(file);
      targets = requested.filter(account => state.accounts?.[account] !== 'unavailable'
        || state.accountCacheAt?.[account] !== cacheAt(account));
      if (!targets.length) return null;
      if (Number.isFinite(state.lastAttempt) && now - state.lastAttempt < 10 * 60000) return null;
      const attempt = randomUUID();
      writeJson(file, { ...state, lastAttempt: now, attempt, status: 'refreshing', cacheAt: data?.checkedAt ?? null });
      return attempt;
    }, { timeoutMs: 200, retryMs: 20, ownerPid: true });
    let refreshed = { status: read(file).status === 'unavailable' ? 'unavailable' : 'throttled' };
    if (claim) {
      try { refreshed = await refresh({ timeoutMs: 30000, accounts: targets }); }
      catch { refreshed = { status: 'failed' }; }
      if (!['ok', 'failed', 'unavailable'].includes(refreshed?.status)) refreshed = { status: 'failed' };
      withLock(file, () => {
        const state = read(file);
        if (state.attempt !== claim) return;
        writeJson(file, { ...state, status: refreshed.status,
          consecutiveFailures: refreshed.status === 'failed' ? (state.consecutiveFailures ?? 0) + 1 : 0,
          accounts: { ...state.accounts, ...refreshed.accounts },
          accountCacheAt: { ...state.accountCacheAt, ...Object.fromEntries(targets.map(account => [account, cacheAt(account)])) } });
      }, { timeoutMs: 200, retryMs: 20, ownerPid: true });
    }
    withLock(file, () => {
      const state = read(file), day = new Date(now).toISOString().slice(0, 10);
      for (const [account, status] of Object.entries(state.accounts ?? {})) {
        if (status !== 'unavailable' || !running.some(row => row.account === account)
          || state.unavailableNotices?.[owner]?.[account] === day) continue;
        emit({ ...running.find(row => row.account === account), event: 'message', kind: 'info', wake: false,
          text: `quota warnings unavailable for ${account}: normal signed-in usage provides no numeric quota` },
        `quota-refresh-failure:${owner}:${account}:${day}`);
        ((state.unavailableNotices ??= {})[owner] ??= {})[account] = day;
        writeJson(file, state);
      }
      if ((state.consecutiveFailures ?? 0) >= 3 && state.notices?.[owner] !== day) {
        const alertId = `quota-refresh-failure:${owner}:${day}`;
        emit({ ...running[0], event: 'message', kind: 'info', wake: false,
          text: 'quota warnings unavailable: refresh failing' }, alertId);
        (state.notices ??= {})[owner] = day; writeJson(file, state);
      }
    }, { timeoutMs: 200, retryMs: 20, ownerPid: true });
    checkQuotaWarnings({ data: claim ? readSnapshot() : data, rows, now: Date.now() });
    return refreshed;
  } catch { return { status: 'unavailable' }; } // Monitoring never fails or interrupts a turn.
}
