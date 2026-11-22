import { scopedFlags } from '../route-args.mjs';
import { transportOutcome } from '../worker-completion.mjs';
import { environmentOutcome } from '../worker-result.mjs';
import {REVIEW_CLASSES,projectReviewPolicy} from '../review-policy-data.mjs';
import { VERSION, array, object, idOK, modelSelector, modelId, unique, clone, freeze, fingerprint, isReview, compare, stable } from './common.mjs';

export const CATEGORIES = Object.freeze(['lookup', 'extract', 'analysis', 'research', 'implement', 'implement-hard', 'ui-browser',
  'debug', 'review', 'review-high', 'design', 'docs', 'draft', 'build-run', 'browser', 'computer-use', 'claude-tools', 'science', 'image-gen', 'image-read', 'second-opinion']);
const BOOLEANS = new Set(['auto-check', 'writes', 'read-only', 'runs-tests', 'signing', 'fresh', 'json', 'verbose', 'table', 'no-redeem', 'dry',
  'urgent', 'security', 'adversarial', 'defensive', 'background', 'device-lease', 'shared-lock', 'no-local-build', 'worker', 'installed', 'no-browser-preflight', 'no-auto-continue']);
const VALUES = new Set(['stakes', 'failures', 'against', 'author', 'impact', 'env', 'exclude-account', 'exclude-model', 'origins', 'mode',
  'sandbox', 'cwd', 'task-dir', 'task', 'name', 'project', 'apps', 'user-ok', 'auto-reroute-depth', 'previous-attempt', 'execution', 'actual',
  'owner', 'failure-kind', 'trusted-cwd', 'exclude-lane', 'review-override', 'review-required', 'profile-override', 'artifact-ref', 'network', 'review-class', 'review-reason', 'review-scope', 'needs-cli']);
const CODE = new Set(['implement', 'implement-hard', 'debug', 'science']);
export class TaskInputError extends Error {
  constructor(code, message) { super(message); this.name = 'TaskInputError'; this.code = code; this.exitCode = 2; }
}
const fail = (code, text) => { throw new TaskInputError(code, text); };
const list = (x) => x === undefined ? [] : String(x).split(',').map((s) => s.trim());
const validText = (x) => typeof x === 'string' && x.length > 0 && !/[\u0000-\u001f\u007f]/.test(x);
const origins = (xs) => unique(xs.map((s) => {
  if (!validText(s) || /[?@#\\]/.test(s)) fail('INVALID_ORIGIN', 'Origins must contain only a host or HTTP(S) origin.');
  if (/^https?:\/\//i.test(s)) {
    let u; try { u = new URL(s); } catch { fail('INVALID_ORIGIN', 'Invalid origin.'); }
    if (u.pathname !== '/' || u.username || u.password || !u.hostname) fail('INVALID_ORIGIN', 'Origin paths and credentials are not allowed.');
    return u.origin;
  }
  if (!/^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/i.test(s) || s.includes('..')) fail('INVALID_ORIGIN', 'Invalid host.');
  return s.toLowerCase();
}));
export function parseTaskSpec(argv, context = {}) {
  if (!Array.isArray(argv) || argv.some((x) => !validText(x))) fail('INVALID_ARGV', 'Arguments must be nonempty strings without control characters.');
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith('-')) { pos.push(v); continue; }
    if (!v.startsWith('--') || v.includes('=')) fail('UNKNOWN_OPTION', `Unsupported option: ${v}`);
    const k = v.slice(2);
    if (!BOOLEANS.has(k) && !VALUES.has(k)) fail('UNKNOWN_OPTION', `Unknown option: ${v}`);
    if (Object.hasOwn(flags, k)) fail('REPEATED_OPTION', `Repeated option: ${v}`);
    if (BOOLEANS.has(k)) flags[k] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) fail('MISSING_OPTION_VALUE', `Missing value: ${v}`);
      flags[k] = argv[++i];
    }
  }
  if (flags.table) {
    if (pos.length || Object.keys(flags).some((k) => !['table', 'json'].includes(k))) fail('TABLE_CONFLICT', '--table is standalone.');
    return freeze({ schemaVersion: VERSION, kind: 'table', categories: [...CATEGORIES] });
  }
  if (pos.length !== 1 || !CATEGORIES.includes(pos[0])) fail('INVALID_CATEGORY', 'Exactly one known category is required.');
  return createTaskSpec({ ...context, category: pos[0], flags });
}
export function createTaskSpec(input) {
  if (!object(input) || !CATEGORIES.includes(input.category)) fail('INVALID_CATEGORY', 'Unknown task category.');
  const f = clone(input.flags ?? {}); let cat = input.category; const policyNotes=[];
  const reviewClass=f['review-class']??input.reviewClass??null,reviewReason=f['review-reason']??input.reviewReason??null;
  if(reviewClass!==null&&!REVIEW_CLASSES.includes(reviewClass)) fail('INVALID_REVIEW_CLASS','review-class takes A, B, C or D.');
  if(reviewClass&&(!validText(reviewReason)||!reviewReason.trim()))fail('REVIEW_REASON_REQUIRED','review-class needs --review-reason with its A–D basis.');
  if(f['review-required']&&!reviewClass)policyNotes.push('review-required does not establish mandatory review: provide review-class A–D and review-reason.');
  if(cat==='review-high'&&!reviewClass){cat='review';policyNotes.push('review-high without review-class A–D: using an ordinary optional review.');}
  for (const k of ['writes', 'runsTests', 'background', 'ownTestApp']) if (input[k] !== undefined && typeof input[k] !== 'boolean') fail('INVALID_TASK_SHAPE', `${k} must be boolean.`);
  if (input.requirements !== undefined && !object(input.requirements)) fail('INVALID_TASK_SHAPE', 'Requirements must be a record.');
  if (input.previousAttempts !== undefined && (!Array.isArray(input.previousAttempts) || input.previousAttempts.some((a) => !object(a)))) fail('INVALID_HISTORY', 'Previous attempts must be sanitized records.');
  if (input.floor !== undefined && (!object(input.floor) || !Array.isArray(input.floor.profileIds) || !Array.isArray(input.floor.previousAttemptIds))) fail('INVALID_FLOOR', 'Quality floor requires profile and attempt lists.');
  if (!object(f)) fail('INVALID_FLAGS', 'Flags must be a record.');
  for (const [k, v] of Object.entries(f)) {
    if ((!BOOLEANS.has(k) && !VALUES.has(k)) || (BOOLEANS.has(k) && typeof v !== 'boolean') || (VALUES.has(k) && !validText(String(v))))
      fail('INVALID_FLAGS', `Invalid flag: ${k}`);
  }
  if (f.name !== undefined && !idOK(f.name)) fail('INVALID_NAME','Name must be a public task ID without parent traversal.');
  if (f.task !== undefined && !idOK(f.task)) fail('INVALID_NAME','Task must be a public board task ID without parent traversal.');
  if (f.actual !== undefined && (typeof f.actual !== 'string' || f.actual.split(',').some(tuple=>
    !/^(codex|claude):([\w.-]+):(low|medium|high|xhigh|max)(?:@([\w.-]+))?$/.test(tuple))))
    fail('INVALID_ACTUAL','actual takes vendor:model:effort[@account] (comma-separated launch order).');
  const enumValue = (key, fallback, choices) => {
    const v = f[key] ?? input[key] ?? fallback;
    if (!choices.includes(v)) fail('INVALID_ENUM', key==='impact'?'impact takes service|throwaway|release; release is ONLY class A: an externally released version that cannot be rolled back within hours. Local data reads/writes are not release; irreversible data operations use --review-class C.':`Invalid ${key}.`);
    return v;
  };
  const integer = (key, field, max = Number.MAX_SAFE_INTEGER) => {
    const raw = f[key] ?? input[field] ?? 0;
    if (!/^(0|[1-9]\d*)$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) fail('INVALID_NUMBER', key==='impact'?'impact takes service|throwaway|release; release is ONLY class A: an externally released version that cannot be rolled back within hours. Local data reads/writes are not release; irreversible data operations use --review-class C.':`Invalid ${key}.`);
    return Number(raw);
  };
  const failureKind = enumValue('failure-kind', 'quality', ['tool', 'quality', 'infra']);
  const stakes = enumValue('stakes', 'normal', ['low', 'normal', 'high']);
  let impact = enumValue('impact', null, [null, 'release', 'service', 'throwaway']);
  const project=f.project??input.project??'UNKNOWN', profile=projectReviewPolicy(project,input.projectProfiles??{});
  if(impact==='release'&&reviewClass!=='A'){impact='service';policyNotes.push(profile.externalRelease?'impact release requires review-class A; treating as service.':'Project has no external release: treating impact release as service unless review-class A is given.');}
  const env = enumValue('env', 'prod', ['test', 'prod']);
  if(f.network!==undefined&&!['on','off'].includes(f.network)) fail('INVALID_ENUM','network takes on or off.');
  let failures = integer('failures', 'failures');
  const autoRerouteDepth = integer('auto-reroute-depth', 'autoRerouteDepth', 2);
  if (CODE.has(cat) && !impact) fail('IMPACT_REQUIRED', 'Code tasks require --impact service|throwaway|release. Release is ONLY class A: an externally released version that cannot be rolled back within hours, declared with --review-class A and --review-reason. Local data reads/writes are not release; real irreversible data operations use class C. Personal/family apps, internal demos, PPE/test environments, test packages and features only reading existing data are not release.');
  for (const k of ['author', 'against']) if (f[k] !== undefined && !['claude', 'codex'].includes(f[k])) fail('INVALID_ENUM', `Invalid ${k}.`);
  if (cat === 'second-opinion' && !f.against && !input.againstAttemptId) fail('AGAINST_REQUIRED', 'Second opinions require an against identity.');
  if (f.author && !['review', 'review-high'].includes(cat)) fail('AUTHOR_CATEGORY', 'Author is only valid for review.');
  if ((f.writes && f['read-only']) || (f.signing && f['read-only'])) fail('CONFLICTING_FLAGS', 'Conflicting read/write declarations.');
  if (reviewClass==='D'&&f.defensive)fail('CONFLICTING_CONTENT','Review class D is adversarial and cannot be defensive.');
  if (f.defensive && (!f.security || !isReview({ category: cat }) || f.adversarial)) fail('CONFLICTING_CONTENT', 'Defensive scope requires a security review without adversarial scope.');
  let execution = enumValue('execution', 'UNKNOWN', ['UNKNOWN', 'local-heavy', 'local-light', 'remote']);
  if (f['no-local-build']) {
    if (execution !== 'UNKNOWN' && execution !== 'remote') fail('EXECUTION_CONFLICT', 'no-local-build conflicts with local execution.');
    execution = 'remote';
  }
  if (execution === 'remote' && f['shared-lock']) fail('EXECUTION_CONFLICT', 'Remote work cannot acquire local shared locks.');
  const needsCli = unique(list(f['needs-cli']));
  if (needsCli.some(cli => !/^[a-z][a-z0-9-]*$/.test(cli))) fail('INVALID_CLI', 'needs-cli takes comma-separated CLI names, e.g. lark,bytedcli.');
  const sandbox = needsCli.length ? 'danger-full-access' : f.sandbox ?? input.sandbox ?? 'workspace-write', ceiling = input.sandboxCeiling ?? 'workspace-write';
  if(f.network==='off'&&sandbox==='danger-full-access') fail('INVALID_NETWORK_SANDBOX','Network off requires a read-only or workspace-write sandbox.');
  if (![sandbox, ceiling].every((s) => ['danger-full-access', 'workspace-write', 'read-only'].includes(s))) fail('INVALID_SANDBOX', 'Unsupported sandbox.');
  if (f.sandbox && !['workspace-write', 'read-only'].includes(f.sandbox)) fail('INVALID_SANDBOX', 'Explicit sandbox only narrows the default. For signed-in or network CLIs (bytedcli, lark-cli) add --needs-cli <names> instead: full-access sandbox, read-only by instruction.');
  if (ceiling === 'workspace-write' && sandbox === 'danger-full-access') fail('SANDBOX_CEILING', 'Requested sandbox exceeds parent ceiling.');
  if (ceiling === 'read-only' && sandbox !== 'read-only') fail('SANDBOX_CEILING', 'Requested sandbox exceeds parent ceiling.');
  const apps = unique(input.allowedApps ?? list(f.apps));
  if (apps.some((s) => !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(s))) fail('INVALID_APP', 'Apps must be bundle IDs.');
  if (f.apps && cat !== 'computer-use') fail('APPS_CATEGORY', 'Apps scope is for computer-use.');
  if (f.origins && !['browser', 'ui-browser'].includes(cat)) fail('ORIGINS_CATEGORY', 'Origins scope is for browser tasks.');
  const allowedOrigins = origins(input.allowedOrigins ?? list(f.origins));
  const priorTurns = clone(array(input.previousAttempts));
  const transportFailures = priorTurns.filter(a => transportOutcome(a) && a.taskId === (input.taskId ?? f.name)
    && (a.role ?? 'primary') === (input.role ?? 'primary'));
  const transportIds = new Set(transportFailures.map(a => a.thread && a.turn ? `${a.thread}:${a.turn}` : a.id));
  failures = Math.max(0, failures - transportIds.size);
  if (transportIds.size) f.failures = String(failures);
  const attempts = priorTurns.filter(a => !transportOutcome(a));
  const environmentFailures = attempts.filter(a => environmentOutcome(a) && a.taskId === (input.taskId ?? f.name)
    && (a.role ?? 'primary') === (input.role ?? 'primary')).sort((a,b) => compare(String(a.id),String(b.id)));
  const environmentIds = new Set(environmentFailures.map(a => a.thread && a.turn ? `${a.thread}:${a.turn}` : a.id));
  // Normalized specs retain these actual tuples as a floor. Only consume their
  // retry-count contribution when first normalizing the incoming history.
  const normalizedEnvironmentIds = new Set(array(input.environmentFailures).map(a => a.thread && a.turn ? `${a.thread}:${a.turn}` : a.id));
  failures = Math.max(0, failures - [...environmentIds].filter(id => !normalizedEnvironmentIds.has(id)).length);
  if (environmentIds.size) f.failures = String(failures);
  for (const a of attempts) if (object(a.actual)) {
    a.actual.modelId = modelId(a.actual.modelId ?? a.actual.model); delete a.actual.model;
  }
  const failedActualIds = new Set(attempts.filter((a) => a.taskId === (input.taskId ?? f.name) && (a.role ?? 'primary') === (input.role ?? 'primary')
    && a.state !== 'planned' && a.actualStatus === 'KNOWN' && a.actual && ['quality', 'spec', 'process'].includes(a.failureKind)).map((a) => a.id));
  failures = Math.max(failures, failedActualIds.size);
  const labels = new Set(array(input.contentLabels));
  for (const a of attempts) {
    for (const label of array(a?.contentLabels)) labels.add(label);
    if (a?.failureKind === 'policy-block') labels.add('policy-blocked');
  }
  if (f.security) labels.add('security');
  if (f.adversarial||reviewClass==='D') labels.add('adversarial');
  if (f.defensive) labels.add('defensive-confirmation');
  if (labels.has('adversarial') || labels.has('policy-blocked') || labels.has('attack-material')) { labels.add('adversarial'); labels.add('security'); labels.delete('defensive-confirmation'); }
  if (labels.has('security') && isReview({ category: cat }) && !labels.has('defensive-confirmation')) labels.add('adversarial');
  if (!labels.size) labels.add('ordinary');
  if ([...labels].some((x) => !['ordinary', 'security', 'attack-material', 'adversarial', 'defensive-confirmation', 'policy-blocked'].includes(x))) fail('INVALID_CONTENT', 'Unknown content label.');
  if (labels.size > 1) labels.delete('ordinary');
  const writes = f['read-only'] ? false : (f.writes ?? input.writes ?? ['implement', 'implement-hard', 'debug', 'science', 'docs', 'draft', 'ui-browser', 'build-run', 'computer-use', 'claude-tools', 'image-gen'].includes(cat));
  const background = f.background ?? input.background ?? false;
  const qualityFailures = failureKind === 'quality' ? failures : failedActualIds.size;
  const tier = ['implement-hard', 'debug', 'science', 'review-high', 'design'].includes(cat) || stakes === 'high' || (CODE.has(cat) && qualityFailures > 0) ? 'hard'
    : qualityFailures > 0 ? 'normal'
    : cat === 'build-run' && (env === 'prod' || impact === 'release') ? 'normal'
      : ['lookup', 'extract', 'draft'].includes(cat) || stakes === 'low' || background || (cat === 'build-run' && env === 'test') ? 'light' : 'normal';
  const caps = new Set(array(input.capabilitiesNeeded));
  for (const c of ({ research: ['search'], browser: ['browser', 'signed-in-browser', 'vision'], 'ui-browser': ['browser', 'vision'],
    'computer-use': ['desktop-tool', 'vision'], 'image-read': ['vision'], 'image-gen': ['image-generation'], 'claude-tools': ['claude-tools'] })[cat] ?? []) caps.add(c);
  const exclusions = [...clone(array(input.exclusions)), ...list(f['exclude-account']).map((value) => ({ scope: 'account', accountId: null, value, cause: 'explicit' })),
    ...list(f['exclude-model']).map((value) => ({ scope: ['gpt', 'deepseek', 'kimi', 'claude', 'seed', 'gemini'].includes(value.toLowerCase()) ? 'family' : 'model',
      accountId: null, value: modelSelector(value), companyOnly: true, cause: 'legacy-exclude-model' }))];
  for (const value of list(f['exclude-lane'])) {
    const [accountId, model, ...rest] = value.split(':');
    if (!idOK(accountId) || !idOK(model) || rest.length) fail('INVALID_EXCLUSION', '--exclude-lane takes account:model pairs.');
    exclusions.push({ scope: ['gpt', 'deepseek', 'kimi', 'claude', 'seed', 'gemini'].includes(model) ? 'family' : 'account-model', accountId, value: modelSelector(model), cause: 'infrastructure' });
  }
  for (const e of exclusions) if (!object(e) || !['account', 'account-model', 'model', 'family'].includes(e.scope) || !idOK(e.value)) fail('INVALID_EXCLUSION', 'Invalid exclusion scope.');
  const taskId = input.taskId ?? f.name, requestId = input.requestId;
  if (!idOK(taskId) || !idOK(requestId)) fail('TASK_ID_REQUIRED', 'Inject stable taskId and requestId before planning.');
  const task = { schemaVersion: VERSION, taskId, requestId, project: f.project ?? input.project ?? 'UNKNOWN', owner: f.owner ?? input.owner ?? 'UNKNOWN', category: cat,
    role: input.role ?? 'primary', parentTaskId: input.parentTaskId ?? null, briefHash: input.briefHash ?? 'UNKNOWN', flags: f,
    reviewClass,reviewReason,reviewScope:f['review-scope']??input.reviewScope??null,policyNotes:unique([...array(input.policyNotes),...policyNotes]), tier, stakes, impact, env, execution, writes, runsTests: f['runs-tests'] ?? input.runsTests ?? false, background,
    contentLabels: unique([...labels]), capabilitiesNeeded: unique([...caps]), exclusions: unique(exclusions.map(stable)).map(JSON.parse),
    failures, failureKind, qualityFailures, environmentFailures, transportFailures: transportFailures.length ? transportFailures : clone(array(input.transportFailures)),
    previousAttempts: attempts.sort((a, b) => compare(String(a?.id), String(b?.id))),
    floor: clone(input.floor ?? { profileIds: [], previousAttemptIds: [], relationVersion: VERSION, historyStatus: failures || autoRerouteDepth || f['previous-attempt'] ? 'UNKNOWN' : 'KNOWN' }),
    authorAttemptId: input.authorAttemptId ?? null, againstAttemptId: input.againstAttemptId ?? null,
    cwd: f.cwd ?? input.cwd ?? '.', taskDir: f['task-dir'] ?? input.taskDir ?? '.', sandbox, sandboxCeiling: ceiling,
    needsCli, readOnlyByInstruction: needsCli.length > 0 && !writes,
    allowedOrigins, allowedApps: apps, deviceId: input.deviceId ?? null, ownTestApp: input.ownTestApp === true,
    signingManifestRef: input.signingManifestRef ?? null, approvalRefs: unique([...array(input.approvalRefs), ...list(f['user-ok'])]),
    autoRerouteDepth, notifyBy: input.notifyBy ?? null, timezone: input.timezone ?? 'America/Los_Angeles',
    ...(input.queueOwnerChoice ? {queueOwnerChoice:clone(input.queueOwnerChoice)} : {}),
    artifactRevision: f['artifact-ref'] ?? input.artifactRevision ?? null, requirements: clone({...input.requirements,...(f.installed?{installedOnMachine:true}:{})}), selectionCause: input.selectionCause ?? (attempts.length ? 'infra-reroute' : 'initial'),
    qualityEscalation: clone(input.qualityEscalation ?? null), warnings: f.mode ? ['MODE_DEPRECATED'] : [] };
  if (f['previous-attempt'] && !attempts.length && !task.transportFailures.length) task.floor.previousAttemptIds = unique([...task.floor.previousAttemptIds, f['previous-attempt']]);
  if (!['primary', 'second', 'followup', 'finisher'].includes(task.role)) fail('INVALID_ROLE', 'Unknown task role.');
  // Derive from constraints, never accept a caller-supplied hash as authority.
  const { requestId: ignored, previousAttempts: prior, approvalRefs: refs, warnings, ...constraints } = task;
  constraints.flags = scopedFlags(constraints.flags);
  task.constraintHash = fingerprint(constraints);
  return freeze(task);
}
export function deriveReview(task, { role = 'second', authorAttemptId = null, artifactRevision = task.artifactRevision } = {}) {
  const flags = { ...task.flags, 'read-only': true };
  for (const k of ['writes', 'signing', 'runs-tests', 'author', 'against', 'apps', 'origins', 'failures', 'previous-attempt', 'actual', 'auto-reroute-depth', 'failure-kind', 'no-browser-preflight']) delete flags[k];
  return createTaskSpec({ ...task, category: task.category==='review-high'||['A','D'].includes(task.reviewClass)?'review-high':'review', flags, role, writes: false, runsTests: false,
    previousAttempts: [], failures: 0, autoRerouteDepth: 0, floor: { profileIds: [], previousAttemptIds: [], relationVersion: task.floor.relationVersion, historyStatus: 'KNOWN' },
    authorAttemptId, againstAttemptId: null, artifactRevision, selectionCause: 'initial', qualityEscalation: null });
}
