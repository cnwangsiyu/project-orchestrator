import fs from 'node:fs';
import path from 'node:path';
import { withLock, writeJson } from './shared-file.mjs';

export const denialFile = (shared, account) => {
  if (!['main', 'b'].includes(account)) throw Error('unknown personal account');
  return path.join(shared, `${account}-provider-denial.json`);
};
const finite = value => Number.isFinite(value) && value >= 0;
export function isUsageLimitExceeded(error) {
  if (typeof error === 'string') return /\busageLimitExceeded\b|\busage[_ -]limit[_ -]exceeded\b|you(?:'|\u2019)ve hit your usage limit/i.test(error);
  if (!error || typeof error !== 'object') return false;
  return ['code', 'type', 'codexErrorInfo', 'errorCode', 'message', 'error', 'data'].some(field => isUsageLimitExceeded(error[field]));
}

export function recordPersonalProviderDenial({ shared, account = 'main', error, thread, turn, observation, now = Date.now() }) {
  if (!isUsageLimitExceeded(error)) return null;
  const windows = (observation?.windows ?? []).filter(window => finite(window.used) && finite(window.resetsAt))
    .map(({ used, resetsAt, windowMins }) => ({ used, resetsAt, windowMins }));
  const limiting = windows.filter(window => window.used >= 95 && window.resetsAt > now);
  const resetsAt = limiting.length ? Math.min(...limiting.map(window => window.resetsAt)) : null;
  const denial = { account, code: 'usageLimitExceeded', at: now, resetsAt, thread, turn, windows };
  let recorded = denial;
  withLock(denialFile(shared, account), () => {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(denialFile(shared, account), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (thread && turn && previous?.receipts?.some(receipt => receipt.thread === thread && receipt.turn === turn)) {
      recorded = previous;
      return;
    }
    const receipts = (previous?.receipts ?? (previous ? [previous] : []))
      .filter(receipt => receipt.thread !== thread || receipt.turn !== turn);
    receipts.push({ thread, turn, code: denial.code, at: now });
    writeJson(denialFile(shared, account), { ...denial, receipts: receipts.slice(-128) });
  }, { timeoutMs: 0 });
  return recorded;
}

export function activePersonalProviderDenial({ shared, account = 'main', observation, now = Date.now() }) {
  let denial;
  try { denial = JSON.parse(fs.readFileSync(denialFile(shared, account), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    return { code: 'usageLimitExceeded', at: now, resetsAt: null, unreadable: true };
  }
  if (denial?.account !== account || denial.code !== 'usageLimitExceeded' || !finite(denial.at))
    return { code: 'usageLimitExceeded', at: now, resetsAt: null, unreadable: true };
  const at = observation?.seenAt;
  if (observation?.allowed === true && finite(at) && at > denial.at && at <= now && now - at <= 600000
    && !observation.observationStale && !observation.stateUnknown && !observation.statusReadFailed) {
    const recovered = finite(denial.resetsAt) && at >= denial.resetsAt || (denial.windows ?? []).some(old => old.used > 0
      && (observation.windows ?? []).some(window => window.windowMins === old.windowMins && finite(window.used)
        && (window.resetsAt > old.resetsAt || window.used < old.used)));
    if (recovered) return null;
  }
  return denial;
}
