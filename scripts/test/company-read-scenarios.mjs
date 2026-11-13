#!/usr/bin/env node
// Synthetic company profiles and stubbed CLI calls only; never open a credential file or contact a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

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
  if (args[0] === 'models') return args.includes('--json') ? JSON.stringify({ models: [{ id: SOL }] })
    : JSON.stringify([{ id: SOL, availableAgents: ['codex'] }]);
  if (args.includes('usage')) {
    if (fault === 'malformed') return 'truncated usage JSON';
    throw Object.assign(Error('fixture usage failure'), { code: fault === 'timeouts' ? 'ETIMEDOUT' : 'EIO' });
  }
  if (args.includes('list')) return '';
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
  fs.writeFileSync(profiles, JSON.stringify(registry));
  const { readState, analyze, readProfiles } = await import('../lib/state.mjs');
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

  // Real router and quota entry points, with all provider I/O stubbed before they import state.mjs.
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
syncBuiltinESMExports();
`);
  const route = (args, state = missing, mode = 'unknown-both', registryText = JSON.stringify(registry)) => {
    fs.writeFileSync(profiles, registryText);
    fs.writeFileSync(cache, typeof state === 'string' ? state : JSON.stringify(state));
    const env = { ...process.env, HOME: tmp, COMPANY_READ_FAULT: mode, ROUTE_LOG: '0', ROUTE_RR: path.join(tmp, 'rr'),
      ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl') };
    return JSON.parse(exec(process.execPath, ['--import', preload, new URL('../route.mjs', import.meta.url).pathname,
      ...args, '--json', '--dry', '--mode', 'default'], { env, encoding: 'utf8', timeout: 10000 }));
  };
  const gate = (o) => o.needsUserOK.some((n) => /^personal quota:.*company account state unknown/.test(n));
  for (const args of [['analysis'], ['analysis', '--stakes', 'high'], ['image-gen'], ['claude-tools'], ['browser']]) {
    const o = route(args);
    assert.ok(o.pick, args.join(' ')); assert.ok(gate(o), args.join(' '));
    assert.ok(o.tellUser.some((n) => /check quota\.mjs --fresh/.test(n)));
    assert.ok(o.quota.some((n) => /company account state unknown/.test(n)));
  }
  const urgent = route(['analysis', '--urgent']);
  assert.ok(urgent.pick); assert.equal(gate(urgent), false);
  assert.ok(urgent.tellUser.some((n) => /quota\.mjs/.test(n)));
  const company = route(['analysis'], missing, 'unknown-ttadk');
  assert.equal(company.pick.account, 'trae'); assert.equal(gate(company), false);
  const second = route(['design'], missing, 'unknown-ttadk');
  assert.equal(second.pick.account, 'trae'); assert.equal(second.secondOpinion.vendor, 'claude');
  assert.ok(gate(second), 'unknown company state also gates a personal second opinion beside a company primary');
  for (const name of ['ttadk', 'trae']) {
    const single = route(['analysis'], missing, 'unknown-both', JSON.stringify({ [name]: registry[name] }));
    assert.ok(gate(single));
    assert.ok(single.needsUserOK.some((n) => n.includes(`${name}/${registry[name].kind}`)));
  }
  const repaired = route(['analysis'], missing, '');
  assert.equal(repaired.pick.account, 'ttadk'); assert.equal(gate(repaired), false);
  assert.ok(gate(route(['analysis'], '{"checkedAt":')));
  assert.equal(route(['analysis'], '{"checkedAt":', '').pick.account, 'ttadk');
  assert.ok(gate(route(['analysis'], missing, '', '{"ttadk":')));
  const corruptWithCache = route(['analysis'], recovered, '', '{"ttadk":');
  assert.ok(gate(corruptWithCache), 'a corrupt registry must not launch cached TTADK using the default personal home');
  assert.notEqual(corruptWithCache.pick.account, 'ttadk');
  assert.ok(gate(route(['analysis'], { ...missing, codexAccounts: null })));
  console.log('ok   real routing gates every unknown-state personal pick, honors --urgent, and prefers recovered/known company accounts');

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
