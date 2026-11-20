import fs from 'node:fs';
import { fixedWorkerInstructions } from './fixed-worker-notes.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { modelId, company } from './pipeline/common.mjs';
import { modelFamily } from './worker-model.mjs';
import { assertExclusiveNewThread } from './personal-launch-admission.mjs';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const rulesShared = () => process.env.RULES_SHARED || path.join(process.env.ORCH_ROOT || path.join(os.homedir(), '.claude/orchestrator'), '_shared');
export const rulesLog = () => process.env.ROUTE_LOG_FILE || path.join(rulesShared(), 'route-log.jsonl');
export const parseDigest = (source) => {
  const text = source.trim();
  const version = text.match(/^version: (\d{4}-\d{2}-\d{2}\.\d+)$/m)?.[1];
  const worker = text.split(/^## Worker Rules\s*$/m)[1]?.split(/^## /m)[0]?.trim();
  if (!version || !worker) throw Error('global rules digest is missing version/worker rules');
  return { text, version, coreWorker:worker, worker: `${worker}\n${fixedWorkerInstructions()}` };
};
export const digestFile = () => path.resolve(process.env.RULES_DIGEST || path.join(SKILL_ROOT, 'references/global-rules.md'));
export const loadDigest = () => parseDigest(fs.readFileSync(digestFile(), 'utf8'));
export const workerInstructions = (digest = loadDigest(), { project } = {}) => {
  const profiles = JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'references/project-risk-profiles.json'), 'utf8'));
  const worker = profiles[project]?.workerLanding === 'ff-main'
    ? `${digest.coreWorker}\n${fixedWorkerInstructions(profiles[project])}` : digest.worker;
  return `Global worker rules ${digest.version}\n${worker}`;
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
export const findDecision = (records, name, time = Date.now(), project) => records.filter((row) => isRouteDecision(row)
  && (project===undefined||row.project===project)
  && Number.isFinite(row.t) && row.t <= time && row.t >= time - 86400000 && nameMatches(name, row))
  .sort((a, b) => b.t - a.t)[0] ?? null;
export const routedSeat = (decision, name, role='primary') => {
  const second=role==='second'||[decision?.name,decision?.project&&`${decision.project}-${decision.name}`].filter(Boolean).some(base=>name===`${base}-second`);
  return second?decision?.second:decision?.pick;
};
export const companyAccount = (account, profiles={}) => ['ttadk','trae'].includes(account)||company(profiles[account]);
export function compareLaunch(expected, actual, profiles={}) {
  if(!expected) return null;
  const differences=[];
  for(const field of ['account','model','effort','sandbox']) {
    if(expected[field]==null||actual[field]==null) continue;
    const value=x=>field==='model'?modelId(x):x;
    if(value(expected[field])!==value(actual[field])) differences.push({field,routed:expected[field],actual:actual[field]});
  }
  const sameCompany=expected.company===true&&expected.account===actual.account&&profiles[actual.account]===undefined;
  const personal=actual.vendor==='claude'||actual.account!=null&&!sameCompany&&!companyAccount(actual.account,profiles);
  const companyToPersonal=(expected.company===true||companyAccount(expected.account,profiles))&&personal;
  if(companyToPersonal&&!differences.some(d=>d.field==='account')) differences.push({field:'account',routed:expected.account,actual:actual.account});
  const levels=['read-only','workspace-write','danger-full-access'];
  const family=m=>['haiku','sonnet','opus','fable'].includes(modelId(m))?'claude':modelFamily(m);
  return differences.length?{differences,companyToPersonal,
    modelFamilyChanged:!!expected.model&&!!actual.model&&family(expected.model)!==family(actual.model),
    widerSandbox:levels.includes(actual.sandbox)&&levels.includes(expected.sandbox)&&levels.indexOf(actual.sandbox)>levels.indexOf(expected.sandbox)}:null;
}
// `continuation` (a thread id) marks a further turn on an already launched thread: it is recorded as a launch but is not a new,
// unrouted launch (its routing was decided when the thread started).
export const auditLaunch = ({ name, project, account, model, effort, vendor = 'codex', sandbox, userOK, role='primary', seat, continuation, time = Date.now(), log = rulesLog() }) => {
  let profiles={};try { profiles=JSON.parse(fs.readFileSync(process.env.CODEX_ACCOUNTS||path.join(rulesShared(),'codex-accounts.json'),'utf8'))??{}; } catch {}
  const decision = findDecision(readRecords(log), name, time, project);
  const supplied=seat&&seat.name===name&&(project===undefined||seat.project===project)?seat:null;
  const recorded=routedSeat(decision,name,role);
  const expected=recorded?{...recorded,sandbox:recorded.sandbox??supplied?.sandbox,
    company:recorded.company??(decision.company===recorded.account||supplied?.account===recorded.account&&supplied?.company===true)}:supplied;
  const approvalRef=decision?decision.approvalRef:supplied?.approvalRef;
  const base = { auditId:randomUUID(),name: name ?? null, account: account ?? null, model: model ?? null, effort:effort??null,vendor, t: time,
    sandbox: sandbox ?? null, project: project??decision?.project??supplied?.project??null, routeAt: decision?.t ?? null,
    routeId:decision?.routeId??supplied?.routeId??null,role,userOK:typeof userOK==='string'?userOK:typeof approvalRef==='string'?approvalRef:null,
    routeApprovalRef:typeof approvalRef==='string'?approvalRef:null,routed:expected??null };
  const mismatch=compareLaunch(expected,base,profiles);
  let admissionError;
  try { assertExclusiveNewThread({ account: account ?? 'main', vendor, continuation, profiles, shared: rulesShared(), name }); }
  catch (error) { admissionError = error; }
  const blocked=!!admissionError||!!mismatch?.companyToPersonal&&!(typeof approvalRef==='string'&&approvalRef.trim());
  if(mismatch) process.stderr.write(`launch-mismatch: ${name??'(unnamed)'} ${mismatch.differences.map(d=>`${d.field} ${d.routed} -> ${d.actual}`).join('; ')}${blocked?'; re-route or pass the approval recorded on the route decision':''}\n`);
  if (!expected && !continuation) process.stderr.write(`unrouted-launch: ${name ?? '(unnamed)'} ${account ?? '?'} ${model ?? '?'}; route it first\n`);
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const rows = [...(!expected && !continuation ? [{ kind: 'unrouted', ...base }] : []),
      ...(mismatch?[{kind:'launch-mismatch',...base,...mismatch,blocked}]:[]),{ kind: 'launch', ...base,blocked,
        ...(admissionError ? { admissionReason: admissionError.code } : {}), ...(continuation?{continuation}:{}) }];
    fs.appendFileSync(log, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  } catch { process.stderr.write('launch-audit: route log unavailable; launch evidence not recorded\n'); }
  if(admissionError) throw admissionError;
  if(blocked) throw Object.assign(Error('Personal account replaces a company route without a recorded --user-ok reference; re-route or pass the approval recorded on the route decision.'),{code:'PERSONAL_ROUTE_APPROVAL_REQUIRED',exitCode:1});
  return decision??(supplied?{project:supplied.project,category:supplied.category,pick:supplied}:null);
};
