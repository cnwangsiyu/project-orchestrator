#!/usr/bin/env node
// Foreground supervisor with fake hub/proxy processes and local health only; no live account or install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { hubDirectory, HUB_LOG_LIMIT, readHubDiagnostics, readHubState, writeHubLog } from '../lib/hub-state.mjs';
import { formatReview, review } from '../resource-review.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-launchd-'));
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const live = new Set();
try {
  const out = path.join(tmp, 'plists');
  execFileSync(process.execPath, [path.join(root, 'render-hub-launchd.mjs'), '--out', out, '--home', tmp,
    '--node', process.execPath, '--skill', path.dirname(root)], { env: { ...process.env, HOME: tmp }, encoding: 'utf8' });
  for (const account of ['ttadk', 'trae', 'main', 'b']) {
    const file = path.join(out, `dev.project-orchestrator.hub.${account}.plist`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('<key>KeepAlive</key><true/>'));
    assert.ok(text.includes(`<string>--account</string><string>${account}</string><string>hub</string><string>--foreground</string>`));
    assert.ok(!/__[A-Z_]+__/.test(text));
    if (process.platform === 'darwin') execFileSync('plutil', ['-lint', file]);
  }
  const refused = spawnSync(process.execPath, [path.join(root, 'render-hub-launchd.mjs'), '--home', tmp,
    '--out', path.join(tmp, 'Library/LaunchAgents')], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.ok(!fs.existsSync(path.join(tmp, 'Library/LaunchAgents')));
  console.log('ok   four valid KeepAlive foreground account templates, explicit runtime paths, no automatic install');

  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  const marker = path.join(tmp, 'hub-ready'), starts = path.join(tmp, 'starts.jsonl'), proxyPid = path.join(tmp, 'proxy-pid');
  const worker = path.join(tmp, 'codex-worker.mjs');
  fs.writeFileSync(worker, `import fs from 'node:fs';
if(process.env.PROBE_HANG){setInterval(()=>{},1000);}else process.exit(fs.existsSync(process.env.HUB_MARKER)?0:1);`);
  const fakeHub = `#!/usr/bin/env node
const fs=require('fs');fs.appendFileSync(process.env.STARTS,JSON.stringify({bin:process.argv[1],args:process.argv.slice(2),pid:process.pid,codexHome:process.env.CODEX_HOME??null})+'\\n');
if(process.env.HUB_FAIL)process.exit(1);
if(process.env.HUB_PORT){require('net').createServer().listen(Number(process.env.HUB_PORT),'127.0.0.1');}
fs.writeFileSync(process.env.HUB_MARKER,String(process.pid));
process.on('SIGTERM',()=>{if(process.env.HUB_TERM_IGNORE)return;fs.rmSync(process.env.HUB_MARKER,{force:true});process.exit(0);});
if(process.env.HUB_DIE_MS)setTimeout(()=>{fs.rmSync(process.env.HUB_MARKER,{force:true});process.exit(1);},Number(process.env.HUB_DIE_MS));setInterval(()=>{},1000);`;
  for (const name of ['codex', 'traex']) fs.writeFileSync(path.join(bin, name), fakeHub, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'ttadk-search-proxy.mjs'), `import http from 'node:http';import fs from 'node:fs';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
fs.writeFileSync(process.env.PROXY_PID+'.args',JSON.stringify(process.argv.slice(2)));
const server=http.createServer((q,r)=>{r.end('ok');}).listen(port,'127.0.0.1',()=>fs.writeFileSync(process.env.PROXY_PID,String(process.pid)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const driver = path.join(tmp, 'driver.mjs');
  fs.writeFileSync(driver, `import {runHubForeground} from ${JSON.stringify(path.join(root, 'lib/hub-foreground.mjs'))};
const code=await runHubForeground({account:process.env.ACCOUNT,profile:JSON.parse(process.env.PROFILE||'{}'),hub:'ws://127.0.0.1:1',
script:${JSON.stringify(worker)},home:process.env.HOME,interval:30,...JSON.parse(process.env.OPTIONS||'{}')});process.exit(code);`);
  const env = { ...process.env, HOME: tmp, PATH: `${bin}:${process.env.PATH}`, HUB_MARKER: marker, STARTS: starts,
    PROXY_PID: proxyPid, CODEX_HOME: path.join(tmp, 'account-home') };
  const reset = () => { for (const file of [marker, starts, proxyPid]) fs.rmSync(file, { force: true }); };
  const start = (account, profile = {}, overrides = {}, options = {}) => {
    const child = spawn(process.execPath, [driver], { env: { ...env, ...overrides, ACCOUNT: account, PROFILE: JSON.stringify(profile), OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(child); child.once('exit', () => live.delete(child));
    let errors = ''; child.stderr.on('data', (part) => { errors += part; });
    child.stdout.resume(); return { child, exited: once(child, 'exit'), error: () => errors };
  };
  const waitFile = async (file, run) => {
    for (let i = 0; i < 100 && !fs.existsSync(file) && run.child.exitCode === null; i++) await tick(20);
    assert.ok(fs.existsSync(file), run.error()); await tick(100);
  };
  reset();
  let run = start('main'); await waitFile(marker, run);
  const hubPid = Number(fs.readFileSync(marker, 'utf8'));
  run.child.kill('SIGTERM'); assert.equal((await run.exited)[0], 0);
  assert.ok(!fs.existsSync(marker)); assert.throws(() => process.kill(hubPid, 0));
  console.log('ok   unreachable hub starts as an owned foreground child and stops with its supervisor');

  reset(); fs.writeFileSync(marker, 'external');
  run = start('b'); await tick(250);
  assert.equal(run.child.exitCode, null); assert.ok(!fs.existsSync(starts));
  run.child.kill('SIGTERM'); assert.equal((await run.exited)[0], 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'external');
  console.log('ok   successful empty-list probe retains reachable hub without restart/duplicate/kill');

  reset(); run = start('trae', { kind: 'trae', bin: path.join(bin, 'traex') }); await waitFile(marker, run);
  const details = JSON.parse(fs.readFileSync(starts, 'utf8').trim());
  assert.equal(details.codexHome, null); assert.ok(details.bin.endsWith('/traex'));
  process.kill(Number(fs.readFileSync(marker)), 'SIGKILL'); assert.equal((await run.exited)[0], 1);
  console.log('ok   TRAE uses its own binary/home; hub death exits nonzero for launchd KeepAlive');

  reset();
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((r) => server.close(r));
  run = start('ttadk', { kind: 'ttadk', searchPort: port, home: env.CODEX_HOME }); await waitFile(proxyPid, run); await waitFile(marker, run);
  const proxyArgs = JSON.parse(fs.readFileSync(proxyPid + '.args', 'utf8'));
  assert.equal(proxyArgs[proxyArgs.indexOf('--log') + 1], path.join(env.CODEX_HOME, 'search-proxy.log'));
  const ownedHub = Number(fs.readFileSync(marker)), ownedProxy = Number(fs.readFileSync(proxyPid));
  process.kill(ownedProxy, 'SIGKILL'); assert.equal((await run.exited)[0], 1);
  assert.throws(() => process.kill(ownedHub, 0));
  console.log('ok   TTADK proxy is managed with the hub; proxy death tears down owned hub for a clean KeepAlive restart');

  reset();
  run = start('main', {}, { HUB_TERM_IGNORE: '1' }); await waitFile(marker, run);
  const survivor = Number(fs.readFileSync(marker));
  run.child.kill('SIGTERM'); assert.equal((await run.exited)[0], 0);
  assert.throws(() => process.kill(survivor, 0));
  console.log('ok   owned TERM survivor receives SIGKILL escalation');

  fs.rmSync(path.join(hubDirectory(tmp), 'main.state.json'), { force: true }); reset();
  for (let attempt = 1; attempt <= 5; attempt++) {
    run = start('main', {}, { HUB_FAIL: '1' }, { baseBackoffMs: 15 });
    assert.equal((await run.exited)[0], 1);
    const state = readHubState(tmp, 'main');
    assert.equal(state.failures, attempt); assert.equal(state.mode, attempt === 5 ? 'BLOCKED' : 'BACKOFF');
    if (attempt < 5) {
      assert.equal(state.retryAt - state.t, Math.min(900000, 15 * 2 ** (attempt - 1)));
      await tick(Math.max(0, state.retryAt - Date.now()) + 20);
    }
  }
  const blockedStarts = fs.readFileSync(starts, 'utf8');
  run = start('main', {}, { HUB_FAIL: '1' }); await tick(300);
  assert.equal(run.child.exitCode, null); assert.equal(fs.readFileSync(starts, 'utf8'), blockedStarts);
  run.child.kill('SIGTERM'); assert.equal((await run.exited)[0], 0);
  console.log('ok   permanent failures persist exponential backoff then BLOCKED standby without a silent start loop');

  fs.rmSync(path.join(hubDirectory(tmp), 'main.state.json'), { force: true }); reset();
  for (let attempt = 1; attempt <= 2; attempt++) {
    run = start('main', {}, { HUB_DIE_MS: '250' }, { baseBackoffMs: 15 });
    assert.equal((await run.exited)[0], 1);
    const state = readHubState(tmp, 'main'); assert.equal(state.failures, attempt);
    await tick(Math.max(0, state.retryAt - Date.now()) + 20);
  }
  console.log('ok   short-lived ready hubs do not reset the consecutive-failure counter');

  reset();
  const bound = net.createServer(); bound.listen(0, '127.0.0.1'); await once(bound, 'listening');
  try {
    run = start('b', {}, { PROBE_HANG: '1', HUB_PORT: String(bound.address().port) }, { probeTimeoutMs: 150 });
    assert.equal((await run.exited)[0], 1);
    assert.equal(bound.listening, true); assert.equal(readHubState(tmp, 'b').mode, 'BACKOFF');
    const failedPid = JSON.parse(fs.readFileSync(starts, 'utf8').trim()).pid;
    assert.throws(() => process.kill(failedPid, 0));
  } finally { await new Promise((r) => bound.close(r)); }
  console.log('ok   hung-but-bound list probe races with bind failure without killing the unmanaged listener');

  writeHubLog(tmp, 'b', '12345678', true, 10); writeHubLog(tmp, 'b', 'abcdefgh', true, 10);
  const errLog = path.join(hubDirectory(tmp), 'b.err.log');
  assert.equal(fs.readFileSync(errLog, 'utf8'), 'abcdefgh');
  assert.equal(fs.statSync(errLog + '.1').size <= 10, true);
  writeHubLog(tmp, 'b', 'x'.repeat(20), true, 10);
  assert.equal(fs.statSync(errLog).size, 10); assert.equal(fs.statSync(errLog + '.1').size <= 10, true);
  fs.truncateSync(errLog, HUB_LOG_LIMIT + 1);
  const diagnostics = readHubDiagnostics(tmp);
  assert.equal(diagnostics.entries.find((e) => e.account === 'b').logs.find((l) => l.name === 'b.err.log').oversized, true);
  const report = formatReview(review([{ schema: 1, host: 'fixture', t: Date.now(), complete: true, hubSupervisors: diagnostics }]));
  assert.match(report, /Hub supervisor main:.*BACKOFF/); assert.match(report, /Hub log oversized: b.err.log/);
  assert.match(report, /tell global-rules owner/);
  writeHubLog(tmp, 'b', 'next error', true);
  assert.ok(fs.statSync(errLog).size <= HUB_LOG_LIMIT); assert.ok(fs.statSync(errLog + '.1').size <= HUB_LOG_LIMIT);
  writeHubLog(tmp, 'b', 'stdout', false, 10); writeHubLog(tmp, 'b', 'next stdout', false, 10);
  assert.ok(fs.statSync(path.join(hubDirectory(tmp), 'b.log')).size <= 10);
  assert.throws(() => writeHubLog(tmp, 'b', 'invalid', false, 0), /invalid hub log limit/);
  console.log('ok   stdout/stderr rotation stays bounded and nightly review surfaces backoff and oversized log metadata');
  console.log('\nall pass');
} finally {
  for (const child of live) child.kill('SIGTERM');
  if (live.size) await tick(300);
  for (const child of live) child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
