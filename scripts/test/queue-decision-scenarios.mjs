#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createSnapshot,parseTaskSpec,createTaskSpec} from '../lib/pipeline/index.mjs';
import {notifyQueueOwner,queueOptions,queueOptionPlan,queueDecisionFile,requestQueueChoice,claimQueueChoice,settleQueueChoice} from '../lib/queue-decision.mjs';
import {saveQueue} from '../lib/worker-queue.mjs';
import {readEvents,eventLine} from '../lib/worker-events.mjs';
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
  const emit=e=>(events.push(e),e);
  assert.equal(notifyQueueOwner(f.row,{...f.queue,since:now-5*min},f.launch,{now,policy,context:f.context,emit}),null);
  let notice=notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit});
  assert.equal(notice.wake,true);assert.match(notice.text,/queued 6.0 min position=100 drain=0/);
  assert.ok(notice.options.some(o=>o.account==='trae'&&o.model===TERRA&&o.context==='same thread / resume'));
  assert.ok(notice.options.some(o=>o.account==='b'&&o.approvalRef===policy.userDecisionRef&&!o.needsUserApproval));
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
  const astraOption=notice.options.find(o=>o.account==='b'&&o.model===ASTRA);
  assert.equal(requestQueueChoice(f.row,notice.noticeId,astraOption.id,null,now).exitCode,8);
  const grant=astraOption.approvalCommand.replace('<actual user decision reference>','fixture-user-decision')
    .replace('<approval expiry ISO>',new Date(Date.now()+3600000).toISOString());
  const approved=spawnSync('/bin/sh',['-c',grant],{encoding:'utf8',timeout:10000});
  assert.equal(approved.status,0,approved.stderr+approved.stdout);
  f.raw.approvals=JSON.parse(fs.readFileSync(path.join(tmp,'route-approvals.json')));
  fs.writeFileSync(process.env.ROUTE_SNAPSHOT_FILE,JSON.stringify(f.raw));
  assert.equal(requestQueueChoice(f.row,notice.noticeId,astraOption.id,approved.stdout.trim(),Date.now()).exitCode,0);
  settleQueueChoice(f.row,'waiting',now);
  assert.equal(requestQueueChoice(f.row,notice.noticeId,'wait',null,now).exitCode,0);
  assert.ok(claimQueueChoice(f.row));assert.equal(claimQueueChoice(f.row),null,'only one follower may execute an owner choice');
  settleQueueChoice(f.row,'waiting',now);assert.equal(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).choice,null);
  assert.equal(requestQueueChoice(f.row,notice.noticeId,notice.options.find(o=>o.account==='b'&&o.model===SOL).id,null,now).exitCode,0);
  settleQueueChoice(f.row,'selected',now);assert.throws(()=>requestQueueChoice(f.row,notice.noticeId,'park',null,now));
  fs.rmSync(queueDecisionFile(f.row));
  f=fixture(true);assert.ok(queueOptions(f.row,f.queue,f.launch,now,f.context).some(o=>o.account==='ttadk'&&!o.needsUserApproval));
  const tt=notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit});
  assert.equal(requestQueueChoice(f.row,tt.noticeId,tt.options.find(o=>o.account==='ttadk').id,null,now).exitCode,0);
  settleQueueChoice(f.row,'ended',now);fs.rmSync(queueDecisionFile(f.row));
  f=fixture(false,[SOL],['max']);assert.ok(queueOptions(f.row,f.queue,f.launch,now,f.context).some(o=>o.account==='b'&&o.effort==='max'&&o.needsUserApproval));
  assert.equal(notifyQueueOwner(f.row,{...f.queue,workStarted:true},f.launch,{now,policy,context:f.context,emit}),null);
  assert.equal(notifyQueueOwner(f.row,f.queue,f.launch,{now,policy:{...policy,enabled:false},context:f.context,emit}),null);
  fs.rmSync(queueDecisionFile(f.row),{force:true});f=fixture();
  assert.throws(()=>notifyQueueOwner(f.row,f.queue,f.launch,{now,policy,context:f.context,emit:()=>{throw Error('fixture event write failed');}}));
  assert.equal(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).pendingNotice,true);
  const retried=notifyQueueOwner(f.row,f.queue,f.launch,{now:now+1,policy,context:f.context,emit});
  assert.equal(retried.noticeCount,1,'a failed emission is retried without suppressing or mislabelling the first notice');
  console.log('PASS queue notice options, owner choices, approval gates, +10m repeats, secretary relay, and work/disabled guards');

  // Real worker follower, fake hub, and the exact one-line owner command.
  for(const [label,selection,ttReady] of [['no-switch',null,false],['continued',null,false],['work-started',null,false],['legacy-disabled',null,true],
    ['trae-resume',{model:TERRA},false],['ttadk',{account:'ttadk'},true],['personal',{account:'b',model:SOL},false],
    ['claude-approved',{model:'opus'},false],['cancel-silent',{id:'park'},false],['cancel-unconfirmed',{account:'b',model:SOL},false],
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
    const age=['no-switch','continued'].includes(label)?40:6;
    saveQueue(f.profiles.trae.home,'fixture',{...f.queue,since:now-age*min});
    fs.writeFileSync(process.env.PERSONAL_FALLBACK_FILE,JSON.stringify(label==='legacy-disabled'?{...policy,enabled:false}:policy));
    const args=['--import',transport,path.join(root,'scripts/codex-worker.mjs'),'--account','trae',label==='continued'?'turn':'start',
      ...(label==='continued'?['--thread','fixture']:[]),'--cwd',tmp,'--model',SOL,
      '--effort','high','--sandbox','workspace-write','--name','queue-test','--owner',owner,'--project','fixture',
      '--route-args',f.launch.defaults['route-args'],'--queue-patience-min',label==='legacy-disabled'?'0.01':'30','--log',log,'--out',out,'Read the same brief.'];
    const cancelCase=label.startsWith('cancel-');
    const config={source:SOL,rpc,quiet:true,quietKeepAliveMs:10000,queueAgeMin:age,complete:!cancelCase,completeDelayMs:3500,
      queueOwnerSelect:selection,queueOwnerApprove:label==='claude-approved',progress:label==='work-started',
      ...(cancelCase?{cancel:label==='cancel-silent'?'silent':'unconfirmed'}:{})};
    const r=spawnSync(process.execPath,args,{env:{...process.env,REROUTE_FIXTURE:JSON.stringify(config)},encoding:'utf8',timeout:15000});
    assert.equal(r.error,undefined,label);assert.equal(r.status,cancelCase?7:0,r.stderr+r.stdout);
    const calls=fs.readFileSync(rpc,'utf8').trim().split('\n').map(JSON.parse);
    const interrupts=calls.filter(c=>c.method==='turn/interrupt');
    assert.equal(interrupts.length,label==='legacy-disabled'||selection&&!['wait'].includes(selection.id)?1:0,label);
    if(['work-started','legacy-disabled'].includes(label))assert.equal(fs.existsSync(queueDecisionFile(f.row)),false,label);
    else assert.ok(JSON.parse(fs.readFileSync(queueDecisionFile(f.row))).noticeCount>=1,label);
    if(label==='trae-resume')assert.ok(calls.some(c=>c.method==='thread/resume'&&c.params.model===TERRA),'chosen TRAE model resumes context');
    if(label==='personal'){
      assert.ok(calls.some(c=>c.method==='thread/start'&&c.account==='b'));
      const reroute=JSON.parse(fs.readFileSync(path.join(tmp,'reroute.json')));
      assert.equal(reroute.route.pick.approvalRef,policy.userDecisionRef);assert.equal(reroute.route.needsUserOK.length,0);
    }
    if(label==='ttadk')assert.ok(calls.some(c=>c.method==='thread/start'&&c.account==='ttadk'));
    if(label==='claude-approved')assert.ok(fs.readFileSync(process.env.QUEUE_CLAUDE_ARGS,'utf8').includes('--model\nopus\n'),'the approved option uses the tracked Claude launcher');
    if(cancelCase)assert.equal(calls.filter(c=>c.method==='thread/start').length,1,'unconfirmed cancellation cannot launch a replacement');
    if((!selection&&label!=='legacy-disabled')||selection?.id==='wait')assert.match(fs.readFileSync(out,'utf8'),/DONE original/);
    console.log(`PASS one-step queue choice ${label}`);
  }
  assert.ok(readEvents().some(e=>e.kind==='queue-stalled'&&e.wake));
} finally {Object.keys(process.env).filter(k=>!(k in envBefore)).forEach(k=>delete process.env[k]);Object.assign(process.env,envBefore);fs.rmSync(tmp,{recursive:true,force:true});}
