import { createTaskSpec, deriveReview } from './taskspec.mjs';
import { createSnapshot, isNormalizedSnapshot } from './snapshot.mjs';
import { enumerateCandidates, candidateParts } from './candidates.mjs';
import { evaluateCandidate, needsReviewer, pReviewerSet } from './filters.mjs';
import { estimateCandidate } from './estimate.mjs';
import { orderCandidates } from './choose.mjs';
import { makePlan } from './plan.mjs';
import { validatePlan } from './validate.mjs';
import { array, company, known, reason, fingerprint, compare, clone, freeze } from './common.mjs';

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
  const assessment = assess(task, snapshot);
  const rejected = assessment.rows.flatMap((r) => r.predicates.filter((p) => !p.ok));
  const diagnostics = [...snapshot.diagnostics, ...assessment.diagnostics];
  const valid = assessment.rows.filter((r) => r.ok);
  const complete = [], reviewerRejections = [], gatedProposals = [];
  for (const row of valid) {
    let reviewers = [], reviewerGates = [];
    if (needsReviewer(task)) {
      const reviewerTask = deriveReview(task, { role: 'second', authorAttemptId: task.authorAttemptId });
      const author = task.previousAttempts.find((a) => a.id === task.authorAttemptId);
      const review = assess(reviewerTask, snapshot, { primary: row.candidate, author });
      reviewerRejections.push(...review.rows.flatMap((r) => r.predicates.filter((p) => !p.ok)));
      const ranked = orderCandidates(reviewerTask, snapshot, review.rows.filter((r) => r.ok));
      if (ranked.winner) { reviewers = [proposal(reviewerTask, ranked.winner)]; reviewerGates = gatesOf([ranked.winner]); }
      else {
        const gated = review.rows.filter((r) => r.predicates.filter((p) => !p.ok).every((p) => p.gate));
        gatedProposals.push(...gated.map((r) => proposal(reviewerTask, r)));
      }
      const set = pReviewerSet(task, snapshot, row.candidate, { reviewers });
      if (!set.ok) { rejected.push({ ...set, candidateId: row.candidate.id }); continue; }
    }
    complete.push({ ...row, reviewers, reviewerGates });
  }
  const rankedNow = orderCandidates(task, snapshot, complete);
  // Only explicit quota denial may project recovery. All other hard predicates
  // must pass now; retries, background and resource-bound dispatch never wait.
  const resetAllowed = !task.background && !task.failures && !task.previousAttempts.length && !task.autoRerouteDepth
    && !task.deviceId && !task.flags['device-lease'] && !task.flags['shared-lock'] && known(snapshot.resources)?.held === false && !needsReviewer(task);
  const resetRows = resetAllowed ? assessment.rows.filter((r) => {
    const failures = r.predicates.filter((p) => !p.ok);
    return failures.length === 1 && failures[0].reason.code === 'PROVIDER_QUOTA_DENIED' && failures[0].reconsiderAt !== null
      && company(candidateParts(snapshot, r.candidate).account);
  }).map((r) => ({ ...r, estimate: estimateCandidate(task, snapshot, r.candidate, { capacityReset: true }) })) : [];
  const ordered = orderCandidates(task, snapshot, [...complete, ...resetRows]);
  const trace = { candidates: assessment.rows.map((r) => ({ candidate: r.candidate, predicates: r.predicates, estimate: r.estimate })),
    ordering: ordered.rows.map((r) => ({ candidateId: r.candidate.id, terms: r.orderingTerms })), comparator: ordered.terms, diagnostics };
  const fields = { rejected: dedupe([...rejected, ...reviewerRejections]), trace };
  if (ordered.winner?.estimate.capacityReset) return makePlan('defer', task, snapshot, { ...fields, deferUntil: ordered.winner.estimate.deferUntil,
    trigger: 'capacity-reset', reason: reason('choose', 'CAPACITY_RESET_FASTER', 'Known quota reset has an earlier estimated completion; replan on wake.', [ordered.winner.candidate.id]),
    runnerUp: rankedNow.winner?.candidate ?? null, gates: [], timerOwner: task.owner });
  const winner = rankedNow.winner;
  if (winner) {
    const followups = [], gates = [...gatesOf([winner]), ...winner.reviewerGates];
    if (task.writes && ['release', 'service'].includes(task.impact) && !['review', 'review-high', 'second-opinion'].includes(task.category)) {
      followups.push(deriveReview(task, { role: 'followup', artifactRevision: task.artifactRevision }));
      gates.push({ id: `review:${task.taskId}`, kind: 'artifact-review', phase: 'acceptance', state: 'wait', scope: null,
        reason: reason('pReviewerSet', 'ARTIFACT_REVIEW_REQUIRED', 'After completion, pin the artifact and actual author; replan the inherited review task before acceptance.', [task.taskId]), evidenceIds: [] });
    }
    if (task.deviceId) gates.push({ id: `device:${task.taskId}`, kind: 'device-lease', phase: 'preaction', state: 'wait', scope: null,
      reason: reason('pDevice', 'DEVICE_LEASE_REQUIRED', 'Acquire the bounded device lease after the first response; destructive actions require backup and scoped authorization.', [task.deviceId]), evidenceIds: [] });
    const plan = makePlan('launch', task, snapshot, { ...fields, primary: proposal(task, winner), reviewers: winner.reviewers, followups, gates: dedupe(gates) });
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
  const gates = dedupe([...gatesOf(gatedRows), ...fields.rejected.flatMap((p) => p.gates ?? (p.gate ? [p.gate] : []))]);
  const reasons = dedupe(fields.rejected.map((p) => p.reason));
  if (!reasons.length) reasons.push(reason('enumerate', 'CAPACITY_UNRESOLVED', 'No declared eligible tuple; provide sanitized catalog/harness metadata.', []));
  return makePlan('blocked', task, snapshot, { ...fields, reasons, gates, suggestions: gatedRows.map((r) => r.candidate), reviewers: gatedProposals });
}

export { parseTaskSpec, createTaskSpec, deriveReview, TaskInputError } from './taskspec.mjs';
export { createSnapshot, snapshotFromAnalyze, observation } from './snapshot.mjs';
export { enumerateCandidates } from './candidates.mjs';
export { validatePlan, validateSeat } from './validate.mjs';
export { renderPlan } from './plan.mjs';
