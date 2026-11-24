#!/usr/bin/env node
// Public observations captured on the live machine. No credentials or provider calls.
import fs from 'node:fs';
import { parseRouteJSON } from './helpers/route-fixture.mjs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const route = new URL('../route.mjs', import.meta.url).pathname;
const captured = parseRouteJSON(fs.readFileSync(new URL('./fixtures/live-routing-2026-11-15.json', import.meta.url),'utf8'));
const freeTrae = parseRouteJSON(fs.readFileSync(new URL('./fixtures/free-trae-fresh-ttadk-2026-11-15.json', import.meta.url),'utf8'));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'live-routing-fixture-')));
const file = path.join(tmp,'snapshot.json');
const env = {...process.env, HOME:tmp, RULES_SHARED:tmp, QUOTA_CACHE:path.join(tmp,'cache.json'),
  CODEX_ACCOUNTS:path.join(tmp,'accounts.json'), ROUTE_LOG:'0', ROUTE_NOW:String(captured.decisionAt),
  ROUTE_SNAPSHOT_FILE:file, ROUTE_LOG_FILE:path.join(tmp,'route-log.jsonl'), ROUTE_REQUEST_ID:'live-fixture'};
const cli = (args, raw=startable, approve=false) => {
  if (['browser', 'ui-browser'].includes(args[0]) && !args.includes('--origins') && !args.includes('--browser-origins'))
    args = [...args, '--browser-origins', '*.bytedance.net'];
  if(approve) {const clean=args.slice(),at=clean.indexOf('--user-ok');if(at>=0)clean.splice(at,2);const offered=cli(clean,raw),yes=structuredClone(raw);yes.approvals=[{id:'fixture-approval',userDecisionRef:'synthetic-user-yes',revoked:false,grantedAt:captured.decisionAt-1000,expiresAt:captured.decisionAt+60000,scopes:offered.plan.gates.filter(g=>g.scope).map(g=>({...g.scope,allowPersonalWithCompany:true}))}];return cli([...clean,'--user-ok','fixture-approval'],yes);}
  const input = structuredClone(raw);
  for (const lane of input.lanes) {
    if (lane.mode === 'low-priority' && lane.position.source === 'owner-reproduction-2026-11-15')
      lane.lowQueue = {position:lane.position.value,drainPerMin:lane.drainPerMin.value};
  }
  fs.writeFileSync(file, JSON.stringify(input));
  return parseRouteJSON(execFileSync(process.execPath,[route,...args,'--dry','--json'],{env,encoding:'utf8',maxBuffer:16<<20}));
};
// The CLI controls below exercise independent capabilities and gates on a startable lane.
const startable = structuredClone(captured);
for (const lane of startable.lanes.filter(l=>l.accountId==='trae' && l.mode==='low-priority')) lane.lowStart=0;
const copy=()=>structuredClone(startable);
try {
  const original = cli(['implement-hard','--impact','service'],captured);
  assert.notEqual(original.pick?.account,'trae','raw captured progress alone cannot qualify the exhausted hard lane');
  const quality=parseRouteJSON(fs.readFileSync(new URL('./fixtures/quality-first-2026-11-15.json',import.meta.url),'utf8'));
  for(const args of [['analysis'],['research'],['implement','--impact','service'],['docs'],['review']]) {
    const o=cli(args,quality);assert.equal(o.pick.model,'gpt-6.1-sol');assert.equal(o.pick.account,'trae',args.join(' '));
  }
  const hotSol=structuredClone(quality);hotSol.lanes.find(l=>l.accountId==='trae'&&l.modelId==='gpt-6.1-sol').loadPercent.value=70;
  assert.equal(cli(['analysis'],hotSol).pick.account,'ttadk');assert.equal(cli(['analysis'],hotSol).pick.model,'gpt-6.1-sol');
  for(const args of [['lookup'],['build-run','--env','test','--no-local-build'],['analysis','--background']]) {
    const o=cli(args,quality);assert.equal(o.pick.model,'gpt-5.6-terra');assert.equal(o.pick.account,'ttadk');
  }
  const noTerra=structuredClone(quality);noTerra.accounts.find(a=>a.id==='ttadk').catalog.value=noTerra.accounts.find(a=>a.id==='ttadk').catalog.value.filter(m=>m!=='gpt-5.6-terra');
  noTerra.lanes=noTerra.lanes.filter(l=>l.accountId!=='ttadk'||l.modelId!=='gpt-5.6-terra');
  assert.equal(cli(['lookup'],noTerra).pick.model,'gpt-5.5');
  const ownExpiry=structuredClone(quality);ownExpiry.accounts=ownExpiry.accounts.filter(a=>a.kind!=='ttadk');ownExpiry.lanes=ownExpiry.lanes.filter(l=>l.accountId!=='ttadk');
  const qTrae=ownExpiry.accounts.find(a=>a.kind==='trae');qTrae.quota.push({bucketId:'gpt-5.6-terra',unit:'model-bucket',usage:{status:'KNOWN',value:{used:2,limit:80,resetsAt:quality.decisionAt+600000},sampledAt:quality.decisionAt,receivedAt:quality.decisionAt,maxAgeMs:1800000,source:'fixture'},priority:{status:'KNOWN',value:'available',sampledAt:quality.decisionAt,receivedAt:quality.decisionAt,maxAgeMs:1800000,source:'fixture'}});
  const terraLane=ownExpiry.lanes.find(l=>l.modelId==='gpt-5.6-terra');terraLane.loadPercent.value=25;terraLane.mode='priority';terraLane.modeEvidence.value='priority';terraLane.bucketIds=['gpt-5.6-terra'];
  const exp=cli(['analysis','--background'],ownExpiry);assert.equal(exp.pick.model,'gpt-5.6-terra');assert.equal(exp.plan.primary.estimate.expiryOpportunity,true);assert.equal(exp.plan.primary.estimate.expiryEvidence.unit,'model-bucket');assert.match(exp.why.join(' '),/priority bucket expiring unused/);
  console.log('PASS day3 quality ladder precedes bucket priority on both company accounts and background work');
  for(const args of [['analysis'],['research'],['implement','--impact','service'],['docs'],['image-read'],['browser'],['ui-browser','--impact','service']]) {
    const o=cli(args,freeTrae);assert.equal(o.kind,'launch');assert.equal(o.pick.account,'trae',args.join(' '));
    assert.match(o.why.join('\n'),/TRAE lane free/);
    if(['browser','ui-browser'].includes(args[0])) {assert.equal(o.pick.model,'gpt-6.1-sol');assert.match(o.why.join('\n'),/gpt-6.1-sol load 42%/);assert.doesNotMatch(o.why.join('\n'),/load 70%/);}
    for(const variant of ['hot','queued','stalled']) {
      const x=structuredClone(freeTrae);
      for(const l of x.lanes.filter(l=>l.accountId==='trae')) {

        if(variant==='hot') l.loadPercent.value=70;
        else {l.position.value=181;l.queueState.value='waiting';l.familyQueue.value.position=181;
          if(variant==='stalled') {l.drainPerMin.value=0;l.progressAt.value=null;}}
      }
      assert.equal(cli(args,x).pick.account,'ttadk',`${variant}: ${args.join(' ')}`);
    }
  }
  const expiry=structuredClone(freeTrae),ett=expiry.accounts.find(a=>a.id==='ttadk');
  ett.quota[0].usage.value.resetsAt=captured.decisionAt+3*3600000;
  ett.burn.value={resetsAt:ett.quota[0].usage.value.resetsAt,projectedAtReset:50000000};
  const expiring=cli(['analysis'],expiry);
  assert.equal(expiring.pick.account,'trae'); assert.equal(expiring.pick.model,'gpt-6.1-sol');
  assert.equal(expiring.plan.primary.estimate.balance.freeNow,true);
  assert.ok(expiring.plan.trace.candidates.some(r=>r.candidate.accountId==='ttadk'
    && r.candidate.modelId==='gpt-6.1-sol' && r.estimate.expiryOpportunity===true));
  assert.match(expiring.why.join('\n'),/TRAE lane free/);
  assert.equal(cli(['computer-use','--apps','com.apple.calculator'],freeTrae).pick.account,'ttadk');
  const maxArgs=['debug','--impact','service','--failures','1','--actual','codex:gpt-6.1-sol:xhigh@trae'];
  const siblingQueue=structuredClone(freeTrae);
  for(const l of siblingQueue.lanes.filter(l=>l.accountId==='trae'&&l.modelId.startsWith('gpt'))) {
    l.familyQueue.value={position:181,state:'waiting',t:captured.decisionAt};
    if(l.modelId==='gpt-6-astra') {l.position.value=181;l.drainPerMin.value=0;l.progressAt.value=null;l.queueState.value='waiting';}
  }
  const ownFree=cli(maxArgs,siblingQueue);assert.equal(ownFree.pick.account,'trae');assert.equal(ownFree.pick.model,'gpt-6.1-sol');
  assert.match(ownFree.why.join('\n'),/gpt-6.1-sol load 42%/,'a sibling Astra queue cannot override direct free Sol progress');
  const max=cli(maxArgs,freeTrae);assert.equal(max.pick.account,'trae');assert.equal(max.pick.model,'gpt-6.1-sol');assert.equal(max.pick.effort,'max');
  assert.ok(!max.plan.trace.candidates.filter(r=>['trae','ttadk'].includes(r.candidate.accountId)&&r.candidate.modelId==='gpt-6.1-sol'&&r.candidate.effort==='max').some(r=>r.predicates.some(p=>p.reason?.code==='MAX_EFFORT_OK_REQUIRED')));
  for(const bad of ['missing','stalled']) {
    const x=structuredClone(freeTrae);
    for(const l of x.lanes.filter(l=>l.accountId==='trae'&&l.modelId==='gpt-6-astra')) {
      l.progressAt.value=null;l.readyAt.value=null;l.position.value=bad==='stalled'?181:null;l.drainPerMin.value=bad==='stalled'?0:null;l.queueState.value=bad==='stalled'?'waiting':null;
    }
    assert.equal(cli(maxArgs,x).pick.model,'gpt-6.1-sol');
  }
  console.log('PASS observed free TRAE saves fresh TTADK quota; own-model browser/ui-browser load, queue/stall/desktop exceptions and expiring TTADK quota; company Sol/max retry ungated');
  const lookup=cli(['lookup']);assert.ok(lookup.pick.command.includes('--skip-git-repo-check'));
  assert.ok(lookup.pick.command.includes('<workspace>'));assert.ok(lookup.pick.command.includes('<task dir>'));
  const proxyState=structuredClone(freeTrae),proxyHome=path.join(tmp,'ttadk home');
  for(const part of [...proxyState.accounts,...proxyState.lanes]) if((part.accountId??part.id)==='ttadk') part.capabilities.search.value=true;
  fs.writeFileSync(env.CODEX_ACCOUNTS,JSON.stringify({ttadk:{kind:'ttadk',home:proxyHome}}));
  const proxyCommand=cli(['lookup'],proxyState).pick.command;
  const inner=execFileSync('/bin/sh',['-c',`printf '%s' ${proxyCommand.match(/-- sh -c (.*)$/)[1]}`],{encoding:'utf8'});
  assert.match(inner,/proxy.*&& CODEX_HOME=.* codex exec/,'the selected home applies to exec after proxy setup');
  fs.rmSync(env.CODEX_ACCOUNTS);
  const hub=cli(['implement','--impact','service']);assert.equal(hub.pick.workerArgs[hub.pick.workerArgs.indexOf('--cwd')+1],'<workspace>');
  assert.equal(hub.pick.workerArgs[hub.pick.workerArgs.indexOf('--out')+1],'<task dir>/codex-last.md');
  const cwd='scripts/..',taskDir=path.relative(process.cwd(),path.join(tmp,'task with spaces'));
  const absolute=cli(['lookup','--cwd',cwd,'--task-dir',taskDir]);
  assert.equal(absolute.plan.task.cwd,path.resolve(cwd));assert.equal(absolute.plan.task.taskDir,path.resolve(taskDir));
  assert.ok(!absolute.pick.command.includes('<workspace>')&&!absolute.pick.command.includes('<task dir>'));
  const net=cli(['lookup','--network','on']);assert.equal(net.pick.sandbox,'read-only');
  assert.ok(net.pick.command.includes('.network.enabled=true'));assert.ok(net.pick.command.includes(':read-only'));
  assert.ok(net.pick.command.includes('--skip-git-repo-check'));
  const personalOnly=copy();personalOnly.accounts=personalOnly.accounts.filter(a=>!['ttadk','trae'].includes(a.kind));
  personalOnly.lanes=personalOnly.lanes.filter(l=>personalOnly.accounts.some(a=>a.id===l.accountId));
  personalOnly.resources.value={held:false,ownedReturned:true,registeredResources:[],signingRegistry:false};
  const personalReview=cli(['review-high','--review-class','B','--review-reason','permission logic'],personalOnly);assert.ok(personalReview.pick.command.includes('<workspace>'));
  assert.equal(personalReview.secondOpinion.command,null);assert.ok(personalReview.plan.gates.some(g=>g.kind==='personal-quota'),'Claude second still asks on a personal-only device');
  const noResources=cli(['implement','--impact','service'],personalOnly).allNotes.join('\n');
  assert.doesNotMatch(noResources,/A queued TRAE|on TTADK:|DeepSeek:|identities\.json|iphone8\/iphone11\/s21|registered shared test phones/);
  const registered=copy();registered.resources.value={held:false,ownedReturned:true,registeredResources:['iphone11'],signingRegistry:false};
  const phoneNotes=cli(['build-run'],registered).allNotes.join('\n');assert.match(phoneNotes,/registered shared test phones iphone11/);
  assert.doesNotMatch(phoneNotes,/registered shared test phones iphone8/);
  registered.resources.value.signingRegistry=true;assert.match(cli(['analysis'],registered).allNotes.join('\n'),/identities\.json/);
  console.log('PASS BC-35 placeholders/absolute paths, one-shot git check, read-only network, second-reviewer paths and device-specific notes');
  const trae=captured.accounts.find(a=>a.id==='trae');
  assert.equal(trae.auth.status,'KNOWN');assert.equal(trae.transport.value,true);
  assert.ok(trae.quota.length>0);
  for(const q of trae.quota) {assert.equal(q.usage.status,'KNOWN');assert.ok(q.usage.sampledAt<=captured.decisionAt,'refreshed samples cannot be future evidence');}
  assert.ok(captured.lanes.filter(l=>l.accountId==='trae').every(l=>l.mode!=='UNKNOWN'),'captured live quota must actually survive normalization');
  for(const args of [['lookup'],['analysis'],['research'],['implement','--impact','service'],
    ['implement-hard','--impact','service'],['debug','--impact','release'],['review'],['review-high','--review-class','B','--review-reason','permission logic'],
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
    const o=cli(args);assert.equal(o.pick.model,['lookup','extract','draft'].includes(args[0])?'gpt-5.6-terra':'gpt-6.1-sol',`quality ladder: ${args.join(' ')}`);
  }
  for(const category of ['image-gen','claude-tools']) {
    const o=cli([category]);assert.ok(o.pick.command);assert.equal(o.needsUserOK.length,0);
  }
  fs.writeFileSync(file,JSON.stringify(captured));
  execFileSync(process.execPath,[route,'analysis','--project','route-regression','--name','BC-29','--json'],
    {env:{...env,ROUTE_LOG:'1'},encoding:'utf8',maxBuffer:16<<20});
  const recheck=cli(['review-high','--project','route-regression','--name','BC-29','--impact','service','--runs-tests']);
  const freshReview=cli(['review-high','--project','route-regression','--name','BC-29-fresh','--impact','service','--runs-tests']);
  assert.equal(recheck.kind,'launch');assert.equal(recheck.failures,0);assert.equal(recheck.plan.task.previousAttempts.length,0);
  assert.equal(recheck.pick.model,freshReview.pick.model);assert.equal(recheck.pick.effort,freshReview.pick.effort);
  assert.equal(recheck.pick.account,freshReview.pick.account);fs.rmSync(env.ROUTE_LOG_FILE);
  const desktop=copy(), app={status:'KNOWN',value:true,sampledAt:captured.decisionAt,receivedAt:captured.decisionAt,maxAgeMs:600000,source:'fixture'};
  for(const part of [...desktop.accounts,...desktop.lanes]) if(['main','b'].includes(part.accountId??part.id)) part.capabilities['app:com.apple.calculator']=app;
  const personal=cli(['computer-use','--apps','com.apple.calculator'],desktop);
  assert.match(personal.allNotes.join('\n'),/browser its own tool lists; never put a Claude-in-Chrome deviceId/);
  assert.match(personal.allNotes.join('\n'),/saved browser permission.*cannot be continued.*new thread with --browser-origins/);
  assert.ok(['main','b'].includes(personal.pick.account));assert.ok(personal.needsUserOK.length);assert.equal(personal.pick.command,null);
  const approvedArgs=['computer-use','--apps','com.apple.calculator','--urgent'];
  const offered=cli(approvedArgs,desktop),approvals=path.join(tmp,'personal-approval.json');
  const approvedDesktop=structuredClone(desktop);approvedDesktop.approvals=[{id:'fixture-user-yes',userDecisionRef:'synthetic-user-yes',revoked:false,grantedAt:captured.decisionAt-1000,expiresAt:captured.decisionAt+60000,scopes:offered.plan.gates.filter(g=>g.scope).map(g=>({...g.scope,allowPersonalWithCompany:true}))}];
  assert.ok(cli([...approvedArgs,'--user-ok','fixture-user-yes'],approvedDesktop).pick.command);

  const reachableTT=structuredClone(desktop), tt=reachableTT.accounts.find(a=>a.id==='ttadk');
  tt.auth.value=true;tt.transport.value=true;tt.providerDenied.value=true;
  for(const part of [tt,...reachableTT.lanes.filter(l=>l.accountId==='ttadk')]) part.capabilities['app:com.apple.calculator']=app;
  for(const args of [['computer-use','--apps','com.apple.calculator'],['review','--security','--defensive']]) {
    const o=cli(args,reachableTT);assert.equal(o.kind,'blocked');assert.ok(['main','b'].includes(o.pick.account));
    assert.equal(o.deferred,null,'a future TTADK reset cannot hide the personal-now proposal');assert.equal(o.pick.command,null);
    assert.ok(o.needsUserOK.some(w=>/personal quota now, or wait until/.test(w)));
    const yes=cli([...args,'--urgent','--user-ok','ledger:personal-now'],reachableTT,true);assert.ok(yes.pick.command);
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
  assert.equal(browserPick.account,'trae');assert.equal(browserPick.model,'gpt-6.1-sol');
  const broken=copy();broken.accounts.find(a=>a.id==='main').catalog.value={malformed:true};
  assert.equal(cli(['analysis'],broken).pick.account,'trae','malformed personal account cannot poison company state');
  const stale=copy();stale.accounts.find(a=>a.id==='main').auth.sampledAt-=3600000;
  assert.equal(cli(['analysis'],stale).pick.account,'trae','one stale account cannot defer healthy company work');
  const budget=copy();budget.reviewHistory=Array.from({length:10},(_,i)=>({t:captured.decisionAt-1000,project:'fixture',name:`work-${i}`,category:i<2?'review':'implement'}));
  const review=cli(['review','--project','fixture'],budget);assert.ok(review.pick.command);
  assert.match(review.tellUser.join('\n'),/over review budget — prefer accepting on tests/);
  const owned=path.join(tmp,'named-task');fs.mkdirSync(owned);
  fs.writeFileSync(path.join(owned,'launch.json'),JSON.stringify({id:'owned-astra',taskId:'named-task',project:'fixture',category:'debug',role:'primary',state:'failed',actualStatus:'KNOWN',actual:{model:'gpt-6-astra',effort:'xhigh',account:'trae'}}));
  fs.writeFileSync(env.ROUTE_LOG_FILE,JSON.stringify({t:captured.decisionAt-1000,kind:'route',name:'named-task',project:'fixture',pick:{model:'gpt-6.1-sol',effort:'high',account:'trae'}})+'\n');
  const retryArgs=['debug','--impact','service','--failures','1','--name','named-task','--project','fixture','--task-dir',owned];
  const ownedRetry=cli(retryArgs);assert.equal(ownedRetry.plan.task.previousAttempts[0].actual.modelId,'gpt-6-astra','scoped actual launch precedes route decisions');
  const explicit=cli([...retryArgs,'--actual','codex:gpt-6.1-sol:high@trae']);
  assert.equal(explicit.plan.task.previousAttempts.length,1);assert.equal(explicit.plan.task.previousAttempts[0].actual.modelId,'gpt-6.1-sol','explicit actual wins');
  fs.rmSync(path.join(owned,'launch.json'));
  const logged=cli(retryArgs);assert.equal(logged.plan.task.previousAttempts[0].id,'assumed-first-rung','route decisions never establish an actual floor');
  fs.rmSync(env.ROUTE_LOG_FILE);
  const attempts=path.join(owned,'attempts.json');
  fs.writeFileSync(attempts,JSON.stringify([{id:'finished',taskId:'named-task',project:'fixture',category:'debug',role:'primary',state:'failed',actualStatus:'UNKNOWN',actual:null}]));
  const unknownRetry=cli([...retryArgs,'--previous-attempt','attempts.json']);
  assert.ok(!unknownRetry.plan.rejected.some(r=>r.reason.code==='PREVIOUS_ATTEMPT_UNKNOWN'));
  assert.match(unknownRetry.why.join('\n'),/assumed first category ladder rung/);
  fs.writeFileSync(attempts,JSON.stringify([{id:'legacy-claude',taskId:'named-task',project:'fixture',category:'claude-tools',role:'primary',state:'failed',actualStatus:'KNOWN',actual:{vendor:'claude',model:'sonnet',effort:'medium'}}]));
  const legacy=cli(['claude-tools','--name','named-task','--project','fixture','--task-dir',owned,'--previous-attempt','attempts.json','--failures','1']);
  assert.equal(legacy.plan.task.previousAttempts[0].actual.accountId,'claude');assert.ok(legacy.pick.command);
  fs.writeFileSync(attempts,JSON.stringify([{id:'uncertain',taskId:'named-task',project:'fixture',category:'debug',role:'primary',state:'UNKNOWN',actualStatus:'UNKNOWN',actual:null}]));
  const liveUnknown=cli([...retryArgs,'--previous-attempt','attempts.json']);
  assert.equal(liveUnknown.kind,'defer');assert.ok(liveUnknown.plan.rejected.some(r=>r.reason.code==='ATTEMPT_RECONCILIATION_REQUIRED'));
  fs.rmSync(attempts);
  fs.writeFileSync(env.ROUTE_LOG_FILE,JSON.stringify({t:captured.decisionAt-1000,kind:'route',name:'claude-retry',project:'fixture',pick:{vendor:'claude',model:'sonnet',effort:'medium'}})+'\n');
  const claudeRetry=cli(['claude-tools','--name','claude-retry','--project','fixture','--failures','1']);
  assert.equal(claudeRetry.plan.task.previousAttempts[0].actual.accountId,'claude','missing Claude launch history assumes the Claude category first rung');
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
  const healthyPeer=parseRouteJSON(execFileSync(process.execPath,[route,'analysis','--dry','--json'],{env:offline,encoding:'utf8'}));
  assert.equal(healthyPeer.kind,'launch');assert.equal(healthyPeer.pick.account,'peer','corrupt health data degrades only its account');
  assert.ok(healthyPeer.plan.rejected.some(r=>r.reason.code==='HEALTH_UNKNOWN'));
  console.log('PASS live captured CLI: company parity, signing, retry fallback, pending second, standing exceptions, user yes, browser order, account isolation and budget warning');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
