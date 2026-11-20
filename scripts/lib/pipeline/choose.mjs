import { policyModel, isAstra, EFFORTS, company, companyDevice, adversarial, compare, freeze, stable, known, isReview } from './common.mjs';
import { candidateParts } from './candidates.mjs';
import { matchingApproval } from './filters.mjs';
import { modelPreference, hardPreference, TIERS, SOL, ASTRA } from './policy.mjs';
export const prefersPersonalCodex = task => ['lookup','extract','analysis','implement','implement-hard','debug','science','review','draft','build-run','image-gen','second-opinion'].includes(task.category);

export function orderCandidates(task, snapshot, rows) {
  // Effort is an approved quality stage, not a speed/expiry bidding dimension.
  const minimum = new Map();
  const stageKey=(c)=>`${c.accountId}:${c.modelId}`;
  for (const { candidate: c } of rows) minimum.set(stageKey(c), Math.min(minimum.get(stageKey(c)) ?? Infinity, EFFORTS.indexOf(c.effort)));
  let cohort = rows.filter(({ candidate: c }) => EFFORTS.indexOf(c.effort) === minimum.get(stageKey(c)));
  if (cohort.some(r => r.ok && r.predicates?.some(p => p.personalFallback) && r.estimate.startDelayMin === 0 && !r.estimate.stalled))
    cohort = cohort.filter(r => !company(candidateParts(snapshot, r.candidate).account) || !candidateParts(snapshot, r.candidate).account.fallbackUnavailable);
  const stalled = (r) => r.estimate.stalled || r.reviewers?.some(s=>s.estimate.stalled);
  if(cohort.some(r=>!stalled(r))) cohort=cohort.filter(r=>!stalled(r));
  const backgroundChoice=task.background&&!['browser','ui-browser','computer-use','build-run'].includes(task.category);
  const parts=r=>candidateParts(snapshot,r.candidate);
  const ready=r=>!stalled(r)&&!r.estimate.capacityReset&&r.estimate.startDelayMin===0
    &&(parts(r).account.kind!=='trae'||r.estimate.balance?.freeNow===true);
  const hardAstra = task.tier === 'hard' ? cohort.filter(r => r.ok && ready(r) && isAstra(r.candidate.modelId)
    && r.predicates.some(p => p.personalFallback?.astraApprovalRef && p.personalFallback.preferOverLowerCompany)) : [];
  if (hardAstra.length) cohort = hardAstra;
  const priority = snapshot.personalPriority;
  if (priority) {
    const preferred = cohort.filter(r => r.ok && ready(r)
      && r.predicates.some(p => p.personalFallback?.approvalRef === priority.userDecisionRef));
    if (preferred.length) cohort = preferred;
  }
  // Tier preference precedes quota; only observed free lanes get that preference.
  // Exclusions, capabilities and actual retry floors already bounded these rows.
  const companyRows=cohort.filter(r=>company(parts(r).account));
  const ladder=adversarial(task)?['kimi-k3','deepseek-v4.1-flash','opus']
    :task.category==='image-read'?[SOL,ASTRA,'gemini-3.1-pro-preview','seed-evolving']
    :[...(task.tier==='hard'?hardPreference(task):TIERS[task.tier]),...companyRows.flatMap(r=>modelPreference(task,parts(r).account))];
  const models=[...new Set(ladder)];
  const first=models.find(id=>companyRows.some(r=>policyModel(r.candidate.modelId)===id&&ready(r)));
  if(first) {
    const same=companyRows.filter(r=>policyModel(r.candidate.modelId)===first&&ready(r));
    const expiringTT=same.filter(r=>parts(r).account.kind==='ttadk'&&r.estimate.expiryOpportunity===true);
    const freeTrae=same.filter(r=>parts(r).account.kind==='trae');
    const chosen=expiringTT.length?expiringTT:freeTrae.length?freeTrae:same;
    cohort=cohort.filter(r=>!company(parts(r).account)||chosen.includes(r));
  } else if(cohort.some(r=>!company(parts(r).account)&&r.ok===true&&ready(r))) {
    cohort=cohort.filter(r=>!company(parts(r).account)&&r.ok===true&&ready(r));
  } else if(companyRows.length) {
    // The Astra-first trial applies to free capacity. Keep Sol's existing fallback
    // when no qualified company lane is observed free; actual floors still apply.
    const fallbackModels=task.tier==='hard'&&!adversarial(task)&&task.category!=='image-read'?[SOL,ASTRA]:models;
    const fallback=fallbackModels.find(id=>companyRows.some(r=>policyModel(r.candidate.modelId)===id));
    if(fallback) cohort=cohort.filter(r=>!company(parts(r).account)||policyModel(r.candidate.modelId)===fallback);
  }
  if(adversarial(task)&&cohort.length) {
    const rank=r=>['kimi-k3','deepseek-v4.1-flash','opus'].indexOf(r.candidate.modelId);
    const first=Math.min(...cohort.map(rank));cohort=cohort.filter(r=>rank(r)===first);
  }
  const companyClass = (r) => company(candidateParts(snapshot,r.candidate).account) || (companyDevice(snapshot) && !isReview(task) && matchingApproval(task,snapshot,r.candidate,'personal-quota',true)) ? 0 : 1;
  if (cohort.some((r) => companyClass(r) === 0)) cohort = cohort.filter((r) => companyClass(r) === 0);
  const standingAstra = cohort.filter(r => r.ok && ready(r) && r.predicates?.some(p => p.personalFallback?.astraApprovalRef));
  if (task.tier === 'hard' && standingAstra.length) cohort = cohort.filter(r => company(candidateParts(snapshot,r.candidate).account) || standingAstra.includes(r));
  if (['browser','ui-browser','computer-use'].includes(task.category) && cohort.length) {
    const order=r=>{const k=candidateParts(snapshot,r.candidate).account.kind;return k==='ttadk'?0:k==='trae'?1:k==='claude'?3:2;};
    const first=Math.min(...cohort.map(order)); cohort=cohort.filter(r=>order(r)===first);
  }
  const spare=(r)=>{const a=candidateParts(snapshot,r.candidate).account,b=known(a.budget);return a.kind!=='claude'||tolerateClaude(task,b);};
  if(cohort.some(spare)) cohort=cohort.filter(spare);
  const noCompany=!companyDevice(snapshot);
  if(noCompany&&prefersPersonalCodex(task)&&cohort.some(r=>candidateParts(snapshot,r.candidate).account.kind==='chatgpt'))
    cohort=cohort.filter(r=>candidateParts(snapshot,r.candidate).account.kind==='chatgpt');
  // When every candidate needs approval, offer the personal Astra escalation
  // before a Sol/max decision. Runnable alternatives were selected separately.
  const astraOffers=cohort.filter(r=>isAstra(r.candidate.modelId)&&candidateParts(snapshot,r.candidate).account.kind==='chatgpt'
    && r.predicates?.some(p=>!p.ok&&p.gates?.some(g=>g.kind==='astra'))
    && r.predicates.filter(p=>!p.ok).every(p=>p.gates?.every(g=>['astra','personal-quota'].includes(g.kind))));
  if(task.previousAttempts.length&&astraOffers.length&&cohort.every(r=>r.predicates?.some(p=>!p.ok))) cohort=astraOffers;
  // The legacy device lane spends accounts with deadlines <=48h in rotation;
  // otherwise it uses the earliest deadline. The CLI owns the counter mutation.
  const personalAccounts=[...new Set(cohort.filter(r=>candidateParts(snapshot,r.candidate).account.kind==='chatgpt').map(r=>r.candidate.accountId))]
    .sort((a,b)=>compare(known(snapshot.accounts.find(r=>r.id===a).budget)?.deadline??Infinity,
      known(snapshot.accounts.find(r=>r.id===b).budget)?.deadline??Infinity)||compare(a,b));
  const expiring=personalAccounts.filter(id=>{const deadline=known(snapshot.accounts.find(a=>a.id===id).budget)?.deadline;return deadline!==null&&deadline!==undefined&&deadline<=48;});
  const rotate=noCompany&&expiring.length>=2?expiring:[];
  const rotationRank=id=>rotate.length?(rotate.indexOf(id)-(snapshot.rotationState%rotate.length)+rotate.length)%rotate.length:0;
  if(rotate.length) cohort=cohort.filter(r=>candidateParts(snapshot,r.candidate).account.kind!=='chatgpt'||rotate.includes(r.candidate.accountId));
  const freeLight = !task.background && task.tier === 'light' && cohort.some((r) => company(candidateParts(snapshot, r.candidate).account) && r.estimate.noPrioritySpend === true);
  // Foreground light lists keep their category preference among qualified lanes.
  const costShape = (r) => r.estimate.costs.map((c) => [c.bucketId, c.unit]);
  const costComparable = cohort.length > 0 && cohort[0].estimate.costs.length > 0 && cohort.every((r) => stable(costShape(r)) === stable(costShape(cohort[0]))
    && r.estimate.costs.every((c) => c.normalizedShare !== null));
  const terms = (r) => {
    const c = r.candidate, e = r.estimate;
    const lock = adversarial(task) ? ['kimi-k3', 'deepseek-v4.1-flash', 'opus'].indexOf(c.modelId) : 0;
    const quotaClass = e.expiryOpportunity === true ? 0 : e.noPrioritySpend === true ? 1 : 2;
    const cost = costComparable ? e.costs.map((c) => c.normalizedShare) : [];
    const retainedMax=task.previousAttempts.some(a=>policyModel(a.actual?.modelId)===policyModel(c.modelId)&&a.actual?.effort==='xhigh')&&c.effort==='max';
    const common = [stalled(r)?1:0, lock, companyClass(r), task.previousAttempts.length&&e.confidence==='UNKNOWN'&&!retainedMax?1:0];
    const scheduling = backgroundChoice ? [quotaClass, ...cost, e.expiryOpportunity === true ? 0 : 1, e.completionMin]
      : [e.expiryOpportunity === true ? 0 : 1,e.completionMin, e.noPrioritySpend === true ? 0 : 1, ...cost];
    const account=candidateParts(snapshot,c).account;
    const hardCompany=task.tier==='hard'&&!adversarial(task)&&task.category!=='image-read'&&company(account);
    // Without observed free capacity, preserve the pre-trial fallback tie-breaks.
    const preference=hardCompany&&!first?[SOL,ASTRA]:modelPreference(task,account,snapshot);
    // The free company model was selected above. Its new ladder index must not
    // accidentally promote an approved personal option over the company fallback.
    const pref=hardCompany&&policyModel(c.modelId)===first?0:preference.indexOf(policyModel(c.modelId));
    const accountOrder=account.kind==='ttadk'?0:account.kind==='trae'?1:2;
    const deviceLane=noCompany?[pref<0?preference.length:pref,
      account.kind==='chatgpt'?(rotate.length?rotationRank(c.accountId):known(account.budget)?.deadline??Infinity):0]:[0,0];
    return [...common, ...deviceLane, ...(task.tier==='light'&&!task.background?[e.completionMin,pref < 0 ? preference.length : pref]:[]), ...scheduling, pref < 0 ? preference.length : pref, accountOrder, known(account.budget)?.deadline??Infinity, c.accountId, c.laneId, EFFORTS.indexOf(c.effort), c.id];
  };
  const decorated = cohort.map((r) => ({ ...r, orderingTerms: terms(r) }));
  decorated.sort((a, b) => {
    for (let i = 0; i < a.orderingTerms.length; i++) { const n = compare(a.orderingTerms[i], b.orderingTerms[i]); if (n) return n; }
    return 0;
  });
  return freeze({ rows: decorated, winner: decorated[0] ?? null, runnerUp: decorated[1] ?? null,
    terms: { costComparable, freeLight, accountRotation:rotate, policyLock: adversarial(task) ? 'kimi-deepseek-scoped-opus' : null, background: task.background } });
}
export const choose = (task, snapshot, rows) => orderCandidates(task, snapshot, rows).winner;
function tolerateClaude(t,b) { return !b||t.category==='claude-tools'||b.status==='spare'||b.status==='near'&&(t.category==='design'||t.stakes==='high'||t.category==='review-high'); }
