#!/usr/bin/env node
// BC-29/30/31: public synthetic metadata, no provider/session/credential access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
// Legacy expectations predate the standing personal-fallback policy; personal-fallback-scenarios covers it.
if (!process.env.PERSONAL_FALLBACK_FILE) { const f = (await import('node:path')).join((await import('node:os')).tmpdir(), `pf-off-${process.pid}.json`); (await import('node:fs')).writeFileSync(f, '{"enabled":false}'); process.env.PERSONAL_FALLBACK_FILE = f; }
const route=new URL('../route.mjs',import.meta.url).pathname;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'route-fix2-'));
const now=1800000000000,h=3600000,SOL='gpt-6.1-sol',ASTRA='gpt-6-astra';
const env={...process.env,HOME:tmp,RULES_SHARED:tmp,ROUTE_NOW:String(now),ROUTE_REQUEST_ID:'fix2',
  CODEX_ACCOUNTS:path.join(tmp,'accounts.json'),QUOTA_CACHE:path.join(tmp,'quota.json'),
  ROUTE_RR:path.join(tmp,'rotation'),ROUTE_LOG_FILE:path.join(tmp,'route.jsonl'),QUOTA_LOG_FILE:path.join(tmp,'quota-log.jsonl')};
delete env.ROUTE_SNAPSHOT_FILE;
const window=(used,left)=>({used,resetsAt:now+left*h,windowMins:10080});
const account=(name,left)=>({name,kind:'chatgpt',home:path.join(tmp,name),live:true,healthy:true,browser:true,desktop:true,windows:[window(20,left)]});
const base={checkedAt:now,codexAccounts:[account('main',24),account('alt',36)],claude:[window(10,120)]};
const copy=()=>structuredClone(base);
const cli=(args,raw=base,dry=true)=>{
  if(['implement','implement-hard','debug','science'].includes(args[0])&&!args.includes('--impact')) args=[...args,'--impact','service'];
  fs.writeFileSync(env.QUOTA_CACHE,JSON.stringify(raw));
  fs.writeFileSync(env.CODEX_ACCOUNTS,JSON.stringify(Object.fromEntries(raw.codexAccounts.map(a=>[a.name,{kind:a.kind,home:a.home,browser:a.browser,desktop:a.desktop}]))));
  return JSON.parse(execFileSync(process.execPath,[route,...args,...(dry?['--dry']:[]),'--json'],{env,encoding:'utf8',maxBuffer:16<<20}));
};
const checkFit=o=>{
  for(const seat of [o.plan.primary,o.plan.primaryProposal,...o.plan.reviewers].filter(Boolean)) {
    const row=o.plan.trace.candidates.find(r=>r.candidate.id===seat.candidate.id);
    if(row) assert.ok(row.predicates.find(p=>p.ruleId==='pTierFloor').ok,`${seat.candidate.modelId} must fit its category`);
  }
};
try {
  for(const category of ['implement','implement-hard','review-high','research','analysis','draft','build-run','browser','image-gen','claude-tools']) {
    const o=cli([category,'--impact','service']);
    assert.equal(o.kind,'launch',`${category}: ${o.why}`);assert.ok(o.pick.command,category);
    assert.equal(o.needsUserOK.length,0,category);checkFit(o);
    assert.ok(!o.plan.gates.some(g=>g.kind==='personal-quota'),category);
    assert.doesNotMatch(o.why.join('\n'),/company ETA|wait until company lane progress/);
    if(o.pick.vendor==='codex') assert.match(o.why.join('\n'),new RegExp(`no company account on this device: personal ChatGPT account ${o.pick.account} is the default lane`));
    if(category==='browser') assert.ok(base.codexAccounts.find(a=>a.name===o.pick.account).browser);
    if(category==='draft') assert.equal(o.pick.model,'gpt-6.1-terra');
    if(category==='review-high') {assert.equal(o.category,'review');assert.equal(o.secondOpinion,null,'unclassified review is ordinary');}
    console.log(`PASS no-company ${category}: ${o.pick.model} ${o.pick.effort} @${o.pick.account??'claude'}`);
  }
  fs.writeFileSync(env.ROUTE_RR,'0');
  const first=cli(['implement'],base,false),second=cli(['implement'],base,false),third=cli(['implement']);
  assert.notEqual(first.pick.account,second.pick.account);assert.equal(first.pick.account,third.pick.account);
  assert.equal(fs.readFileSync(env.ROUTE_RR,'utf8'),'2','dry observation never advances rotation');
  const long=copy();long.codexAccounts[0].windows=[window(20,120)];long.codexAccounts[1].windows=[window(20,80)];
  assert.equal(cli(['implement'],long).pick.account,'alt','outside rotation pool, earliest deadline wins');
  const unready=copy();unready.codexAccounts[1].browser=false;
  assert.equal(cli(['browser'],unready).pick.account,'main','rotation cannot select a browser-unready account');
  unready.codexAccounts[0].browser=false;
  const fallback=cli(['browser'],unready);assert.equal(fallback.pick.vendor,'claude');assert.equal(fallback.pick.command,null);assert.ok(fallback.needsUserOK.some(w=>/personal quota/.test(w)));assert.ok(fallback.needsUserOK.length>0);
  const broken=copy();broken.codexAccounts[1].live=false;
  assert.equal(cli(['implement'],broken).pick.account,'main','an unhealthy peer is skipped');
  for(const a of broken.codexAccounts) {a.live=false;a.browser=false;}
  const blocked=cli(['computer-use','--apps','com.example.calc'],broken);
  assert.equal(blocked.kind,'blocked');assert.equal(blocked.pick,null);assert.equal(blocked.plan.reasons.length,1);
  assert.match(blocked.why[0],/on (main|alt):/);assert.doesNotMatch(blocked.why.join('\n'),/CATEGORY_MODEL_FIT|ASTRA_SUBSTITUTION_HARD_ONLY|company lane progress/);
  const spent=copy();spent.codexAccounts.forEach(a=>a.windows=[window(100,24)]);
  const denied=cli(['image-gen'],spent);assert.equal(denied.kind,'blocked');assert.equal(denied.plan.reasons.length,1);
  assert.match(denied.why[0],/Provider explicitly denied quota capacity/);assert.equal(denied.needsUserOK.length,0);
  const cards=structuredClone(spent);cards.codexAccounts[0].resets={credits:[{id:'card-1',expiresAt:now+h}]};
  const codexReset=cli(['implement'],cards);assert.equal(codexReset.kind,'blocked');assert.ok(codexReset.redeemFirst);
  assert.ok(codexReset.plan.gates.some(g=>g.kind==='reset-redemption'));assert.equal(codexReset.pick.command,null);
  assert.equal(cli(['implement','--no-redeem'],cards).pick.vendor,'claude');
  const redeem=cli(['image-gen'],cards);assert.equal(redeem.kind,'blocked');assert.equal(redeem.pick.command,null);
  assert.ok(redeem.plan.gates.some(g=>g.kind==='reset-redemption'));assert.ok(!redeem.plan.gates.some(g=>g.kind==='personal-quota'));
  const noRedeem=cli(['image-gen','--no-redeem'],cards);assert.ok(!noRedeem.plan.gates.some(g=>g.kind==='reset-redemption'));
  const max=cli(['implement','--actual',`codex:${SOL}:max@main`]);assert.equal(max.kind,'blocked');assert.equal(max.pick.command,null);
  assert.ok(max.plan.gates.some(g=>g.kind==='max-effort'));assert.ok(!max.plan.gates.some(g=>g.kind==='personal-quota'));
  console.log('PASS account rotation/deadlines, browser fallback, unhealthy/exhausted accounts, reset and max gates');

  const astraArgs=['implement-hard','--impact','throwaway','--writes','--failures','1',
    '--actual',`codex:${SOL}:xhigh@alt`,'--project','acq','--name','probe2'];
  const astra=cli(astraArgs);assert.equal(astra.kind,'blocked');assert.equal(astra.pick.model,ASTRA);
  assert.equal(astra.pick.command,null);assert.deepEqual(astra.needsUserOK,[`use GPT-6-Astra on personal account ${astra.pick.account}?`]);
  assert.ok(astra.plan.gates.some(g=>g.kind==='astra'));assert.ok(!astra.plan.gates.some(g=>g.kind==='max-effort'));
  const request=cli([...astraArgs,'--urgent']);
  const approval=path.join(tmp,'astra-approvals.json');env.ROUTE_APPROVAL_FILE=approval;
  const astraScope=request.plan.gates.find(g=>g.kind==='astra').scope;
  const approve=scope=>fs.writeFileSync(approval,JSON.stringify([{id:'astra-yes',userDecisionRef:'synthetic-astra-yes',
    grantedAt:now-1000,expiresAt:now+60000,revoked:false,scopes:[scope]}]));
  approve({...astraScope,action:'personal-quota'});
  assert.equal(cli([...astraArgs,'--urgent','--user-ok','astra-yes']).pick.command,null,'personal quota approval cannot authorize Astra');
  approve(astraScope);
  const yes=cli([...astraArgs,'--urgent','--user-ok','astra-yes']);assert.equal(yes.kind,'launch');assert.equal(yes.pick.model,ASTRA);
  assert.ok(yes.pick.command);assert.equal(yes.needsUserOK.length,0);
  delete env.ROUTE_APPROVAL_FILE;
  const companyOut=copy();companyOut.codexAccounts.push({name:'ttadk',kind:'ttadk',home:path.join(tmp,'ttadk'),live:true,healthy:false,
    models:[SOL],reason:'daily token quota used up',usage:{used:100,limit:100,resetsAt:now+h}});
  const onCompanyDevice=cli([...astraArgs,'--urgent','--user-ok','personal-yes'],companyOut);
  assert.equal(onCompanyDevice.kind,'blocked');assert.equal(onCompanyDevice.pick.model,ASTRA);assert.equal(onCompanyDevice.pick.command,null);
  assert.ok(onCompanyDevice.needsUserOK.includes(`use GPT-6-Astra on personal account ${onCompanyDevice.pick.account}?`));assert.ok(onCompanyDevice.plan.gates.some(g=>g.kind==='personal-quota'));assert.ok(onCompanyDevice.plan.gates.some(g=>g.kind==='astra'));
  const solArgs=['implement-hard','--impact','throwaway','--writes','--failures','1','--actual',`codex:${SOL}:high@alt`];
  const sol=cli(solArgs);assert.equal(sol.kind,'launch');assert.equal(sol.pick.model,SOL);assert.equal(sol.pick.effort,'xhigh');
  assert.ok(sol.pick.command);assert.equal(sol.needsUserOK.length,0);assert.match(sol.why.join('\n'),/Astra .*gated alternative/);
  const mini=copy();mini.codexAccounts=[{name:'trae',kind:'trae',home:path.join(tmp,'trae'),live:true,healthy:true,models:[SOL,ASTRA],windows:[],
    load:{[SOL]:{percent:25,t:now}}, // Retained Sol/max wins when Sol's lane is actually observed free.
    quota:{sampledAt:now,daily:Object.fromEntries([SOL,ASTRA].map(model=>[model,{used:20,limit:100,remaining:80,depleted:false,resetsAt:now+h}]))}}];
  const companyAstra=cli(['implement-hard','--impact','throwaway','--writes','--failures','1','--actual',`codex:${SOL}:xhigh@trae`],mini);
  assert.equal(companyAstra.kind,'launch');assert.equal(companyAstra.pick.model,SOL);assert.equal(companyAstra.pick.effort,'max');assert.equal(companyAstra.pick.account,'trae');
  assert.ok(companyAstra.pick.command);assert.equal(companyAstra.needsUserOK.length,0);
  const accountless=cli(['implement-hard','--impact','throwaway','--writes','--failures','1','--actual',`codex:${SOL}:xhigh`]);
  assert.equal(accountless.kind,'blocked');assert.equal(accountless.pick.model,ASTRA);
  assert.equal(accountless.plan.task.previousAttempts[0].actual.accountId,null);
  assert.equal(accountless.plan.task.previousAttempts[0].actual.accountStatus,'UNKNOWN');
  assert.ok(!accountless.plan.rejected.some(p=>p.reason.code==='PREVIOUS_ATTEMPT_UNKNOWN'));
  assert.match(accountless.why.join('\n'),/actual account is unknown/);
  const noAccountSol=cli(['implement-hard','--failures','1','--actual',`codex:${SOL}:high`]);
  assert.equal(noAccountSol.kind,'launch');assert.equal(noAccountSol.pick.model,SOL);assert.equal(noAccountSol.pick.effort,'xhigh');
  const mixed=cli(['implement-hard','--failures','1','--actual',`codex:${SOL}:high,codex:${SOL}:high@alt`]);
  assert.equal(mixed.plan.task.previousAttempts.length,2);assert.equal(mixed.plan.task.previousAttempts[0].actual.accountId,null);
  assert.equal(mixed.plan.task.previousAttempts[1].actual.accountId,'alt');
  for(const actual of [`codex:${SOL}:high@`,`codex:${SOL}:high@@alt`,`codex:${SOL}:ultra`])
    assert.throws(()=>cli(['implement-hard','--actual',actual]),e=>e.status===2);
  console.log('PASS BC-31 personal Astra scoped OK on both device types, ready Sol preferred with gated alternative, TRAE Astra ungated, account-less/mixed actual floors');

  const nameArgs=['--project','route-regression','--name','BC-29','--review-class','B','--review-reason','user asked permission review'];
  const decision=cli(['analysis',...nameArgs],base,false);assert.equal(decision.kind,'launch');
  const review=cli(['review-high','--impact','service','--runs-tests',...nameArgs]);
  assert.equal(review.kind,'launch');assert.equal(review.failures,0);assert.equal(review.plan.task.previousAttempts.length,0);
  const scope={t:now-1000,name:'BC-29',project:'route-regression',category:'review-high',role:'primary'};
  const launched={...scope,kind:'attempt',id:'accepted-astra',state:'failed',actualStatus:'KNOWN',
    actual:{accountId:'main',modelId:ASTRA,effort:'xhigh'}};
  const log=rows=>fs.writeFileSync(env.ROUTE_LOG_FILE,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  log([launched]);
  assert.equal(cli(['review-high',...nameArgs,'--failures','0']).plan.task.previousAttempts.length,0,'no retry ignores even real same-task launches');
  const real=cli(['review-high',...nameArgs,'--failures','1']);assert.equal(real.plan.task.previousAttempts[0].actual.modelId,ASTRA);
  assert.ok(!real.pick||real.pick.model!==SOL,'actual Astra floor cannot demote');
  for(const row of [{...launched,category:'analysis'},{...launched,project:'another'},{...launched,name:'another'},
    {...launched,state:'planned'},{...launched,dry:true},{...launched,launched:false},
    {...launched,state:undefined},{...launched,accepted:false},
    {...scope,kind:'route',pick:{model:ASTRA,effort:'xhigh',account:'main'}},
    {...scope,kind:'launch',model:ASTRA,effort:'xhigh',account:'main'},
    {...scope,kind:'outcome',result:'fail',actual:[{model:ASTRA,effort:'xhigh',account:'main'}]}]) {
    log([row]);const o=cli(['review-high',...nameArgs,'--failures','1']);
    assert.equal(o.plan.task.previousAttempts[0].id,'assumed-first-rung');assert.match(o.why.join('\n'),/assumed first category ladder rung/);
  }
  const explicit=cli(['review-high',...nameArgs,'--actual',`codex:${ASTRA}:xhigh@main`]);
  assert.equal(explicit.plan.task.previousAttempts[0].actual.modelId,ASTRA,'explicit actual applies even without failures');
  const owned=path.join(tmp,'task');fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned,'launch.json'),JSON.stringify({...launched,category:'analysis'}));
  assert.equal(cli(['review-high',...nameArgs,'--task-dir',owned,'--failures','1']).plan.task.previousAttempts[0].id,'assumed-first-rung');
  fs.writeFileSync(path.join(owned,'launch.json'),JSON.stringify(launched));
  assert.equal(cli(['review-high',...nameArgs,'--task-dir',owned,'--failures','1']).plan.task.previousAttempts[0].actual.modelId,ASTRA);
  log([{...launched,kind:'launch-model',id:undefined,thread:'thread-1',turn:'turn-1',account:'main',accepted:true,state:'running'},
    {...launched,kind:'launch-model',id:undefined,thread:'thread-1',turn:'turn-1',account:'main',accepted:true,state:'completed',t:now-500}]);
  const observed=cli(['review-high',...nameArgs,'--failures','1']);assert.equal(observed.plan.task.previousAttempts.length,1);
  assert.equal(observed.plan.task.previousAttempts[0].state,'completed','terminal evidence replaces the running observation');
  console.log('PASS BC-29 sequence, retry-only admission, exact launch scope, planned/dry/unlaunched rejection and explicit actual precedence');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
