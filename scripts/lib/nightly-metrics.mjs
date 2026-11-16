// Pure calculations over frozen collector output. No CLI, shared writes or model calls.
import fs from 'node:fs';

export const thresholds = JSON.parse(fs.readFileSync(new URL('./nightly-thresholds.json', import.meta.url), 'utf8'));
const finite = v => typeof v === 'number' && Number.isFinite(v);
const round = v => finite(v) ? +v.toFixed(2) : null;
const entries = v => Object.entries(v ?? {});
const esc = v => String(v ?? 'UNKNOWN').replace(/[|\r\n]/g, ' ');

export function computeNightly({ day, review, resources, usage, previousUnknownClasses = [], evidence = {}, config = thresholds, now = Date.now() }) {
  const metrics = [], findings = [], unknown = new Set();
  const pointer = (source, field) => `${evidence[source] ?? source}#${field}`;
  const add = (id, value, limit, source, field, { project = null, owner = null, comparison = 'observe', unknownClass = id } = {}) => {
    const missing = value == null;
    if (missing) unknown.add(unknownClass);
    const triggered = !missing && (comparison === 'above' ? value > limit : comparison === 'below' ? value < limit : comparison === 'at-or-below' ? value <= limit : false);
    const row = { id, project, owner, value, threshold: limit, comparison, status: missing ? 'UNKNOWN' : triggered ? 'FINDING' : 'OK', evidence: [pointer(source, field)] };
    metrics.push(row);
    if (triggered) findings.push({ ...row, class: id.split('/')[0] });
  };
  const rules = review?.globalRules;
  const ownerFor = project => rules?.acknowledgements?.find(a => a.project === project)?.session ?? null;
  const projects = review?.reviews?.window?.byProject;
  if (!projects) add('review-share', null, null, 'review', 'reviews.window.byProject');
  for (const [project, p] of entries(projects)) {
    const target = p.targetExcluded ? null : p.targetPct ?? config.reviewTargetPct[project] ?? config.reviewTargetPct.default;
    // Compare the exact ratio, not the collector's rounded display percentage.
    add(`review-share/${project}`, p.dispatches > 0 ? p.reviews / p.dispatches * 100 : null, target, 'review', `reviews.window.byProject.${project}`,
      { project, owner: ownerFor(project), comparison: target == null ? 'observe' : 'above', unknownClass: 'review-share' });
    add(`review-yield/${project}`, p.reviews > 0 ? `${p.yield?.blocking ?? 'UNKNOWN'}/${p.yield?.known ?? 'UNKNOWN'} known; ${p.yield?.unknown ?? 'UNKNOWN'} unknown; mandatory ${p.requiredReviews}; second ${p.secondReviewers}; re-review ${p.reReviews}` : 'no reviews', null, 'review', `reviews.window.byProject.${project}.yield`, { project });
    if (p.reviews > 0 && (!p.yield || p.yield.unknown > 0)) unknown.add('review-yield');
  }
  for (const [id, key, limit] of [['unrouted', 'unrouted', config.unroutedMax], ['mismatches', 'launchMismatches', config.mismatchesMax], ['personal-approval', 'personalQuotaWithoutOK', config.missingPersonalApprovalMax]]) {
    const rows = rules?.[key];
    add(id, Array.isArray(rows) ? rows.length : null, limit, 'review', `globalRules.${key}`, { comparison: 'above' });
    if (findings.at(-1)?.id === id) {
      // Retain attribution without treating attribution as a route or removing historical launches.
      findings.at(-1).items = rows.map(r => ({ name: r.name, project: r.project ?? null,
        owner: r.attributedOwner ?? r.orchestrator ?? ownerFor(r.project), evidence: pointer('review', `globalRules.${key}`) }));
    }
  }
  add('launch-evidence-gaps', rules?.coverage?.decisionsWithoutLaunchEvidence ?? null, null, 'review', 'globalRules.coverage');
  if (rules?.coverage?.decisionsWithoutLaunchEvidence > 0) unknown.add('launch-evidence');
  const acks = rules?.acknowledgements;
  add('rules-acks', Array.isArray(acks) ? `${acks.filter(a => a.current).length}/${acks.length} current` : null, null, 'review', 'globalRules.acknowledgements');
  for (const a of acks ?? []) {
    if (a.current === true) continue;
    const firstSeen = a.staleSince ?? (finite(a.at) ? Math.max(a.at, review.digestChangedAt ?? a.at) : null);
    add(`stale-rules/${a.session ?? a.orchestrator}`, a.current === false && finite(firstSeen) ? (now - firstSeen) / 3600000 : null,
      config.staleRulesHoursMax, 'review', 'globalRules.acknowledgements', { owner: a.session, project: a.project, comparison: 'above', unknownClass: 'rules-acks' });
  }
  if (!Array.isArray(review?.workerInbox)) add('inbox-p90', null, config.inboxP90MinutesMax, 'review', 'workerInbox');
  for (const i of review?.workerInbox ?? []) {
    add(`inbox-p90/${i.owner}`, finite(i.finishToAckMs?.p90) ? i.finishToAckMs.p90 / 60000 : i.acknowledged === 0 && i.totalUnacknowledged === 0 ? 0 : null,
      config.inboxP90MinutesMax, 'review', 'workerInbox', { owner: i.owner, comparison: 'above', unknownClass: 'inbox-latency' });
    add(`inbox-pending/${i.owner}`, `${i.unacknowledged}/${i.totalUnacknowledged} pending; ${i.launchesWithoutIdentity} identity gaps; ${i.latencyUnknown} latency gaps`, null, 'review', 'workerInbox', { owner: i.owner });
    if (i.latencyUnknown > 0 || i.launchesWithoutIdentity > 0 || i.ownerStatus === 'UNKNOWN') unknown.add('inbox-identity');
  }
  const coverage = review?.outcomes?.autoCoverage ?? review?.outcomes?.coverage;
  add('auto-outcomes', coverage?.unknownTerminalIdentity > 0 ? null : coverage?.completed > 0 && finite(coverage.autoCompleted) ? coverage.autoCompleted / coverage.completed * 100 : coverage?.completed === 0 ? 100 : null,
    config.autoOutcomeCoveragePctMin, 'review', 'outcomes.autoCoverage', { comparison: 'below' });
  if (coverage?.unknownTerminalIdentity > 0) unknown.add('outcome-identity');
  for (const [vendor, o] of entries(review?.outcomes?.byVendor))
    add(`outcomes/${vendor}`, `${o.firstPass} first pass; ${o.rework} code rework; ${o.nonCodeRework} other rework; ${o.fail} fail; ${o.meanRounds ?? 'UNKNOWN'} mean rounds`, null, 'review', `outcomes.byVendor.${vendor}`);
  const u = resources?.utilisation ?? review?.utilisation;
  for (const [id, value, field] of [
    ['resource-cpu-idle-pct', u?.cpu?.meanIdlePct, 'cpu.meanIdlePct'],
    ['resource-idle-ready-hours', u?.cpu?.hoursIdleAbove50WithReadyTasks, 'cpu.hoursIdleAbove50WithReadyTasks'],
    ['resource-memory-mean-gib', u?.memory?.meanAvailableGiB, 'memory.meanAvailableGiB'],
    ['resource-memory-min-gib', u?.memory?.minAvailableGiB, 'memory.minAvailableGiB'],
    ['resource-pressure-hours', u?.memory?.pressureHours, 'memory.pressureHours'],
    ['resource-lane-occupancy-pct', u?.heavyLanes?.occupancyPct, 'heavyLanes.occupancyPct'],
    ['resource-queue-hours', u?.queue?.hours, 'queue.hours'],
    ['ttadk-unused-reset-tokens', u?.quota?.ttadk?.tokensUnusedAtReset, 'quota.ttadk.tokensUnusedAtReset']])
    add(id, value ?? null, null, 'resources', `utilisation.${field}`);
  for (const [model, value] of entries(u?.quota?.trae?.highPriorityUnitsUnusedAtResetByModel))
    add(`trae-unused-reset-units/${model}`, value, null, 'resources', 'utilisation.quota.trae', { unknownClass: 'trae-unused-reset-units' });
  add('resource-over-gate-hours', u?.cpu?.hoursOverGate ?? null, config.overGateHoursMax, 'resources', 'utilisation.cpu.hoursOverGate', { comparison: 'above' });
  add('resource-coverage-pct', resources?.coverage?.coveragePct ?? null, config.resourceCoveragePctMin, 'resources', 'coverage', { comparison: 'below' });
  for (const [field, value] of entries(resources?.coverage).filter(([k]) => /Minutes$/.test(k))) add(`coverage/${field}`, value, null, 'resources', `coverage.${field}`);
  const accounts = review?.companyHealth;
  if (!Array.isArray(accounts) || !accounts.length) unknown.add('company-expiry');
  for (const a of accounts ?? []) {
    add(`sso-expiry-hours/${a.name}`, finite(a.ssoExpiresAt) ? (a.ssoExpiresAt - now) / 3600000 : null, config.expiryWarningHours, 'review', 'companyHealth', { comparison: 'at-or-below', unknownClass: 'company-sso-expiry' });
    // Daily reset is routine replenishment. Only nonrenewing quota entitlement expiry is actionable.
    add(`quota-expiry-hours/${a.name}`, finite(a.quotaExpiresAt) ? (a.quotaExpiresAt - now) / 3600000 : null, config.expiryWarningHours, 'review', 'companyHealth', { comparison: 'at-or-below', unknownClass: 'company-quota-expiry' });
  }
  if (review?.quota?.traeReconciliation?.status === 'UNKNOWN') unknown.add('trae-cost-reconciliation');
  if (Array.isArray(review?.overdueQuestions)) add('overdue-questions', review.overdueQuestions.length, config.overdueQuestionsMax, 'review', 'overdueQuestions', {comparison: 'above'});
  if (review?.catalog) add('catalog-changes', (review.catalog.codexAdded?.length ?? 0) + (review.catalog.codexRemoved?.length ?? 0), config.catalogChangesMax, 'review', 'catalog', {comparison: 'above'});
  if (usage === null) unknown.add('orchestrator-usage');
  if (usage) {
    if (!Array.isArray(usage.orchestrators)) unknown.add('orchestrator-usage');
    for (const o of usage.orchestrators ?? []) for (const [key, limit] of entries(config.orchestratorUsage))
      add(`usage-${key}/${o.name}`, finite(o[key]) ? o[key] : null, limit, 'usage', 'orchestrators', {owner: o.id, comparison: 'above', unknownClass: 'orchestrator-usage'});
  }
  const newUnknownClasses = [...unknown].filter(c => !previousUnknownClasses.includes(c)).sort();
  add('new-unknown-classes', newUnknownClasses.length, config.newUnknownClassesMax, 'review', 'UNKNOWN', { comparison: 'above' });
  if (findings.at(-1)?.id === 'new-unknown-classes') {
    const finding = findings.at(-1);
    finding.classes = newUnknownClasses;
    finding.evidence = [...new Set(metrics.filter(m => m.status === 'UNKNOWN').flatMap(m => m.evidence)
      .concat([pointer('review', 'reviews'), pointer('review', 'workerInbox'), pointer('review', 'globalRules.coverage')]))];
  }
  const weekly = new Date(`${day}T12:00:00`).getDay() === config.weeklyDay;
  if (weekly) findings.push({ id: 'weekly-full-review', class: 'weekly', value: day, evidence: Object.values(evidence) });
  return { schema: 1, day, collectedAt: now, metrics, findings, unknownClasses: [...unknown].sort(), newUnknownClasses, weekly, needsModel: findings.length > 0 };
}

export function metricTable(result) {
  const lines = ['| Metric | Value | Threshold | Status |', '|---|---|---|---|'];
  const ordered = [...result.metrics].sort((a, b) => (a.status === 'FINDING' ? 0 : a.status === 'UNKNOWN' ? 1 : 2) - (b.status === 'FINDING' ? 0 : b.status === 'UNKNOWN' ? 1 : 2));
  for (const r of ordered.slice(0, 37)) lines.push(`| ${esc(r.id)} | ${esc(round(r.value) ?? r.value)} | ${esc(r.comparison === 'observe' ? 'observe' : `${r.comparison} ${r.threshold}`)} | ${r.status} |`);
  if (ordered.length > 37) lines.push(`| Additional metrics | ${ordered.length - 37}; see metrics.json | observe | recorded |`);
  return lines.join('\n');
}

export function nightlyBrief(result, attemptDir) {
  return `Nightly review ${result.day}. Analyze only the following triggered findings and their evidence paths. Explain causes and propose concrete owner actions. Missing evidence remains UNKNOWN. No source edits, commits, push, policy changes, cleanup, logins, messaging or delegation. Write a concise analysis to ${attemptDir}/report.md and ${attemptDir}/notify.json as {"actions":[{"orchestrator":"<exact name or owner>","findingIds":["<id>"],"text":"<action>"}],"decisions":[{"id":"<id>","question":"<Chinese question>","options":[{"label":"<label>","description":"<effect>"}],"recommended":0,"default":"不回答则保持现状"}]}. Weekly actions also require project and evidence fields identifying only that recipient's project and one of the weekly evidence paths. Decisions require 2–4 options, recommendation, and an explicit default. No action is authorized by a proposal.\n${JSON.stringify(result.findings, null, 2)}\n`;
}

export function nightlyReport(result, analysis = '') {
  return `# Nightly routing review — ${result.day}\n\n## Summary\n\n${result.findings.length} findings; model ${result.needsModel ? 'requested' : 'skipped'}. Full numbers and evidence pointers: ${result.day}.metrics.json.\n\n## Metrics\n\n${metricTable(result)}\n\n## Findings\n\n${result.findings.length ? result.findings.map(f => `- ${f.id}: ${esc(f.value)}; evidence ${f.evidence.join(', ')}`).join('\n') : 'None.'}${analysis ? `\n\n## Model analysis\n\n${analysis.trim()}` : ''}\n`;
}
