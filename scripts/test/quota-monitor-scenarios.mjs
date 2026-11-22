#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { probeHub, hubRPC } from '../lib/hub-state.mjs';
const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-monitor-'));
const sockets = new Set();
const server = http.createServer((req, res) => { res.end('healthy'); });
server.on('upgrade', (req, socket) => {
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let pending = Buffer.alloc(0);
  socket.on('data', data => {
    pending = Buffer.concat([pending, data]);
    for (;;) {
      if (pending.length < 2) return;
      let len = pending[1] & 127, offset = 2;
      if (len === 126) { if (pending.length < 4) return; len = pending.readUInt16BE(2); offset = 4; }
      const masked = !!(pending[1] & 128), mask = pending.subarray(offset, offset + (masked ? 4 : 0));
      offset += masked ? 4 : 0;
      if (pending.length < offset + len) return;
      const op = pending[0] & 15, payload = Buffer.from(pending.subarray(offset, offset + len));
      pending = pending.subarray(offset + len);
      if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
      if (masked) for (let n = 0; n < payload.length; n++) payload[n] ^= mask[n % 4];
      let row; try { row = JSON.parse(payload.toString()); } catch { continue; }
      if (row.id === undefined) continue;
      const result = row.method === 'thread/read' ? { thread: { turns: [{ status: 'inProgress' }] } } : { server: 'fixture' };
      const response = Buffer.from(JSON.stringify({ id: row.id, result }));
      socket.write(Buffer.concat([Buffer.from([0x81, response.length]), response]));
    }
  });
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const hub = `ws://127.0.0.1:${server.address().port}`;
  assert.equal((await probeHub({ home: tmp, account: 'main', hub })).state, 'up');
  assert.equal((await hubRPC(hub, 'thread/read', { threadId: 'fixture', includeTurns: true })).thread.turns[0].status, 'inProgress');
  console.log('PASS HTTP health and actual read-only WebSocket initialize/thread probe');

  const skill = path.join(tmp, 'skill'), bin = path.join(tmp, 'bin'), shared = path.join(tmp, '.claude/orchestrator/_shared');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(path.join(shared, 'hub-launchd'), { recursive: true });
  fs.cpSync(path.join(scripts, 'lib'), path.join(skill, 'scripts/lib'), { recursive: true });
  fs.cpSync(path.join(scripts, '../references'), path.join(skill, 'references'), { recursive: true });
  fs.copyFileSync(path.join(scripts, 'resource-policy.json'), path.join(skill, 'scripts/resource-policy.json'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "Current week (all models): 10%% used\\n"\n', { mode: 0o755 });
  const now = Date.now(), cache = path.join(tmp, 'quota.json'), profiles = path.join(tmp, 'profiles.json'), quotaLog = path.join(tmp, 'quota-log.jsonl');
  fs.writeFileSync(profiles, JSON.stringify({ main: { home: path.join(tmp, 'account'), hub: 'ws://127.0.0.1:1' } }));
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [], codexAccounts: [{ name: 'main', home: path.join(tmp, 'account'), live: false, windows: [] }], errors: {}, history: {} }));
  fs.writeFileSync(path.join(shared, 'hub-launchd/main.state.json'), JSON.stringify({ mode: 'HEALTHY', failures: 0, t: now + 1, retryAt: null, reason: 'NONE' }));
  const called = path.join(tmp, 'called.jsonl');
  fs.writeFileSync(path.join(skill, 'scripts/codex-worker.mjs'), `import fs from 'node:fs';\nif(process.env.USAGE_FAIL==='1')process.exit(1);\nawait new Promise(r=>setTimeout(r,25));\nfs.appendFileSync(${JSON.stringify(called)},JSON.stringify({t:Date.now()})+'\\n');\nconsole.log(JSON.stringify({buckets:{codex:{secondary:{usedPercent:15,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}}}}));`);
  const driver = path.join(tmp, 'driver.mjs');
  fs.writeFileSync(driver, `import {readState,now} from ${JSON.stringify(path.join(skill, 'scripts/lib/state.mjs'))};\nconsole.log(JSON.stringify({data:readState(),captureStartedAt:now}));`);
  const env = { ...process.env, HOME: tmp, RULES_SHARED: shared, PATH: `${bin}:${process.env.PATH}`, QUOTA_CACHE: cache,
    CODEX_ACCOUNTS: profiles, QUOTA_LOG_FILE: quotaLog, QUOTA_LOG: '1', TRAE_PROBE: '0' };
  const result = JSON.parse(execFileSync(process.execPath, [driver], { env, encoding: 'utf8' }));
  assert.equal(result.data.codexAccounts[0].live, true, 'HEALTHY transition invalidates recently cached unavailable reading');
  assert.equal(fs.readFileSync(called, 'utf8').trim().split('\n').length, 1);
  const snapshot = JSON.parse(fs.readFileSync(quotaLog, 'utf8').trim());
  const call = JSON.parse(fs.readFileSync(called, 'utf8').trim());
  assert.ok(snapshot.t >= call.t); assert.ok(snapshot.t > snapshot.captureStartedAt);
  assert.equal(result.data.checkedAt, snapshot.t);
  console.log('PASS BC-17 successful supervisor start refreshes cache; AU-6 quota timestamps use capture end');

  fs.copyFileSync(path.join(scripts, 'quota.mjs'), path.join(skill, 'scripts/quota.mjs'));
  const stale = { label: 'week', used: 10, windowMins: 10080, resetsAt: Date.now() + 86400000 };
  fs.writeFileSync(profiles, JSON.stringify({ main: { home: path.join(tmp, 'account'), hub, windows: [stale], seenAt: Date.now() - 2 * 86400000 } }));
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: Date.now(), claude: [], codexAccounts: [{ name: 'main', live: false, windows: [stale] }], errors: {}, history: {} }));
  const liveEvent = { id: 'active', runId: 'active', event: 'running', t: Date.now(), account: 'main', thread: 'active-thread', pid: process.pid, owner: 'quota-owner', model: 'fixture-model' };
  fs.writeFileSync(path.join(shared, 'worker-events.jsonl'), JSON.stringify(liveEvent) + '\n');
  const panel = JSON.parse((await promisify(execFile)(process.execPath, [path.join(skill, 'scripts/quota.mjs'), '--json'], { env: { ...env, USAGE_FAIL: '1' }, encoding: 'utf8' })).stdout);
  assert.equal(panel.hubs[0].state, 'up'); assert.equal(panel.codex[0].live, true); assert.equal(panel.codex[0].usageLive, false);
  assert.equal(panel.running.byAccount.main.length, 1);
  assert.equal(typeof panel.browserReadiness.main.ready,'boolean');
  assert.match(panel.browserReadiness.main.why,/main browser runtime/);
  assert.ok(panel.browserReadiness.main.checkedAt>=result.data.checkedAt);
  console.log('PASS quota keeps hub connectivity separate from stale usage and counts an active event while usage fails');

  console.log('\nall pass');
} finally {
  for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
