#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createSnapshot,parseTaskSpec,createTaskSpec} from '../lib/pipeline/index.mjs';
import {notifyQueueOwner,queueSourceArgs,queueOptions,queueOptionPlan,queueDecisionFile,requestQueueChoice,claimQueueChoice,settleQueueChoice,queueChoiceSafety,automaticQueueOption} from '../lib/queue-decision.mjs';
import {queueStallLabel} from '../lib/queue-stall-watch.mjs';
import {saveQueue} from '../lib/worker-queue.mjs';
import {readEvents,eventLine,hookEventLine} from '../lib/worker-events.mjs';
const root=new URL('../../',import.meta.url).pathname.replace(/\/$/,''),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'queue-decisions-'));
const now=Date.now(),min=60000,owner='c2987dae-1fac-5a84-a312-a29117f1b8c7',SOL='gpt-6.1-sol',TERRA='gpt-5.6-terra',ASTRA='gpt-6-astra';
const policy=JSON.parse(fs.readFileSync(path.join(root,'references/personal-fallback.json')));
const envBefore={...process.env};
Object.assign(process.env,{HOME:tmp,RULES_SHARED:tmp,RES_DIR:tmp,CODEX_ACCOUNTS:path.join(tmp,'accounts.json'),
  QUOTA_CACHE:path.join(tmp,'quota.json'),ROUTE_SNAPSHOT_FILE:path.join(tmp,'snapshot.json'),ROUTE_LOG_FILE:path.join(tmp,'routes.jsonl'),
  PERSONAL_FALLBACK_FILE:path.join(tmp,'policy.json'),ROUTE_NOW:String(now),TRAE_PROBE:'0',QUOTA_LOG:'0'});
fs.writeFileSync(process.env.PERSONAL_FALLBACK_FILE,JSON.stringify(policy));fs.writeFileSync(process.env.QUOTA_CACHE,'{}');
function fixture(ttReady=false,models=[SOL,ASTRA],personalEfforts=['medium','high','xhigh','max']) {
  const caps={search:true,vision:true},accounts=[['trae','trae',[SOL,TERRA]],['ttadk','ttadk',[SOL]],['main','chatgpt',models],['b','chatgpt',models],['claude','claude',['opus','fable']]];
  const raw={schemaVersion:'pipeline-v1',collectedFrom:now,collectedThrough:now,decisionAt:now,personalFallback:policy,
    resources:{held:false,ownedReturned:true},health:[],approvals:[],dependencies:[],
    accounts:accounts.map(([id,kind,catalog])=>({id,kind,catalog,auth:true,transport:true,health:true,capabilities:caps,
      providerDenied:id==='ttadk'&&!ttReady,denialResetAt:now+2*3600000,quota:[],budget:{deadline:id==='b'?24:72}})),
    models:[...new Set(accounts.flatMap(a=>a[2]))].map(id=>({id,efforts:['medium','high','xhigh','max'],capabilities:caps,largeOutput:true})),
    lanes:accounts.flatMap(([id,kind,catalog])=>catalog.map(modelId=>({id:`${id}:${modelId}`,accountId:id,modelId,harness:kind==='claude'?'claude-bg':'hub',
      efforts:['main','b'].includes(id)?personalEfforts:['medium','high','xhigh','max'],mode:id==='trae'&&modelId===SOL?'low-priority':'priority',
      selectable:true,readyAt:id==='trae'&&modelId===SOL?null:now,position:id==='trae'&&modelId===SOL?4:0,drainPerMin:1,
      queueState:id==='trae'&&modelId===SOL?'queued':'ready',loadPercent:modelId===SOL?70:10,loadSource:'model',capabilities:caps}))) };
  const profiles=Object.fromEntries(accounts.filter(a=>a[0]!=='claude').map(([id,kind])=>{
    const home=path.join(tmp,id);fs.mkdirSync(home,{recursive:true});return[id,{kind,home,hub:'ws://127.0.0.1:1',id:`fixture-${id}`,email:`${id}@example.com`,plan:'prolite'}];}));
  fs.writeFileSync(process.env.CODEX_ACCOUNTS,JSON.stringify(profiles));fs.writeFileSync(process.env.ROUTE_SNAPSHOT_FILE,JSON.stringify(raw));
  const args=['analysis','--impact','service','--name','queue-test','--project','fixture','--cwd',tmp,'--task-dir',tmp,'--owner',owner];
  const task=parseTaskSpec(args,{taskId:'queue-test',requestId:'fixture-request',sandboxCeiling:'danger-full-access'});
  const row={owner,account:'trae',model:SOL,effort:'high',thread:'fixture',turn:'turn',runId:'fixture-run',name:'queue-test',project:'fixture',pid:process.pid};
  const queue={state:'queued',since:now-6*min,turnId:'turn',position:100,drainPerMin:0};
  const launch={defaults:{'route-args':JSON.stringify(args),cwd:tmp,name:row.name,owner,project:'fixture','auto-reroute-depth':0}};
  const context={task,snapshot:createSnapshot(raw),profiles,root,now,routeLog:process.env.ROUTE_LOG_FILE};
  saveQueue(profiles.trae.home,row.thread,queue);
  return{raw,row,queue,launch,context,profiles};
}
try {
  let f=fixture();const events=[];
  const personal=fixture();
  personal.raw.accounts.find(a=>a.id==='trae').catalog=[SOL];
  personal.raw.lanes=personal.raw.lanes.filter(l=>l.accountId!=='trae' || l.modelId===SOL);
  personal.context.snapshot=createSnapshot(personal.raw);
  const main=automaticQueueOption(personal.row,personal.queue,personal.launch,personal.context,'personal');
  assert.equal(main?.account,'main'); assert.equal(main.approvalRef,policy.userDecisionRef);
  personal.raw.personalFallback={...policy,enabled:false}; personal.context.snapshot=createSnapshot(personal.raw);
  assert.equal(automaticQueueOption(personal.row,personal.queue,personal.launch,personal.context,'gated'),null);
  f=fixture();
  const emit=e=>(events.push(e),e);
  for (const change of ['none','option','reset']) {
    f=fixture();
    const usage = change === 'reset' ? { resetsAt: now + 5 * min } : { used: 10, limit: 10, resetsAt: now + 90 * min };
    f.raw.accounts.find(a=>a.id==='trae').quota=[{bucketId:SOL,priority:'depleted',usage}];
    f.context.snapshot=createSnapshot(f.raw);
    const poll = minutes => notifyQueueOwner(f.row,f.queue,f.launch,{now:now+minutes*min,policy,context:f.context,emit});
    const first=poll(0);
    requestQueueChoice(f.row,first.noticeId,'wait',null,now);
    assert.equal(claimQueueChoice(f.row),null,'wait is durable without a follower');
    assert.equal(poll(1),null);
    if(change==='option') f=fixture(true);
    if(change==='none') {
      assert.equal(poll(59),null);
      assert.equal(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).noticeCount,1);
      assert.equal(poll(60).noticeCount,2);
    } else {
      const material=poll(5);
      assert.equal(material.noticeCount,2); assert.doesNotMatch(material.summary,/still pending/);
      assert.equal(poll(15),null);
      assert.equal(claimQueueChoice(f.row,{policy,since:f.queue.since,now:now+15*min}),null);
    }
    fs.rmSync(queueDecisionFile(f.row));
  }
  f=fixture();
  assert.equal(notifyQueueOwner(f.row,{...f.queue,since:now-5*min},f.launch,{now,policy,context:f.context,emit}),null);
  const legacy = {defaults:{...f.launch.defaults,'route-args':undefined,'routed-seat':JSON.stringify({
    name:f.row.name,project:f.row.project,category:'build-run',role:'primary',routeId:'route:fixture',effort:'high'})}};
  const incompleteRow = { ...f.row, effort: undefined };
  const legacyNotice = notifyQueueOwner(incompleteRow,f.queue,legacy,{now,policy,emit});
  assert.equal(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).row.effort, 'high');
  assert.match(legacyNotice.text,/derived from saved launch metadata/);
  assert.ok(legacyNotice.options.some(o => o.type === 'switch'));
  const exact = ['build-run','--impact','throwaway','--needs-cli','adb','--exclude-model','gemini'];
  fs.writeFileSync(process.env.ROUTE_LOG_FILE,JSON.stringify({kind:'route',routeId:'route:fixture',project:f.row.project,name:f.row.name,routeArgs:exact}));
  assert.deepEqual(queueSourceArgs(f.row,legacy),{args:exact});
  assert.deepEqual(queueSourceArgs(f.row,{defaults:{...legacy.defaults,'route-args':'truncated['}}),{args:exact});
  fs.rmSync(queueDecisionFile(f.row)); fs.rmSync(process.env.ROUTE_LOG_FILE);
  let notice=notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit});
  const short=hookEventLine({...notice,summary:'long description '.repeat(200)});
  assert.ok(short.length<=500 && short.endsWith('\n'+notice.choiceCommand));
  assert.ok(notice.text.startsWith(notice.choiceCommand));
  assert.ok(notice.choiceCommand.includes('--notice '+notice.noticeId+' --best'));
  assert.equal(notice.wake,true);assert.match(notice.text,/queued 6.0 min position=100 drain=0/);
  assert.ok(notice.options.some(o=>o.account==='trae'&&o.model===TERRA&&o.context==='same thread / resume'));
  assert.ok(notice.options.some(o=>o.account==='main'&&o.approvalRef===policy.userDecisionRef&&!o.needsUserApproval));
  assert.ok(!notice.options.some(o=>o.account==='b'), 'queue choices cannot re-enable refused personal b');
  const banned = queueOptionPlan(f.context,f.row,f.queue,notice.options.find(o=>o.account==='main').candidateId,notice.noticeId)
    .plan.trace.candidates.find(r=>r.candidate.accountId==='b').candidate;
  assert.throws(()=>queueOptionPlan(f.context,f.row,f.queue,banned.id,notice.noticeId,'old-approval'),/Account b/);
  assert.ok(notice.options.some(o=>o.model===ASTRA&&o.needsUserApproval));
  assert.ok(notice.options.some(o=>o.model==='opus'&&o.needsUserApproval));
  const hardContext={...f.context,task:createTaskSpec({...f.context.task,category:'debug'})};
  assert.ok(queueOptions(f.row,f.queue,f.launch,now,hardContext).some(o=>o.model==='fable'&&o.needsUserApproval));
  assert.deepEqual(notice.options.slice(-2).map(o=>o.id),['wait','park']);
  for(const o of notice.options)assert.ok(o.command.includes('queue-choice')&&o.command.includes('--owner')&&o.command.includes('--option'));
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now:now+9*min,policy,context:f.context,emit}),null);
  const second=notifyQueueOwner(f.row,f.queue,f.launch,{now:now+10*min,policy,context:f.context,emit});
  assert.equal(second.noticeCount,2);assert.match(second.text,/SECOND NOTICE/);assert.ok(second.secretaryRelay);
  assert.match(eventLine(second),/secretary-relay: owner queue decision still pending/);
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now:now+19*min,policy,context:f.context,emit}),null);
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now:now+20*min,policy,context:f.context,emit}).noticeCount,3);
  assert.equal(requestQueueChoice(f.row,notice.noticeId,notice.options.find(o=>o.model==='opus').id,null,now).exitCode,8);
  const astraOption=notice.options.find(o=>o.account==='main'&&o.model===ASTRA);
  assert.equal(requestQueueChoice(f.row,notice.noticeId,astraOption.id,null,now).exitCode,8);
  const grant=astraOption.approvalCommand.replace('<actual user decision reference>','fixture-user-decision')
    .replace('<approval expiry ISO>',new Date(Date.now()+3600000).toISOString());
  const approved=spawnSync('/bin/sh',['-c',grant],{encoding:'utf8',timeout:10000});
  assert.equal(approved.status,0,approved.stderr+approved.stdout);
  f.raw.approvals=JSON.parse(fs.readFileSync(path.join(tmp,'route-approvals.json')));
  fs.writeFileSync(process.env.ROUTE_SNAPSHOT_FILE,JSON.stringify(f.raw));
  assert.equal(requestQueueChoice(f.row,notice.noticeId,astraOption.id,approved.stdout.trim(),Date.now()).exitCode,0);
  settleQueueChoice(f.row,'waiting',now);
  assert.equal(requestQueueChoice(f.row,notice.noticeId,'park',null,now).exitCode,0);
  assert.ok(claimQueueChoice(f.row));assert.equal(claimQueueChoice(f.row),null,'only one follower may execute an owner choice');
  settleQueueChoice(f.row,'waiting',now);assert.equal(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).choice,null);
  assert.equal(requestQueueChoice(f.row,notice.noticeId,notice.options.find(o=>o.account==='main'&&o.model===SOL).id,null,now).exitCode,0);
  settleQueueChoice(f.row,'selected',now);assert.throws(()=>requestQueueChoice(f.row,notice.noticeId,'park',null,now));
  fs.rmSync(queueDecisionFile(f.row));
  // A mistaken ending must not silence the same queue episode forever.
  f=fixture();
  const endedNotice=notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit});
  settleQueueChoice(f.row,'ended',now);
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now:now+9*min,policy,context:f.context,emit}),null);
  const renewed=notifyQueueOwner(f.row,f.queue,f.launch,{now:now+10*min,policy,context:f.context,emit});
  assert.notEqual(renewed.noticeId,endedNotice.noticeId);assert.equal(renewed.noticeCount,2);
  assert.throws(()=>requestQueueChoice(f.row,endedNotice.noticeId,'wait',null,now),/stale/);
  assert.equal(requestQueueChoice(f.row,renewed.noticeId,'park',null,now).exitCode,0);
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now:now+20*min,policy,context:f.context,emit}),null,'pending choice is not replaced');
  assert.ok(claimQueueChoice(f.row));
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now:now+20*min,policy,context:f.context,emit}),null,'claimed choice is not replaced');
  settleQueueChoice(f.row,'selected',now);
  settleQueueChoice(f.row,'ended',now);
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now:now+20*min,policy,context:f.context,emit}),null,'executed choice is not reopened');
  fs.rmSync(queueDecisionFile(f.row));
  f=fixture(true);assert.ok(queueOptions(f.row,f.queue,f.launch,now,f.context).some(o=>o.account==='ttadk'&&!o.needsUserApproval));
  const tt=notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit});
  assert.equal(requestQueueChoice(f.row,tt.noticeId,tt.options.find(o=>o.account==='ttadk').id,null,now).exitCode,0);
  settleQueueChoice(f.row,'ended',now);fs.rmSync(queueDecisionFile(f.row));
  // A reminder drops the old TTADK option. Its printed ID still selects a current company lane.
  f=fixture(true);
  const beforeChange=notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit});
  const gone=beforeChange.options.find(o=>o.account==='ttadk');
  f=fixture(false);
  const changed=notifyQueueOwner(f.row,f.queue,f.launch,{now:now+10*min,policy,context:f.context,emit});
  assert.ok(!changed.options.some(o=>o.id===gone.id));
  const substitute=requestQueueChoice(f.row,changed.noticeId,gone.id,null,now);
  assert.equal(substitute.exitCode,0); assert.equal(substitute.option.company,true);
  assert.notEqual(substitute.option.id,gone.id);
  settleQueueChoice(f.row,'waiting',now);
  const compact=spawnSync(process.execPath,[path.join(root,'scripts/codex-worker.mjs'),'queue-choice','--notice',changed.noticeId,'--best'],
    {env:{...process.env,ORCHESTRATOR_OWNER:owner},encoding:'utf8'});
  assert.equal(compact.status,0,compact.stderr);
  assert.equal(JSON.parse(compact.stdout).option.id,changed.options.find(o=>o.type!=='wait').id);
  fs.rmSync(queueDecisionFile(f.row));
  f=fixture(false,[SOL],['max']);assert.ok(queueOptions(f.row,f.queue,f.launch,now,f.context).some(o=>o.account==='main'&&o.effort==='max'&&o.needsUserApproval));
  const midQueue={...f.queue,workStarted:true,workedMinutesBefore:24};
  assert.match(queueStallLabel(midQueue,now,f.row),/notice=none/);
  const midNotice=notifyQueueOwner(f.row,midQueue,f.launch,{now,policy,context:f.context,emit});
  assert.equal(midNotice.phase,'mid-turn');assert.equal(midNotice.workedMinutesBefore,24);assert.equal(midNotice.queuedMinutes,6);
  assert.match(queueStallLabel(midQueue,now,f.row),/notice=1/);
  for(const option of midNotice.options.filter(o=>o.type!=='wait'))assert.match(option.interruptionNote,/interrupt.*uncommitted/);
  const midTurn={status:'inProgress',items:[{type:'commandExecution',status:'completed'}]};
  assert.equal(queueChoiceSafety(midTurn,midQueue,{workStarted:true}),null);
  assert.match(queueChoiceSafety(midTurn,{...midQueue,completing:true}),/no longer queued/);
  assert.match(queueChoiceSafety(midTurn,midQueue,{runningTools:1}),/tool call.*refused/);
  assert.match(queueChoiceSafety({...midTurn,items:[{type:'mcpToolCall',status:'inProgress'}]},midQueue),/tool call.*refused/);
  assert.match(queueChoiceSafety({...midTurn,items:[{type:'commandExecution'}]},midQueue),/tool call.*refused/,'unknown tool status cannot confirm idle');
  saveQueue(f.profiles.trae.home,f.row.thread,{...midQueue,runningTools:1});
  assert.throws(()=>requestQueueChoice(f.row,midNotice.noticeId,'park',null,now),/tool call.*refused/);
  assert.equal(requestQueueChoice(f.row,midNotice.noticeId,'wait',null,now).exitCode,0);
  settleQueueChoice(f.row,'waiting',now);
  saveQueue(f.profiles.trae.home,f.row.thread,midQueue);
  assert.equal(requestQueueChoice(f.row,midNotice.noticeId,'park',null,now).exitCode,0);
  settleQueueChoice(f.row,'waiting',now);
  assert.equal(notifyQueueOwner(f.row,midQueue,f.launch,{now:now+9*min,policy,context:f.context,emit}),null);
  assert.equal(notifyQueueOwner(f.row,midQueue,f.launch,{now:now+10*min,policy,context:f.context,emit}).noticeCount,2);
  for(const ending of [{reporting:true},{completing:true},{state:'ready'}]) {
    assert.equal(notifyQueueOwner(f.row,{...midQueue,...ending},f.launch,{now:now+20*min,policy,context:f.context,emit}),null);
  }
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now,policy:{...policy,enabled:false},context:f.context,emit}),null);
  fs.rmSync(queueDecisionFile(f.row),{force:true});f=fixture();
  assert.throws(()=>notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit:()=>{throw Error('fixture event write failed');}}));
  assert.equal(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).pendingNotice,true);
  const retried=notifyQueueOwner(f.row,f.queue,f.launch,{now:now+1,policy,context:f.context,emit});
  assert.equal(retried.noticeCount,1,'a failed emission is retried without suppressing or mislabelling the first notice');

  // A follower can miss the queue event while another observer publishes the
  // current notice. Detaching that follower must leave the owner command usable.
  for(const reason of ['stall','disconnect']) {
    fs.rmSync(queueDecisionFile(f.row),{force:true});f=fixture();
    saveQueue(f.profiles.trae.home,f.row.thread,{state:'ready',turnId:f.row.turn});
    const detachedRpc=path.join(tmp,`detached-${reason}.rpc.jsonl`);
    const detached=spawnSync(process.execPath,['--import',path.join(root,'scripts/test/fixtures/reroute-transport.mjs'),
      path.join(root,'scripts/codex-worker.mjs'),'--account','trae','start','--cwd',tmp,'--model',SOL,'--effort','high',
      '--sandbox','workspace-write','--name',f.row.name,'--owner',owner,'--project','fixture',
      '--route-args',f.launch.defaults['route-args'],'--stall-min',reason==='disconnect'?'0.1':'0.01',
      '--log',path.join(tmp,`detached-${reason}.log`),'--out',path.join(tmp,`detached-${reason}.md`),'Read the same brief.'],
      {env:{...process.env,REROUTE_FIXTURE:JSON.stringify({source:SOL,rpc:detachedRpc,watcherOnlyQueue:true,disconnect:reason==='disconnect'})},encoding:'utf8',timeout:10000});
    assert.equal(detached.error,undefined);assert.equal(detached.status,reason==='stall'?4:11,detached.stdout+detached.stderr);
    if(reason==='stall')assert.match(detached.stdout,/stalled: no events/);
    const detachedNotice=JSON.parse(fs.readFileSync(queueDecisionFile(f.row)));
    assert.equal(detachedNotice.status,'waiting','follower exit is not a queue episode ending');
    assert.throws(()=>requestQueueChoice({...f.row,owner:'another-owner'},detachedNotice.noticeId,'park'),/owned by another/);
    assert.throws(()=>requestQueueChoice(f.row,'old-notice','park'),/stale/);
    for(const changed of [{turnId:'another-turn'},{since:detachedNotice.since+1},{state:'ready'},{reporting:true}]) {
      saveQueue(f.profiles.trae.home,f.row.thread,{...detachedNotice.queue,turnId:f.row.turn,...changed});
      assert.throws(()=>requestQueueChoice(f.row,detachedNotice.noticeId,'park'),/no longer in this queue episode/);
    }
    saveQueue(f.profiles.trae.home,f.row.thread,{...detachedNotice.queue,turnId:f.row.turn});
    assert.equal(requestQueueChoice(f.row,detachedNotice.noticeId,'wait').exitCode,0);
    settleQueueChoice(f.row,'waiting');
    const parkCommand=detachedNotice.options.find(o=>o.id==='park').command;
    const parked=spawnSync('/bin/sh',['-c',parkCommand],
      {env:{...process.env,NODE_OPTIONS:`--import=${path.join(root,'scripts/test/fixtures/reroute-transport.mjs')}`,
        REROUTE_FIXTURE:JSON.stringify({source:SOL,rpc:detachedRpc})},encoding:'utf8',timeout:10000});
    assert.equal(parked.status,0,parked.stdout+parked.stderr);assert.match(parked.stdout,/queue-choice: parked/);
    assert.equal(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).status,'parked');
    assert.throws(()=>requestQueueChoice(f.row,detachedNotice.noticeId,'wait'),/stale, ended/);
    assert.equal(fs.readFileSync(detachedRpc,'utf8').trim().split('\n').map(JSON.parse).filter(c=>c.method==='turn/interrupt').length,1);
    console.log(`PASS watcher notice survives ${reason}; exact command reattaches and applies once`);
  }

  // A confirmed terminal turn retires its notice, including historical wait
  // followers that never set activeTurn.
  for(const status of ['completed','failed','interrupted']) {
    fs.rmSync(queueDecisionFile(f.row),{force:true});f=fixture();
    const endedNotice=notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit});
    const ended=spawnSync(process.execPath,['--import',path.join(root,'scripts/test/fixtures/reroute-transport.mjs'),
      path.join(root,'scripts/codex-worker.mjs'),'--account','trae','wait','--thread','fixture'],
      {env:{...process.env,REROUTE_FIXTURE:JSON.stringify({source:SOL,rpc:path.join(tmp,`ended-${status}.rpc.jsonl`),readStatus:status})},encoding:'utf8',timeout:10000});
    assert.equal(ended.error,undefined);assert.equal(ended.status,status==='completed'?0:1,ended.stdout+ended.stderr);
    assert.equal(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).status,'ended');
    assert.throws(()=>requestQueueChoice(f.row,endedNotice.noticeId,'wait'),/stale, ended/);
  }
  console.log('PASS queue notice options, owner choices, approval gates, +10m repeats, secretary relay, and work/disabled guards');

  // Real worker follower, fake hub, and the exact one-line owner command.
  f=fixture(true,[SOL,'gpt-6.2-astra']);
  f.raw.accounts.find(a=>a.id==='trae').catalog.push(ASTRA);
  f.raw.models.push({...f.raw.models[0],id:ASTRA});
  f.raw.lanes.push({...f.raw.lanes[0],id:`trae:${ASTRA}`,modelId:ASTRA,position:501,drainPerMin:0});
  f.row.model=ASTRA;f.row.effort='xhigh';
  const hardMid={...f.queue,workStarted:true,workedMinutesBefore:24};
  const hardMidContext={...f.context,snapshot:createSnapshot(f.raw),task:createTaskSpec({...f.context.task,category:'implement-hard',tier:'hard'})};
  const hardOptions=queueOptions(f.row,hardMid,f.launch,now,hardMidContext);
  assert.ok(hardOptions.some(o=>o.model==='gpt-6.2-astra'&&o.approvalRef===policy.userDecisionRef&&!o.needsUserApproval),
    'mid-turn hard queues list standing-approved personal Astra even with ready TTADK Sol');
  const hardPlan=queueOptionPlan(hardMidContext,f.row,hardMid,hardOptions.find(o=>o.model==='gpt-6.2-astra').candidateId,'fixture-mid-hard');
  assert.equal(hardPlan.plan.task.previousAttempts[0].usefulWork,true);
  assert.equal(hardPlan.plan.task.previousAttempts[0].state,'interrupted');
  assert.equal(hardPlan.blocked,false);
  console.log('PASS mid-turn hard queue lists personal Astra with honest interrupted-work evidence');
  for(const [label,selection,ttReady] of [['mid-auto',null,true],['no-switch',null,false],['continued',null,false],['work-started',null,false],['legacy-disabled',null,true],
    ['mid-wait',null,false],['mid-threshold',null,false],['mid-repeat',null,false],['mid-resume',{model:TERRA},false],
    ['mid-fresh',{account:'ttadk'},true],['mid-park',{id:'park'},false],['mid-tool-running',{id:'park'},false],
    ['mid-tool-race',{id:'park'},false],['mid-reporting',null,false],['mid-items-only',null,false],['mid-server-request',null,false],
    ['mid-complete-race',{id:'park'},false],
    ['trae-resume',{model:TERRA},false],['ttadk',{account:'ttadk'},true],['personal',{account:'main',model:SOL},false],
    ['claude-approved',{model:'opus'},false],['cancel-silent',{id:'park'},false],['cancel-unconfirmed',{account:'main',model:SOL},false],
    ['wait',{id:'wait'},false],['park',{id:'park'},false]]) {
    fs.rmSync(queueDecisionFile(f.row),{force:true});f=fixture(ttReady);
    fs.writeFileSync(process.env.ROUTE_LOG_FILE,'');
    const log=path.join(tmp,`${label}.log`),rpc=path.join(tmp,`${label}.rpc.jsonl`),out=path.join(tmp,`${label}.md`);
    const transport=path.join(root,'scripts/test/fixtures/reroute-transport.mjs');
    if(label==='claude-approved') {
      const bin=path.join(tmp,'bin');fs.mkdirSync(bin,{recursive:true});
      fs.writeFileSync(path.join(bin,'claude'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$QUEUE_CLAUDE_ARGS"\nexit 0\n',{mode:0o755});
      process.env.PATH=`${bin}:${envBefore.PATH}`;process.env.QUEUE_CLAUDE_ARGS=path.join(tmp,'claude-args.log');
    }
    const mid=label.startsWith('mid-'),age=['mid-threshold','mid-reporting'].includes(label)?4:['no-switch','continued'].includes(label)?40:6;
    saveQueue(f.profiles.trae.home,'fixture',{...f.queue,since:now-age*min});
    fs.writeFileSync(process.env.PERSONAL_FALLBACK_FILE,JSON.stringify(label==='legacy-disabled'?{...policy,enabled:false}:label==='mid-repeat'?{...policy,queueAutoChoiceAfterNotices:0}:policy));
    const args=['--import',transport,path.join(root,'scripts/codex-worker.mjs'),'--account','trae',label==='continued'?'turn':'start',
      ...(label==='continued'?['--thread','fixture']:[]),'--cwd',tmp,'--model',SOL,
      '--effort','high','--sandbox','workspace-write','--name','queue-test','--owner',owner,'--project','fixture',
      ...(label==='ttadk' ? ['--routed-seat',JSON.stringify({category:'analysis',role:'primary',name:f.row.name,project:f.row.project,account:'trae',model:SOL,effort:'high'})]
        : ['--route-args',f.launch.defaults['route-args']]),'--queue-patience-min',label==='legacy-disabled'?'0.01':'30','--log',log,'--out',out,'Read the same brief.'];
    const cancelCase=label.startsWith('cancel-');
    const config={source:SOL,rpc,quiet:true,quietKeepAliveMs:10000,queueAgeMin:age,complete:!cancelCase,completeDelayMs:3500,
      queueOwnerSelect:selection,queueOwnerApprove:label==='claude-approved',progress:label==='work-started',
      ...(mid?{midTurn:true,midWorkMinutes:24,midToolRunning:label==='mid-tool-running',midToolType:'mcpToolCall',
        midReadRunning:label==='mid-tool-race',queueWhileReporting:label==='mid-reporting',
        midWithoutReady:['mid-items-only','mid-server-request'].includes(label),midServerRequest:label==='mid-server-request',
        ...(['mid-auto','mid-repeat'].includes(label)?{midSamples:[5,5.01,15.01]}:{})}:{}),
      ...(cancelCase?{cancel:label==='cancel-silent'?'silent':'unconfirmed'}:{})};
    if(label==='mid-complete-race')config.cancel='completed';
    const r=spawnSync(process.execPath,args,{env:{...process.env,REROUTE_FIXTURE:JSON.stringify(config)},encoding:'utf8',timeout:15000});
    assert.equal(r.error,undefined,label);assert.equal(r.status,cancelCase?7:0,r.stderr+r.stdout);
    const calls=fs.readFileSync(rpc,'utf8').trim().split('\n').map(JSON.parse);
    const interrupts=calls.filter(c=>c.method==='turn/interrupt');
    assert.equal(interrupts.length,label==='mid-auto'||label==='legacy-disabled'||selection&&!['wait'].includes(selection.id)&&!label.startsWith('mid-tool')?1:0,label);
    if(['legacy-disabled','mid-threshold','mid-reporting'].includes(label))assert.equal(fs.existsSync(queueDecisionFile(f.row)),false,label);
    else assert.ok(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).noticeCount>=1,label);
    if(mid&&!['mid-threshold','mid-reporting'].includes(label)) {
      const decision=JSON.parse(fs.readFileSync(queueDecisionFile(f.row)));
      assert.equal(decision.queue.workStarted,true,label);
      assert.equal(decision.queue.workedMinutesBefore,24,label);
      assert.equal(decision.noticeCount,['mid-repeat','mid-auto'].includes(label)?2:1,label);
      if(label==='mid-tool-running')assert.equal(decision.queue.runningTools,1);
      if(label.startsWith('mid-tool'))assert.match(r.stderr,/tool call is still running.*refused/);
    }
    if(label==='mid-auto') {
      const state=JSON.parse(fs.readFileSync(queueDecisionFile(f.row)));
      assert.equal(state.decision.decidedBy,'auto'); assert.equal(state.decision.option.account,'ttadk');
      const audit=fs.readFileSync(process.env.ROUTE_LOG_FILE,'utf8').trim().split('\n').map(JSON.parse);
      for(const kind of ['route','launch','reroute']) assert.ok(audit.some(r=>r.kind===kind && r.decidedBy==='auto' && r.ownerDecision===state.noticeId),kind);
      assert.equal(readEvents().filter(e=>e.noticeId===state.noticeId && e.decidedBy==='auto' && e.secretaryRelay && e.wake).length,1);
    }
    if(label==='mid-resume')assert.ok(calls.some(c=>c.method==='thread/resume'&&c.params.model===TERRA));
    if(label==='mid-fresh')assert.ok(calls.some(c=>c.method==='thread/start'&&c.account==='ttadk'));
    if(label==='mid-complete-race') {
      assert.match(r.stdout,/final: DONE original completed during queue choice/);
      assert.doesNotMatch(r.stderr,/queue-choice-blocked/);
      assert.equal(calls.filter(c=>c.method==='thread/start').length,1,'completion wins without a replacement');
    }
    if(label==='trae-resume')assert.ok(calls.some(c=>c.method==='thread/resume'&&c.params.model===TERRA),'chosen TRAE model resumes context');
    if(label==='personal'){
      assert.ok(calls.some(c=>c.method==='thread/start'&&c.account==='main'));
      const reroute=JSON.parse(fs.readFileSync(path.join(tmp,'reroute.json')));
      assert.equal(reroute.route.pick.approvalRef,policy.userDecisionRef);assert.equal(reroute.route.needsUserOK.length,0);
    }
    if(label==='ttadk')assert.ok(calls.some(c=>c.method==='thread/start'&&c.account==='ttadk'));
    if(label==='claude-approved')assert.ok(fs.readFileSync(process.env.QUEUE_CLAUDE_ARGS,'utf8').includes('--model\nopus\n'),'the approved option uses the tracked Claude launcher');
    if(cancelCase)assert.equal(calls.filter(c=>c.method==='thread/start').length,1,'unconfirmed cancellation cannot launch a replacement');
    if((!selection&&!['legacy-disabled','mid-auto'].includes(label))||selection?.id==='wait')assert.match(fs.readFileSync(out,'utf8'),/DONE original/);
    console.log(`PASS one-step queue choice ${label}`);
  }
  // A steer is accepted without interrupting, but acceptance is not an answer while queued.
  for(const state of ['queued','waiting','ready']) {
    f=fixture();saveQueue(f.profiles.trae.home,f.row.thread,{...f.queue,state,workStarted:true});
    const rpc=path.join(tmp,`steer-${state}.rpc.jsonl`);
    const r=spawnSync(process.execPath,['--import',path.join(root,'scripts/test/fixtures/reroute-transport.mjs'),
      path.join(root,'scripts/codex-worker.mjs'),'--account','trae','steer','--thread','fixture','Continue when ready.'],
      {env:{...process.env,REROUTE_FIXTURE:JSON.stringify({source:SOL,rpc})},encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr+r.stdout);assert.match(r.stdout,/steered turn turn/);
    if(state!=='ready')assert.match(r.stdout,/queued \d+\.\d min at position 100.*delivered only when the turn runs/);
    else assert.doesNotMatch(r.stdout,/delivered only when/);
    assert.ok(!fs.readFileSync(rpc,'utf8').includes('turn/interrupt'));
  }
  assert.ok(readEvents().some(e=>e.kind==='queue-stalled'&&e.wake));
} finally {Object.keys(process.env).filter(k=>!(k in envBefore)).forEach(k=>delete process.env[k]);Object.assign(process.env,envBefore);fs.rmSync(tmp,{recursive:true,force:true});}
