#!/usr/bin/env node
// Light/procedural deploy tier and escalation against synthetic catalogs and quota only; never contact a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { noteFailure } from '../lib/trae-health.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'light-deploy-'));
const now = Date.now(), h = 3600000;
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', SOL56 = 'gpt-5.6-sol';
const TERRA56 = 'gpt-5.6-terra', GPT55 = 'gpt-5.5', FLASH = 'deepseek-v4.1-flash';
const bucket = (depleted = false) => ({ used: depleted ? 80 : 1, limit: 80, remaining: depleted ? 0 : 79, depleted, resetsAt: now + h });
const active = { [SOL]: bucket(), [ASTRA]: bucket(), [SOL56]: bucket(), [TERRA56]: bucket(), [GPT55]: bucket() };
const window = { label: 'week', used: 10, resetsAt: now + 120 * h, windowMins: 10080, scoped: false };
const home = path.join(tmp, 'trae'); fs.mkdirSync(home);
const run = (args, { ttadkModels = [SOL, TERRA56, GPT55], traeModels = null, daily = active, company = true,
  traeHome = home, ttadkUsed = 10, historyUsed = null, claudeUsed = 10 } = {}) => {
  const a = args.slice();
  const trae = traeModels && { name: 'trae', kind: 'trae', home: traeHome, healthy: true, live: true, search: true, searchLive: true,
    models: traeModels, modelIds: Object.fromEntries(traeModels.map((id) => [id, id.toUpperCase()])), windows: [],
    load: Object.fromEntries(traeModels.map((id) => [id, { t: now, percent: 10 }])),
    quota: daily === null ? null : { daily, sampledAt: now } };
  if (trae) fs.writeFileSync(path.join(traeHome, 'queue-state.json'), JSON.stringify({
    gpt: { t: now, position: 0, state: 'ready' }, deepseek: { t: now, position: 0, state: 'ready' },
  }));
  const personal = { name: 'main', home: path.join(tmp, 'main'), live: true, windows: [window], resets: { credits: [] } };
  const ttadk = company && { name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), healthy: true, live: true, seenAt: now,
    models: ttadkModels, windows: [], usage: { used: ttadkUsed, limit: 100, resetsAt: now + 8 * h } };
  const history = path.join(tmp, 'history.jsonl');
  fs.writeFileSync(history, historyUsed == null ? '' : `${JSON.stringify({ t: now - h, ttadk: { name: 'ttadk', used: historyUsed, limit: 100, resetsAt: now + 8 * h } })}\n`);
  const cache = path.join(tmp, 'quota.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [{ ...window, used: claudeUsed, label: 'week (all models)' }],
    codexAccounts: [personal, ...(ttadk ? [ttadk] : []), ...(trae ? [trae] : [])], errors: {}, history: {} }));
  return JSON.parse(execFileSync(process.execPath, [path.join(root, 'route.mjs'), ...a, '--mode', 'default', '--json'], {
    encoding: 'utf8', env: { ...process.env, CODEX_ACCOUNTS: path.join(tmp, 'none.json'), QUOTA_CACHE: cache,
      QUOTA_LOG: '0', ROUTE_LOG: '0', TRAE_PROBE: '0', QUOTA_LOG_FILE: history },
  }));
};
try {
  // Test-environment build-run is procedural: light tier, lightest company model first.
  const testBuild = run(['build-run', '--env', 'test']);
  assert.equal(testBuild.tier, 'light');
  assert.deepEqual([testBuild.pick.account, testBuild.pick.model, testBuild.pick.effort], ['ttadk', TERRA56, 'medium']);
  assert.ok(!testBuild.notes.some((n) => n.startsWith('deploy/release brief')));
  assert.ok(testBuild.notes.some((n) => n.startsWith('test-environment build-run')));
  // A test-env deploy is remote/procedural: no local heavy-build wrapper hint, explicit no-lock note.
  assert.ok(!testBuild.notes.some((n) => n.startsWith('build brief: full-package builds must use')));
  assert.ok(testBuild.notes.some((n) => n.startsWith('test-environment run (--env test): no heavy-build/lane lock')));

  // A failed light run escalates to Sol medium, not to another light model.
  const testRetry = run(['build-run', '--env', 'test', '--failures', '1']);
  assert.equal(testRetry.tier, 'normal');
  assert.deepEqual([testRetry.pick.account, testRetry.pick.model, testRetry.pick.effort], ['ttadk', SOL, 'medium']);

  // A production release keeps Sol medium and the pinned criteria.
  const prod = run(['build-run', '--impact', 'release']);
  assert.equal(prod.tier, 'normal');
  assert.deepEqual([prod.pick.account, prod.pick.model, prod.pick.effort], ['ttadk', SOL, 'medium']);
  assert.ok(prod.notes.some((n) => n.startsWith('deploy/release brief')));

  // --env test with high stakes stays production-grade.
  const high = run(['build-run', '--env', 'test', '--stakes', 'high']);
  assert.equal(high.tier, 'hard');
  assert.ok(high.notes.some((n) => n.startsWith('deploy/release brief')));

  // TRAE-only light pick uses its own light list (no Sol-first detour) and still escalates to Sol.
  const traeLight = run(['build-run', '--env', 'test'], { company: false, traeModels: [SOL, TERRA56, GPT55, FLASH] });
  assert.deepEqual([traeLight.tier, traeLight.pick.account, traeLight.pick.model], ['light', 'trae', TERRA56]);
  const traeRetry = run(['build-run', '--env', 'test', '--failures', '1'], { company: false, traeModels: [SOL, TERRA56, GPT55, FLASH] });
  assert.deepEqual([traeRetry.tier, traeRetry.pick.model], ['normal', SOL]);

  // Failed light work must not step sideways to a light model just because Sol's TRAE bucket is depleted.
  const depletedSol = { ...active, [SOL]: bucket(true) };
  const sideways = run(['build-run', '--env', 'test', '--failures', '1'], { company: false, daily: depletedSol, traeModels: [SOL, SOL56, TERRA56, GPT55, FLASH] });
  assert.equal(sideways.tier, 'normal');
  assert.equal(sideways.pick.model, SOL56, 'normal-tier fallback, not a light model');
  assert.ok(![TERRA56, GPT55].includes(sideways.pick.model));

  // Balancing a TTADK light first rung walks the full TRAE light list: paused TRAE Terra falls through to 5.5.
  // (lookup is lane-eligible; build-run keeps its no-transfer preference.)
  const paused = path.join(tmp, 'paused'); fs.mkdirSync(paused);
  noteFailure(paused, `-32600: model \`${TERRA56}\` is unavailable because its metadata could not be resolved`, now, TERRA56);
  const balanced = run(['lookup'], { company: true, traeModels: [SOL, TERRA56, GPT55, FLASH], traeHome: paused, historyUsed: 50 });
  assert.deepEqual([balanced.tier, balanced.pick.account, balanced.pick.model, balanced.pick.effort], ['light', 'trae', GPT55, 'medium']);
  assert.equal(balanced.balance?.selected, true);

  // Without a balance trigger the light pick stays on TTADK.
  const stays = run(['lookup'], { company: true, traeModels: null });
  assert.deepEqual([stays.pick.account, stays.pick.model], ['ttadk', TERRA56]);

  // A test-env build-run keeps its existing no-transfer preference (build-run is not lane-eligible).
  const buildStays = run(['build-run', '--env', 'test'], { company: true, traeModels: [SOL, TERRA56, GPT55, FLASH], historyUsed: 50 });
  assert.deepEqual([buildStays.pick.account, buildStays.pick.model], ['ttadk', TERRA56]);

  // --no-local-build marks a remote run: no local heavy-build brief, explicit remote note.
  const remote = run(['build-run', '--impact', 'release', '--no-local-build']);
  assert.ok(remote.notes.some((n) => n.startsWith('remote/CI build (--no-local-build)')));
  assert.ok(!remote.notes.some((n) => n.startsWith('build brief: full-package builds must use')));

  // A local production build keeps the heavy-build brief.
  assert.ok(prod.notes.some((n) => n.startsWith('build brief: full-package builds must use')));
  console.log('light-deploy scenarios: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
