import { isAstra, array, object, finite, nonnegative, company, freeze, matchesModel } from './common.mjs';
import { candidateParts } from './candidates.mjs';

export function personalFallbackPolicy(raw, now) {
  if (!nonnegative(now) || !object(raw) || typeof raw.enabled !== 'boolean' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.since ?? '')
    || !finite(Date.parse(raw.since)) || Date.parse(raw.since) > now
    || raw.userDecisionRef !== `standing:personal-fallback-${raw.since}`) return null;
  const queueWaitMinutes = raw.queueWaitMinutes ?? 5;
  if (!finite(queueWaitMinutes) || queueWaitMinutes <= 0) return null;
  const queueReminderMinutes = raw.queueReminderMinutes ?? 10;
  if (!finite(queueReminderMinutes) || queueReminderMinutes <= 0) return null;
  const hardAstraDecisionRef = raw.hardAstraDecisionRef === `standing:hard-astra-${raw.since}` ? raw.hardAstraDecisionRef : null;
  return { enabled: raw.enabled, since: raw.since, userDecisionRef: raw.userDecisionRef, queueWaitMinutes,queueReminderMinutes,
    allowHardPersonalAstra: raw.allowHardPersonalAstra === true && !!hardAstraDecisionRef, hardAstraDecisionRef };
}

// Retain only explicit negative capacity evidence when status ages out. It never
// changes ordinary admission, freshens observations, or survives a known reset.
export function fallbackUnavailable(account, now) {
  const unwrap = value => object(value) && Object.hasOwn(value, 'status')
    ? value.status === 'KNOWN' ? value.value : null : value;
  const fresh = (value, ttl) => !object(value) || nonnegative(value.sampledAt) && value.sampledAt <= now
    && now - value.sampledAt <= Math.min(ttl, value.maxAgeMs ?? ttl);
  const reset = unwrap(account.denialResetAt);
  if (unwrap(account.providerDenied) === true && (reset == null || reset > now)) {
    const at = account.providerDenied?.sampledAt ?? now;
    if (nonnegative(at) && at <= now) return { kind: 'provider-denied', sampledAt: at, until: reset ?? null };
  }
  if (account.kind === 'ttadk') for (const q of array(account.quota)) {
    const usage = unwrap(q.usage), at = q.usage?.sampledAt ?? now;
    if (q.authoritative === true && usage && nonnegative(usage.used) && finite(usage.limit) && usage.used >= usage.limit && usage.limit > 0 && usage.resetsAt > now
      && nonnegative(at) && at <= now) return { kind: 'quota-exhausted', sampledAt: at, until: usage.resetsAt };
  }
  const existing = account.fallbackUnavailable;
  const refreshed = existing?.kind === 'provider-denied'
    ? unwrap(account.providerDenied) === false && fresh(account.providerDenied, 600000)
    : array(account.quota).some(q => {
      const usage = unwrap(q.usage);
      return usage && nonnegative(usage.used) && finite(usage.limit) && usage.used < usage.limit
        && usage.resetsAt > now && fresh(q.usage, 1800000);
    });
  if (!refreshed && object(existing) && ['quota-exhausted', 'provider-denied'].includes(existing.kind)
    && nonnegative(existing.sampledAt) && existing.sampledAt <= now
    && (existing.until === null || nonnegative(existing.until) && existing.until > now)
    && !(reset != null && reset <= now)) return { kind: existing.kind, sampledAt: existing.sampledAt, until: existing.until };
  return null;
}

function excludedAfterInfrastructure(task, candidate) {
  return task.exclusions.some(e => (!e.accountId || e.accountId === candidate.accountId)
    && (e.scope === 'account' ? e.value === candidate.accountId : e.scope === 'family' ? e.value === candidate.family : matchesModel(e.value, candidate.modelId))
    && (e.cause === 'infrastructure' || task.previousAttempts.some(a => a.actual?.accountId === candidate.accountId
      && a.actualStatus === 'KNOWN' && a.failureKind === 'infra' && ['failed', 'cancelled-no-work'].includes(a.state))));
}

export function standingPersonalFallback(task, snapshot, candidate, rows) {
  const policy = snapshot.personalFallback, account = candidateParts(snapshot, candidate).account;
  const astra = isAstra(candidate.modelId);
  if (!policy?.enabled || account?.kind !== 'chatgpt' || candidate.family !== 'gpt'
    || (astra && !(task.tier === 'hard' && policy.allowHardPersonalAstra))
    || (!astra && (candidate.effort === 'max' || task.requirements.resetRedemption)) || task.reviewClass
    || task.contentLabels.some(l => ['security', 'adversarial', 'attack-material', 'policy-blocked'].includes(l))) return null;
  const companies = snapshot.accounts.filter(company);
  if (!companies.length && snapshot.accounts.some(a => a.kind === 'UNKNOWN')) return null;
  if (!companies.length && !astra) return null; // Existing personal-device quota permission.
  const allCompanyUnknown = companies.length > 0 && companies.every(a => [a.auth, a.transport, a.catalog, a.health]
    .some(o => o?.status !== 'KNOWN' || o.source === 'last-good-stale') || a.health.value !== true);
  const restrictedFor = c => snapshot.health.some(h => h.accountId === c.accountId && (!h.modelId || h.modelId === c.modelId)
    && (!h.family || h.family === c.family) && (h.restricted || h.recovery === 'awaiting-probe'));
  const explanations = companies.length ? [] : ['no company accounts registered'], options = [];
  const relevant = rows.filter(r => r.predicates.every(p => p.ok || ['pAvailable', 'pExclusions', 'pScopedApproval'].includes(p.ruleId)));
  let reserveApplied = false;
  for (const a of companies) {
    const pool = relevant.filter(r => r.candidate.accountId === a.id);
    const excluded = task.exclusions.some(e => e.scope === 'account' && e.value === a.id)
      && excludedAfterInfrastructure(task, { accountId: a.id });
    const restricted = snapshot.health.some(h => h.accountId === a.id && !h.modelId && !h.family && h.restricted);
    const unavailable = a.fallbackUnavailable;
    if (excluded && !allCompanyUnknown || restricted || unavailable) {
      explanations.push(`${a.id}: ${excluded ? 'excluded after infrastructure failures' : restricted ? 'restricted' : unavailable.kind === 'quota-exhausted' ? 'daily quota exhausted' : 'provider quota denied'}${unavailable?.until ? ` until ${new Date(unavailable.until).toISOString()}` : ''}`);
      continue;
    }
    // An unresolved catalog/status is not evidence that company quota is out.
    if (!pool.length) return null;
    if (allCompanyUnknown && a.catalog.value?.some(id => !rows.some(r => r.candidate.accountId === a.id && r.candidate.modelId === id))) return null;
    for (const r of pool) {
      const failures = r.predicates.filter(p => !p.ok);
      if (restrictedFor(r.candidate)) {
        explanations.push(`${a.id}/${r.candidate.modelId}: restricted`);
        continue;
      }
      if (allCompanyUnknown) return null;
      const reserve = failures.find(p => p.reason?.code === 'TTADK_DAILY_RESERVE');
      if (reserve) {
        reserveApplied = true;
        explanations.push(reserve.reason.text);
        continue;
      }
      if (failures.some(p => ['TOOL_CHANNEL_FAILED', 'ACTIVE_RESTRICTION', 'PROVIDER_QUOTA_DENIED'].includes(p.reason?.code)
        || p.reason?.code === 'EXCLUDED' && excludedAfterInfrastructure(task, r.candidate))) {
        explanations.push(`${a.id}/${r.candidate.modelId}: excluded after infrastructure failure, restricted or quota denied`);
        continue;
      }
      if (failures.length || r.estimate.confidence === 'UNKNOWN') return null;
      if (!r.estimate.stalled && r.estimate.startDelayMin <= policy.queueWaitMinutes) return null;
      options.push(r);
    }
  }
  if (options.length) {
    options.sort((a, b) => (a.estimate.startDelayMin ?? Infinity) - (b.estimate.startDelayMin ?? Infinity));
    const best = options[0], { account: a, lane } = candidateParts(snapshot, best.candidate);
    if (a.kind !== 'trae' || (lane.mode !== 'low-priority' && !reserveApplied)) return null;
    const queue = best.estimate.stalled ? 'flat/stalled queue' : `predicted start ~${Math.round(best.estimate.startDelayMin)} min`;
    explanations.push(`${a.id}/${best.candidate.modelId} ${lane.mode === 'low-priority' ? 'low-priority ' : ''}${queue} > ${policy.queueWaitMinutes} min`);
  }
  if (astra) explanations.push(`personal Astra for hard-tier task (standing user OK ${policy.since}: ${policy.hardAstraDecisionRef})`);
  return freeze({ approvalRef: policy.userDecisionRef, since: policy.since, queueWaitMinutes: policy.queueWaitMinutes,
    quotaApproved: candidate.effort !== 'max' && !task.requirements.resetRedemption,
    astraApprovalRef: astra ? policy.hardAstraDecisionRef : null,
    text: `personal fallback (standing user OK ${policy.since}): ${[...new Set(explanations)].join('; ')}` });
}
