#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTaskSpec } from '../lib/pipeline/index.mjs';
import { routeFixture } from './helpers/route-fixture.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-route-scope-'));
const script = new URL('../route.mjs', import.meta.url).pathname;
const now = Date.now(), sites = 'https://example.com,https://example.test:8443';
const accounts = path.join(tmp, 'accounts.json'), quota = path.join(tmp, 'quota.json');
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: accounts, QUOTA_CACHE: quota,
  ROUTE_NOW: String(now), ROUTE_REQUEST_ID: 'browser-scope-fixture', ROUTE_LOG: '0',
  ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl') };
const run = args => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 10000 });
const route = args => {
  const result = run([...args, '--json']); assert.equal(result.status, 0, result.stderr);
  const view = JSON.parse(result.stdout); assert.equal(view.blocked, false, JSON.stringify(view.why));
  assert.equal(view.pick.account, 'ttadk'); return view;
};
const value = (args, flag) => args[args.indexOf(flag) + 1];
const parse = args => parseTaskSpec(args, { taskId: 'scope-fixture', requestId: 'scope-fixture' });
try {
  for (const category of ['browser', 'ui-browser']) {
    const result = run([category, '--json']);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.match(result.stderr, /usage: route\.mjs .*--browser-origins/);
  }
  assert.ok(!fs.existsSync(quota), 'missing sites fail before provider/state acquisition');
  assert.equal(run(['--help']).status, 0);
  assert.match(run(['--help']).stdout, /--browser-origins.*required/);
  assert.match(run(['--help']).stdout, /--computer-use-apps/);

  fs.writeFileSync(accounts, JSON.stringify({ ttadk: { kind: 'ttadk', home: tmp, browser: true, desktop: true, models: ['gpt-6.1-sol'] } }));
  fs.writeFileSync(quota, JSON.stringify({ checkedAt: now, claude: [{ used: 10, windowMins: 10080, resetsAt: now + 7 * 86400000 }],
    codexAccounts: [{ name: 'ttadk', kind: 'ttadk', home: tmp, healthy: true, live: true, seenAt: now, models: ['gpt-6.1-sol'],
      browser: true, desktop: true, windows: [], usage: { used: 1, limit: 500000000, resetsAt: now + 12 * 3600000 },
      browserRuntime: { ready: true, checkedAt: now, why: 'fixture browser runtime ready' } }] }));
  for (const category of ['browser', 'ui-browser']) {
    const view = route([category, '--browser-origins', sites]);
    assert.match(view.pick.command, /--browser-origins/);
    assert.ok(value(view.pick.workerArgs, '--browser-origins').includes('https://example.com'));
    assert.ok(value(view.pick.workerArgs, '--browser-origins').includes('https://example.test:8443'));
    const saved = JSON.parse(value(view.pick.workerArgs, '--route-args'));
    assert.equal(value(saved, '--browser-origins'), sites);
    const text = run([category, '--browser-origins', sites]);
    assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /launch: .*--browser-origins.*https:\/\/example\.com/);
  }
  const desktop = route(['computer-use', '--computer-use-apps', 'com.apple.Notes,com.apple.calculator']);
  assert.equal(value(desktop.pick.workerArgs, '--computer-use-apps'), 'com.apple.Notes,com.apple.calculator');
  assert.equal(value(JSON.parse(value(desktop.pick.workerArgs, '--route-args')), '--computer-use-apps'), 'com.apple.Notes,com.apple.calculator');
  assert.match(route(['browser', '--origins', 'example.com']).pick.command, /--browser-origins.*example\.com/);
  assert.deepEqual(parse(['computer-use', '--apps', 'com.apple.Notes']).allowedApps, ['com.apple.Notes']);
  assert.throws(() => parse(['browser', '--browser-origins', 'example.com', '--origins', 'example.test']), /only one/);
  assert.throws(() => parse(['analysis', '--browser-origins', 'example.com']), /browser tasks/);
  assert.throws(() => parse(['browser', '--computer-use-apps', 'com.apple.Notes']), /computer-use/);
  assert.equal(run(['browser', '--browser-origins', ',']).status, 2);
  const claude = JSON.parse(routeFixture(script, ['browser', '--browser-origins', sites, '--exclude-account', 'ttadk', '--json'],
    { env, dir: tmp, approve: true, timeout: 10000 }));
  assert.equal(claude.pick.vendor, 'claude'); assert.equal(claude.blocked, false);
  assert.match(claude.pick.command, /Allowed browser origins \(--browser-origins\)/);
  assert.ok(claude.pick.command.includes('https://example.com')); assert.ok(claude.pick.command.includes('https://example.test:8443'));
  assert.equal(value(claude.pick.routeArgs, '--browser-origins'), sites);
  console.log('PASS browser scope: early one-line usage error, CLI help, browser/UI launch and route args, desktop app scope, aliases and invalid input');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
