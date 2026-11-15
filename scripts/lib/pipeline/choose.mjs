import { EFFORTS, company, companyDevice, adversarial, compare, freeze, stable, known, isReview } from './common.mjs';
import { candidateParts } from './candidates.mjs';
import { matchingApproval } from './filters.mjs';
import { modelPreference, TIERS } from './policy.mjs';
export const prefersPersonalCodex = task => ['lookup','extract','analysis','implement','implement-hard','debug','science','review','draft','build-run','image-gen','second-opinion'].includes(task.category);

export function orderCandidates(task, snapshot, rows) {
  // Effort is an approved quality stage, not a speed/expiry bidding dimension.
  const minimum = new Map();
  const stageKey=(c)=>`${c.accountId}:${c.modelId}`;
  for (const { candidate: c } of rows) minimum.set(stageKey(c), Math.min(minimum.get(stageKey(c)) ?? Infinity, EFFORTS.indexOf(c.effort)));
  let cohort = rows.filter(({ candidate: c }) => EFFORTS.indexOf(c.effort) === minimum.get(stageKey(c)));
  const stalled = (r) => r.estimate.stalled || r.reviewers?.some(s=>s.estimate.stalled);
  if(cohort.some(r=>!stalled(r))) cohort=cohort.filter(r=>!stalled(r));
  // Quota preference stays within the task's qualified ladder. A free depleted
  // Sol lane does not promote light work while light models can serve it.
  if(task.tier!=='hard' && !adversarial(task) && task.category!=='image-read' && !task.previousAttempts.length) {
    for(const account of snapshot.accounts.filter(a=>a.kind==='trae')) {
      const ladder=TIERS[task.tier];
      const inLadder=r=>r.candidate.accountId===account.id && ladder.includes(r.candidate.modelId);
      const usable=cohort.filter(r=>inLadder(r)&&!r.estimate.capacityReset&&!stalled(r));
      if(task.tier==='light' && usable.length)
        cohort=cohort.filter(r=>r.candidate.accountId!==account.id||inLadder(r));
      const priority=usable.some(r=>candidateParts(snapshot,r.candidate).lane.mode==='priority'
        && r.estimate.balance?.congestion!=='high');
      if(priority) cohort=cohort.filter(r=>r.candidate.accountId!==account.id
        ||candidateParts(snapshot,r.candidate).lane.mode!=='low-priority');
    }
  }
  // Apply the adversarial family ladder before company-lane preference so free
  // Flash cannot displace qualified Kimi; compare free capacity within that rung.
  if (adversarial(task) && cohort.length) {
    const lock = (r) => ['kimi-k3', 'deepseek-v4.1-flash', 'opus'].indexOf(r.candidate.modelId);
    const first = Math.min(...cohort.map(lock));
    cohort = cohort.filter((r) => lock(r) === first);
  }
  if(['browser','ui-browser'].includes(task.category))
    cohort=cohort.filter(r=>candidateParts(snapshot,r.candidate).account.kind!=='trae'||r.estimate.balance?.freeNow);
  const backgroundChoice=task.background&&!['browser','ui-browser','computer-use','build-run'].includes(task.category)&&!task.flags['shared-lock']&&!task.flags['device-lease'];
  const ttReady=cohort.some((r)=>candidateParts(snapshot,r.candidate).account.kind==='ttadk'&&!r.estimate.capacityReset&&r.estimate.startDelayMin===0);
  const ttExpiry=cohort.some(r=>candidateParts(snapshot,r.candidate).account.kind==='ttadk'&&r.estimate.expiryOpportunity===true);
  if(ttReady&&!backgroundChoice) {
    // Admission already enforces capabilities, resource rules and retry floors.
    // Prefer demonstrated immediate TRAE capacity, including depleted buckets,
    // to preserve TTADK's daily quota. Unknown telemetry is not proof of a free lane.
    const free=cohort.filter(r=>!task.flags['shared-lock']&&!task.flags['device-lease']&&candidateParts(snapshot,r.candidate).account.kind==='trae'&&r.estimate.balance?.freeNow
      &&(task.tier!=='light'||TIERS.light.includes(r.candidate.modelId)));
    if(ttExpiry) cohort=cohort.filter(r=>candidateParts(snapshot,r.candidate).account.kind!=='trae');
    else if(free.length) cohort=cohort.filter(r=>!company(candidateParts(snapshot,r.candidate).account)||free.includes(r));
    else cohort=cohort.filter(r=>candidateParts(snapshot,r.candidate).account.kind!=='trae');
  }
  // Normal work retains its established quota order. Within that order, measured
  // congestion can prefer the next available lane; hard work compares Sol/Astra.
  if(task.tier==='normal'&&task.category!=='image-read'&&!task.previousAttempts.length&&!adversarial(task)) {
    const preferred=new Map();
    for(const account of snapshot.accounts.filter((a)=>a.kind==='trae')) {
      const rr=cohort.filter((r)=>r.candidate.accountId===account.id), sol=rr.find((r)=>r.candidate.modelId==='gpt-6.1-sol');
      const unqueued=(r)=>r.estimate.basis!=='queue'&&r.estimate.confidence!=='UNKNOWN'&&r.estimate.balance?.congestion!=='high';
      const alt=['gpt-5.6-sol','gpt-5.6-terra','deepseek-v4.1-flash'].map((id)=>rr.find((r)=>r.candidate.modelId===id
        && ['priority','bucket-free'].includes(candidateParts(snapshot,r.candidate).lane.mode)&&unqueued(r))).find(Boolean);
      if(sol&&candidateParts(snapshot,sol.candidate).lane.mode!=='low-priority'&&unqueued(sol)) preferred.set(account.id,sol.candidate.modelId);
      else if(alt) preferred.set(account.id,alt.candidate.modelId);
    }
    cohort=cohort.filter((r)=>!preferred.has(r.candidate.accountId)||preferred.get(r.candidate.accountId)===r.candidate.modelId);
  }
  const companyClass = (r) => company(candidateParts(snapshot,r.candidate).account) || (!isReview(task) && matchingApproval(task,snapshot,r.candidate,'personal-quota',true)) ? 0 : 1;
  if (cohort.some((r) => companyClass(r) === 0)) cohort = cohort.filter((r) => companyClass(r) === 0);
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
  const astraOffers=cohort.filter(r=>r.candidate.modelId==='gpt-6-astra'&&candidateParts(snapshot,r.candidate).account.kind==='chatgpt'
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
    const retainedMax=task.previousAttempts.some(a=>a.actual?.modelId===c.modelId&&a.actual?.effort==='xhigh')&&c.effort==='max';
    const common = [stalled(r)?1:0, lock, companyClass(r), task.previousAttempts.length&&e.confidence==='UNKNOWN'&&!retainedMax?1:0];
    const scheduling = backgroundChoice ? [quotaClass, ...cost, e.expiryOpportunity === true ? 0 : 1, e.completionMin]
      : [e.completionMin, e.noPrioritySpend === true ? 0 : 1, e.expiryOpportunity === true ? 0 : 1, ...cost];
    const account=candidateParts(snapshot,c).account, preference=modelPreference(task,account), pref=preference.indexOf(c.modelId);
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
