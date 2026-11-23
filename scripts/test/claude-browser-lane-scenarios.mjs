#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routeFixture } from './helpers/route-fixture.mjs';
import { parseTaskSpec, deriveReview } from '../lib/pipeline/index.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-lane-'));
const script = new URL('../route.mjs', import.meta.url).pathname, now = Date.now();
const accounts = path.join(tmp, 'accounts.json'), quota = path.join(tmp, 'quota.json');
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, CODEX_ACCOUNTS: accounts, QUOTA_CACHE: quota,
  ROUTE_NOW: String(now), ROUTE_REQUEST_ID: 'claude-browser-lane', ROUTE_LOG: '0', ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl') };
const base = { checkedAt: now, claude: [{ used: 10, windowMins: 10080, resetsAt: now + 7 * 86400000 }], codexAccounts: [
  { name: 'ttadk', kind: 'ttadk', home: tmp, healthy: true, live: true, seenAt: now, models: ['gpt-6.1-sol'],
    browser: true, windows: [], usage: { used: 1, limit: 500000000, resetsAt: now + 12 * 3600000 },
    browserRuntime: { ready: true, checkedAt: now, why: 'fixture browser runtime ready' } }] };
const route = (extra = [], cache = base, approve = true) => {
  fs.writeFileSync(quota, JSON.stringify(cache));
  return JSON.parse(routeFixture(script, ['browser', '--browser-origins', 'https://example.test',
    '--exclude-account', 'ttadk', ...extra, '--json'], { env, dir: tmp, approve, timeout: 10000 }));
};
const launchArgs = view => {
  const result = spawnSync('python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.stdin.read())))'],
    { input: view.pick.command, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(result.stdout), at = args.findIndex((arg, i) => arg === 'claude' && args[i + 1] === '--bg');
  assert.ok(at >= 0, 'the printed command includes the actual Claude background launch'); return args.slice(at);
};
const value = (args, flag) => args[args.indexOf(flag) + 1];
const check = (view, model, effort) => {
  assert.equal(view.blocked, false, JSON.stringify(view.why)); assert.equal(view.pick.vendor, 'claude');
  assert.equal(view.pick.model, model); assert.equal(view.pick.effort, effort);
  const args = launchArgs(view);
  for (const flag of ['--bg', '--remote-control', '--chrome']) assert.ok(args.includes(flag));
  assert.equal(value(args, '--permission-mode'), 'bypassPermissions');
  assert.equal(value(args, '--model'), model); assert.equal(value(args, '--effort'), effort);
  assert.match(view.pick.command, /launch-audit\.mjs/); assert.match(view.pick.command, /launch-claude-worker\.mjs/);
};
try {
  fs.writeFileSync(accounts, JSON.stringify({ ttadk: { kind: 'ttadk', home: tmp, browser: true, models: ['gpt-6.1-sol'] } }));
  const blocked = route([], base, false);
  assert.equal(blocked.blocked, true); assert.equal(blocked.pick.command, null, 'personal quota still needs a scoped decision');
  for (const flags of [[], ['--browser-kind', 'page'], ['--stakes', 'high'], ['--stakes', 'low'], ['--background'], ['--auto-check']])
    check(route(flags), 'sonnet', 'medium');
  check(route(['--failure-kind', 'tool', '--failures', '1', '--actual', 'codex:gpt-6.1-sol:xhigh@ttadk']), 'sonnet', 'medium');
  console.log('PASS Claude page lane: reroute after missing Codex browser, full Chrome/background/Bypass launch, fixed Sonnet medium and quota gate');
  for (const flags of [['--browser-kind', 'poll'], ['--browser-kind', 'poll', '--stakes', 'high'], ['--browser-kind', 'poll', '--background']]) {
    const view = route(flags); check(view, 'haiku', 'low');
    assert.equal(value(view.pick.routeArgs, '--browser-kind'), 'poll');
    assert.equal(view.plan.task.browserKind, 'poll'); assert.match(view.pick.command, /Only re-read the page and report status changes/);
  }
  const unavailable = route(['--exclude-lane', 'claude:sonnet']);
  assert.equal(unavailable.blocked, true); assert.notEqual(unavailable.pick?.model, 'opus');
  const failedQuality = route(['--failure-kind', 'quality', '--failures', '1', '--actual', 'claude:opus:high@claude']);
  assert.equal(failedQuality.blocked, true, 'real prior quality floors still apply'); assert.notEqual(failedQuality.pick?.model, 'opus');
  console.log('PASS Claude poll lane: fixed Haiku low, saved kind, no Opus substitution and prior quality floors preserved');
  for (const args of [['browser', '--browser-kind', 'other'], ['analysis', '--browser-kind', 'poll'],
    ['browser', '--browser-kind', 'poll', '--writes']]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2); assert.match(result.stderr, /browser-kind/);
  }
  const task = parseTaskSpec(['browser', '--browser-origins', 'example.test', '--browser-kind', 'page', '--review-class', 'A',
    '--review-reason', 'external version review'], { taskId: 'browser-review-fixture', requestId: 'browser-review-fixture' });
  const reviewer = deriveReview(task);
  assert.equal(reviewer.category, 'review-high'); assert.equal(reviewer.flags['browser-kind'], undefined);
  assert.equal(reviewer.flags['browser-origins'], undefined, 'separate review category drops browser-only CLI flags');
  assert.equal(reviewer.browserKind, undefined);
  console.log('PASS browser kind validation and separate review category scope');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
