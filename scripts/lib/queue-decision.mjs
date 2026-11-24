import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rulesShared, loadDigest } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';
import { appendEvent } from './worker-events.mjs';
import { queuePolicy } from './queue-stall-watch.mjs';
import { acquireRoute } from './route-data.mjs';
import { parseTaskSpec, createTaskSpec, routePure, renderPlan, enumerateCandidates, validatePlan } from './pipeline/index.mjs';
import { makePlan } from './pipeline/plan.mjs';
import { previousReleaseFallback } from './pipeline/release-fallback.mjs';
import { candidateParts } from './pipeline/candidates.mjs';
import { company, known, isAstra } from './pipeline/common.mjs';
import { nextRouteArgs, setRouteFlag, turnHasWork, turnHasRunningTools } from './worker-reroute.mjs';
import { shellQuote } from './pipeline/presentation.mjs';
import { readQueue } from './worker-queue.mjs';

const root = fileURLToPath(new URL('../..',import.meta.url)).replace(/\/$/,'');
const read = file => { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; } };
const key = row => createHash('sha256').update(JSON.stringify([row.account,row.thread,row.turn])).digest('hex');
export const queueDecisionFile = row => path.join(rulesShared(),'queue-decisions',`${key(row)}.json`);
const waiting = q => ['queued','waiting'].includes(q?.state);
export function queueChoiceSafety(turn, queue, {runningTools = 0, reporting = false, workStarted = false} = {}) {
  if (reporting || !turn || turn.status !== 'inProgress' || !Array.isArray(turn.items)) return 'turn is completing or ended';
  if (!waiting(queue) || queue.reporting) return 'turn is no longer queued';
  if (runningTools || queue.runningTools || turnHasRunningTools(turn)) return 'a tool call is still running; choice refused, queue retained; notice will repeat later';
  if (!queue.workStarted && (workStarted || turnHasWork(turn))) return 'turn started during option validation';
  return null;
}
export function queueOwnerNotice(row, queue) {
  const state = row ? read(queueDecisionFile(row)) : null;
  return state?.since === queue?.since && !state.pendingNotice && ['waiting','choosing'].includes(state.status)
    ? state.noticeCount : null;
}
const command = args => args.map(shellQuote).join(' ');
const argvOf = launch => {
  const raw = launch?.defaults?.['route-args'];
  const args = Array.isArray(raw)?raw:JSON.parse(raw??'null');
  if (!Array.isArray(args)||!args.length) throw Error('saved route arguments unavailable');
  return args;
};
export function queueRouteContext(row, launch, now = Date.now()) {
  const defaults = launch?.defaults??{};
  let args = nextRouteArgs(argvOf(launch),{account:row.account,model:row.model,effort:row.effort},Number(defaults['auto-reroute-depth']??0));
  for (const name of ['owner','name','cwd','task-dir']) if (defaults[name]??row[name]) args=setRouteFlag(args,name,defaults[name]??row[name]);
  const parsed = parseTaskSpec(args,{taskId:row.name??row.task,requestId:`queue-${key(row)}`,sandboxCeiling:'danger-full-access'});
  const context = acquireRoute(parsed,{root,now});
  return {...context,args};
}

// This is an explicit capacity choice. Ordinary routing never sets this scope.
// Forecast receipts describe the options only; the follower confirms cancellation
// before using the selected plan, then reacquires state for that exact tuple.
export function queueOptionPlan(context, row, queue, candidateId, decisionId, userOK = null) {
  const {snapshot} = context;
  const c = enumerateCandidates(context.task,snapshot).candidates.find(c=>c.id===candidateId);
  if (!c) throw Error('selected tuple is no longer in the current catalog');
  const account = candidateParts(snapshot,c).account, attemptId=`queue-choice:${decisionId}`;
  const flags={...context.task.flags,'exclude-lane':[context.task.flags['exclude-lane'],`${row.account}:${row.model}`].filter(Boolean).join(','),
    ...(userOK?{'user-ok':userOK}:{})};
  const task = createTaskSpec({...context.task,flags,
    approvalRefs:userOK?[...context.task.approvalRefs,userOK]:context.task.approvalRefs,
    previousAttempts:[{id:attemptId,taskId:context.task.taskId,role:context.task.role,actualStatus:'KNOWN',
      actual:{accountId:row.account,modelId:row.model,effort:row.effort},state:queue.workStarted?'interrupted':'cancelled-no-work',usefulWork:!!queue.workStarted,
      failureKind:'infra',cancellationEvidenceId:decisionId,rerouteReason:'queue-too-slow',queueWaitMinutes:(context.now-queue.since)/60000}],
    floor:{...context.task.floor,previousAttemptIds:[]},
    queueOwnerChoice:{candidateId,decisionId,owner:row.owner,previousAttemptId:attemptId,midTurn:!!queue.workStarted,allowLowerFloor:account.kind==='trae',allowFamilyChange:c.family==='claude'},
    ...(isAstra(c.modelId)?{selectionCause:'quality-escalation',qualityEscalation:{modelId:c.modelId,policyVersion:snapshot.policyVersion,evidenceId:decisionId}}:{})});
  const base = routePure(task,snapshot), r = base.trace?.candidates.find(r=>r.candidate.id===candidateId);
  if (!r) throw Error('selected tuple has no evaluated predicates');
  const failed = r.predicates.filter(p=>!p.ok), gates=failed.flatMap(p=>p.gates??(p.gate?[p.gate]:[]));
  const seat={role:task.role,task,candidate:c,estimate:r.estimate,dependsOnRoles:[],
    personalFallback:r.predicates.find(p=>p.ruleId==='pScopedApproval')?.personalFallback??null};
  const reviewGates=base.gates.filter(g=>['independent-review','review-decision'].includes(g.kind));
  const plan=makePlan(failed.length?'blocked':'launch',task,snapshot,{trace:base.trace,rejected:base.rejected,
    ...(failed.length?{primaryProposal:seat,reasons:failed.map(p=>p.reason)}:{primary:seat}),
    reviewers:base.reviewers,gates:[...gates,...reviewGates]});
  const view=renderPlan(plan,{...context,snapshot,owner:row.owner,digest:loadDigest()});
  const validation=validatePlan(plan,snapshot);
  if (plan.kind==='launch'&&!validation.ok) return {...view,blocked:true,needsUserOK:['Selected option fails current scope/review checks.'],validation};
  return view;
}

export function queueOptions(row,queue,launch,now=Date.now(),context=queueRouteContext(row,launch,now),decisionId='queue-preview') {
  const options=[], groups=new Set();
  for (const c of [...enumerateCandidates(context.task,context.snapshot).candidates].sort((a,b)=>['low','medium','high','xhigh','max'].indexOf(a.effort)-['low','medium','high','xhigh','max'].indexOf(b.effort))) {
    if (c.accountId===row.account&&c.modelId===row.model) continue;
    const group=`${c.accountId}:${c.modelId}`;
    if (groups.has(group)) continue;
    let route; try { route=queueOptionPlan(context,row,queue,c.id,decisionId); } catch { continue; }
    const r=route.plan.trace?.candidates.find(r=>r.candidate.id===c.id);
    if (!r || r.predicates.some(p=>!p.ok&&!p.gate&&!p.gates?.length)) continue;
    groups.add(group);
    const {account,lane}=candidateParts(context.snapshot,c), budget=known(account.budget);
    const daily=account.quota?.find(q=>q.bucketId===c.modelId), usage=known(daily?.usage);
    const quotaNote=account.kind==='trae'
      ? `${lane.mode}; load ${known(lane.loadPercent)??'?'}%; high-priority quota ${usage?`${usage.used}/${usage.limit}`:lane.mode==='priority'?'available':'unknown/depleted'}`
      : company(account)?`company quota ${account.fallbackUnavailable?'exhausted/restricted':'available'}`
      : `${route.pick?.approvalRef??'scoped personal approval required'}; personal quota cost; reset deadline ${budget?.deadline??'?'}h`;
    options.push({id:createHash('sha256').update(c.id).digest('hex').slice(0,16),type:'switch',candidateId:c.id,
      lane:c.laneId,account:c.accountId,model:c.modelId,effort:c.effort,expectedStartDelayMin:r.estimate.startDelayMin,
      quotaNote,company:company(account),releaseFallback:previousReleaseFallback(route.plan.task,context.snapshot,c)?.text??null,approvalRef:route.pick?.approvalRef??null,needsUserApproval:route.needsUserOK.length>0,
      preferred:!!context.snapshot.personalPriority&&route.pick?.approvalRef===context.snapshot.personalPriority.userDecisionRef,
      budgetDeadlineHours:budget?.deadline??null,
      approvalKinds:route.plan.gates.filter(g=>g.state==='needsOK').map(g=>g.kind),
      approvalNotes:route.needsUserOK,context:c.accountId===row.account&&c.family!=='claude'&&!launch?.requestBufferExceededAt?'same thread / resume':'fresh worker with the same brief',
      ownerMayLowerFloor:account.kind==='trae'&&c.modelId!==row.model});
  }
  options.sort((a,b)=>Number(b.company)-Number(a.company)
    ||Number(!!b.releaseFallback)-Number(!!a.releaseFallback)||Number(b.preferred)-Number(a.preferred)
    ||(a.account==='trae'?0:a.account==='ttadk'?1:a.account==='claude'?3:2)-(b.account==='trae'?0:b.account==='ttadk'?1:b.account==='claude'?3:2)
    ||(a.budgetDeadlineHours??Infinity)-(b.budgetDeadlineHours??Infinity));
  options.push({id:'wait',type:'wait',lane:`${row.account}:${row.model}`,model:row.model,effort:row.effort,
    expectedStartDelayMin:queue.drainPerMin>0&&Number.isFinite(queue.position)?queue.position/queue.drainPerMin:null,
    quotaNote:'keep existing queue; no new quota cost',needsUserApproval:false,context:'same thread / same turn'});
  options.push({id:'park',type:'park',lane:'park',model:row.model,effort:row.effort,
    expectedStartDelayMin:null,quotaNote:'cancel confirmed queued turn; no replacement quota cost',needsUserApproval:false,context:'same thread can resume later'});
  return options;
}

export function notifyQueueOwner(row,queue,launch,{now=Date.now(),policy=queuePolicy(now),emit=appendEvent,context}={}) {
  const file=queueDecisionFile(row);
  if (!policy?.enabled||!waiting(queue)||queue.reporting||queue.completing) { const old=read(file); if(old?.status==='waiting') writeJson(file,{...old,status:'ended'}); return null; }
  if (!Number.isFinite(queue.since)||now-queue.since<=policy.queueWaitMinutes*60000) return null;
  const old=read(file), same=old?.since===queue.since;
  const canNotify = state => {
    if (state?.since !== queue.since) return true;
    if (state.choice || state.choiceExecutedAt || !['waiting','ended'].includes(state.status)) return false;
    return state.status === 'waiting' && state.pendingNotice
      || now-state.lastNoticeAt >= (policy.queueReminderMinutes??10)*60000;
  };
  if (!canNotify(old)) return null;
  const renewing = same && old.status === 'ended';
  const noticeId=same&&!renewing?old.noticeId:randomUUID();
  let options, optionError=null;
  try { options=queueOptions(row,queue,launch,now,context,noticeId); }
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
      ...(o.approvalKinds.includes('fable')?['--fable']:[]),'--',...argvOf(launch)]);
  }
  return withLock(file,()=>{
    const current=read(file);
    if (!canNotify(current) || current?.noticeId !== old?.noticeId || current?.status !== old?.status) return null;
    const count=same?(old.pendingNotice&&!renewing?old.noticeCount:(old.noticeCount??1)+1):1;
    const text=`queue-stalled: ${count===2?'SECOND NOTICE; ':count>2?`NOTICE ${count}; `:''}task=${row.name??row.task} thread=${row.thread} turn=${row.turn} owner=${row.owner} lane=${row.account}:${row.model} model=${row.model} effort=${row.effort}; queued ${((now-queue.since)/60000).toFixed(1)} min position=${queue.position??'?'} drain=${queue.drainPerMin??'?'} /min. Owner decides; no automatic switch.${count>1?' secretary-relay: owner queue decision still pending.':''}${optionError?` Options incomplete: ${optionError}.`:''}\n`
      +options.map(o=>`${o.id}: ${o.lane} ${o.model}/${o.effort}; start=${o.expectedStartDelayMin??'?'} min; ${o.quotaNote}; ${o.releaseFallback?`${o.releaseFallback}; `:''}${o.context}; ${o.interruptionNote}; user approval=${o.needsUserApproval?'required':'no'}; ${o.command}${o.approvalCommand?`; after user approval: ${o.approvalCommand}; append --user-ok <returned approval id> to the choice command`:''}`).join('\n');
    const prepared={row,since:queue.since,queue,launch,options,noticeId,noticeCount:count,lastNoticeAt:now,status:'waiting',pendingNotice:true};
    // Commands are usable when the event becomes visible. A crash before emit
    // leaves a pending notice to retry, rather than an acknowledged silent wait.
    writeJson(file,prepared);
    const phase=queue.workStarted?'mid-turn':'initial-queue';
    const workedMinutesBefore=queue.workedMinutesBefore??null,queuedMinutes=Math.max(0,(now-queue.since)/60000);
    const event=emit({...row,event:'message',kind:'queue-stalled',severity:'risk',wake:true,
      text:`phase=${phase}; worked before queue=${workedMinutesBefore??'?'} min; ${text}`,options,noticeId,noticeCount:count,
      phase,workedMinutesBefore,queuedMinutes,
      queueEpisode:JSON.stringify([row.account,row.thread,row.turn]),queueSince:queue.since,queuePosition:queue.position??null,
      queuedMinutes:(now-queue.since)/60000,drainPerMin:queue.drainPerMin??null,secretaryRelay:count>1});
    if(event) writeJson(file,{...prepared,pendingNotice:false});
    return event;
  });
}

export function requestQueueChoice(row,noticeId,optionId,userOK=null,now=Date.now()) {
  if(!queuePolicy(now)?.enabled)throw Error('queue notice policy is disabled; reconcile with legacy controls');
  const file=queueDecisionFile(row),state=read(file);
  if(!state||state.noticeId!==noticeId||state.row.owner!==row.owner||state.status!=='waiting') throw Error('notice is stale, ended, or owned by another orchestrator');
  const option=state.options.find(o=>o.id===optionId);
  if(!option) throw Error('option is no longer listed');
  const profiles=read(process.env.CODEX_ACCOUNTS??path.join(rulesShared(),'codex-accounts.json'))??{};
  const current=readQueue(profiles[row.account]?.home,row.thread);
  if(!current||current.turnId!==row.turn||!waiting(current)||current.reporting||current.since!==state.since)
    throw Error('source turn is no longer in this queue episode');
  if(option.type!=='wait'&&current.runningTools) throw Error('a tool call is still running; choice refused, queue retained; notice will repeat later');
  let route=null;
  if(option.type==='switch') {
    const context=queueRouteContext(state.row,state.launch,now);
    route=queueOptionPlan(context,state.row,state.queue,option.candidateId,noticeId,userOK);
    if(route.blocked||route.needsUserOK.length||!route.pick?.command) return {exitCode:8,route};
  }
  return withLock(file,()=>{
    const latest=read(file);
    if(latest.noticeId!==noticeId||latest.status!=='waiting'||latest.choice) throw Error('this notice already has a choice');
    writeJson(file,{...latest,choice:{optionId,userOK,at:now,owner:row.owner}});
    return {exitCode:0,option};
  });
}
export const pendingQueueChoice = row => {const state=read(queueDecisionFile(row));return state?.status==='waiting'&&state.choice?state:null;};
export function claimQueueChoice(row) {
  const file=queueDecisionFile(row);if(!fs.existsSync(file))return null;
  return withLock(file,()=>{
    const state=read(file);if(state?.status!=='waiting'||!state.choice)return null;
    writeJson(file,{...state,status:'choosing',choicePid:process.pid});return state;
  });
}
export function settleQueueChoice(row,status,now=Date.now()) {
  const file=queueDecisionFile(row); if(!fs.existsSync(file))return;withLock(file,()=>{
    const s=read(file);if(s&&(status!=='ended'||['waiting','choosing'].includes(s.status)))writeJson(file,{...s,status,lastNoticeAt:now,choice:null,choicePid:null,
      ...(['selected','parked'].includes(status)?{choiceExecutedAt:now}:{})});
  });
}
