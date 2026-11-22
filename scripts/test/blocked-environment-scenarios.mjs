#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordWorkerOutcome } from '../lib/worker-outcome.mjs';
import { blockedEnvironmentFinal, parseWorkerResult } from '../lib/worker-result.mjs';
import { createTaskSpec } from '../lib/pipeline/taskspec.mjs';
import { routeFixture } from './helpers/route-fixture.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-environment-'));
const log = path.join(tmp,'route.jsonl'), cache = path.join(tmp,'cache.json'), now = Date.now();
const env = { ...process.env, HOME:tmp, RULES_SHARED:tmp, ROUTE_LOG_FILE:log,
  QUOTA_CACHE:cache, ROUTE_NOW:String(now), CODEX_ACCOUNTS:path.join(tmp,'none.json'),
  ROUTE_SNAPSHOT_FILE:'', QUOTA_LOG_FILE:path.join(tmp,'empty-quota'), QUOTA_LOG:'0', TRAE_PROBE:'0',
  PERSONAL_FALLBACK_FILE:path.join(tmp,'disabled.json'), PERSONAL_PRIORITY_FILE:path.join(tmp,'no-priority.json') };
const company = { name:'trae', kind:'trae', home:path.join(tmp,'trae'), healthy:true, live:true, active:0,
  hub:'ws://127.0.0.1:1',
  models:['gpt-6.1-sol'], modelIds:{'gpt-6.1-sol':'GPT-6.1-Sol'}, windows:[], resets:null };
fs.writeFileSync(cache,JSON.stringify({ checkedAt:now, claude:null, errors:{}, history:{}, codexAccounts:[company,
  { name:'main', kind:'chatgpt', home:path.join(tmp,'main'), healthy:true, live:true,
    models:['gpt-6.1-sol','gpt-6.2-sol'], windows:[{used:20,resetsAt:now+80*3600000,windowMins:10080}] }] }));
fs.writeFileSync(path.join(tmp,'disabled.json'),'{"enabled":false}');
fs.mkdirSync(path.join(tmp,'main'));
fs.writeFileSync(path.join(tmp,'main','models_cache.json'),JSON.stringify({models:[{slug:'gpt-6.1-sol'},{slug:'gpt-6.2-sol'}]}));
const rows = () => fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const route = (history = [], failures = 0, extra = [], approve = false, {category='implement',project='p',name='task'} = {}) => {
  fs.writeFileSync(log, history.map(JSON.stringify).join('\n')+'\n');
  const args=[category,'--impact','service','--project',project,'--name',name,'--failures',String(failures),'--dry','--json',...extra];
  if (approve) return JSON.parse(routeFixture(path.join(scripts,'route.mjs'),args,{env,dir:tmp,approve:true}));
  const r = spawnSync(process.execPath,[path.join(scripts,'route.mjs'),...args],{env,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout);
};
const actual = {account:'trae',model:'gpt-6.1-sol',effort:'high'};
const launch = turn => ({kind:'launch-model',project:'p',name:'task',category:'implement',thread:'thread',turn,
  t:now-10000+Number(turn),accepted:true,state:'completed',actualStatus:'KNOWN',
  actual:{accountId:'trae',modelId:actual.model,effort:actual.effort}});
const outcome = (turn, final) => recordWorkerOutcome({ project:'p',name:'task',category:'implement',account:'trae',
  thread:'thread',turn,actualModel:actual.model,effort:actual.effort,command:'start',exit:0,terminal:true,
  status:'completed',final,log,time:now-5000+Number(turn) });
let count=0;
const check=(label,fn)=>{fn();count++;console.log(`PASS ${label}`);};
try {
  check('T139 infra retries return from a completed personal newer Sol to qualified company Sol',()=>{
    const context={category:'build-run',project:'lynx-view',name:'T139'};
    const attempt=(account,model,turn,t,failureKind)=>({kind:'launch-model',t,...context,thread:account,turn,
      accepted:true,state:'completed',actualStatus:'KNOWN',failureKind,
      actual:{accountId:account,modelId:model,effort:'medium'}});
    const main=attempt('main','gpt-6.2-sol','personal',now-5000,'quality');
    const blocked=['one','two'].flatMap((turn,i)=>{
      const launch=attempt('trae','gpt-6.1-sol',turn,now-3000+i*1000);
      return [launch,{...launch,kind:'outcome',auto:true,result:'blocked-environment',failureKind:'infra',
        actual:[{account:'trae',model:'gpt-6.1-sol',effort:'medium'}]}];
    });
    const history=[main,{...main,kind:'outcome',auto:true,result:'pass',failureKind:'quality',
      actual:[{account:'main',model:'gpt-6.2-sol',effort:'medium'}]},...blocked];
    for(const failures of [1,4,99]) {
      const r=route(history,failures,['--failure-kind','infra'],true,context);
      assert.equal(r.pick?.account,'trae',`infra count ${failures} must not retain the personal floor`);
      assert.equal(r.pick.model,'gpt-6.1-sol'); assert.equal(r.pick.effort,'medium');
      assert.equal(r.plan.task.qualityFailures,0); assert.equal(r.plan.task.tier,'normal');
      assert.ok(r.plan.task.previousAttempts.some(a=>a.actual?.modelId==='gpt-6.2-sol'),'retain execution history for audit');
    }
    const automatic=route(history,2,[],true,context);
    assert.equal(automatic.pick?.account,'trae'); assert.equal(automatic.plan.task.qualityFailures,0);
    const explicit=route(history,1,['--failure-kind','infra','--actual','codex:gpt-6.2-sol:medium@main'],true,context);
    assert.equal(explicit.pick?.account,'trae'); assert.equal(explicit.pick.model,'gpt-6.1-sol');
    const personalOnly=route(history.slice(0,2),99,['--failure-kind','infra'],true,context);
    assert.equal(personalOnly.pick?.account,'trae'); assert.equal(personalOnly.plan.task.qualityFailures,0);
    const acceptedResult=route(history.map(row=>row.thread==='main'?{...row,state:'failed'}:row),1,
      ['--failure-kind','infra'],true,context);
    assert.equal(acceptedResult.pick?.account,'trae'); assert.equal(acceptedResult.plan.task.qualityFailures,0);
    const completedCompany={...main,thread:'trae',actual:{accountId:'trae',modelId:'gpt-6.1-sol',effort:'medium'}};
    const repeat=route([completedCompany],99,['--failure-kind','infra'],true,context);
    assert.equal(repeat.pick?.account,'trae'); assert.equal(repeat.pick.effort,'medium');
    const quality=history.map(row=>row.thread==='main'?{...row,state:'failed',result:'fail'}:row);
    const rejected=route(quality,1,['--failure-kind','infra'],true,context);
    assert.equal(rejected.pick?.account,'main'); assert.equal(rejected.plan.task.qualityFailures,1);
    assert.ok(rejected.plan.rejected.some(p=>p.reason?.code==='RETRY_BELOW_ACTUAL_FLOOR'));
    const infraCause=route(quality.map(row=>row.thread==='main'?{...row,cause:'infra'}:row),1,
      ['--failure-kind','infra'],true,context);
    assert.equal(infraCause.pick?.account,'trae'); assert.equal(infraCause.plan.task.qualityFailures,0);
    const corrected=route(history.map(row=>row.thread==='main'&&row.kind==='outcome'
      ?{...row,result:'blocked-environment',cause:'infra',correction:true}:row),1,['--failure-kind','infra'],true,context);
    assert.equal(corrected.pick?.account,'main'); assert.equal(corrected.plan.task.qualityFailures,1);
    const declared=route(history,1,['--failure-kind','quality'],true,context);
    assert.equal(declared.pick?.account,'main'); assert.ok(declared.plan.task.qualityFailures>0);
    const higherCompany=history.map(row=>row.thread==='trae'?{...row,actual:Array.isArray(row.actual)
      ?row.actual.map(a=>({...a,effort:'high'})):{...row.actual,effort:'high'}}:row);
    const retained=route(higherCompany,99,['--failure-kind','infra'],true,context);
    assert.equal(retained.pick?.account,'trae'); assert.equal(retained.pick.effort,'high');
    const testEnv=route(history,99,['--env','test','--failure-kind','infra'],true,context);
    assert.equal(testEnv.pick?.account,'trae'); assert.equal(testEnv.plan.task.tier,'light');
    const normalized=createTaskSpec(retained.plan.task);
    assert.equal(normalized.qualityFailures,0); assert.equal(normalized.constraintHash,retained.plan.task.constraintHash);
  });
  check('structured marker and conservative legacy status labels classify environment blockers',()=>{
    assert.equal(parseWorkerResult('Report\nWORKER-RESULT: blocked-environment\nREVIEW-RESULT: none'),'blocked-environment');
    assert.equal(blockedEnvironmentFinal('Checks failed.\nWORKER-RESULT: blocked-environment'),'marker');
    for(const final of ['[R-build] BLOCKED: executable not found','**BLOCKED**: login required','[R-build] **BLOCKED**: login required',
      'Stopped: missing dependencies','## BLOCKED\nCannot acquire a device lease.'])
      assert.equal(blockedEnvironmentFinal(final),'legacy-label',final);
    for(const final of ['DONE. No BLOCKED tasks remain; login required in fixtures.', 'BLOCKED: fix P1',
      'Tests FAILED: dependency assertion differs.', 'Example: BLOCKED: login required',
      'DONE examples:\n```\nBLOCKED: login required\n```',
      'DONE examples:\n~~~text\nWORKER-RESULT: blocked-environment\n~~~',
      'BLOCKED: login required\nWORKER-RESULT: completed','WORKER-RESULT: unknown'])
      assert.equal(blockedEnvironmentFinal(final),null,final);
    assert.equal(parseWorkerResult('WORKER-RESULT: blocked-environment\nWORKER-RESULT: completed'),null);
  });
  check('four exit-zero environment blockers keep the same company Sol tier and effort',()=>{
    fs.writeFileSync(log,'');
    for(let i=1;i<=4;i++) {
      fs.appendFileSync(log,JSON.stringify(launch(String(i)))+'\n');
      const o=outcome(String(i),i%2?'[R-build] BLOCKED: login required':'Stopped here.\nWORKER-RESULT: blocked-environment');
      assert.equal(o.result,'blocked-environment'); assert.equal(o.failureKind,'infra');
      assert.equal(o.rounds,0); assert.equal(o.accepted,null);
    }
    const history=rows();
    const r=route(history,4);
    assert.equal(r.blocked,false,JSON.stringify({reasons:r.plan.reasons?.map(x=>x.code),rejected:r.plan.rejected?.map(x=>x.reason?.code),failures:r.failures,qualityFailures:r.plan.task.qualityFailures,environmentFailures:r.plan.task.environmentFailures.length})); assert.equal(r.pick.account,'trae'); assert.equal(r.pick.model,'gpt-6.1-sol');
    assert.equal(r.pick.effort,'high'); assert.equal(r.plan.task.tier,'normal');
    assert.equal(r.failures,0); assert.equal(r.plan.task.qualityFailures,0); assert.equal(r.plan.task.environmentFailures.length,4);
    assert.match(r.why.join('\n'),/Ignored 4 blocked-environment.*same tier and company lanes/);
    const explicit=route(history,4,['--actual',Array(4).fill('codex:gpt-6.1-sol:high@trae').join(',')]);
    assert.equal(explicit.pick.account,'trae'); assert.equal(explicit.failures,0); assert.equal(explicit.pick.effort,'high');
    const latestOnly=route(history,4,['--actual','codex:gpt-6.1-sol:high@trae']);
    assert.equal(latestOnly.pick.account,'trae'); assert.equal(latestOnly.failures,0); assert.equal(latestOnly.plan.task.environmentFailures.length,4);
    const outcomesOnly=route(history.filter(r=>r.kind==='outcome'),4);
    assert.equal(outcomesOnly.pick.account,'trae'); assert.equal(outcomesOnly.failures,0);
    const unavailable=route(history,4,['--exclude-account','trae']);
    assert.equal(unavailable.blocked,true); assert.equal(unavailable.pick,null);
    assert.ok(unavailable.plan.trace.candidates.some(c=>c.predicates.some(p=>p.reason?.code==='ENVIRONMENT_RETRY_COMPANY_ONLY')));
  });
  check('genuine quality failures still advance the floor to the personal-only newer Sol',()=>{
    const history=[launch('1'),{...launch('1'),kind:'outcome',auto:true,result:'fail',failureKind:'quality',actual:[actual]}];
    const r=route(history,4,[],true);
    assert.equal(r.plan.task.qualityFailures,4); assert.equal(r.pick?.model,'gpt-6.2-sol'); assert.equal(r.pick?.account,'main');
    assert.match(r.why.join('\n'),/Quality escalation after 4 quality failure\(s\).*offered only on personal accounts/);
  });
  check('explicit route failure-kind overrides automatic environment evidence',()=>{
    const o={...launch('1'),kind:'outcome',result:'blocked-environment',failureKind:'infra',actual:[actual]};
    for(const extra of [[],['--actual','codex:gpt-6.1-sol:high@trae']]) {
      const r=route([launch('1'),o],1,['--failure-kind','quality',...extra]);
      assert.equal(r.failures,1); assert.equal(r.plan.task.qualityFailures,1);
      assert.equal(r.plan.task.environmentFailures.length,0);
    }
    const infra=route([launch('1'),o],4,['--failure-kind','infra']);
    assert.equal(infra.plan.task.qualityFailures,0); assert.equal(infra.pick.account,'trae');
    fs.writeFileSync(path.join(tmp,'actual-attempts.json'),JSON.stringify(['1','2'].map(turn=>({
      ...launch(turn),kind:'attempt',id:`named-${turn}`,taskId:'task',failureKind:'infra',environmentBlocked:true }))));
    const tool=route([],2,['--failure-kind','tool','--exclude-account','trae','--task-dir',tmp,
      '--previous-attempt','actual-attempts.json'],true);
    assert.equal(tool.plan.task.qualityFailures,0); assert.equal(tool.pick.account,'main');
    assert.ok(tool.plan.task.previousAttempts.some(a=>a.failureKind==='tool'));
    assert.match(tool.why.join('\n'),/explicit --failure-kind takes precedence/);
  });
  check('manual CLI failure-kind correction overrides the structured terminal signal',()=>{
    const o={...launch('1'),kind:'outcome',auto:true,result:'blocked-environment',failureKind:'infra',actual:[actual]};
    fs.writeFileSync(log,[launch('1'),o].map(JSON.stringify).join('\n')+'\n');
    const corrected=spawnSync(process.execPath,[path.join(scripts,'outcome.mjs'),'--project','p','--name','task',
      '--correct','--failure-kind','quality'],{env,encoding:'utf8',timeout:10000});
    assert.equal(corrected.status,0,corrected.stderr);
    const history=rows(); assert.equal(history.at(-1).thread,'thread'); assert.equal(history.at(-1).turn,'1');
    const r=route(history.map(row=>({...row,t:Math.min(row.t,now)})),1); assert.equal(r.plan.task.qualityFailures,1); assert.equal(r.plan.task.environmentFailures.length,0);
  });
  check('mixed quality history and normalization preserve only genuine quality failures',()=>{
    const attempts=[{id:'env',taskId:'task',state:'failed',failureKind:'infra',environmentBlocked:true,
      actualStatus:'KNOWN',actual:{accountId:'trae',modelId:actual.model,effort:'high'}},
      {id:'quality',taskId:'task',state:'failed',failureKind:'quality',actualStatus:'KNOWN',
        actual:{accountId:'trae',modelId:actual.model,effort:'high'}}];
    const task=createTaskSpec({category:'implement',taskId:'task',requestId:'test',flags:{name:'task',impact:'service',failures:'2'},previousAttempts:attempts});
    assert.equal(task.failures,1); assert.equal(task.qualityFailures,1);
    assert.equal(createTaskSpec(task).failures,1,'normalization must not subtract twice');
    assert.equal(createTaskSpec(task).constraintHash,task.constraintHash,'environment history order must remain stable');
    const isolated=createTaskSpec({...task,environmentFailures:[],flags:{...task.flags,failures:'2'},previousAttempts:[
      {...attempts[0],taskId:'another-task'},{...attempts[0],id:'second',role:'second'},attempts[1]]});
    assert.equal(isolated.failures,2); assert.equal(isolated.environmentFailures.length,0);
  });
  check('unknown actual model on a blocked turn cannot manufacture a quality escalation',()=>{
    const o={kind:'outcome',t:now-1000,project:'p',name:'task',category:'implement',thread:'unknown',turn:'1',
      result:'blocked-environment',failureKind:'infra',actualStatus:'UNKNOWN'};
    const r=route([o],1); assert.equal(r.failures,0); assert.equal(r.plan.task.qualityFailures,0);
    assert.equal(r.blocked,true); assert.equal(r.pick,null);
  });
  check('review environment blocker preserves marker metadata without claiming acceptance',()=>{
    fs.writeFileSync(log,'');
    const o=recordWorkerOutcome({project:'p',name:'review',category:'review',thread:'review',turn:'env',exit:0,terminal:true,
      final:'BLOCKED: missing tools\nWORKER-RESULT: blocked-environment\nREVIEW-RESULT: none',log});
    assert.equal(o.result,'blocked-environment'); assert.equal(o.reviewResult,'none'); assert.equal(o.accepted,null);
    assert.equal(recordWorkerOutcome({project:'p',name:'review',category:'review',exit:0,terminal:true,
      final:'BLOCKED: fix P1\nREVIEW-RESULT: blocking',log}).failureKind,'quality');
  });
  console.log(`${count} scenarios passed`);
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
