import { idOK, isAstra, known, nonnegative, object } from './common.mjs';
import { modelPreference } from './policy.mjs';
import { PERSONAL_LAUNCH_HEADROOM } from '../personal-launch.mjs';

export const PERSONAL_PRIORITY_FILE = 'personal-priority-window.json';
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function personalPriorityWindow(raw) {
  if (!object(raw) || raw.account !== 'main' || !['prefer-first', 'exclusive'].includes(raw.mode)
    || !idOK(raw.userDecisionRef) || !raw.userDecisionRef.startsWith('standing:personal-priority-')
    || typeof raw.quote !== 'string' || !raw.quote.trim() || typeof raw.revoked !== 'boolean'
    || !utc.test(raw.from) || !(utc.test(raw.until) || raw.mode === 'exclusive' && raw.until == null)) return null;
  const from = Date.parse(raw.from), until = raw.until == null ? null : Date.parse(raw.until);
  if (!nonnegative(from) || until !== null && (!nonnegative(until) || from >= until)) return null;
  // Optional user decision "spend the account until it is used up": only the used
  // percentage guards the window, at this value; the projection guard is off.
  const exhaust = raw.exhaustAtUsed;
  if (exhaust !== undefined && !(Number.isInteger(exhaust) && exhaust >= 90 && exhaust <= 100)) return null;
  return { account: raw.account, mode: raw.mode, from: new Date(from).toISOString(), until: until === null ? null : new Date(until).toISOString(),
    userDecisionRef: raw.userDecisionRef, quote: raw.quote, revoked: raw.revoked,
    ...(exhaust === undefined ? {} : { exhaustAtUsed: exhaust }) };
}

export function activePersonalPriority(raw, now) {
  const window = personalPriorityWindow(raw);
  return window && !window.revoked && Date.parse(window.from) <= now && (window.until === null || now < Date.parse(window.until)) ? window : null;
}

export function freshPersonalWeekly(snapshot) {
  const account = snapshot.accounts.find(a => a.id === snapshot.personalPriority?.account && a.kind === 'chatgpt');
  const budget = account?.budget, weekly = known(budget)?.weekly;
  return budget?.source !== 'last-good-stale' && nonnegative(weekly?.used) && nonnegative(weekly?.projected)
    && nonnegative(weekly?.resetsAt) && weekly.resetsAt > snapshot.decisionAt ? weekly : null;
}

export function personalPriorityGuard(snapshot) {
  const window = snapshot.personalPriority;
  if (!window) return null;
  const weekly = freshPersonalWeekly(snapshot);
  // The decision may name a reset at minute precision. Guard against using the
  // next week's telemetry if the observed reset precedes the window expiry.
  if (!weekly || window.mode !== 'exclusive' && Math.abs(weekly.resetsAt - Date.parse(window.until)) >= 60000)
    return 'fresh weekly quota for this reset is unavailable';
  if (window.mode === 'exclusive') {
    const exhaust = window.exhaustAtUsed ?? 99;
    if (weekly.used >= exhaust) return `weekly quota used up (used ${weekly.used}% / ${exhaust}% spend-until threshold)`;
    return 100 - weekly.used < PERSONAL_LAUNCH_HEADROOM ? `main ${weekly.used}% used: below launch headroom ${PERSONAL_LAUNCH_HEADROOM}%` : null;
  }
  if (window.exhaustAtUsed !== undefined)
    return weekly.used >= window.exhaustAtUsed
      ? `weekly quota used up (used ${weekly.used}% / ${window.exhaustAtUsed}% spend-until threshold)` : null;
  if (weekly.used >= 90 || weekly.projected >= 95)
    return `weekly quota guard (used ${weekly.used}% / 90% threshold, projected at reset ${weekly.projected}% / 95% threshold)`;
  return null;
}

export const exclusiveCodexTask = (task, snapshot) => snapshot.personalPriority?.mode === 'exclusive'
  && task.category !== 'claude-tools' && modelPreference(task, { kind: 'chatgpt' }, snapshot).some(id => ['sol', 'astra'].includes(id) || id.startsWith('gpt-'));

export function personalMainWaitText(task, snapshot) {
  const account = snapshot.accounts.find(a => a.id === 'main' && a.kind === 'chatgpt');
  const used = account?.budget?.value?.weekly?.used;
  return `[personal-main-wait] main ${Number.isFinite(used) ? used : '?'}%: ${task.flags?.name ?? task.taskId} waiting (redeem main card?)`;
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
    text: `personal ${window.account} ${window.mode === 'exclusive' ? 'only' : 'first'} under the standing routing window ${window.until === null ? 'until revoked' : `until ${window.until}`}` };
}
