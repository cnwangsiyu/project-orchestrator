import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rulesShared, rulesLog, readRecords, loadDigest } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';
import { appendEvent } from './worker-events.mjs';
import { queuePolicy } from './queue-stall-watch.mjs';
import { acquireRoute } from './route-data.mjs';
import { parseTaskSpec, createTaskSpec, routePure, renderPlan, enumerateCandidates, validatePlan } from './pipeline/index.mjs';
import { estimateCandidate } from './pipeline/estimate.mjs';
import { orderCandidates } from './pipeline/choose.mjs';
import { makePlan } from './pipeline/plan.mjs';
import { previousReleaseFallback, releaseUnavailable } from './pipeline/release-fallback.mjs';
import { candidateParts } from './pipeline/candidates.mjs';
import { companyDowngrade, normalTierOverflow } from './pipeline/policy.mjs';
import { company, known, isAstra, newestRelease, policyModel } from './pipeline/common.mjs';
import { flagArgs } from './route-args.mjs';
import { nextRouteArgs, routeFlag, setRouteFlag, turnHasWork, turnHasRunningTools } from './worker-reroute.mjs';
import { shellQuote } from './pipeline/presentation.mjs';
import { readQueue, queueHome, queueDecisionKey as key, queueDecisionFile, readQueueDecision,
  queueWaiting, queueBusy, sameQueueEpisode } from './worker-queue.mjs';
export { queueDecisionFile };

const root = fileURLToPath(new URL('../..',import.meta.url)).replace(/\/$/,'');
const read = file => { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; } };
export const QUEUE_CHOICE_PENDING = 3;
export function queueChoiceSafety(turn, queue, {runningTools = 0, reporting = false, workStarted = false} = {}) {
  if (reporting || !turn || turn.status !== 'inProgress' || !Array.isArray(turn.items)) return 'turn is completing or ended';
  if (!queueWaiting(queue)) return 'turn is no longer queued';
  if (runningTools || queue.runningTools || turnHasRunningTools(turn)) return 'a tool call is still running';
  if (!queue.workStarted && (workStarted || turnHasWork(turn))) return 'turn started during option validation';
  return null;
}
export function queueOwnerNotice(row, queue) {
  const state = row ? read(queueDecisionFile(row)) : null;
  return state?.since === queue?.since && !state.pendingNotice && ['waiting','choosing'].includes(state.status)
    ? state.noticeCount : null;
}
const command = args => args.map(shellQuote).join(' ');
const parseSaved = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const usableArgs = args => Array.isArray(args) && args.length > 0
  && args.every(arg => typeof arg === 'string' && arg.length > 0) && !args[0].startsWith('-');
const launchEffort = (row, launch) => row.effort ?? launch?.effort ?? launch?.defaults?.effort
  ?? parseSaved(launch?.defaults?.['routed-seat'])?.effort;
export function queueSourceArgs(row, launch) {
  const defaults = launch?.defaults ?? {}, saved = parseSaved(defaults['route-args']);
  if (usableArgs(saved)) return { args: saved };
  const seat = parseSaved(defaults['routed-seat']);
  const project = defaults.project ?? seat?.project ?? launch?.project ?? row.project;
  const decision = seat?.routeId && readRecords(rulesLog()).find(r => r.kind === 'route'
    && r.routeId === seat.routeId && r.project === project && r.name === seat.name);
  if (usableArgs(decision?.routeArgs) && seat.role === 'primary') return { args: decision.routeArgs };
  const category = seat?.category ?? defaults.category ?? launch?.category ?? row.category;
  if (!category || !project) throw Error('saved route arguments and launch category/project unavailable');
  // Old records have no argv. Keep scope and exclusions from the matching
  // decision, plus the worker's persisted restrictions and paths.
  const flags = { project, name: defaults.name ?? row.name, impact: decision?.impact ?? (['implement','implement-hard','debug','science'].includes(category) ? 'service' : undefined),
    stakes: decision?.stakes ?? (seat?.tier === 'hard' ? 'high' : undefined), env: decision?.env, failures: decision?.failures,
    'failure-kind': decision?.failureKind, 'review-class': decision?.reviewClass, 'review-reason': decision?.reviewReason, 'review-scope': decision?.reviewScope,
    'exclude-account': decision?.excluded?.join(',') || undefined,
    'exclude-lane': decision?.excludedLanes?.join(',') || undefined,
    'auto-check': decision?.autoCheck, 'runs-tests': decision?.runsTests, 'no-local-build': decision?.noLocalBuild,
    'no-redeem': decision?.noRedeem, 'browser-origins': defaults['browser-origins'], apps: defaults['computer-use-apps'],
    sandbox: defaults.sandbox === 'danger-full-access' ? undefined : defaults.sandbox,
    'task-dir': defaults['task-dir'] ?? (defaults.log ? path.dirname(defaults.log) : undefined) };
  for (const k of ['signing','security','defensive','adversarial','background']) flags[k] = defaults[k] || decision?.[k];
  return { args: [category, ...flagArgs(flags)], derived: true };
}
export function queueRouteContext(row, launch, now = Date.now()) {
  const defaults = launch?.defaults??{};
  const source = queueSourceArgs(row, launch);
  const effort = launchEffort(row, launch);
  let args = nextRouteArgs(source.args,{account:row.account,model:row.model,effort},Number(defaults['auto-reroute-depth']??0));
  for (const name of ['owner','name','cwd','task-dir']) if (defaults[name]??row[name]) args=setRouteFlag(args,name,defaults[name]??row[name]);
  // Preserve genuine retry history when acquiring the forecast. The queue
  // plan adds the current turn separately with its interruption evidence.
  const historyArgs = setRouteFlag(args, 'actual', routeFlag(source.args, 'actual'));
  const parsed = parseTaskSpec(historyArgs,{taskId:row.name??row.task,requestId:`queue-${key(row)}`,sandboxCeiling:'danger-full-access'});
  const context = acquireRoute(parsed,{root,now});
  return {...context,args,source,effort};
}

// This is an explicit capacity choice. Ordinary routing never sets this scope.
// Forecast receipts describe the options only; the follower confirms cancellation
// before using the selected plan, then reacquires state for that exact tuple.
export function queueOptionPlan(context, row, queue, candidateId, decisionId, userOK = null, requireFloor = false) {
  const {snapshot} = context;
  const c = enumerateCandidates(context.task,snapshot).candidates.find(c=>c.id===candidateId);
  if (!c) throw Error('selected tuple is no longer in the current catalog');
  if (c.accountId === 'b') throw Error('Account b is unavailable for new work or queue switches');
  const account = candidateParts(snapshot,c).account, attemptId=`queue-choice:${decisionId}`;
  const actual = context.args && routeFlag(context.args, 'actual');
  const flags={...context.task.flags,...(actual ? {actual} : {}),'exclude-lane':[context.task.flags['exclude-lane'],`${row.account}:${row.model}`].filter(Boolean).join(','),
    ...(userOK?{'user-ok':userOK}:{})};
  const effort = row.effort ?? context.effort;
  const prior = context.task.previousAttempts.filter(a => !(a.thread === row.thread && a.turn === row.turn));
  const task = createTaskSpec({...context.task,flags,
    approvalRefs:userOK?[...context.task.approvalRefs,userOK]:context.task.approvalRefs,
    previousAttempts:[...(requireFloor ? prior : []),{id:attemptId,taskId:context.task.taskId,role:context.task.role,actualStatus:'KNOWN',
      actual:{accountId:row.account,modelId:row.model,effort},state:queue.workStarted?'interrupted':'cancelled-no-work',usefulWork:!!queue.workStarted,
      failureKind:'infra',cancellationEvidenceId:decisionId,rerouteReason:'queue-too-slow',queueWaitMinutes:(context.now-queue.since)/60000}],
    floor:requireFloor ? context.task.floor : {...context.task.floor,previousAttemptIds:[]},
    queueOwnerChoice:{candidateId,decisionId,owner:row.owner,previousAttemptId:attemptId,midTurn:!!queue.workStarted,requireFloor,allowLowerFloor:!requireFloor && account.kind==='trae',allowFamilyChange:!requireFloor && c.family==='claude'},
    ...(!requireFloor && isAstra(c.modelId)?{selectionCause:'quality-escalation',qualityEscalation:{modelId:c.modelId,policyVersion:snapshot.policyVersion,evidenceId:decisionId}}:{})});
  const base = routePure(task,snapshot), r = base.trace?.candidates.find(r=>r.candidate.id===candidateId);
  if (!r) throw Error('selected tuple has no evaluated predicates');
  const belowTier = (task.tier === 'normal' && normalTierOverflow(task) && company(account) && companyDowngrade(c.modelId))
    || r.predicates.some(p => !p.ok && (p.ruleId === 'pTierFloor'
      || ['RETRY_BELOW_ACTUAL_FLOOR', 'RETRY_LIGHT_REQUIRES_SOL'].includes(p.reason?.code)));
  const failed = r.predicates.filter(p=>!p.ok), gates=failed.flatMap(p=>p.gates??(p.gate?[p.gate]:[]));
  const seat={role:task.role,task,candidate:c,estimate:r.estimate,dependsOnRoles:[],
    personalFallback:r.predicates.find(p=>p.ruleId==='pScopedApproval')?.personalFallback??null};
  const reviewGates=base.gates.filter(g=>['independent-review','review-decision'].includes(g.kind));
  const blocked = failed.length || requireFloor && (belowTier || r.estimate.stalled);
  const plan=makePlan(blocked?'blocked':'launch',task,snapshot,{trace:base.trace,rejected:base.rejected,
    ...(blocked?{primaryProposal:seat,reasons:failed.map(p=>p.reason)}:{primary:seat}),
    reviewers:base.reviewers,gates:[...gates,...reviewGates]});
  const view=renderPlan(plan,{...context,snapshot,owner:row.owner,digest:loadDigest()});
  const validation=validatePlan(plan,snapshot);
  if (plan.kind==='launch'&&!validation.ok) return {...view,blocked:true,needsUserOK:['Selected option fails current scope/review checks.'],validation};
  return {...view, belowTier};
}

export function queueOptions(row,queue,launch,now=Date.now(),context=queueRouteContext(row,launch,now),decisionId='queue-preview') {
  const eligibleRows=[], automaticRows=[], options=[], groups=new Map(), healthyCurrent=new Set();
  const candidates = enumerateCandidates(context.task,context.snapshot).candidates;
  const source = candidates.find(c => c.accountId === row.account && c.modelId === row.model && c.effort === (row.effort ?? context.effort));
  const sourceWork = source && estimateCandidate(context.task,context.snapshot,source).workMin;
  const queueDelay = queue.position > 0 && queue.drainPerMin > 0 ? queue.position / queue.drainPerMin : null;
  const executable = route => route.pick?.command && !route.blocked && !route.needsUserOK.length && !route.redeemFirst;
  const efforts = ['low','medium','high','xhigh','max'];
  for (const c of [...candidates].sort((a,b)=>efforts.indexOf(a.effort)-efforts.indexOf(b.effort))) {
    if (c.accountId==='b' || c.accountId===row.account&&c.modelId===row.model) continue;
    const group=`${c.accountId}:${c.modelId}`;
    if (groups.get(group)?.strict) continue;
    let strict, route;
    try {
      strict=queueOptionPlan(context,row,queue,c.id,decisionId,null,true);
      route=executable(strict) ? strict : groups.has(group) ? null : queueOptionPlan(context,row,queue,c.id,decisionId);
    } catch { continue; }
    const r=route?.plan.trace?.candidates.find(r=>r.candidate.id===c.id);
    if (!r || r.predicates.some(p=>!p.ok&&!p.gate&&!p.gates?.length)) continue;
    groups.set(group,{strict:route===strict, c, route, r, belowTier:strict.belowTier});
  }
  for (const {strict,c,route,r,belowTier} of groups.values()) {
    const {account,lane}=candidateParts(context.snapshot,c), budget=known(account.budget);
    const daily=account.quota?.find(q=>q.bucketId===c.modelId), usage=known(daily?.usage);
    const quotaNote=account.kind==='trae'
      ? `${lane.mode}; load ${known(lane.loadPercent)??'?'}%; high-priority quota ${usage?`${usage.used}/${usage.limit}`:lane.mode==='priority'?'available':'unknown/depleted'}`
      : company(account)?`company quota ${account.fallbackUnavailable?'exhausted/restricted':'available'}`
      : `${route.pick?.approvalRef??'scoped personal approval required'}; personal quota cost; reset deadline ${budget?.deadline??'?'}h`;
    const faster = Number.isFinite(sourceWork) && (queueDelay !== null
      ? r.estimate.completionMin < sourceWork + queueDelay
      : r.estimate.startDelayMin === 0 && r.estimate.workMin <= sourceWork);
    const automaticEligible = strict && company(account) && route.pick?.workerArgs && !route.signing
      && (!route.secondOpinion || route.secondOpinion.company) && !queue.workStarted && !r.estimate.stalled
      && Number.isFinite(r.estimate.startDelayMin) && r.estimate.confidence !== 'UNKNOWN'
      && (account.kind !== 'trae' || r.estimate.balance?.freeNow || ['queue','observed-start'].includes(r.estimate.basis))
      && faster;
    if (strict) {
      const eligible = {...r,ok:true};
      eligibleRows.push(eligible);
      if (automaticEligible) automaticRows.push(eligible);
    }
    const rung = policyModel(c.modelId);
    if (company(account) && ['astra','sol'].includes(rung) && c.modelId === newestRelease(known(account.catalog) ?? [], rung)
      && route.plan.kind === 'launch' && !releaseUnavailable(route.plan.task, context.snapshot, c)) healthyCurrent.add(c.id);
    options.push({id:createHash('sha256').update(c.id).digest('hex').slice(0,16),type:'switch',candidateId:c.id,
      lane:c.laneId,account:c.accountId,model:c.modelId,effort:c.effort,expectedStartDelayMin:r.estimate.startDelayMin,
      quotaNote,company:company(account),releaseFallback:previousReleaseFallback(route.plan.task,context.snapshot,c)?.text??null,approvalRef:route.pick?.approvalRef??null,needsUserApproval:route.needsUserOK.length>0,
      preferred:!!context.snapshot.personalPriority&&route.pick?.approvalRef===context.snapshot.personalPriority.userDecisionRef,
      budgetDeadlineHours:budget?.deadline??null,
      approvalKinds:route.plan.gates.filter(g=>g.state==='needsOK').map(g=>g.kind),
      approvalNotes:route.needsUserOK,context:c.accountId===row.account&&c.family!=='claude'&&!launch?.requestBufferExceededAt?'same thread / resume':'fresh worker with the same brief',
      ownerMayLowerFloor:account.kind==='trae'&&c.modelId!==row.model,belowTier,bestEligible:strict});
  }
  const ranked = new Map();
  const rankingTask = eligibleRows.length ? groups.values().find(g => g.strict).route.plan.task : context.task;
  const autoWinner = orderCandidates(rankingTask,context.snapshot,automaticRows).winner;
  if (autoWinner) options.find(o => o.candidateId === autoWinner.candidate.id).automaticDefault = true;
  let remaining = eligibleRows;
  while (remaining.length) {
    const {winner}=orderCandidates(rankingTask,context.snapshot,remaining);
    if (!winner) break;
    ranked.set(winner.candidate.id, ranked.size);
    remaining = remaining.filter(r => r.candidate.id !== winner.candidate.id);
  }
  const hasFallback = options.some(o => o.releaseFallback);
  function releaseRank(option) {
    if (healthyCurrent.has(option.candidateId)) return 0;
    if (option.releaseFallback) return 1;
    return option.company ? 2 : 3;
  }
  options.sort((a,b)=>(ranked.get(a.candidateId)??ranked.size)-(ranked.get(b.candidateId)??ranked.size)
    || (hasFallback ? releaseRank(a)-releaseRank(b) : 0)
    ||Number(b.preferred)-Number(a.preferred)
    ||(a.account==='trae'?0:a.account==='ttadk'?1:a.account==='claude'?3:2)-(b.account==='trae'?0:b.account==='ttadk'?1:b.account==='claude'?3:2)
    ||(a.budgetDeadlineHours??Infinity)-(b.budgetDeadlineHours??Infinity));
  options.splice(ranked.size ? options.length : 0, 0, {id:'wait',type:'wait',lane:`${row.account}:${row.model}`,model:row.model,effort:row.effort,
    expectedStartDelayMin:queue.drainPerMin>0&&Number.isFinite(queue.position)?queue.position/queue.drainPerMin:null,
    quotaNote:'keep existing queue; no new quota cost',needsUserApproval:false,context:'same thread / same turn'});
  options.push({id:'park',type:'park',lane:'park',model:row.model,effort:row.effort,
    expectedStartDelayMin:null,quotaNote:'cancel confirmed queued turn; no replacement quota cost',needsUserApproval:false,context:'same thread can resume later'});
  return options;
}

export function automaticQueueOption(row,queue,launch,context,noticeId) {
  return queueOptions(row,queue,launch,context.now,context,noticeId).find(o=>o.automaticDefault) ?? null;
}

function noticeTiming(state, queue, now, policy) {
  const stalled = now - (queue.lastAdvanceAt ?? queue.since) >= (policy.queueWaitMinutes ?? 5)*60000;
  if (state?.since !== queue.since) return { due: true, stalled };
  if (state.choice || state.choiceExecutedAt || !['waiting','ended'].includes(state.status)) return { due: false };
  const wait = state.status === 'waiting' ? state.explicitWait : null;
  const snoozed = wait && now < wait.until;
  const resetPassed = snoozed && wait.resetAt != null && now >= wait.resetAt && !wait.resetReported;
  const reminder = (!wait && stalled || state.status === 'ended')
    && now-state.lastNoticeAt >= (policy.queueReminderMinutes??10)*60000;
  return { wait, snoozed, resetPassed, stalled, reminder, due: state.pendingNotice || resetPassed
    || !!wait && !snoozed || reminder || state.status === 'waiting' && now >= (state.nextOptionCheckAt ?? 0) };
}

export function queueNoticeDue(row, queue, now, policy) {
  return !!policy?.enabled && queueWaiting(queue) && Number.isFinite(queue.since) && now >= queue.since
    && !queueBusy(queue, now) && noticeTiming(readQueueDecision(row), queue, now, policy).due;
}

export function notifyQueueOwner(row,queue,launch,{now=Date.now(),policy=queuePolicy(now),emit=appendEvent,context,validate}={}) {
  if (!queueNoticeDue(row,queue,now,policy)) return null;
  if (row.effort == null) row = { ...row, effort: launchEffort(row, launch) };
  const file=queueDecisionFile(row),old=read(file),same=old?.since===queue.since;
  const {due,wait,snoozed,resetPassed,stalled,reminder}=noticeTiming(old,queue,now,policy);
  if (!due) return null;
  const answered = wait ? !!snoozed : same && old.ownerAnswered;
  const renewing = same && old.status === 'ended';
  const noticeId=same&&!renewing?old.noticeId:randomUUID();
  let options, autoOption=null, optionError=null;
  try {
    context??=queueRouteContext(row,launch,now);
    options=queueOptions(row,queue,launch,now,context,noticeId);
    const count=same ? old.noticeCount+(old.pendingNotice&&!renewing?0:1) : 1;
    if (!answered && policy.queueAutoChoiceAfterNotices>0 && count>=policy.queueAutoChoiceAfterNotices)
      autoOption=options.find(o=>o.automaticDefault) ?? null;
  }
  catch(e) { optionError=e.message; options=[{id:'wait',type:'wait',lane:`${row.account}:${row.model}`,model:row.model,effort:row.effort,
    expectedStartDelayMin:null,quotaNote:'saved route unavailable; recover before switching',needsUserApproval:false,context:'same thread / same turn'},
    {id:'park',type:'park',lane:'park',model:row.model,effort:row.effort,expectedStartDelayMin:null,
      quotaNote:'cancel confirmed queued turn; no replacement quota cost',needsUserApproval:false,context:'same thread can resume later'}]; }
  for (const o of options) {
    o.interruptionNote = o.type === 'wait' ? 'keep the same in-flight turn; steer messages are delivered only when it runs'
      : queue.workStarted ? 'interrupt the in-flight turn only with no tool call running; uncommitted file changes remain in the worktree for the next worker'
      : 'confirm queued no-work cancellation before switching or parking';
    o.command=command([process.execPath,`${root}/scripts/codex-worker.mjs`,'--account',row.account,'queue-choice',
      '--thread',row.thread,'--turn',row.turn,'--owner',row.owner,'--notice',noticeId,'--option',o.id]);
    if(o.needsUserApproval&&o.type==='switch')o.approvalCommand=command([process.execPath,`${root}/scripts/approval.mjs`,'add',
      '--account',o.account,'--ref','<actual user decision reference>','--until','<approval expiry ISO>',
      '--queue-source',row.account,'--queue-thread',row.thread,'--queue-turn',row.turn,'--queue-notice',noticeId,'--queue-option',o.id,
      ...(o.approvalKinds.includes('astra')?['--astra']:[]),...(o.approvalKinds.includes('max-effort')?['--max']:[]),
      ...(o.approvalKinds.includes('fable')?['--fable']:[]),'--',...(context?.source ?? queueSourceArgs(row,launch)).args]);
  }
  return withLock(file,()=>{
    const current=read(file);
    if (current?.noticeId !== old?.noticeId || current?.status !== old?.status
      || current?.lastNoticeAt !== old?.lastNoticeAt || current?.explicitWait?.at !== old?.explicitWait?.at
      || current?.noticeCount !== old?.noticeCount || current?.pendingNotice !== old?.pendingNotice
      || !noticeTiming(current,queue,now,policy).due || validate && !validate()) return null;
    const optionIds = options.filter(o => o.type === 'switch' && !o.needsUserApproval).map(o => o.id).sort();
    const laneUnavailable = context?.snapshot.lanes.find(l => l.accountId === row.account && l.modelId === row.model)?.selectable === false
      || context?.snapshot.accounts.find(a => a.id === row.account)?.fallbackUnavailable === true;
    const optionsChanged = same && (old.options?.[0]?.id !== options[0].id
      || !!old.optionIds && JSON.stringify(optionIds) !== JSON.stringify(old.optionIds));
    const laneChanged = same && old.laneUnavailable !== undefined && laneUnavailable !== old.laneUnavailable;
    const material = !same || renewing || !!old.pendingNotice || resetPassed || !!wait && !snoozed
      || optionsChanged || laneChanged || reminder && stalled && !old.stallAnnounced;
    const nextOptionCheckAt = now + Math.min(1, policy.queueReminderMinutes ?? 10) * 60000;
    if (!material && (snoozed || !reminder)) {
      writeJson(file,{...current,nextOptionCheckAt,...(!stalled ? {stallAnnounced:false} : {})});
      return null;
    }
    const account = context?.snapshot.accounts.find(a => a.id === row.account);
    const bucket = account?.quota.find(q => q.bucketId === row.model);
    const resetAt = known(bucket?.usage)?.resetsAt ?? known(bucket?.partialReset) ?? known(account?.denialResetAt);
    const relay = wait ? snoozed ? ' Owner chose wait; queue options or reset changed.' : ' Owner wait period expired.'
      : ' secretary-relay: owner queue decision still pending.';
    const count=same?(old.pendingNotice&&!renewing?old.noticeCount:(old.noticeCount??1)+1):1;
    const text=`queue-stalled: ${count===2?'SECOND NOTICE; ':count>2?`NOTICE ${count}; `:''}task=${row.name??row.task} thread=${row.thread} turn=${row.turn} owner=${row.owner} lane=${row.account}:${row.model} model=${row.model} effort=${row.effort}; queued ${((now-queue.since)/60000).toFixed(1)} min position=${queue.position??'?'} drain=${queue.drainPerMin??'?'} /min. Owner may choose now.${context?.source?.derived?' Switch options derived from saved launch metadata (category, project and actual effort).':''}${count>1?relay:''}${optionError?` Options incomplete: ${optionError}.`:''}\n`
      +options.map(o=>`${o.id}: ${o.lane} ${o.model}/${o.effort}; start=${o.expectedStartDelayMin??'?'} min; ${o.quotaNote}; ${o.belowTier?'below tier; explicit choice only; ':''}${o.releaseFallback?`${o.releaseFallback}; `:''}${o.context}; ${o.interruptionNote}; user approval=${o.needsUserApproval?'required':'no'}; ${o.command}${o.approvalCommand?`; after user approval: ${o.approvalCommand}; append --user-ok <returned approval id> to the choice command`:''}`).join('\n');
    const optionKinds = same && !renewing ? {...old.optionKinds} : {};
    for (const option of [...(same && !renewing ? old.options : []), ...options])
      optionKinds[option.id] = option.type === 'switch' ? (option.company ? 'company' : 'personal') : option.type;
    const prepared={autoOption,ownerAnswered:!!answered,resetAt,nextOptionCheckAt,optionIds,laneUnavailable,
      choiceResults:old?.choiceResults, stallAnnounced:!!stalled,
      explicitWait:snoozed ? {...wait,optionIds:[...new Set([...wait.optionIds,...optionIds])],resetReported:wait.resetReported || resetPassed} : null,optionKinds,row,since:queue.since,queue,launch,options,noticeId,noticeCount:count,lastNoticeAt:now,status:'waiting',pendingNotice:true};
    // Commands are usable when the event becomes visible. A crash before emit
    // leaves a pending notice to retry, rather than an acknowledged silent wait.
    writeJson(file,prepared);
    const phase=queue.workStarted?'mid-turn':'initial-queue';
    const workedMinutesBefore=queue.workedMinutesBefore??null,queuedMinutes=Math.max(0,(now-queue.since)/60000);
    const choiceCommand=command([process.execPath,`${root}/scripts/codex-worker.mjs`,'queue-choice','--notice',noticeId,'--best','--owner',row.owner]);
    const summary=`queue-stalled notice ${count} for ${String(row.name??row.task).slice(0,80)} at ${row.account}/${row.model}; ${queuedMinutes.toFixed(1)} min queued.${count>1?relay:''}`;
    const event=emit({...row,event:'message',kind:'queue-stalled',severity:'risk',wake:material,verifyQueueNotice:!!validate,
      choiceCommand,summary,text:`${choiceCommand}\nphase=${phase}; worked before queue=${workedMinutesBefore??'?'} min; ${text}`,options,noticeId,noticeCount:count,
      phase,workedMinutesBefore,queuedMinutes,
      queueEpisode:JSON.stringify([row.account,row.thread,row.turn]),queueSince:queue.since,queuePosition:queue.position??null,
      queuedMinutes:(now-queue.since)/60000,drainPerMin:queue.drainPerMin??null,secretaryRelay:count>1});
    if(event) writeJson(file,{...prepared,pendingNotice:false});
    return event;
  });
}

export function noticeRow(noticeId, owner) {
  if (!owner) throw Error('queue-choice needs the owner session in ORCHESTRATOR_OWNER or --owner');
  if (typeof noticeId !== 'string' || !noticeId) throw Error('queue-choice needs a notice id');
  const dir = path.join(rulesShared(), 'queue-decisions');
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const state = read(path.join(dir, name));
    if (state?.noticeId === noticeId && state.row?.owner === owner) return state.row;
  }
  throw Error('notice is stale, ended, or owned by another orchestrator');
}

export function requestQueueChoice(row,noticeId,optionId,userOK=null,now=Date.now()) {
  const policy = queuePolicy(now);
  if(!policy?.enabled)throw Error('queue notice policy is disabled; reconcile with legacy controls');
  const file=queueDecisionFile(row),state=read(file);
  if(!state||state.noticeId!==noticeId||state.row.owner!==row.owner||state.status!=='waiting') throw Error('notice is stale, ended, or owned by another orchestrator');
  let option=state.options.find(o=>o.id===optionId);
  const kind=state.optionKinds?.[optionId];
  if(!option && optionId!=='best' && !kind) throw Error('unknown queue option');
  const home=queueHome(row), current=readQueue(home,row.thread);
  const compatible = queue => sameQueueEpisode(queue,row,state.since)
    && (queueWaiting(queue) || queue.state === 'tool-active' && !queue.reporting && !queue.completing);
  if(!compatible(current)) throw Error('source turn is no longer in this queue episode');
  let context;
  const best = optionId === 'best';
  if (best || option?.type === 'switch' || !option) {
    context=queueRouteContext(state.row,state.launch,now);
    const options=queueOptions(state.row,current,state.launch,now,context,noticeId);
    const companyKind=option?.company ?? (kind === 'company');
    option=best ? options[0] : options.find(o=>o.id===optionId)
      ?? options.find(o=>o.bestEligible && o.company===companyKind);
    if (!option) throw Error('no current replacement of the requested kind; queue retained');
  }
  let route=null;
  if(option.type==='switch') {
    route=queueOptionPlan(context,state.row,state.queue,option.candidateId,noticeId,option.id===optionId?userOK:null,best || option.bestEligible);
    if(route.blocked||route.needsUserOK.length||!route.pick?.command) return {exitCode:8,applied:false,pending:false,reason:'selected option requires approval or is unavailable; queue retained',route,option};
  }
  return withLock(file,()=>{
    const latest=read(file);
    if(latest?.noticeId!==noticeId||latest.status!=='waiting'||latest.choice) throw Error('this notice already has a choice');
    const fresh=readQueue(home,row.thread);
    if(!compatible(fresh)) throw Error('source turn is no longer in this queue episode');
    const explicitWait = option.type === 'wait' ? { at:now, until:now + policy.queueWaitSnoozeMinutes * 60000,
      optionIds:latest.optionIds ?? [], resetAt:latest.resetAt > now ? latest.resetAt : null } : null;
    const busy = !queueWaiting(fresh) || queueBusy(fresh, now);
    const choiceId = explicitWait ? null : randomUUID();
    writeJson(file,{...latest,explicitWait,nextOptionCheckAt:now,autoOption:null,ownerAnswered:true,choice:explicitWait ? null : {
      id:choiceId,optionId:option.id,option,requestedOptionId:optionId,userOK:option.id===optionId?userOK:null,at:now,owner:row.owner,deferred:busy }});
    return explicitWait ? {exitCode:0,option,applied:true,pending:false,
      ...(best ? {reason:'no runnable replacement meets the task quality floor; keeping the existing queue'} : {})} : {
      exitCode:QUEUE_CHOICE_PENDING,option,choiceId,applied:false,pending:true,busy,
      reason:busy?'recorded; waiting for tool activity to end and a model queue observation':'recorded; waiting for follower confirmation' };

  });
}
export const pendingQueueChoice = row => {const state=read(queueDecisionFile(row));return state?.status==='waiting'&&state.choice?state:null;};
export function claimQueueChoice(row, {policy, since, now=Date.now()}={}) {
  const file=queueDecisionFile(row);if(!fs.existsSync(file))return null;
  return withLock(file,()=>{
    const state=read(file);
    if(state?.status!=='waiting' || state.row.owner!==row.owner || since!==undefined && state.since!==since || policy && !policy.enabled) return null;
    if(!state.choice) {
      const threshold=policy?.queueAutoChoiceAfterNotices;
      if(!policy?.enabled || !(threshold>0) || state.noticeCount<threshold || state.pendingNotice || state.ownerAnswered
        || state.since!==since || state.lastAutoNotice===state.noticeCount) return null;
      const option=state.autoOption;
      if(!option) return null;
      state.lastAutoNotice=state.noticeCount;
      state.choice={option,optionId:option.id,decidedBy:'auto',owner:row.owner,at:now};
    }
    writeJson(file,{...state,row:{...state.row,...row},status:'choosing',choicePid:process.pid});return state;
  });
}
export function deferQueueChoice(row, choice) {
  const file=queueDecisionFile(row);
  return withLock(file,()=>{
    const state=read(file);
    if(state?.status!=='choosing' || !state.choice || state.choice.id!==choice.id || state.choicePid!==process.pid) return;
    if(choice.decidedBy==='auto') writeJson(file,{...state,status:'waiting',choice:null,choicePid:null});
    else writeJson(file,{...state,status:'waiting',choice:{...state.choice,deferred:true},choicePid:null});
  });
}

export function queueChoiceResult(row, choiceId) {
  const state=readQueueDecision(row);
  return state?.choiceResults?.[choiceId] ?? (state?.choice?.id===choiceId && state.choice.deferred ? {
    exitCode:QUEUE_CHOICE_PENDING,applied:false,pending:true,
    reason:'recorded; waiting for tool activity to end and a model queue observation' } : null);
}

export function settleQueueChoice(row,status,now=Date.now(),selected,failure) {
  const file=queueDecisionFile(row); if(!fs.existsSync(file))return;
  const failed=withLock(file,()=>{
    const s=read(file);if(!s || status==='ended' && !['waiting','choosing'].includes(s.status))return null;
    const applied=['selected','parked'].includes(status), choice=s.choice;
    const result=applied ? {exitCode:0,applied:true,pending:false,option:selected??choice?.option,status} : {
      exitCode:failure?.exitCode??7,applied:false,pending:false,reason:failure?.reason??'source turn left the queue; no choice was applied' };
    const choiceResults=choice?.id ? Object.fromEntries(Object.entries({...s.choiceResults,[choice.id]:result}).slice(-8)) : s.choiceResults;
    writeJson(file,{...s,status,lastNoticeAt:now,choice:null,choicePid:null,choiceResults,
      ...(applied?{choiceExecutedAt:now,decision:selected?{...choice,option:selected,optionId:selected.id}:choice}:{})});
    return !applied && choice && (choice.id || failure) ? {choice,result,row:s.row} : null;
  });
  if(failed) appendEvent({...failed.row,event:'message',kind:'queue-choice-failed',severity:'risk',wake:true,
    text:`Queue choice not applied: ${failed.result.reason}; task=${failed.row.name} thread=${row.thread}.`,
    noticeId:readQueueDecision(row)?.noticeId,choiceId:failed.choice.id});
}
