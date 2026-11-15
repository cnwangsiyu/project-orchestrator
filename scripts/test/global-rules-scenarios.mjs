#!/usr/bin/env node
// User, 2026-11-13: explicit Claude Bypass/Remote Control and >=2-day SSO notice.
// Synthetic homes/settings/quota only; never launch a worker or read live credentials.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { routeFixture } from './helpers/route-fixture.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'global-rules-test-'));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
try {
  const { analyze, leanLines, POLICY, now } = await import('../lib/state.mjs');
  const { loadDigest } = await import('../lib/global-rules.mjs');
  const digest = loadDigest();
  const digestText = fs.readFileSync(path.join(path.dirname(root), 'references/global-rules.md'), 'utf8');
  assert.equal(digestText.match(/^version:/gm)?.length, 1, 'integration must publish one digest version');
  assert.equal(digestText.match(/^## Changes In This Version$/gm)?.length, 1);
  assert.match(digestText, /Resources \(2026-11-14\): stage res v1\.4/);
  assert.match(digestText, /Nightly delivery \(2026-11-14\): no fixed working-worker kill\/timeout/);
  assert.match(digest.worker, /take-build\/wait-build inside ONE long-lived wrapper.*local heavy compute/);
  assert.match(digest.worker, /elapsed and predicted-start deadlines.*exclude only the slow account\/model lane/);
  const loginAt = digest.worker.indexOf('Forbidden for every worker: never read, copy, load or inject LOGIN material');
  const signingAt = digest.worker.indexOf('Registered own-test signing uses');
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
    ROUTE_NOW:String(now), ROUTE_LOG_FILE:path.join(tmp,'empty-routes'), QUOTA_LOG_FILE: path.join(tmp, 'empty-history') };
  fs.writeFileSync(env.CODEX_ACCOUNTS, JSON.stringify({ main: { home: tmp, hub: 'ws://127.0.0.1:1' } }));
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const data = (left = 240) => ({ checkedAt: now, claude: [window],
    codexAccounts: [main, { ...ttadk, ssoExpiresAt: now + left * h }], errors: {}, history: {} });
  const route = (args) => {
    fs.writeFileSync(cache, JSON.stringify(data()));
    return JSON.parse(routeFixture(path.join(root, 'route.mjs'), [...args,
      '--cwd', tmp, '--task-dir', tmp, '--name', 'fixture', '--dry', '--json'], { env, dir:tmp, approve:true }));
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
      assert.equal(design.secondOpinion, null);
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
  assert.equal(signing.blocked,true); assert.equal(signing.pick,null);
  assert.ok(signing.plan.reasons.some(r=>r.code==='SIGNING_COMPANY_FULL_ACCESS_REQUIRED'));
  console.log('ok   Codex writers default full; reviewers stay read-only; tests and explicit overrides stay narrower');

  const buildNote = route(['build-run']).notes.find((n) => n.startsWith('build brief:'));
  assert.match(buildNote, /ONE-process wrapper around res take-build\/wait-build\/return-build.*res v1\.4/);
  assert.match(buildNote, /holding neither resource while waiting for the other/);
  assert.match(buildNote, /only for genuine local heavy compute/);
  assert.match(buildNote, /long-lived watched wrapper/);
  for (const flags of [['--no-local-build']]) {
    const notes = route(['build-run', ...flags]).notes;
    assert.ok(!notes.some((n) => n.startsWith('build brief:')));
    assert.ok(notes.some((n) => /no heavy-build\/lane lock|no local heavy-build\/lane lock/.test(n)));
  }
  console.log('ok   integrated digest and route notes retain v1.4 pair acquisition, local-only locks and reroute rules');

  assert.match(digest.worker,/ordinary full-access Codex-family company workers/);
  assert.match(digest.worker,/resident Claude signer is retired/);
  assert.ok(route(['build-run','--env','test']).plan.gates.some(g=>g.kind==='local-resource-admission'));

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
