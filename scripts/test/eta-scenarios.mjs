#!/usr/bin/env node
// ETA acceptance against synthetic lanes and the real route/review-data CLIs. No provider or device access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ETA, laneEta, patienceMinutes, workMinutes, ttadkEta } from '../lib/eta.mjs';
import { createQueueRecorder, readLaneState } from '../lib/company-load.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-acceptance-'));
const now = Date.now(), min = 60000, SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra';
const home = path.join(tmp, 'fixture-home'); fs.mkdirSync(home);
const traeHome = path.join(tmp, 'trae'); fs.mkdirSync(traeHome);
const cache = path.join(tmp, 'quota.json'), outcomes = path.join(tmp, 'outcomes.jsonl');
const profiles = path.join(tmp, 'profiles.json'); fs.writeFileSync(profiles, '{}');
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
for (const cli of ['codex', 'claude']) fs.writeFileSync(path.join(bin, cli), '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', {mode:0o755});
const env = {...process.env, HOME:home, PATH:`${bin}:${process.env.PATH}`, CODEX_ACCOUNTS:profiles,
  QUOTA_CACHE:cache, ROUTE_NOW:String(now), ROUTE_LOG:'0', ROUTE_LOG_FILE:outcomes, QUOTA_LOG:'0', QUOTA_LOG_FILE:path.join(tmp,'no-quota-history'),
  TRAE_PROBE:'0', ROUTE_RR:path.join(tmp,'rotation')};
const bucket = (depleted=true) => ({depleted, used:depleted?80:1, limit:80, remaining:depleted?0:79, resetsAt:now+360*min});
const lane = (position, drainPerMin, extra={}) => ({t:now, state:'queued', position, drainPerMin, ...extra});
const route = ({lanes={}, familyQueue={}, resetMin=540, ttAvailable=false, daily={[SOL]:bucket(),[ASTRA]:bucket()}, args=['implement-hard'], history=[]}={}) => {
  fs.writeFileSync(path.join(traeHome,'lane-state.json'),JSON.stringify(lanes));
  fs.writeFileSync(path.join(traeHome,'queue-state.json'),JSON.stringify(familyQueue));
  fs.writeFileSync(outcomes,history.map(JSON.stringify).join('\n'));
  const tt = {name:'ttadk',kind:'ttadk',home:path.join(tmp,'tt'),models:[SOL,'gpt-5.6-terra'],healthy:ttAvailable,
    reason:ttAvailable?null:'its daily token quota is used up',windows:[],usage:{used:ttAvailable?10:100,limit:100,resetsAt:now+resetMin*min}};
  const tr = {name:'trae',kind:'trae',home:traeHome,healthy:true,live:true,search:true,searchLive:true,windows:[],
    models:[SOL,ASTRA,'gpt-5.6-sol','gpt-5.6-terra','gpt-5.5','deepseek-v4.1-flash'],
    quota:{sampledAt:now,daily}, load:{}};
  fs.writeFileSync(cache,JSON.stringify({checkedAt:now,claude:[{label:'week',used:10,resetsAt:now+120*60*min,windowMins:10080}],
    codexAccounts:[tt,tr],errors:{},history:{}}));
  const flags = ['implement-hard','implement','debug','science'].includes(args[0]) ? ['--impact','service'] : [];
  const raw = execFileSync(process.execPath,[path.join(scripts,'route.mjs'),...args,...flags,'--dry','--json'],
    {env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(raw.trim().split('\n').length,1,'dry JSON stdout is a single document');
  return JSON.parse(raw);
};
try {
  let r = route();
  assert.equal(r.pick.model,SOL); assert.equal(r.deferred,null); assert.equal(r.queuePatienceMin,30);
  assert.match(r.pick.command,/--queue-patience-min/); assert.match(r.queueAlt,/--failures 0.*--exclude-lane/);
  assert.equal(r.queueAlternative.routeArgs.includes('--fresh'),false);
  assert.ok(r.why.some((s)=>/ETA: task estimate.*chosen lane: company/.test(s)));
  assert.ok(!r.needsUserOK.some((s)=>s.startsWith('personal quota:')));
  r = route({lanes:{[ASTRA]:lane(500,0.5)}});
  assert.match(r.queueAlt,/scheduled dispatch.*--exclude-lane trae:gpt-6.1-sol/);
  assert.equal(r.queueAlternative.account,'ttadk'); assert.equal(r.queueAlternative.model,SOL);
  assert.ok(!r.queueAlt.includes("--exclude-model 'gpt-6.1-sol'"),'TTADK handoff must keep the same model eligible');
  r = route({daily:{[SOL]:bucket(),[ASTRA]:bucket(false)},lanes:{[SOL]:lane(null,null,{state:'ready',lastProgressAt:now-29*min,itemsPerMin:2})}});
  assert.equal(r.pick.model,ASTRA,'free hard Astra precedes Sol even when Sol spends no priority quota');
  assert.equal(r.eta.find((x)=>x.model===SOL&&x.account==='trae').basis,'progressing');
  r = route({familyQueue:{gpt:{t:now,state:'queued',position:537}},
    lanes:{[SOL]:lane(null,null,{state:'ready',lastProgressAt:now,itemsPerMin:2}),[ASTRA]:lane(537,0.7)}});
  assert.equal(r.eta.find((x)=>x.model===SOL&&x.account==='trae').basis,'progressing',
    'Astra family queue cannot hide fresh Sol progress');
  r = route({ttAvailable:true,lanes:{[SOL]:lane(null,null,{state:'ready',lastProgressAt:now})}});
  assert.equal(r.pick.account,'ttadk','free TTADK Astra precedes free TRAE Sol in the hard ladder');
  r = route({ttAvailable:true,lanes:{[SOL]:lane(500,0.5),[ASTRA]:lane(500,0.5)}});
  assert.equal(r.pick.account,'ttadk','available TTADK beats measured queued lanes');
  r = route({lanes:{[SOL]:lane(10,1),[ASTRA]:lane(20,20)},resetMin:100});
  assert.equal(r.pick.model,SOL,'free TTADK Sol precedes measured queued TRAE Astra');
  assert.ok(r.why.some((s)=>/gpt-6-astra@trae queue ~1 min/.test(s)));
  r = route({lanes:{[SOL]:lane(10,5),[ASTRA]:lane(20,5)},resetMin:240});
  assert.equal(r.pick.account,'trae','runnable company work launches even if a reset projects earlier completion');
  assert.equal(r.deferUntil,null); assert.ok(r.pick.command);
  assert.equal(r.kind,'launch');assert.ok(r.pick.command);
  const stale = {[SOL]:lane(500,0.5,{t:now-31*min}),[ASTRA]:lane(500,0.5,{t:now+min})};
  r = route({lanes:stale,resetMin:40});
  assert.equal(r.pick.model,SOL); assert.equal(r.deferred,null,'stale/future lanes cannot force a scheduled wait');
  // Fresh stuck telemetry is positive evidence, even at a queue position below 300.
  const stuck=lane(181,0,{state:'waiting',lastProgressAt:null});
  r=route({lanes:{[ASTRA]:stuck,[SOL]:lane(null,null,{state:'ready',lastProgressAt:now})}});
  assert.equal(r.pick.model,SOL,'a progressing lane beats a fresh zero-drain queue');
  const stalled=r.eta.find(x=>x.model===ASTRA&&x.account==='trae');
  assert.equal(stalled.confidence,'STALLED');assert.equal(stalled.startDelayMin,null);assert.equal(stalled.completionMin,null);
  assert.equal(stalled.unknown,false);assert.match(r.why.join(' '),/gpt-6-astra@trae stalled/);
  assert.doesNotMatch(r.why.join(' '),/gpt-6-astra@trae now/);
  r=route({ttAvailable:true,lanes:{[SOL]:stuck,[ASTRA]:stuck}});
  assert.equal(r.pick.account,'ttadk','ready company capacity beats every stalled lane');
  r=route({lanes:{[SOL]:stuck,[ASTRA]:stuck},resetMin:40});
  assert.equal(r.kind,'blocked');assert.equal(r.deferUntil,null,'ready personal proposal requires a decision before a company reset wait');
  r=route({lanes:{[ASTRA]:stuck},args:['debug','--failures','1','--actual',`codex:${ASTRA}:high@trae`]});
  assert.equal(r.kind,'defer');assert.equal(r.plan.reason.code,'ETA_STALLED');assert.equal(r.pick,null,'no downgrade or optimistic launch when the only floor-safe lane is stalled');
  r=route({lanes:{[ASTRA]:{...stuck,t:now-31*min}}});
  const expired=r.eta.find(x=>x.model===ASTRA&&x.account==='trae');
  assert.equal(expired.confidence,'UNKNOWN');assert.equal(expired.stalled,false,'stale stuck telemetry is unknown');
  r=route({daily:{[SOL]:bucket(),[ASTRA]:{...bucket(),resetsAt:now-1}},
    lanes:{[ASTRA]:lane(18,6),[SOL]:lane(null,null,{state:'ready',lastProgressAt:now})}});
  const moving=r.eta.find(x=>x.model===ASTRA&&x.account==='trae');
  assert.equal(moving.basis,'queue');assert.equal(moving.startDelayMin,3);assert.equal(moving.unknown,false,'fresh positive drain remains measured when quota metadata expires');
  for(const data of [{position:181,drainPerMin:0},{state:'waiting'}]) {
    const e=laneEta({workMin:90,requests:120,...data});
    assert.equal(e.basis,'stalled');assert.equal(e.unknown,false);assert.equal(e.completionMin,null);
  }
  assert.equal(laneEta({workMin:90,requests:120,bucketDepleted:true,unknown:true}).basis,'unknown');
  r = route({lanes:{[SOL]:lane(500,0.5),[ASTRA]:lane(null,null,{state:'ready',lastProgressAt:now})},args:['implement-hard','--shared-lock']});
  assert.equal(r.pick.model,SOL,'free TTADK Sol precedes Astra without fresh model load or unused units');
  assert.ok([...r.notes,...r.fixedNotes].some((s)=>/take the lease\/lock only after the first model response/.test(s)));
  // Same moderately queued lane: a small task beats the reset, a large one is scheduled for it.
  const slow = {[SOL]:lane(100,2),[ASTRA]:lane(100,2),'gpt-5.6-sol':lane(100,2),'gpt-5.6-terra':lane(100,2),'gpt-5.5':lane(100,2),'deepseek-v4.1-flash':lane(100,2)};
  r = route({lanes:slow,resetMin:600,args:['lookup']});
  assert.equal(r.pick.model,'gpt-5.6-terra'); assert.equal(r.deferred,null,'the qualified light ladder remains unchanged');
  r = route({lanes:slow,resetMin:600}); assert.equal(r.pick.account,'trae');assert.equal(r.deferUntil,null);
  r = route({args:['implement'], daily:{[SOL]:bucket(),[ASTRA]:bucket(),'gpt-5.6-sol':bucket(false)},
    lanes:{'gpt-5.6-sol':lane(500,0.5)}});
  assert.equal(r.pick.model,SOL,'free same-model TTADK keeps quality before queued TRAE alternatives');
  r = route({args:['implement','--failures','1','--actual',`codex:${SOL}:high@trae`]});
  assert.equal(r.deferred,null,'retry dispatches are not held for reset');
  assert.ok(r.eta.filter((x)=>x.account==='trae').every((x)=>[SOL,ASTRA].includes(x.model)&&x.requests===120&&x.workMin===90),
    'retry estimates and alternatives belong to the selected hard rung');
  for (const category of ['implement-hard','debug','science','design','review-high']) {
    r = route({args:category==='review-high'?[category,'--review-class','A','--review-reason','fixture independent reviewer set']:[category]}); assert.ok([SOL,ASTRA].includes(r.pick.model));
    if(category==='review-high') {assert.equal(r.blocked,false);assert.ok(r.secondOpinion || r.plan.gates.some(g=>g.kind==='independent-review'),'explicit class A retains the independent second or its acceptance gate');}
    else assert.ok(!r.needsUserOK.some((s)=>s.startsWith('personal quota:')),category);
  }
  assert.equal(laneEta({workMin:90,requests:120,bucketDepleted:true,position:100,drainPerMin:0.01}).startDelayMin,10000);
  assert.equal(patienceMinutes({now,ttadk:{usage:{resetsAt:now+2*min}}}),0.5);
  assert.equal(ttadkEta({now,workMin:90,account:{usable:false,reason:'SSO expired',usage:{used:100,limit:100,resetsAt:now+min}}}),null);
  const timed = (name,effort,minutes) => ({kind:'outcome',t:now,project:'eta',name,category:'implement-hard',result:'pass',rounds:0,minutes,
    first:{vendor:'codex',model:SOL,effort,account:'trae'}});
  const history = [timed('a','xhigh',7),timed('b','xhigh',9),timed('c','xhigh',11),timed('d','high',200),
    {kind:'outcome',t:now+1,project:'eta',name:'c',correction:true,minutes:13}];
  assert.equal(workMinutes('implement-hard','hard',history,'high'),90,'different efforts do not mix');
  r = route({history}); assert.equal(r.eta.find((x)=>x.model===SOL&&x.account==='trae').workMin,9);
  const review = JSON.parse(execFileSync(process.execPath,[path.join(scripts,'review-data.mjs'),'--json'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.deepEqual(review.routing.eta.constants.workMin,ETA.workMin);
  assert.deepEqual(review.routing.eta.constants.requests,ETA.requests);
  assert.deepEqual(review.routing.eta.byCategoryEffort['implement-hard:xhigh'],{samples:3,medianMinutes:9,usable:true});
  // Progress/drain are model-specific; a requeue or position increase clears incompatible old evidence.
  const telemetry = path.join(tmp,'telemetry'); fs.mkdirSync(telemetry);
  const record = createQueueRecorder(telemetry,SOL);
  record({state:'queued',position:100},now-2*min); record({state:'queued',position:90},now);
  assert.equal(readLaneState(telemetry,now)[SOL].drainPerMin,5);
  record({state:'ready',position:null,progress:true,itemsPerMin:2},now);
  assert.equal(readLaneState(telemetry,now)[SOL].itemsPerMin,2);
  record({state:'queued',position:100},now+min);
  assert.equal(readLaneState(telemetry,now+min)[SOL].lastProgressAt,null);
  assert.equal(readLaneState(telemetry,now+min)[SOL].drainPerMin,null);
  record({state:'queued',position:110},now+2*min);
  assert.equal(readLaneState(telemetry,now+2*min)[SOL].drainPerMin,null);
  record.stop(); record({state:'ready',progress:true},now+3*min);
  assert.equal(readLaneState(telemetry,now+3*min)[SOL].state,'queued','stopped recorders ignore late events');
  assert.deepEqual(readLaneState(telemetry,now+33*min),{});
  console.log('PASS ETA: routing, task size, efforts/corrections, reset scheduling, tie breaks, resources, dry JSON, telemetry lifecycle and review refresh');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
