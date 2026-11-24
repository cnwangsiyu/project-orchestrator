import { evaluateCandidate, pReviewerSet } from './filters.mjs';
import { enumerateCandidates, candidateParts } from './candidates.mjs';
import { company, result, stable } from './common.mjs';
import { argvMatches, planFingerprint } from './plan.mjs';
import { createTaskSpec } from './taskspec.mjs';
import { tierApprovalRef } from './policy.mjs';
import { companyWouldDowngrade } from './choose.mjs';
import { estimateCandidate, usesExclusiveInfraOverflow } from './estimate.mjs';

export function validateSeat(task, snapshot, candidate, context = {}) {
  return evaluateCandidate(task, snapshot, candidate, context);
}
export function validatePlan(plan, snapshot, { proposed = null } = {}) {
  const checks = [];
  const check = (ok, code, text) => checks.push(result('pLaunchMatches', ok ? null : code, text));
  check(plan.snapshotId === snapshot.id && plan.policyVersion === snapshot.policyVersion, 'PLAN_SNAPSHOT_CHANGED', 'Fresh state differs; replan without silently changing the selected tuple.');
  check(plan.planHash === planFingerprint(plan), 'PLAN_HASH_MISMATCH', 'Plan content does not match its fingerprint.');
  if (plan.kind !== 'launch') {
    check(!plan.primary && !plan.reviewers.some((s) => s.argv), 'BLOCKED_ARGV_FORBIDDEN', 'Blocked/deferred plans cannot contain executable seats.');
    return { ok: false, checks };
  }
  check(!plan.gates.some((g) => g.phase === 'prelaunch' && g.state !== 'satisfied'), 'PRELAUNCH_GATE_UNSATISFIED', 'Every prelaunch gate must be satisfied.');
  const allSeats = [plan.primary, ...plan.reviewers];
  check(stable(plan.primary.task) === stable(plan.task), 'TASK_ENVELOPE_MISMATCH', 'Primary task must match the plan task.');
  check(new Set(allSeats.map((s) => s.role)).size === allSeats.length, 'DUPLICATE_ROLE', 'Each role must have a distinct seat.');
  for (const seat of allSeats) {
    let constraintMatches = false;
    try { constraintMatches = createTaskSpec(seat.task).constraintHash === seat.task.constraintHash; } catch {}
    check(constraintMatches, 'CONSTRAINT_HASH_MISMATCH', 'Recomputed task constraints must match the approval scope.');
    const enumeration = enumerateCandidates(seat.task, snapshot);
    const context = seat === plan.primary ? {} : { primary: plan.primary.candidate,
      author: plan.task.previousAttempts.find((a) => a.id === seat.task.authorAttemptId) };
    const companyCandidates = enumeration.candidates.filter(c => company(candidateParts(snapshot, c).account));
    const tierGrant = seat.personalFallback?.approvalRef === tierApprovalRef;
    const companyRows = tierGrant || usesExclusiveInfraOverflow(seat.task, snapshot) ? companyCandidates.map(candidate => ({ candidate,
      predicates: evaluateCandidate(seat.task, snapshot, candidate, context), estimate: estimateCandidate(seat.task, snapshot, candidate) })) : null;
    const eligibleCompany = companyRows ? companyRows.some(r => r.predicates.every(p => p.ok))
      : companyCandidates.some(c => evaluateCandidate(seat.task, snapshot, c, context).every(p => p.ok));
    checks.push(...validateSeat(seat.task, snapshot, seat.candidate, { ...context, companyEligible: eligibleCompany,
      ...(companyRows ? { companyRows, tierDowngrade: companyWouldDowngrade(seat.task, snapshot, companyRows) } : {}),
      companyUnknown: enumeration.diagnostics.some((d) => snapshot.accounts.some((a) => company(a) && d.subjects.includes(a.id))),
      ...(seat === plan.primary ? { proposed } : {}) }));
    check(argvMatches(plan, seat), 'LAUNCH_ARGV_MISMATCH', 'Launch arguments must match account/model/effort, scope and sandbox.');
    check(seat.dependsOnRoles.every((r) => allSeats.some((s) => s.role === r) && r !== seat.role), 'DEPENDENCY_UNKNOWN', 'Seat dependency does not resolve.');
    if (seat !== plan.primary) check(seat.task.contentLabels.every((l) => l === 'adversarial' || plan.task.contentLabels.includes(l))
      && plan.task.contentLabels.filter((l) => l !== 'ordinary').every((l) => seat.task.contentLabels.includes(l)), 'CONTENT_SCOPE_MISMATCH', 'Reviewer content constraints must be inherited.');
  }
  const visiting = new Set(), visited = new Set();
  const visit = (role) => {
    if (visiting.has(role)) return false;
    if (visited.has(role)) return true;
    visiting.add(role);
    const ok = allSeats.find((s) => s.role === role)?.dependsOnRoles.every(visit) ?? false;
    visiting.delete(role); visited.add(role); return ok;
  };
  check(allSeats.every((s) => visit(s.role)), 'DEPENDENCY_CYCLE', 'Reviewer dependencies must be acyclic.');
  checks.push(pReviewerSet(plan.task, snapshot, plan.primary.candidate, { reviewers: plan.reviewers }));
  if (proposed) check(proposed.sandbox === plan.task.sandbox && proposed.taskId === plan.task.taskId && proposed.planHash === plan.planHash
    && proposed.routeId === plan.routeId && proposed.role === plan.task.role,
    'LAUNCH_TUPLE_MISMATCH', 'Actual launch envelope must match the task, sandbox and plan.');
  return { ok: checks.every((r) => r.ok), checks };
}
