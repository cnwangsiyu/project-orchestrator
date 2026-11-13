import fs from 'node:fs';
import path from 'node:path';
import { findDecision, isRouteDecision, nameMatches } from './global-rules.mjs';

export const auditGlobalRules = ({ records, version, since, profiles = {}, ledgerRoot }) => {
  const recent = records.filter((row) => row.t >= since && row.t <= Date.now());
  const launches = recent.filter((row) => row.kind === 'launch');
  const unrouted = recent.filter((row) => row.kind === 'unrouted');
  const personalQuotaWithoutOK = [], traeGPTOnSecurity = [];
  for (const launch of launches) {
    const route = Number.isFinite(launch.routeAt)
      ? records.find((row) => isRouteDecision(row) && row.t === launch.routeAt && nameMatches(launch.name, row))
      : findDecision(records, launch.name, launch.t);
    if (!route) continue;
    const recordedOK = launch.userOK || route.personalApproved || route.approvalRef || records.some((row) =>
      row.kind === 'approval' && row.userOK === true && row.t <= launch.t && row.t >= route.t && nameMatches(launch.name, row));
    const needsPersonal = (route.needsOK ?? []).some((line) => /^personal quota:/i.test(line));
    const company = launch.vendor !== 'claude' && (['ttadk', 'trae'].includes(launch.account)
      || ['ttadk', 'trae'].includes(profiles[launch.account]?.kind));
    if (needsPersonal && !company && !recordedOK) personalQuotaWithoutOK.push({ ...launch, needsOK: route.needsOK });
    if (route.security && (launch.account === 'trae' || profiles[launch.account]?.kind === 'trae')
      && /^gpt[- ]/i.test(launch.model ?? '')) traeGPTOnSecurity.push({ ...launch, decisionModel: route.pick?.model });
  }
  const acknowledgements = [];
  try { for (const entry of fs.readdirSync(ledgerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_shared') continue;
    const file = path.join(ledgerRoot, entry.name, 'ledger.md');
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const orchestrator = text.match(/^\s*(?:\*\*)?Orchestrator session:\s*(?:\*\*)?\s*(.+)$/mi)?.[1]?.trim() ?? entry.name;
    const ack = [...text.matchAll(/\brules-ack\s+(\d{4}-\d{2}-\d{2}\.\d+)\b/g)].at(-1)?.[1] ?? null;
    acknowledgements.push({ project: entry.name, orchestrator, version: ack, current: ack === version, ledger: file });
  } } catch {}
  const byOrchestrator = {};
  const add = (row, violation) => {
    const owner = acknowledgements.find((ack) => ack.project === row.project
      || (!row.project && typeof row.name === 'string' && row.name.startsWith(`${ack.project}-`)))?.orchestrator
      ?? row.project ?? '(unknown owner)';
    (byOrchestrator[owner] ??= []).push({ violation, name: row.name ?? null, account: row.account ?? null, model: row.model ?? null });
  };
  for (const row of unrouted) add(row, 'unrouted launch');
  for (const row of personalQuotaWithoutOK) add(row, 'personal quota without recorded user OK');
  for (const row of traeGPTOnSecurity) add(row, 'TRAE GPT launched on a security decision');
  for (const row of acknowledgements.filter((ack) => !ack.current)) add(row, `rules-ack ${row.version ?? 'missing'} != ${version}`);
  return { version, unrouted, personalQuotaWithoutOK, traeGPTOnSecurity, acknowledgements, byOrchestrator,
    coverage: { launches: launches.length, decisionsWithoutLaunchEvidence: recent.filter((row) => isRouteDecision(row)
      && !launches.some((launch) => launch.routeAt === row.t)).length,
    note: 'Legacy decisions without launch records are unknown, not proven violations; approval references record user decisions, not automatic authorization.' },
    orchUsage: { script: 'scripts/orch-usage.mjs', hours: (Date.now() - since) / 3600000,
      flags: ['edits source files itself', 'runs tests/builds itself', 'blocking', 'sleep polls'],
      instruction: 'Read the nightly launcher orch-usage data flags/blockedMinutes alongside these per-orchestrator violations.' } };
};
