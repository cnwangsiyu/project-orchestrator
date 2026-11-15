import { isReview, reason } from './common.mjs';
import {mandatoryReview,projectReviewPolicy,reviewScope} from '../review-policy-data.mjs';
export const baseTaskName=name=>reviewScope({name});
export const requiredReview=mandatoryReview;
export function reviewDecision(t,s) {
  if(!isReview(t))return null;
  if(projectReviewPolicy(t.project,s.projectProfiles).profile==='no-review'&&!requiredReview(t))return reason('pReviewerSet','PROJECT_NO_REVIEW','This project uses no-review: no reviewer is dispatched without an explicit user-requested review-class A–D and review-reason.',[t.project]);
  const rows=(s.reviewHistory??[]).filter(r=>r.t<=s.decisionAt);
  const owned=rows.filter(r=>r.project===t.project&&reviewScope(r)===reviewScope(t)
    &&['review','review-high','second-opinion'].includes(r.category)&&r.role!=='second');
  if(owned.length>=2)return reason('pReviewerSet','REVIEW_ROUND_CAP','Two review rounds already ran for this task/branch. Report remaining findings and re-scope genuinely new work; another override reason cannot authorize a third round.',[t.taskId]);
  const recent=rows.filter(r=>r.t>=s.decisionAt-86400000&&r.project===t.project);
  const percent=recent.length?100*recent.filter(r=>['review','review-high','second-opinion'].includes(r.category)).length/recent.length:0;
  const target=projectReviewPolicy(t.project,s.projectProfiles).reviewTargetPct;
  if(percent>target&&!requiredReview(t))return reason('pReviewerSet','REVIEW_BUDGET_WARNING',`over review budget — prefer accepting on tests (${percent.toFixed(1)}%; project target ${target}%)`,[t.project]);
  return null;
}
export function reviewAfterWrite(t,s,c) {return t.writes&&!isReview(t)&&requiredReview(t);}
