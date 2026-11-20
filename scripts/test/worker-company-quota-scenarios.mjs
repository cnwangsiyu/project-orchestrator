#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRequestedCompanyQuota } from '../lib/worker-company-quota.mjs';
import { refreshWorkerQuota } from '../lib/worker-quota-refresh.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-company-quota-'));
const priorShared = process.env.RULES_SHARED, priorCache = process.env.QUOTA_CACHE;
process.env.RULES_SHARED = tmp; process.env.QUOTA_CACHE = path.join(tmp, 'quota.json');
try {
  const now = Date.now(), calls = [];
  const profiles = { company: { kind: 'ttadk' }, other: { kind: 'trae' }, personal: { kind: 'chatgpt' } };
  fs.writeFileSync(process.env.QUOTA_CACHE, JSON.stringify({ checkedAt: now - 60000,
    codexAccounts: [{ name: 'company', kind: 'ttadk' }, { name: 'personal', kind: 'chatgpt', seenAt: 7 }] }));
  const result = readRequestedCompanyQuota({ accounts: ['company', 'company', 'personal'], profiles, now,
    execute: (bin, args, options) => {
      calls.push(args);
      assert.equal(bin, process.execPath);
      assert.deepEqual(args.slice(1), ['--account', 'company', 'usage']);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
      assert.doesNotMatch(args.join(' '), /auth\s+export|token|credential/i);
      return JSON.stringify({ quotas: [{ period: 'daily', used: 85, limit: 100, resetsAt: now + 3600000 }] });
    } });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.accounts, { company: 'ok', personal: 'unavailable' });
  const cache = JSON.parse(fs.readFileSync(process.env.QUOTA_CACHE, 'utf8'));
  assert.equal(cache.checkedAt, now - 60000);
  assert.equal(cache.codexAccounts.find(account => account.name === 'company').usageSeenAt, now);
  assert.equal(cache.codexAccounts.find(account => account.name === 'personal').seenAt, 7);
  assert.equal(readRequestedCompanyQuota({ accounts: ['company'], profiles, execute: () => '{}' }).accounts.company, 'unavailable');
  console.log('PASS only requested company usage is queried; numeric sampling leaves unrelated accounts and cache age unchanged');

  // Execute the real tick child against a cloned module tree. The old broad
  // refresher and any export invocation fail this contract at runtime.
  const scripts = path.join(tmp, 'scripts'), lib = path.join(scripts, 'lib');
  fs.mkdirSync(scripts);
  fs.cpSync(new URL('../lib', import.meta.url), lib, { recursive: true });
  const record = path.join(tmp, 'calls.jsonl');
  fs.writeFileSync(path.join(lib, 'state.mjs'), `export const readProfiles=()=>({company:{kind:'ttadk'},personal:{kind:'chatgpt'}});
    export const readState=()=>{throw Error('forbidden broad refresh/export path');};
    export const traeQuota=()=>null;
    export const selectDailyQuota=payload=>({usage:payload[0]??null});`);
  fs.writeFileSync(path.join(scripts, 'codex-worker.mjs'), `import fs from 'node:fs';
    const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(args)+'\\n');
    if(args.join(' ')!=='--account company usage')throw Error('forbidden command, including auth export');
    console.log(JSON.stringify({quotas:[{used:85,limit:100,resetsAt:${now + 3600000}}]}));`);
  const copied = await import(new URL('file://' + path.join(lib, 'worker-quota-refresh.mjs')));
  const child = await copied.refreshWorkerQuota({ accounts: ['company'], timeoutMs: 2000 });
  assert.equal(child.status, 'ok');
  assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse), [['--account', 'company', 'usage']]);
  assert.equal(typeof refreshWorkerQuota, 'function');
  console.log('PASS real tick child never reaches the broad refresher or credential-export command');
  console.log('all pass');
} finally {
  if (priorShared === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = priorShared;
  if (priorCache === undefined) delete process.env.QUOTA_CACHE; else process.env.QUOTA_CACHE = priorCache;
  fs.rmSync(tmp, { recursive: true, force: true });
}
