#!/usr/bin/env node
// User, 2026-11-13: explicit Claude Bypass/Remote Control and >=2-day SSO notice.
// Synthetic homes/settings/quota only; never launch a worker or read live credentials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'global-rules-test-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
try {
  const { analyze, leanLines, POLICY, now } = await import('../lib/state.mjs');
  const { loadDigest } = await import('../lib/global-rules.mjs');
  const digest = loadDigest();
  const loginAt = digest.worker.indexOf('Forbidden for every worker: never read, copy, load or inject LOGIN material');
  const signingAt = digest.worker.indexOf("Allowed with the user's 2026-11-13 authorization: sign OUR OWN TEST packages");
  assert.ok(loginAt >= 0 && signingAt > loginAt, 'worker digest must contain adjacent login and test-signing rules');
  assert.match(digest.worker, /registered shared test phones iphone8\/iphone11\/s21.*freely tap Allow\/Authorize\/Trust\/OK/);
  assert.match(digest.worker, /personal iPhone 15 Pro Max \(`policy=never`\).*device not registered in `res`/);
  assert.match(digest.worker, /lease <=2 h.*back up app data.*never enter personal-account credentials\/passwords\/verification codes.*no purchases/);
  assert.match(digest.worker, /Codex refuses an allowed prompt.*routes that step to Claude.*do not ask the user to tap it/);
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

  for (const [mode, sandbox] of [[[], 'danger-full-access'], [['--mode', 'default'], 'danger-full-access'],
    [['--mode', 'acceptEdits'], 'danger-full-access'], [['--mode', 'bypassPermissions'], 'danger-full-access']]) {
    assert.ok(route(['implement', '--impact', 'service', ...mode]).pick.command.includes(` --sandbox ${sandbox} `));
    assert.ok(route(['implement', '--impact', 'service', '--read-only', ...mode]).pick.command.includes(' --sandbox read-only '));
  }
  assert.equal(route(['review']).pick.sandbox, 'read-only');
  assert.equal(route(['review', '--runs-tests']).pick.sandbox, 'workspace-write');
  assert.equal(route(['implement', '--impact', 'service', '--sandbox', 'workspace-write']).pick.sandbox, 'workspace-write');
  assert.equal(route(['implement', '--impact', 'service', '--sandbox', 'read-only']).pick.sandbox, 'read-only');
  const signing = route(['review', '--signing', '--sandbox', 'read-only']);
  assert.equal(signing.pick.sandbox, 'danger-full-access');
  assert.match(signing.notes[0], /OUR OWN TEST packages.*user-signing\/registry\.json/);
  assert.match(signing.notes[1], /scan worker logs only.*mask any hits/);
  console.log('ok   Codex writers default full; reviewers stay read-only; tests and explicit overrides stay narrower');

  const forbiddenText = ['regardless of', 'authorization'].join(' ');
  const scan = spawnSync('rg', ['-n', '-i', forbiddenText, path.dirname(root)], { encoding: 'utf8' });
  assert.equal(scan.status, 1, scan.stdout || scan.stderr || `rg exited ${scan.status}`);
  console.log('ok   scoped signing rule replaces every unconditional authorization prohibition');

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
