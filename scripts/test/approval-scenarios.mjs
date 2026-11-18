#!/usr/bin/env node
// approval.mjs: add from a route gate, route LAUNCHes with --user-ok, revoke blocks again, expiry enforced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url)), scripts = path.join(dir, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-')), file = path.join(tmp, 'route-approvals.json');
const now = Date.now(), snapshot = path.join(tmp, 'snapshot.json'), registry = path.join(tmp, 'accounts.json');
const sol = 'gpt-6.1-sol', efforts = ['medium', 'high', 'xhigh', 'max'];
fs.writeFileSync(registry, '{}');
fs.writeFileSync(snapshot, JSON.stringify({ schemaVersion: 'pipeline-v1', collectedFrom: now, collectedThrough: now, decisionAt: now,
  personalFallback: null, approvals: [], health: [], resources: { held: false, ownedReturned: true }, dependencies: [],
  accounts: [['ttadk', 'ttadk'], ['trae', 'trae'], ['main', 'chatgpt']].map(([id, kind]) => ({ id, kind, catalog: [sol],
    auth: true, transport: true, health: true, providerDenied: kind !== 'chatgpt', denialResetAt: now + 3600000, capabilities: {}, quota: [] })),
  models: [{ id: sol, efforts, capabilities: {}, largeOutput: true }],
  lanes: ['ttadk', 'trae', 'main'].map(accountId => ({ id: `${accountId}:${sol}`, accountId, modelId: sol, harness: 'hub',
    efforts, mode: 'standard', selectable: true, readyAt: now, capabilities: {} })) }));
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: registry, QUOTA_CACHE: path.join(tmp, 'quota.json'),
  ROUTE_NOW: String(now), ROUTE_SNAPSHOT_FILE: snapshot, ROUTE_APPROVAL_FILE: file, ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl'),
  QUOTA_LOG_FILE: path.join(tmp, 'quota-log.jsonl'), QUOTA_LOG: '0', TRAE_PROBE: '0' };
const run = (script, args) => {
  const raw = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  raw.approvals = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  raw.decisionAt = Date.now(); env.ROUTE_NOW = String(raw.decisionAt);
  fs.writeFileSync(snapshot, JSON.stringify(raw));
  return spawnSync(process.execPath, [path.join(scripts, script), ...args], { env, encoding: 'utf8', timeout: 120000 });
};
const A = ['implement', '--name', 'approval-probe', '--project', 'approval-test', '--cwd', tmp, '--task-dir', tmp, '--writes', '--impact', 'service',
  '--exclude-account', 'ttadk,trae,b'];
try {
  const before = run('route.mjs', A).stdout.split('\n')[0];
  assert.match(before, /^BLOCKED .* on main/);
  assert.equal(run('approval.mjs', ['add', '--account', 'main', '--ref', 'r1', '--until', new Date(Date.now() - 1000).toISOString(), '--', ...A]).status, 2, 'past --until refused');
  const add = run('approval.mjs', ['add', '--account', 'main', '--ref', 'test ref', '--until', new Date(Date.now() + 3600000).toISOString(), '--', ...A]);
  assert.equal(add.status, 0, add.stderr); const id = add.stdout.trim();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(saved.length, 1); assert.equal(saved[0].scopes[0].allowPersonalWithCompany, true);
  assert.match(run('route.mjs', [...A, '--user-ok', id]).stdout, /^LAUNCH .* on main/);
  assert.match(run('approval.mjs', ['list']).stdout, new RegExp(`LIVE\\t${id}`));
  assert.equal(run('approval.mjs', ['add', '--account', 'zz', '--ref', 'r', '--until', new Date(Date.now() + 3600000).toISOString(), '--', ...A]).status, 1, 'wrong account refused');
  assert.equal(run('approval.mjs', ['revoke', id]).status, 0);
  assert.match(run('route.mjs', [...A, '--user-ok', id]).stdout, /^BLOCKED /);
  // An explicit --astra decision survives a model catalog upgrade on this account.
  const raw = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  const addModel = model => {
    raw.accounts.find(a => a.id === 'main').catalog = [model];
    raw.models.push({ ...raw.models[0], id: model });
    raw.lanes.push({ ...raw.lanes.find(l => l.accountId === 'main'), modelId: model, id: `main:${model}` });
    fs.writeFileSync(snapshot, JSON.stringify(raw));
  };
  const hard = ['implement-hard', ...A.slice(1)];
  addModel('gpt-6-astra');
  const approved = run('approval.mjs', ['add', '--astra', '--account', 'main', '--ref', 'astra-decision',
    '--until', new Date(Date.now() + 3600000).toISOString(), '--', ...hard]);
  assert.equal(approved.status, 0, approved.stderr);
  addModel('gpt-6.2-astra');
  assert.match(run('route.mjs', [...hard, '--user-ok', approved.stdout.trim()]).stdout, /^LAUNCH .*gpt-6\.2-astra .* on main/);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const scope of legacy.find(a => a.id === approved.stdout.trim()).scopes) scope.models = ['gpt-6-astra'];
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.match(run('route.mjs', [...hard, '--user-ok', approved.stdout.trim()]).stdout, /^LAUNCH .*gpt-6\.2-astra .* on main/);
  console.log('PASS approval add from gate → LAUNCH, list, wrong account/past expiry refused, revoke blocks again');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
