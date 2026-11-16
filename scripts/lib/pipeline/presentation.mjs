import {DEPENDENCY_RULE} from '../dependency-policy.mjs';
// Pure compatibility rendering. Receives paths, owner and digest from the CLI;
// it never launches, reads metadata, or changes the selected tuple.
import { company, companyDevice, known, adversarial, isReview } from './common.mjs';
import { candidateParts } from './candidates.mjs';
import {mandatoryReview,projectReviewPolicy} from '../review-policy-data.mjs';
import { deriveReview } from './taskspec.mjs';
import { reviewAfterWrite } from './review-policy.mjs';
import { estimateCandidate } from './estimate.mjs';
import { etaText } from '../eta.mjs';
import { modelPreference } from './policy.mjs';
export const shellQuote = (v) => /^[a-zA-Z0-9_./:@-]+$/.test(String(v)) ? String(v) : `'${String(v).replaceAll("'", "'\\''")}'`;
const command = (args) => args.map(shellQuote).join(' ');
export function presentRoute(plan, view, context) {
  const { snapshot, root, owner, profiles = {}, digest:sourceDigest = { version:'UNKNOWN',worker:'' } } = context;
  const resources=known(snapshot.resources)??{}, hasTrae=snapshot.accounts.some(a=>a.kind==='trae');
  const hasDeepSeek=snapshot.accounts.some(a=>(known(a.catalog)||[]).some(m=>m.startsWith('deepseek')));
  const phones=['iphone8','iphone11','s21'].filter(id=>(resources.registeredResources??[]).includes(id)||resources.devices?.[id]?.registered);
  const hasSigning=resources.signingRegistry===true;
  const digest={...sourceDigest,worker:sourceDigest.worker.split('\n').filter(line=>
    (hasSigning||!line.startsWith('- Allowed with'))&&(phones.length||!line.startsWith('- On registered shared test phones'))
    &&(hasTrae||!line.startsWith('- A queued TRAE'))).map(line=>line.replaceAll('iphone8/iphone11/s21',phones.join('/'))).join('\n')};
  const t = plan.task, f = t.flags, seat = plan.primary ?? plan.primaryProposal, c = seat?.candidate;
  const notes = [...view.notes,...(t.policyNotes??[])], why = [...(t.policyNotes??[])], tellUser = [...view.tellUser], needsUserOK = [...view.needsOK];
  if(['implement','implement-hard','build-run','debug','ui-browser'].includes(t.category))notes.push(DEPENDENCY_RULE);
  const noReview=projectReviewPolicy(t.project,snapshot.projectProfiles).profile==='no-review'&&!mandatoryReview(t);
  if(noReview)notes.push('no review (project profile no-review): accept on tests/build');
  const unknownCompany=snapshot.accounts.filter(a=>company(a)&&(known(a.auth)!==true||known(a.transport)!==true));
  const quota=snapshot.accounts.map(a=>`${a.id}/${a.kind}: ${known(a.auth)===true&&known(a.transport)===true?'available status':'account state unknown or unavailable'}`);
  const personalAccounts=snapshot.accounts.filter(a=>!company(a)&&a.kind!=='claude');
  const personalBudgets=personalAccounts.map(a=>known(a.budget)).filter(Boolean);
  const quotaSummary={claude:known(snapshot.accounts.find(a=>a.kind==='claude')?.budget)?.status??'UNKNOWN',
    codexOut:personalAccounts.length>0&&personalAccounts.every(a=>known(a.providerDenied)===true),
    underused:personalBudgets.some(b=>b.underused),frontLoad:personalBudgets.some(b=>b.frontLoad),
    overspending:personalBudgets.some(b=>b.overspending),redeemDue:personalBudgets.some(b=>b.redemption)};
  if(unknownCompany.length) tellUser.push(`company account state unknown or unavailable: ${unknownCompany.map(a=>`${a.id}/${a.kind}`).join(', ')}; check quota.mjs --fresh using an authorized status reader, then replan.`);
  const balanceRows = (plan.trace?.candidates ?? []).filter(r => r.estimate.balance && r.predicates
    .filter(p => !p.ok).every(p => p.reason.code === 'ACTIVE_RESTRICTION'));
  const balanceCandidates = [...new Map(balanceRows.map(r => [r.candidate.modelId, {
    ...r.estimate.balance, reasons: [...r.estimate.balance.reasons,
      ...(r.predicates.some(p => p.reason?.code === 'ACTIVE_RESTRICTION') ? ['model paused'] : [])],
  }])).values()].sort((a,b) => {
    const account = snapshot.accounts.find(a => a.kind === 'trae');
    const pref = modelPreference(t,account);
    return pref.indexOf(a.model)-pref.indexOf(b.model);
  });
  const chosenBalance = seat?.estimate.balance;
  const walked = chosenBalance ? balanceCandidates.slice(0,balanceCandidates.findIndex(b=>b.model===c.modelId)+1) : balanceCandidates;
  const balance = balanceCandidates.length ? {...(chosenBalance ?? {}),selected:!!(chosenBalance?.freeNow||chosenBalance?.eligible),candidates:walked} : null;
  if(seat?.estimate.expiryOpportunity) { const hint=candidateParts(snapshot,c).account.kind==='ttadk'?'TTADK quota expiring unused: good time for existing qualified work':`TRAE ${c.modelId} priority bucket expiring unused at ${new Date(seat.estimate.expiryEvidence.resetsAt).toISOString()}; quality order preserved`; why.push(hint);quota.push(hint); }
  if(chosenBalance?.freeNow) why.push(`TRAE lane free: saving TTADK quota; ${c.modelId} load ${chosenBalance.load.percent}%; no queue or stall observed.`);
  else if(chosenBalance) why.push(`TRAE ${c.modelId}: bounded fallback; immediate uncongested capacity is unmeasured.`);
  if(c && candidateParts(snapshot,c).account.kind==='ttadk' && balanceCandidates.length) {
    const relevant=balanceCandidates.find(b=>b.model===c.modelId);
    why.push(relevant?`stays on TTADK: ${relevant.model}: ${relevant.queued?'queue observed':relevant.congestion==='high'?'model congested':!relevant.freeNow?'no demonstrated immediate uncongested TRAE lane':'TTADK quota expiry or required capability'}`:`stays on TTADK: ${c.modelId} has no qualified same-model TRAE lane for the required capability/catalog.`);
  }
  if(f.dry) notes.push(`--dry: cached snapshot only; no live refresh/probes. Cache age: ${context.cacheAgeMs===null||context.cacheAgeMs===undefined?'UNKNOWN':`${Math.round(context.cacheAgeMs/1000)} seconds`}.`);
  if(context.refreshRequired) notes.push('--fresh: account status refreshed through authenticated read-only interfaces.');
  const staleAccounts=snapshot.accounts.filter(a=>a.auth.source==='last-good-stale').map(a=>a.id);
  if(staleAccounts.length) why.push(`Status read incomplete: retained last-good stale observations for ${staleAccounts.join(', ')}; original sample ages and admission checks remain in force.`);
  if(context.retryAssumption) why.push(context.retryAssumption);
  if(t.previousAttempts.some(a=>a.source==='explicit-actual'&&a.actual?.accountStatus==='UNKNOWN'))
    why.push('Prior actual account is unknown; retaining the supplied model/effort floor.');
  for(const warning of plan.warnings??[]) { why.push(warning.text);tellUser.push(warning.text); }
  for(const gate of plan.gates.filter((g)=>g.state==='needsOK')) {
    if(gate.kind==='personal-quota') needsUserOK.push(`personal quota: ${gate.scope?.accounts.join(',')??'reviewer'} needs the user's scoped OK${unknownCompany.length?`; company account state unknown or unavailable (${unknownCompany.map(a=>`${a.id}/${a.kind}`).join(', ')})`:''}`);
    if(gate.kind==='max-effort') needsUserOK.push('max effort');
    if(gate.kind==='capacity-decision') needsUserOK.push(gate.reason.text);
  }
  const routeArgs = [t.category, ...Object.entries({...f, failures:t.failures, ...(owner?{owner}:{})}).filter(([k])=>!['json','table','dry'].includes(k)).flatMap(([k,v])=>[`--${k}`,...(v===true?[]:[String(v)])])];
  const estimatedRows = (plan.trace?.candidates ?? []).map((r) => r.predicates.some((p)=>p.reason?.code==='PROVIDER_QUOTA_DENIED')
    ? {...r, estimate:estimateCandidate(t,snapshot,r.candidate,{capacityReset:true})} : r);
  const eta = estimatedRows.filter((r)=>r.predicates.every((p)=>p.ok || p.reason?.code==='PROVIDER_QUOTA_DENIED'))
    .filter((r)=>!seat || r.candidate.effort===seat.candidate.effort).map((r)=>({ ...r.estimate, model:r.candidate.modelId, account:r.candidate.accountId, effort:r.candidate.effort,
      unknown:r.estimate.confidence==='UNKNOWN', lane:{position:known(candidateParts(snapshot,r.candidate).lane.position),drainPerMin:known(candidateParts(snapshot,r.candidate).lane.drainPerMin)} }));
  const low = c && company(candidateParts(snapshot,c).account) && (seat.estimate.patienceMin!==null);
  let patience = low ? seat.estimate.patienceMin ?? 30 : null;
  const altRows = estimatedRows.filter((r)=>r.candidate.accountId!==c?.accountId || r.candidate.modelId!==c?.modelId)
    .filter((r)=>company(candidateParts(snapshot,r.candidate).account) && r.predicates.every((p)=>p.ok || p.reason?.code==='PROVIDER_QUOTA_DENIED'));
  const alternative = altRows.sort((a,b)=>Number(!!a.estimate.stalled)-Number(!!b.estimate.stalled)
    || (a.estimate.completionMin??Infinity)-(b.estimate.completionMin??Infinity))[0];
  if(low&&alternative?.estimate.startDelayMin>0) patience=Math.min(patience,alternative.estimate.startDelayMin*.25);
  const altArgs = [...routeArgs];
  for(const key of ['--fresh','--exclude-lane']) { const i=altArgs.indexOf(key); if(i>=0) altArgs.splice(i,key==='--fresh'?1:2); }
  if(c) altArgs.push('--exclude-lane',[f['exclude-lane'],`${c.accountId}:${c.modelId}`].filter(Boolean).join(','));
  const queueAlternative = low ? { model:alternative?.candidate.modelId??null,account:alternative?.candidate.accountId??null,
    basis:alternative?.estimate.basis??null,startDelayMin:alternative?.estimate.startDelayMin??null,routeArgs:altArgs } : null;
  const queueAlt = low ? `${alternative?.estimate.capacityReset ? 'scheduled dispatch: ' : ''}${command(['node',`${root}/scripts/route.mjs`,...altArgs])}` : null;
  const launch = (s, executable) => {
    const c=s.candidate, task=s.task, a=candidateParts(snapshot,c).account;
    const cwd=task.flags.cwd?task.cwd:'<workspace>', taskDir=task.flags['task-dir']?task.taskDir:'<task dir>';
    const launchModel=a.kind==='trae'?(profiles[c.accountId]?.modelIds?.[c.modelId]??c.modelId):c.modelId;
    const primary=s.role==='primary', suffix=primary?'':`-${s.role}`;
    const vendor=c.family==='claude'?'claude':'codex', an=c.accountId, name=`${task.flags.name??task.taskId}${suffix}`;
    const outputBase=`${taskDir}/codex${suffix}`;
    const seatLow=company(a)&&s.estimate.patienceMin!==null;
    const seatPatience=seatLow?s.estimate.patienceMin??30:null;
    const out={vendor,model:c.modelId,effort:c.effort,account:vendor==='claude'?undefined:an,company:company(a),sandbox:vendor==='claude'?null:task.sandbox,
      launcher:vendor==='claude'?'claude-bg':'codex-worker',command:null};
    if(!executable) return out;
    const prompt=`${primary?'':`Act as the independent ${s.role} reviewer of artifact ${task.artifactRevision}. `}Read ${taskDir}/brief.md and follow it.`;
    const routed={name,project:task.project,category:task.category,role:s.role,account:an,model:c.modelId,effort:c.effort,sandbox:task.sandbox,
      company:company(a),routeId:plan.routeId,approvalRef:f['user-ok']??null};
    const audit=command(['node',`${root}/scripts/launch-audit.mjs`,'--name',name,'--project',task.project,'--role',s.role,'--vendor',vendor,'--account',an,'--model',c.modelId,
      '--effort',c.effort,'--sandbox',task.sandbox,'--routed-seat',JSON.stringify(routed),...(f['user-ok']?['--user-ok',f['user-ok']]:[])]);
    if(vendor==='claude') {
      const trustedCwd = context.trustedCwd ?? task.flags['trusted-cwd'] ?? cwd;
      if (!task.flags['trusted-cwd'] && !context.trustedCwd) notes.push('Claude launch: no trusted project root configured; launch uses the working directory; verify it is trusted or pass --trusted-cwd with the trusted project root.');
      const claudePrompt = `Working directory: ${cwd}. ${prompt}`;
      out.command=`${audit} && cd ${shellQuote(trustedCwd)} && ${command(['claude','--bg','--remote-control','--permission-mode','bypassPermissions','-n',name,'--model',c.modelId,'--effort',c.effort,'--append-system-prompt',`Global worker rules ${digest.version}\n${digest.worker}`,claudePrompt])}`;
      return out;
    }
    const args=['--account',an,'start','--cwd',cwd,'--model',launchModel,'--effort',c.effort,'--sandbox',task.sandbox,'--name',name,
      ...(primary?['--route-args',JSON.stringify(routeArgs),'--auto-reroute-depth',String(task.autoRerouteDepth)]:[]),'--log',`${outputBase}.jsonl`,'--out',`${outputBase}-last.md`];
    if(owner) args.push('--owner',owner);
    args.push('--project',task.project,'--role',s.role,'--routed-seat',JSON.stringify(routed));
    if(task.background) args.push('--background');
    if(f['user-ok']) args.push('--user-ok',f['user-ok']);
    if(task.flags.network) args.push('--network',task.flags.network);
    if(seatPatience!==null) args.push('--queue-patience-min',String(seatPatience),'--alt',primary?queueAlt:'Return this result to the owner and replan the required reviewer set, preserving artifact and family independence.',...(primary?['--queue-alternative',JSON.stringify(queueAlternative)]:[]));
    if(primary&&queueAlternative?.startDelayMin!==null && queueAlternative?.startDelayMin!==undefined) args.push('--queue-alt-start-min',String(queueAlternative.startDelayMin));
    if(task.category==='computer-use') args.push('--computer-use-apps',task.allowedApps.join(','));
    if(['browser','ui-browser'].includes(task.category)) args.push('--browser-origins',task.allowedOrigins.join(','));
    if(task.flags['no-browser-preflight']) args.push('--no-browser-preflight');
    out.workerArgs=args;
    const oneShot=['lookup','extract','draft','image-gen','second-opinion'].includes(task.category)&&!task.background&&!f.worker&&!low&&c.modelId!=='gpt-6-astra';
    if(oneShot) {
      const bin=a.kind==='trae'?(profiles[an]?.bin??'traecli'):'codex';
      const readOnlyNetwork=task.flags.network&&task.sandbox==='read-only', profile=`route_read_only_${plan.planHash}`;
      const sandboxArgs=readOnlyNetwork?['-c',`default_permissions="${profile}"`,'-c',`permissions.${profile}.extends=":read-only"`,
        '-c',`permissions.${profile}.network.enabled=${task.flags.network==='on'}`]:['-s',task.sandbox];
      const accountEnv=profiles[an]?.home?`CODEX_HOME=${shellQuote(profiles[an].home)} `:'';
      const inner=(a.kind==='ttadk'&&known(a.capabilities.search)?`${command(['node',`${root}/scripts/codex-worker.mjs`,'--account',an,'proxy'])} >/dev/null && `:'')+accountEnv+command([bin,'exec','--skip-git-repo-check','-C',cwd,...sandboxArgs,'-m',launchModel,'-c',`model_reasoning_effort="${c.effort}"`,
        ...(task.flags.network&&task.sandbox==='workspace-write'?['-c',`sandbox_workspace_write.network_access=${task.flags.network==='on'}`]:[]),
        '-c',`developer_instructions=${JSON.stringify(`Global worker rules ${digest.version}\n${digest.worker}`)}`,'--json','-o',`${taskDir}/codex${suffix}-last.md`,prompt]);
      out.launcher=a.kind==='trae'?'traecli-exec':'codex-exec';
      out.command=command(['sh',`${root}/scripts/run-tracked.sh`,'--name',name,'--account',an,'--model',c.modelId,'--effort',c.effort,'--cwd',cwd,
        '--out',`${taskDir}/codex${suffix}-last.md`,'--log',`${taskDir}/codex${suffix}.jsonl`,...(owner?['--owner',owner]:[]),'--','sh','-c',`${audit} && ${inner}`]);
    } else out.command=command(['node',`${root}/scripts/codex-worker.mjs`,...args,prompt]);
    return out;
  };
  if(c) {
    const account=candidateParts(snapshot,c).account;
    if(!companyDevice(snapshot)&&account.kind==='chatgpt')
      why.push(`no company account on this device: personal ChatGPT account ${account.id} is the default lane`);
    why.push(`ETA: ${eta.length?eta.map(e=>`${company(snapshot.accounts.find(a=>a.id===e.account))?'company':'personal'} ${etaText(e)}`).join('; '):`${company(account)?'company':'personal'} ${c.modelId}@${c.accountId}, est. ${seat.estimate.completionMin} min`}; selected by policy, qualified floor and completion ETA`);
    if(adversarial(t)) why.push('adversarial: no GPT model on any account; Kimi-K3, DeepSeek-V4.1-Flash, then scoped Opus; two independent non-GPT families required.');
    if(candidateParts(snapshot,c).lane.mode==='low-priority') why.push(`TRAE ${c.modelId} low-priority lane (bucket depleted): provider capacity remains eligible with bounded queue patience.`);
    if(seat.estimate.basis==='progressing') why.push(`${c.modelId} low-priority lane (bucket depleted): slower bucket designation, but progressing without queue cycles in fresh per-model telemetry.`);
    if(['browser','ui-browser'].includes(t.category)&&c.family==='claude') notes.push('Claude in Chrome: select_browser, then work only in task-created tabs; never switch to another connected browser.');
    if(t.writes||['browser','computer-use'].includes(t.category)) notes.unshift("brief: include the safety clauses — never overwrite, delete or move files outside the task's scope (user files, uncommitted changes, shared headers/configs); restore anything touched by mistake byte-for-byte and report it");
    notes.push(`Global worker rules ${digest.version}: ${digest.worker}`);
    notes.push('brief: include the credential clause — never read, copy, load or inject LOGIN material, CLI auth files, sessions, cookies, keys or browser profiles. Use installed, already signed-in CLIs through normal commands, and let ssh/git use the normal ~/.ssh config and default keys (never override GIT_SSH_COMMAND/-F/IdentityFile to avoid them); service keys the user put in the project config may be used by running the project code for the official API of that service, never printed, copied or sent elsewhere; an authentication error is BLOCKED. '+
      (hasSigning?'Registered own-test packages use ordinary full-access Codex-family signing workers; identities.json and registry.json are read-only to workers, unlisted identities or packages are BLOCKED. ':'')+
      'never put internal code, logs or private material into public search queries.');
    if(t.writes) notes.push('back up app data before any destructive step; restore accidental out-of-scope changes byte-for-byte.');
    if(f['shared-lock']||f['device-lease']) notes.push('take the lease/lock only after the first model response; return every owned resource before a queue handoff.');
    if(hasDeepSeek&&['implement','implement-hard','debug'].includes(t.category)) notes.push('DeepSeek: read-only analysis and simple edits only; not full-package builds, auth/storage reviews or acceptance — re-route with --exclude-model deepseek if the brief needs those checks.');
    if(c.family==='deepseek') notes.push("DeepSeek can't emit one very large file in a single turn (output limit); split the work or exclude deepseek. Build and executable acceptance must use a capable finisher; this model can't see images.");
    if(c.family==='gemini'&&company(candidateParts(snapshot,c).account)&&!t.background) notes.push('Gemini-3.1-Pro ran past 40 minutes in 3 of 12 benchmark runs: if it shows no progress for 20 minutes, or runs past twice what the task should take, interrupt it and re-route with --exclude-model gemini (same --failures)');
    if(candidateParts(snapshot,c).account.kind==='ttadk'&&known(candidateParts(snapshot,c).account.capabilities.search)) notes.push('web search: use the local proxy; never put internal code or private logs into public queries.');
    if(t.category==='image-read') notes.push('read the supplied image directly; no web search is needed for screenshot transcription.');
    if(t.sandbox==='danger-full-access') notes.push('full access: the worker may commit on its task branch if the brief says so; never push to main, never force-push; commits carry no co-author/tool trailer');
    if(t.runsTests&&!t.writes) notes.push('workspace-write only for test-generated files; the reviewer must not edit source code');
    if(reviewAfterWrite(t,snapshot,c)) notes.push(`review required (class ${t.reviewClass}, impact ${t.impact}): pin the artifact before its gated action/acceptance, route.mjs ${deriveReview(t).category} --review-class ${t.reviewClass} --review-reason ${shellQuote(t.reviewReason)} --review-scope ${shellQuote(t.reviewScope??t.flags.name??t.taskId)} --author ${c.family==='claude'?'claude':'codex'}${['deepseek','gemini','seed'].includes(c.family)?` --exclude-model ${c.family}`:''}${t.contentLabels.includes('security')?' --security':''} --impact ${t.impact} --project ${t.project} --name ${f.name??t.taskId}-R; pin the actual author and artifact; blocks only on P0/P1, at most 2 rounds; then record with scripts/outcome.mjs --reviewed`);
    else if(!noReview&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push(`no review (impact ${t.impact}): accept on your own check (tests, build, acceptance), then record with scripts/outcome.mjs`);
    if(isReview(t)) notes.push('re-reviews check only the previously blocked findings; at most two review rounds per task/branch. Batch related small changes; docs/rule-text-only fixes need owner diff verification, not another review round.');
  }
    if(['build-run','implement','implement-hard','debug','ui-browser'].includes(t.category)) {
      if(t.execution==='remote') notes.push('remote/CI build (--no-local-build): no local heavy-build/lane lock and no local verify throttle — do not take res locks or pass --shared-lock; shared remote entry scripts stay unthrottled');
      else notes.push('build brief: full-package builds must use scripts/heavy-build.sh or an equivalent ONE-process wrapper around res take-build/wait-build/return-build (res v1.5): acquire heavy-build plus one free admitted lane together, holding neither resource while waiting for the other; live full-build waiters receive the next free lane in FIFO order, without reservations for dead, gate-blocked or foreign-held builds; reverse return on every exit. Normal gate remains min(20, 12 + 8 * other lanes), memory >=16 GiB; STALE and caller-owned locks excluded. lane 3 is available only after reviewed owner switch, at load1m <=8 AND available memory >=32 GiB; lane3=OPEN|CLOSED. UNKNOWN blocks admission; timeout means report/queue. Locks are only for genuine local heavy compute; remote pipeline deploys and CI runs never take one; use --no-local-build. One long-lived watched wrapper owns acquisition/build/return; never hold a device/build resource while queued.');
    }
    notes.push('takeover/continuation and publish/build-run brief: carry the full checked checklist — exact commands, non-secret variables and expected artifacts. Never write "repeat the last steps".');
    if(t.category==='build-run') notes.push(t.env==='test'&&t.stakes!=='high'?'test-environment build-run: follow written steps and pinned health/restore checks; report unexpected errors. env=test does not prove the run is remote.':'deploy/release brief: pin baseline/control probes, health thresholds, sample intervals and observation window, rollback triggers and exact prior artifact/config restore steps before acting; unexpected evidence needs stronger-model judgment.');
    if(phones.length&&(['build-run','ui-browser','computer-use'].includes(t.category)||f['device-lease'])) notes.push(`registered shared test phones ${phones.join(', ')} are pre-authorized for OUR OWN apps: tap ordinary Allow/Authorize/Trust/OK dialogs without a new per-prompt card. Never operate personal iPhone 15 Pro Max or unregistered devices. Device lease: at most 2 h; back up app data before a destructive reinstall/wipe/erase; take the lease/lock only after the first model response.`);
    if(['browser','ui-browser'].includes(t.category)) notes.push('Chrome must be running before the worker starts; use the named signed-in browser and exact origins. Never switch to another connected browser or bypass a login. Public/local Playwright does not grant signed-in console access.');
    if(t.category==='computer-use') notes.push('Computer Use via node_repl: operate only the specified apps; the screen must stay unlocked. Missing desktop tool or vision is BLOCKED.');
    if(['browser','ui-browser','computer-use'].includes(t.category)) {
      notes.push('a Codex or TRAE browser worker uses the browser its own tool lists; never put a Claude-in-Chrome deviceId in its brief (that id is only for Claude workers)');
      notes.push('A thread whose saved browser permission says "declined approval" or "saved permission … denies access" cannot be continued for that site; start a new thread with --browser-origins.');
    }
    if(t.contentLabels.includes('security')) notes.push('brief: describe defensive intent and ask for findings with impact and fix; avoid requesting step-by-step exploit code. A policy block must never be retried on any GPT account.');
    if(f.defensive) { why.push('defensive confirmation: preserve ordinary security routing'); notes.push('defensive confirmation (--defensive): give only the rule to hold and its acceptance conditions; no bypass description. On a cyber-policy block, do not retry that thread and do not resend it to any GPT account; re-route with --adversarial for Kimi-K3 plus a DeepSeek-V4.1-Flash second reviewer. Resolve disagreements by whichever side reproduces it with an executable test.'); }
  if(c) {
    if(candidateParts(snapshot,c).account.kind==='ttadk') notes.push('on TTADK: if rate-limited, retry it once; on repeated infrastructure failure re-route with --exclude-account and preserve the actual attempt floor.');
    if(candidateParts(snapshot,c).account.kind==='trae') {
      notes.push('on TRAE CLI: provider-assigned low-priority/depleted lanes remain capacity. Launch queued work through the hub; queue patience confirms no-work cancellation before a company replacement. Keep the real model/effort floor, owner and max 2 hops; parallel task concurrency unchanged.');
      if(['browser','ui-browser'].includes(t.category)) {
        why.push("TRAE via Playwright extension in the user's Chrome");
        notes.push("TRAE browser path: use Playwright MCP browser_* tools in the user's Chrome. The allowed-sites list is stated to the worker but not enforced technically on TRAE (no per-site approvals as on TTADK): name the exact sites and the read/write scope in the brief, and keep irreversible actions behind the user's confirmation.");
        notes.push("brief (TRAE browser): the Playwright Extension connects to the user's already signed-in Chrome; use only the configured origins and never read browser profiles, cookies, storage or the pairing token. If the extension/browser is unreachable, report BLOCKED with the exact Playwright error; never attempt a sign-in workaround. Git commits must carry no co-author or tool trailer");
      } else notes.push("brief (TRAE): the default headless Playwright MCP is for public/local pages only; signed-in consoles require a routed browser task with console origins and an already signed-in browser/account named in the brief. Missing login means BLOCKED, never a Playwright sign-in workaround; git commits must carry no co-author or tool trailer");
    }
    if(t.failures>=2&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push('a new defect of the same kind means stop patching: analyze the contract/interface, then reset acceptance checks.');
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("if the last miss was spec/process, amend the brief's acceptance first and say what changed; record outcome --actual. A repeated defect needs contract/interface analysis, not another unchanged patch.");
  }
  if(t.failures>=2&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push('a new defect of the same kind means stop patching: analyze the contract/interface, then reset acceptance checks.');
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("rework thread rule: use the actual accepted attempt floor. May continue the original author thread only for a same-task fix with useful context and no escalation/exclusion; record outcome.mjs --actual and ledger: continued original thread because ...");
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("if the last miss was spec/process, amend the brief's acceptance first; record what changed before another attempt.");
  if(snapshot.accounts.some(a=>known(a.transport)!==true)||!c) notes.push('hub check: list --limit 1; only if unreachable report to the global-rules owner; never restart shared hubs without ownership.');
  if(hasDeepSeek&&['implement','implement-hard','debug'].includes(t.category)&&!c) notes.push('DeepSeek: read-only analysis and simple edits only; not full-package builds, auth/storage reviews or acceptance; use --exclude-model deepseek for those checks.');
  if(['build-run','ui-browser','computer-use'].includes(t.category)||f['device-lease']) {
    notes.push("device work uses a guarded executor with continuous idle evidence and every orchestrator's release; lease at most 2 h, then return the device and report; device connected, unlocked, app data backed up.");
    if(phones.length) notes.push(`registered shared test phones ${phones.join(', ')}: ordinary Allow/Authorize/Trust/OK dialogs have no per-prompt approval or button whitelist; includes camera, microphone, photos, notifications, local network, tracking, developer trust, USB debugging and install confirmations. Never operate personal iPhone 15 Pro Max (policy=never) or a device not registered in res.`);
    notes.push('iOS app-data backup: exclude iOS-protected Library/SplashBoard/; verify the backup is readable before any install. When save data matters, install over the top to preserve it; destructive reinstall/wipe/erase requires a verified backup.');
    notes.push('Take/return through res; lease <=2 h; back up app data before destructive operations; never enter personal-account credentials, passwords or verification codes; no purchases. If Codex refuses an allowed device prompt, re-route that step to Claude instead of asking the user to tap it.');
  }
  if(c&&candidateParts(snapshot,c).account.kind==='trae') {
    const mode=candidateParts(snapshot,c).lane.mode;
    if(mode==='bucket-free') why.push(`${t.background?'background: ':''}${c.modelId} has no daily bucket; no high-priority quota spent; no low-priority lane (step 2)`);
    else if(t.background) why.push(`background: ${mode==='low-priority'?`${c.modelId} low-priority lane; no high-priority quota spent (step 1)`:`normal TRAE pick ${c.modelId}; may spend high-priority quota (step 3)`}`);
    if(t.background) notes.push('Background work uses the same quality ladder and quota permission; report a decision when no runnable authorized lane exists.');
  }
  if(plan.reviewers.length) notes.push('Reviewer seats use distinct worker names and output files. If a second reviewer cannot complete, return to the owner to replan the required set against the same artifact and independent families; do not reuse the primary reroute arguments.');
  if(t.background&&!c) tellUser.push('No runnable authorized background lane: present the plan’s decision and keep dispatching independent work.');
  if(plan.kind==='blocked') why.unshift(...plan.reasons.map(r=>r.text));
  if(!why.length) why.push(...(plan.reasons??[plan.reason]).filter(Boolean).map((r)=>r.text));
  if(companyDevice(snapshot)&&(plan.kind==='defer' || (plan.kind==='blocked' && plan.gates.some(g=>g.kind==='personal-quota')))) {
    const reset=plan.deferUntil??Math.min(...snapshot.accounts.filter(company).map(a=>known(a.denialResetAt)).filter(at=>at>snapshot.decisionAt));
    const question=`No company lane can start now. Use personal quota now, or wait until ${Number.isFinite(reset)?new Date(reset).toISOString():'company lane progress'}?`;
    needsUserOK.push(question);tellUser.push(question);
  }
  notes.push(`launch as a background task (run_in_background) - never detach with & inside another command. Every launch must be tracked or covered by an armed codex-worker watch --owner ${owner??'<session-id>'}; re-arm after every wake and handle finished workers first.`);
  notes.push('brief: workers use codex-worker ask only for an unsettled decision that changes their next action, with --default; note is for a discovered risk, scope change or milestone needed before completion, never routine progress. Answer promptly with codex-worker reply; after the question timeout the worker uses its default, or ends BLOCKED without one.');
  notes.push('brief: bare note/ask discover the newest running worker context matching cwd if thread flags/environment are absent. In restricted sandboxes denied shared writes relay through command output; if ask exits 6, the worker runs its printed ask --await ID command to read the original reply, without repeating the question or widening the sandbox.');
  notes.push('brief: keep --out separate from any file the worker is asked to write; --out receives the final message and can overwrite that deliverable.');
  notes.push('launch audit: every launch must match its route/actual task identity; --user-ok is only a reference to a real scoped decision, never inferred from urgency.');
  const profile=snapshot.projectProfiles?.[t.project]; if(profile) notes.push(`project profile ${profile.profile}${profile.landingGate ? `; landing gate: ${profile.landingGate}` : ''}`);
  const blocked=plan.kind==='blocked', pick=seat?launch(seat,plan.kind==='launch'):null;
  return { category:t.category,stakes:t.stakes,failures:t.failures,failureKind:t.failureKind,security:t.contentLabels.includes('security'),adversarial:adversarial(t),defensive:!!f.defensive,signing:!!f.signing,
    background:t.background,tier:t.tier,kind:plan.kind,blocked,executable:plan.kind==='launch',routeId:plan.routeId,planHash:plan.planHash,
    deferred:plan.kind==='defer'?plan.reason.text:(!pick&&blocked?plan.reasons.map((r)=>r.text).join('; '):null),
    deferUntil:plan.deferUntil??null,deferReason:plan.reason?.text??null,deferRunnerUp:plan.runnerUp?{model:plan.runnerUp.modelId,account:plan.runnerUp.accountId}:null,
    eta,queuePatienceMin:patience,queueAlt,queueAlternative,pick,secondOpinion:plan.reviewers[0]?launch(plan.reviewers[0],plan.kind==='launch'):plan.reviewerProposals?.[0]?launch(plan.reviewerProposals[0],false):null,
    needsUserOK:[...new Set(needsUserOK)],tellUser:[...new Set(tellUser)],why,notes,
    redeemFirst:c?known(candidateParts(snapshot,c).account.budget)?.redemption??null:null,balance,quota,quotaSummary,plan };
}
