import { isReview, adversarial, reason } from './common.mjs';

export const baseTaskName = (name) => String(name ?? '').replace(/(?:[-_](?:r\d*|review\d*|re-review\d*))+$/ig, '');
export const requiredReview = (t) => adversarial(t) || t.category === 'review-high' || t.impact === 'release' || t.stakes === 'high'
  || t.requirements.installedOnMachine || !!t.flags['review-required'];
export function reviewDecision(t, s) {
  const profile = s.projectProfiles?.[t.project] ?? { profile: 'default' };
  if (profile.profile === 'internal-demo' && !t.flags['profile-override'] && (t.category === 'review-high' || t.contentLabels.includes('security') || adversarial(t)))
    return reason('pReviewerSet', 'PROJECT_PROFILE_ACCEPTANCE', "project profile internal-demo: use acceptance tests (route as implement/analysis); pass --profile-override '<why>' if the user asked for a security review", [t.project]);
  if (!isReview(t)) return null;
  const rows = (s.reviewHistory ?? []).filter((r)=>r.t<=s.decisionAt), taskRows = rows.filter((r) => r.project === t.project && baseTaskName(r.name) === baseTaskName(t.flags.name ?? t.taskId)
    && ['review', 'review-high', 'second-opinion'].includes(r.category) && r.role !== 'second');
  if (taskRows.length >= 2 && (!t.flags['review-override'] || taskRows.some((r)=>r.reviewOverride===t.flags['review-override']))) return reason('pReviewerSet', 'REVIEW_ROUND_CAP',
    "Two review rounds already ran: re-scope the task (a design route may review the approach), or merge with notes and record open items; --review-override '<reason>' permits one additional round.", [t.taskId]);
  const recent = rows.filter((r) => r.t <= s.decisionAt && r.t >= s.decisionAt - 86400000);
  const project = recent.filter((r) => r.project === t.project);
  const share = (xs) => xs.length ? 100 * xs.filter((r) => ['review', 'review-high', 'second-opinion'].includes(r.category)).length / xs.length : 0;
  const percent = Math.max(share(project), share(recent));
  if (percent > 10 && !requiredReview(t)) return reason('pReviewerSet', 'REVIEW_BUDGET_WARNING',
    `over review budget — prefer accepting on tests (${percent.toFixed(1)}%)`, [t.project]);
  return null;
}
export function reviewAfterWrite(t, s, c) {
  if (!t.writes || !['implement', 'implement-hard', 'debug', 'science'].includes(t.category)) return false;
  if (requiredReview(t)) return true;
  if (t.impact !== 'service') return false;
  if (!['deepseek', 'gemini', 'seed'].includes(c.family)) return false;
  if (t.runsTests || t.requirements.fullPackageBuild || t.requirements.executableAcceptance) return true;
  return (s.outcomes ?? []).some((r) => r.category === t.category && r.modelId === c.modelId
    && ['rework', 'fail'].includes(r.result) && r.t >= s.decisionAt - 7 * 86400000 && r.t <= s.decisionAt);
}
