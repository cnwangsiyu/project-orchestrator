// Read current public policy/quota metadata at each new-thread boundary.
import fs from 'node:fs';
import path from 'node:path';
import { company } from './pipeline/common.mjs';
import { PERSONAL_PRIORITY_FILE, personalAccount, windowIncludes, personalPriorityWindow, activePersonalPriority } from './pipeline/personal-priority.mjs';
import { publishPersonalQuota, readQuotaCache } from './routing-observations.mjs';
import { readPersonalCodexQuota } from './codex-quota.mjs';
import { activePersonalProviderDenial } from './main-provider-denial.mjs';

export function assertExclusiveNewThread({ account = 'main', vendor = 'codex', continuation,
  profiles = {}, shared, name, time = Date.now(), cache }, allowRefresh = true) {
  if (continuation || vendor !== 'codex') return;
  const refuse = detail => { throw Object.assign(Error(`[personal-exclusive-launch-refused] ${detail}; re-route ${name ?? account} under the current policy before starting a new thread.`),
    { code: 'PERSONAL_EXCLUSIVE_LAUNCH_REFUSED', exitCode: 1 }); };
  if (company(profiles[account]) || !profiles[account] && ['ttadk', 'trae'].includes(account)) return;
  const cacheFile = cache ?? process.env.QUOTA_CACHE ?? path.join(shared, 'quota.json');
  const data = readQuotaCache(cacheFile);
  const main = Array.isArray(data?.codexAccounts) ? data.codexAccounts.find(a => a?.name === account) : null;
  if (personalAccount(account) && activePersonalProviderDenial({ shared, account, observation: main && { ...main, seenAt: main.seenAt ?? data.checkedAt }, now: time }))
    refuse(`${account} provider usageLimitExceeded denial is still active; reroute`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(shared, PERSONAL_PRIORITY_FILE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; refuse('current personal priority window is unreadable'); }
  const valid = personalPriorityWindow(raw);
  if (!valid) refuse('current personal priority window is invalid');
  const window = activePersonalPriority(valid, time);
  if (window?.mode !== 'exclusive') return;
  if (!windowIncludes(window, account)) refuse(`exclusive personal window is active: ${account} is ineligible`);
  if (profiles[account]?.kind !== undefined && profiles[account].kind !== 'chatgpt') refuse(`personal account metadata for ${account} is unavailable`);
  const at = main?.seenAt ?? data?.checkedAt;
  const available = main?.live === true && !main.stateUnknown && !main.statusReadFailed
    && main.loggedIn !== false && main.healthy !== false && main.allowed !== false
    && (main.kind === undefined || main.kind === 'chatgpt') && Array.isArray(main.windows)
    && main.windows.every(w => w && typeof w === 'object' && Number.isFinite(w.used) && w.used >= 0);
  const unavailable = `fresh ${account} quota and availability telemetry is unavailable (refresh quota.mjs --fresh)`;
  if (!available || !Number.isFinite(at) || at > time) refuse(unavailable);
  if (main.observationStale || time - at > 600000) {
    if (!allowRefresh) refuse(unavailable);
    try {
      const observed = readPersonalCodexQuota(account, profiles[account]);
      publishPersonalQuota(cacheFile, { ...observed, name: account, seenAt: Date.now(), observationStale: false });
    } catch { refuse(unavailable); }
    return assertExclusiveNewThread({ account, vendor, profiles, shared, name, cache: cacheFile }, false);
  }
}
