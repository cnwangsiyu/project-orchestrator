#!/usr/bin/env node
// Approved review policy, using only synthetic dispatch and outcome metadata.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRoute } from '../lib/route-data.mjs';
import { createTaskSpec, createSnapshot, routePure, renderPlan } from '../lib/pipeline/index.mjs';
import { reviewAfterWrite, reviewDecision } from '../lib/pipeline/review-policy.mjs';
import { needsReviewer } from '../lib/pipeline/filters.mjs';
const now=1800000000000, day=86400000;
const task=(category='review',flags={})=>createTaskSpec({taskId:'T1',requestId:'request',project:'fixture',category,
  flags:{name:'T1',...(category==='implement'?{impact:'service'}:{}),...flags}});
const state=(reviewHistory=[],outcomes=[])=>({decisionAt:now,reviewHistory,outcomes,projectProfiles:{}});
const review=(name='T1-R',extra={})=>({name,category:'review',project:'fixture',t:now-1000,...extra});
assert.equal(reviewDecision(task(),state()),null);
assert.equal(reviewDecision(task(),state([review(),review('T1-R2')])).code,'REVIEW_ROUND_CAP');
const overridden=task('review',{'review-override':'new branch risk explained'});
assert.equal(reviewDecision(overridden,state([review(),review('T1-R2')] )).code,'REVIEW_BUDGET_WARNING');
const requiredOverride=task('review',{'review-override':'new branch risk explained','review-required':'release obligation'});
assert.equal(reviewDecision(requiredOverride,state([review(),review('T1-R2')])),null);
assert.equal(reviewDecision(requiredOverride,state([review(),review('T1-R2'),review('T1-R3',{reviewOverride:'new branch risk explained'})])).code,'REVIEW_ROUND_CAP');
const rows=Array.from({length:10},(_,i)=>({name:`work-${i}`,project:'fixture',category:i<2?'review':'implement',t:now-1000}));
assert.match(reviewDecision(task(),state(rows)).text,/over review budget — prefer accepting on tests \(20.0%\)/);
for(const t of [task('review-high'),task('review',{impact:'release'}),task('review',{stakes:'high'}),task('review',{installed:true}),task('review',{'review-required':'acceptance risk'})])
  assert.equal(reviewDecision(t,state(rows)),null);
assert.equal(reviewDecision(task(),state(rows.map(r=>({...r,t:now-day-1})))),null);
assert.equal(reviewDecision(task(),state(rows.map(r=>({...r,project:'peer'})))).code,'REVIEW_BUDGET_WARNING','global share also applies');
const flash={modelId:'deepseek-v4.1-flash',family:'deepseek'},gpt={modelId:'gpt-6.1-sol',family:'gpt'};
assert.equal(reviewAfterWrite(task('implement'),state(),flash),false);
for(const flags of [{impact:'release'},{stakes:'high'},{'runs-tests':true}]) assert.equal(reviewAfterWrite(task('implement',flags),state(),flash),true);
const past={category:'implement',modelId:flash.modelId,result:'rework',t:now-6*day};
assert.equal(reviewAfterWrite(task('implement'),state([],[past]),flash),true);
assert.equal(reviewAfterWrite(task('implement'),state([],[{...past,t:now-8*day}]),flash),false);
assert.equal(reviewAfterWrite(task('implement'),state([],[past]),gpt),false);
assert.equal(needsReviewer(task('review'),state()),false);
assert.equal(needsReviewer(task('design'),state()),false);
assert.equal(needsReviewer(task('review',{stakes:'high'}),state()),false);
for(const flags of [{security:true},{impact:'release'}]) assert.equal(needsReviewer(task('review',flags),state()),true);
const demo=state(); demo.projectProfiles.fixture={profile:'internal-demo',landingGate:'package tests + typecheck + SG prepare'};
for(const t of [task('review-high'),task('review',{security:true}),task('analysis',{adversarial:true})]) assert.equal(reviewDecision(t,demo).code,'PROJECT_PROFILE_ACCEPTANCE');
assert.equal(needsReviewer(task('review',{stakes:'high'}),demo),false);
assert.equal(reviewDecision(task('review-high',{'profile-override':'user explicitly requested review'}),demo),null);
// A required adversarial pair is an executable two-family set, without GPT.
const models=['kimi-k3','deepseek-v4.1-flash'];
const raw={schemaVersion:'pipeline-v1',collectedFrom:now,collectedThrough:now,decisionAt:now,
  accounts:[{id:'ttadk',kind:'ttadk',catalog:models,auth:true,transport:true,health:true,providerDenied:false,quota:[],capabilities:{}}],
  models:models.map(id=>({id,efforts:['high'],capabilities:{}})),
  lanes:models.map(modelId=>({id:modelId,accountId:'ttadk',modelId,harness:'hub',efforts:['high'],mode:'standard',selectable:true,readyAt:now,capabilities:{}})),
  resources:{held:false,ownedReturned:true},health:[],reviewHistory:[],projectProfiles:{}};
const plan=routePure(task('review',{security:true,'artifact-ref':'revision-1'}),createSnapshot(raw));
assert.equal(plan.kind,'launch');assert.equal(plan.primary.candidate.modelId,'kimi-k3');
assert.equal(plan.reviewers[0].candidate.modelId,'deepseek-v4.1-flash');
const rendered=renderPlan(plan,{snapshot:createSnapshot(raw),root:'/fixture',owner:'fixture-owner'});
const value=(args,key)=>args[args.indexOf(key)+1];
assert.notEqual(value(rendered.pick.workerArgs,'--name'),value(rendered.secondOpinion.workerArgs,'--name'));
for(const key of ['--log','--out']) assert.notEqual(value(rendered.pick.workerArgs,key),value(rendered.secondOpinion.workerArgs,key));
assert.ok(rendered.pick.workerArgs.includes('--route-args'));
assert.ok(!rendered.secondOpinion.workerArgs.includes('--route-args'),'secondary recovery must preserve the reviewer-set independence');
assert.match(rendered.secondOpinion.command,/independent second reviewer/);
console.log('PASS review policy: round cap/override, optional budget, mandatory exceptions, fallback triggers, independent set and internal-demo');

// An executed company primary counts even while its personal second is gated.
// A proposed second must not inflate the dispatch budget or review-round count.
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'review-accounting-'));
try {
  const routeLog=path.join(tmp,'routes.jsonl');
  const rows=['T1-R','T1-R2'].map(name=>({t:now-1000,kind:'route',project:'fixture',name,category:'review-high',
    pick:{account:'trae',model:'gpt-6.1-sol',effort:'xhigh'},executable:true,needsOK:['personal second reviewer'],
    second:{model:'opus',effort:'xhigh'},secondExecutable:false}));
  fs.writeFileSync(routeLog,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const c=acquireRoute(task(),{root:new URL('../../',import.meta.url).pathname,env:{ROUTE_NOW:String(now),RULES_SHARED:tmp,
    CODEX_ACCOUNTS:path.join(tmp,'registry.json'),QUOTA_CACHE:path.join(tmp,'cache.json'),ROUTE_LOG_FILE:routeLog}});
  assert.equal(c.snapshot.reviewHistory.length,2,'primary dispatches count; pending seconds do not');
  assert.equal(reviewDecision(task(),c.snapshot).code,'REVIEW_ROUND_CAP');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
