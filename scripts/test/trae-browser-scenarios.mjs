#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(path.dirname(base));
const worker = path.join(root, 'scripts', 'codex-worker.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-browser-test-'));
const home = path.join(tmp, 'home'), traeHome = path.join(home, '.trae');
fs.mkdirSync(traeHome, { recursive: true });
const tokenValue = 'fixture-playwright-extension-token-never-print';
const tokenFile = path.join(tmp, 'playwright-extension-token');
fs.writeFileSync(tokenFile, `${tokenValue}\n`, { mode: 0o600 });
const persistent = `[mcp_servers.playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--headless", "--isolated"]\n`;
const persistentFile = path.join(traeHome, 'traecli.toml');
fs.writeFileSync(persistentFile, persistent);
const profiles = path.join(tmp, 'profiles.json');
fs.writeFileSync(profiles, JSON.stringify({ trae: { kind: 'trae', home: traeHome, hub: 'ws://127.0.0.1:1', bin: '/fixture/traex',
  modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol' } } }));
const transport = path.join(tmp, 'transport.mjs');
fs.writeFileSync(transport, `import fs from 'node:fs';
globalThis.WebSocket=class { constructor(){setImmediate(()=>this.onopen?.());} close(){} send(raw){
const m=JSON.parse(raw);if(m.id==null)return;fs.appendFileSync(process.env.CAPTURE,JSON.stringify(m)+'\\n');
if(['thread/start','thread/resume'].includes(m.method)&&m.params.config?.mcp_servers?.playwright?.enabled){
 this.browser=true;this.status=process.env.MCP_MODE||'ready';
 const status=this.status==='delayed'?'starting':this.status;
 this.onmessage?.({data:JSON.stringify({method:'mcpServer/startupStatus/updated',params:{threadId:'fixture-thread',name:'playwright',status,failureReason:status==='failed'?'fixture startup failure':null}})});
 if(this.status==='delayed')setTimeout(()=>{this.status='ready';this.onmessage?.({data:JSON.stringify({method:'mcpServer/startupStatus/updated',params:{threadId:'fixture-thread',name:'playwright',status:'ready'}})});},100);
}
const result=m.method==='thread/start'?{thread:{id:'fixture-thread'}}:m.method==='turn/start'?{turn:{id:'fixture-turn'}}:
 m.method==='mcpServerStatus/list'?{data:[{name:'playwright',runtimeStatus:this.status==='delayed'?'starting':this.status,tools:{browser_navigate:{},browser_snapshot:{}}}]}:{};
setImmediate(()=>{if(m.method==='turn/start'&&this.browser&&this.status!=='ready')throw Error('turn sent before MCP ready');
this.onmessage?.({data:JSON.stringify({id:m.id,result})});if(m.method==='turn/start')setImmediate(()=>this.onmessage?.({data:JSON.stringify({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed',items:[{type:'agentMessage',text:'DONE fixture'}]}}})}));});}};
`);
const fakeBin=path.join(tmp,'bin');fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin,'npx'), `#!${process.execPath}
let rest='';process.stdin.on('data',chunk=>{rest+=chunk;let end;while((end=rest.indexOf('\\n'))>=0){const m=JSON.parse(rest.slice(0,end));rest=rest.slice(end+1);if(m.id&&process.env.PREFLIGHT_MODE!=='hang')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.id===2?{isError:process.env.PREFLIGHT_MODE==='fail',content:[]}:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})+'\\n');}});
`,{mode:0o755});
fs.writeFileSync(path.join(fakeBin, 'pgrep'), `#!${process.execPath}\nprocess.exit(process.env.CHROME_DOWN === '1' ? 1 : 0);\n`, { mode: 0o755 });
const baseEnv = { ...process.env, RULES_SHARED:tmp, PATH:`${fakeBin}:${process.env.PATH}`, HOME: home, CODEX_ACCOUNTS: profiles, PLAYWRIGHT_EXTENSION_TOKEN_FILE: tokenFile,
  ROUTE_LOG_FILE: path.join(tmp, 'route-log.jsonl'), ORCHESTRATOR_WORKER_EVENTS: path.join(tmp, 'worker-events.jsonl') };
const run = (capture, args, env = {}) => {
  fs.writeFileSync(capture, '');
  const result = spawnSync(process.execPath, ['--import', transport, worker, '--account', 'trae', ...args], {
    cwd: root, env: { ...baseEnv, CAPTURE: capture, ...env }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rpc = fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return { result, rpc, start: rpc.find((m) => m.method === 'thread/start')?.params };
};

let fail = 0;
try {
  const capture = path.join(tmp, 'browser-rpc.jsonl');
  const { result, rpc, start } = run(capture, ['start', '--cwd', tmp, '--effort', 'high', '--sandbox', 'read-only',
    '--model', 'gpt-6.1-sol', '--name', 'fixture-browser', '--log', path.join(tmp, 'browser-log.jsonl'),
    '--browser-origins', 'https://example.com/path,*.bytedance.net,localhost', 'reply DONE']);
  const server = start.config.mcp_servers.playwright;
  assert.equal(server.enabled, true);
  // The hub runs our launcher (node + playwright-extension-mcp.mjs); the launcher alone reads the token file.
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /scripts\/playwright-extension-mcp\.mjs$/);
  assert.deepEqual(server.args.slice(1, 3), ['--profile-dir-name', 'Profile 1']);
  assert.equal(server.args.length, 3, 'no --allowed-origins: Playwright cannot express host globs and blocks page subrequests');
  const howToScope = start.developerInstructions;
  for (const expected of ['https://example.com/path', '*.bytedance.net', 'localhost']) assert.ok(howToScope.includes(expected), expected);
  assert.equal(server.env_vars, undefined, 'the token must not depend on the hub environment');
  assert.equal(server.env, undefined);
  assert.equal(start.approvalsReviewer, undefined);
  const howTo = start.developerInstructions.split('\nGlobal worker rules ')[0];
  for (const tool of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_take_screenshot']) assert.match(howTo, new RegExp(tool));
  assert.doesNotMatch(howTo, /mcp__claude-in-chrome__/); assert.doesNotMatch(howTo, /node_repl/);
  const visible = [result.stdout, result.stderr, JSON.stringify(rpc), fs.readFileSync(capture, 'utf8'),
    fs.existsSync(path.join(tmp, 'browser-log.jsonl')) ? fs.readFileSync(path.join(tmp, 'browser-log.jsonl'), 'utf8') : '',
    fs.readFileSync(persistentFile, 'utf8')].join('\n');
  assert.ok(!visible.includes(tokenValue), 'token value appeared in launcher output/config/log');
  assert.equal(fs.readFileSync(persistentFile, 'utf8'), persistent, 'persistent headless config changed');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  console.log('ok   TRAE browser start uses per-thread extension Playwright, translated origins, launcher-read token file and TRAE-specific instructions');
} catch (e) { fail++; console.log(`FAIL TRAE browser start: ${e.stack}`); }

try {
  const capture = path.join(tmp, 'plain-rpc.jsonl');
  const { result, rpc, start } = run(capture, ['start', '--cwd', tmp, '--effort', 'high', '--sandbox', 'read-only',
    '--model', 'gpt-6.1-sol', '--name', 'fixture-plain', '--log', path.join(tmp, 'plain-log.jsonl'), 'reply DONE']);
  assert.equal(start.config.mcp_servers.playwright.enabled, false);
  assert.equal(start.config.mcp_servers.playwright.command, 'npx', 'disabled servers still need a transport on fresh homes');
  assert.ok(rpc.filter((m) => m.method === 'thread/resume').every((m) => m.params.config.mcp_servers.playwright.enabled === false));
  assert.doesNotMatch(start.developerInstructions.split('Global worker rules ')[0], /Playwright Extension|browser_navigate|node_repl/);
  assert.match(start.developerInstructions,/For TRAE signed-in browser tasks:.*configured origins/);
  assert.equal(fs.readFileSync(persistentFile, 'utf8'), persistent);
  assert.ok(![result.stdout, result.stderr, JSON.stringify(rpc)].join('\n').includes(tokenValue));
  console.log('ok   non-browser TRAE start and setup resume disable Playwright without changing persistent config');
} catch (e) { fail++; console.log(`FAIL non-browser TRAE start: ${e.stack}`); }

try {
  for (const [category, origins, expected] of [
    ['analysis', null, false], ['build-run', null, false], ['review', null, false], ['docs', null, false],
    ['browser', 'https://example.com', true], ['ui-browser', 'http://localhost:8787', true],
    ['analysis', 'https://example.com', true],
  ]) {
    const capture = path.join(tmp, `${category}-${origins ? 'origins' : 'plain'}-rpc.jsonl`);
    const { start } = run(capture, ['start', '--cwd', tmp, '--effort', 'high', '--sandbox', 'read-only',
      '--model', 'gpt-6.1-sol', '--route-args', JSON.stringify([category]),
      ...(origins ? ['--browser-origins', origins] : []), 'reply DONE'],
      category === 'ui-browser' ? { CHROME_DOWN: '1', PLAYWRIGHT_EXTENSION_TOKEN_FILE: path.join(tmp, 'missing') } : {});
    const server = start.config.mcp_servers.playwright;
    assert.equal(server.enabled, expected, category);
    if (category === 'ui-browser') {
      assert.equal(server.command, 'npx');
      assert.deepEqual(server.args, ['-y', '@playwright/mcp@latest', '--browser', 'chrome', '--headless', '--isolated']);
      assert.match(start.developerInstructions.split('Global worker rules ')[0], /public\/local UI checks/);
      assert.doesNotMatch(start.developerInstructions.split('Global worker rules ')[0], /node_repl|Playwright Extension/);
    } else if (expected) assert.match(server.args[0], /playwright-extension-mcp\.mjs$/);
    const { rpc, result } = run(capture, ['turn', '--thread', 'fixture-thread', '--effort', 'high', '--model', 'gpt-6.1-sol', 'reply DONE'],
      category === 'ui-browser' ? { CHROME_DOWN: '1', PLAYWRIGHT_EXTENSION_TOKEN_FILE: path.join(tmp, 'missing') } : {});
    assert.match(result.stdout, /inherited:/);
    assert.deepEqual(rpc.find((m) => m.method === 'thread/resume').params.config.mcp_servers.playwright, server, `${category} continuation`);
  }
  // Secondary seats have routed metadata but no primary --route-args.
  const { start } = run(path.join(tmp, 'secondary-ui.jsonl'), ['start', '--cwd', tmp, '--effort', 'high', '--sandbox', 'read-only',
    '--model', 'gpt-6.1-sol', '--routed-seat', JSON.stringify({ category: 'ui-browser' }), 'reply DONE']);
  assert.equal(start.config.mcp_servers.playwright.enabled, true);
  assert.ok(start.config.mcp_servers.playwright.args.includes('--headless'));
  const { rpc } = run(path.join(tmp, 'secondary-ui-turn.jsonl'), ['turn', '--thread', 'fixture-thread', '--effort', 'high', '--model', 'gpt-6.1-sol', 'reply DONE']);
  assert.deepEqual(rpc.find((m) => m.method === 'thread/resume').params.config.mcp_servers.playwright, start.config.mcp_servers.playwright);
  console.log('ok   route categories and explicit browser flags select the MCP mode; primary and secondary turns inherit it');
} catch (e) { fail++; console.log(`FAIL MCP routing and inheritance: ${e.stack}`); }

try {
  // Setup only sees this synthetic home; all external subprocesses are replaced before worker imports.
  const setupHome = path.join(tmp, 'setup-home'), setupConfig = path.join(setupHome, '.trae', 'traecli.toml');
  fs.mkdirSync(path.dirname(setupConfig), { recursive: true });
  const preload = path.join(tmp, 'setup-preload.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
cp.execFileSync=(bin,args)=>{if(bin==='/bin/zsh')return '/fixture/traex\\n';if(bin==='/bin/sh')return 'Logged in\\n';if(bin==='/fixture/traex'&&args[0]==='models')return 'GPT-6.1-Sol\\n';if(bin==='/fixture/traex'&&args[0]==='plugin'&&args[1]==='list')return '';throw Error('fixture forbids external subprocess: '+bin);};syncBuiltinESMExports();`);
  const setup = (flags = []) => {
    const r = spawnSync(process.execPath, ['--import', preload, worker, 'trae-setup', ...flags], {
      env: { ...baseEnv, HOME: setupHome, CODEX_ACCOUNTS: path.join(tmp, 'setup-accounts.json') }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return fs.readFileSync(setupConfig, 'utf8');
  };
  const fresh = setup();
  assert.doesNotMatch(fresh, /\[mcp_servers\.playwright\]|playwright MCP \(codex-worker trae-setup\)/);
  assert.match(fresh, /network_access = true/);
  const optedIn = setup(['--headless-playwright']);
  assert.match(optedIn, /\[mcp_servers\.playwright\]/);
  assert.match(optedIn, /"--headless", "--isolated"/);
  assert.equal(setup(['--headless-playwright']), optedIn, 'opt-in setup is idempotent');
  // The old managed block also held the network and pet settings; migrate those into their own managed block.
  const pet = path.join(setupHome, '.agents', 'skills', 'hatch-pet', 'SKILL.md');
  fs.mkdirSync(path.dirname(pet), { recursive: true }); fs.writeFileSync(pet, 'fixture');
  const custom = '# custom setting\n[mcp_servers.other]\ncommand = "fixture-other"\n';
  const legacy = `${custom}\n# --- playwright MCP (codex-worker trae-setup) ---\n[mcp_servers.playwright]\ncommand = "npx"\n[sandbox_workspace_write]\nnetwork_access = true\n# --- end playwright MCP ---\n`;
  fs.writeFileSync(setupConfig, legacy);
  const removed = setup(['--no-headless-playwright']);
  assert.doesNotMatch(removed, /\[mcp_servers\.playwright\]/);
  assert.ok(removed.includes(custom));
  assert.equal((removed.match(/\[sandbox_workspace_write\]/g) ?? []).length, 1);
  assert.match(removed, /\[\[skills.config\]\][\s\S]*enabled = false/);
  assert.equal(setup(['--no-headless-playwright']), removed, 'migration is idempotent');
  const backups = fs.readdirSync(path.dirname(setupConfig)).filter((name) => name.includes('.bak-worker-'));
  assert.ok(backups.some((name) => fs.readFileSync(path.join(path.dirname(setupConfig), name), 'utf8') === legacy));
  fs.writeFileSync(setupConfig, legacy);
  assert.doesNotMatch(setup(), /\[mcp_servers\.playwright\]/, 'default setup also removes an old managed block');
  console.log('ok   fixture-only trae-setup defaults to per-thread MCP, supports global opt-in, and removes/backups legacy blocks');
} catch (e) { fail++; console.log(`FAIL trae-setup defaults: ${e.stack}`); }

try {
  const capture=path.join(tmp,'blocked-rpc.jsonl');
  const args=['--import',transport,worker,'--account','trae','start','--cwd',tmp,'--effort','high','--sandbox','read-only','--model','gpt-6.1-sol','--browser-origins','example.com','reply DONE'];
  // Client-side preflight is "Chrome is running" + the pairing file; a fake pgrep makes it deterministic.
  const fakeBin=path.join(tmp,'fake-bin');fs.mkdirSync(fakeBin,{recursive:true});
  fs.writeFileSync(path.join(fakeBin,'pgrep'),`#!${process.execPath}\nprocess.exit(process.env.CHROME_DOWN==='1'?1:0);\n`,{mode:0o755});
  const withBin={...baseEnv,PATH:`${fakeBin}:${process.env.PATH}`};
  {
    fs.writeFileSync(capture,'');const began=Date.now();
    const r=spawnSync(process.execPath,args,{env:{...withBin,CAPTURE:capture,CHROME_DOWN:'1'},encoding:'utf8',timeout:7000});
    assert.equal(r.status,1,r.stderr);assert.equal((r.stderr.match(/BLOCKED/g)||[]).length,1);assert.match(r.stderr,/Google Chrome is not running/);
    assert.equal(fs.readFileSync(capture,'utf8'),'','no hub RPC on failed preflight');assert.ok(Date.now()-began<5000);
    fs.writeFileSync(capture,'');
    const ok=spawnSync(process.execPath,args,{env:{...withBin,CAPTURE:capture},encoding:'utf8',timeout:7000});
    assert.equal(ok.status,0,ok.stderr);assert.match(fs.readFileSync(capture,'utf8'),/thread\/start/);
  }
  const skip=spawnSync(process.execPath,[...args.slice(0,-1),'--no-browser-preflight',args.at(-1)],{env:{...withBin,CAPTURE:capture,CHROME_DOWN:'1'},encoding:'utf8',timeout:5000});
  assert.equal(skip.status,0,skip.stderr);assert.match(fs.readFileSync(capture,'utf8'),/thread\/start/);
  fs.writeFileSync(capture,'');const missing=spawnSync(process.execPath,args,{env:{...baseEnv,CAPTURE:capture,PLAYWRIGHT_EXTENSION_TOKEN_FILE:path.join(tmp,'missing')},encoding:'utf8',timeout:5000});
  assert.equal(missing.status,1);assert.match(missing.stderr,/BLOCKED browser preflight.*pairing file is missing/);assert.equal(fs.readFileSync(capture,'utf8'),'');
  console.log('ok   TRAE preflight: Chrome down or missing pairing blocks once before RPC; explicit skip launches');
} catch(e){fail++;console.log(`FAIL browser preflight: ${e.stack}`);}
try {
  for (const command of ['start', 'turn']) for (const mode of ['delayed', 'failed', 'starting']) {
    const capture = path.join(tmp, `${command}-${mode}-rpc.jsonl`); fs.writeFileSync(capture, '');
    const r = spawnSync(process.execPath, ['--import', transport, worker, '--account', 'trae', command,
      ...(command === 'start' ? ['--cwd', tmp] : ['--thread', 'fixture-thread']),
      '--effort', 'high', '--sandbox', 'read-only', '--browser-origins', 'example.com', 'reply DONE'],
      {env:{...baseEnv,CAPTURE:capture,MCP_MODE:mode,CODEX_WORKER_MCP_READY_TIMEOUT_MS:'300'},encoding:'utf8',timeout:5000});
    const rpc = fs.readFileSync(capture, 'utf8');
    assert.equal(r.status, mode === 'delayed' ? 0 : 1, r.stderr);
    if (mode === 'delayed') assert.match(rpc, /turn\/start/);
    else { assert.doesNotMatch(rpc, /turn\/start/); assert.match(r.stderr, /BLOCKED browser preflight: MCP playwright/); }
  }
  const capture = path.join(tmp, 'health-rpc.jsonl');
  const {result,rpc} = run(capture, ['browser-health']);
  assert.equal(JSON.parse(result.stdout).traeBrowser, true);
  assert.ok(!rpc.some(m=>m.method==='turn/start'));
  assert.ok(rpc.some(m=>m.method==='thread/unsubscribe'));
  console.log('ok   TRAE start/resume wait for delayed MCP readiness, block failed/stuck startup, and probe health without a model turn');
} catch(e){fail++;console.log(`FAIL MCP startup readiness: ${e.stack}`);}
process.exitCode = fail ? 1 : 0;
