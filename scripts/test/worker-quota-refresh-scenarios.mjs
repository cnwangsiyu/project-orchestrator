#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pollWorkerQuota, refreshWorkerQuota } from '../lib/worker-quota-refresh.mjs';
import { readEvents, eventLine } from '../lib/worker-events.mjs';
import { dailyWarningBuckets } from '../lib/worker-quota-warnings.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-quota-refresh-'));
const prior = process.env.RULES_SHARED; process.env.RULES_SHARED = tmp;
const now = Date.now(), owner = '053283ad-1bc8-5a31-ad44-d68e6b199eb6';
const profiles = { company: { kind: 'trae' }, personal: { kind: 'chatgpt' } };
const row = { owner, account: 'company', runId: 'one', thread: 'one', event: 'running', pid: process.pid };
const data = { checkedAt: now - 30 * 60000, codexAccounts: [{ name: 'company', kind: 'trae' }] };
const options = { owner, rows: [row], data, profiles, now, readSnapshot: () => data };
try {
  const file = path.join(tmp, 'shared-refresh.json'), calls = path.join(tmp, 'calls.txt');
  const driver = path.join(tmp, 'follower.mjs');
  const module = fileURLToPath(new URL('../lib/worker-quota-refresh.mjs', import.meta.url));
  fs.writeFileSync(driver, `import fs from 'node:fs';import {pollWorkerQuota} from ${JSON.stringify(module)};
    await pollWorkerQuota({...${JSON.stringify({ ...options, file })},refresh:async()=>{
      fs.appendFileSync(${JSON.stringify(calls)},'refresh\\n');await new Promise(resolve=>setTimeout(resolve,50));return {status:'ok'};
    },readSnapshot:()=>(${JSON.stringify(data)})});`);
  const follow = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => errors += chunk);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(errors)));
  });
  await Promise.all([follow(), follow()]);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
  let refreshed = 0;
  await pollWorkerQuota({ ...options, file, now: now + 9 * 60000, refresh: () => { refreshed++; return { status: 'ok' }; } });
  assert.equal(refreshed, 0);
  await pollWorkerQuota({ ...options, file, now: now + 10 * 60000, refresh: () => { refreshed++; return { status: 'ok' }; } });
  assert.equal(refreshed, 1);
  console.log('PASS stale snapshot starts only one refresh across two followers and throttles all processes for 10 minutes');

  const failedFile = path.join(tmp, 'failed.json');
  for (let i = 0; i < 4; i++) {
    const result = await pollWorkerQuota({ ...options, file: failedFile, now: now + i * 10 * 60000,
      refresh: async () => { throw Error('synthetic failed refresh'); } });
    assert.equal(result.status, 'failed');
  }
  const notes = readEvents().filter(row => row.text === 'quota warnings unavailable: refresh failing');
  assert.equal(notes.length, 1); assert.equal(notes[0].kind, 'info'); assert.equal(notes[0].wake, false);
  assert.match(eventLine(notes[0]), /^\[quota-warning\]/); assert.doesNotMatch(eventLine(notes[0]), /deliver|skip|finish/i);
  assert.equal(JSON.parse(fs.readFileSync(failedFile, 'utf8')).consecutiveFailures, 4);
  console.log('PASS refresh failure is harmless, and three consecutive failures produce one info note per owner/day');

  let forbidden = 0;
  for (const rows of [[], [{ ...row, account: 'personal' }], [{ ...row, event: 'finished' }]]) {
    const result = await pollWorkerQuota({ ...options, rows, file: path.join(tmp, 'unused.json'), refresh: () => { forbidden++; } });
    assert.equal(result.status, 'idle');
  }
  await pollWorkerQuota({ ...options, alive: () => false, file: path.join(tmp, 'dead.json'), refresh: () => { forbidden++; } });
  await pollWorkerQuota({ ...options, data: { ...data, checkedAt: now }, file: path.join(tmp, 'fresh.json'), refresh: () => { forbidden++; } });
  assert.equal(forbidden, 0);
  console.log('PASS no running company turn, dead follower, or fresh snapshot triggers no refresh');
  let numericRefreshes = 0;
  await pollWorkerQuota({ ...options, file: path.join(tmp, 'stale-numeric.json'),
    data: { checkedAt: now, codexAccounts: [{ name: 'company', kind: 'trae', quota: { sampledAt: now - 16 * 60000 } }] },
    refresh: () => { numericRefreshes++; return { status: 'ok' }; } });
  assert.equal(numericRefreshes, 1, 'fresh routing cache cannot hide a stale numeric quota sample');
  const staleTtadk = { checkedAt: now, codexAccounts: [{ name: 'company', kind: 'ttadk', usageSeenAt: now - 60 * 60000,
    usage: { used: 85, limit: 100, resetsAt: now + 3600000 } }] };
  assert.equal(dailyWarningBuckets(staleTtadk, now).length, 0);
  let ttadkRefreshes = 0;
  const ttadkResult = await pollWorkerQuota({ ...options, data: staleTtadk, profiles: { company: { kind: 'ttadk' } },
    file: path.join(tmp, 'stale-ttadk.json'), refresh: () => { ttadkRefreshes++; return { status: 'ok' }; } });
  assert.equal(ttadkResult.status, 'ok'); assert.equal(ttadkRefreshes, 1);
  staleTtadk.codexAccounts[0].usageSeenAt = now;
  assert.equal(dailyWarningBuckets(staleTtadk, now).length, 1);
  console.log('PASS last successful TTADK numeric timestamp controls warning admission and tick freshness');

  const unavailableFile = path.join(tmp, 'worker-quota-refresh.json');
  let unavailableReads = 0;
  const unavailableRefresh = () => { unavailableReads++; return { status: 'unavailable', accounts: { company: 'unavailable' } }; };
  for (let i = 0; i < 2; i++) {
    const result = await pollWorkerQuota({ ...options, file: unavailableFile, now: now + i * 10 * 60000,
      data: { ...data, errors: { codex: 'login required on unrelated account' } }, refresh: unavailableRefresh });
    assert.equal(result.status, 'unavailable');
  }
  assert.equal(unavailableReads, 1);
  assert.equal(readEvents().filter(row => row.text?.startsWith('quota warnings unavailable for company:')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(unavailableFile, 'utf8')).accounts.company, 'unavailable');
  const quotaCli = fileURLToPath(new URL('../quota.mjs', import.meta.url));
  const status = spawnSync(process.execPath, [quotaCli, '--running', '--json'], {
    env: { ...process.env, HOME: tmp, CODEX_ACCOUNTS: path.join(tmp, 'absent-accounts.json'), QUOTA_CACHE: path.join(tmp, 'absent-cache.json') },
    encoding: 'utf8', timeout: 5000 });
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).quotaRefresh.status, 'unavailable');
  console.log('PASS requested account unavailability produces one daily info note and never blocks another account by a global login error');

  const lib = path.join(tmp, 'lib');
  fs.cpSync(fileURLToPath(new URL('../lib', import.meta.url)), lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'state.mjs'), `export const readProfiles=()=>({});`);
  fs.writeFileSync(path.join(lib, 'worker-company-quota.mjs'), `process.on('SIGTERM',()=>{});
    export const readRequestedCompanyQuota=()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);return {status:'ok'};};`);
  const copied = await import(new URL('file://' + path.join(lib, 'worker-quota-refresh.mjs')));
  const start = Date.now(); assert.equal((await copied.refreshWorkerQuota({ timeoutMs: 60 })).status, 'failed');
  assert.ok(Date.now() - start < 2000);
  fs.writeFileSync(path.join(lib, 'worker-company-quota.mjs'), `export const readRequestedCompanyQuota=()=>({status:'ok',accounts:{company:'ok'}});`);
  assert.equal((await copied.refreshWorkerQuota({ timeoutMs: 2000, accounts: ['company'] })).status, 'ok');
  fs.writeFileSync(path.join(lib, 'worker-company-quota.mjs'), `export const readRequestedCompanyQuota=()=>({status:'unavailable',accounts:{company:'unavailable'}});`);
  assert.equal((await copied.refreshWorkerQuota({ timeoutMs: 2000, accounts: ['company'] })).status, 'unavailable');
  console.log('PASS company-only child boundary is noninteractive, timeout-bounded, and returns only account status enums');
  console.log('all pass');
} finally {
  if (prior === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = prior;
  fs.rmSync(tmp, { recursive: true, force: true });
}
