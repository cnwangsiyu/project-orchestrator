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
const pinnedScope=task('review',{'review-scope':'branch-work'});
assert.equal(reviewDecision(pinnedScope,state([review('renamed-one',{reviewScope:'branch-work'}),review('renamed-two',{reviewScope:'branch-work'})])).code,'REVIEW_ROUND_CAP','renaming reviews cannot bypass an explicit branch scope');
const overridden=task('review',{'review-override':'another reason'});
assert.equal(reviewDecision(overridden,state([review(),review('T1-R2')] )).code,'REVIEW_ROUND_CAP');
const classified=(category='review',cls='B',flags={})=>task(category,{'review-class':cls,'review-reason':'concrete approved class basis',...flags});
for(const cls of ['A','B','C','D']) {
  assert.throws(()=>task('review',{'review-class':cls}),/review-reason/);
  assert.equal(reviewDecision(classified('review',cls),state([review(),review('T1-R2')])).code,'REVIEW_ROUND_CAP');
  assert.equal(reviewAfterWrite(classified('implement',cls),state()),true);
}
assert.throws(()=>task('review',{'review-class':'E','review-reason':'invalid'}),/A, B, C or D/);
const rows=Array.from({length:10},(_,i)=>({name:`work-${i}`,project:'fixture',category:i<2?'review':'implement',t:now-1000}));
assert.match(reviewDecision(task(),state(rows)).text,/20.0%; project target 10%/);
for(const t of [task('review-high'),task('review',{impact:'release'}),task('review',{stakes:'high'}),task('review',{installed:true}),task('review',{'review-required':'acceptance risk'})])
  assert.equal(reviewDecision(t,state(rows)).code,'REVIEW_BUDGET_WARNING');
assert.equal(task('review-high').category,'review');assert.match(task('review-high').policyNotes.join(' '),/ordinary optional review/);
assert.equal(task('review',{impact:'release'}).impact,'service');
assert.equal(classified('review','A',{impact:'release'}).impact,'release');
assert.equal(reviewDecision(classified(),state(rows)),null,'mandatory share does not suppress dispatch');
assert.equal(reviewDecision(task(),state(rows.map(r=>({...r,t:now-day-1})))),null);
assert.equal(reviewDecision(task(),state(rows.map(r=>({...r,project:'peer'})))),null,'other projects do not set this target');
const vesdk=task();const vs={...vesdk,project:'vesdk-mainline'};
assert.equal(reviewDecision(vs,state(rows.map(r=>({...r,project:'vesdk-mainline'})))),null,'20% vesdk target');
const flash={modelId:'deepseek-v4.1-flash',family:'deepseek'};
for(const flags of [{},{impact:'release'},{stakes:'high'},{'runs-tests':true},{installed:true}]) assert.equal(reviewAfterWrite(task('implement',flags),state(),flash),false);
assert.equal(reviewAfterWrite(task('implement'),state([],[{category:'implement',modelId:flash.modelId,result:'rework',t:now-1000}]),flash),false);
for(const t of [task('review'),task('design'),task('review',{stakes:'high'}),task('review',{security:true})]) assert.equal(needsReviewer(t,state()),false);
for(const t of [classified('review','D'),classified('review-high','B'),classified('review','A',{impact:'release'})]) assert.equal(needsReviewer(t,state()),true);
const demo=state();demo.projectProfiles.fixture={profile:'internal-demo',externalRelease:false};
for(const cls of ['A','B','C','D'])assert.equal(reviewDecision(classified('review-high',cls),demo),null);
const releaseDemo=createTaskSpec({taskId:'T1',requestId:'request',project:'fixture',category:'docs',flags:{impact:'release'},projectProfiles:demo.projectProfiles});
assert.equal(releaseDemo.impact,'service');assert.match(releaseDemo.policyNotes.join(' '),/no external release/);
const noReview=state();noReview.projectProfiles={default:{profile:'standard',externalRelease:false},profiles:{'no-review':{optionalReview:false}},fixture:{profile:'no-review'}};
assert.equal(reviewDecision(task(),noReview).code,'PROJECT_NO_REVIEW');
assert.equal(reviewDecision(classified('review-high','B'),noReview),null);
const privateFeature=task('implement',{impact:'release'});
assert.equal(privateFeature.impact,'service');assert.equal(reviewAfterWrite(privateFeature,noReview),false);assert.equal(needsReviewer(privateFeature,noReview),false);
assert.equal(reviewDecision(task(),{...noReview,projectProfiles:{default:{profile:'no-review'}}}).code,'PROJECT_NO_REVIEW','new-project default can select no-review');
// A required adversarial pair is an executable two-family set, without GPT.
const models=['kimi-k3','deepseek-v4.1-flash'];
const raw={schemaVersion:'pipeline-v1',collectedFrom:now,collectedThrough:now,decisionAt:now,
  accounts:[{id:'ttadk',kind:'ttadk',catalog:models,auth:true,transport:true,health:true,providerDenied:false,quota:[],capabilities:{}}],
  models:models.map(id=>({id,efforts:['high'],capabilities:{}})),
  lanes:models.map(modelId=>({id:modelId,accountId:'ttadk',modelId,harness:'hub',efforts:['high'],mode:'standard',selectable:true,readyAt:now,capabilities:{}})),
  resources:{held:false,ownedReturned:true},health:[],reviewHistory:[],projectProfiles:{}};
const plan=routePure(classified('review','D',{security:true,'artifact-ref':'revision-1'}),createSnapshot(raw));
assert.equal(plan.kind,'launch');assert.equal(plan.primary.candidate.modelId,'kimi-k3');
assert.equal(plan.reviewers[0].candidate.modelId,'deepseek-v4.1-flash');
const rendered=renderPlan(plan,{snapshot:createSnapshot(raw),root:'/fixture',owner:'fixture-owner'});
const value=(args,key)=>args[args.indexOf(key)+1];
assert.notEqual(value(rendered.pick.workerArgs,'--name'),value(rendered.secondOpinion.workerArgs,'--name'));
for(const key of ['--log','--out']) assert.notEqual(value(rendered.pick.workerArgs,key),value(rendered.secondOpinion.workerArgs,key));
assert.ok(rendered.pick.workerArgs.includes('--route-args'));
assert.ok(!rendered.secondOpinion.workerArgs.includes('--route-args'),'secondary recovery must preserve the reviewer-set independence');
assert.match(rendered.secondOpinion.command,/independent second reviewer/);
console.log('PASS review policy: hard round cap, per-project budget, explicit classes, no inferred fallback triggers, independent set and internal-demo');

// Private/family app local-data work cannot accidentally create review gates or seats.
const publicQuality=JSON.parse(fs.readFileSync(new URL('./fixtures/quality-first-2026-11-15.json',import.meta.url),'utf8'));
publicQuality.projectProfiles={default:{profile:'standard',externalRelease:false},profiles:{'no-review':{optionalReview:false,reviewTargetPct:0,externalRelease:false}},fixture:{profile:'no-review'}};
const privatePlan=routePure(task('implement',{impact:'release'}),createSnapshot(publicQuality));
assert.equal(privatePlan.kind,'launch');assert.equal(privatePlan.task.impact,'service');assert.equal(privatePlan.followups.length,0);assert.equal(privatePlan.reviewers.length,0);
assert.ok(!privatePlan.gates.some(g=>['artifact-review','independent-review'].includes(g.kind)));
const privateView=renderPlan(privatePlan,{snapshot:createSnapshot(publicQuality),root:'/fixture'});
assert.equal(privateView.secondOpinion,null);assert.doesNotMatch(privateView.notes.join(' '),/review required/);
const noSeat=routePure(task(),createSnapshot(publicQuality));assert.equal(noSeat.kind,'blocked');assert.equal(noSeat.primaryProposal,undefined);assert.equal(noSeat.reviewers.length,0);
for(const cls of ['A','B','C'])for(const category of ['implement','docs','build-run']) {
  const p=routePure(classified(category,cls,{impact:cls==='A'?'release':'service'}),createSnapshot(publicQuality));
  assert.equal(p.kind,'launch');assert.equal(p.followups.length,1,`${category}/${cls}`);
  assert.equal(p.followups[0].category,cls==='A'?'review-high':'review');
  const g=p.gates.find(g=>g.kind==='artifact-review');assert.equal(g.phase,cls==='B'?'acceptance':'preaction');
  const view=renderPlan(p,{snapshot:createSnapshot(publicQuality),root:'/fixture'});
  assert.match(view.notes.join(' '),new RegExp(`--review-class ${cls} --review-reason`));
}
const configuredProfiles=JSON.parse(fs.readFileSync(new URL('../../references/project-risk-profiles.json',import.meta.url),'utf8'));
assert.equal(configuredProfiles.default.profile,'standard');
for(const project of ['evelyns-world','acq','autotrader']) {
  publicQuality.projectProfiles=configuredProfiles;
  assert.equal(configuredProfiles[project].profile,'no-review');
  for(const category of ['analysis','implement','docs','build-run','lookup','image-read']) {
    const t=createTaskSpec({taskId:'private-feature',requestId:'private-route',project,category,flags:{name:'private-feature',impact:'release'}});
    const p=routePure(t,createSnapshot(publicQuality)),view=renderPlan(p,{snapshot:createSnapshot(publicQuality),root:'/fixture'});
    assert.equal(p.kind,'launch');assert.equal(p.followups.length,0);assert.equal(view.secondOpinion,null);
    assert.match(view.notes.join(' '),/no review \(project profile no-review\): accept on tests\/build/);assert.doesNotMatch(view.notes.join(' '),/review required/);
  }
  for(const category of ['review','review-high']) {
    const t=createTaskSpec({taskId:'requested-review',requestId:'requested-route',project,category,flags:{}});
    const p=routePure(t,createSnapshot(publicQuality));assert.equal(p.kind,'blocked');assert.equal(p.reviewers.length,0);assert.equal(p.primaryProposal,undefined);
    const asked=createTaskSpec({...t,category,flags:{'review-class':'B','review-reason':'user asked permission review by name'}});
    assert.equal(routePure(asked,createSnapshot(publicQuality)).kind,'launch');
  }
}
console.log('PASS strict class-A release, no-review/default profiles, private local-data feature and cross-category artifact gates');

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
