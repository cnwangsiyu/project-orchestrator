import { WORKER_NOTES } from '../fixed-worker-notes.mjs';
// Pure compatibility rendering. Receives paths, owner and digest from the CLI;
// it never launches, reads metadata, or changes the selected tuple.
import { policyModel, isAstra, company, companyDevice, known, adversarial, isReview } from './common.mjs';
import { candidateParts } from './candidates.mjs';
import {mandatoryReview,projectReviewPolicy} from '../review-policy-data.mjs';
import { deriveReview } from './taskspec.mjs';
import { reviewAfterWrite } from './review-policy.mjs';
import { estimateCandidate } from './estimate.mjs';
import { etaText, taskEstimateText, laneStartText } from '../eta.mjs';
import { modelPreference } from './policy.mjs';
import { flagArgs } from '../route-args.mjs';
import { personalPriorityGuard } from './personal-priority.mjs';
import { transportLaneFailures } from '../worker-completion.mjs';
export const shellQuote = (v) => /^[a-zA-Z0-9_./:@-]+$/.test(String(v)) ? String(v) : `'${String(v).replaceAll("'", "'\\''")}'`;
const command = (args) => args.map(shellQuote).join(' ');
export function presentRoute(plan, view, context) {
  const { snapshot, root, owner, profiles = {}, digest:sourceDigest = { version:'UNKNOWN',worker:'' } } = context;
  const resources=known(snapshot.resources)??{}, hasTrae=snapshot.accounts.some(a=>a.kind==='trae');
  const phones=['iphone8','iphone11','s21'].filter(id=>(resources.registeredResources??[]).includes(id)||resources.devices?.[id]?.registered);
  const hasSigning=resources.signingRegistry===true;
  const digest={...sourceDigest,worker:(sourceDigest.coreWorker??sourceDigest.worker).split('\n').filter(line=>
    (hasSigning||!line.startsWith('- Allowed with'))&&(phones.length||!line.startsWith('- On registered shared test phones'))
    &&(hasTrae||!line.startsWith('- A queued TRAE'))).map(line=>line.replaceAll('iphone8/iphone11/s21',phones.join('/'))).join('\n')};
  const t = plan.task, f = t.flags, seat = plan.primary ?? plan.primaryProposal, c = seat?.candidate;
  const fixedNotes = [];
  const notes = [...view.notes,...(t.policyNotes??[])], why = [...(t.policyNotes??[])], tellUser = [...view.tellUser], needsUserOK = [...view.needsOK];
  if(c && candidateParts(snapshot,c).account.kind==='chatgpt' && plan.trace?.comparator?.personalLaunchWhy)
    why.push(plan.trace.comparator.personalLaunchWhy);
  if(snapshot.personalFallback?.enabled) {
    const i=notes.findIndex(line=>line.startsWith('Queue patience:'));
    if(i>=0)notes[i]=`Queue decision: notify the owner after >${snapshot.personalFallback.queueWaitMinutes} min; repeat after ${snapshot.personalFallback.queueReminderMinutes} min; owner chooses, no automatic switch.`;
  }
  if (plan.kind === 'launch' && snapshot.personalPriority?.mode === 'exclusive'
    && company(candidateParts(snapshot, c).account))
    why.push(`company lanes first; personal overflow only on main under the standing routing window ${snapshot.personalPriority.until === null ? 'until revoked' : `until ${snapshot.personalPriority.until}`}`);
  if (plan.kind === 'launch' && seat?.personalFallback) why.push(seat.personalFallback.text);
  if (plan.kind === 'launch' && seat?.personalFallback?.maxUnavailable) tellUser.push(seat.personalFallback.text);
  if (plan.kind === 'launch' && snapshot.personalPriority) for (const reviewer of plan.reviewers) {
    if (reviewer.personalFallback?.approvalRef === snapshot.personalPriority.userDecisionRef)
      why.push(`second reviewer: ${reviewer.personalFallback.text}`);
  }
  const priorityGuard = personalPriorityGuard(snapshot);
  if (priorityGuard) why.push(snapshot.personalPriority.mode === 'exclusive'
    ? `company lanes first; personal overflow only on main: ${priorityGuard}; other personal Codex accounts remain ineligible`
    : `personal main-first window until ${snapshot.personalPriority.until} paused: ${priorityGuard}; using normal routing order`);
  for (const text of new Set(plan.rejected.filter(p => p.reason?.code === 'TTADK_DAILY_RESERVE').map(p => p.reason.text)))
    if (!why.some(line => line.includes(text))) why.push(text);
  if (t.needsCli.length) notes.push('signed-in CLIs need the full-access sandbox (keychain); stay read-only by instruction: queries only, no writes');
  else if (f['read-only']) notes.push('read-only sandbox: keychain-backed CLIs (lark-cli, bytedcli) will not work; add --needs-cli if the task must use them');
  if(['implement','implement-hard','build-run','debug','ui-browser'].includes(t.category))fixedNotes.push(sourceDigest.worker.split('\n').find(line=>line.startsWith('- Project dependencies'))??'');
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
    return pref.indexOf(policyModel(a.model))-pref.indexOf(policyModel(b.model));
  });
  const chosenBalance = seat?.estimate.balance;
  const walked = chosenBalance ? balanceCandidates.slice(0,balanceCandidates.findIndex(b=>b.model===c.modelId)+1) : balanceCandidates;
  const balance = balanceCandidates.length ? {...(chosenBalance ?? {}),selected:!!(chosenBalance?.freeNow||chosenBalance?.eligible),candidates:walked} : null;
  if(seat?.estimate.expiryOpportunity) { const hint=candidateParts(snapshot,c).account.kind==='ttadk'?'TTADK quota expiring unused: good time for existing qualified work':`TRAE ${c.modelId} priority bucket expiring unused at ${new Date(seat.estimate.expiryEvidence.resetsAt).toISOString()}; quality order preserved`; why.push(hint);quota.push(hint); }
  if(chosenBalance?.freeNow) why.push(chosenBalance.astraUnitsEvidence
    ? `TRAE lane free: saving TTADK quota; Astra load not published; units ${chosenBalance.astraUnitsEvidence.used}/${chosenBalance.astraUnitsEvidence.limit} used; no queue observed; no recent Astra stall; TRAE hub healthy.`
    : `TRAE lane free: saving TTADK quota; ${c.modelId} load ${chosenBalance.load.percent}%; no queue or stall observed.`);
  else if(chosenBalance) why.push(`TRAE ${c.modelId}: bounded fallback; immediate uncongested capacity is unmeasured.`);
  if(c && candidateParts(snapshot,c).account.kind==='ttadk' && balanceCandidates.length) {
    const relevant=balanceCandidates.find(b=>policyModel(b.model)===policyModel(c.modelId));
    why.push(relevant?`stays on TTADK: ${relevant.model}: ${relevant.queued?'queue observed':relevant.congestion==='high'?'model congested':!relevant.freeNow?'no demonstrated immediate uncongested TRAE lane':'TRAE lane demoted by transport failures or required capability'}`:`stays on TTADK: ${c.modelId} has no qualified same-class TRAE lane for the required capability/catalog.`);
  }
  if(f.dry) notes.push(`--dry: preview only — no route decision is recorded, so do not launch from this output; run again without --dry. State is read as a real route would read it. Cache age: ${context.cacheAgeMs===null||context.cacheAgeMs===undefined?'UNKNOWN':`${Math.round(context.cacheAgeMs/1000)} seconds`}.`);
  if(context.refreshRequired) notes.push('--fresh: account status refreshed through authenticated read-only interfaces.');
  const staleAccounts=snapshot.accounts.filter(a=>a.auth.source==='last-good-stale').map(a=>a.id);
  if(staleAccounts.length) why.push(`Status read incomplete: retained last-good stale observations for ${staleAccounts.join(', ')}; original sample ages and admission checks remain in force.`);
  if(context.retryAssumption) why.push(context.retryAssumption);
  if(t.transportFailures?.length) why.push(`Ignored ${new Set(t.transportFailures.map(a=>a.thread&&a.turn?`${a.thread}:${a.turn}`:a.id)).size} transport-failed turn(s): no quality attempt, --failures increment, repeat gate or dominance floor.`);
  if(t.environmentFailures?.length) why.push(`Ignored ${new Set(t.environmentFailures.map(a=>a.thread&&a.turn?`${a.thread}:${a.turn}`:a.id)).size} blocked-environment turn(s) for quality escalation: ${f['failure-kind'] ? 'explicit --failure-kind takes precedence' : 'retry on the same tier and company lanes'}; retain the actual model/effort floor.`);
  if(t.infraRetry) why.push('Infrastructure recovery: raw --failures does not advance the quality ladder; completed personal turns without quality rejection do not prevent a qualified company retry. Genuine quality failures and company execution floors remain in force.');
  if(c && t.qualityFailures > 0 && !company(candidateParts(snapshot,c).account)
    && !snapshot.accounts.some(a => company(a) && known(a.catalog)?.includes(c.modelId)))
    why.push(`Quality escalation after ${t.qualityFailures} quality failure(s): ${c.modelId} is offered only on personal accounts; environment blockers do not advance the ladder.`);
  for (const lane of new Set((snapshot.transportFailures ?? []).map(r => `${r.account}:${r.modelId}`))) {
    const at = lane.indexOf(':'), account = lane.slice(0,at), model = lane.slice(at+1);
    const count = transportLaneFailures(snapshot.transportFailures, account, model, snapshot.decisionAt);
    if(count >= 2) why.push(`Transport lane demoted: ${lane}, ${count} transport-failed turns in the last 30 minutes; remains eligible when no healthy qualified alternative exists.`);
  }
  if(t.previousAttempts.some(a=>a.source==='explicit-actual'&&a.actual?.accountStatus==='UNKNOWN'))
    why.push('Prior actual account is unknown; retaining the supplied model/effort floor.');
  for(const warning of plan.warnings??[]) { why.push(warning.text);tellUser.push(warning.text); }
  for(const gate of plan.gates.filter((g)=>g.state==='needsOK')) {
    if(gate.kind==='personal-quota') needsUserOK.push(`personal quota: ${gate.scope?.accounts.join(',')??'reviewer'} needs the user's scoped OK${unknownCompany.length?`; company account state unknown or unavailable (${unknownCompany.map(a=>`${a.id}/${a.kind}`).join(', ')})`:''}`);
    if(gate.kind==='max-effort') needsUserOK.push('max effort');
    if(gate.kind==='capacity-decision') needsUserOK.push(gate.reason.text);
  }
  const routeArgs = [t.category, ...flagArgs(Object.fromEntries(Object.entries({...f, failures:t.failures, ...(owner?{owner}:{})})
    .filter(([k])=>!['json','table','dry'].includes(k))))];
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
  const listedCandidates = [c, ...(plan.reviewers ?? []).map(row => row.candidate),
    ...(plan.reviewerProposals ?? []).map(row => row.candidate), ...(plan.suggestions ?? []),
    ...(plan.gatedAlternatives ?? []).map(row => row.candidate), ...(low ? [alternative?.candidate] : [])];
  const hasDeepSeek = listedCandidates.some(candidate => candidate?.family === 'deepseek');
  const queueAlt = low ? `${alternative?.estimate.capacityReset ? 'scheduled dispatch: ' : ''}${command(['node',`${root}/scripts/route.mjs`,...altArgs])}` : null;
  const launch = (s, executable) => {
    const c=s.candidate, task=s.task, a=candidateParts(snapshot,c).account;
    const cwd=task.flags.cwd?task.cwd:'<workspace>', taskDir=task.flags['task-dir']?task.taskDir:'<task dir>';
    const launchModel=a.kind==='trae'?(profiles[c.accountId]?.modelIds?.[c.modelId]??c.modelId):c.modelId;
    const primary=s.role==='primary', suffix=primary?'':`-${s.role}`;
    const vendor=c.family==='claude'?'claude':'codex', an=c.accountId, name=`${task.flags.name??task.taskId}${suffix}`;
    const outputBase=`${taskDir}/codex${suffix}`;
    const paths=context.launchPaths?.[s.role]??{brief:`${taskDir}/brief.md`,out:`${outputBase}-last.md`,log:`${outputBase}.jsonl`};
    const seatLow=company(a)&&s.estimate.patienceMin!==null;
    const seatPatience=seatLow?s.estimate.patienceMin??30:null;
    const out={vendor,model:c.modelId,effort:c.effort,account:vendor==='claude'?undefined:an,company:company(a),sandbox:vendor==='claude'?null:task.sandbox,
      launcher:vendor==='claude'?'claude-bg':'codex-worker',command:null,
      approvalRef:executable ? (s.personalFallback?.quotaApproved ? s.personalFallback.approvalRef : f['user-ok'] ?? null) : null,
      astraApprovalRef: executable ? s.personalFallback?.astraApprovalRef ?? null : null};
    if (executable && s.personalFallback) out.personalFallback = s.personalFallback;
    if(!executable) return out;
    const prompt=`${primary?'':`Act as the independent ${s.role} reviewer of artifact ${task.artifactRevision}. `}Read ${paths.brief} and follow it.${task.browserKind === 'poll' ? ' Browser kind: poll. Only re-read the page and report status changes.' : ''}`;
    const routed={name,project:task.project,category:task.category,tier:task.tier,role:s.role,account:an,model:c.modelId,effort:c.effort,sandbox:task.sandbox,
      company:company(a),routeId:plan.routeId,approvalRef:out.approvalRef};
    const audit=command(['node',`${root}/scripts/launch-audit.mjs`,'--name',name,'--project',task.project,'--role',s.role,'--vendor',vendor,'--account',an,'--model',c.modelId,
      '--effort',c.effort,'--sandbox',task.sandbox,'--routed-seat',JSON.stringify(routed),...(f['user-ok']?['--user-ok',f['user-ok']]:[])]);
    if(vendor==='claude') {
      const trustedCwd = context.trustedCwd ?? task.flags['trusted-cwd'] ?? cwd;
      if (!task.flags['trusted-cwd'] && !context.trustedCwd) notes.push('Claude launch: no trusted project root configured; launch uses the working directory; verify it is trusted or pass --trusted-cwd with the trusted project root.');
      const browserScope = ['browser', 'ui-browser'].includes(task.category);
      const claudePrompt = `Working directory: ${cwd}. ${browserScope ? `Allowed browser origins (--browser-origins): ${task.allowedOrigins.join(',')}. ` : ''}${prompt}`;
      const metadata = JSON.stringify({ name, model: c.modelId, effort: c.effort, project: task.project, owner,
        ...(browserScope ? { browserOrigins: task.allowedOrigins, browserKind: task.browserKind, routeArgs } : {}) });
      if (browserScope) out.routeArgs = routeArgs;
      out.command=`${audit} && cd ${shellQuote(trustedCwd)} && ${command(['node',`${root}/scripts/launch-claude-worker.mjs`,metadata,
        'claude','--bg','--remote-control',...(browserScope ? ['--chrome'] : []),'--permission-mode','bypassPermissions','-n',name,'--model',c.modelId,'--effort',c.effort,claudePrompt])}`;
      return out;
    }
    const args=['--account',an,'start','--cwd',cwd,'--model',launchModel,'--effort',c.effort,'--sandbox',task.sandbox,'--name',name,
      ...(primary?['--route-args',JSON.stringify(routeArgs),'--auto-reroute-depth',String(task.autoRerouteDepth)]:[]),'--log',paths.log,'--out',paths.out];
    if(owner) args.push('--owner',owner);
    if(f.task) args.push('--task',f.task);
    args.push('--project',task.project,'--role',s.role,'--routed-seat',JSON.stringify(routed));
    if(task.background) args.push('--background');
    if(task.flags['no-auto-continue']) args.push('--no-auto-continue');
    if(f['user-ok']) args.push('--user-ok',f['user-ok']);
    if(task.flags.network) args.push('--network',task.flags.network);
    if(seatPatience!==null) args.push('--queue-patience-min',String(seatPatience),'--alt',primary?queueAlt:'Return this result to the owner and replan the required reviewer set, preserving artifact and family independence.',...(primary?['--queue-alternative',JSON.stringify(queueAlternative)]:[]));
    if(primary&&queueAlternative?.startDelayMin!==null && queueAlternative?.startDelayMin!==undefined) args.push('--queue-alt-start-min',String(queueAlternative.startDelayMin));
    if(task.category==='computer-use') args.push('--computer-use-apps',task.allowedApps.join(','));
    if(['browser','ui-browser'].includes(task.category)) args.push('--browser-origins',task.allowedOrigins.join(','));
    if(task.flags['no-browser-preflight']) args.push('--no-browser-preflight');
    out.workerArgs=args;
    const oneShot=['lookup','extract','draft','image-gen','second-opinion'].includes(task.category)&&!task.background&&!f.worker&&!low&&!isAstra(c.modelId);
    if(oneShot) {
      const bin=a.kind==='trae'?(profiles[an]?.bin??'traecli'):'codex';
      const readOnlyNetwork=task.flags.network&&task.sandbox==='read-only', profile=`route_read_only_${plan.planHash}`;
      const sandboxArgs=readOnlyNetwork?['-c',`default_permissions="${profile}"`,'-c',`permissions.${profile}.extends=":read-only"`,
        '-c',`permissions.${profile}.network.enabled=${task.flags.network==='on'}`]:['-s',task.sandbox];
      const accountEnv=profiles[an]?.home?`CODEX_HOME=${shellQuote(profiles[an].home)} `:'';
      const inner=(a.kind==='ttadk'&&known(a.capabilities.search)?`${command(['node',`${root}/scripts/codex-worker.mjs`,'--account',an,'proxy'])} >/dev/null && `:'')+accountEnv+command([bin,'exec','--skip-git-repo-check','-C',cwd,...sandboxArgs,'-m',launchModel,'-c',`model_reasoning_effort="${c.effort}"`,
        ...(task.flags.network&&task.sandbox==='workspace-write'?['-c',`sandbox_workspace_write.network_access=${task.flags.network==='on'}`]:[]),
        ])+' -c "$ORCHESTRATOR_WORKER_RULES_CONFIG" '+command(['--json','-o',paths.out,prompt]);
      out.launcher=a.kind==='trae'?'traecli-exec':'codex-exec';
      out.command=command(['sh',`${root}/scripts/run-tracked.sh`,'--name',name,'--account',an,'--model',c.modelId,'--effort',c.effort,'--cwd',cwd,
        '--project',task.project,'--task',f.task??name,'--task-dir',taskDir,
        '--out',paths.out,'--log',paths.log,'--inject-rules','on',...(owner?['--owner',owner]:[]),'--','sh','-c',`${audit} && ${inner}`]);
    } else out.command=command(['node',`${root}/scripts/codex-worker.mjs`,...args,prompt]);
    return out;
  };
  if(c) {
    const account=candidateParts(snapshot,c).account;
    if(!companyDevice(snapshot)&&account.kind==='chatgpt')
      why.push(`no company account on this device: personal ChatGPT account ${account.id} is the default lane`);
    const alternatives=eta.filter(e=>e.account!==c.accountId||e.model!==c.modelId);
    why.push(`ETA: ${taskEstimateText(seat.estimate)}; chosen lane: ${company(account)?'company':'personal'} ${c.modelId}@${c.accountId} ${laneStartText(seat.estimate)}${alternatives.length?`; alternatives: ${alternatives.map(e=>`${company(snapshot.accounts.find(a=>a.id===e.account))?'company':'personal'} ${etaText(e)}`).join('; ')}`:''}; selected by policy and qualified floor; task time is not a lane-speed ranking`);
    if(adversarial(t)) why.push('adversarial: no GPT model on any account; Kimi-K3, DeepSeek-V4.1-Flash, then scoped Opus; two independent non-GPT families required.');
    if(candidateParts(snapshot,c).lane.mode==='low-priority') why.push(`TRAE ${c.modelId} low-priority lane (bucket depleted): provider capacity remains eligible with ${snapshot.personalFallback?.enabled?'an owner queue decision':'bounded queue patience'}.`);
    if(seat.estimate.basis==='progressing') why.push(`${c.modelId} low-priority lane (bucket depleted): slower bucket designation, but progressing without queue cycles in fresh per-model telemetry.`);
    if(['browser','ui-browser'].includes(t.category)&&c.family==='claude') fixedNotes.push(WORKER_NOTES.claudeBrowser);
    if(t.writes||['browser','computer-use'].includes(t.category)) fixedNotes.unshift(sourceDigest.worker.split('\n').find(line=>line.startsWith('- Scope safety:'))??'');
    if(t.writes&&context.slowTests?.length) notes.push('brief: slow tests for this project — run each ONLY when the listed code is touched, never inside a heavy lane, and report "<file> not run: untouched code" otherwise: '+context.slowTests.map(x=>`${x.file} (${x.cost}; run when touching ${[].concat(x.runWhen??[]).join(', ')})`).join(' | '));
    fixedNotes.push(`Global worker rules ${digest.version}: ${digest.worker}`);
    fixedNotes.push(sourceDigest.worker.split('\n').find(line=>line.startsWith('- Forbidden for every worker:'))??'');
    if(t.writes) fixedNotes.push(WORKER_NOTES.backup);
    if(f['shared-lock']||f['device-lease']) fixedNotes.push(WORKER_NOTES.lease);
    if(hasDeepSeek&&['implement','implement-hard','debug'].includes(t.category)) notes.push('DeepSeek: read-only analysis and simple edits only; not full-package builds, auth/storage reviews or acceptance — re-route with --exclude-model deepseek if the brief needs those checks.');
    if(c.family==='deepseek') notes.push("DeepSeek can't emit one very large file in a single turn (output limit); split the work or exclude deepseek. Build and executable acceptance must use a capable finisher; this model can't see images.");
    if(c.family==='gemini'&&company(candidateParts(snapshot,c).account)&&!t.background) notes.push('Gemini-3.1-Pro ran past 40 minutes in 3 of 12 benchmark runs: if it shows no progress for 20 minutes, or runs past twice what the task should take, interrupt it and re-route with --exclude-model gemini (same --failures)');
    if(candidateParts(snapshot,c).account.kind==='ttadk'&&known(candidateParts(snapshot,c).account.capabilities.search)) fixedNotes.push(WORKER_NOTES.search);
    if(t.category==='image-read') fixedNotes.push(WORKER_NOTES.image);
    if(t.sandbox==='danger-full-access') fixedNotes.push(WORKER_NOTES.commits);
    if(t.runsTests&&!t.writes) fixedNotes.push(WORKER_NOTES.reviewTests);
    if(reviewAfterWrite(t,snapshot,c)) notes.push(`review required (class ${t.reviewClass}, impact ${t.impact}): pin the artifact before its gated action/acceptance, route.mjs ${deriveReview(t).category} --review-class ${t.reviewClass} --review-reason ${shellQuote(t.reviewReason)} --review-scope ${shellQuote(t.reviewScope??t.flags.name??t.taskId)} --author ${c.family==='claude'?'claude':'codex'}${['deepseek','gemini','seed'].includes(c.family)?` --exclude-model ${c.family}`:''}${t.contentLabels.includes('security')?' --security':''} --impact ${t.impact} --project ${t.project} --name ${f.name??t.taskId}-R; pin the actual author and artifact; blocks only on P0/P1, at most 2 rounds; then record with scripts/outcome.mjs --reviewed`);
    else if(!noReview&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push(`no review (impact ${t.impact}): accept on your own check (tests, build, acceptance), then record with scripts/outcome.mjs`);
    if(isReview(t)) fixedNotes.push(WORKER_NOTES.rereview);
  }
    if(['build-run','implement','implement-hard','debug','ui-browser'].includes(t.category)) {
      if(t.execution==='remote') { notes.push('build execution: remote/CI; no local resource locks.'); fixedNotes.push(WORKER_NOTES.remoteBuild); }
      else { notes.push('build execution: local; use the injected build/resource rules for heavy compute.'); fixedNotes.push(WORKER_NOTES.localBuild); }
    }
    fixedNotes.push(WORKER_NOTES.checklist);
    if(t.category==='build-run') { fixedNotes.push(t.env==='test'&&t.stakes!=='high'?WORKER_NOTES.testBuild:WORKER_NOTES.deployBuild); notes.push(`build-run environment: ${t.env}, stakes: ${t.stakes}; pin the task's health and restore checklist.`); }
    if(phones.length&&(['build-run','ui-browser','computer-use'].includes(t.category)||f['device-lease'])) fixedNotes.push(`registered shared test phones ${phones.join(', ')} are pre-authorized for OUR OWN apps: tap ordinary Allow/Authorize/Trust/OK dialogs without a new per-prompt card. Never operate personal iPhone 15 Pro Max or unregistered devices. Device lease: at most 2 h; back up app data before a destructive reinstall/wipe/erase; take the lease/lock only after the first model response.`);
    if(['browser','ui-browser'].includes(t.category)) fixedNotes.push(WORKER_NOTES.browser);
    if(['browser','ui-browser','computer-use'].includes(t.category) && t.sandbox==='read-only')
      notes.push('Read-only reports go in the final message; the launcher writes --out and status/log files. Worker-created evidence files require --sandbox workspace-write and a destination separate from --out.');
    if(t.category==='computer-use') fixedNotes.push(WORKER_NOTES.desktop);
    if(['browser','ui-browser','computer-use'].includes(t.category)) {
      fixedNotes.push(WORKER_NOTES.browserIdentity);
      fixedNotes.push(WORKER_NOTES.browserDenial);
    }
    if(t.contentLabels.includes('security')) fixedNotes.push(WORKER_NOTES.security);
    if(f.defensive) { why.push('defensive confirmation: preserve ordinary security routing'); fixedNotes.push(WORKER_NOTES.defensive); }
  if(c) {
    if(candidateParts(snapshot,c).account.kind==='ttadk') fixedNotes.push(WORKER_NOTES.ttadk);
    if(candidateParts(snapshot,c).account.kind==='trae') {
      fixedNotes.push(WORKER_NOTES.trae);
      if(['browser','ui-browser'].includes(t.category)) {
        why.push("TRAE via Playwright extension in the user's Chrome");
        fixedNotes.push(WORKER_NOTES.traeScope);
        notes.push(`browser origins: ${t.allowedOrigins.join(', ')}; name the task's read/write scope in the brief.`);
        fixedNotes.push(WORKER_NOTES.traeBrowser);
      } else fixedNotes.push(WORKER_NOTES.traePublic);
    }
    if(t.failures>=2&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push('a new defect of the same kind means stop patching: analyze the contract/interface, then reset acceptance checks.');
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("if the last miss was spec/process, amend the brief's acceptance first and say what changed; record outcome --actual. A repeated defect needs contract/interface analysis, not another unchanged patch.");
  }
  if(t.failures>=2&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push('a new defect of the same kind means stop patching: analyze the contract/interface, then reset acceptance checks.');
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("rework thread rule: use the actual accepted attempt floor. May continue the original author thread only for a same-task fix with useful context and no escalation/exclusion; record outcome.mjs --actual and ledger: continued original thread because ...");
  if(t.failures&&['implement','implement-hard','debug','science'].includes(t.category)) notes.push("if the last miss was spec/process, amend the brief's acceptance first; record what changed before another attempt.");
  if(snapshot.accounts.some(a=>known(a.transport)!==true)||!c) { fixedNotes.push(WORKER_NOTES.hub); notes.push(`hub check required: ${snapshot.accounts.filter(a=>known(a.transport)!==true).map(a=>a.id).join(', ')||'no executable lane'}; follow the injected probe/ownership rule.`); }
  if(hasDeepSeek&&['implement','implement-hard','debug'].includes(t.category)&&!c) notes.push('DeepSeek: read-only analysis and simple edits only; not full-package builds, auth/storage reviews or acceptance; use --exclude-model deepseek for those checks.');
  if(['build-run','ui-browser','computer-use'].includes(t.category)||f['device-lease']) {
    fixedNotes.push(WORKER_NOTES.device);
    if(phones.length) fixedNotes.push(`registered shared test phones ${phones.join(', ')}: ordinary Allow/Authorize/Trust/OK dialogs have no per-prompt approval or button whitelist; includes camera, microphone, photos, notifications, local network, tracking, developer trust, USB debugging and install confirmations. Never operate personal iPhone 15 Pro Max (policy=never) or a device not registered in res.`);
    if(phones.length) notes.push(`registered shared test phones: ${phones.join(', ')}.`);
    fixedNotes.push(WORKER_NOTES.iosBackup);
    fixedNotes.push(WORKER_NOTES.deviceSafety);
  }
  if(c&&candidateParts(snapshot,c).account.kind==='trae') {
    const mode=candidateParts(snapshot,c).lane.mode;
    if(mode==='bucket-free') why.push(`${t.background?'background: ':''}${c.modelId} has no daily bucket; no high-priority quota spent; no low-priority lane (step 2)`);
    else if(t.background) why.push(`background: ${mode==='low-priority'?`${c.modelId} low-priority lane; no high-priority quota spent (step 1)`:`normal TRAE pick ${c.modelId}; may spend high-priority quota (step 3)`}`);
    if(t.background) fixedNotes.push(WORKER_NOTES.background);
  }
  if(plan.reviewers.length) fixedNotes.push(WORKER_NOTES.reviewers);
  if(t.background&&!c) tellUser.push('No runnable authorized background lane: present the plan’s decision and keep dispatching independent work.');
  if(plan.kind==='blocked') why.unshift(...plan.reasons.map(r=>r.text));
  why.push(...new Set(plan.rejected.filter(r=>r.reason?.code==='BROWSER_RUNTIME_UNAVAILABLE').map(r=>r.reason.text)));
  if(!why.length) why.push(...(plan.reasons??[plan.reason]).filter(Boolean).map((r)=>r.text));
  if(companyDevice(snapshot)&&plan.trigger!=='personal-main-capacity'&&(plan.kind==='defer' || (plan.kind==='blocked' && plan.gates.some(g=>g.kind==='personal-quota')))) {
    const reset=plan.deferUntil??Math.min(...snapshot.accounts.filter(company).map(a=>known(a.denialResetAt)).filter(at=>at>snapshot.decisionAt));
    const question=`No company lane can start now. Use personal quota now, or wait until ${Number.isFinite(reset)?new Date(reset).toISOString():'company lane progress'}?`;
    needsUserOK.push(question);tellUser.push(question);
  }
  fixedNotes.push(`${WORKER_NOTES.launch} Owner: ${owner??'<session-id>'}.`);
  fixedNotes.push(WORKER_NOTES.talkback);
  fixedNotes.push(WORKER_NOTES.talkbackIdentity);
  fixedNotes.push(WORKER_NOTES.output);
  fixedNotes.push(WORKER_NOTES.audit);
  const profile=snapshot.projectProfiles?.[t.project]; if(profile) notes.push(`project profile ${profile.profile}${profile.landingGate ? `; landing gate: ${profile.landingGate}` : ''}`);
  const blocked=plan.kind==='blocked', pick=seat?launch(seat,plan.kind==='launch'):null;
  // JSON retains full diagnostics; text repeats only the choice and task context.
  const shortWhy = [...new Set(why.map(line => {
    if (c && line.startsWith('ETA:'))
      return `ETA: ${taskEstimateText(seat.estimate)}; chosen lane: ${c.modelId}@${c.accountId} ${laneStartText(seat.estimate)}; alternative waits: --json/--verbose.`;
    if (c && line.includes('low-priority lane (bucket depleted)'))
      return `${c.modelId}: low-priority capacity; ${snapshot.personalFallback?.enabled?'owner decides queued handoffs':seat.estimate.basis==='progressing'?'fresh progress observed':'bounded queue patience'}.`;
    return line;
  }))];
  const shortNotes = notes.map(line => {
    if (line.startsWith('--dry:'))
      return `--dry: preview only; rerun without --dry before launching. Cache age: ${context.cacheAgeMs==null?'UNKNOWN':Math.round(context.cacheAgeMs/1000)+' seconds'}.`;
    if (line.startsWith('brief: slow tests for this project'))
      return `slow tests for this project: only for touched code, outside heavy lanes; otherwise report skipped: ${context.slowTests.map(x=>`${x.file} (${x.cost}; touches ${[].concat(x.runWhen??[]).join(', ')})`).join(' | ')}`;
    if (line.startsWith('registered shared test phones'))
      return `registered shared test phones ${phones.join(', ')}; permission and backup rules injected.`;
    return line;
  });
  return { category:t.category,stakes:t.stakes,failures:t.failures,failureKind:t.failureKind,security:t.contentLabels.includes('security'),adversarial:adversarial(t),defensive:!!f.defensive,signing:!!f.signing,
    background:t.background,tier:t.tier,kind:plan.kind,blocked,executable:plan.kind==='launch',routeId:plan.routeId,planHash:plan.planHash,
    deferred:plan.kind==='defer'?plan.reason.text:(!pick&&blocked?plan.reasons.map((r)=>r.text).join('; '):null),
    deferUntil:plan.deferUntil??null,deferReason:plan.reason?.text??null,deferRunnerUp:plan.runnerUp?{model:plan.runnerUp.modelId,account:plan.runnerUp.accountId}:null,
    eta,queuePatienceMin:patience,queueMode:snapshot.personalFallback?.enabled?'owner':'legacy',queueNoticeAfterMin:snapshot.personalFallback?.enabled?snapshot.personalFallback.queueWaitMinutes:null,
    queueAlt,queueAlternative,pick,queueFallbackPolicy:snapshot.personalFallback?.enabled?snapshot.personalFallback:null,secondOpinion:plan.reviewers[0]?launch(plan.reviewers[0],plan.kind==='launch'):plan.reviewerProposals?.[0]?launch(plan.reviewerProposals[0],false):null,
    needsUserOK:[...new Set(needsUserOK)],tellUser:[...new Set(tellUser)],why,shortWhy,notes,shortNotes,fixedNotes,workerRulesVersion:sourceDigest.version,
    redeemFirst:c?known(candidateParts(snapshot,c).account.budget)?.redemption??null:null,balance,quota,quotaSummary,plan };
}
