import { createTaskSpec, deriveReview } from './taskspec.mjs';
import { createSnapshot, isNormalizedSnapshot } from './snapshot.mjs';
import { enumerateCandidates, candidateParts } from './candidates.mjs';
import { evaluateCandidate, needsReviewer, pReviewerSet } from './filters.mjs';
import { estimateCandidate } from './estimate.mjs';
import { orderCandidates, prefersPersonalCodex } from './choose.mjs';
import { makePlan } from './plan.mjs';
import { validatePlan } from './validate.mjs';
import { reviewDecision, reviewAfterWrite } from './review-policy.mjs';
import { array, company, companyDevice, known, reason, fingerprint, compare, clone, freeze } from './common.mjs';

function assess(task, snapshot, context = {}) {
  const { candidates, diagnostics } = enumerateCandidates(task, snapshot);
  const companyUnknown = diagnostics.some((d) => snapshot.accounts.some((a) => company(a) && d.subjects.includes(a.id)))
    || snapshot.diagnostics.some((d) => ['accounts', 'models', 'lanes', 'schemaVersion'].some((p) => d.subjects.includes(p)));
  const rows = candidates.map((candidate) => ({ candidate, predicates: evaluateCandidate(task, snapshot, candidate, context) }));
  const companyEligible = rows.some((r) => company(candidateParts(snapshot, r.candidate).account) && r.predicates.every((p) => p.ok));
  for (const row of rows) {
    row.predicates = evaluateCandidate(task, snapshot, row.candidate, { ...context, companyEligible, companyUnknown });
    row.ok = row.predicates.every((p) => p.ok);
    row.estimate = estimateCandidate(task, snapshot, row.candidate);
  }
  return { rows, diagnostics, companyUnknown };
}
const dedupe = (xs) => [...new Map(xs.map((x) => [fingerprint(x), x])).values()].sort((a, b) => compare(fingerprint(a), fingerprint(b)));
const proposal = (task, row) => ({ role: task.role, task, candidate: row.candidate, estimate: row.estimate, dependsOnRoles: [] });
const gatesOf = (rows) => dedupe(rows.flatMap((r) => r.predicates.flatMap((p) => p.gates ?? (p.gate ? [p.gate] : []))));

/** Pure selection only: no state reads, dispatch, logging, timers or lock claims. */
export function routePure(taskSpec, stateSnapshot, history = []) {
  const extra = array(history);
  const previousAttempts = dedupe([...array(taskSpec?.previousAttempts), ...extra]);
  const task = createTaskSpec({ ...taskSpec, previousAttempts });
  const snapshot = isNormalizedSnapshot(stateSnapshot) ? freeze(clone(stateSnapshot)) : createSnapshot(stateSnapshot);
  const reviewBlock = reviewDecision(task, snapshot);
  if (reviewBlock && reviewBlock.code !== 'REVIEW_BUDGET_WARNING') return makePlan('blocked', task, snapshot, { reasons: [reviewBlock], suggestions: [], gates: [{ id: reviewBlock.code,
    kind: 'review-decision', phase: 'prelaunch', state: 'needsOK', scope: null, reason: reviewBlock, evidenceIds: [] }] });
  const assessment = assess(task, snapshot);
  const rejected = assessment.rows.flatMap((r) => r.predicates.filter((p) => !p.ok));
  const diagnostics = [...snapshot.diagnostics, ...assessment.diagnostics];
  const valid = assessment.rows.filter((r) => r.ok);
  const complete = [], reviewerRejections = [], gatedProposals = new Map(), reviewerCache = new Map();
  for (const row of valid) {
    let reviewers = [], reviewerGates = [], reviewerProposals = [];
    if (needsReviewer(task,snapshot)) {
      const reviewerTask = deriveReview(task, { role: 'second', authorAttemptId: task.authorAttemptId });
      const author = task.previousAttempts.find((a) => a.id === task.authorAttemptId);
      let entry=reviewerCache.get(row.candidate.family);
      if(!entry) {
        const review=assess(reviewerTask, snapshot, {primary:row.candidate,author});
        entry={review,ranked:orderCandidates(reviewerTask,snapshot,review.rows.filter(r=>r.ok))};
        reviewerCache.set(row.candidate.family,entry);
        reviewerRejections.push(...review.rows.flatMap(r=>r.predicates.filter(p=>!p.ok)));
      }
      const {review,ranked}=entry;
      if (ranked.winner && !ranked.winner.estimate.stalled) { reviewers = [proposal(reviewerTask, ranked.winner)]; reviewerGates = gatesOf([ranked.winner]); }
      else {
        const gated = review.rows.filter((r) => r.predicates.filter((p) => !p.ok).every((p) => p.gate));
        const proposedReviewer=orderCandidates(reviewerTask,snapshot,gated).winner;
        if(proposedReviewer) {
          reviewerProposals=[proposal(reviewerTask,proposedReviewer)];
          reviewerGates=gatesOf([proposedReviewer]).map(g=>({...g,phase:'acceptance'}));
          gatedProposals.set(row.candidate.family,{seat:reviewerProposals[0],gates:reviewerGates});
        }
        reviewerGates.push({id:`second:${task.taskId}`,kind:'independent-review',phase:'acceptance',state:'wait',scope:null,
          reason:reason('pReviewerSet','REVIEWER_PENDING','Launch the company primary now; complete the independent second review before acceptance.',[task.taskId]),evidenceIds:[]});
      }
      const set = pReviewerSet(task, snapshot, row.candidate, { reviewers });
      if (!set.ok) { rejected.push({ ...set, candidateId: row.candidate.id }); continue; }
    }
    complete.push({ ...row, reviewers, reviewerGates, reviewerProposals });
  }
  const rankedNow = orderCandidates(task, snapshot, complete);
  // Only explicit quota denial may project recovery. All other hard predicates
  // must pass now; retries, background and resource-bound dispatch never wait.
  const resetAllowed = !task.background && !task.failures && task.previousAttempts.every((a)=>a.state==='cancelled-no-work'&&a.cancellationEvidenceId&&a.usefulWork===false)
    && !task.deviceId && !task.flags['device-lease'] && !task.flags['shared-lock'] && known(snapshot.resources)?.held === false && !needsReviewer(task,snapshot);
  const resetRows = resetAllowed ? assessment.rows.filter((r) => {
    const failures = r.predicates.filter((p) => !p.ok);
    return failures.length === 1 && failures[0].reason.code === 'PROVIDER_QUOTA_DENIED' && failures[0].reconsiderAt !== null
      && company(candidateParts(snapshot, r.candidate).account);
  }).map((r) => ({ ...r, estimate: estimateCandidate(task, snapshot, r.candidate, { capacityReset: true }) })) : [];
  // Runnable work always wins over a future quota reset.
  const ordered = rankedNow.winner && !rankedNow.winner.estimate.stalled ? rankedNow : orderCandidates(task,snapshot,resetRows);
  const trace = { candidates: assessment.rows.map((r) => ({ candidate: r.candidate, predicates: r.predicates, estimate: r.estimate })),
    ordering: ordered.rows.map((r) => ({ candidateId: r.candidate.id, terms: r.orderingTerms })), comparator: ordered.terms, diagnostics };
  const fields = { warnings: reviewBlock?.code === 'REVIEW_BUDGET_WARNING' ? [reviewBlock] : [], rejected: dedupe([...rejected, ...reviewerRejections]), trace };
  // Show the ready personal choice before scheduling a future company reset.
  // Its command remains gated until the orchestrator supplies the user's yes.
  if (ordered.winner?.estimate.capacityReset && !rankedNow.winner) {
    const personalRows=assessment.rows.filter(r=>!company(candidateParts(snapshot,r.candidate).account)
      && !r.estimate.stalled && r.predicates.filter(p=>!p.ok).every(p=>p.gate));
    const personal=orderCandidates(task,snapshot,personalRows).winner;
    if(personal) return makePlan('blocked',task,snapshot,{...fields,primaryProposal:proposal(task,personal),
      gates:gatesOf([personal]),suggestions:personalRows.map(r=>r.candidate),
      reasons:personal.predicates.filter(p=>!p.ok).slice(0,1).map(p=>({...p.reason,
        text:`${personal.candidate.modelId} ${personal.candidate.effort} on ${personal.candidate.accountId}: ${p.reason.text}`}))});
  }
  if (ordered.winner?.estimate.capacityReset) return makePlan('defer', task, snapshot, { ...fields, deferUntil: ordered.winner.estimate.deferUntil,
    trigger: 'capacity-reset', reason: reason('choose', 'CAPACITY_RESET_REQUIRED', `No company lane can start now; company quota resets at ${new Date(ordered.winner.estimate.deferUntil).toISOString()}.`, [ordered.winner.candidate.id]),
    runnerUp: rankedNow.winner?.candidate ?? null, gates: [], timerOwner: task.owner });
  const winner = rankedNow.winner;
  // Preserve the personal-device reset-card proposal when the default Codex
  // accounts are spent. A fresh decision and quota refresh precede any launch.
  if(!companyDevice(snapshot)&&prefersPersonalCodex(task)&&winner
    && candidateParts(snapshot,winner.candidate).account.kind==='claude') {
    const cards=assessment.rows.filter(r=>candidateParts(snapshot,r.candidate).account.kind==='chatgpt'
      && r.predicates.filter(p=>!p.ok).length===1
      && r.predicates.some(p=>!p.ok&&p.reason.code==='RESET_REDEMPTION_OK_REQUIRED'));
    const card=orderCandidates(task,snapshot,cards).winner;
    if(card) return makePlan('blocked',task,snapshot,{...fields,primaryProposal:proposal(task,card),gates:gatesOf([card]),
      suggestions:cards.map(r=>r.candidate),reasons:card.predicates.filter(p=>!p.ok).map(p=>({...p.reason,
        text:`${card.candidate.modelId} ${card.candidate.effort} on ${card.candidate.accountId}: ${p.reason.text}`}))});
  }
  if(winner && (winner.estimate.stalled || winner.reviewers.some(s=>s.estimate.stalled))) return makePlan('defer', task, snapshot, {
    ...fields, deferUntil:null, trigger:'lane-progress', reason:reason('choose','ETA_STALLED','The qualified lane/reviewer set is STALLED in fresh telemetry; wait for progress and replan before launching.',
      [winner.candidate.id,...winner.reviewers.filter(s=>s.estimate.stalled).map(s=>s.candidate.id)]),
    runnerUp:null,gates:[],timerOwner:task.owner });
  if (winner) {
    const followups = [], gates = [...gatesOf([winner]), ...winner.reviewerGates];
    if (reviewAfterWrite(task, snapshot, winner.candidate)) {
      followups.push(deriveReview(task, { role: 'followup', artifactRevision: task.artifactRevision }));
      gates.push({ id: `review:${task.taskId}`, kind: 'artifact-review', phase: 'acceptance', state: 'wait', scope: null,
        reason: reason('pReviewerSet', 'ARTIFACT_REVIEW_REQUIRED', 'After completion, pin the artifact and actual author; replan the inherited review task before acceptance.', [task.taskId]), evidenceIds: [] });
    }
    if (task.deviceId) gates.push({ id: `device:${task.taskId}`, kind: 'device-lease', phase: 'preaction', state: 'wait', scope: null,
      reason: reason('pDevice', 'DEVICE_LEASE_REQUIRED', 'Acquire the bounded device lease after the first response; destructive actions require backup and scoped authorization.', [task.deviceId]), evidenceIds: [] });
    const plan = makePlan('launch', task, snapshot, { ...fields, primary: proposal(task, winner), reviewers: winner.reviewers, reviewerProposals:winner.reviewerProposals, followups, gates: dedupe(gates) });
    const validation = validatePlan(plan, snapshot);
    if (validation.ok) return plan;
    return makePlan('blocked', task, snapshot, { ...fields, gates: validation.checks.map((p) => p.gate).filter(Boolean), reasons: dedupe(validation.checks.filter((p) => !p.ok).map((p) => p.reason)), suggestions: [] });
  }
  const companyRows = assessment.rows.filter((r) => company(candidateParts(snapshot, r.candidate).account));
  const capacityOnly = companyRows.some((r) => r.predicates.filter((p) => !p.ok).every((p) => p.reason.code === 'PROVIDER_QUOTA_DENIED'));
  if (task.background && (capacityOnly || (!companyRows.length && !assessment.companyUnknown))) return makePlan('defer', task, snapshot, {
    ...fields, deferUntil: null, trigger: 'company-capacity-change', reason: reason('pBackground', 'BACKGROUND_WAIT_COMPANY', 'No complete eligible company set is available.', [task.taskId]),
    runnerUp: null, gates: [], timerOwner: task.owner });
  const gatedRows = assessment.rows.filter((r) => r.predicates.filter((p) => !p.ok).every((p) => p.gate));
  const proposed = orderCandidates(task, snapshot, gatedRows).winner;
  const validProposal=orderCandidates(task,snapshot,valid).winner;
  // Keep full predicate diagnostics in rejected/trace. Explain one obstruction
  // on the closest qualified candidate, instead of unrelated rejected models.
  const failuresOf=r=>r.predicates.filter(p=>!p.ok);
  const qualified=assessment.rows.filter(r=>r.predicates.filter(p=>['pUserRules','pExclusions','pTierFloor','pModelFit','pContent'].includes(p.ruleId)).every(p=>p.ok));
  const pool=qualified.length?qualified:assessment.rows;
  const fewest=Math.min(...pool.map(r=>failuresOf(r).length));
  const closest=orderCandidates(task,snapshot,pool.filter(r=>failuresOf(r).length===fewest)).winner;
  const best=validProposal??proposed??closest;
  const blocker=best && (failuresOf(best)[0] ?? fields.rejected.find(p=>p.candidateId===best.candidate.id));
  const reasons = blocker ? [{...blocker.reason,text:`${best.candidate.modelId} ${best.candidate.effort} on ${best.candidate.accountId}: ${blocker.reason.text}`}] :
    [reason('enumerate','CAPACITY_UNRESOLVED','No declared eligible tuple; provide sanitized catalog/harness metadata.',[])];
  const proposedSecond=gatedProposals.get((validProposal??proposed)?.candidate.family);
  const gates = validProposal ? dedupe(fields.rejected.filter((p)=>p.candidateId===validProposal.candidate.id&&p.ruleId==='pReviewerSet').flatMap((p)=>p.gates??(p.gate?[p.gate]:[])))
    : proposed ? gatesOf([proposed]) : [];
  return makePlan('blocked', task, snapshot, { ...fields, reasons, gates, suggestions: gatedRows.map((r) => r.candidate),
    primaryProposal: validProposal ? proposal(task,validProposal) : proposed ? proposal(task, proposed) : null,
    reviewers: proposedSecond?[proposedSecond.seat]:[], gates:dedupe([...gates,...(proposedSecond?.gates??[])]) });
}

export { parseTaskSpec, createTaskSpec, deriveReview, TaskInputError } from './taskspec.mjs';
export { createSnapshot, snapshotFromAnalyze, observation } from './snapshot.mjs';
export { enumerateCandidates } from './candidates.mjs';
export { validatePlan, validateSeat } from './validate.mjs';
export { renderPlan } from './plan.mjs';
