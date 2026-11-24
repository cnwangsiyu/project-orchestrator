#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSnapshot, createTaskSpec, routePure, renderPlan } from '../lib/pipeline/index.mjs';
import { saveQueue } from '../lib/worker-queue.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url)), tmp=fs.mkdtempSync(path.join(os.tmpdir(),'live-attempt-'));
const now=Date.parse('2026-11-24T02:45:00Z'), model='gpt-6.2-sol', caps={search:true,vision:true};
const attempt={id:'live',taskId:'live-task',project:'fixture',category:'implement-hard',role:'primary',state:'running',actualStatus:'KNOWN',
  actual:{accountId:'trae',modelId:model,effort:'xhigh'},thread:'fixture-thread',turn:'fixture-turn',failureKind:'infra'};
const raw={schemaVersion:'pipeline-v1',collectedFrom:now,collectedThrough:now,decisionAt:now,
  personalPriority:{account:'main',mode:'exclusive',from:'2026-11-21T08:00:00Z',until:null,revoked:false,
    quote:'fixture company before main',userDecisionRef:'standing:personal-priority-fixture'},
  resources:{held:false,ownedReturned:true},health:[],approvals:[],dependencies:[],
  accounts:['trae','main'].map(id=>({id,kind:id==='trae'?'trae':'chatgpt',catalog:[model],auth:true,transport:true,health:true,
    providerDenied:false,capabilities:caps,quota:[],budget:{weekly:{used:46,projected:50,resetsAt:now+86400000},deadline:24}})),
  models:[{id:model,efforts:['high','xhigh','max'],capabilities:caps,largeOutput:true}],
  lanes:['trae','main'].map(accountId=>({id:`${accountId}:${model}`,accountId,modelId:model,harness:'hub',efforts:['high','xhigh','max'],
    mode:'priority',selectable:true,readyAt:now,position:0,drainPerMin:0,queueState:'ready',loadPercent:20,loadSource:'model',capabilities:caps}))};
const task = (a=attempt) => createTaskSpec({taskId:'live-task',requestId:'fixture-request',category:'implement-hard',impact:'service',owner:'fixture-owner',project:'fixture',previousAttempts:[a]});
try {
  for (const a of [attempt,{...attempt,state:'queued',queueSince:now-25*60000},{...attempt,state:'queued'}]) {
    const p=routePure(task(a),createSnapshot(raw)), v=renderPlan(p,{root,snapshot:createSnapshot(raw)});
    assert.equal(p.kind,'defer');assert.equal(p.reason.code,'ATTEMPT_RECONCILIATION_REQUIRED');
    assert.equal(p.trigger,'attempt-reconciliation');assert.equal(v.pick,null);assert.deepEqual(v.needsUserOK,[]);
    assert.match(v.tellUser.join('\n'),/account=trae model=gpt-6.2-sol thread=fixture-thread/);
    assert.match(v.why.join('\n'),/queue-choice on its notice, or interrupt then route/);
    assert.doesNotMatch(JSON.stringify(v.tellUser),/personal-main-wait|no executable main lane/);
    if(a.queueSince)assert.match(p.reason.text,/queued 25 min/);
    else if(a.state==='queued')assert.match(p.reason.text,/duration unknown/);
  }
  const unavailable=structuredClone(raw);unavailable.accounts.forEach(a=>a.transport=false);
  assert.notEqual(routePure(task(),createSnapshot(unavailable)).trigger,'attempt-reconciliation','do not hide additional hard refusals');
  assert.equal(routePure(task({...attempt,state:'completed'}),createSnapshot(raw)).kind,'launch');
  fs.writeFileSync(path.join(tmp,'accounts.json'),JSON.stringify({trae:{kind:'trae',home:tmp,hub:'ws://127.0.0.1:1'}}));
  fs.writeFileSync(path.join(tmp,'snapshot.json'),JSON.stringify(raw));
  fs.writeFileSync(path.join(tmp,'attempts.json'),JSON.stringify([attempt]));
  const env={...process.env,HOME:tmp,RULES_SHARED:tmp,CODEX_ACCOUNTS:path.join(tmp,'accounts.json'),QUOTA_CACHE:path.join(tmp,'quota.json'),
    ROUTE_SNAPSHOT_FILE:path.join(tmp,'snapshot.json'),ROUTE_NOW:String(now),ROUTE_LOG:'0',ROUTE_LOG_FILE:path.join(tmp,'routes.jsonl'),
    QUOTA_LOG_FILE:path.join(tmp,'quota.jsonl'),TRAE_PROBE:'0'};
  const args=[path.join(root,'scripts/route.mjs'),'implement-hard','--impact','service','--name','live-task','--project','fixture','--task-dir',tmp,
    '--failures','1','--failure-kind','infra','--previous-attempt','attempts.json','--dry'];
  const invoke=json=>execFileSync(process.execPath,[...args,...(json?['--json']:[])],{env,encoding:'utf8',maxBuffer:16<<20});
  const queue={state:'queued',turnId:'fixture-turn',since:now-25*60000,at:now,position:58,drainPerMin:0};
  saveQueue(tmp,attempt.thread,queue);
  const view=JSON.parse(invoke(true));
  assert.equal(view.plan.trigger,'attempt-reconciliation');assert.equal(view.plan.task.previousAttempts[0].queueWaitMinutes,25);
  const text=invoke(false);assert.match(text,/ATTEMPT_RECONCILIATION_REQUIRED/);assert.match(text,/queued 25 min/);
  assert.doesNotMatch(text,/personal-main-wait|No company lane can start now/);
  for(const stale of [{turnId:'another-turn'},{at:now-31*60000},{since:now+60000},{reporting:true},{state:'ready'}]) {
    saveQueue(tmp,attempt.thread,{...queue,...stale});
    const v=JSON.parse(invoke(true));assert.equal(v.plan.task.previousAttempts[0].queueWaitMinutes,undefined);
    assert.doesNotMatch(v.plan.reason.text,/queued 25 min/);
  }
  // W784's c2 decision was 61 ms before the interruption became visible.
  const record = JSON.parse(fs.readFileSync(new URL('./fixtures/w784-infra-recovery.json',import.meta.url)));
  const { name, project, category, excludeAccount, c2, c3 } = record;
  const replay = structuredClone(raw), astra = c3.pick.model;
  replay.personalFallback = JSON.parse(fs.readFileSync(path.join(root,'references/personal-fallback.json')));
  replay.accounts[1].catalog = [astra];
  replay.accounts[1].budget.weekly.used = 78;
  replay.accounts[1].budget.weekly.resetsAt = c3.at+86400000;
  replay.models.push({...replay.models[0], id:astra});
  Object.assign(replay.lanes[1], {modelId:astra,id:`main:${astra}`});
  fs.unlinkSync(path.join(tmp,'attempts.json'));
  const runW = (input,at) => {
    fs.writeFileSync(env.ROUTE_SNAPSHOT_FILE,JSON.stringify({...replay,decisionAt:at,collectedFrom:at,collectedThrough:at}));
    return JSON.parse(execFileSync(process.execPath,[args[0],category,'--impact','service','--project',project,
      '--name',name,'--exclude-account',excludeAccount,'--failures',String(input.failures),
      ...(input.failureKind?['--failure-kind',input.failureKind]:[]),'--dry','--json'],{env:{...env,ROUTE_NOW:String(at)},encoding:'utf8'}));
  };
  const row = {...attempt, kind:'launch-model',taskId:name,name,project,accepted:true,actual:null,actualStatus:'UNKNOWN',t:record.submittedAt};
  fs.writeFileSync(env.ROUTE_LOG_FILE, JSON.stringify(row)+'\n');
  const before = runW(c2,c2.at);
  assert.equal(before.plan.trigger,'attempt-reconciliation');
  assert.ok(!before.tellUser.includes(c2.tellUser));
  fs.appendFileSync(env.ROUTE_LOG_FILE,JSON.stringify({...row,t:record.interruptedAt,state:'interrupted',actualStatus:'KNOWN',actual:attempt.actual})+'\n');
  for(const input of [c2,c3]) {
    const { account,model,effort }=runW(input,c3.at).pick;
    assert.deepEqual({account,model,effort},c3.pick);
  }
  console.log('PASS live-attempt reconciliation explains actual account/model/thread and queue age, keeps duplicate-dispatch guard and ignores stale queue evidence');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
