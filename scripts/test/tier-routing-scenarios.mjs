#!/usr/bin/env node
// Difficulty policy against synthetic catalogs, quota and pauses only; never contact a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { noteFailure } from '../lib/trae-health.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-routing-'));
const now = Date.now(), h = 3600000;
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', SOL56 = 'gpt-5.6-sol';
const TERRA56 = 'gpt-5.6-terra', GPT55 = 'gpt-5.5', FLASH = 'deepseek-v4.1-flash';
const PRO = 'deepseek-v4-pro', SEED = 'seed-evolving';
const ids = [SOL, ASTRA, SOL56, TERRA56, GPT55, FLASH, PRO, SEED, 'gpt-5.6-luna', 'gpt-6.1-terra'];
const bucket = (depleted = false) => ({ used: depleted ? 80 : 1, limit: 80, remaining: depleted ? 0 : 79,
  depleted, resetsAt: now + h });
const active = { [SOL]: bucket(), [ASTRA]: bucket(), [SOL56]: bucket() };
const depleted = { ...active, [SOL]: bucket(true) };
const window = { label: 'week', used: 10, resetsAt: now + 120 * h, windowMins: 10080, scoped: false };
const home = path.join(tmp, 'trae'); fs.mkdirSync(home);
const run = (args, { models = ids, daily = depleted, company = false, traeHome = home } = {}) => {
  const a = args.slice();
  if (['implement', 'implement-hard', 'debug', 'science'].includes(a[0]) && !a.includes('--impact')) a.push('--impact', 'service');
  const trae = { name: 'trae', kind: 'trae', home: traeHome, healthy: true, live: true, search: true, searchLive: true,
    models, modelIds: Object.fromEntries(models.map((id) => [id, id.toUpperCase()])), windows: [],
    load: Object.fromEntries(models.map((id) => [id, { t: now, percent: 10 }])),
    quota: daily === null ? null : { daily, sampledAt: now } };
  fs.writeFileSync(path.join(traeHome, 'queue-state.json'), JSON.stringify({
    gpt: { t: now, position: 0, state: 'ready' }, deepseek: { t: now, position: 0, state: 'ready' },
  }));
  const personal = { name: 'main', home: path.join(tmp, 'main'), live: true, windows: [window], resets: { credits: [] } };
  const ttadk = { name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), healthy: true, live: true, seenAt: now,
    models: [SOL], windows: [], usage: { used: 90, limit: 100, resetsAt: now + 8 * h } };
  const history = path.join(tmp, 'history.jsonl');
  fs.writeFileSync(history, company ? `${JSON.stringify({ t: now - h, ttadk: { name: 'ttadk', ...ttadk.usage, used: 50 } })}\n` : '');
  const cache = path.join(tmp, 'quota.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [{ ...window, label: 'week (all models)' }],
    codexAccounts: [personal, ...(company ? [ttadk] : []), trae], errors: {}, history: {} }));
  return JSON.parse(execFileSync(process.execPath, [path.join(root, 'route.mjs'), ...a, '--mode', 'default', '--json'], {
    encoding: 'utf8', env: { ...process.env, CODEX_ACCOUNTS: path.join(tmp, 'none.json'), QUOTA_CACHE: cache,
      QUOTA_LOG: '0', ROUTE_LOG: '0', TRAE_PROBE: '0', QUOTA_LOG_FILE: history },
  }));
};
const personalGate = (r) => r.needsUserOK.some((n) => n.startsWith('personal quota:'));
try {
  for (const [args, tier, model] of [
    [['implement-hard'], 'hard', ASTRA], [['debug'], 'hard', ASTRA], [['science'], 'hard', ASTRA],
    [['review-high'], 'hard', ASTRA], [['design'], 'hard', ASTRA],
    [['analysis', '--stakes', 'high'], 'hard', ASTRA], [['lookup', '--stakes', 'high'], 'hard', ASTRA],
    [['implement', '--failures', '1'], 'hard', ASTRA], [['implement', '--stakes', 'low', '--failures', '1'], 'hard', ASTRA],
    [['implement'], 'normal', SOL56], [['analysis'], 'normal', SOL56], [['review'], 'normal', SOL56],
    [['lookup'], 'light', TERRA56], [['extract'], 'light', TERRA56], [['draft'], 'light', TERRA56],
    [['analysis', '--stakes', 'low'], 'light', TERRA56], [['analysis', '--background'], 'light', TERRA56],
  ]) {
    const r = run(args); assert.equal(r.tier, tier, args.join(' ')); assert.equal(r.pick.model, model, args.join(' '));
    assert.equal(r.pick.account, 'trae'); assert.ok(!personalGate(r));
  }
  assert.equal(run(['implement', '--failures', '1']).pick.effort, 'xhigh');
  for (const args of [['implement', '--failures', '1'], ['debug', '--failures', '1'], ['design', '--failures', '1']]) {
    const r = run(args, { models: ids.filter((id) => id !== SOL) });
    assert.equal(r.tier, 'hard'); assert.equal(r.pick.model, ASTRA);
    assert.ok(['xhigh', 'max'].includes(r.pick.effort));
  }
  for (const daily of [active, depleted]) {
    assert.equal(run(['lookup'], { daily }).pick.model, TERRA56);
    assert.equal(run(['lookup', '--exclude-model', TERRA56], { daily }).pick.model, GPT55);
    assert.equal(run(['lookup', '--exclude-model', `${TERRA56},${GPT55}`], { daily }).pick.model, FLASH);
  }
  assert.equal(run(['implement'], { daily: { ...depleted, [SOL56]: bucket(true) } }).pick.model, TERRA56);
  assert.equal(run(['implement', '--exclude-model', `${SOL56},${TERRA56}`]).pick.model, FLASH);
  for (const args of [['analysis'], ['lookup'], ['draft']]) {
    for (const models of [ids.filter((id) => id !== SOL), [ASTRA, FLASH, PRO]]) {
      const r = run(args, { models }); assert.notEqual(r.pick.model, ASTRA); assert.notEqual(r.pick.model, PRO);
    }
  }
  for (const args of [['debug'], ['design'], ['implement-hard'], ['analysis', '--stakes', 'high']]) {
    for (const flags of [[], ['--background'], ['--stakes', 'low']]) {
      const r = run([...args, ...flags], { models: ids.filter((id) => id !== SOL) });
      if (r.tier === 'hard') assert.equal(r.pick.model, ASTRA);
      const fallback = run([...args, ...flags, '--exclude-model', ASTRA], { models: ids.filter((id) => id !== SOL) });
      if (fallback.tier === 'hard') assert.ok(![SOL56, TERRA56, GPT55, PRO].includes(fallback.pick?.model));
    }
  }
  assert.equal(run(['lookup', '--security']).pick.model, FLASH);
  assert.equal(run(['implement', '--security']).pick.model, FLASH);
  assert.ok(!run(['review-high', '--security']).pick?.model.startsWith('gpt-')
    || run(['review-high', '--security']).pick.account !== 'trae');
  assert.equal(run(['review-high', '--security', '--background']).pick, null);
  for (const args of [['image-read'], ['image-read', '--stakes', 'low'], ['image-read', '--background']]) {
    assert.ok([SOL, ASTRA, SEED].includes(run(args).pick.model));
    assert.equal(run([...args, '--security']).pick.model, SEED);
  }
  for (const args of [['lookup'], ['analysis'], ['implement'], ['debug'], ['image-read']]) {
    for (const flags of [[], ['--background']]) {
      const r = run([...args, ...flags], { daily: null }); assert.equal(r.pick.model, SOL);
    }
  }
  const paused = path.join(tmp, 'paused'); fs.mkdirSync(paused);
  noteFailure(paused, `-32600: model \`${SOL}\` is unavailable because its metadata could not be resolved`, now, SOL);
  assert.equal(run(['analysis'], { traeHome: paused }).pick.model, SOL56);
  assert.equal(run(['debug'], { traeHome: paused }).pick.model, ASTRA);
  assert.equal(run(['implement', '--failures', '1'], { traeHome: paused }).pick.model, ASTRA);
  noteFailure(paused, `-32600: model \`${TERRA56}\` is unavailable because its metadata could not be resolved`, now, TERRA56);
  assert.equal(run(['lookup'], { traeHome: paused }).pick.model, GPT55);
  const retry = run(['implement', '--failures', '4']);
  assert.equal(retry.pick.model, ASTRA); assert.ok(!retry.needsUserOK.includes('Astra (5x Sol usage)'));
  const noAstra = run(['debug'], { models: [SOL56, TERRA56, GPT55, PRO] });
  assert.ok(personalGate(noAstra));
  for (const [args, model] of [[['lookup'], TERRA56], [['analysis'], SOL56], [['debug'], ASTRA]]) {
    const r = run(args, { company: true }); assert.equal(r.pick.account, 'trae'); assert.equal(r.pick.model, model);
    assert.equal(r.balance.selected, true); assert.ok(!personalGate(r));
  }
  const balancedFallback = run(['implement', '--exclude-model', `${SOL56},${TERRA56}`], { company: true });
  assert.equal(balancedFallback.pick.model, FLASH); assert.equal(balancedFallback.pick.effort, 'high');
  assert.ok(balancedFallback.notes.some((n) => /review required.*fallback model/.test(n)));
  assert.equal(run(['debug'], { company: true, daily: null }).pick.account, 'ttadk');
  const onlyPro = run(['analysis'], { models: [PRO] }); assert.notEqual(onlyPro.pick.model, PRO); assert.ok(personalGate(onlyPro));
  for (const cat of ['lookup', 'extract', 'draft', 'analysis', 'implement', 'debug', 'science', 'review', 'review-high', 'design']) {
    for (const failures of [0, 1, 2, 4, 6]) {
      const r = run([cat, '--failures', String(failures)]);
      for (const pick of [r.pick, r.secondOpinion].filter(Boolean)) {
        assert.notEqual(pick.model, PRO); assert.notEqual(pick.model, 'gpt-5.6-luna'); assert.notEqual(pick.model, 'gpt-6.1-terra');
        if (r.tier === 'hard' && pick.account === 'trae') assert.ok(![SOL56, TERRA56, GPT55].includes(pick.model));
      }
    }
  }
  assert.ok(run(['analysis', '--exclude-model', 'gpt']).notes.some((n) => /can't emit one very large file in a single turn \(output limit\).*split the work or exclude deepseek/.test(n)));
  console.log('all pass: difficulty tiers, depletion, availability, pauses, background, balancing, safety and escalation');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
