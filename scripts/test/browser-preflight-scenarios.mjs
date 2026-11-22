#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const scripts=new URL('../',import.meta.url).pathname;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'browser-preflight-'));
const plugin=path.join(tmp,'chrome'),bin=path.join(tmp,'bin'),capture=path.join(tmp,'rpc.jsonl');
fs.mkdirSync(path.join(plugin,'scripts'),{recursive:true});fs.mkdirSync(bin);
fs.writeFileSync(path.join(plugin,'scripts/browser-client.mjs'),'// fixture runtime');
fs.writeFileSync(path.join(plugin,'scripts/check-extension-installed.js'),`process.stdout.write(JSON.stringify({installed:process.env.EXTENSION_MODE!=='missing',enabled:process.env.EXTENSION_MODE!=='disabled'}));`);
fs.writeFileSync(path.join(bin,'pgrep'),`#!${process.execPath}\nprocess.exit(process.env.EXTENSION_MODE==='host-down'?1:0);\n`,{mode:0o755});
const profiles=path.join(tmp,'accounts.json');fs.writeFileSync(profiles,JSON.stringify({ttadk:{kind:'ttadk',home:tmp,hub:'ws://127.0.0.1:1',chromePlugin:plugin}}));
const preload=path.join(tmp,'preload.mjs');
const runtime=path.join(bin,'node_repl');fs.writeFileSync(runtime,'fixture runtime',{mode:0o700});
fs.writeFileSync(path.join(tmp,'config.toml'),`[mcp_servers.node_repl]\ncommand = ${JSON.stringify(runtime)}\n`);
fs.writeFileSync(preload,`import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const stat=fs.statSync;fs.statSync=(file,...args)=>file==='/Applications/ChatGPT.app'?{isDirectory:()=>true}:stat(file,...args);const real=cp.execFileSync;cp.execFileSync=(file,...args)=>file==='/usr/libexec/PlistBuddy'?'26.1115':real(file,...args);syncBuiltinESMExports();await import(${JSON.stringify(path.join(scripts,'test/fixtures/worker-events-transport.mjs'))});`);
const env={...process.env,HOME:tmp,RULES_SHARED:tmp,CODEX_ACCOUNTS:profiles,PATH:`${bin}:${process.env.PATH}`,ROUTE_LOG_FILE:path.join(tmp,'routes.jsonl'),
  WORKER_EVENTS_FIXTURE:JSON.stringify({rpc:capture}),NODE_OPTIONS:''};
const run=(mode,command='start',skip=false)=>{
  fs.writeFileSync(capture,'');const began=Date.now();
  const r=spawnSync(process.execPath,['--import',preload,path.join(scripts,'codex-worker.mjs'),'--account','ttadk',command,
    ...(command==='start'?['--cwd',tmp]:['--thread','thread-fixture']),'--effort','high','--model','fixture','--sandbox','read-only',
    '--browser-origins','example.com',...(skip?['--no-browser-preflight']:[]),'reply DONE'],{env:{...env,EXTENSION_MODE:mode},encoding:'utf8',timeout:6000});
  assert.ok(Date.now()-began<5000);return {...r,rpc:fs.readFileSync(capture,'utf8')};
};
try {
  for(const command of ['start','turn']) {
    const r=run('healthy',command);assert.equal(r.status,0,r.stderr);assert.match(r.rpc,/turn\/start/);
  }
  // The client only checks what it can see truthfully: Chrome running (the fake pgrep exits 1 in host-down mode).
  // Extension state is not probed from the client (it cannot read Chrome's profile on this Mac); the worker reports it.
  for(const mode of ['missing','disabled']) { const r=run(mode);assert.equal(r.status,0,r.stderr);assert.match(r.rpc,/turn\/start/); }
  { const r=run('host-down');assert.equal(r.status,1,r.stderr);assert.equal((r.stderr.match(/BLOCKED browser preflight/g)||[]).length,1);assert.match(r.stderr,/Google Chrome is not running/);assert.equal(r.rpc,''); }
  const skip=run('host-down','start',true);assert.equal(skip.status,0,skip.stderr);assert.match(skip.rpc,/turn\/start/);
  // The launcher, outside the worker sandbox, owns --out and the event log.
  // Read-only reports must use that channel; separate evidence files need writes.
  const out=path.join(tmp,'codex-last.md'),log=path.join(tmp,'task-evidence.jsonl');
  const report=spawnSync(process.execPath,['--import',preload,path.join(scripts,'codex-worker.mjs'),'--account','ttadk','start',
    '--cwd',tmp,'--effort','high','--model','fixture','--sandbox','read-only','--browser-origins','example.com',
    '--out',out,'--log',log,'Return the readiness report in your final message.'],{env:{...env,EXTENSION_MODE:'healthy'},encoding:'utf8',timeout:6000});
  assert.equal(report.status,0,report.stderr);assert.match(fs.readFileSync(out,'utf8'),/DONE fixture completed/);
  assert.ok(fs.statSync(log).size>0);assert.match(fs.readFileSync(capture,'utf8'),/"sandbox":"read-only"/);
  const status=spawnSync(process.execPath,['--import',preload,path.join(scripts,'codex-worker.mjs'),'--account','ttadk','status',
    '--thread','thread-fixture'],{env:{...env,EXTENSION_MODE:'healthy'},encoding:'utf8',timeout:6000});
  assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).browserRuntime.ready,true);
  console.log('PASS BC-12 browser preflight: Chrome not running blocks once before RPC; extension state is left to the worker; skip launches');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
