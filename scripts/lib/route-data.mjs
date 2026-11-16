// Effectful acquisition boundary: refresh account status through authenticated
// read-only interfaces, then pass immutable observations to the pure pipeline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTaskSpec } from './pipeline/taskspec.mjs';
import { createSnapshot } from './pipeline/snapshot.mjs';
import { modelId, familyOf, object, array, nonnegative, VERSION } from './pipeline/common.mjs';
import { dedupeOutcomes } from './pipeline/outcomes.mjs';
import { personalBudget } from './pipeline/quota.mjs';
import { modelLoad } from './company-load.mjs';
import { isQueueOrStall } from './trae-health.mjs';
import { readRoutingAccount, readRoutingClaude, traeBrowserReady } from './state.mjs';
import { routePure } from './pipeline/index.mjs';
import { modelPreference, policyEffort } from './pipeline/policy.mjs';
import { readLeases } from './resource-data.mjs';
import { readRoutingObservations, saveRoutingObservations } from './routing-observations.mjs';

const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const lines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { const r = JSON.parse(l); return object(r) ? [r] : []; } catch { return []; } }); } catch { return []; } };
// A missing health ledger means no recorded failures; an unreadable ledger
// cannot assert that restrictions are clear.
const readHealth = file => { try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(e) { return e.code==='ENOENT'?{}:null; } };
// Public turn metadata only: no worker prompts, login/session files or provider calls.
const recentAstraQueue = (home, health, now) => {
  const queues=home?readHealth(path.join(home,'queue-status.json')):{}, models=home?readHealth(path.join(home,'thread-models.json')):{};
  const lanes=home?readHealth(path.join(home,'lane-state.json')):{}, families=home?readHealth(path.join(home,'queue-state.json')):{};
  const sources=[], times=[], fresh=t=>nonnegative(t)&&t<=now&&now-t<=1800000;
  if(![queues,models,lanes,families].every(object)) return {value:{blocked:true,sources:['unreadable recent-turn queue metadata']},sampledAt:now};
  for(const [thread,q] of Object.entries(queues)) if(object(q)&&fresh(q.at??q.t)
    &&modelId(q.modelId??q.model??models[thread])==='gpt-6-astra'
    &&(q.position>0||['queued','waiting','stalled'].includes(q.state)||q.stalled===true)) {
    sources.push('queue-status'); times.push(q.at??q.t);
  }
  for(const r of [health,...Object.values(object(health?.pools)?health.pools:{})]) if(object(r)) {
    const at=r.lastFailureAt??r.t??r.pausedUntil;
    if(r.queueSignals===undefined&&fresh(at)&&modelId(r.model)==='gpt-6-astra'&&isQueueOrStall(r.reason)) {
      sources.push('worker-health'); times.push(at);
    }
    if(r.queueSignals!==undefined&&!Array.isArray(r.queueSignals)) return {value:{blocked:true,sources:['unreadable recent-turn health metadata']},sampledAt:now};
    for(const f of array(r.queueSignals)) if(object(f)&&fresh(f.t)&&modelId(f.model)==='gpt-6-astra') {
      sources.push('worker-health'); times.push(f.t);
    }
    if(r.failures!==undefined&&!Array.isArray(r.failures)) return {value:{blocked:true,sources:['unreadable recent-turn health metadata']},sampledAt:now};
    for(const f of array(r.failures)) if(object(f)&&fresh(f.t)&&modelId(f.modelId??f.model??r.model)==='gpt-6-astra'
      &&(isQueueOrStall(f.why)||f.stalled===true)) {
      sources.push('worker-health'); times.push(f.t);
    }
  }
  return {value:{blocked:times.length>0,sources:[...new Set(sources)]},sampledAt:times.length?Math.max(...times):now};
};
const DEFAULT_MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra'];
export const BROWSER_ORIGINS = ['*.bytedance.net', '*.byted.org', '*.larkoffice.com', '*.feishu.cn', '*.tiktok-row.net', '*.byteintl.net', '*.bytedance.com'];
export function taskContext(env = process.env) {
  return { taskId: 'unnamed-task', requestId: env.ROUTE_REQUEST_ID || randomUUID(), sandboxCeiling: 'danger-full-access' };
}
export function acquireRoute(parsed, { env = process.env, now = Number(env.ROUTE_NOW ?? Date.now()), root, readAccount = readRoutingAccount, readClaude = readRoutingClaude } = {}) {
  if (!nonnegative(now)) throw Error('ROUTE_NOW must be a finite epoch timestamp');
  const shared = env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared');
  const cachePath = env.QUOTA_CACHE || path.join(shared, 'quota.json'), routeLog = env.ROUTE_LOG_FILE || path.join(shared, 'route-log.jsonl');
  const registryPath=env.CODEX_ACCOUNTS || path.join(shared, 'codex-accounts.json');
  let registry, registryInvalid=false;
  try { registry=JSON.parse(fs.readFileSync(registryPath,'utf8')); registryInvalid=!object(registry); }
  catch(e) { registryInvalid=e.code!=='ENOENT'; registry={}; }
  const collectedFrom = now;
  const cached = readRoutingObservations(cachePath,now);
  const data = object(cached) ? {...cached} : {};
  const invalidProfiles = new Set(Object.entries(object(registry)?registry:{}).filter(([,p])=>!object(p)).map(([name])=>name));
  const profiles = object(registry) ? {...registry} : {}, accounts = array(data?.codexAccounts).filter(object).map((a) => ({ ...a }));
  for (const [name, p] of Object.entries(profiles)) if (object(p) && !accounts.some((a) => a.name === name)) accounts.push({ name, kind: p.kind, stateUnknown: true });
  for(const a of accounts) if(!profiles[a.name]) profiles[a.name]={home:a.home,kind:a.kind,modelIds:a.modelIds,bin:a.bin};
  // A frozen clock or supplied snapshot is an offline replay; never query the
  // host for it. Live decisions refresh each account independently. In particular
  // a cached hub-down reading is checked again even inside the cache TTL.
  // --dry previews the real decision, so it reads state exactly like a real route (owner 2026-11-15: a preview that
  // skips the refresh showed a stale blocked Claude lane that the real route would not). It only skips logging/rotation.
  const live = env.ROUTE_NOW === undefined && !env.ROUTE_SNAPSHOT_FILE;
  if(live) saveRoutingObservations(cachePath,data);
  if (live && !registryInvalid) for (const a of accounts) {
    const p = profiles[a.name], at = a.seenAt ?? data.checkedAt;
    if (!object(p)) continue;
    const reset=a.quotaOut?.resetsAt??a.usage?.resetsAt;
    const deniedUntilReset=a.kind==='ttadk' && reset>now && (!!a.quotaOut || /quota|daily token/i.test(a.reason??''));
    if ((parsed.flags.fresh || !deniedUntilReset) && (parsed.flags.fresh || a.stateUnknown || a.live !== true || !nonnegative(at) || now-at > 600000)) {
      try {
        const observed = readAccount(a.name, p);
        if(!object(observed)||observed.stateUnknown||observed.statusReadFailed) throw Error('account status read incomplete');
        Object.assign(a, observed, { seenAt: Date.now(), stateUnknown:observed.stateUnknown===true, transport: observed.live === true, statusSource: 'authenticated-status', observationStale:false });
        if (observed.quota === null && object(cached?.codexAccounts?.find(r=>r.name===a.name)?.quota))
          a.quota = cached.codexAccounts.find(r=>r.name===a.name).quota;
        if (a.kind === 'ttadk' && !observed.usage) {
          const previous=cached?.codexAccounts?.find(r=>r.name===a.name);
          a.usage = previous?.usage;a.usageSeenAt=previous?.usageSeenAt??data.checkedAt;
        } else if(a.kind==='ttadk') a.usageSeenAt=a.seenAt;
        profiles[a.name] = {...p, modelIds: observed.modelIds ?? p.modelIds};
      } catch { a.statusSource = 'last-good-stale'; a.observationStale=true; }
    }
  }
  // Capability detection checks only whether the configured pairing file exists;
  // it neither reads pairing material nor queries a provider, including fixtures.
  for(const a of accounts) if(a.kind==='trae') a.traeBrowser=traeBrowserReady();
  if (live && (parsed.flags.fresh || !Array.isArray(data.claude) || now-data.checkedAt > 600000)) {
    try { const observed=readClaude(); if(!Array.isArray(observed)||!observed.length) throw Error('Claude usage incomplete');
      data.claude = observed; data.claudeSeenAt = Date.now(); data.claudeObservationStale=false;
    } catch { data.claudeObservationStale=true; }
  }
  data.codexAccounts=accounts;
  if(live) saveRoutingObservations(cachePath,data);
  if (live) now=Math.max(now,Date.now()); // refreshed samples precede the live decision
  const rows = lines(routeLog), quotaHistory = lines(env.QUOTA_LOG_FILE || path.join(shared, 'quota-log.jsonl'));
  const outcomes=dedupeOutcomes(rows.filter(r=>r.kind==='outcome'&&r.t<=now))
    .filter(r=>!r.reviewRun && r.role !== 'second' && !['review','review-high','adversarial','second-opinion'].includes(r.category));
  const projectProfiles = read(path.join(root,'references/project-risk-profiles.json'),{});
  const projectConfig = projectProfiles[parsed.project] ?? {};
  const cachedAt = data.checkedAt ?? (env.ROUTE_SNAPSHOT_FILE ? read(env.ROUTE_SNAPSHOT_FILE)?.decisionAt : undefined);
  const cacheAgeMs = nonnegative(cachedAt) && cachedAt <= now ? now - cachedAt : null;
  const flags = parsed.flags, id = flags.name ?? parsed.taskId, role = parsed.role;
  const attempts = [];
  const injectedSnapshot=env.ROUTE_SNAPSHOT_FILE ? read(env.ROUTE_SNAPSHOT_FILE) : null;
  const retryHistory = parsed.failures > 0;
  const ownedDir = flags['task-dir'] ?? (flags.name && flags.project && !['.','..'].includes(flags.project) && /^[\w.-]+$/.test(flags.project)
    ? path.join(shared,'..',flags.project,'tasks',id) : null);
  const metadata = file => { try { return fs.lstatSync(file).isSymbolicLink() ? null : read(file); } catch { return null; } };
  const sameTask = r => object(r) && r.project === parsed.project && r.category === parsed.category
    && (r.taskId ?? r.name) === id && (r.role ?? 'primary') === role;
  const addActual = (actual, extra = {}) => {
    if (!actual) return;
    const accountId=Object.hasOwn(actual,'account') ? actual.account : actual.accountId
      ?? (actual.vendor==='claude' || familyOf(actual.modelId??actual.model)==='claude' ? 'claude' : actual.vendor==='codex' ? 'main' : undefined);
    attempts.push({ id: `actual-${attempts.length}`, taskId: id, role, state: 'failed', actualStatus: 'KNOWN',
      actual: { accountId, ...(actual.accountStatus?{accountStatus:actual.accountStatus}:{}), modelId: modelId(actual.modelId ?? actual.model), effort: actual.effort }, failureKind: 'infra', ...extra });
  };
  let missingTerminalActual=false;
  const ingestAttempt = r => {
    if (!sameTask(r) || r.dry === true || r.launched === false || r.state==='planned') return;
    const terminal=['failed','completed','cancelled-no-work','cancelled','succeeded'].includes(r.state);
    if ((!terminal && !['starting','queued','running','cancel-pending','UNKNOWN'].includes(r.state))
      || (r.kind && !['attempt','launch','launch-model'].includes(r.kind)) || r.accepted===false) return;
    if(terminal && r.actualStatus!=='KNOWN') {
      // An unconfirmed actual from a finished attempt cannot block a count-only
      // retry. Continue the named-log/first-rung lookup; live UNKNOWN states stay.
      missingTerminalActual=true;
      return;
    }
    const prior=r.actual, vendor=prior?.vendor??r.vendor;
    const actual=object(prior)?{...prior,accountId:prior.accountId??prior.account??r.accountId??r.account
      ??(vendor==='claude'||familyOf(prior.modelId??prior.model)==='claude'?'claude':vendor==='codex'?'main':undefined)}:prior;
    attempts.push({...r,id:r.id??`metadata-${attempts.length}`,taskId:r.taskId??id,role:r.role??role,actual,
      failureKind:r.failureKind??(parsed.failures?parsed.failureKind:'infra')});
  };
  if (flags.actual) for (const tuple of flags.actual.split(',')) {
    const m = /^(codex|claude):([\w.-]+):(low|medium|high|xhigh|max)(?:@([\w.-]+))?$/.exec(tuple);
    if (!m) throw Error('--actual takes vendor:model:effort[@account] (comma-separated launch order)');
    addActual({ model: m[2], effort: m[3], account: m[4] ?? null, accountStatus:m[4]?'KNOWN':'UNKNOWN' },
      { source:'explicit-actual', failureKind: parsed.failures ? parsed.failureKind : 'infra' });
  }
  if (retryHistory && flags['previous-attempt'] && !flags.actual) {
    const dir = path.resolve(flags['task-dir'] ?? '.'), file = path.resolve(dir, flags['previous-attempt']);
    if (!file.startsWith(`${dir}${path.sep}`) || !['attempts.json', 'actual-attempts.json', 'launch.json'].includes(path.basename(file))) throw Error('--previous-attempt must name task-owned attempts.json, actual-attempts.json or launch.json');
    let cursor=file;
    while(cursor!==dir) { if(fs.lstatSync(cursor).isSymbolicLink()) throw Error('--previous-attempt cannot follow a symlink'); cursor=path.dirname(cursor); }
    const recorded=read(file,[]);
    if(Array.isArray(recorded)) recorded.forEach(ingestAttempt);
    else if(object(recorded)&&Array.isArray(recorded.attempts)) recorded.attempts.forEach(ingestAttempt);
    else if(object(recorded)&&('actualStatus' in recorded || 'state' in recorded)) ingestAttempt(recorded);
    else throw Error('--previous-attempt contains no attested actual attempts');
  }
  if (retryHistory && !flags.actual && !attempts.length) {
    if (ownedDir) {
      for (const file of ['actual-attempts.json','attempts.json','launch.json']) {
        const record=metadata(path.join(ownedDir,file));
        const rows=Array.isArray(record)?record:array(record?.attempts);
        rows.forEach(ingestAttempt);
        if (!rows.length && record) ingestAttempt(record);
        if(attempts.length) break;
      }
    }
  }
  if (retryHistory && !flags.actual && !attempts.length) {
    // Pre-RPC launch audits, route decisions and outcomes alone cannot attest
    // execution. Only scoped accepted/terminal actual-launch records qualify.
    const launched = rows.filter(r=>sameTask(r) && r.t<=now && r.dry!==true && r.launched!==false
      && (r.kind==='attempt' || (['launch-model','launch'].includes(r.kind) && r.accepted===true && r.thread && r.turn)));
    const latest = new Map();
    for (const row of launched) {
      const key = row.id ?? (row.thread && row.turn ? `${row.account}:${row.thread}:${row.turn}` : `attempt-${row.t}`);
      if (!latest.has(key) || latest.get(key).t <= row.t) latest.set(key,row);
    }
    for (const row of latest.values()) ingestAttempt({...row,id:row.id??`launch-${row.t}`});
  }
  // Automatic no-work hops explicitly carry their actual tuple, including when
  // failures=0. Rebind only the matching, task-scoped cancellation receipt.
  if (flags.actual && parsed.autoRerouteDepth > 0 && ownedDir) {
    const r = metadata(path.join(ownedDir,'reroute.json'));
    if (sameTask(r) && r.depth === parsed.autoRerouteDepth && typeof r.cancellationEvidenceId==='string' && r.cancellationEvidenceId.length>0
      && r.from && attempts.length===1
      && attempts[0].actual.accountId===r.from.account && attempts[0].actual.modelId===modelId(r.from.model)
      && attempts[0].actual.effort===r.from.effort) Object.assign(attempts[0],{
        state:'cancelled-no-work',usefulWork:false,cancellationEvidenceId:r.cancellationEvidenceId,
        failureKind:r.reason==='policy-block'?'policy-block':'infra'});
  }
  if (flags['failure-kind'] && !flags.actual && attempts.length && parsed.autoRerouteDepth === 0) {
    attempts.at(-1).failureKind = parsed.failureKind;
    if (parsed.failures && parsed.failureKind === 'tool' && ['completed','succeeded'].includes(attempts.at(-1).state)) attempts.at(-1).state='failed';
  }
  let retryAssumption = missingTerminalActual ? 'A finished attempt had no confirmed actual tuple; using the next available recorded retry baseline.' : null;
  if (retryHistory && !attempts.length && parsed.failureKind !== 'tool') {
    const deviceAccounts=env.ROUTE_SNAPSHOT_FILE?array(injectedSnapshot?.accounts):accounts;
    const a = deviceAccounts.some(a=>['trae','ttadk'].includes(a.kind)) && !['image-gen','claude-tools','computer-use'].includes(parsed.category) ? {kind:'trae'} : {kind:'chatgpt'}, initial = createTaskSpec({...parsed, flags:{...flags,failures:'0'}, failures:0, previousAttempts:[]});
    const model = modelPreference(initial,a)[0], effort = policyEffort(initial,{family:familyOf(model),modelId:model},a,{accounts:[]});
    addActual({model,effort,account:familyOf(model)==='claude'?'claude':a.kind==='trae'?'assumed-company':'assumed-personal'}, {id:'assumed-first-rung',failureKind:parsed.failures?parsed.failureKind:'infra',assumed:true});
    retryAssumption = `No actual launch history found; assumed first category ladder rung ${model}/${effort} for --failures ${parsed.failures}.`;
  }
  const writes = parsed.writes || !!flags.signing;
  const sandbox = flags.sandbox ?? (writes ? 'danger-full-access' : parsed.runsTests ? 'workspace-write' : 'read-only');
  let task = createTaskSpec({ ...parsed, taskId: id, writes, sandbox, sandboxCeiling: 'danger-full-access', previousAttempts: attempts,
    flags:{...flags,...(flags.cwd?{cwd:path.resolve(flags.cwd)}:{}),...(flags['task-dir']?{'task-dir':path.resolve(flags['task-dir'])}:{})},
    projectProfiles,
    allowedOrigins: ['browser', 'ui-browser'].includes(parsed.category) ? [...BROWSER_ORIGINS, ...array(projectConfig.browserOrigins), ...(parsed.category === 'ui-browser' ? ['localhost', '127.0.0.1'] : []), ...parsed.allowedOrigins] : parsed.allowedOrigins,
    floor: { profileIds: [], previousAttemptIds: [], relationVersion: VERSION, historyStatus: attempts.length || !parsed.failures ? 'KNOWN' : 'UNKNOWN' } });
  const finish = snapshot => {
    const unknownToolChannels = attempts.filter(a=>a.failureKind==='tool' && !snapshot.accounts.some(p=>p.id===a.actual?.accountId));
    if(retryHistory && unknownToolChannels.length && ['browser','ui-browser','computer-use'].includes(task.category)) {
      const baseline = createTaskSpec({...task,previousAttempts:attempts.filter(a=>!unknownToolChannels.includes(a)),failures:0,
        flags:{...task.flags,failures:'0'},floor:{...task.floor,historyStatus:'KNOWN'}});
      const first=routePure(baseline,snapshot), candidate=(first.primary??first.primaryProposal)?.candidate;
      if(candidate) {
        const channel=snapshot.accounts.find(p=>p.id===candidate.accountId)?.kind;
        for(const a of unknownToolChannels) Object.assign(a,{browserChannel:channel,assumedChannel:true});
        task=createTaskSpec({...task,previousAttempts:attempts});
        retryAssumption=`Prior actual browser account is unknown; assumed failed ${channel} channel from the cached initial route, preserving the supplied model/effort floor.`;
      }
    }
    if (retryHistory && !attempts.length && parsed.failureKind === 'tool') {
      const inferred = [];
      for (let i=0; i<parsed.failures; i++) {
        const baseline = createTaskSpec({...task, failures:0, previousAttempts:inferred, flags:{...task.flags, failures:'0'},
          floor:{...task.floor, historyStatus:'KNOWN'}});
        const plan = routePure(baseline, snapshot), candidate = (plan.primary ?? plan.primaryProposal)?.candidate;
        if (!candidate) break;
        inferred.push({id:`assumed-tool-channel-${i}`,taskId:id,role,state:'failed',actualStatus:'KNOWN',assumed:true,
          actual:{accountId:candidate.accountId,modelId:candidate.modelId,effort:candidate.effort},failureKind:'tool'});
      }
      task = createTaskSpec({...task,previousAttempts:inferred,floor:{...task.floor,historyStatus:inferred.length?'KNOWN':'UNKNOWN'}});
      retryAssumption = `No actual launch history found; assumed ${inferred.length} failed browser channel(s) from the cached initial route for --failures ${parsed.failures}.`;
    }
    return {task,snapshot,data,profiles,routeLog,now,root,retryAssumption,cacheAgeMs,refreshRequired:live&&!!flags.fresh,
      trustedCwd: flags['trusted-cwd'] ? path.resolve(flags['trusted-cwd']) : projectConfig.root ?? projectConfig.projectRoot ?? null,
      slowTests: Array.isArray(projectConfig.slowTests) ? projectConfig.slowTests : []};
  };
  if (env.ROUTE_SNAPSHOT_FILE) return finish(createSnapshot(injectedSnapshot, { now }));
  const at = data?.checkedAt, globalStamp = (value, sampledAt = at, maxAgeMs = 600000) => ({ status: 'KNOWN', value, sampledAt, receivedAt: now, maxAgeMs, source: 'public-status-cache' });
  const baseCaps = (vision = true) => ({ search: true, browser: vision, 'signed-in-browser': vision, 'desktop-tool': vision, vision, 'image-generation': true, 'claude-tools': true });
  const models = new Map(), normalized = [], lanes = [], health = [];
  const add = (a, isClaude = false) => {
    const accountAt = isClaude ? data.claudeSeenAt ?? at : a.seenAt ?? at;
    const stamp = (value, sampledAt = accountAt, maxAgeMs = 600000) => ({...globalStamp(value,sampledAt,maxAgeMs),
      source:(isClaude?data.claudeObservationStale:a.observationStale)?'last-good-stale':'public-status-cache'});
    const kind = isClaude ? 'claude' : a.kind ?? 'chatgpt', name = isClaude ? 'claude' : a.name, company = ['ttadk', 'trae'].includes(kind);
    const profile = profiles[name] ?? a, home = profile.home ?? a.home;
    const profileCatalog=company&&a.models===undefined&&(Array.isArray(profile.models)||object(profile.modelIds));
    const catalog = isClaude ? ['haiku', 'sonnet', 'opus', 'fable'] : array(a.models ?? (profileCatalog?profile.models??Object.keys(profile.modelIds):company ? [] : DEFAULT_MODELS)).map(modelId);
    const healthRaw = home ? readHealth(path.join(home, 'worker-health.json')) : {}, h=object(healthRaw)?healthRaw:{};
    const unknownHealth = !object(healthRaw) || (h.pools !== undefined && !object(h.pools)) || (h.modelPauses !== undefined && !object(h.modelPauses))
      || Object.values(h.pools??{}).some((r)=>!object(r)) || Object.values(h.modelPauses??{}).some((r)=>!object(r));
    const currentLimit=kind==='ttadk'&&home?read(path.join(home,'quota-limit.json')):null;
    const quotaDenied = currentLimit?.resetsAt>now || !!(a.quotaOut && (!a.quotaOut.resetsAt || a.quotaOut.resetsAt>now)) || (!a.healthy && /quota|daily token/i.test(a.reason ?? ''));
    const windows = array(isClaude ? data.claude : a.windows), badWindows = (isClaude ? data.claude : a.windows) !== undefined
      && (!Array.isArray(isClaude ? data.claude : a.windows) || windows.some((w)=>!object(w)));
    const spent = windows.some((w) => object(w)&&!w.scoped && (w.used >= 99 || (w.windowMins < 1440 && w.used >= 95)) && (!w.resetsAt || w.resetsAt > now));
    const browser = isClaude || a.browser === true || profile.browser === true || (kind==='trae' && a.traeBrowser === true);
    const desktop = !isClaude && kind!=='trae' && (a.desktop ?? profile.desktop ?? browser) === true;
    const caps = { search: isClaude || kind === 'chatgpt' || kind === 'trae' || (a.search === true && a.searchLive !== false),
      browser: browser || a.publicBrowser === true, 'signed-in-browser': browser, 'desktop-tool': desktop, vision: true,
      'image-generation': kind === 'chatgpt', 'claude-tools': isClaude };
    for (const origin of task.allowedOrigins) caps[`origin:${origin}`] = browser || a.publicBrowser === true;
    for (const app of task.allowedApps) caps[`app:${app}`] = desktop;
    const quota = [];
    if (kind === 'ttadk') quota.push({ bucketId: 'ttadk-daily', unit: 'tokens', usage: stamp(a.usage,a.usageSeenAt??accountAt), priority: stamp('available') });
    if (kind === 'trae') for (const [m, q] of Object.entries(object(a.quota?.daily) ? a.quota.daily : {})) quota.push({ bucketId: modelId(m), unit: 'model-bucket',
      usage: stamp(q, a.quota.sampledAt, 1800000), priority: stamp(q?.depleted ? 'depleted' : 'available', a.quota.sampledAt, 1800000) });
    let burn = null;
    const prior = quotaHistory.filter((r) => r.t < at && r.t >= now - 7200000 && r.ttadk?.name === name && r.ttadk?.resetsAt === a.usage?.resetsAt).sort((a,b) => a.t-b.t)[0];
    if (prior && a.usage && at - prior.t >= 600000 && a.usage.used >= prior.ttadk.used) burn = { resetsAt: a.usage.resetsAt,
      projectedAtReset: a.usage.used + (a.usage.used - prior.ttadk.used) / (at - prior.t) * (a.usage.resetsAt - at) };
    const declared=(value)=>isClaude||profileCatalog?{...globalStamp(value,now),source:'declared-harness'}:stamp(value);
    normalized.push({ id: name, kind, catalog: declared(catalog), auth: stamp(((registryInvalid||invalidProfiles.has(name))&&!isClaude||a.stateUnknown)?null:a.auth ?? (isClaude ? Array.isArray(data.claude)?true:null : company ? a.healthy || quotaDenied : a.live === true)),
      transport: stamp(a.stateUnknown?null:a.transport ?? (isClaude ? Array.isArray(data.claude)?true:null : a.live ?? (company ? a.healthy || quotaDenied : null))), health: declared(!unknownHealth && !badWindows),
      capabilities: Object.fromEntries(Object.entries(caps).map(([k,v]) => [k,declared(v)])), quota, burn: stamp(burn),
      providerDenied: currentLimit?.resetsAt>now?globalStamp(true,now):stamp(quotaDenied || (!company && spent)), denialResetAt: stamp(currentLimit?.resetsAt ?? a.quotaOut?.resetsAt ?? a.usage?.resetsAt ?? windows.find((w) => w?.used >= 95)?.resetsAt),
      resets: a.resets, workerClass: a.workerClass,
      budget:stamp(personalBudget(windows,a.resets,data.history?.[isClaude?'claude':`codex:${name}`],now,isClaude)) });
    const appendPause = (r, extra = {}) => {
      if (!object(r) || (!(r.pausedUntil > now) && r.kind !== 'hard')) return;
      health.push({ accountId: name, modelId: null, family: null, generation: String(r.generation ?? r.t ?? r.pausedUntil),
        restricted: true, until: r.pausedUntil, recovery: r.kind === 'hard' ? 'awaiting-probe' : 'not-due', evidence: stamp(true), ...extra });
    };
    appendPause(h); for (const [family,r] of Object.entries(object(h?.pools) ? h.pools : {})) appendPause(r,{family});
    for (const [m,r] of Object.entries(object(h?.modelPauses) ? h.modelPauses : {})) if (r?.pausedUntil > now) appendPause(r,{modelId:modelId(m)});
    const telemetry = home ? read(path.join(home,'lane-state.json'),{}) : {}, familyQueue=home?read(path.join(home,'queue-state.json'),{}):{}, load = object(a.load) ? a.load : {};
    const astraRecent=kind==='trae'&&catalog.includes('gpt-6-astra')?recentAstraQueue(home,h,now):null;
    for (const m of catalog) {
      const family = familyOf(m), vision = !['deepseek','kimi'].includes(family), modelCaps = baseCaps(vision);
      models.set(m, { id:m, efforts: ['low','medium','high','xhigh','max'], capabilities:modelCaps, largeOutput: family !== 'deepseek' });
      const q = a.quota?.daily?.[m], sample = a.quota?.sampledAt;
      const freshQuota = nonnegative(sample) && sample <= now && now-sample <= 1800000 && (!q?.resetsAt || q.resetsAt>now);
      const explicitFree = (a.quotaKeys && Object.hasOwn(a.quotaKeys,m) && a.quotaKeys[m] === null)
        || (freshQuota && object(a.quota?.daily) && Object.values(a.quota.daily).some(b=>object(b)&&nonnegative(b.used)&&typeof b.limit==='number'&&b.limit>0&&b.resetsAt>now) && !Object.hasOwn(a.quota.daily,m) && !['gpt-6.1-sol','gpt-6-astra','gpt-5.6-sol'].includes(m));
      const mode = kind !== 'trae' ? 'standard' : freshQuota && object(q) && nonnegative(q.used) && typeof q.limit==='number' && q.limit>0 && q.resetsAt>now ? (q.depleted ? 'low-priority' : 'priority') : explicitFree ? 'bucket-free' : 'UNKNOWN';
      const direct = telemetry?.[m], directLoad = modelLoad(load,m,now);
      lanes.push({ id:`${name}:${m}:hub`, accountId:name, modelId:m, harness: isClaude?'claude-bg':'hub', efforts:declared(['low','medium','high','xhigh','max']),
        modeEvidence:stamp(mode,kind==='trae'?sample:at,1800000), selectable:true, capabilities:Object.fromEntries(Object.entries(caps).map(([k,v])=>[k,declared(v)])),
        readyAt: kind !== 'trae' || mode === 'priority' || mode === 'bucket-free' ? stamp(now) : direct?.state==='ready'&&direct?.position===0 ? stamp(direct.t,direct.t,1800000):null,
        position:stamp(direct?.position,direct?.t,1800000), drainPerMin:stamp(direct?.drainPerMin,direct?.t,1800000), progressAt:stamp(direct?.lastProgressAt,direct?.t,1800000),
        queueState:stamp(direct?.state,direct?.t,1800000),
        ...(m==='gpt-6-astra'&&astraRecent?{recentQueue:stamp(astraRecent.value,astraRecent.sampledAt,1800000),hubHealthy:stamp(a.healthy)}:{}),
        loadPercent:stamp(directLoad?.percent,directLoad?.t,1800000), loadSource: directLoad?.source??'UNKNOWN',
        familyQueue:stamp(familyQueue?.[family],familyQueue?.[family]?.t,1800000) });
    }
  };
  accounts.forEach((a)=>add(a)); add({},true);
  const snapshot = createSnapshot({ schemaVersion:VERSION, collectedFrom, collectedThrough:now, decisionAt:now, accounts:normalized, models:[...models.values()], lanes, health,
    qualityRelations:['gpt-6-luna','gpt-6.1-terra','gpt-5.6-terra','gpt-5.5','gpt-5.6-sol'].flatMap((from)=>['low','medium','high','xhigh','max'].flatMap((e,i,efforts)=>
      efforts.slice(i).map((to)=>({from:`${from}:${e}`,to:`gpt-6.1-sol:${to}`,version:VERSION,evidenceId:'policy-light-to-sol'})))),
    resources: { held:false, ownedReturned:true, registeredResources:readLeases(shared).registered,
      signingRegistry:fs.existsSync(path.join(shared,'user-signing/registry.json'))&&fs.existsSync(path.join(shared,'user-signing/identities.json')) },
    dependencies:[], approvals: array(read(env.ROUTE_APPROVAL_FILE || path.join(shared,'route-approvals.json'),[])),
    projectProfiles, reviewHistory:rows.filter((r)=>
      (r.kind==='route'||!r.kind)&&r.pick&&r.executable!==false&&!r.deferred&&(r.executable===true||!r.needsOK?.length))
      .flatMap((r)=>[r,...(r.second&&r.secondExecutable!==false?[{...r,category:'second-opinion',role:'second'}]:[])]),
    outcomes:outcomes.map((r)=>({...r,modelId:r.actual?.[0]?.model??r.first?.model})),
    etaHistory:outcomes.map((r)=>({attemptId:`${r.name}-${r.t}`,category:r.category,modelId:r.actual?.[0]?.model??r.first?.model,
      accountId:r.actual?.[0]?.account??r.first?.account,effort:r.actual?.[0]?.effort??r.first?.effort,minutes:r.minutes,cause:r.cause})) });
  return finish(snapshot);
}
