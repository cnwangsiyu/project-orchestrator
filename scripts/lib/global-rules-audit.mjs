import fs from 'node:fs';
import path from 'node:path';
import { findDecision, isRouteDecision, nameMatches, routedSeat, compareLaunch } from './global-rules.mjs';

export const auditGlobalRules = ({ records, version, since, profiles = {}, ledgerRoot }) => {
  const recent = records.filter((row) => row.t >= since && row.t <= Date.now());
  const launches = recent.filter((row) => row.kind === 'launch');
  const attributions = records.filter(row => row.kind === 'launch-attribution');
  const unrouted = recent.filter((row) => row.kind === 'unrouted').map(row => {
    const attribution = attributions.findLast(a => a.name === row.name &&
      (a.auditId ? a.auditId === row.auditId : a.launchAt === row.t));
    return attribution ? { ...row, attributedOwner: attribution.owner, attributionNote: attribution.note } : row;
  });
  const launchMismatches=recent.filter(row=>row.kind==='launch-mismatch');
  const personalQuotaWithoutOK = [], traeGPTOnSecurity = [];
  for (const launch of launches) {
    const route = Number.isFinite(launch.routeAt)
      ? records.find((row) => isRouteDecision(row) && row.t === launch.routeAt && nameMatches(launch.name, row)&&(!launch.project||row.project===launch.project))
      : findDecision(records, launch.name, launch.t,launch.project??undefined);
    const mismatch=compareLaunch(launch.routed??routedSeat(route,launch.name,launch.role),launch,profiles);
    if(mismatch&&!launchMismatches.some(r=>r.auditId?r.auditId===launch.auditId:r.t===launch.t&&r.name===launch.name))
      launchMismatches.push({...launch,kind:'launch-mismatch',...mismatch});
    if (!route&&!launch.routed) continue;
    const replacementOK=route?.approvalRef??launch.routeApprovalRef;
    const recordedOK = mismatch?.companyToPersonal?replacementOK:launch.userOK || route?.personalApproved || route?.approvalRef || records.some((row) =>
      row.kind === 'approval' && row.userOK === true && row.t <= launch.t && row.t >= route?.t && nameMatches(launch.name, row));
    const needsPersonal = mismatch?.companyToPersonal||(route?.needsOK ?? []).some((line) => /^personal quota:/i.test(line));
    const company = launch.vendor !== 'claude' && (['ttadk', 'trae'].includes(launch.account)
      || ['ttadk', 'trae'].includes(profiles[launch.account]?.kind));
    if (needsPersonal && !company && !recordedOK) personalQuotaWithoutOK.push({ ...launch, needsOK: route?.needsOK });
    if (route?.security && (launch.account === 'trae' || profiles[launch.account]?.kind === 'trae')
      && /^gpt[- ]/i.test(launch.model ?? '')) traeGPTOnSecurity.push({ ...launch, decisionModel: route.pick?.model });
  }
  const acknowledgements = [];
  try { for (const entry of fs.readdirSync(ledgerRoot, { withFileTypes: true })) {
    if (entry.name === '_shared' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    if (entry.isSymbolicLink()) {
      try { if (!fs.statSync(path.join(ledgerRoot, entry.name)).isDirectory()) continue; }
      catch { acknowledgements.push({ project: entry.name, orchestrator: entry.name, version: null, current: null,
        status: 'UNKNOWN', ledger: path.join(ledgerRoot, entry.name, 'ledger.md') }); continue; }
    }
    const file = path.join(ledgerRoot, entry.name, 'ledger.md');
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch {
      acknowledgements.push({ project: entry.name, orchestrator: entry.name, version: null, current: null,
        status: 'UNKNOWN', ledger: file }); continue;
    }
    const plain = text.replaceAll('**', '').replaceAll('`', '');
    const orchestrator = plain.match(/^\s*(?:[-*+]\s+)?(?:\*\*)?Orchestrator session:\s*(?:\*\*)?\s*(.+)$/mi)?.[1]?.trim().replace(/^"|"$/g, '') ?? entry.name;
    const ack = [...plain.matchAll(/\brules-ack(?:\*\*)?\s*:?[ \t]*(?:`)?(\d{4}-\d{2}-\d{2}\.\d+)\b/g)].at(-1)?.[1] ?? null;
    acknowledgements.push({ project: entry.name, orchestrator, version: ack, current: ack === version, status: 'KNOWN', ledger: file });
  } } catch { acknowledgements.push({ project: '(ledger root)', orchestrator: '(unknown owner)', version: null,
    current: null, status: 'UNKNOWN', ledger: ledgerRoot }); }
  const byOrchestrator = {};
  const add = (row, violation) => {
    const owner = row.attributedOwner ?? acknowledgements.find((ack) => ack.project === row.project
      || (!row.project && typeof row.name === 'string' && row.name.startsWith(`${ack.project}-`)))?.orchestrator
      ?? row.project ?? '(unknown owner)';
    (byOrchestrator[owner] ??= []).push({ violation, name: row.name ?? null, account: row.account ?? null, model: row.model ?? null });
  };
  for (const row of unrouted) add(row, 'unrouted launch');
  for (const row of personalQuotaWithoutOK) add(row, 'personal quota without recorded user OK');
  for (const row of traeGPTOnSecurity) add(row, 'TRAE GPT launched on a security decision');
  for (const row of launchMismatches) add(row,`launch mismatch: ${row.differences.map(d=>d.field).join(', ')}${row.blocked?' (blocked; missing recorded personal approval)':''}`);
  for (const row of acknowledgements.filter((ack) => ack.current === false)) add(row, `rules-ack ${row.version ?? 'missing'} != ${version}`);
  for (const row of acknowledgements.filter(ack => ack.status === 'UNKNOWN')) add(row, 'rules-ack UNKNOWN: ledger unreadable');
  return { version, unrouted, personalQuotaWithoutOK, traeGPTOnSecurity, launchMismatches, acknowledgements, byOrchestrator,
    coverage: { launches: launches.length, decisionsWithoutLaunchEvidence: recent.filter((row) => isRouteDecision(row)
      && !launches.some((launch) => launch.routeAt === row.t)).length,
    note: 'Legacy decisions without launch records are unknown, not proven violations; approval references record user decisions, not automatic authorization.' },
    orchUsage: { script: 'scripts/orch-usage.mjs', hours: (Date.now() - since) / 3600000,
      flags: ['edits source files itself', 'runs tests/builds itself', 'blocking', 'sleep polls'],
      instruction: 'Read the nightly launcher orch-usage data flags/blockedMinutes alongside these per-orchestrator violations.' } };
};
