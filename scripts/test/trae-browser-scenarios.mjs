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
const result=m.method==='thread/start'?{thread:{id:'fixture-thread'}}:m.method==='turn/start'?{turn:{id:'fixture-turn'}}:{};
setImmediate(()=>{this.onmessage?.({data:JSON.stringify({id:m.id,result})});if(m.method==='turn/start')setImmediate(()=>this.onmessage?.({data:JSON.stringify({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed',items:[{type:'agentMessage',text:'DONE fixture'}]}}})}));});}};
`);
const baseEnv = { ...process.env, HOME: home, CODEX_ACCOUNTS: profiles, PLAYWRIGHT_EXTENSION_TOKEN_FILE: tokenFile,
  ROUTE_LOG_FILE: path.join(tmp, 'route-log.jsonl'), ORCHESTRATOR_WORKER_EVENTS: path.join(tmp, 'worker-events.jsonl') };
const run = (capture, args) => {
  fs.writeFileSync(capture, '');
  const result = spawnSync(process.execPath, ['--import', transport, worker, '--account', 'trae', ...args], {
    cwd: root, env: { ...baseEnv, CAPTURE: capture }, encoding: 'utf8', timeout: 10000,
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
  // The hub runs our launcher (node + playwright-extension-mcp.mjs); the launcher alone reads the token file.
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /scripts\/playwright-extension-mcp\.mjs$/);
  assert.deepEqual(server.args.slice(1, 3), ['--profile-dir-name', 'Profile 1']);
  assert.equal(server.args[3], '--allowed-origins');
  const origins = server.args[4].split(';');
  for (const expected of ['https://example.com', 'http://*.bytedance.net:*', 'https://*.bytedance.net:*',
    'http://bytedance.net:*', 'https://bytedance.net:*', 'http://localhost:*', 'https://localhost:*']) assert.ok(origins.includes(expected), expected);
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
  assert.equal(start.config, undefined);
  assert.doesNotMatch(start.developerInstructions, /Playwright Extension|browser_navigate|node_repl/);
  assert.equal(fs.readFileSync(persistentFile, 'utf8'), persistent);
  assert.ok(![result.stdout, result.stderr, JSON.stringify(rpc)].join('\n').includes(tokenValue));
  console.log('ok   non-browser TRAE start leaves the persistent headless Playwright default untouched');
} catch (e) { fail++; console.log(`FAIL non-browser TRAE start: ${e.stack}`); }

process.exitCode = fail ? 1 : 0;
