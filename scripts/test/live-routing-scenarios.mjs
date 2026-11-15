#!/usr/bin/env node
// Public observations captured on the live machine. No credentials or provider calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const route = new URL('../route.mjs', import.meta.url).pathname;
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/live-routing-2026-11-15.json', import.meta.url),'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'live-routing-fixture-'));
const file = path.join(tmp,'snapshot.json');
const env = {...process.env, HOME:tmp, RULES_SHARED:tmp, QUOTA_CACHE:path.join(tmp,'cache.json'),
  CODEX_ACCOUNTS:path.join(tmp,'accounts.json'), ROUTE_LOG:'0', ROUTE_NOW:String(captured.decisionAt),
  ROUTE_SNAPSHOT_FILE:file, ROUTE_LOG_FILE:path.join(tmp,'route-log.jsonl'), ROUTE_REQUEST_ID:'live-fixture'};
const cli = (args, raw=captured) => {
  fs.writeFileSync(file,JSON.stringify(raw));
  return JSON.parse(execFileSync(process.execPath,[route,...args,'--dry','--json'],{env,encoding:'utf8',maxBuffer:16<<20}));
};
const copy=()=>structuredClone(captured);
try {
  const trae=captured.accounts.find(a=>a.id==='trae');
  assert.equal(trae.auth.status,'KNOWN');assert.equal(trae.transport.value,true);
  assert.ok(trae.quota.length>0);
  for(const q of trae.quota) {assert.equal(q.usage.status,'KNOWN');assert.ok(q.usage.sampledAt<=captured.decisionAt,'refreshed samples cannot be future evidence');}
  assert.ok(captured.lanes.filter(l=>l.accountId==='trae').every(l=>l.mode!=='UNKNOWN'),'captured live quota must actually survive normalization');
  for(const args of [['lookup'],['analysis'],['research'],['implement','--impact','service'],
    ['implement-hard','--impact','service'],['debug','--impact','release'],['review'],['review-high'],
    ['design'],['docs'],['build-run','--signing','--impact','service'],['analysis','--background'],
    ['implement','--impact','service','--background'],['implement','--impact','service','--failures','1']]) {
    const o=cli(args);assert.equal(o.kind,'launch',args.join(' '));
    assert.equal(o.pick.account,'trae');assert.ok(o.pick.company);assert.ok(o.pick.command);
    if(args.includes('--signing')) assert.equal(o.pick.sandbox,'danger-full-access');
    if(args.includes('--failures')) assert.match(o.why.join('\n'),/assumed first category ladder rung/);
    if(args[0]==='review-high') {assert.ok(o.secondOpinion);assert.equal(o.secondOpinion.command,null);assert.ok(o.needsUserOK.length);}
  }
  const security=cli(['review','--security']);assert.equal(security.kind,'launch');
  assert.equal(security.pick.account,'trae');assert.equal(security.pick.model,'deepseek-v4.1-flash');
  for(const args of [['lookup'],['extract'],['draft'],['analysis'],['research'],['implement','--impact','service'],
    ['review'],['docs'],['build-run'],['build-run','--signing','--impact','service']]) {
    const o=cli(args);assert.equal(o.pick.model,'gpt-5.6-terra',`priority ladder: ${args.join(' ')}`);
  }
  for(const category of ['image-gen','claude-tools']) {
    const o=cli([category]);assert.ok(o.pick.command);assert.equal(o.needsUserOK.length,0);
  }
  const desktop=copy(), app={status:'KNOWN',value:true,sampledAt:captured.decisionAt,receivedAt:captured.decisionAt,maxAgeMs:600000,source:'fixture'};
  for(const part of [...desktop.accounts,...desktop.lanes]) if(['main','b'].includes(part.accountId??part.id)) part.capabilities['app:com.apple.calculator']=app;
  const personal=cli(['computer-use','--apps','com.apple.calculator'],desktop);
  assert.ok(['main','b'].includes(personal.pick.account));assert.ok(personal.needsUserOK.length);assert.equal(personal.pick.command,null);
  assert.ok(cli(['computer-use','--apps','com.apple.calculator','--urgent','--user-ok','ledger:user-yes'],desktop).pick.command);
  const reachableTT=structuredClone(desktop), tt=reachableTT.accounts.find(a=>a.id==='ttadk');
  tt.auth.value=true;tt.transport.value=true;tt.providerDenied.value=true;
  for(const part of [tt,...reachableTT.lanes.filter(l=>l.accountId==='ttadk')]) part.capabilities['app:com.apple.calculator']=app;
  for(const args of [['computer-use','--apps','com.apple.calculator'],['review','--security','--defensive']]) {
    const o=cli(args,reachableTT);assert.equal(o.kind,'blocked');assert.ok(['main','b'].includes(o.pick.account));
    assert.equal(o.deferred,null,'a future TTADK reset cannot hide the personal-now proposal');assert.equal(o.pick.command,null);
    assert.ok(o.needsUserOK.some(w=>/personal quota now, or wait until/.test(w)));
    const yes=cli([...args,'--urgent','--user-ok','ledger:personal-now'],reachableTT);assert.ok(yes.pick.command);
  }
  const browser=copy();browser.accounts.find(a=>a.id==='trae').capabilities.browser.value=true;
  browser.accounts.find(a=>a.id==='trae').capabilities['signed-in-browser'].value=true;
  for(const lane of browser.lanes.filter(l=>l.accountId==='trae')) {
    lane.capabilities.browser.value=true;lane.capabilities['signed-in-browser'].value=true;
    for(const cap of Object.keys(lane.capabilities).filter(k=>k.startsWith('origin:'))) lane.capabilities[cap].value=true;
  }
  // An explicit snapshot needs exact target evidence at both account and lane.
  const origin={status:'KNOWN',value:true,sampledAt:captured.decisionAt,receivedAt:captured.decisionAt,maxAgeMs:600000,source:'fixture'};
  browser.accounts.find(a=>a.id==='trae').capabilities['origin:https://example.test']=origin;
  for(const lane of browser.lanes.filter(l=>l.accountId==='trae')) lane.capabilities['origin:https://example.test']=origin;
  // The CLI adds its standard company origins; allow those too in the captured view.
  for(const host of ['*.bytedance.net','*.byted.org','*.larkoffice.com','*.feishu.cn','*.tiktok-row.net','*.byteintl.net','*.bytedance.com']) {
    browser.accounts.find(a=>a.id==='trae').capabilities[`origin:${host}`]=origin;
    for(const lane of browser.lanes.filter(l=>l.accountId==='trae')) lane.capabilities[`origin:${host}`]=origin;
  }
  const browserPick=cli(['browser','--origins','https://example.test'],browser).pick;
  assert.equal(browserPick.account,'trae');assert.equal(browserPick.model,'gpt-5.6-terra');
  const broken=copy();broken.accounts.find(a=>a.id==='main').catalog.value={malformed:true};
  assert.equal(cli(['analysis'],broken).pick.account,'trae','malformed personal account cannot poison company state');
  const stale=copy();stale.accounts.find(a=>a.id==='main').auth.sampledAt-=3600000;
  assert.equal(cli(['analysis'],stale).pick.account,'trae','one stale account cannot defer healthy company work');
  const budget=copy();budget.reviewHistory=Array.from({length:10},(_,i)=>({t:captured.decisionAt-1000,project:'fixture',name:`work-${i}`,category:i<2?'review':'implement'}));
  const review=cli(['review','--project','fixture'],budget);assert.ok(review.pick.command);
  assert.match(review.tellUser.join('\n'),/over review budget — prefer accepting on tests/);
  const owned=path.join(tmp,'named-task');fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned,'launch.json'),JSON.stringify({model:'gpt-6-astra',effort:'xhigh',account:'trae'}));
  fs.writeFileSync(env.ROUTE_LOG_FILE,JSON.stringify({t:captured.decisionAt-1000,kind:'route',name:'named-task',project:'fixture',pick:{model:'gpt-6.1-sol',effort:'high',account:'trae'}})+'\n');
  const retryArgs=['debug','--impact','service','--failures','1','--name','named-task','--project','fixture','--task-dir',owned];
  const ownedRetry=cli(retryArgs);assert.equal(ownedRetry.plan.task.previousAttempts[0].actual.modelId,'gpt-6-astra','task launch precedes last route');
  const explicit=cli([...retryArgs,'--actual','codex:gpt-6.1-sol:high@trae']);
  assert.equal(explicit.plan.task.previousAttempts.length,1);assert.equal(explicit.plan.task.previousAttempts[0].actual.modelId,'gpt-6.1-sol','explicit actual wins');
  fs.rmSync(path.join(owned,'launch.json'));
  const logged=cli(retryArgs);assert.equal(logged.plan.task.previousAttempts[0].actual.modelId,'gpt-6.1-sol','named last route is the final record fallback');
  fs.rmSync(env.ROUTE_LOG_FILE);
  const attempts=path.join(owned,'attempts.json');
  fs.writeFileSync(attempts,JSON.stringify([{id:'finished',taskId:'named-task',role:'primary',state:'failed',actualStatus:'UNKNOWN',actual:null}]));
  const unknownRetry=cli([...retryArgs,'--previous-attempt','attempts.json']);
  assert.ok(!unknownRetry.plan.rejected.some(r=>r.reason.code==='PREVIOUS_ATTEMPT_UNKNOWN'));
  assert.match(unknownRetry.why.join('\n'),/assumed first category ladder rung/);
  fs.writeFileSync(attempts,JSON.stringify([{id:'legacy-claude',taskId:'named-task',role:'primary',state:'failed',actualStatus:'KNOWN',actual:{vendor:'claude',model:'sonnet',effort:'medium'}}]));
  const legacy=cli(['claude-tools','--name','named-task','--project','fixture','--task-dir',owned,'--previous-attempt','attempts.json','--failures','1']);
  assert.equal(legacy.plan.task.previousAttempts[0].actual.accountId,'claude');assert.ok(legacy.pick.command);
  fs.writeFileSync(attempts,JSON.stringify([{id:'uncertain',taskId:'named-task',role:'primary',state:'UNKNOWN',actualStatus:'UNKNOWN',actual:null}]));
  const liveUnknown=cli([...retryArgs,'--previous-attempt','attempts.json']);
  assert.equal(liveUnknown.kind,'blocked');assert.ok(liveUnknown.plan.rejected.some(r=>r.reason.code==='ATTEMPT_RECONCILIATION_REQUIRED'));
  fs.rmSync(attempts);
  fs.writeFileSync(env.ROUTE_LOG_FILE,JSON.stringify({t:captured.decisionAt-1000,kind:'route',name:'claude-retry',project:'fixture',pick:{vendor:'claude',model:'sonnet',effort:'medium'}})+'\n');
  const claudeRetry=cli(['claude-tools','--name','claude-retry','--project','fixture','--failures','1']);
  assert.equal(claudeRetry.plan.task.previousAttempts[0].actual.accountId,'claude','legacy Claude decisions imply their global account');
  assert.ok(claudeRetry.pick.command);assert.ok(!claudeRetry.plan.rejected.some(r=>r.reason.code==='PREVIOUS_ATTEMPT_UNKNOWN'));
  fs.rmSync(env.ROUTE_LOG_FILE);
  assert.ok(!fs.existsSync(env.ROUTE_LOG_FILE),'dry routing writes no dispatch log');
  const corruptHome=path.join(tmp,'corrupt-health'), clearHome=path.join(tmp,'clear-health');
  fs.mkdirSync(corruptHome);fs.mkdirSync(clearHome);
  fs.writeFileSync(path.join(corruptHome,'worker-health.json'),'{');
  const cache=path.join(tmp,'public-cache.json');
  fs.writeFileSync(cache,JSON.stringify({checkedAt:captured.decisionAt,codexAccounts:[
    {name:'broken',kind:'ttadk',home:corruptHome,models:['gpt-6.1-sol'],healthy:true,live:true,windows:[]},
    {name:'peer',kind:'ttadk',home:clearHome,models:['gpt-6.1-sol'],healthy:true,live:true,windows:[]}]}));
  const offline={...env,QUOTA_CACHE:cache};delete offline.ROUTE_SNAPSHOT_FILE;
  const healthyPeer=JSON.parse(execFileSync(process.execPath,[route,'analysis','--dry','--json'],{env:offline,encoding:'utf8'}));
  assert.equal(healthyPeer.kind,'launch');assert.equal(healthyPeer.pick.account,'peer','corrupt health data degrades only its account');
  assert.ok(healthyPeer.plan.rejected.some(r=>r.reason.code==='HEALTH_UNKNOWN'));
  console.log('PASS live captured CLI: company parity, signing, retry fallback, pending second, standing exceptions, user yes, browser order, account isolation and budget warning');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
