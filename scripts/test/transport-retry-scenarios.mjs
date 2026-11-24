#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { completionKind, classifyCompletion, transportLaneFailures } from '../lib/worker-completion.mjs';
import { eventLine } from '../lib/worker-events.mjs';
import { recordWorkerOutcome } from '../lib/worker-outcome.mjs';
import { createTaskSpec } from '../lib/pipeline/taskspec.mjs';
import { TRANSPORT_CONTINUE_MESSAGE, transportQuotaBlock, transportHealthBlock, transportSourceBlock } from '../lib/worker-transport-retry.mjs';
import { claimTransportContinuation, markTransportContinuationStarting, saveTransportContinuation, savedLaunch, saveLaunch } from '../lib/worker-launch.mjs';

import { claimProbes, isModelAccessFailure, modelProbeResult, noteModelAccessFailure, noteSuccess, readModelPauses, startModelProbe } from '../lib/trae-health.mjs';

const accessError = 'stream disconnected before completion: Model access temporarily restricted';
const errors = [
  // W569 and W513 had the same exact terminal message (masked named logs).
  'stream disconnected before completion: Transport error: network error: error decoding response body',
  'stream disconnected before completion: Transport error: network error: error decoding response body',
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-retry-'));
let count = 0;
const check = (label, run) => { run(); count++; console.log(`PASS ${label}`); };
const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const now = Date.now();
const routeDir = path.join(tmp, 'route'); fs.mkdirSync(routeDir);
const routeLog = path.join(routeDir, 'route.jsonl'), cache = path.join(routeDir, 'cache.json');
const route = (history = [], failures = 0, onlyMain = false, extra = []) => {
  const account = (name, hours) => ({ name, kind: 'chatgpt', home: path.join(routeDir,name), live: true,
    healthy: true, windows: [{ used: 20, resetsAt: now + hours * 3600000, windowMins: 10080 }] });
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, codexAccounts: [account('main',80), ...(!onlyMain ? [account('alt',120)] : [])],
    claude: null, errors: {}, history: {} }));
  fs.writeFileSync(routeLog, history.map(r => JSON.stringify(r)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [path.join(scripts,'route.mjs'), 'implement', '--impact','service',
    '--project','p','--name','task','--failures',String(failures),'--dry','--json',...extra], { encoding:'utf8',
    env: { ...process.env, HOME:routeDir, RULES_SHARED:routeDir, CODEX_ACCOUNTS:path.join(routeDir,'none.json'),
      QUOTA_CACHE:cache, ROUTE_NOW:String(now), ROUTE_LOG_FILE:routeLog, QUOTA_LOG_FILE:path.join(routeDir,'empty-quota'),
      ROUTE_SNAPSHOT_FILE:'', QUOTA_LOG:'0', TRAE_PROBE:'0', PERSONAL_FALLBACK_FILE:path.join(routeDir,'disabled.json') } });
  assert.equal(run.status,0,run.stderr); return JSON.parse(run.stdout);
};
const failed = (turn, t = now - 1000) => ({ kind:'outcome', t, project:'p', name:'task', category:'implement',
  account:'main', thread:'thread', turn, result:'transport-failed', failureKind:'transport-failed',
  actual:[{ account:'main', model:'gpt-6.1-sol', effort:'max' }], actualStatus:'KNOWN' });
const follower = (label, config = {}, extra = []) => {
  const dir = path.join(tmp,label), home = path.join(dir,'home'), bin = path.join(dir,'bin');
  fs.mkdirSync(home,{recursive:true}); fs.mkdirSync(bin);
  for (const [name,output] of [['codex','{"models":[]}'],['claude','fixture']])
    fs.writeFileSync(path.join(bin,name),`#!/bin/sh\nprintf '%s\\n' '${output}'\n`,{mode:0o755});
  const profiles = path.join(dir,'profiles.json'), rpc = path.join(dir,'rpc.jsonl'), log = path.join(dir,'outcomes.jsonl');
  fs.writeFileSync(profiles,JSON.stringify({fixture:{kind:'trae',home,hub:'ws://127.0.0.1:1'}}));
  const category = config.review ? 'review' : 'implement';
  const pick = {vendor:'codex',account:'fixture',model:'gpt-6.1-sol',effort:'high',sandbox:'read-only'};
  fs.writeFileSync(log,JSON.stringify({kind:'route',t:now,project:'p',name:label,category,pick})+'\n');
  const env = {...process.env,HOME:home,CODEX_HOME:home,CODEX_ACCOUNTS:profiles,CODEX_HUB:'ws://127.0.0.1:1',
    RULES_SHARED:dir,ROUTE_LOG_FILE:log,QUOTA_CACHE:path.join(dir,'cache.json'),QUOTA_LOG_FILE:path.join(dir,'empty-quota'),
    PATH:`${bin}:${process.env.PATH}`,NODE_OPTIONS:'',ORCHESTRATOR_OWNER:'',CLAUDE_SESSION_ID:'',CLAUDE_JOB_DIR:'',CLAUDECODE:'',
    TRAE_PROBE:'0',QUOTA_LOG:'0',TRAE_SESSIONS_DIR:path.join(dir,'empty-sessions'),
    TRANSPORT_RETRY_FIXTURE:JSON.stringify({rpc,errors:[errors[0]],...config})};
  const seat = {project:'p',name:label,category,role:'primary',...pick};
  const run = (command = 'start', override = {}) => {
    const args = ['--account','fixture',command,...(command === 'start' ? ['--cwd',dir] : ['--thread','transport-thread']),
      '--sandbox','read-only','--name',label,'--project','p','--model','gpt-6.1-sol','--effort','high',
      '--routed-seat',JSON.stringify(seat),'--out',path.join(dir,'final.md'),...extra,
      ...(['start','turn'].includes(command) ? ['Follow fixture.'] : [])];
    // The fixture intercepts the retry delay; this watchdog bounds process
    // startup and teardown, not the separately asserted continuation timing.
    const r = spawnSync(process.execPath,['--import',path.join(scripts,'test/fixtures/worker-transport-retry.mjs'),path.join(scripts,'codex-worker.mjs'),...args],
      {env:{...env,TRANSPORT_RETRY_FIXTURE:JSON.stringify({rpc,errors:[errors[0]],...config,...override})},encoding:'utf8',timeout:15000});
    assert.equal(r.error,undefined,r.stderr+r.stdout); return r;
  };
  const rows = file => fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return {dir,home,env,run,calls:()=>rows(rpc),outcomes:()=>rows(log).filter(r=>r.kind==='outcome')};
};
try {
  check('real stream errors and exhausted provider errors are transport failures', () => {
    for (const error of [...errors, 'connection reset by peer', 'ECONNRESET', 'HTTP 500 after retries', 'provider 503', 'provider overloaded after retries'])
      assert.equal(completionKind({ status: 'failed', error: { message: error } }), 'transport-failed');
    for (const status of ['completed', 'interrupted', 'BLOCKED', 'TRUNCATED'])
      assert.equal(completionKind({ status, error: errors[0] }), status);
    assert.equal(completionKind({ status: 'failed', error: 'test assertions failed' }), 'failed');
    assert.equal(classifyCompletion({turn:{status:'failed',error:errors[0]}}).status,'transport-failed');
    assert.equal(classifyCompletion({turn:{status:'failed',error:{httpStatusCode:500}}}).status,'transport-failed');
    assert.match(eventLine({event:'message',kind:'transport-retry',text:'Continue: node script.mjs --thread thread',name:'fixture'}),/^\[transport-retry\].*Continue: node script.mjs --thread thread$/);
  });
  check('transport outcome is durable, idempotent, and distinct from quality or partial final prose', () => {
    const log = path.join(tmp, 'outcomes.jsonl');
    const base = { project: 'p', name: 'task', category: 'implement', thread: 'thread', turn: 'turn',
      account: 'a', actualModel: 'gpt-6.1-sol', effort: 'high', command: 'start', terminal: true,
      status: 'failed', error: errors[0], exit: 1, final: 'BLOCKED: partial task report', log };
    const row = recordWorkerOutcome(base);
    assert.equal(row.result, 'transport-failed'); assert.equal(row.failureKind, 'transport-failed');
    assert.equal(row.cause, 'transport'); assert.equal(row.rounds, 0);
    assert.equal(recordWorkerOutcome(base), null);
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).result, 'transport-failed');
    const success = recordWorkerOutcome({ ...base, turn: 'continued', command: 'turn', status: 'completed', exit: 0, final: 'DONE' });
    assert.equal(success.result, 'pass'); assert.equal(success.rounds, 0);
    assert.equal(recordWorkerOutcome({...base,turn:'later-transport',command:'turn'}).rounds,0);
  });
  check('router ledger joins terminal transport errors, ignores failures and stronger launch dominance', () => {
    const outcome = failed('turn');
    const launch = { ...outcome, kind:'launch-model', accepted:true, state:'failed', failureKind:'quality',
      actual:{ accountId:'main', modelId:'gpt-6-astra', effort:'max' }, result:undefined };
    const r = route([launch,outcome],1);
    assert.equal(r.failures,0); assert.equal(r.plan.task.qualityFailures,0); assert.equal(r.plan.task.previousAttempts.length,0);
    assert.equal(r.blocked,false); assert.equal(r.pick.model,'gpt-6.1-sol'); assert.notEqual(r.pick.effort,'max');
    assert.match(r.why.join('\n'),/Ignored 1 transport-failed/);
    const direct = createTaskSpec({ category:'implement', taskId:'task', requestId:'transport-test', sandboxCeiling:'danger-full-access',
      flags:{ name:'task', impact:'service', failures:'2' }, previousAttempts:[
        { id:'transport',taskId:'task',state:'transport-failed',failureKind:'quality',actualStatus:'KNOWN' },
        { id:'quality',taskId:'task',state:'failed',failureKind:'quality',actualStatus:'KNOWN',
          actual:{accountId:'main',modelId:'gpt-6.1-sol',effort:'high'} }] });
    assert.equal(direct.failures,1); assert.equal(direct.qualityFailures,1); assert.equal(direct.previousAttempts.length,1);
    assert.equal(createTaskSpec(direct).failures,1, 'normalization must not subtract twice');
    fs.writeFileSync(path.join(routeDir,'attempts.json'),JSON.stringify([{...launch,id:'transport-attempt',taskId:'task',state:'transport-failed',failureKind:'transport-failed'}]));
    const named = route([],1,false,['--task-dir',routeDir,'--previous-attempt','attempts.json']);
    assert.equal(named.blocked,false); assert.equal(named.failures,0); assert.equal(named.plan.task.floor.previousAttemptIds.length,0);
    assert.match(route([],0,false,['--no-auto-continue']).pick.command,/--no-auto-continue/);
    const explicit = {...outcome,actual:[{account:'main',model:'gpt-6-astra',effort:'max'}]};
    const matched = route([launch,explicit],1,false,['--actual','codex:gpt-6-astra:max@main']);
    assert.equal(matched.failures,0); assert.equal(matched.blocked,false); assert.equal(matched.plan.task.previousAttempts.length,0);
    const quality = {...explicit,turn:'older-quality',t:now-2000,result:'fail',failureKind:'quality'};
    const mixed = route([quality,explicit],2,false,['--actual','codex:gpt-6-astra:max@main,codex:gpt-6-astra:max@main']);
    assert.equal(mixed.failures,1); assert.equal(mixed.plan.task.previousAttempts.length,1);
  });
  check('lane demotion lasts 30 minutes, dedupes turns, and never bans the only lane', () => {
    const recent = [failed('first'),failed('second')];
    assert.equal(transportLaneFailures([...recent,recent[0],failed('old',now-1800001),failed('future',now+1)],'main','gpt-6.1-sol',now),2);
    assert.equal(route().pick.account,'main');
    assert.equal(route(recent).pick.account,'alt');
    assert.match(route(recent).why.join('\n'),/Transport lane demoted: main:gpt-6.1-sol/);
    assert.equal(route(recent,0,true).pick.account,'main');
    assert.equal(route(recent.map(r=>({...r,t:now-1800001}))).pick.account,'main');
  });
  check('manual transport correction binds the latest terminal turn for cutover routing', () => {
    const original = {...failed('legacy-turn'),auto:true,result:'fail',failureKind:'infra',cause:'infra',actual:[{account:'main',model:'gpt-6-astra',effort:'max'}]};
    const launch = {...original,kind:'launch-model',state:'failed',accepted:true,actual:{accountId:'main',modelId:'gpt-6-astra',effort:'max'}};
    fs.writeFileSync(routeLog,[launch,original].map(JSON.stringify).join('\n')+'\n');
    const r = spawnSync(process.execPath,[path.join(scripts,'outcome.mjs'),'--project','p','--name','task','--correct',
      '--result','transport-failed','--rounds','0'],{encoding:'utf8',env:{...process.env,RULES_SHARED:routeDir,ROUTE_LOG_FILE:routeLog}});
    assert.equal(r.status,0,r.stderr);
    const corrected = fs.readFileSync(routeLog,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(corrected.at(-1).thread,'thread'); assert.equal(corrected.at(-1).turn,'legacy-turn');
    assert.equal(corrected.at(-1).failureKind,'transport-failed');
    const rerouted = route(corrected.map(r=>({...r,t:Math.min(r.t,now)})),1); assert.equal(rerouted.failures,0); assert.equal(rerouted.blocked,false);
    assert.equal(route(corrected.map(r=>({...r,t:Math.min(r.t,now)})),1,false,['--actual','codex:gpt-6-astra:max@main']).failures,0);
  });
  check('terminal corrections consume one tuple identity and preserve an identical earlier quality floor', () => {
    const actual=[{account:'main',model:'gpt-6-astra',effort:'max'}];
    const quality={...failed('Q',now-3000),actual,result:'fail',failureKind:'quality',cause:'code'};
    const original={...failed('T',now-2000),actual,result:'fail',failureKind:'infra',cause:'infra'};
    const correction={...original,t:now-1000,correction:true,result:'transport-failed',failureKind:'transport-failed'};
    const args=['--actual','codex:gpt-6-astra:max@main,codex:gpt-6-astra:max@main'];
    for (const changed of [correction,{t:now-1000,kind:'outcome',project:'p',name:'task',category:'implement',
      thread:'thread',turn:'T',correction:true,result:'transport-failed',failureKind:'transport-failed'}]) {
      const r=route([quality,original,changed],2,false,args);
      assert.equal(r.failures,1); assert.equal(r.plan.task.qualityFailures,1); assert.equal(r.plan.task.previousAttempts.length,1);
      assert.equal(r.plan.task.previousAttempts[0].failureKind,'quality');
      assert.equal(r.plan.task.previousAttempts[0].actual.modelId,'gpt-6-astra');
      assert.equal(r.plan.task.previousAttempts[0].actual.effort,'max');
      assert.ok(r.plan.rejected.some(p=>p.reason?.code==='RETRY_BELOW_ACTUAL_FLOOR'));
    }
  });
  check('follower retries once on the same thread with 60s backoff and fixed state-check message', () => {
    const f = follower('retry-success'); const r = f.run(); assert.equal(r.status,0,r.stderr+r.stdout);
    const starts = f.calls().filter(r=>r.method==='turn/start'); assert.equal(starts.length,2);
    assert.equal(starts[1].params.threadId,'transport-thread'); assert.equal(starts[1].params.model,starts[0].params.model);
    assert.equal(starts[1].params.effort,starts[0].params.effort); assert.equal(starts[1].params.input[0].text,TRANSPORT_CONTINUE_MESSAGE);
    assert.equal(f.calls().filter(r=>r.backoffMs===60000).length,1); assert.match(r.stderr,/\[transport-retry\].*after 60s/);
    assert.deepEqual(f.outcomes().map(r=>[r.result,r.rounds]),[['transport-failed',0],['pass',0]]);
    assert.equal(fs.readFileSync(path.join(f.dir,'final.md'),'utf8'),'DONE transport fixture\n');
  });
  check('model access denial persists and does not auto-continue or restart a saved lane', () => {
    const f = follower('model-access', { errors: [accessError] });
    const result = f.run(); assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /model-access: gpt-6.1-sol demoted; recovery probe due/);
    assert.match(result.stderr, /provider model access unavailable; re-route/);
    assert.doesNotMatch(result.stderr, /continue manually:/);
    assert.equal(f.calls().filter(row => row.method === 'turn/start').length, 1);
    assert.deepEqual(f.outcomes().map(r => [r.result,r.rounds]), [['transport-failed',0]]);
    assert.equal(f.run().status, 1);
    assert.equal(f.calls().filter(row => row.method === 'thread/start').length, 1);
  });
  check('W754: after five overlapping failures and 40 minutes, route Sol while one Astra probe gets the lane', () => {
    const home = path.join(tmp,'w754'); fs.mkdirSync(home);
    const ASTRA = 'gpt-6-astra', SOL = 'gpt-6.2-sol', min = 60000;
    const t0 = Date.parse('2026-11-23T22:25:00Z'), reset = t0 + 150 * min;
    assert.ok(isModelAccessFailure(accessError));
    assert.ok(isModelAccessFailure('Access denied for model GPT-6-Astra'));
    assert.equal(isModelAccessFailure(`${accessError} (983)`), false);
    assert.equal(isModelAccessFailure('403 Forbidden from login'), false);
    const first = noteModelAccessFailure(home, ASTRA.toUpperCase(), t0, reset);
    assert.equal(first.pausedUntil, t0 + 30 * min);
    for (let i = 1; i < 5; i++) assert.deepEqual(noteModelAccessFailure(home, ASTRA, t0 + i * min, reset), first);
    const runAt = at => {
      const state = { checkedAt: at, codexAccounts: [{ name:'trae', kind:'trae', home, live:true, healthy:true, windows:[],
        models:[ASTRA,SOL], load:{[SOL]:{percent:47,t:at}},
        quota:{sampledAt:at,daily:{[ASTRA]:{used:0,limit:58,remaining:58,depleted:false,resetsAt:reset},
          [SOL]:{used:10,limit:80,remaining:70,depleted:false,resetsAt:reset}}} }], claude:null, errors:{}, history:{} };
      fs.writeFileSync(cache,JSON.stringify(state));
      const out = spawnSync(process.execPath,[path.join(scripts,'route.mjs'),'implement-hard','--impact','service','--failures','0','--dry','--json'],
        {encoding:'utf8',env:{...process.env,HOME:home,RULES_SHARED:home,QUOTA_CACHE:cache,CODEX_ACCOUNTS:path.join(home,'none.json'),
          ROUTE_NOW:String(at),ROUTE_SNAPSHOT_FILE:'',TRAE_PROBE:'0',QUOTA_LOG:'0',ROUTE_LOG:'0'}});
      assert.equal(out.status,0,out.stderr); return JSON.parse(out.stdout);
    };
    assert.equal(runAt(t0 + 25 * min).pick.model,SOL);
    const at = t0 + 40 * min;
    let route = runAt(at); assert.equal(route.pick.model,SOL);
    assert.match(route.why.join('\n'), /Model lane demoted: trae:gpt-6-astra.*recovery probe due since 2026-11-23T22:55:00/);
    assert.equal(route.plan.task.qualityFailures,0);
    assert.deepEqual(claimProbes(home,t0 + 30 * min - 1),[]);
    noteSuccess(home,SOL,at); noteSuccess(home,ASTRA,at);
    assert.ok(readModelPauses(home,at)[ASTRA], 'an unrelated or older completion cannot clear the pause');
    const [probe] = claimProbes(home,at); assert.equal(probe.model,ASTRA); assert.equal(probe.scope,'model');
    assert.deepEqual(claimProbes(home,at),[]);
    assert.equal(modelProbeResult(home,ASTRA,probe.claim,true,'',at),false,'unstarted probe cannot clear');
    assert.equal(startModelProbe(home,ASTRA,probe.claim,at),true);
    assert.equal(startModelProbe(home,ASTRA,probe.claim,at),false);
    route = runAt(at); assert.equal(route.pick.model,SOL); assert.match(route.why.join('\n'), /recovery probe in progress/);
    assert.equal(modelProbeResult(home,ASTRA,probe.claim,false,accessError,at),true);
    const secondAt = at + 60 * min;
    assert.equal(readModelPauses(home,at)[ASTRA].pausedUntil,secondAt);
    assert.deepEqual(claimProbes(home,secondAt-1),[]);
    const [second] = claimProbes(home,secondAt);
    assert.equal(startModelProbe(home,ASTRA,second.claim,secondAt),true);
    assert.equal(modelProbeResult(home,ASTRA,second.claim,false,accessError,secondAt),true);
    assert.equal(readModelPauses(home,secondAt)[ASTRA].pausedUntil,reset,'two-hour backoff is capped by the provider reset');
    const [third] = claimProbes(home,reset); assert.equal(startModelProbe(home,ASTRA,third.claim,reset),true);
    assert.equal(modelProbeResult(home,ASTRA,second.claim,true,'',reset),false);
    assert.equal(modelProbeResult(home,ASTRA,third.claim,true,'',reset),true);
    assert.deepEqual(readModelPauses(home,reset),{});
    assert.equal(runAt(at).pick.model,ASTRA,'successful probe puts Astra back on the normal quality ladder');
  });
  check('second transport failure stops with an exact continue command and receipt prevents wait duplication', () => {
    const f = follower('retry-stop',{errors}); const r = f.run(); assert.equal(r.status,1,r.stderr+r.stdout);
    assert.equal(f.calls().filter(r=>r.method==='turn/start').length,2);
    assert.match(r.stderr,/stopped: one automatic continuation already claimed; continue manually: .*codex-worker.mjs.*--account fixture turn --thread transport-thread/);
    assert.deepEqual(f.outcomes().map(r=>r.result),['transport-failed','transport-failed']);
    const launch = JSON.parse(fs.readFileSync(path.join(f.dir,'worker-launches/fixture/transport-thread.json'),'utf8'));
    assert.equal(launch.transportRetry.sourceTurn,'transport-turn-1'); assert.equal(launch.transportRetry.continuationTurn,'transport-turn-2');
    assert.equal(launch.turn,'transport-turn-2');
  });
  check('failed fresh hub read cancels continuation even when another follower cached a terminal state', () => {
    const f=follower('retry-unconfirmed-hub',{cachedTerminalAfterBackoff:true,hubReadFailureAfterBackoff:true});
    const r=f.run(); assert.equal(r.status,1,r.stderr+r.stdout);
    assert.match(r.stderr,/fresh hub state could not be confirmed after backoff/);
    assert.equal(f.calls().filter(r=>r.method==='turn/start').length,1);
    const source={id:'source',status:'failed'};
    assert.equal(transportSourceBlock({result:{thread:{id:'thread',turns:[source]}},threadId:'thread',sourceTurn:'source'}),null);
    for(const result of [{},{thread:{turns:[]}},{thread:{turns:[source],status:{type:'unknown'}}},{thread:{turns:[{id:'source',status:'unknown'}]}},
      {thread:{turns:[source,{id:'newer',status:'completed'}]}},
      {thread:{turns:[source],activeTurn:{id:'newer',status:'inProgress'}}}])
      assert.ok(transportSourceBlock({result,threadId:'thread',sourceTurn:'source'}));
  });
  check('lost continuation acknowledgement is consumed before a later follower observes its failed turn', () => {
    const f=follower('retry-lost-ack',{errors,loseContinuationAck:true});
    const first=f.run(); assert.equal(first.status,7,first.stderr+first.stdout);
    assert.equal(f.calls().filter(r=>r.method==='turn/start').length,2);
    const file=path.join(f.dir,'worker-launches/fixture/transport-thread.json');
    const claim=JSON.parse(fs.readFileSync(file,'utf8')).transportRetry;
    assert.equal(claim.phase,'starting'); assert.equal(claim.sourceTurn,'transport-turn-1');
    assert.equal(claim.continuationTurn,undefined);
    const later=f.run('wait',{loseContinuationAck:false,existingTurns:[
      {id:'transport-turn-1',status:'failed',error:{message:errors[0]},items:[]},
      {id:'transport-turn-2',status:'failed',error:{message:errors[1]},items:[]}]});
    assert.equal(later.status,1,later.stderr+later.stdout);
    assert.match(later.stderr,/unacknowledged automatic continuation claim is consumed.*continue manually:/);
    assert.equal(f.calls().filter(r=>r.method==='turn/start').length,2,'later follower must not create turn three');
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).transportRetry,claim);
    process.env.RULES_SHARED=f.dir;
    assert.match(claimTransportContinuation('fixture','transport-thread','different-turn'),/unacknowledged.*consumed/);
  });
  check('no-auto-continue persists across wait and review seats honor the flag', () => {
    for (const review of [false,true]) {
      const f = follower(`retry-disabled-${review}`,{review},['--no-auto-continue']);
      assert.equal(f.run().status,1); assert.equal(f.calls().filter(r=>r.method==='turn/start').length,1);
      assert.equal(f.calls().filter(r=>r.backoffMs).length,0);
      const saved = JSON.parse(fs.readFileSync(path.join(f.dir,'worker-launches/fixture/transport-thread.json'),'utf8'));
      assert.equal(saved.defaults['no-auto-continue'],true);
    }
    const review = follower('retry-review',{review:true,final:'DONE\nREVIEW-RESULT: none'});
    assert.equal(review.run().status,0); assert.equal(review.calls().filter(r=>r.method==='turn/start').length,2);
  });
  check('wait followers continue terminal failures and exhausted quota skips continuation', () => {
    const f = follower('retry-wait',{wait:true});
    process.env.RULES_SHARED=f.dir;
    saveLaunch('fixture','transport-thread',{name:'retry-wait',project:'p',model:'gpt-6.1-sol',effort:'high',sandbox:'read-only',
      'routed-seat':JSON.stringify({category:'implement'})},'053283ad-1bc8-5a31-ad44-d68e6b199eb6');
    const waited = f.run('wait'); assert.equal(waited.status,0,waited.stderr+waited.stdout); assert.equal(f.calls().filter(r=>r.method==='turn/start').length,1);
    const depleted = follower('retry-quota',{exhausted:true}); const r=depleted.run();
    assert.equal(r.status,1); assert.match(r.stderr,/quota exhausted/); assert.equal(depleted.calls().filter(r=>r.method==='turn/start').length,1);
  });
  check('durable retry claims and stalled/unknown quota prevent unsafe automatic repeats', () => {
    const home = path.join(tmp,'health'); fs.mkdirSync(home);
    fs.writeFileSync(path.join(home,'lane-state.json'),JSON.stringify({'gpt-6.1-sol':{t:now,state:'queued',position:10,drainPerMin:0}}));
    assert.equal(transportHealthBlock({home,model:'gpt-6.1-sol',now}),'lane stalled');
    assert.equal(transportQuotaBlock({kind:'trae',payload:{},now}),'lane quota unknown');
    assert.equal(transportQuotaBlock({payload:{rateLimits:{primary:{usedPercent:100}}},now}),'lane quota exhausted');
    assert.equal(transportQuotaBlock({kind:'ttadk',account:'t',now,cache:{checkedAt:now-900001,codexAccounts:[{name:'t',usage:{used:1,limit:100,resetsAt:now+1000}}]}}),'lane quota unknown or stale');
    process.env.RULES_SHARED=home; saveLaunch('a','thread',{model:'gpt-6.1-sol'},'owner');
    assert.equal(claimTransportContinuation('a','thread','turn'),null);
    assert.equal(claimTransportContinuation('a','thread','turn'),'one automatic continuation already claimed');
    assert.equal(savedLaunch('a','thread').transportRetry.phase,'claimed');
    assert.match(claimTransportContinuation('a','thread','different'),/unacknowledged.*consumed/);
    markTransportContinuationStarting('a','thread','turn'); assert.equal(savedLaunch('a','thread').transportRetry.phase,'starting');
    saveTransportContinuation('a','thread','turn','next');
    assert.equal(savedLaunch('a','thread').transportRetry.phase,'acknowledged');
    assert.equal(claimTransportContinuation('a','thread','next'),'one automatic continuation already claimed');
  });
  console.log(`${count} scenarios passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
