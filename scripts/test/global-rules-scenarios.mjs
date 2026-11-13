#!/usr/bin/env node
// User, 2026-11-13: explicit Claude Bypass/Remote Control and >=2-day SSO notice.
// Synthetic homes/settings/quota only; never launch a worker or read live credentials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'global-rules-test-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
try {
  const { analyze, leanLines, POLICY, now } = await import('../lib/state.mjs');
  const h = 3600000;
  const window = { label: 'week (all models)', used: 10, resetsAt: now + 120 * h, windowMins: 10080, scoped: false };
  const main = { name: 'main', home: tmp, live: true, seenAt: now, windows: [window], resets: { count: 0, credits: [] } };
  const ttadk = { name: 'ttadk', kind: 'ttadk', home: tmp, live: true, healthy: true, active: 0,
    models: ['gpt-6.1-sol'], windows: [], resets: null, ssoExpiresAt: now + 240 * h };
  const cache = path.join(tmp, 'quota.json'), settings = path.join(tmp, '.claude', 'settings.json');
  const env = { ...process.env, CODEX_ACCOUNTS: path.join(tmp, 'profiles.json'), QUOTA_CACHE: cache,
    QUOTA_LOG: '0', ROUTE_LOG: '0', TRAE_PROBE: '0', ROUTE_RR: path.join(tmp, 'rotation'),
    QUOTA_LOG_FILE: path.join(tmp, 'empty-history') };
  fs.writeFileSync(env.CODEX_ACCOUNTS, JSON.stringify({ main: { home: tmp, hub: 'ws://127.0.0.1:1' } }));
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const data = (left = 240) => ({ checkedAt: Date.now(), claude: [window],
    codexAccounts: [main, { ...ttadk, ssoExpiresAt: now + left * h }], errors: {}, history: {} });
  const route = (args) => {
    fs.writeFileSync(cache, JSON.stringify(data()));
    return JSON.parse(execFileSync(process.execPath, [path.join(root, 'route.mjs'), ...args,
      '--cwd', tmp, '--task-dir', tmp, '--name', 'fixture', '--dry', '--json'], { env, encoding: 'utf8' }));
  };
  const claudeLaunch = (pick) => {
    assert.equal(pick.vendor, 'claude');
    assert.equal(pick.launcher, 'claude-bg');
    assert.match(pick.command, /claude --bg --remote-control --permission-mode bypassPermissions /);
    assert.ok(pick.command.includes(` --model ${pick.model} --effort ${pick.effort} `));
  };

  for (const config of [null, '{broken', {}, { permissions: { defaultMode: 'default' } },
    { permissions: { defaultMode: 'acceptEdits' } }, { defaultMode: 'plan' },
    { permissions: { defaultMode: 'bypassPermissions' } }]) {
    if (config === null) fs.rmSync(settings, { force: true });
    else fs.writeFileSync(settings, typeof config === 'string' ? config : JSON.stringify(config));
    for (const mode of [[], ['--mode', 'default'], ['--mode', 'acceptEdits'], ['--mode', 'bypassPermissions']]) {
      claudeLaunch(route(['claude-tools', ...mode]).pick);
      const design = route(['design', ...mode]);
      assert.equal(design.pick.vendor, 'codex');
      claudeLaunch(design.secondOpinion);
    }
  }
  console.log('ok   Claude primary/second-opinion launches use Remote Control and Bypass for every default/override');

  for (const [mode, sandbox] of [[[], 'workspace-write'], [['--mode', 'default'], 'workspace-write'],
    [['--mode', 'bypassPermissions'], 'danger-full-access']]) {
    assert.ok(route(['implement', '--impact', 'service', ...mode]).pick.command.includes(` --sandbox ${sandbox} `));
    assert.ok(route(['implement', '--impact', 'service', '--read-only', ...mode]).pick.command.includes(' --sandbox read-only '));
  }
  console.log('ok   explicit Claude Bypass does not widen the Codex sandbox');

  assert.equal(POLICY.ttadkSsoWarnH, 72);
  for (const [left, expected] of [[73, false], [72, true], [71, true], [55, true], [48, true], [24, true]]) {
    const d = data(left);
    assert.equal(leanLines(analyze(d), d).some((line) => line.startsWith('TTADK SSO expires in ')), expected,
      `SSO notice at ${left} hours`);
    fs.writeFileSync(cache, JSON.stringify(d));
    const shown = execFileSync(process.execPath, [path.join(root, 'quota.mjs')], { env, encoding: 'utf8' });
    assert.equal(shown.includes('lean: TTADK SSO expires in '), expected, `quota CLI notice at ${left} hours`);
  }
  console.log('ok   SSO warning includes 72h boundary and reaches quota.mjs before the two-day deadline');
  console.log('\nall pass');
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
}
