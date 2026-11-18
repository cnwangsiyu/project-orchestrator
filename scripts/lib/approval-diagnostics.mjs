import { scopedFlags, scopedRouteArgs } from './route-args.mjs';
import { shellQuote } from './pipeline/presentation.mjs';
import { createTaskSpec } from './pipeline/taskspec.mjs';

// Older records contain only a hash. Recover the missing-default cases only
// when recomputing the hash verifies the exact arguments and project.
function legacyFlags(task, hash, inheritedOwner) {
  const current = scopedFlags(task.flags);
  const omissions = [];
  if (current.owner) omissions.push(['owner']);
  if (current.failures === '0') omissions.push(['failures']);
  if (omissions.length === 2) omissions.push(['owner', 'failures']);
  for (const keys of omissions) {
    const flags = { ...current };
    for (const key of keys) delete flags[key];
    // Without --owner the original route may have inherited the launcher owner.
    const owners = new Set([task.owner]);
    if (keys.includes('owner')) {
      if (inheritedOwner) owners.add(inheritedOwner);
      owners.add('UNKNOWN');
    }
    for (const owner of owners)
      if (createTaskSpec({ ...task, flags, owner }).constraintHash === hash) return flags;
  }
  return null;
}

export function approvalMismatchHints(plan, snapshot, root, inheritedOwner) {
  const task = plan.task, current = scopedFlags(task.flags);
  const hints = [];
  for (const gate of plan.gates.filter(g => g.reason?.code === 'PERSONAL_QUOTA_OK_REQUIRED')) {
    const scope = gate.scope, account = scope.accounts[0];
    const candidates = [];
    for (const approval of snapshot.approvals) {
      if (approval.revoked || approval.grantedAt > snapshot.decisionAt || snapshot.decisionAt >= approval.expiresAt
        || (approval.project !== null && approval.project !== undefined && approval.project !== task.project)) continue;
      for (const prior of approval.scopes) {
        if (prior.action !== 'personal-quota' || prior.taskId !== scope.taskId || !prior.accounts.includes(account)
          || !prior.roles.includes(scope.roles[0]) || prior.constraintHash === scope.constraintHash) continue;
        const flags = approval.project === task.project && approval.routeFlags ? scopedFlags(approval.routeFlags)
          : scope.roles[0] === task.role ? legacyFlags(task, prior.constraintHash, inheritedOwner) : null;
        if (!flags) continue;
        const differences = [...new Set([...Object.keys(current), ...Object.keys(flags)])].sort()
          .filter(k => current[k] !== flags[k])
          .map(k => ({ arg: `--${k}`, approved: flags[k] ?? null, requested: current[k] ?? null }));
        if (approval.category && approval.category !== task.category)
          differences.unshift({ arg: 'category', approved: approval.category, requested: task.category });
        if (differences.length) candidates.push({ approval, differences });
      }
    }
    candidates.sort((a, b) => a.differences.length - b.differences.length
      || b.approval.grantedAt - a.approval.grantedAt || a.approval.id.localeCompare(b.approval.id));
    const closest = candidates[0];
    if (!closest) continue;
    const a = closest.approval;
    const astra = plan.gates.some(g => g.kind === 'astra' && g.scope?.taskId === scope.taskId
      && g.scope.roles.includes(scope.roles[0]) && g.scope.accounts.includes(account));
    const command = ['node', `${root}/scripts/approval.mjs`, 'add', '--account', account,
      ...(astra ? ['--astra'] : []), '--ref', a.userDecisionRef, '--until', new Date(a.expiresAt).toISOString(),
      '--', ...scopedRouteArgs(task)].map(shellQuote).join(' ');
    hints.push({ approvalId: a.id, differences: closest.differences, command });
  }
  return hints;
}

const argumentValue = value => value === null ? '<missing>' : value === true ? '<present>' : shellQuote(value);
export const mismatchHintText = hint => `closest approval ${hint.approvalId}: ${hint.differences.map(d =>
  `${d.arg}: approved ${argumentValue(d.approved)}; requested ${argumentValue(d.requested)}`).join('; ')}. Corrected scoped approval command (use only if the existing decision covers these arguments): ${hint.command}`;
