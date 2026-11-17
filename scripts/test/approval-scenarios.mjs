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
const env = { ...process.env, ROUTE_APPROVAL_FILE: file };
const run = (script, args) => spawnSync(process.execPath, [path.join(scripts, script), ...args], { env, encoding: 'utf8', timeout: 120000 });
const A = ['implement', '--name', 'approval-probe', '--project', 'approval-test', '--cwd', tmp, '--task-dir', tmp, '--writes', '--impact', 'service',
  '--exclude-account', 'ttadk,trae,b', '--failures', '1', '--failure-kind', 'infra'];
try {
  const before = run('route.mjs', A).stdout.split('\n')[0];
  if (!/^BLOCKED .* on main/.test(before)) { console.log(`SKIP route does not ask main for approval here: ${before}`); process.exit(0); }
  assert.equal(run('approval.mjs', ['add', '--account', 'main', '--ref', 'r1', '--until', new Date(Date.now() - 1000).toISOString(), '--', ...A]).status, 2, 'past --until refused');
  const add = run('approval.mjs', ['add', '--account', 'main', '--ref', 'test ref', '--until', new Date(Date.now() + 3600000).toISOString(), '--', ...A]);
  assert.equal(add.status, 0, add.stderr); const id = add.stdout.trim();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(saved.length, 1); assert.equal(saved[0].scopes[0].allowPersonalWithCompany, true);
  assert.match(run('route.mjs', [...A, '--user-ok', id]).stdout, /^LAUNCH .* on main/);
  assert.match(run('approval.mjs', ['list']).stdout, new RegExp(`LIVE\\t${id}`));
  assert.equal(run('approval.mjs', ['add', '--account', 'zz', '--ref', 'r', '--until', new Date(Date.now() + 3600000).toISOString(), '--', ...A]).status, 1, 'wrong account refused');
  assert.equal(run('approval.mjs', ['revoke', id]).status, 0);
  assert.match(run('route.mjs', [...A, '--user-ok', id]).stdout, /^BLOCKED /);
  console.log('PASS approval add from gate → LAUNCH, list, wrong account/past expiry refused, revoke blocks again');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
