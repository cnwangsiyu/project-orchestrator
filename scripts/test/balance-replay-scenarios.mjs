#!/usr/bin/env node
// Replay sanitized route evidence and exercise real route decisions with fixed clocks and fixture accounts.
// No provider calls, login files, live profiles or worker launches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { balanceFactors, modelLoad, ttadkBurn } from '../lib/company-load.mjs';
import { noteFailure } from '../lib/trae-health.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/balance-evidence.json', import.meta.url), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-replay-'));
const home = path.join(tmp, 'trae'); fs.mkdirSync(home);
const clock = path.join(tmp, 'clock.mjs');
fs.writeFileSync(clock, 'Date.now = () => Number(process.env.BALANCE_FIXTURE_TIME);\n');
const profiles = path.join(tmp, 'profiles.json'); fs.writeFileSync(profiles, '{}');
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', SOL56 = 'gpt-5.6-sol';
const TERRA = 'gpt-5.6-terra', GPT55 = 'gpt-5.5', FLASH = 'deepseek-v4.1-flash';
const ids = [SOL, ASTRA, SOL56, TERRA, GPT55, FLASH];
const min = 60000, h = 60 * min, now = Date.parse('2026-11-13T21:00:00Z');
const bucket = (share, t = now, reset = t + 8 * h) => ({ used: 100 * (1 - share), limit: 100,
  remaining: 100 * share, depleted: share === 0, resetsAt: reset });
const load = (percent, t = now) => ({ percent, t });
const run = (args, { t = now, daily = { [SOL]: bucket(0), [ASTRA]: bucket(.6), [SOL56]: bucket(.94) },
  models = ids, loads = { [SOL]: load(35, t) }, queue = {}, sampledAt = t, projected = true,
  ttShare = .33, burn = null, traeHealthy = true, traeHome = home, company = true, logged = false } = {}) => {
  const a = args.slice();
  if (['implement', 'implement-hard', 'debug', 'science'].includes(a[0]) && !a.includes('--impact')) a.push('--impact', 'service');
  const reset = burn?.resetsAt ?? t + 18 * h;
  const stamp = burn?.sampledAt ?? t, span = burn?.spanMin ?? 60;
  const rate = burn?.perHour ?? (projected ? 50e6 : 1e6), limit = 500e6, used = limit * (1 - ttShare);
  const usage = { used, limit, resetsAt: reset };
  const history = path.join(tmp, 'history.jsonl');
  fs.writeFileSync(history, JSON.stringify({ t: stamp - span * min,
    ttadk: { name: 'ttadk', ...usage, used: used - rate * span / 60 } }) + '\n');
  const tt = { name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), healthy: true, live: true,
    browser: true, search: true, searchLive: true, models: [SOL], windows: [], seenAt: stamp, usage };
  const trae = { name: 'trae', kind: 'trae', home: traeHome, healthy: traeHealthy, live: true, search: true,
    models, modelIds: Object.fromEntries(models.map((id) => [id, id.toUpperCase()])), windows: [],
    load: loads, quota: daily === null ? null : { sampledAt, daily } };
  fs.writeFileSync(path.join(traeHome, 'queue-state.json'), JSON.stringify(queue));
  const cache = path.join(tmp, 'cache.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: t, claude: null, codexAccounts: [...(company ? [tt] : []), trae], errors: {}, history: {} }));
  const routeLog = path.join(tmp, 'routes.jsonl');
  const result = JSON.parse(execFileSync(process.execPath, ['--import', clock, path.join(root, 'route.mjs'), ...a, '--json', '--mode', 'default'], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, BALANCE_FIXTURE_TIME: String(t), CODEX_ACCOUNTS: profiles,
      QUOTA_CACHE: cache, QUOTA_LOG: '0', QUOTA_LOG_FILE: history, ROUTE_LOG: logged ? '1' : '0', ROUTE_LOG_FILE: routeLog,
      TRAE_PROBE: '0', RULES_SHARED: path.join(tmp, 'rules') },
  }));
  if (logged) result.logged = JSON.parse(fs.readFileSync(routeLog, 'utf8').trim().split('\n').at(-1));
  return result;
};

try {
  // Empty/stale queue data cannot block fresh low load; actual high positions still veto the family.
  for (const queue of [{}, { gpt: { t: now - 31 * min, position: 9999 } }, { gpt: { t: now, state: 'waiting' } }]) {
    const r = run(['implement'], { queue });
    assert.equal(r.pick.account, 'trae'); assert.equal(r.pick.model, SOL56);
    assert.equal(r.balance.congestion, 'low');
  }
  const queued = run(['implement'], { queue: { gpt: { t: now, position: 301 } } });
  assert.equal(queued.pick.model, FLASH); assert.equal(queued.balance.load.source, 'account');
  for (const queue of [{ gpt: { t: now, position: 301 } },
    { gpt: { t: now, position: 0, state: 'ready', high: { t: now - 10 * min, position: 3100 } } }]) {
    const r = run(['implement-hard'], { queue, logged: true });
    assert.equal(r.pick.account, 'ttadk'); assert.match(r.why.join('\n'), /stays on TTADK:/);
    assert.ok(r.balance.candidates.every((c) => c.reasons.includes('family queue above 300')));
    assert.deepEqual(r.logged.balance.candidates, r.balance.candidates);
  }
  assert.equal(run(['implement-hard'], { queue: { gpt: { t: now, position: 300 } } }).pick.model, ASTRA);

  // Direct load takes precedence. Missing load falls back within the family, then across the account.
  const family = modelLoad({ [SOL]: load(24), [SOL56]: load(45), [FLASH]: load(59) }, ASTRA, now);
  assert.equal(family.percent, 45); assert.equal(family.source, 'family');
  assert.equal(modelLoad({ [FLASH]: load(29) }, ASTRA, now).source, 'account');
  assert.equal(modelLoad({ [SOL]: load(90, now - 31 * min) }, ASTRA, now), null);
  assert.equal(modelLoad({ [SOL]: load(90, now + 1) }, ASTRA, now), null);
  assert.equal(modelLoad({ [SOL]: load(90), [ASTRA]: load(24) }, ASTRA, now).percent, 24);
  const hard = run(['implement-hard']);
  assert.equal(hard.pick.model, ASTRA); assert.equal(hard.balance.load.source, 'family');
  assert.equal(run(['implement-hard'], { loads: { [SOL]: load(20), [SOL56]: load(60) } }).pick.account, 'ttadk');
  assert.equal(run(['implement-hard'], { loads: {} }).pick.account, 'ttadk');

  // Walk candidates in tier order after reserve, load, catalog, pause or exclusion misses.
  assert.deepEqual(run(['implement']).balance.candidates.map((c) => c.model), [SOL, SOL56]);
  const fresh = { [SOL]: bucket(.99), [ASTRA]: bucket(.6), [SOL56]: bucket(.94) };
  assert.equal(run(['implement'], { daily: fresh }).pick.model, SOL);
  assert.equal(run(['implement'], { loads: { [SOL]: load(61), [SOL56]: load(35) }, daily: fresh }).pick.model, SOL56);
  assert.equal(run(['implement'], { daily: { ...fresh, [SOL]: bucket(.149) } }).pick.model, SOL56);
  assert.equal(run(['implement'], { daily: { ...fresh, [SOL]: bucket(.15) } }).pick.model, SOL);
  assert.equal(run(['implement'], { daily: { ...fresh, [SOL]: bucket(.99, now, now) } }).pick.model, SOL56);
  assert.equal(run(['implement'], { daily: { ...fresh, [SOL]: bucket(.99, now, now + h) }, sampledAt: now - 30 * min }).pick.model, SOL);
  const stale = run(['implement'], { daily: fresh, sampledAt: now - 30 * min - 1 });
  assert.equal(stale.pick.account, 'ttadk'); assert.ok(stale.balance.candidates.every((c) => !c.reserveOK));
  assert.ok(stale.balance.candidates[0].reasons.some((s) => /stale/.test(s)));
  assert.equal(run(['implement', '--exclude-model', SOL56]).pick.model, TERRA);
  assert.equal(run(['implement', '--exclude-model', `${SOL56},${TERRA}`]).pick.model, FLASH);
  assert.equal(run(['implement'], { models: ids.filter((id) => id !== SOL56) }).pick.model, TERRA);
  const paused = path.join(tmp, 'paused'); fs.mkdirSync(paused);
  noteFailure(paused, `-32600: model \`${SOL56}\` is unavailable because its metadata could not be resolved`, now, SOL56);
  const pausePick = run(['implement'], { traeHome: paused });
  assert.equal(pausePick.pick.model, TERRA); assert.ok(pausePick.balance.candidates[1].reasons.includes('model paused'));
  assert.equal(run(['lookup'], { daily: fresh }).pick.model, TERRA);
  assert.equal(run(['lookup'], { daily: { ...fresh, [TERRA]: bucket(.75) } }).pick.model, TERRA);
  assert.equal(run(['lookup', '--exclude-model', TERRA]).pick.model, GPT55);
  assert.equal(run(['lookup', '--exclude-model', `${TERRA},${GPT55}`]).pick.model, FLASH);
  assert.equal(run(['lookup'], { daily: { ...fresh, [TERRA]: bucket(.14) } }).pick.model, GPT55);
  assert.equal(run(['lookup'], { models: [SOL, ASTRA], daily: fresh }).pick.account, 'ttadk');
  const noHard = run(['implement-hard'], { daily: { ...fresh, [SOL]: bucket(0), [ASTRA]: bucket(.14) } });
  assert.equal(noHard.pick.account, 'ttadk'); assert.deepEqual(noHard.balance.candidates.map((c) => c.model), [SOL, ASTRA]);
  assert.match(noHard.why.join('\n'), /stays on TTADK: no hard-tier/);
  assert.equal(run(['implement', '--failures', '1']).pick.model, ASTRA);

  // Projection sends every eligible normal/light dispatch; when TTADK will last, only light/low/expiry triggers move it.
  for (const category of ['implement', 'analysis', 'review', 'research', 'docs', 'lookup', 'extract', 'draft']) {
    const r = run([category]); assert.equal(r.pick.account, 'trae', category);
    assert.ok(r.balance.projectedOut); assert.ok(!r.needsUserOK.some((s) => /^personal quota:/.test(s)));
    const lasts = run([category], { projected: false });
    assert.equal(lasts.pick.account, ['lookup', 'extract', 'draft'].includes(category) ? 'trae' : 'ttadk', category);
    if (lasts.pick.account === 'ttadk') assert.match(lasts.why.join('\n'), /stays on TTADK: no balancing trigger/);
  }
  assert.equal(run(['analysis', '--impact', 'throwaway'], { projected: false }).pick.account, 'trae');
  assert.equal(run(['analysis'], { projected: false, daily: { ...fresh, [SOL]: bucket(.99, now, now + 5 * h) } }).pick.account, 'trae');
  for (const category of ['implement-hard', 'debug', 'science', 'design', 'review-high']) assert.equal(run([category]).pick.model, ASTRA);
  for (const args of [['browser'], ['ui-browser'], ['computer-use'], ['build-run'], ['image-read'],
    ['implement', '--device-lease'], ['implement', '--shared-lock'], ['implement-hard', '--security']]) {
    assert.equal(run(args).pick.account, 'ttadk', args.join(' '));
  }
  assert.equal(run(['implement', '--security']).pick.model, FLASH);
  assert.equal(run(['implement', '--exclude-account', 'trae']).pick.account, 'ttadk');
  const fallback = run(['implement'], { company: false, queue: { gpt: { t: now, position: 5000 } } });
  assert.equal(fallback.pick.account, 'trae'); assert.equal(fallback.pick.model, SOL56);
  assert.equal(run(['implement'], { traeHealthy: false }).pick.account, 'ttadk');

  // Burn crosses the reset boundary only with sufficient recent observations in the same quota period.
  const usage = { used: 330e6, limit: 500e6, resetsAt: now + 18 * h }, account = { name: 'ttadk', usage };
  const sample = (t, used, extra = {}) => ({ t, ttadk: { name: 'ttadk', ...usage, used, ...extra } });
  assert.equal(ttadkBurn([sample(now - 119 * min, 226e6)], account, now, now).beforeReset, true);
  assert.equal(ttadkBurn([sample(now - 9 * min, 320e6)], account, now, now), null);
  assert.equal(ttadkBurn([sample(now - 121 * min, 220e6)], account, now, now), null);
  assert.equal(ttadkBurn([sample(now - h, 330e6)], account, now, now).beforeReset, false);
  assert.equal(ttadkBurn([sample(now - h, 340e6)], account, now, now), null);
  assert.equal(ttadkBurn([sample(now - h, 220e6, { resetsAt: now + h })], account, now, now), null);
  assert.equal(ttadkBurn([sample(now - h, 220e6)], account, now - 31 * min, now), null);
  assert.equal(balanceFactors({ ttadk: account, model: SOL, trae: { quota: { sampledAt: now, daily: fresh }, load: { [SOL]: load(35) } },
    category: 'implement', stakes: 'normal', now }).eligible, false);

  // Replay each row with balancing factors. The fixture explicitly documents reconstructed missing candidate telemetry.
  // Security reviews are adversarial and move to DeepSeek-V4.1-Flash on TRAE once TTADK is projected out;
  // implement-hard --security (row 48) is not adversarial and still stays on TTADK.
  const stayed = new Set([18, 19, 20, 21, 22, 25, 26, 28, 48, 56]);
  const before = { ttadk: 0, trae: 0, main: 0 }, after = { ...before }, replay = { ttadk: 0, trae: 0 };
  let changed = 0;
  const solReset = Date.parse('2026-11-13T22:00:00Z');
  for (const row of evidence.rows) {
    before[row.account]++;
    if (!row.balance) { after[row.account]++; continue; }
    const b = row.balance, t = row.t;
    const daily = { [SOL]: bucket(t < solReset ? 0 : .995175625, t, t < solReset ? solReset : solReset + 24 * h),
      [ASTRA]: bucket(.6, t), [SOL56]: bucket(.94, t) };
    if (b.remainingShare != null) daily[b.model] = bucket(b.remainingShare, t,
      b.model === SOL ? daily[SOL].resetsAt : t + 8 * h);
    const loads = b.load ? { [SOL56]: load(b.load.percent, b.load.t), [b.model]: load(b.load.percent, b.load.t) }
      : b.model === ASTRA ? { [SOL56]: load(45, t) } : {};
    const args = [row.category, '--stakes', row.stakes, '--failures', String(row.failures)];
    if (row.impact) args.push('--impact', row.impact);
    if (row.security) args.push('--security');
    const r = run(args, { t, daily: b.remainingShare === null && !b.bucketFree && !b.load ? null : daily,
      loads, ttShare: b.ttadkRemainingShare, burn: b.burn, projected: b.burn?.beforeReset === true,
      queue: b.queue ? { [b.family]: b.queue } : {} });
    const expected = stayed.has(row.row) ? 'ttadk' : 'trae';
    assert.equal(r.pick.account, expected, `evidence row ${row.row}`);
    replay[r.pick.account]++; after[r.pick.account]++;
    if (r.pick.account !== row.account) changed++;
    if (r.pick.account === 'trae') assert.ok(!daily[r.pick.model]?.depleted, `row ${row.row} must avoid a depleted foreground bucket`);
  }
  assert.deepEqual(before, { ttadk: 49, trae: 11, main: 2 });
  assert.deepEqual(replay, { ttadk: 10, trae: 29 });
  assert.deepEqual(after, { ttadk: 22, trae: 38, main: 2 }); assert.equal(changed, 27);
  console.log(`PASS reconstructed evidence: 39 replayed rows -> ${replay.ttadk} TTADK / ${replay.trae} TRAE; 23 rows without snapshots retained; total ${after.ttadk} TTADK / ${after.trae} TRAE / ${after.main} personal; ${changed} transfers`);
  console.log('PASS queue independence, load fallback, tier walking, projection split, reserve/freshness, tool exclusions, rejection logs and burn boundaries');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
