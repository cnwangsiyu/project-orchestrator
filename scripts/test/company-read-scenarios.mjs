#!/usr/bin/env node
// Synthetic company profiles and stubbed CLI calls only; never open a credential file or contact a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {readPause,readPoolPauses,readModelPauses,readHealthStatus,claimProbes,readTraeBrowserHealth} from '../lib/trae-health.mjs';
import {readHubDiagnostics,writeHubState} from '../lib/hub-state.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'company-read-'));
const profiles = path.join(tmp, 'accounts.json'), cache = path.join(tmp, 'quota.json');
const exec = childProcess.execFileSync, rename = fs.renameSync, exists = fs.existsSync;
const SOL = 'gpt-6.1-sol';
const ttadkBin = path.join(tmp, 'ttadk-cli'), traeBin = path.join(tmp, 'trae-cli');
fs.writeFileSync(ttadkBin, 'fixture'); fs.writeFileSync(traeBin, 'fixture');
const registry = {
  ttadk: { kind: 'ttadk', home: tmp, hub: 'ws://127.0.0.1:1', ttadkBin, models: [SOL] },
  trae: { kind: 'trae', home: tmp, hub: 'ws://127.0.0.1:2', bin: traeBin, models: [SOL] },
};
Object.assign(process.env, { CODEX_ACCOUNTS: profiles, QUOTA_CACHE: cache, QUOTA_LOG: '0', TRAE_PROBE: '0',
  QUOTA_LOG_FILE: path.join(tmp, 'history.jsonl') });
let fault = '', companyChecks = 0;
const counts = {};
const stub = (bin, args) => {
  if (fault !== 'registry-lock') assert.ok(!exists(`${profiles}.lock`), 'slow CLI reads must not hold the registry lock');
  const key = `${bin}:${args[0]}`; counts[key] = (counts[key] ?? 0) + 1;
  if (bin === 'claude') return 'Current week (all models): 10% used\n';
  if (bin === '/bin/sh') return 'Logged in\n';
  if (bin === 'lsof') return '';
  if (args[0] === 'auth' && args[1] === 'status') return JSON.stringify({ providers: [{ provider: 'sso', status: 'active' }] });
  if (args[0] === 'auth' && args[1] === 'token') {
    if (fault === 'timeouts') throw Object.assign(Error('fixture timeout'), { code: 'ETIMEDOUT' });
    return fault === 'malformed' ? '{"token":"synthetic-fixture"}' : '{}';
  }
  if (args[0] === '--input-type=module') return 'truncated quota JSON';
  if (args[0] === 'models' && args.includes('--json')) {
    if (fault === 'timeouts') throw Object.assign(Error('fixture timeout'), { code: 'ETIMEDOUT' });
    if (fault === 'malformed') return 'truncated catalog JSON';
    if (bin === traeBin && fault.startsWith('catalog:')) return JSON.stringify({ models: [{ id: fault.slice(8) }] });
  }
  if (args[0] === 'models') {
    if (bin === ttadkBin && fault === 'tt-model-timeout') throw Object.assign(Error('fixture catalog timeout'), { code: 'ETIMEDOUT' });
    return args.includes('--json') ? JSON.stringify({ models: [{ id: SOL }] })
      : JSON.stringify([{ id: fault.startsWith('tt-catalog:')?fault.slice(11):SOL, availableAgents: ['codex'] }]);
  }
  if (args.includes('usage')) {
    if (fault === 'malformed') return 'truncated usage JSON';
    throw Object.assign(Error('fixture usage failure'), { code: fault === 'timeouts' ? 'ETIMEDOUT' : 'EIO' });
  }
  if (args.includes('list')) return '';
  if (args.includes('browser-health')) return JSON.stringify({traeBrowser:fault!=='bridge-failed',status:'ready'});
  throw Error('unexpected subprocess in company-read fixture');
};
childProcess.execFileSync = stub;
const checkCompany = (p) => {
  if (p === ttadkBin || p === traeBin) {
    companyChecks++;
    if (fault === 'unknown-both' || (p === ttadkBin && (fault === 'unknown-ttadk' || (fault === 'recover' && companyChecks === 1))))
      throw Object.assign(Error('fixture metadata read failed'), { code: 'EIO' });
  }
  return exists(p);
};
fs.existsSync = checkCompany;
syncBuiltinESMExports();
try {
  const healthHome=path.join(tmp,'health-reader');fs.mkdirSync(healthHome);
  assert.equal(readHealthStatus(healthHome),'UNKNOWN');assert.equal(readPause(healthHome).status,'UNKNOWN');
  for(const bad of ['null','[]','{"pools":{"gpt":null}}','{"modelPauses":null}']) {
    fs.writeFileSync(path.join(healthHome,'worker-health.json'),bad);
    assert.equal(readPause(healthHome).status,'UNKNOWN');assert.deepEqual(readPoolPauses(healthHome),{});assert.deepEqual(readModelPauses(healthHome),{});
    assert.deepEqual(claimProbes(healthHome),[]);assert.equal(fs.readFileSync(path.join(healthHome,'worker-health.json'),'utf8'),bad);
  }
  let diagnostic=readHubDiagnostics(healthHome,['ttadk']);assert.equal(diagnostic.complete,false);assert.match(diagnostic.errors.join(' '),/supervisor state UNKNOWN/);
  writeHubState(healthHome,'ttadk',{mode:'HEALTHY',failures:0,t:Date.now(),retryAt:null,reason:'HEALTHY'});
  assert.equal(readHubDiagnostics(healthHome,['ttadk']).complete,true);
  console.log('ok   null/absent health readers return UNKNOWN; corrupt ledgers are preserved; missing supervisor state is incomplete');
  fs.writeFileSync(profiles, JSON.stringify(registry));
  const { readState, analyze, readProfiles, readRoutingAccount } = await import('../lib/state.mjs');
  const pairingFile = path.join(tmp, 'fixture-pairing'); fs.writeFileSync(pairingFile, 'synthetic-fixture');
  process.env.PLAYWRIGHT_EXTENSION_TOKEN_FILE = pairingFile;
  fault = 'bridge-failed';
  assert.equal(readTraeBrowserHealth('trae', registry.trae).traeBrowser, false);
  const failedBridge = readRoutingAccount('trae', registry.trae);
  assert.equal(failedBridge.healthy, true); assert.equal(failedBridge.traeBrowser, false);
  fault = '';
  assert.equal(readTraeBrowserHealth('trae', registry.trae).traeBrowser, true);
  delete process.env.PLAYWRIGHT_EXTENSION_TOKEN_FILE;
  console.log('ok   failed bridge startup disables TRAE browser capability while preserving ordinary account health');
  fs.renameSync = (src, dst) => {
    if (dst === profiles) throw Object.assign(Error('fixture registry write failed'), { code: 'EIO' });
    return rename(src, dst);
  };
  syncBuiltinESMExports();
  const data = readState({ fresh: true });
  assert.ok(Array.isArray(data.codexAccounts), 'a registry write failure must not discard already-read company accounts');
  assert.equal(data.codexAccounts.length, 2);
  assert.equal(analyze(data).codex.ttadk.usable, true);
  assert.equal(analyze(data).codex.trae.usable, true);
  assert.match(data.errors.registryWrite, /fixture registry write failed/);
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).codexAccounts.length, 2);
  console.log('ok   registry write failure preserves both company accounts and their usable state');

  fs.renameSync = rename; syncBuiltinESMExports();
  for (fault of ['timeouts', 'malformed']) {
    const d = readState({ fresh: true }), x = analyze(d).codex;
    assert.equal(d.codexAccounts.length, 2);
    assert.equal(x.ttadk.usable, true); assert.equal(x.trae.usable, true);
    assert.equal(x.ttadk.usage, null); assert.ok(x.ttadk.usageError);
    assert.equal(x.trae.quota, null); assert.match(x.trae.quotaError, /usage read failed.*models\/load read failed/);
    assert.deepEqual(x.trae.load, {}); assert.deepEqual(x.trae.models, [SOL]);
    assert.deepEqual(x.companyUnknown, []);
  }
  console.log('ok   thrown/time-out and malformed usage/load reads leave both accounts present and usable');

  fault = 'recover'; companyChecks = 0;
  const recovered = readState({ fresh: true });
  assert.equal(companyChecks, 4, 'a newly failed fresh reading is retried once');
  assert.equal(analyze(recovered).codex.ttadk.usable, true);
  assert.deepEqual(analyze(recovered).codex.companyUnknown, []);

  const claude = recovered.claude;
  const missing = { checkedAt: Date.now(), claude, codexAccounts: [], errors: {}, history: {} };
  fs.writeFileSync(cache, JSON.stringify(missing));
  fault = 'unknown-both'; companyChecks = 0;
  const unknown = readState();
  assert.equal(companyChecks, 2, 'missing cached accounts get exactly one fresh read');
  assert.deepEqual(analyze(unknown).codex.companyUnknown, [{ name: 'ttadk', kind: 'ttadk' }, { name: 'trae', kind: 'trae' }]);
  assert.ok(unknown.codexAccounts.every((a) => a.stateUnknown && !a.healthy));
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).codexAccounts.length, 2);
  console.log('ok   fresh retry recovers transient failures; persistent missing state retains both company identities');

  fault = '';
  for (const bad of ['{"checkedAt":', 'null', '[]', '{"checkedAt":9999999999999,"codexAccounts":[]}']) {
    fs.writeFileSync(cache, bad);
    const d = readState();
    assert.match(d.errors.cacheRead, /cache unreadable or incomplete/);
    assert.equal(analyze(d).codex.ttadk.usable, true);
    assert.equal(analyze(d).codex.trae.usable, true);
  }
  const oldCache = fs.readFileSync(cache, 'utf8');
  fs.renameSync = (src, dst) => {
    if (dst === cache) throw Object.assign(Error('fixture cache write failed'), { code: 'EIO' });
    return rename(src, dst);
  };
  syncBuiltinESMExports();
  const unsaved = readState({ fresh: true });
  assert.match(unsaved.errors.cacheWrite, /fixture cache write failed/);
  assert.equal(analyze(unsaved).codex.ttadk.usable, true);
  assert.equal(fs.readFileSync(cache, 'utf8'), oldCache, 'a failed atomic rename leaves the last complete cache intact');
  fs.renameSync = rename; syncBuiltinESMExports();
  console.log('ok   truncated/invalid cache is refreshed and atomic-save failure keeps the previous complete cache');

  fs.writeFileSync(profiles, '{"ttadk":');
  assert.throws(readProfiles, /account registry unreadable/);
  const unreadableRegistry = readState({ fresh: true });
  assert.match(unreadableRegistry.errors.registry, /account registry unreadable/);
  assert.equal(fs.readFileSync(profiles, 'utf8'), '{"ttadk":', 'never replace a corrupt registry with main');
  fs.writeFileSync(profiles, JSON.stringify(registry));
  assert.equal(analyze(readState()).codex.registryError, null, 'a repaired registry clears the unknown marker');
  console.log('ok   corrupt registry fails closed, is never overwritten, and can recover');

  for (const model of ['gpt-5.6-terra', 'gpt-5.5', 'gpt-6-astra', 'deepseek-v4-pro']) {
    fault = `catalog:${model}`;
    const d = readState({ fresh: true });
    assert.equal(analyze(d).codex.trae.usable, true, 'catalog health must not enforce task eligibility');
    assert.deepEqual(d.codexAccounts.find((a) => a.kind === 'trae').models, [model]);
  }
  fault = '';
  console.log('ok   live-read catalogs with only a tier model remain healthy; routing owns model eligibility');
  fault='tt-catalog:deepseek-v4.1-flash';
  const qualifiedTT=readState({fresh:true});assert.equal(qualifiedTT.codexAccounts.find(a=>a.kind==='ttadk').healthy,true);
  assert.deepEqual(qualifiedTT.codexAccounts.find(a=>a.kind==='ttadk').models,['deepseek-v4.1-flash']);
  fault='tt-catalog:unqualified-model';assert.equal(readState({fresh:true}).codexAccounts.find(a=>a.kind==='ttadk').healthy,false);
  fault='';
  console.log('ok   TTADK remains healthy without Sol when its catalog contains another usable qualified model');

  // Real router and quota entry points, with all provider I/O stubbed before they import state.mjs.
  const browserCommand=path.join(tmp,'node_repl');
  fs.writeFileSync(browserCommand,'fixture runtime',{mode:0o700});
  const browserCli=path.join(tmp,'codex'); fs.writeFileSync(browserCli,'fixture executable',{mode:0o700});
  fs.writeFileSync(path.join(tmp,'config.toml'),`[mcp_servers.node_repl]\ncommand = ${JSON.stringify(browserCommand)}\n[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = ${JSON.stringify(browserCli)}\n`);
  const preload = path.join(tmp, 'preload.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const profiles = ${JSON.stringify(profiles)}, ttadkBin = ${JSON.stringify(ttadkBin)}, traeBin = ${JSON.stringify(traeBin)};
const SOL = ${JSON.stringify(SOL)}, exists = fs.existsSync, counts = {};
let fault = process.env.COMPANY_READ_FAULT || '', companyChecks = 0;
childProcess.execFileSync = ${stub.toString()};
fs.existsSync = ${checkCompany.toString()};
const stat=fs.statSync;
fs.statSync=(file,...args)=>file==='/Applications/ChatGPT.app'?{isDirectory:()=>true}:stat(file,...args);
const childExec=childProcess.execFileSync;
childProcess.execFileSync=(file,args,...rest)=>file==='/usr/libexec/PlistBuddy'?'26.1117':file==='ps'&&args.join(' ')==='-axo comm='?'/Applications/ChatGPT.app/Contents/Resources/extension-host/macos/arm64/ChatGPT for Chrome':file==='pgrep'?'fixture host':childExec(file,args,...rest);
syncBuiltinESMExports();
`);
  const route = (args, state = missing, mode = 'unknown-both', registryText = JSON.stringify(registry)) => {
    if (args[0] === 'browser' && !args.includes('--origins') && !args.includes('--browser-origins'))
      args = [...args, '--browser-origins', 'https://example.test'];
    fs.rmSync(`${cache}.routing-last-good.json`,{force:true}); // independent fixture, no retained reading
    fs.writeFileSync(profiles, registryText);
    fs.writeFileSync(cache, typeof state === 'string' ? state : JSON.stringify(state));
    const env = { ...process.env, HOME: tmp, COMPANY_READ_FAULT: mode, ROUTE_LOG: '0', ROUTE_RR: path.join(tmp, 'rr'),
      ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl') };
    return JSON.parse(exec(process.execPath, ['--import', preload, new URL('../route.mjs', import.meta.url).pathname,
      ...args, '--json', '--dry', '--mode', 'default'], { env, encoding: 'utf8', timeout: 10000 }));
  };
  const gate = (o) => o.needsUserOK.some((n) => /^personal quota:/.test(n));
  for (const args of [['analysis'], ['analysis','--stakes','high'], ['image-gen'], ['claude-tools'], ['browser']]) {
    const o=route(args);
    if(args[0]==='claude-tools') { assert.equal(o.blocked,false);assert.ok(o.pick.command);assert.ok(!gate(o)); }
    else {assert.equal(o.blocked,true,args.join(' '));assert.ok(!o.pick?.command);if(o.pick) assert.ok(gate(o));}
  }
  const staleClaude=route(['claude-tools'],{...missing,checkedAt:Date.now()-11*60000});
  assert.equal(staleClaude.blocked,false,'stale Claude status must refresh before the ten-minute admission TTL');
  assert.ok(staleClaude.pick.command);assert.ok(!gate(staleClaude));
  const urgent=route(['analysis','--urgent']);
  assert.equal(urgent.blocked,true); assert.ok(!urgent.pick?.command);
  // The router consumes public cache evidence. It never obtains credentials or
  // turns --fresh/urgency into provider access or a scoped personal decision.
  for(const mode of ['','unknown-ttadk','unknown-both']) {
    const o=route(['analysis','--fresh'],missing,mode);
    assert.ok(o.notes.some(n=>n.startsWith('--fresh:')));
    if(mode==='unknown-both') assert.equal(o.blocked,true);else {assert.equal(o.blocked,false);assert.ok(['ttadk','trae'].includes(o.pick.account));}
  }
  const repairedState={...recovered,checkedAt:Date.now(),codexAccounts:recovered.codexAccounts.map(a=>({...a,live:true,healthy:true}))};
  const repaired=route(['analysis'],repairedState,'');
  assert.equal(repaired.pick.account,'ttadk'); assert.equal(repaired.blocked,false); assert.equal(gate(repaired),false);
  const browserRegistry = JSON.stringify({...registry,ttadk:{...registry.ttadk,browser:true}});
  for (const mode of ['', 'tt-model-timeout']) {
    const browser = route(['browser','--fresh'], missing, mode, browserRegistry);
    assert.equal(browser.pick.account, 'ttadk'); assert.equal(browser.blocked, false);
    assert.ok(!browser.notes.some(n=>/retained last-good stale observations for ttadk/.test(n)));
  }
  console.log('ok   healthy TTADK browser routes with failing display-only usage and a retained qualified catalog');
  const design=route(['design'],repairedState,'');
  assert.equal(design.secondOpinion,null,'ordinary design no longer adds a reviewer');
  for(const broken of ['{"checkedAt":',{...missing,codexAccounts:null}]) {
    const o=route(['analysis'],broken,''); assert.equal(o.blocked,false);assert.equal(o.pick.account,'ttadk');
  }
  const corruptRegistry=route(['analysis'],repairedState,'','{"ttadk":');
  assert.equal(corruptRegistry.blocked,true); assert.ok(!corruptRegistry.pick?.command);
  console.log('ok   router uses public cache, blocks unknown transport/corrupt registry, and requires scoped personal approval');

  const {acquireRoute}=await import('../lib/route-data.mjs');
  const {parseTaskSpec,routePure}=await import('../lib/pipeline/index.mjs');
  const safeDir=path.join(tmp,'last-good');fs.mkdirSync(safeDir);
  const safeCache=path.join(safeDir,'quota.json'),safeRegistry=path.join(safeDir,'accounts.json'),at=Date.now();
  fs.writeFileSync(safeRegistry,JSON.stringify({ttadk:{kind:'ttadk',home:safeDir,browser:true,models:[SOL]}}));
  const good={checkedAt:at,claude:[{used:10,windowMins:10080,resetsAt:at+7*86400000}],codexAccounts:[
    {name:'ttadk',kind:'ttadk',home:safeDir,models:[SOL],healthy:true,live:true,browser:true,windows:[],seenAt:at,
      usage:{used:20000000,limit:500000000,resetsAt:at+12*3600000}}]};
  fs.writeFileSync(safeCache,JSON.stringify(good));
  const safeEnv={RULES_SHARED:safeDir,CODEX_ACCOUNTS:safeRegistry,QUOTA_CACHE:safeCache,ROUTE_LOG_FILE:path.join(safeDir,'routes.jsonl')};
  const acquire=(args,readAccount=()=>({name:'ttadk',kind:'ttadk',healthy:false,live:false,models:[],statusReadFailed:true}))=>acquireRoute(parseTaskSpec(args,{taskId:'fixture',requestId:'last-good-fixture'}),{env:safeEnv,root:new URL('../../',import.meta.url).pathname,
    readAccount,
    readBrowserRuntime:name=>({ready:true,why:`${name} fixture browser runtime ready`,checkedAt:Date.now()}),
    readClaude:()=>{throw Error('fixture timed-out usage');}});
  acquire(['computer-use','--apps','com.apple.calculator']); // remembers the good public reading
  const statusOnly=()=>({...good.codexAccounts[0],usage:null});
  const positive=acquire(['analysis','--fresh'],statusOnly);
  assert.equal(positive.snapshot.accounts.find(a=>a.id==='ttadk').quota[0].usage.sampledAt,at,'auth-only refresh cannot renew retained quota');
  fs.writeFileSync(safeCache,'{"checkedAt":');fs.mkdirSync(`${safeCache}.lock`);
  try {
    const retained=acquire(['computer-use','--apps','com.apple.calculator','--fresh']);
    const chosen=routePure(retained.task,retained.snapshot);
    assert.equal(chosen.kind,'launch');assert.equal(chosen.primary.candidate.accountId,'ttadk');
    assert.equal(retained.snapshot.accounts.find(a=>a.id==='ttadk').auth.source,'last-good-stale');
    assert.equal(retained.snapshot.accounts.find(a=>a.id==='ttadk').auth.sampledAt,positive.snapshot.accounts.find(a=>a.id==='ttadk').auth.sampledAt);
    const claude=acquire(['claude-tools','--fresh']);assert.equal(routePure(claude.task,claude.snapshot).kind,'launch');
    assert.equal(claude.snapshot.accounts.find(a=>a.id==='claude').auth.sampledAt,at);
    fs.writeFileSync(path.join(safeDir,'quota-limit.json'),JSON.stringify({kind:'daily',resetsAt:at+3600000}));
    const denied=acquire(['computer-use','--apps','com.apple.calculator','--fresh']);
    assert.equal(denied.snapshot.accounts.find(a=>a.id==='ttadk').providerDenied.value,true,'fallback cannot hide a newer provider denial');
    assert.notEqual(routePure(denied.task,denied.snapshot).kind,'launch');fs.rmSync(path.join(safeDir,'quota-limit.json'));
    assert.equal(fs.readFileSync(safeCache,'utf8'),'{"checkedAt":','routing never rewrites a locked/truncated quota cache');
  } finally {fs.rmdirSync(`${safeCache}.lock`);}
  fs.writeFileSync(safeCache,JSON.stringify({...good,claude:null,codexAccounts:[]}));
  const partial=acquire(['computer-use','--apps','com.apple.calculator']);
  assert.equal(routePure(partial.task,partial.snapshot).kind,'launch');
  const backupFile=`${safeCache}.routing-last-good.json`,old=JSON.parse(fs.readFileSync(backupFile));
  old.codexAccounts[0].seenAt=at-11*60000;old.codexAccounts[0].usageSeenAt=at-11*60000;old.claudeSeenAt=at-11*60000;old.checkedAt=at-11*60000;
  fs.writeFileSync(backupFile,JSON.stringify(old));
  const aged=acquire(['claude-tools','--fresh']);assert.equal(aged.snapshot.accounts.find(a=>a.id==='claude').auth.status,'UNKNOWN');
  assert.equal(routePure(aged.task,aged.snapshot).kind,'blocked','last-good fallback never renews expired authentication');
  const freshAuth=acquire(['analysis','--fresh'],statusOnly),freshTT=freshAuth.snapshot.accounts.find(a=>a.id==='ttadk');
  assert.equal(freshTT.auth.status,'KNOWN');assert.equal(freshTT.quota[0].usage.status,'UNKNOWN');
  fs.rmSync(`${safeCache}.routing-last-good.json`);
  const unknownClaude=acquire(['claude-tools','--fresh']);
  assert.equal(unknownClaude.snapshot.accounts.find(a=>a.id==='claude').auth.status,'UNKNOWN');
  assert.equal(unknownClaude.snapshot.accounts.find(a=>a.id==='ttadk').auth.status,'UNKNOWN');
  assert.ok(unknownClaude.snapshot.lanes.some(l=>l.accountId==='ttadk'),'declared TTADK harness remains present while its account state is UNKNOWN');
  const unresolved=routePure(unknownClaude.task,unknownClaude.snapshot);assert.equal(unresolved.kind,'blocked');
  assert.match(unresolved.reasons[0].text,/on claude:.*authentication/);
  console.log('ok   BC-38 truncated/locked/partial cache and failed probes retain last-good account readings with original age; absent Claude remains capable UNKNOWN');

  fs.writeFileSync(profiles, JSON.stringify(registry));
  fault = 'registry-lock'; fs.mkdirSync(`${profiles}.lock`);
  try {
    const blockedSave = readState({ fresh: true });
    assert.match(blockedSave.errors.registryWrite, /lock busy/);
    assert.equal(blockedSave.codexAccounts.length, 2);
    assert.equal(analyze(blockedSave).codex.ttadk.usable, true);
    assert.equal(analyze(blockedSave).codex.trae.usable, true);
  } finally { fs.rmdirSync(`${profiles}.lock`); }
  assert.ok(!fs.readdirSync(tmp).some((s) => s.endsWith('.lock') || /\.\d+$/.test(s)));
  console.log('ok   real 10-second registry-lock contention cannot cache absent company accounts');
  console.log('\nall pass');
} finally {
  childProcess.execFileSync = exec; fs.renameSync = rename; fs.existsSync = exists; syncBuiltinESMExports();
  fs.rmSync(tmp, { recursive: true, force: true });
}
