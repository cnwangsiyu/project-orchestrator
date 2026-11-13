import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const rulesShared = () => process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared');
export const rulesLog = () => process.env.ROUTE_LOG_FILE || path.join(rulesShared(), 'route-log.jsonl');
export const loadDigest = () => {
  const text = fs.readFileSync(process.env.RULES_DIGEST || path.join(SKILL_ROOT, 'references/global-rules.md'), 'utf8').trim();
  const version = text.match(/^version: (\d{4}-\d{2}-\d{2}\.\d+)$/m)?.[1];
  const worker = text.split(/^## Worker Rules\s*$/m)[1]?.split(/^## /m)[0]?.trim();
  if (!version || !worker) throw Error('global rules digest is missing version/worker rules');
  return { text, version, worker };
};
export const readRecords = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; } catch { return []; }
  }); } catch { return []; }
};
export const isRouteDecision = (row) => row && (!row.kind || row.kind === 'route') && typeof row.category === 'string';
export const nameMatches = (name, row) => typeof name === 'string' && typeof row.name === 'string'
  && [row.name, row.project && `${row.project}-${row.name}`].filter(Boolean)
    .some((base) => name === base || name.startsWith(`${base}-`));
export const findDecision = (records, name, time = Date.now()) => records.filter((row) => isRouteDecision(row)
  && Number.isFinite(row.t) && row.t <= time && row.t >= time - 86400000 && nameMatches(name, row))
  .sort((a, b) => b.t - a.t)[0] ?? null;
export const auditLaunch = ({ name, account, model, vendor = 'codex', userOK, time = Date.now(), log = rulesLog() }) => {
  const decision = findDecision(readRecords(log), name, time);
  const base = { name: name ?? null, account: account ?? null, model: model ?? null, vendor, t: time,
    project: decision?.project ?? null, routeAt: decision?.t ?? null };
  if (!decision) process.stderr.write(`unrouted-launch: ${name ?? '(unnamed)'} ${account ?? '?'} ${model ?? '?'}; route it first\n`);
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const rows = [...(!decision ? [{ kind: 'unrouted', ...base }] : []),
      { kind: 'launch', ...base, userOK: typeof userOK === 'string' ? userOK : null }];
    fs.appendFileSync(log, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  } catch { process.stderr.write('launch-audit: route log unavailable; launch evidence not recorded\n'); }
  return decision;
};
