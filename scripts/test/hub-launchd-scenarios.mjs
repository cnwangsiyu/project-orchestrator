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
  fs.writeFileSync(worker, `import fs from 'node:fs'; process.exit(fs.existsSync(process.env.HUB_MARKER)?0:1);`);
  const fakeHub = `#!/usr/bin/env node
const fs=require('fs');fs.appendFileSync(process.env.STARTS,JSON.stringify({bin:process.argv[1],args:process.argv.slice(2),pid:process.pid,codexHome:process.env.CODEX_HOME??null})+'\\n');
fs.writeFileSync(process.env.HUB_MARKER,String(process.pid));
process.on('SIGTERM',()=>{fs.rmSync(process.env.HUB_MARKER,{force:true});process.exit(0);});setInterval(()=>{},1000);`;
  for (const name of ['codex', 'traex']) fs.writeFileSync(path.join(bin, name), fakeHub, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'ttadk-search-proxy.mjs'), `import http from 'node:http';import fs from 'node:fs';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
const server=http.createServer((q,r)=>{r.end('ok');}).listen(port,'127.0.0.1',()=>fs.writeFileSync(process.env.PROXY_PID,String(process.pid)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const driver = path.join(tmp, 'driver.mjs');
  fs.writeFileSync(driver, `import {runHubForeground} from ${JSON.stringify(path.join(root, 'lib/hub-foreground.mjs'))};
const code=await runHubForeground({account:process.env.ACCOUNT,profile:JSON.parse(process.env.PROFILE||'{}'),hub:'ws://127.0.0.1:1',
script:${JSON.stringify(worker)},home:process.env.HOME,interval:30});process.exit(code);`);
  const env = { ...process.env, HOME: tmp, PATH: `${bin}:${process.env.PATH}`, HUB_MARKER: marker, STARTS: starts,
    PROXY_PID: proxyPid, CODEX_HOME: path.join(tmp, 'account-home') };
  const reset = () => { for (const file of [marker, starts, proxyPid]) fs.rmSync(file, { force: true }); };
  const start = (account, profile = {}) => {
    const child = spawn(process.execPath, [driver], { env: { ...env, ACCOUNT: account, PROFILE: JSON.stringify(profile) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  run = start('ttadk', { kind: 'ttadk', searchPort: port }); await waitFile(proxyPid, run); await waitFile(marker, run);
  const ownedHub = Number(fs.readFileSync(marker)), ownedProxy = Number(fs.readFileSync(proxyPid));
  process.kill(ownedProxy, 'SIGKILL'); assert.equal((await run.exited)[0], 1);
  assert.throws(() => process.kill(ownedHub, 0));
  console.log('ok   TTADK proxy is managed with the hub; proxy death tears down owned hub for a clean KeepAlive restart');
  console.log('\nall pass');
} finally {
  for (const child of live) child.kill('SIGTERM');
  if (live.size) await tick(300);
  for (const child of live) child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
