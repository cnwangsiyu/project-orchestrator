// Pure compatibility rendering. Receives paths, owner and digest from the CLI;
// it never launches, reads metadata, or changes the selected tuple.
import { company, known, adversarial, isReview } from './common.mjs';
import { candidateParts } from './candidates.mjs';
import { reviewAfterWrite } from './review-policy.mjs';
import { estimateCandidate } from './estimate.mjs';
import { etaText } from '../eta.mjs';
import { modelPreference } from './policy.mjs';
export const shellQuote = (v) => /^[a-zA-Z0-9_./:@-]+$/.test(String(v)) ? String(v) : `'${String(v).replaceAll("'", "'\\''")}'`;
const command = (args) => args.map(shellQuote).join(' ');
export function presentRoute(plan, view, context) {
  const { snapshot, root, owner, profiles = {}, digest = { version:'UNKNOWN',worker:'' } } = context;
  const t = plan.task, f = t.flags, seat = plan.primary ?? plan.primaryProposal, c = seat?.candidate;
  const notes = [...view.notes], why = [], tellUser = [...view.tellUser], needsUserOK = [...view.needsOK];
  const unknownCompany=snapshot.accounts.filter(a=>company(a)&&(known(a.auth)!==true||known(a.transport)!==true));
  const quota=snapshot.accounts.map(a=>`${a.id}/${a.kind}: ${known(a.auth)===true&&known(a.transport)===true?'available status':'company account state unknown or unavailable'}`);
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
  const balance = balanceCandidates.length ? {...(chosenBalance ?? {}),selected:!!chosenBalance?.eligible,candidates:walked} : null;
  if(seat?.estimate.expiryOpportunity) { const hint='TTADK quota expiring unused: good time for reviews, docs and exploratory work'; why.push(hint);quota.push(hint); }
  if(chosenBalance?.eligible) {why.push(`balanced to TRAE: ${chosenBalance.triggers.join('; ')}; ${Math.round(chosenBalance.remainingShare*100)}% left; load ${chosenBalance.load?.percent??'unknown'}%`);notes.push('balanced from TTADK after fresh reserve/load checks; task quality and review obligations are preserved.');}
  if(c && candidateParts(snapshot,c).account.kind==='ttadk' && balanceCandidates.length) {
    const reasons = [...new Set(balanceCandidates.flatMap(b=>b.reasons))];
    why.push(`stays on TTADK: ${t.tier==='hard'?'no hard-tier TRAE transfer; ':''}${reasons.join('; ') || 'tool/resource scope or completion ETA retains this account'}`);
  }
  if(context.refreshRequired) notes.push('--fresh: account status refreshed through authenticated read-only interfaces.');
  if(context.retryAssumption) why.push(context.retryAssumption);
  for(const warning of plan.warnings??[]) { why.push(warning.text);tellUser.push(warning.text); }
  for(const gate of plan.gates.filter((g)=>g.state==='needsOK')) {
    if(gate.kind==='personal-quota') needsUserOK.push(`personal quota: ${gate.scope?.accounts.join(',')??'reviewer'} needs the user's scoped OK${unknownCompany.length?`; company account state unknown or unavailable (${unknownCompany.map(a=>`${a.id}/${a.kind}`).join(', ')})`:''}`);
    if(gate.kind==='max-effort') needsUserOK.push('max effort');
  }
  const routeArgs = [t.category, ...Object.entries({...f, failures:t.failures, ...(owner?{owner}:{})}).filter(([k])=>!['json','table','dry'].includes(k)).flatMap(([k,v])=>[`--${k}`,...(v===true?[]:[String(v)])])];
  const estimatedRows = (plan.trace?.candidates ?? []).map((r) => r.predicates.some((p)=>p.reason?.code==='PROVIDER_QUOTA_DENIED')
    ? {...r, estimate:estimateCandidate(t,snapshot,r.candidate,{capacityReset:true})} : r);
  const eta = estimatedRows.filter((r)=>r.predicates.every((p)=>p.ok || p.reason?.code==='PROVIDER_QUOTA_DENIED'))
    .filter((r)=>!seat || r.candidate.effort===seat.candidate.effort).map((r)=>({ ...r.estimate, model:r.candidate.modelId, account:r.candidate.accountId, effort:r.candidate.effort,
      unknown:r.estimate.confidence==='UNKNOWN', lane:{position:known(candidateParts(snapshot,r.candidate).lane.position),drainPerMin:known(candidateParts(snapshot,r.candidate).lane.drainPerMin)} }));
  const low = c && candidateParts(snapshot,c).account.kind==='trae' && ['low-priority','UNKNOWN'].includes(candidateParts(snapshot,c).lane.mode);
  const patience = low ? seat.estimate.patienceMin ?? 30 : null;
  const altRows = estimatedRows.filter((r)=>r.candidate.accountId!==c?.accountId || r.candidate.modelId!==c?.modelId)
    .filter((r)=>r.candidate.effort===c?.effort && r.predicates.every((p)=>p.ok || p.reason?.code==='PROVIDER_QUOTA_DENIED'));
  const alternative = altRows.sort((a,b)=>Number(!!a.estimate.stalled)-Number(!!b.estimate.stalled)
    || (a.estimate.completionMin??Infinity)-(b.estimate.completionMin??Infinity))[0];
  const altArgs = [...routeArgs];
  for(const key of ['--fresh','--exclude-lane']) { const i=altArgs.indexOf(key); if(i>=0) altArgs.splice(i,key==='--fresh'?1:2); }
  if(c) altArgs.push('--exclude-lane',[f['exclude-lane'],`${c.accountId}:${c.modelId}`].filter(Boolean).join(','));
  const queueAlternative = low ? { model:alternative?.candidate.modelId??null,account:alternative?.candidate.accountId??null,
    basis:alternative?.estimate.basis??null,startDelayMin:alternative?.estimate.startDelayMin??null,routeArgs:altArgs } : null;
  const queueAlt = low ? `${alternative?.estimate.capacityReset ? 'scheduled dispatch: ' : ''}${command(['node',`${root}/scripts/route.mjs`,...altArgs])}` : null;
  const launch = (s, executable) => {
    const c=s.candidate, task=s.task, a=candidateParts(snapshot,c).account;
    const launchModel=a.kind==='trae'?(profiles[c.accountId]?.modelIds?.[c.modelId]??c.modelId):c.modelId;
    const primary=s.role==='primary', suffix=primary?'':`-${s.role}`;
    const vendor=c.family==='claude'?'claude':'codex', an=c.accountId, name=`${task.flags.name??task.taskId}${suffix}`;
    const outputBase=`${task.taskDir}/codex${suffix}`;
    const seatLow=a.kind==='trae'&&['low-priority','UNKNOWN'].includes(candidateParts(snapshot,c).lane.mode);
    const seatPatience=seatLow?s.estimate.patienceMin??30:null;
    const out={vendor,model:c.modelId,effort:c.effort,account:vendor==='claude'?undefined:an,company:company(a),sandbox:vendor==='claude'?null:task.sandbox,
      launcher:vendor==='claude'?'claude-bg':'codex-worker',command:null};
    if(!executable) return out;
    const prompt=`${primary?'':`Act as the independent ${s.role} reviewer of artifact ${task.artifactRevision}. `}Read ${task.taskDir}/brief.md and follow it.`;
    const audit=command(['node',`${root}/scripts/launch-audit.mjs`,'--name',name,'--vendor',vendor,'--account',an,'--model',c.modelId,
      ...(vendor==='codex'?['--sandbox',task.sandbox]:[]),...(f['user-ok']?['--user-ok',f['user-ok']]:[])]);
    if(vendor==='claude') {
      out.command=`${audit} && cd ${shellQuote(task.cwd)} && ${command(['claude','--bg','--remote-control','--permission-mode','bypassPermissions','-n',name,'--model',c.modelId,'--effort',c.effort,'--append-system-prompt',`Global worker rules ${digest.version}\n${digest.worker}`,prompt])}`;
      return out;
    }
    const args=['--account',an,'start','--cwd',task.cwd,'--model',launchModel,'--effort',c.effort,'--sandbox',task.sandbox,'--name',name,
      ...(primary?['--route-args',JSON.stringify(routeArgs),'--auto-reroute-depth',String(task.autoRerouteDepth)]:[]),'--log',`${outputBase}.jsonl`,'--out',`${outputBase}-last.md`];
    if(owner) args.push('--owner',owner);
    if(task.background) args.push('--background');
    if(f['user-ok']) args.push('--user-ok',f['user-ok']);
    if(seatPatience!==null) args.push('--queue-patience-min',String(seatPatience),'--alt',primary?queueAlt:'Return this result to the owner and replan the required reviewer set, preserving artifact and family independence.',...(primary?['--queue-alternative',JSON.stringify(queueAlternative)]:[]));
    if(primary&&queueAlternative?.startDelayMin!==null && queueAlternative?.startDelayMin!==undefined) args.push('--queue-alt-start-min',String(queueAlternative.startDelayMin));
    if(task.category==='computer-use') args.push('--computer-use-apps',task.allowedApps.join(','));
    if(['browser','ui-browser'].includes(task.category)) args.push('--browser-origins',task.allowedOrigins.join(','));
    out.workerArgs=args;
    const oneShot=['lookup','extract','draft','image-gen','second-opinion'].includes(task.category)&&!task.background&&!f.worker&&!low&&c.modelId!=='gpt-6-astra';
    if(oneShot) {
      const bin=a.kind==='trae'?(profiles[an]?.bin??'traecli'):'codex';
      const inner=(a.kind==='ttadk'&&known(a.capabilities.search)?`${command(['node',`${root}/scripts/codex-worker.mjs`,'--account',an,'proxy'])} >/dev/null && `:'')+command([bin,'exec','-C',task.cwd,'-s',task.sandbox,'-m',launchModel,'-c',`model_reasoning_effort="${c.effort}"`,'-c',`developer_instructions=${JSON.stringify(`Global worker rules ${digest.version}\n${digest.worker}`)}`,'--json','-o',`${task.taskDir}/codex-last.md`,prompt]);
      const accountEnv=profiles[an]?.home?`CODEX_HOME=${shellQuote(profiles[an].home)} `:'';
      out.launcher=a.kind==='trae'?'traecli-exec':'codex-exec';
      out.command=command(['sh',`${root}/scripts/run-tracked.sh`,'--name',name,'--account',an,'--model',c.modelId,'--effort',c.effort,'--cwd',task.cwd,
        '--out',`${task.taskDir}/codex-last.md`,'--log',`${task.taskDir}/codex.jsonl`,...(owner?['--owner',owner]:[]),'--','sh','-c',`${audit} && ${accountEnv}${inner}`]);
    } else out.command=command(['node',`${root}/scripts/codex-worker.mjs`,...args,prompt]);
    return out;
  };
  if(c) {
    why.push(`company ETA: ${eta.length?eta.map(etaText).join('; '):`${c.modelId}@${c.accountId}, est. ${seat.estimate.completionMin} min`}; selected by policy, qualified floor and completion ETA`);
    if(adversarial(t)) why.push('adversarial: no GPT model on any account; Kimi-K3, DeepSeek-V4.1-Flash, then scoped Opus; two independent non-GPT families required.');
    if(candidateParts(snapshot,c).lane.mode==='low-priority') why.push(`TRAE ${c.modelId} low-priority lane (bucket depleted): provider capacity remains eligible with bounded queue patience.`);
    if(seat.estimate.basis==='progressing') why.push(`${c.modelId} low-priority lane (bucket depleted): slower bucket designation, but progressing without queue cycles in fresh per-model telemetry.`);
    if(['browser','ui-browser'].includes(t.category)&&c.family==='claude') notes.push('Claude in Chrome: select_browser, then work only in task-created tabs; never switch to another connected browser.');
    if(t.writes||['browser','computer-use'].includes(t.category)) notes.unshift("brief: include the safety clauses — never overwrite, delete or move files outside the task's scope (user files, uncommitted changes, shared headers/configs); restore anything touched by mistake byte-for-byte and report it");
    notes.push(`Global worker rules ${digest.version}: ${digest.worker}`);
    notes.push('brief: include the credential clause — never read, copy, load or inject LOGIN material, CLI auth files, sessions, cookies, keys or browser profiles. Use installed, already signed-in CLIs through normal commands; an authentication error is BLOCKED. Registered own-test packages use ordinary full-access Codex company signing workers; identities.json and registry.json are read-only to workers, unlisted identities or packages are BLOCKED. never put internal code, logs or private material into public search queries.');
    if(t.writes) notes.push('back up app data before any destructive step; restore accidental out-of-scope changes byte-for-byte.');
    if(f['shared-lock']||f['device-lease']) notes.push('take the lease/lock only after the first model response; return every owned resource before a queue handoff.');
    if(['implement','implement-hard','debug'].includes(t.category)) notes.push('DeepSeek: read-only analysis and simple edits only; not full-package builds, auth/storage reviews or acceptance — re-route with --exclude-model deepseek if the brief needs those checks.');
    if(c.family==='deepseek') notes.push("DeepSeek can't emit one very large file in a single turn (output limit); split the work or exclude deepseek. Build and executable acceptance must use a capable finisher; this model can't see images.");
    if(candidateParts(snapshot,c).account.kind==='ttadk'&&known(candidateParts(snapshot,c).account.capabilities.search)) notes.push('web search: use the local proxy; never put internal code or private logs into public queries.');
    if(t.category==='image-read') notes.push('read the supplied image directly; no web search is needed for screenshot transcription.');
    if(t.sandbox==='danger-full-access') notes.push('full access: the worker may commit on its task branch if the brief says so; never push to main, never force-push; commits carry no co-author/tool trailer');
    if(t.runsTests&&!t.writes) notes.push('workspace-write only for test-generated files; the reviewer must not edit source code');
    if(reviewAfterWrite(t,snapshot,c)) notes.push(`review required (impact ${t.impact}): after the worker reports, route.mjs ${t.stakes==='high'?'review-high':'review'} --author ${c.family==='claude'?'claude':'codex'}${['deepseek','gemini','seed'].includes(c.family)?` --exclude-model ${c.family}`:''}${t.contentLabels.includes('security')?' --security':''} --impact ${t.impact} --project ${t.project} --name ${f.name??t.taskId}-R; pin the actual author and artifact; blocks only on P0/P1, at most 2 rounds; then record with scripts/outcome.mjs --reviewed`);
    else if(['implement','implement-hard','debug','science'].includes(t.category)) notes.push(`no review (impact ${t.impact}): accept on your own check (tests, build, acceptance), then record with scripts/outcome.mjs`);
    if(isReview(t)) notes.push('re-reviews check only the previously blocked findings; at most two review rounds per task/branch. Batch related small changes; docs/rule-text-only fixes need owner diff verification, not another review round.');
  }
    if(['build-run','implement','implement-hard','debug','ui-browser'].includes(t.category)) {
      if(t.execution==='remote') notes.push('remote/CI build (--no-local-build): no local heavy-build/lane lock and no local verify throttle — do not take res locks or pass --shared-lock; shared remote entry scripts stay unthrottled');
      else notes.push('build brief: full-package builds must use scripts/heavy-build.sh or an equivalent ONE-process wrapper around res take-build/wait-build/return-build (res v1.4): acquire heavy-build plus one free admitted lane together, holding neither resource while waiting for the other; reverse return on every exit. Normal gate remains min(20, 12 + 8 * other lanes), memory >=16 GiB; STALE and caller-owned locks excluded. lane 3 is available only after reviewed owner switch, at load1m <=8 AND available memory >=32 GiB; lane3=OPEN|CLOSED. UNKNOWN blocks admission; timeout means report/queue. Locks are only for genuine local heavy compute; remote pipeline deploys and CI runs never take one; use --no-local-build. One long-lived watched wrapper owns acquisition/build/return; never hold a device/build resource while queued.');
    }
    if(t.category==='build-run') notes.push(t.env==='test'&&t.stakes!=='high'?'test-environment build-run: follow written steps and pinned health/restore checks; report unexpected errors. env=test does not prove the run is remote.':'deploy/release brief: pin baseline/control probes, health thresholds, sample intervals and observation window, rollback triggers and exact prior artifact/config restore steps before acting; unexpected evidence needs stronger-model judgment.');
    if(['build-run','ui-browser','computer-use'].includes(t.category)||f['device-lease']) notes.push('registered shared test phones iphone8, iphone11 and s21 are pre-authorized for OUR OWN apps: tap ordinary Allow/Authorize/Trust/OK dialogs without a new per-prompt card. Never operate personal iPhone 15 Pro Max or unregistered devices. Device lease: at most 2 h; back up app data before a destructive reinstall/wipe/erase; take the lease/lock only after the first model response.');
    if(['browser','ui-browser'].includes(t.category)) notes.push('Chrome must be running before the worker starts; use the named signed-in browser and exact origins. Never switch to another connected browser or bypass a login. Public/local Playwright does not grant signed-in console access.');
    if(t.category==='computer-use') notes.push('Computer Use via node_repl: operate only the specified apps; the screen must stay unlocked. Missing desktop tool or vision is BLOCKED.');
    if(t.contentLabels.includes('security')) notes.push('brief: describe defensive intent and ask for findings with impact and fix; avoid requesting step-by-step exploit code. A policy block must never be retried on any GPT account.');
    if(f.defensive) { why.push('defensive confirmation: preserve ordinary security routing'); notes.push('defensive confirmation (--defensive): give only the rule to hold and its acceptance conditions; no bypass description. On a cyber-policy block, do not retry that thread and do not resend it to any GPT account; re-route with --adversarial for Kimi-K3 plus a DeepSeek-V4.1-Flash second reviewer. Resolve disagreements by whichever side reproduces it with an executable test.'); }
  if(c) {
    if(candidateParts(snapshot,c).account.kind==='ttadk') notes.push('on TTADK: if rate-limited, retry it once; on repeated infrastructure failure re-route with --exclude-account and preserve the actual attempt floor.');
    if(candidateParts(snapshot,c).account.kind==='trae') notes.push('on TRAE CLI: provider-assigned low-priority/depleted lanes remain capacity. Launch queued work through the hub; queue patience confirms no-work cancellation before a company replacement. Keep the real model/effort floor, owner and max 2 hops; parallel task concurrency unchanged. No ChatGPT browser here; playwright MCP is for public/local pages only; missing login means BLOCKED.');
    if(t.failures>=2&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push('a new defect of the same kind means stop patching: analyze the contract/interface, then reset acceptance checks.');
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("if the last miss was spec/process, amend the brief's acceptance first and say what changed; record outcome --actual. A repeated defect needs contract/interface analysis, not another unchanged patch.");
  }
  if(t.failures>=2&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push('a new defect of the same kind means stop patching: analyze the contract/interface, then reset acceptance checks.');
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("rework thread rule: use the actual accepted attempt floor. May continue the original author thread only for a same-task fix with useful context and no escalation/exclusion; record outcome.mjs --actual and ledger: continued original thread because ...");
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("if the last miss was spec/process, amend the brief's acceptance first; record what changed before another attempt.");
  if(snapshot.accounts.some(a=>known(a.transport)!==true)||!c) notes.push('hub check: list --limit 1; only if unreachable report to the global-rules owner; never restart shared hubs without ownership.');
  if(['implement','implement-hard','debug'].includes(t.category)&&!c) notes.push('DeepSeek: read-only analysis and simple edits only; not full-package builds, auth/storage reviews or acceptance; use --exclude-model deepseek for those checks.');
  if(['build-run','ui-browser','computer-use'].includes(t.category)||f['device-lease']) {
    notes.push("device work uses a guarded executor with continuous idle evidence and every orchestrator's release; lease at most 2 h, then return the device and report; device connected, unlocked, app data backed up.");
    notes.push('registered shared test phones iphone8, iphone11 and s21: ordinary Allow/Authorize/Trust/OK dialogs have no per-prompt approval or button whitelist; includes camera, microphone, photos, notifications, local network, tracking, developer trust, USB debugging and install confirmations. Never operate personal iPhone 15 Pro Max (policy=never) or a device not registered in res.');
    notes.push('Take/return through res; lease <=2 h; back up app data before destructive operations; never enter personal-account credentials, passwords or verification codes; no purchases. If Codex refuses an allowed device prompt, re-route that step to Claude instead of asking the user to tap it.');
  }
  if(c&&candidateParts(snapshot,c).account.kind==='trae') {
    const mode=candidateParts(snapshot,c).lane.mode;
    if(mode==='bucket-free') why.push(`${t.background?'background: ':''}${c.modelId} has no daily bucket; no high-priority quota spent; no low-priority lane (step 2)`);
    else if(t.background) why.push(`background: ${mode==='low-priority'?`${c.modelId} low-priority lane; no high-priority quota spent (step 1)`:`normal TRAE pick ${c.modelId}; may spend high-priority quota (step 3)`}`);
    if(t.background) notes.push('Queued turns can expect hours when each model request queues separately; bounded queue patience and cancellation evidence control any replacement.');
  }
  if(plan.reviewers.length) notes.push('Reviewer seats use distinct worker names and output files. If a second reviewer cannot complete, return to the owner to replan the required set against the same artifact and independent families; do not reuse the primary reroute arguments.');
  if(t.background&&!c) tellUser.push('queued for later: keep the company-only task pending and replan when qualified capacity is available.');
  if(!why.length) why.push(...(plan.reasons??[plan.reason]).filter(Boolean).map((r)=>`${r.code}: ${r.text}`));
  if(plan.kind==='defer' || (plan.kind==='blocked' && plan.gates.some(g=>g.kind==='personal-quota'))) {
    const reset=plan.deferUntil??Math.min(...snapshot.accounts.filter(company).map(a=>known(a.denialResetAt)).filter(at=>at>snapshot.decisionAt));
    const question=`No company lane can start now. Use personal quota now, or wait until ${Number.isFinite(reset)?new Date(reset).toISOString():'company lane progress'}?`;
    needsUserOK.push(question);tellUser.push(question);
  }
  notes.push(`launch as a background task (run_in_background) - never detach with & inside another command. Every launch must be tracked or covered by an armed codex-worker watch --owner ${owner??'<session-id>'}; re-arm after every wake and handle finished workers first.`);
  notes.push('launch audit: every launch must match its route/actual task identity; --user-ok is only a reference to a real scoped decision, never inferred from urgency.');
  const profile=snapshot.projectProfiles?.[t.project]; if(profile) notes.push(`project profile ${profile.profile}; landing gate: ${profile.landingGate}`);
  const blocked=plan.kind==='blocked', pick=seat?launch(seat,plan.kind==='launch'):null;
  return { category:t.category,stakes:t.stakes,failures:t.failures,security:t.contentLabels.includes('security'),adversarial:adversarial(t),defensive:!!f.defensive,signing:!!f.signing,
    background:t.background,tier:t.tier,kind:plan.kind,blocked,executable:plan.kind==='launch',routeId:plan.routeId,planHash:plan.planHash,
    deferred:plan.kind==='defer'?plan.reason.text:(!pick&&blocked?plan.reasons.map((r)=>r.text).join('; '):null),
    deferUntil:plan.deferUntil??null,deferReason:plan.reason?.text??null,deferRunnerUp:plan.runnerUp?{model:plan.runnerUp.modelId,account:plan.runnerUp.accountId}:null,
    eta,queuePatienceMin:patience,queueAlt,queueAlternative,pick,secondOpinion:plan.reviewers[0]?launch(plan.reviewers[0],plan.kind==='launch'):plan.reviewerProposals?.[0]?launch(plan.reviewerProposals[0],false):null,
    needsUserOK:[...new Set(needsUserOK)],tellUser:[...new Set(tellUser)],why,notes,
    redeemFirst:c?known(candidateParts(snapshot,c).account.budget)?.redemption??null:null,balance,quota,quotaSummary,plan };
}
