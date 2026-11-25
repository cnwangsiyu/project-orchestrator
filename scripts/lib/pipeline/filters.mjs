import {mandatoryReview} from '../review-policy-data.mjs';
import { policyModel, matchesModel, isAstra, newestRelease, VERSION, EFFORTS, array, company, companyDevice, known, modelId, familyOf, isReview, adversarial, result, reason, fingerprint, stable } from './common.mjs';
import { candidateParts, enumerateCandidates } from './candidates.mjs';
import { modelPreference, policyEffort, claudeBrowserPolicy, tierApprovalRef, tierDecision,
  mandatoryClaudeSeat, mandatoryClaudeApprovalRef, mandatoryClaudeDecision } from './policy.mjs';
import { estimateCandidate } from './estimate.mjs';
import { standingPersonalFallback, hardPersonalXhighFallback } from './personal-fallback.mjs';
import { standingPersonalPriority, personalPriorityGuard, exclusiveCodexTask } from './personal-priority.mjs';
import { liveAttempts, liveAttemptText } from './live-attempt.mjs';
import { unavailableDayQuota, previousReleaseFallback } from './release-fallback.mjs';
import { rejectedQualityAttempt } from '../worker-result.mjs';

const pass = (id) => result(id);
const deny = (id, code, text, c, extra) => result(id, code, text, [c.id], extra);
const effortIndex = (e) => EFFORTS.indexOf(e);
const sameSet = (a, b) => stable([...a].sort()) === stable([...b].sort());
export function approvalScope(t, c, action) {
  return { taskId: t.taskId, constraintHash: t.constraintHash, roles: [t.role], action, accounts: [c.accountId], models: [c.modelId],
    efforts: [c.effort], artifactHash: t.artifactRevision, origins: t.allowedOrigins, apps: t.allowedApps, allowPersonalWithCompany: false };
}
export function matchingApproval(t, s, c, action, bypass = false) {
  if (action === 'personal-quota' && (['image-gen','claude-tools'].includes(t.category))) return true;
  return s.approvals.find((a) => t.approvalRefs.includes(a.id) && !a.revoked && !(action === 'reset-redemption' && a.consumed)
    && a.grantedAt <= s.decisionAt && s.decisionAt < a.expiresAt && a.scopes.some((p) => p.taskId === t.taskId && p.constraintHash === t.constraintHash
      && p.roles.includes(t.role) && p.action === action && p.accounts.includes(c.accountId)
      && p.models.some(id => matchesModel(id, c.modelId) || action === 'astra' && isAstra(id) && isAstra(c.modelId))
      && p.efforts.includes(c.effort)
      && p.artifactHash === t.artifactRevision && sameSet(p.origins, t.allowedOrigins) && sameSet(p.apps, t.allowedApps) && (!bypass || p.allowPersonalWithCompany)));
}
export function approvalGate(t, c, action, code, text, phase = 'prelaunch') {
  const r = reason('pScopedApproval', code, text, [c.id]);
  const scope = approvalScope(t, c, action);
  return { id: `gate:${fingerprint([scope, code])}`, kind: action, phase, state: 'needsOK', scope, reason: r, evidenceIds: [] };
}
export function pUserRules(t, s, c) {
  if (t.sandboxCeiling === 'read-only' && (t.sandbox !== 'read-only' || t.writes)) return deny('pUserRules', 'SANDBOX_CEILING', 'Task exceeds the parent workspace ceiling.', c);
  if (t.requirements.credentialAccess) return deny('pUserRules', 'CREDENTIAL_ACCESS_FORBIDDEN', 'Credential/session access is not available to this pipeline.', c);
  return pass('pUserRules');
}
export function pExclusions(t, s, c) {
  const { account } = candidateParts(s, c);
  if (account.id === 'b')
    return deny('pExclusions', 'PERSONAL_B_REFUSED', 'The 2026-11-21 rule forbids new personal work on b independently of the priority window.', c);
  if (s.personalPriority?.mode === 'exclusive' && (!company(account) && account.kind !== 'claude'
    && (account.id !== s.personalPriority.account || account.kind !== 'chatgpt')
    || account.kind === 'claude' && exclusiveCodexTask(t, s) && !mandatoryClaudeSeat(t, c, account)))
    return deny('pExclusions', 'PERSONAL_EXCLUSIVE_ACCOUNT', 'New personal Codex work is restricted to main until the standing window is revoked.', c);
  const toolChannelFailed = ['browser','ui-browser','computer-use'].includes(t.category) && t.previousAttempts.some(a =>
    a.taskId === t.taskId && (a.role ?? 'primary') === t.role && ['failed','completed','succeeded'].includes(a.state) && a.failureKind === 'tool'
    && a.actualStatus === 'KNOWN' && (a.browserChannel ?? s.accounts.find(p => p.id === a.actual?.accountId)?.kind) === account.kind);
  if (toolChannelFailed) return deny('pExclusions', 'TOOL_CHANNEL_FAILED', 'Browser/desktop tool failure excludes this channel; select the next capable channel.', c);
  const excluded = t.exclusions.some((e) => (!e.companyOnly || company(account)) && (e.accountId === null || !e.accountId || e.accountId === c.accountId)
    && (e.scope === 'account' ? e.value === c.accountId : e.scope === 'family' ? e.value === c.family : matchesModel(e.value, c.modelId)));
  return excluded ? deny('pExclusions', 'EXCLUDED', 'Candidate matches an explicit exclusion.', c) : pass('pExclusions');
}
export function pAvailable(t, s, c) {
  const { account: a, model: m, lane: l } = candidateParts(s, c);
  if (!a || !m || !l || !known(a.catalog)?.includes(c.modelId) || !m.efforts.includes(c.effort) || !known(l.efforts)?.includes(c.effort)
    || l.accountId !== a.id || l.modelId !== m.id || l.harness !== c.harness || l.harness === 'UNKNOWN'
    || c.family !== m.family || c.qualityProfileId !== m.qualityProfiles[c.effort])
    return deny('pAvailable', 'CATALOG_UNSUPPORTED', 'The exact model, effort and harness must be declared.', c);
  if (!l.selectable && !l.evidenced) return deny('pAvailable', 'LANE_NOT_EVIDENCED', 'Provider-assigned lanes need current evidence; they cannot be forced.', c);
  if (s.personalPriority?.mode === 'exclusive' && a.kind === 'chatgpt' && a.id === s.personalPriority.account) {
    const guard = personalPriorityGuard(s);
    if (guard) return deny('pAvailable', 'PERSONAL_EXCLUSIVE_WAIT', guard, c);
  }
  if (known(a.auth) !== true) return deny('pAvailable', 'AUTH_UNKNOWN_OR_DENIED', 'Fresh positive authentication status is required.', c);
  if (known(a.transport) !== true) return deny('pAvailable', 'TRANSPORT_UNKNOWN_OR_DENIED', 'Fresh positive transport/supervisor status is required.', c);
  if (known(a.health) !== true) return deny('pAvailable', 'HEALTH_UNKNOWN', 'Health status is unknown.', c);
  if (s.health.some((h) => h.accountId === a.id && (!h.modelId || h.modelId === m.id) && (!h.family || h.family === c.family)
    && (h.restricted || h.recovery === 'awaiting-probe'))) return deny('pAvailable', 'ACTIVE_RESTRICTION', 'Restriction generation requires explicit matching recovery.', c);
  // Q1/Q2: only explicit provider denial is authoritative. Dashboard disagreement
  // and undocumented weekly semantics affect uncertainty, not account admission.
  if (known(a.providerDenied) === true && !company(a) && known(a.budget)?.redemption && !t.flags['no-redeem'])
    return deny('pAvailable','RESET_REDEMPTION_OK_REQUIRED','Redeem the named reset card with a separate scoped decision, then refresh quota and replan.',c,
      {gate:approvalGate(t,c,'reset-redemption','RESET_REDEMPTION_OK_REQUIRED','Reset redemption requires its own decision and refreshed capacity evidence.')});
  if (known(a.providerDenied) === true) return deny('pAvailable', 'PROVIDER_QUOTA_DENIED', 'Provider explicitly denied quota capacity.', c,
    { reconsiderAt: known(a.denialResetAt) > s.decisionAt ? known(a.denialResetAt) : null });
  const exhausted = unavailableDayQuota(a, l, s);
  if (exhausted && !(a.kind === 'trae' && t.flags['allow-low-priority-queue']))
    return deny('pAvailable', 'DAY_QUOTA_EXHAUSTED', `${a.id}/${m.id} day quota exhausted until ${exhausted.until ? new Date(exhausted.until).toISOString() : 'provider reset (time unknown)'}${exhausted.reason ? '; ' + exhausted.reason : ''}`, c,
      { reconsiderAt: exhausted.until });
  return pass('pAvailable');
}
export function pCapabilities(t, s, c) {
  const { account: a, model: m, lane: l } = candidateParts(s, c);
  if (['browser', 'ui-browser', 'computer-use'].includes(t.category) && a?.browserRuntime !== undefined) {
    const runtime = known(a.browserRuntime);
    if (runtime?.ready !== true) return deny('pCapabilities', 'BROWSER_RUNTIME_UNAVAILABLE',
      runtime?.why ?? `${a.id} browser runtime readiness is unknown or stale`, c);
  }
  if (t.category==='computer-use' && !['ttadk','chatgpt'].includes(a?.kind))
    return deny('pCapabilities','CAPABILITY_DESKTOP_TOOL','Desktop runtime is available only to TTADK and browser-ready ChatGPT.',c);
  for (const cap of t.capabilitiesNeeded) if ([a, m, l].some((part) => known(part?.capabilities?.[cap]) !== true))
    return deny('pCapabilities', `CAPABILITY_${cap.toUpperCase().replaceAll('-', '_')}`, `Missing positive ${cap} evidence in the model/account/harness intersection.`, c);
  if (t.category === 'computer-use' && !t.allowedApps.length) return deny('pCapabilities', 'APP_SCOPE_REQUIRED', 'Desktop work requires explicit app scope.', c);
  if (['browser', 'ui-browser'].includes(t.category) && !t.allowedOrigins.length) return deny('pCapabilities', 'ORIGIN_SCOPE_REQUIRED', 'Browser work requires explicit origin scope.', c);
  for (const scope of [...t.allowedApps.map((v) => `app:${v}`), ...t.allowedOrigins.map((v) => `origin:${v}`)])
    if ([a, l].some((part) => known(part?.capabilities?.[scope]) !== true)) return deny('pCapabilities', 'CAPABILITY_SCOPE', `Exact target access is missing: ${scope}.`, c);
  return pass('pCapabilities');
}
export function pTierFloor(t, s, c) {
  const account = candidateParts(s,c).account;
  const rung = policyModel(c.modelId);
  const browser = claudeBrowserPolicy(t);
  if (c.family === 'claude' && browser) {
    // Page operations have a fixed qualified tuple; general effort/tier or
    // budget preferences cannot turn browser work into an Opus launch.
    if (rung !== browser[0] || c.effort !== browser[1])
      return deny('pTierFloor', 'CLAUDE_BROWSER_TUPLE', `Claude browser ${t.browserKind ?? 'page'} requires ${browser[0]} ${browser[1]}; use another category for broader judgment.`, c);
    if (account.kind === 'claude') return pass('pTierFloor');
  }
  const releaseFallback = previousReleaseFallback(t, s, c);
  if (['astra', 'sol'].includes(rung) && c.modelId !== newestRelease(known(account?.catalog) ?? [], rung) && !releaseFallback)
    return deny('pTierFloor', 'MODEL_SUPERSEDED', 'A newer release is listed for this account.', c);
  const explicitEscalation = t.selectionCause === 'quality-escalation' && matchesModel(t.qualityEscalation?.modelId, c.modelId)
    && t.qualityEscalation?.policyVersion === s.policyVersion && !!t.qualityEscalation?.evidenceId;
  const ownerDowngrade = t.queueOwnerChoice?.candidateId === c.id && t.queueOwnerChoice.owner
    && t.queueOwnerChoice.decisionId && account.kind === 'trae' && t.queueOwnerChoice.allowLowerFloor && !releaseFallback;
  if (rung === 'astra' && t.tier !== 'hard' && t.category !== 'image-read' && !explicitEscalation) return deny('pTierFloor', 'ASTRA_SUBSTITUTION_HARD_ONLY', 'Astra substitutions are reserved for hard tasks.', c);
  const hardNonGPT = adversarial(t) && isReview(t) && !t.writes && !t.runsTests && ['kimi', 'deepseek'].includes(c.family);
  if (t.tier === 'hard' && !['astra', 'sol', 'opus', 'fable'].includes(rung) && !hardNonGPT && !ownerDowngrade)
    return deny('pTierFloor', 'TIER_QUALITY_FLOOR', 'Candidate is outside the established hard-task floor.', c);
  if (t.tier !== 'hard' && !['astra', 'sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-6.1-terra', 'gpt-6-luna',
    'gpt-5.6-luna', 'kimi-k3', 'deepseek-v4.1-flash', 'gemini-3.1-pro-preview', 'seed-evolving', 'opus', 'sonnet', 'haiku', 'fable'].includes(rung))
    return deny('pTierFloor', 'TIER_QUALITY_FLOOR', 'Model has no established category qualification.', c);
  if (!modelPreference(t,account,s).includes(rung)&&!explicitEscalation&&!ownerDowngrade) return deny('pTierFloor','CATEGORY_MODEL_FIT','Model is outside the category/account policy list.',c);
  if (effortIndex(c.effort) < effortIndex(policyEffort(t, c, account,s))) return deny('pTierFloor', 'TIER_EFFORT_FLOOR', 'Effort is below the category/model floor.', c);
  return pass('pTierFloor');
}
// Partial relation only: no cross-family leaderboard. Explicit versioned edges
// are injected policy, distinct from admissibility for a task category.
export function dominates(c, previous, s) {
  const id = modelId(previous.modelId ?? previous.model), effort = previous.effort;
  if (!EFFORTS.includes(effort) || !id) return false;
  if (id === c.modelId) return effortIndex(c.effort) >= effortIndex(effort);
  const previousRung = policyModel(id);
  if (['astra', 'sol'].includes(previousRung) && c.family === 'gpt') {
    if (previousRung === 'sol' && isAstra(c.modelId)) return effortIndex(c.effort) >= effortIndex(effort);
    return newestRelease([id, c.modelId], previousRung) === c.modelId && effortIndex(c.effort) >= effortIndex(effort);
  }
  const from = `${id}:${effort}`, to = c.qualityProfileId;
  const seen = new Set([from]), pending = [from];
  while (pending.length) {
    const current = pending.shift();
    for (const edge of s.qualityRelations.filter((e) => e.from === current && e.version === s.qualityRelationVersion && e.evidenceId)) {
      if (edge.to === to) return true;
      if (!seen.has(edge.to)) { seen.add(edge.to); pending.push(edge.to); }
    }
  }
  return false;
}
export function pPreviousFloor(t, s, c, context = {}) {
  const capacityRows = context.companyRows ?? (candidateParts(s, c).account?.kind === 'chatgpt' && isAstra(c.modelId)
    ? enumerateCandidates(t, s).candidates.filter(candidate => company(candidateParts(s, candidate).account))
      .map(candidate => ({ candidate, predicates: evaluateCandidate(t, s, candidate, { ...context, companyRows: [] }),
        estimate: estimateCandidate(t, s, candidate) })) : []);
  const attempts = t.previousAttempts;
  const relevant = attempts.filter((a) => a?.taskId === t.taskId && (a.role ?? 'primary') === t.role
    && a.state !== 'planned' && a.state !== 'transport-failed' && a.failureKind !== 'transport-failed');
  const accountlessActual=a=>a.source==='explicit-actual'&&a.actualStatus==='KNOWN'&&a.actual?.accountStatus==='UNKNOWN'
    && a.actual.accountId===null && modelId(a.actual.modelId??a.actual.model) && EFFORTS.includes(a.actual.effort);
  if (relevant.some((a) => !a.id || (!a.actual?.accountId&&!accountlessActual(a)))) return deny('pPreviousFloor', 'PREVIOUS_ATTEMPT_UNKNOWN', 'Prior attempt identity and actual account must be attested, or an explicit account-less model/effort floor supplied.', c);
  if ((t.autoRerouteDepth > 0 || array(t.floor.previousAttemptIds).length > 0) && !relevant.length && !t.transportFailures?.length)
    return deny('pPreviousFloor', 'PREVIOUS_ATTEMPT_UNKNOWN', 'Retry requires sanitized actual-attempt evidence.', c);
  if (t.floor.relationVersion !== s.qualityRelationVersion && relevant.length) return deny('pPreviousFloor', 'QUALITY_RELATION_UNKNOWN', 'The pinned quality relation is unavailable.', c);
  if (array(t.floor.previousAttemptIds).some((id) => !relevant.some((a) => a.id === id)) || relevant.some((a) => a.actualStatus !== 'KNOWN' || !a.actual))
    return deny('pPreviousFloor', 'PREVIOUS_ATTEMPT_UNKNOWN', 'An actual prior tuple is unknown.', c);
  const releaseFallback = previousReleaseFallback(t, s, c);
  if (!releaseFallback && t.queueOwnerChoice?.candidateId === c.id && t.queueOwnerChoice.owner && t.queueOwnerChoice.decisionId
    && (t.queueOwnerChoice.allowLowerFloor && candidateParts(s,c).account.kind === 'trae'
      || t.queueOwnerChoice.allowFamilyChange && c.family === 'claude')) return pass('pPreviousFloor');
  // Light quality failures promote to the Sol retry, even when a weaker normal
  // model has a free lane. More effort on the failed light model is not this rung.
  const lightRetry = ['lookup', 'extract', 'draft'].includes(t.category) || t.category === 'build-run' && t.env === 'test';
  if (lightRetry && relevant.some(a => ['quality', 'spec', 'process'].includes(a.failureKind)
    && (!t.infraRetry || rejectedQualityAttempt(a))
    && ['gpt-5.6-terra', 'gpt-5.5'].includes(modelId(a.actual?.modelId)))
    && c.family === 'gpt' && !['sol', 'astra'].includes(policyModel(c.modelId)))
    return deny('pPreviousFloor', 'RETRY_LIGHT_REQUIRES_SOL', 'A failed light quality rung requires the Sol retry or a stronger model.', c);
  for (const a of relevant) {
    // Category-qualified company recovery may step back from a personal model
    // that was merely executed/completed, while genuine quality rejection and
    // every company actual tuple still retain their established floor.
    if (t.infraRetry && company(candidateParts(s,c).account)
      && ['chatgpt','claude'].includes(s.accounts.find(account => account.id === a.actual?.accountId)?.kind)
      && !rejectedQualityAttempt(a)) continue;
    if (releaseFallback && a.actual.accountId === c.accountId && modelId(a.actual.modelId) === releaseFallback.newest
      && !rejectedQualityAttempt(a) && !['quality', 'spec', 'process'].includes(a.failureKind)
      && a.cancellationEvidenceId && (a.state === 'cancelled-no-work' && a.usefulWork === false
        || a.state === 'interrupted' && t.queueOwnerChoice?.midTurn && t.queueOwnerChoice.previousAttemptId === a.id)
      && effortIndex(c.effort) >= effortIndex(a.actual.effort)) continue;
    const capacityFallback = hardPersonalXhighFallback(t, s, c, capacityRows);
    if (capacityFallback && a.state === 'cancelled-no-work' && a.usefulWork === false && a.cancellationEvidenceId) continue;
    // A failed tool says nothing about answer quality across model families.
    const toolSwitch = a.failureKind === 'tool' && ['browser','ui-browser','computer-use'].includes(t.category)
      && c.family !== familyOf(a.actual.modelId ?? a.actual.model);
    if (!toolSwitch && !dominates(c, a.actual, s)) return deny('pPreviousFloor', 'RETRY_BELOW_ACTUAL_FLOOR', 'Candidate does not dominate every real prior attempt.', c);
    if (['quality', 'spec', 'process'].includes(a.failureKind) && (!t.infraRetry || rejectedQualityAttempt(a))
      && policyModel(a.actual.modelId ?? a.actual.model) === policyModel(c.modelId) && a.actual.effort === c.effort
      && !matchingApproval(t, s, c, 'retry-same-floor') && !(capacityFallback
        && company(s.accounts.find(account => account.id === a.actual.accountId))))
      return deny('pPreviousFloor', 'QUALITY_REPEAT_REQUIRES_DECISION', 'Repeating an exhausted quality step requires an explicit task decision.', c);
  }
  for (const profile of array(t.floor.profileIds)) {
    const at = profile.lastIndexOf(':');
    if (!dominates(c, { modelId: profile.slice(0, at), effort: profile.slice(at + 1) }, s)) return deny('pPreviousFloor', 'RETRY_BELOW_ACTUAL_FLOOR', 'An explicit quality floor is not met.', c);
  }
  return pass('pPreviousFloor');
}
export function pContent(t, s, c) {
  if (adversarial(t) && c.family === 'gpt') return deny('pContent', 'ADVERSARIAL_GPT_FORBIDDEN', 'Adversarial/policy-blocked content excludes GPT on every account.', c);
  if (t.contentLabels.includes('security') && candidateParts(s, c).account?.kind === 'trae' && c.family === 'gpt')
    return deny('pContent', 'SECURITY_TRAE_GPT_FORBIDDEN', 'Security content excludes TRAE GPT.', c);
  return pass('pContent');
}
export function pModelFit(t, s, c, context = {}) {
  const account = candidateParts(s,c).account;
  if (t.infraRetry && !t.qualityFailures && t.environmentFailures?.some(a => company(s.accounts.find(account => account.id === a.actual?.accountId)))
    && !company(candidateParts(s,c).account))
    return deny('pModelFit', 'ENVIRONMENT_RETRY_COMPANY_ONLY', 'An environment-blocked company turn retries on company lanes without advancing the quality ladder.', c);
  if(c.modelId==='gpt-5.6-luna'||candidateParts(s,c).account.kind==='trae'&&c.modelId.startsWith('gemini')) return deny('pModelFit','MODEL_RETIRED','This model is retired from current routing; historical tuples remain valid history.',c);
  if (c.family === 'deepseek' && !adversarial(t) && isReview(t) && (t.stakes === 'high' || t.impact === 'release' || t.contentLabels.includes('defensive-confirmation'))) return deny('pModelFit', 'MODEL_FIT_SENSITIVE_REVIEW', 'Sensitive reviews require an established strong reviewer family.', c);
  if (c.family === 'kimi' && candidateParts(s, c).account?.kind !== 'ttadk') return deny('pModelFit', 'KIMI_TTADK_ONLY', 'The established Kimi route is TTADK only.', c);
  if (c.family === 'deepseek' && (t.category === 'build-run' || t.runsTests || ['fullPackageBuild', 'executableAcceptance', 'authAcceptance', 'storageAcceptance'].some((k) => t.requirements[k])))
    return deny('pModelFit', 'MODEL_FIT_BUILD_ACCEPTANCE', 'DeepSeek cannot perform build or executable/auth/storage acceptance.', c);
  if ((c.family === 'seed' || candidateParts(s, c).model?.visionOnly) && t.category !== 'image-read') return deny('pModelFit', 'MODEL_FIT_VISION_ONLY', 'Vision-only models are not general fallbacks.', c);
  if (t.requirements.largeSingleOutput && (c.family === 'deepseek' || known(candidateParts(s, c).model?.largeOutput) !== true)) return deny('pModelFit', 'MODEL_FIT_LARGE_OUTPUT', 'Large single-output support is required.', c);
  if (adversarial(t) && !['kimi-k3', 'deepseek-v4.1-flash', 'opus'].includes(c.modelId)) return deny('pModelFit', 'ADVERSARIAL_FAMILY_ORDER', 'Adversarial policy permits Kimi-K3, DeepSeek Flash, then scoped Opus.', c);
  return pass('pModelFit');
}
export function pSigning(t, s, c) {
  if (!t.flags.signing) return pass('pSigning');
  const a = candidateParts(s,c).account;
  if (c.family === 'claude' || t.sandbox !== 'danger-full-access')
    return deny('pSigning','SIGNING_FULL_ACCESS_REQUIRED','Registered own-test signing uses an ordinary full-access Codex-family worker; quota permission follows its actual account.',c);
  // --signing declares the registered own-test workflow. The worker must check
  // its public package registry and identity allowlist at action time; routing
  // never opens signing material or invents a new manifest prerequisite.
  return pass('pSigning');
}
export function pDevice(t, s, c) {
  if (!t.deviceId && !t.flags['device-lease']) return pass('pDevice');
  const device = known(s.resources)?.devices?.[t.deviceId];
  if (!device?.registered || device.personal || !t.ownTestApp || !device.ownTestApp) return deny('pDevice', 'DEVICE_FORBIDDEN', 'Only registered permitted own-test-app devices are allowed.', c);
  const { account: a, lane: l } = candidateParts(s, c);
  if ([a, l].some((p) => known(p?.capabilities?.[`device:${t.deviceId}`]) !== true)) return deny('pDevice', 'CAPABILITY_DEVICE', 'Device tool access is missing.', c);
  if (device.leaseMinutes > 120 || device.leaseMinutes <= 0 || !Number.isFinite(device.leaseMinutes)) return deny('pDevice', 'DEVICE_LEASE_PROTOCOL', 'Device leases must be bounded to two hours.', c);
  return pass('pDevice');
}
export function pScopedApproval(t, s, c, context = {}) {
  const a = candidateParts(s, c).account;
  const personalPriority = mandatoryClaudeSeat(t, c, a) ? {
    approvalRef: mandatoryClaudeApprovalRef, quotaApproved: true,
    text: `Codex-authored mandatory class ${t.reviewClass} review uses Claude Opus 5.5 medium under the standing user decision of ${mandatoryClaudeDecision}.`
  } : standingPersonalPriority(t, s, c, a);
  const tierMain = context.tierDowngrade && a.id === 'main' && a.kind === 'chatgpt' && policyModel(c.modelId) === 'sol'
    && c.effort !== 'max';
  let personalFallback = personalPriority ?? (a.kind === 'chatgpt' && s.personalFallback?.enabled ? standingPersonalFallback(t, s, c,
    context.companyRows ?? enumerateCandidates(t, s).candidates.filter(p => company(candidateParts(s, p).account))
      .map(candidate => ({ candidate, predicates: evaluateCandidate(t, s, candidate, context), estimate: estimateCandidate(t, s, candidate) }))) : null);
  if (!personalFallback && tierMain) {
    const start = estimateCandidate(t, s, c);
    if (!start.stalled && start.startDelayMin === 0) personalFallback = {
      approvalRef: tierApprovalRef, quotaApproved: true,
      text: `Personal main approved for a proper-tier route ahead of a company downgrade under the user decision of ${tierDecision}.` };
  }
  const requirements = [];
  if (!company(a) && (a.kind==='claude'||companyDevice(s)) && !personalFallback?.quotaApproved) requirements.push(['personal-quota', 'PERSONAL_QUOTA_OK_REQUIRED', 'Current scoped personal-quota approval is required.', context.companyEligible || context.companyUnknown]);
  if (isAstra(c.modelId) && a?.kind==='chatgpt' && !personalFallback?.astraApprovalRef) requirements.push(['astra','PERSONAL_ASTRA_OK_REQUIRED',`use ${c.modelId} on personal account ${a.id}?`]);
  if (c.effort === 'max' && !company(a)) requirements.push(['max-effort', 'MAX_EFFORT_OK_REQUIRED', 'Max effort on a personal account requires its own scoped approval.']);
  if (c.modelId === 'fable') requirements.push(['fable', 'FABLE_OK_REQUIRED', 'Fable requires a separate scoped decision.']);
  if (t.requirements.resetRedemption) requirements.push(['reset-redemption', 'RESET_REDEMPTION_OK_REQUIRED', 'Each reset redemption needs unused scoped approval.']);
  const missing = requirements.filter(([action, , , bypass]) => !matchingApproval(t, s, c, action, bypass));
  if (missing.length) {
    const gates = missing.map(([action, code, text]) => approvalGate(t, c, action, code, text));
    return deny('pScopedApproval', missing[0][1], missing[0][2], c, { gate: gates[0], gates, personalFallback });
  }
  return { ...pass('pScopedApproval'), personalFallback };
}
export function pBackground(t, s, c) {
  return pass('pBackground'); // Personal background work uses the same scoped/standing quota permission as foreground work.
}
export function pResourceScope(t, s, c) {
  const resources = known(s.resources);
  if (t.execution === 'remote' && (t.flags['shared-lock'] || t.requirements.localLock)) return deny('pResourceScope', 'REMOTE_LOCAL_LOCK_FORBIDDEN', 'Remote/CI work cannot acquire local build resources.', c);
  if (t.autoRerouteDepth > 0 && (!resources || resources.held === true || resources.ownedReturned !== true)) return deny('pResourceScope', 'RESOURCE_HOP_BLOCKED', 'A hop requires confirmed return of all owned resources.', c);
  if (t.execution !== 'remote' && (t.execution === 'local-heavy' || t.category === 'build-run' || t.requirements.fullPackageBuild)) {
    const r = reason('pResourceScope', 'LOCAL_WRAPPER_REQUIRED', 'Acquire local compute only after the first response, in one watched wrapper; controller UNKNOWN/timeout blocks the action.', [c.id]);
    return result('pResourceScope', null, '', [], { gate: { id: `local:${t.taskId}:${t.role}`, kind: 'local-resource-admission', phase: 'preaction', state: 'wait', scope: null, reason: r, evidenceIds: [] } });
  }
  return pass('pResourceScope');
}
export function needsReviewer(t, s) {
  return mandatoryReview(t)&&t.role === 'primary' && (t.reviewClass==='D' && isReview(t) || t.category === 'review-high'
    || isReview(t) && t.impact === 'release');
}
export function pReviewerSet(t, s, c, context = {}) {
  const author = t.previousAttempts.find((a) => a.id === (t.authorAttemptId ?? t.againstAttemptId)) ?? context.author;
  if ((t.authorAttemptId || t.againstAttemptId) && (!author?.actual || author.actualStatus !== 'KNOWN'))
    return deny('pReviewerSet', 'AUTHOR_ATTEMPT_UNKNOWN', 'Independent review needs the attested author/against attempt.', c);
  if (author?.actual && (author.id === context.attemptId || familyOf(author.actual.modelId ?? author.actual.model) === c.family))
    return deny('pReviewerSet', 'REVIEWER_NOT_INDEPENDENT', 'Reviewer must be a fresh attempt from another family.', c);
  if (context.primary && c.family === context.primary.family) return deny('pReviewerSet', 'REVIEWER_NOT_INDEPENDENT', 'The second reviewer must use another family.', c);
  if ((t.flags.author === 'claude' || t.flags.against === 'claude') && c.family === 'claude') return deny('pReviewerSet', 'REVIEWER_VENDOR_CONFLICT', 'Review must respect the explicit other-vendor constraint.', c);
  if ((t.flags.author === 'codex' || t.flags.against === 'codex') && c.family === 'gpt')
    return deny('pReviewerSet', 'REVIEWER_VENDOR_CONFLICT', 'Review must respect the explicit other-vendor constraint.', c);
  if (context.primary && !adversarial(t) && !['gpt', 'claude'].includes(c.family) && !['gpt', 'claude'].includes(context.primary.family))
    return deny('pReviewerSet', 'REVIEWER_STRONG_FAMILY_REQUIRED', 'Ordinary acceptance needs an independent GPT/Claude reviewer.', c);
  if (context.reviewers !== undefined && needsReviewer(t,s)) {
    if (context.reviewers.some((r) => r.candidate.family === c.family || r.task.artifactRevision !== t.artifactRevision
      || (adversarial(t) && r.candidate.family === 'gpt'))) return deny('pReviewerSet', 'REVIEWER_NOT_INDEPENDENT', 'Reviewer set violates family or artifact requirements.', c);
  }
  return pass('pReviewerSet');
}
export function pLaunchMatches(t, s, c, context = {}) {
  if (s.policyVersion !== VERSION || s.qualityRelationVersion !== t.floor.relationVersion) return deny('pLaunchMatches', 'POLICY_VERSION_MISMATCH', 'Plan policy/relation version must be pinned and supported.', c);
  if (liveAttempts(t).length) return deny('pLaunchMatches', 'ATTEMPT_RECONCILIATION_REQUIRED', liveAttemptText(t, s.decisionAt), c);
  if (t.autoRerouteDepth > 0) {
    const prior = t.previousAttempts.filter((a) => a.taskId === t.taskId && (a.role ?? 'primary') === t.role);
    const personalQueue = !company(candidateParts(s,c).account) && s.personalFallback?.enabled
      && prior.at(-1)?.rerouteReason === 'queue-too-slow'
      && Number.isFinite(prior.at(-1)?.queueWaitMinutes) && prior.at(-1).queueWaitMinutes >= s.personalFallback.queueWaitMinutes
      && pScopedApproval(t,s,c,context).personalFallback?.quotaApproved;
    const ownerChoice=t.queueOwnerChoice?.candidateId===c.id&&t.queueOwnerChoice.owner&&t.queueOwnerChoice.decisionId;
    if (t.autoRerouteDepth > 2 || t.background&&!ownerChoice || t.flags.signing || (!company(candidateParts(s,c).account) && !personalQueue&&!ownerChoice)) return deny('pLaunchMatches', 'AUTO_REROUTE_FORBIDDEN', 'Automatic hop limit or task scope forbids replacement.', c);
    const checked = (ownerChoice || t.queueOwnerChoice?.requireFloor) ? prior.filter(a=>a.id === t.queueOwnerChoice.previousAttemptId) : prior;
    const ownerInterruption = t.queueOwnerChoice?.owner && t.queueOwnerChoice.decisionId && t.queueOwnerChoice.midTurn === true;
    const confirmed = a => a.cancellationEvidenceId && (a.state === 'cancelled-no-work' && a.usefulWork === false
      || ownerInterruption && a.id === t.queueOwnerChoice.previousAttemptId && a.state === 'interrupted' && a.usefulWork === true
      || a.terminalProviderDenial === true && a.rerouteReason === 'provider-quota-denied' && a.state === 'failed'
        && a.actual?.accountId === 'main' && a.failureKind === 'infra' && company(candidateParts(s,c).account));
    if (!checked.length || checked.some(a => !confirmed(a)))
      return deny('pLaunchMatches', 'CANCELLATION_UNCONFIRMED', 'Automatic replacement requires terminal no-work cancellation evidence.', c);
  }
  if (context.proposed && ['accountId', 'modelId', 'effort', 'laneId', 'harness'].some((k) => context.proposed[k] !== c[k]))
    return deny('pLaunchMatches', 'LAUNCH_TUPLE_MISMATCH', 'Proposed tuple does not match the validated seat.', c);
  return pass('pLaunchMatches');
}
export const PREDICATES = Object.freeze([pUserRules, pExclusions, pAvailable, pCapabilities, pTierFloor, pPreviousFloor, pContent, pModelFit,
  pSigning, pDevice, pScopedApproval, pBackground, pResourceScope, pReviewerSet, pLaunchMatches]);
export const evaluateCandidate = (t, s, c, context = {}) => PREDICATES.map((predicate) => ({ ...predicate(t, s, c, context), candidateId: c.id }));
