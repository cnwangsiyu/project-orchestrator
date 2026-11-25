#!/usr/bin/env node
// Capture launch argv and RPC fixtures only; never contact providers or real workers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadDigest, parseDigest } from '../lib/global-rules.mjs';
import { WORKER_NOTES } from '../lib/fixed-worker-notes.mjs';
const scripts = path.resolve(new URL('..', import.meta.url).pathname);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lean-route-'));
const projectOrigins=JSON.parse(fs.readFileSync(path.join(scripts,'../references/project-risk-profiles.json'))).acq?.browserOrigins??[];
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/free-trae-fresh-ttadk-2026-11-15.json',import.meta.url)));
const snapshot=path.join(dir,'snapshot.json'),bin=path.join(dir,'bin'),capture=path.join(dir,'capture.json');
fs.mkdirSync(bin);
const env={...process.env,HOME:dir,RULES_SHARED:dir,CODEX_ACCOUNTS:path.join(dir,'accounts.json'),QUOTA_CACHE:path.join(dir,'quota.json'),ROUTE_SNAPSHOT_FILE:snapshot,ROUTE_LOG_FILE:path.join(dir,'routes.jsonl'),ROUTE_LOG:'0',ROUTE_NOW:String(raw.decisionAt),ROUTE_REQUEST_ID:'lean-route',PATH:`${bin}:${process.env.PATH}`,CAPTURE:capture};
const cli=(args)=>execFileSync(process.execPath,[path.join(scripts,'route.mjs'),...args,'--dry'],{env,encoding:'utf8',maxBuffer:16<<20});
try {
  fs.writeFileSync(snapshot,JSON.stringify(raw));
  const args=['implement','--project','video-agent','--writes','--impact','service'];
  const output=cli(args), verbose=cli([...args,'--verbose']), route=JSON.parse(cli([...args,'--json']));
  const boardRoute = JSON.parse(cli([...args, '--task', 'board-task', '--json']));
  const taskFlag = boardRoute.pick.workerArgs.indexOf('--task');
  assert.ok(taskFlag >= 0); assert.equal(boardRoute.pick.workerArgs[taskFlag + 1], 'board-task');
  assert.ok(Buffer.byteLength(output)<3584,`writes output ${Buffer.byteLength(output)} bytes`);
  assert.match(output,/worker rules .* are injected by the launcher; do not copy them into the brief/);
  assert.doesNotMatch(output,/Global worker rules .*:|credential clause|full-package builds must use|bare note\/ask/);
  assert.match(output,/slow tests for this project/);assert.match(output,/landing gate:/);
  assert.ok(route.fixedNotes.includes(WORKER_NOTES.localBuild));assert.ok(!route.notes.includes(WORKER_NOTES.localBuild));
  assert.match(verbose,/fixedNotes: build brief:/);assert.ok(verbose.length>output.length);
  const noDeepSeek = JSON.parse(cli([...args, '--exclude-model', 'deepseek', '--json']));
  assert.ok(!noDeepSeek.notes.some(note => note.startsWith('DeepSeek:')), 'catalog presence alone cannot emit DeepSeek limits');
  const deepSeek = JSON.parse(cli(['implement', '--read-only', '--impact', 'service', '--exclude-model', 'gpt,seed,gemini', '--exclude-account', 'main,b', '--json']));
  assert.match(deepSeek.pick.model, /^deepseek/);
  assert.ok(deepSeek.notes.some(note => note.startsWith('DeepSeek:')), 'chosen DeepSeek receives its limits');
  const timed = structuredClone(raw);
  timed.etaHistory = [0, 1, 2].map(i => ({ category: 'implement', effort: 'high', minutes: 21.582291666666666,
    modelId: 'gpt-6.1-sol', accountId: 'trae', attemptId: `timing-${i}`, cause: 'pass' }));
  fs.writeFileSync(snapshot, JSON.stringify(timed));
  const timedOutput = cli(args);
  assert.match(timedOutput, /~22 min/); assert.doesNotMatch(timedOutput, /21\.582/);
  fs.writeFileSync(snapshot, JSON.stringify(raw));
  const normalize=pick=>{
    const result=JSON.parse(JSON.stringify(pick).replace(/route:[a-f0-9]+/g,'route:fixture'));
    // The saved route args retain diagnostic flags for replay. Compare those
    // args explicitly after removing only --verbose; every executable arg and
    // every selected tuple field must remain identical.
    const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
    const rewrite=(index,value)=>{
      const before=result.workerArgs[index];
      result.workerArgs[index]=value;
      result.command=result.command.replace(quote(before),quote(value));
    };
    const index=result.workerArgs.indexOf('--route-args');
    if(index>=0) rewrite(index+1,JSON.stringify(JSON.parse(result.workerArgs[index+1]).filter(arg=>arg!=='--verbose')));
    const alternative=result.workerArgs.indexOf('--queue-alternative');
    if(alternative>=0) {
      const saved=JSON.parse(result.workerArgs[alternative+1]);
      saved.routeArgs=saved.routeArgs.filter(arg=>arg!=='--verbose');
      rewrite(alternative+1,JSON.stringify(saved));
    }
    const alt=result.workerArgs.indexOf('--alt');
    if(alt>=0) rewrite(alt+1,result.workerArgs[alt+1].replace(/ --verbose(?= |$)/g,''));
    return result;
  };
  assert.deepEqual(normalize(JSON.parse(cli([...args,'--verbose','--json'])).pick),normalize(route.pick),'verbose preserves launch arguments and chosen tuple apart from the output-flag fingerprint');
  const phones=structuredClone(raw);phones.resources.value.registeredResources=['iphone11'];
  fs.writeFileSync(snapshot,JSON.stringify(phones));
  const deviceRoute=JSON.parse(cli(['build-run','--json']));
  assert.ok(deviceRoute.notes.some(n=>n.includes('iphone11')));
  assert.ok(!deviceRoute.notes.some(n=>/Allow\/Authorize|USB debugging|no purchases/.test(n)));
  assert.ok(deviceRoute.fixedNotes.some(n=>/iphone11.*Allow\/Authorize/.test(n)));
  fs.writeFileSync(snapshot,JSON.stringify(raw));
  console.log('PASS lean text, verbose diagnostics, JSON separation and unchanged choice');
  // This normal CLI hook deliberately skips workers. The append prompt must be sufficient by itself.
  fs.writeFileSync(path.join(bin,'claude'),`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2)));\n`,{mode:0o755});
  for(const category of ['claude-tools','browser']) {
    const state=structuredClone(raw);
    if(category==='browser') {
      state.accounts=state.accounts.filter(a=>a.kind==='claude');state.lanes=state.lanes.filter(l=>state.accounts.some(a=>a.id===l.accountId));
      for(const part of [...state.accounts,...state.lanes]) {
        const obs={status:'KNOWN',value:true,sampledAt:raw.decisionAt,receivedAt:raw.decisionAt,maxAgeMs:600000,source:'fixture'};
        part.capabilities.browser=obs;part.capabilities['signed-in-browser']=obs;
        for(const origin of [...projectOrigins,'https://example.test','*.bytedance.net','*.byted.org','*.larkoffice.com','*.feishu.cn','*.tiktok-row.net','*.byteintl.net','*.bytedance.com'])part.capabilities[`origin:${origin}`]=obs;
      }
    }
    fs.writeFileSync(snapshot,JSON.stringify(state));
    const requested=[category,'--urgent','--project','acq','--cwd',dir,'--task-dir',dir,'--trusted-cwd',dir,...(category==='browser'?['--origins','https://example.test']:[])];
    let r=JSON.parse(cli([...requested,'--json']));
    if(r.pick&&!r.pick.command){state.approvals=[{id:'fixture-approval',userDecisionRef:'synthetic-user-yes',revoked:false,grantedAt:raw.decisionAt-1000,expiresAt:raw.decisionAt+60000,scopes:r.plan.gates.filter(g=>g.scope).map(g=>({...g.scope,allowPersonalWithCompany:true}))}];fs.writeFileSync(snapshot,JSON.stringify(state));r=JSON.parse(cli([...requested,'--user-ok','fixture-approval','--json']));}
    assert.equal(r.pick?.vendor,'claude',JSON.stringify(r.why));assert.ok(r.pick.command,JSON.stringify({why:r.why,ok:r.needsUserOK,gates:r.plan.gates}));
    assert.doesNotMatch(r.pick.command,/Global worker rules/);
    const digestFile=path.join(dir,'launch-digest.md'),latest=loadDigest().text.replace('## Details','- Fixture launch-time marker.\n\n## Details');
    fs.writeFileSync(digestFile,latest);
    execFileSync('/bin/sh',['-c',r.pick.command],{env:{...env,RULES_DIGEST:digestFile},encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const argv=JSON.parse(fs.readFileSync(capture)),prompt=argv[argv.indexOf('--append-system-prompt')+1],digest=parseDigest(latest);
    assert.match(prompt,/Fixture launch-time marker/);
    assert.equal(prompt,`Global worker rules ${digest.version}\n${digest.worker}`);
    for(const clause of Object.values(WORKER_NOTES))assert.ok(prompt.includes(clause),clause);
    assert.match(prompt,/never overwrite, delete or move files outside the task's scope.*byte-for-byte/);
  }
  console.log('PASS Claude tools and browser launches automatically receive every fixed clause');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
