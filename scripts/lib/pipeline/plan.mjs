import { VERSION, fingerprint, freeze, clone, unique, stable } from './common.mjs';
import { presentRoute } from './presentation.mjs';
import { taskEstimateText, laneStartText } from '../eta.mjs';

export function planFingerprint(plan) {
  const copy = clone(plan); delete copy.planHash;
  if (copy.primary) delete copy.primary.argv;
  for (const seat of copy.reviewers ?? []) delete seat.argv;
  return fingerprint(copy);
}
export function makePlan(kind, task, snapshot, fields = {}) {
  const routeId = `route:${fingerprint([task.requestId, task, snapshot.contentHash, task.previousAttempts])}`;
  const plan = { schemaVersion: VERSION, routeId, task, snapshotId: snapshot.id, policyVersion: snapshot.policyVersion,
    gates: [], rejected: [], reviewers: [], followups: [], records: [],
    handover: { previousAttemptIds: task.previousAttempts.map((a) => a.id),
      cancellationEvidenceIds: task.previousAttempts.flatMap((a) => a.cancellationEvidenceId ? [a.cancellationEvidenceId] : []),
      artifactRevision: task.artifactRevision, requiredChecks: task.autoRerouteDepth ? ['confirm terminal no-work', 'confirm owned resources returned', 'inspect current artifact'] : [] },
    ...fields, kind, executable: kind === 'launch' };
  if (kind !== 'launch') {
    delete plan.primary;
    plan.reviewers = plan.reviewers.map(({ argv, ...seat }) => seat);
  }
  plan.planHash = planFingerprint(plan);
  if (kind === 'launch') {
    plan.primary = { ...plan.primary, argv: seatArgv(plan, plan.primary) };
    plan.reviewers = plan.reviewers.map((seat) => ({ ...seat, argv: seatArgv(plan, seat) }));
  }
  return freeze(plan);
}
// An envelope for the future guarded launcher, not direct worker start argv.
// The launcher must verify a fresh snapshot and dependencies before executing.
export function seatArgv(plan, seat) {
  const c = seat.candidate, t = seat.task;
  return ['validated-launch', '--plan-hash', plan.planHash, '--route-id', plan.routeId, '--task-id', t.taskId, '--role', t.role,
    '--account', c.accountId, '--model', c.modelId, '--lane', c.laneId, '--harness', c.harness, '--effort', c.effort,
    '--sandbox', t.sandbox, '--cwd', t.cwd, '--task-dir', t.taskDir,
    ...(t.allowedOrigins.length ? ['--origins', t.allowedOrigins.join(',')] : []), ...(t.allowedApps.length ? ['--apps', t.allowedApps.join(',')] : []),
    ...(t.contentLabels.includes('security') ? ['--security'] : []), ...(t.contentLabels.includes('adversarial') ? ['--adversarial'] : [])];
}
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
export function renderPlan(plan, context = null) {
  const notes = [], needsOK = [], tellUser = [];
  for (const gate of plan.gates) {
    if (gate.state === 'needsOK') needsOK.push(gate.reason.text);
    else if (gate.state !== 'satisfied') notes.push(`${gate.phase}: ${gate.reason.text}`);
  }
  if (plan.kind === 'launch') {
    const { candidate: c, estimate: e } = plan.primary;
    notes.push(`${c.modelId}/${c.effort} on ${c.accountId}; ${taskEstimateText(e)}; lane: ${laneStartText(e)}.`);
    notes.push(...e.uncertainty.map((r) => r.text));
    if (e.patienceMin !== null) notes.push(`Queue patience: ${Math.round(e.patienceMin)} min; cancel/reconcile before any replacement.`);
  } else if (plan.kind === 'defer') tellUser.push(['personal-main-capacity','attempt-reconciliation'].includes(plan.trigger) ? plan.reason.text
    : `${plan.reason.text} Owner ${plan.task.owner} must record a ${plan.trigger} wake and replan.`);
  else tellUser.push(...plan.reasons.map((r) => `${r.code}: ${r.text}`));
  const view = { notes: unique(notes), needsOK: unique(needsOK), tellUser: unique(tellUser), command: plan.kind === 'launch' ? plan.primary.argv.map(quote).join(' ') : null };
  return freeze(context ? presentRoute(plan, view, context) : view);
}
export const argvMatches = (plan, seat) => stable(seat.argv) === stable(seatArgv(plan, seat));
