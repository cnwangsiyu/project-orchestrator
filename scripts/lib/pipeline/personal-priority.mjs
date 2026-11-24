import { idOK, isAstra, known, nonnegative, object } from './common.mjs';
import { modelPreference } from './policy.mjs';

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
  if (window?.mode !== 'prefer-first') return null;
  const weekly = freshPersonalWeekly(snapshot);
  return !weekly || Math.abs(weekly.resetsAt - Date.parse(window.until)) >= 60000
    ? 'fresh weekly quota for this reset is unavailable' : null;
}

export const exclusiveCodexTask = (task, snapshot) => snapshot.personalPriority?.mode === 'exclusive'
  && task.category !== 'claude-tools' && modelPreference(task, { kind: 'chatgpt' }, snapshot).some(id => ['sol', 'astra'].includes(id) || id.startsWith('gpt-'));

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
    text: `${window.mode === 'exclusive' ? `company lanes first; personal overflow only on ${window.account}` : `personal ${window.account} first`} under the standing routing window ${window.until === null ? 'until revoked' : `until ${window.until}`}` };
}
