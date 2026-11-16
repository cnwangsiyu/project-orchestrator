#!/usr/bin/env node
// All observations, extension hosts and event journals are private fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRouteJSON } from './helpers/route-fixture.mjs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {parseTaskSpec,routePure,renderPlan} from '../lib/pipeline/index.mjs';
import {acquireRoute} from '../lib/route-data.mjs';
import {appendEvent,readEvents,inbox,readAck,deliver,deliverAsync,readInboxAsync,eventLine,answerQuestion,auditWorkerEvents,hasWatcher,compactWorkerEvents} from '../lib/worker-events.mjs';

const root=new URL('../../',import.meta.url).pathname;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'router-tail-'));
const oldShared=process.env.RULES_SHARED;process.env.RULES_SHARED=tmp;
const snapshot=parseRouteJSON(fs.readFileSync(new URL('./fixtures/free-trae-fresh-ttadk-2026-11-15.json',import.meta.url),'utf8'));
for(const part of [...snapshot.accounts,...snapshot.lanes]) {
  part.capabilities['app:com.apple.calculator']={status:'KNOWN',value:true,sampledAt:snapshot.decisionAt,receivedAt:snapshot.decisionAt,maxAgeMs:600000,source:'fixture'};
  for(const scope of ['*.bytedance.net','*.byted.org','*.larkoffice.com','*.feishu.cn','*.tiktok-row.net','*.byteintl.net','*.bytedance.com','localhost','127.0.0.1'])
    part.capabilities[`origin:${scope}`]={status:'KNOWN',value:true,sampledAt:snapshot.decisionAt,receivedAt:snapshot.decisionAt,maxAgeMs:600000,source:'fixture'};
}
const file=path.join(tmp,'snapshot.json');fs.writeFileSync(file,JSON.stringify(snapshot));
const env={...process.env,HOME:tmp,RULES_SHARED:tmp,CODEX_ACCOUNTS:path.join(tmp,'accounts.json'),QUOTA_CACHE:path.join(tmp,'cache.json'),
  ROUTE_LOG_FILE:path.join(tmp,'routes.jsonl'),ROUTE_NOW:String(snapshot.decisionAt),ROUTE_SNAPSHOT_FILE:file,ROUTE_REQUEST_ID:'tail-fixture'};
const cli=(args,extra={})=>{
  const r=spawnSync(process.execPath,[path.join(root,'scripts/route.mjs'),...args,'--dry','--json'],{env:{...env,...extra},encoding:'utf8',timeout:10000,maxBuffer:16<<20});
  assert.equal(r.status,0,r.stderr);return parseRouteJSON(r.stdout);
};
const record=(owner,event,name,extra={})=>appendEvent({owner,event,name,runId:name,account:'fixture',thread:'fixture-thread',...extra});
try {
  for(const category of ['browser','ui-browser']) {
    const base=[category,'--name','tool-retry','--project','fixture','--failures','1','--failure-kind','tool'];
    const fromTrae=cli([...base,'--actual','codex:gpt-6.1-sol:medium@trae']);
    assert.equal(fromTrae.pick.account,'ttadk');assert.equal(fromTrae.pick.effort,category==='browser'?'medium':'high');
    assert.equal(fromTrae.failureKind,'tool');
    assert.ok(fromTrae.plan.trace.candidates.filter(r=>r.candidate.accountId==='trae').every(r=>r.predicates.some(p=>p.reason?.code==='TOOL_CHANNEL_FAILED')));
    fs.writeFileSync(path.join(tmp,'attempts.json'),JSON.stringify([{id:'completed-tool',taskId:'tool-retry',project:'fixture',category,role:'primary',kind:'attempt',state:'completed',actualStatus:'KNOWN',actual:{accountId:'trae',modelId:'gpt-6.1-sol',effort:'medium'}}]));
    const completed=cli([...base,'--task-dir',tmp,'--previous-attempt','attempts.json']);assert.equal(completed.pick.account,'ttadk','completed worker status does not erase a reported tool failure');
    const fromTT=cli([...base,'--actual','codex:gpt-6.1-sol:medium@ttadk']);assert.equal(fromTT.pick.account,'trae');
    const personal=cli([...base].concat(['--actual','codex:gpt-6.1-sol:medium@trae,codex:gpt-6.1-sol:medium@ttadk']));
    assert.equal(personal.kind,'blocked');assert.ok(personal.needsUserOK.length);assert.equal(personal.pick.command,null);
    const personalArgs=[...base,'--actual','codex:gpt-6.1-sol:medium@trae,codex:gpt-6.1-sol:medium@ttadk'];
    const approvedSnapshot=structuredClone(snapshot);
    approvedSnapshot.approvals=[{id:'fixture-ok',userDecisionRef:'synthetic-user-yes',grantedAt:snapshot.decisionAt-1000,expiresAt:snapshot.decisionAt+60000,revoked:false,
      scopes:personal.plan.gates.filter(g=>g.scope).map(g=>({...g.scope,allowPersonalWithCompany:true}))}];
    fs.writeFileSync(file,JSON.stringify(approvedSnapshot));
    const approved=cli([...personalArgs,'--user-ok','fixture-ok']);assert.equal(approved.kind,'launch',JSON.stringify({why:approved.why,gates:approved.plan.gates}));assert.ok(['main','b'].includes(approved.pick.account));
    fs.writeFileSync(file,JSON.stringify(snapshot));
    const claude=cli([...base,'--actual','codex:gpt-6.1-sol:medium@trae,codex:gpt-6.1-sol:medium@ttadk,codex:gpt-6.1-sol:medium@main']);
    assert.equal(claude.pick.vendor,'claude');assert.equal(claude.kind,'blocked');assert.ok(claude.needsUserOK.length);assert.equal(claude.pick.command,null);
    const accountless=cli([...base,'--actual','codex:gpt-6.1-sol:medium']);assert.equal(accountless.pick.account,'ttadk');assert.match(accountless.why.join(' '),/actual browser account is unknown.*assumed failed trae/);
    const inferred=cli(base);assert.equal(inferred.pick.account,'ttadk');assert.match(inferred.why.join(' '),/assumed 1 failed browser channel/);
  }
  const quality=cli(['browser','--failures','1','--actual','codex:gpt-6.1-sol:medium@trae']);
  assert.equal(quality.failureKind,'quality');assert.equal(quality.pick.account,'trae');assert.equal(quality.pick.effort,'high');
  const infra=cli(['browser','--failure-kind','infra','--failures','1','--actual','codex:gpt-6.1-sol:medium@trae']);
  assert.equal(infra.pick.effort,'medium');
  const desktop=cli(['computer-use','--apps','com.apple.calculator','--failure-kind','tool','--failures','1','--actual','codex:gpt-6.1-sol:medium@ttadk']);
  assert.equal(desktop.kind,'blocked');assert.ok(desktop.needsUserOK.length);
  console.log('PASS BC-24 tool failures switch browser/desktop channels, quality escalates and infra retains effort');

  const logged=spawnSync(process.execPath,[path.join(root,'scripts/route.mjs'),'browser','--name','logged-tool','--project','fixture','--failures','1','--failure-kind','tool','--actual','codex:gpt-6.1-sol:medium@trae','--json'],{env:{...env,ROUTE_LOG:'1'},encoding:'utf8',timeout:10000,maxBuffer:16<<20});
  assert.equal(logged.status,0,logged.stderr);assert.equal(parseRouteJSON(fs.readFileSync(env.ROUTE_LOG_FILE,'utf8').trim().split('\n').at(-1)).failureKind,'tool');
  const outcome=spawnSync(process.execPath,[path.join(root,'scripts/outcome.mjs'),'--project','fixture','--name','logged-tool','--result','fail','--failure-kind','tool'],{env,encoding:'utf8',timeout:5000});assert.equal(outcome.status,0,outcome.stderr);assert.equal(parseRouteJSON(fs.readFileSync(env.ROUTE_LOG_FILE,'utf8').trim().split('\n').at(-1)).failureKind,'tool');
  const origins=cli(['browser','--project','acq','--origins','example.com']);
  for(const host of ['instagram.com','*.instagram.com','youtube.com','*.youtube.com','facebook.com','*.facebook.com','*.bytedance.net','example.com'])assert.ok(origins.plan.task.allowedOrigins.includes(host));
  assert.equal(cli(['browser']).plan.task.allowedOrigins.includes('instagram.com'),false);
  for(const extra of [[],['--env','test'],['--env','test','--background','--stakes','low']]) {
    const r=cli(['build-run','--impact','release','--review-class','A','--review-reason','external irreversible release',...extra]);assert.notEqual(r.tier,'light');
  }
  assert.equal(cli(['build-run','--env','test']).tier,'light');
  for(const args of [['build-run'],['browser','--failures','1'],['analysis','--failures','1']])assert.match(cli(args).allNotes.join('\n'),/full checked checklist.*non-secret variables.*expected artifacts/);
  assert.match(cli(['build-run']).allNotes.join('\n'),/Library\/SplashBoard\/.*readable before any install.*over the top/);
  const claude=cli(['claude-tools','--cwd','/fixture/work tree','--task-dir','/fixture/task dir','--trusted-cwd','/fixture/trusted root']);
  assert.match(claude.pick.command,/cd '\/fixture\/trusted root' && claude/);assert.match(claude.pick.command,/Working directory: \/fixture\/work tree/);
  assert.match(cli(['claude-tools']).allNotes.join('\n'),/no trusted project root configured/);
  console.log('PASS BC-13/18/19/22/48 checklist, trusted launch, origins, release tier and backup notes');

  // AU-7 ("--dry never refreshes") was withdrawn by the owner on 2026-11-15: a preview must read state like a real
  // route, otherwise it shows lanes the real route would not. --dry only skips logging and rotation.
  console.log('PASS AU-7 withdrawn: --dry reads state like a real route');

  const owner='01234567-89ab-4cde-8123-456789abcdef';
  record(owner,'running','anchor');
  const q=record(owner,'question','early-question',{questionId:'early-answer',text:'Which baseline?',expiresAt:Date.now()+60000,timeoutMin:1,default:'A'});
  answerQuestion({owner,account:'fixture',thread:'fixture-thread',questionId:'early-answer',text:'Use B'});
  const got=inbox(readEvents(),owner,readAck(owner)).pending.find(r=>r.id===q.id);assert.equal(got.event,'answered');assert.match(eventLine(got),/answered: Which baseline\? → Use B/);assert.doesNotMatch(eventLine(got),/asks|reply/);
  const alias=record('01234567','finished','alias');
  assert.equal(readEvents().find(r=>r.id===alias.id).owner,owner);assert.ok((await readInboxAsync(owner)).pending.some(r=>r.id===alias.id));
  let printed=[];await deliverAsync(owner,async rows=>printed.push(...rows));assert.ok(printed.some(r=>r.id===alias.id));assert.equal(inbox(readEvents(),owner,readAck(owner)).pending.length,0);
  assert.equal(deliver(owner,()=>{throw Error('duplicate delivery');}).length,0);
  const syncAlias=record('01234567','finished','sync-alias');deliver('01234567',()=>{});assert.ok(readAck(owner).delivered[syncAlias.id]);
  const asyncAlias=record('01234567','finished','async-alias');assert.ok((await readInboxAsync('01234567')).pending.some(r=>r.id===asyncAlias.id));await deliverAsync('01234567',async()=>{});assert.ok(readAck(owner).delivered[asyncAlias.id]);
  const watcher=spawn(process.execPath,[path.join(root,'scripts/codex-worker.mjs'),'watch','--owner','01234567'],{env,stdio:['ignore','pipe','pipe']});
  let watchOutput='';watcher.stdout.on('data',b=>watchOutput+=b);const stopped=new Promise(resolve=>watcher.on('exit',resolve));
  try {const deadline=Date.now()+4000;while(!hasWatcher(owner)){if(Date.now()>deadline)throw Error('prefix watch did not arm');await new Promise(r=>setTimeout(r,25));}
    const watchAlias=record('01234567','finished','watch-alias');assert.equal(await stopped,0);assert.match(watchOutput,/watch-alias/);assert.ok(readAck(owner).delivered[watchAlias.id]);
  } finally {if(watcher.exitCode===null)watcher.kill('SIGTERM');}
  const audit=auditWorkerEvents();assert.ok(audit.find(r=>r.owner===owner).acknowledged>=2);assert.equal(audit.some(r=>r.owner==='01234567'),false);
  record('01234567-aaaa-4cde-8123-456789abcdef','running','other-anchor');
  record('01234567','finished','ambiguous');record('fedcba98','finished','unmatched');
  assert.equal(new Set(inbox(readEvents(),owner,readAck(owner)).unresolved.map(r=>r.owner)).size,2);
  const unresolved=auditWorkerEvents();assert.equal(unresolved.find(r=>r.owner==='01234567').unresolved,'ambiguous');assert.equal(unresolved.find(r=>r.owner==='fedcba98').unresolved,'unmatched');
  const mine=spawnSync(process.execPath,[path.join(root,'scripts/codex-worker.mjs'),'mine','--owner','unrelated-owner'],{env:{...env,ROUTE_LOG:'0'},encoding:'utf8',timeout:5000});
  assert.equal(mine.status,0,mine.stderr);assert.match(mine.stdout,/unresolved owner 01234567: ambiguous/);assert.match(mine.stdout,/unresolved owner fedcba98: unmatched/);
  for(let i=0;i<70;i++)record('rotation-owner','finished',`rotation-${i}`);deliver('rotation-owner',()=>{});compactWorkerEvents();
  assert.ok(readEvents().some(r=>r.owner==='fedcba98'&&r.ownerResolution==='unmatched'),'compaction preserves unresolved events');
  assert.equal(auditWorkerEvents().find(r=>r.owner==='fedcba98').ownerStatus,'UNKNOWN');
  console.log('PASS BC-47/NR-04 early answers render once; short owners deliver/count under full UUID; unresolved aliases surface');
} finally {
  if(oldShared===undefined)delete process.env.RULES_SHARED;else process.env.RULES_SHARED=oldShared;
  fs.rmSync(tmp,{recursive:true,force:true});
}
