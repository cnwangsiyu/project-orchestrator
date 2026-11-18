import { idOK, isAstra, known, nonnegative, object } from './common.mjs';

export const PERSONAL_PRIORITY_FILE = 'personal-priority-window.json';
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function personalPriorityWindow(raw) {
  if (!object(raw) || raw.account !== 'main' || raw.mode !== 'prefer-first'
    || !idOK(raw.userDecisionRef) || !raw.userDecisionRef.startsWith('standing:personal-priority-')
    || typeof raw.quote !== 'string' || !raw.quote.trim() || typeof raw.revoked !== 'boolean'
    || !utc.test(raw.from) || !utc.test(raw.until)) return null;
  const from = Date.parse(raw.from), until = Date.parse(raw.until);
  if (!nonnegative(from) || !nonnegative(until) || from >= until) return null;
  // Optional user decision "spend the account until it is used up": only the used
  // percentage guards the window, at this value; the projection guard is off.
  const exhaust = raw.exhaustAtUsed;
  if (exhaust !== undefined && !(Number.isInteger(exhaust) && exhaust >= 90 && exhaust <= 100)) return null;
  return { account: raw.account, mode: raw.mode, from: new Date(from).toISOString(), until: new Date(until).toISOString(),
    userDecisionRef: raw.userDecisionRef, quote: raw.quote, revoked: raw.revoked,
    ...(exhaust === undefined ? {} : { exhaustAtUsed: exhaust }) };
}

export function activePersonalPriority(raw, now) {
  const window = personalPriorityWindow(raw);
  return window && !window.revoked && Date.parse(window.from) <= now && now < Date.parse(window.until) ? window : null;
}

export function personalPriorityGuard(snapshot) {
  const window = snapshot.personalPriority;
  if (!window) return null;
  const account = snapshot.accounts.find(a => a.id === window.account && a.kind === 'chatgpt');
  const budget = account?.budget;
  const weekly = known(budget)?.weekly;
  // The decision may name a reset at minute precision. Guard against using the
  // next week's telemetry if the observed reset precedes the window expiry.
  if (budget?.source === 'last-good-stale' || !nonnegative(weekly?.used) || !nonnegative(weekly?.projected)
    || !nonnegative(weekly?.resetsAt) || weekly.resetsAt <= snapshot.decisionAt
    || Math.abs(weekly.resetsAt - Date.parse(window.until)) >= 60000)
    return 'fresh weekly quota for this reset is unavailable';
  if (window.exhaustAtUsed !== undefined)
    return weekly.used >= window.exhaustAtUsed
      ? `weekly quota used up (used ${weekly.used}% / ${window.exhaustAtUsed}% spend-until threshold)` : null;
  if (weekly.used >= 90 || weekly.projected >= 95)
    return `weekly quota guard (used ${weekly.used}% / 90% threshold, projected at reset ${weekly.projected}% / 95% threshold)`;
  return null;
}

export function standingPersonalPriority(task, snapshot, candidate, account) {
  const window = snapshot.personalPriority;
  if (!window || account.id !== window.account || account.kind !== 'chatgpt' || candidate.family !== 'gpt'
    || candidate.effort === 'max' || task.requirements.resetRedemption || task.reviewClass
    || task.contentLabels.some(l => ['security', 'adversarial', 'attack-material', 'policy-blocked'].includes(l))) return null;
  const fallback = snapshot.personalFallback;
  const astraApprovalRef = isAstra(candidate.modelId) && task.tier === 'hard' && fallback?.enabled && fallback.allowHardPersonalAstra
    ? fallback.hardAstraDecisionRef : null;
  if ((isAstra(candidate.modelId) && !astraApprovalRef) || personalPriorityGuard(snapshot)) return null;
  return { approvalRef: window.userDecisionRef, quotaApproved: true, astraApprovalRef,
    text: `personal ${window.account} first under the standing routing window until ${window.until}` };
}
