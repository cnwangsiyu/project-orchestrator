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
const run = (args, { models = ids, daily = depleted, company = false, traeHome = home, claudeUsed = 10, sampledAt = now } = {}) => {
  const a = args.slice();
  if (['implement', 'implement-hard', 'debug', 'science'].includes(a[0]) && !a.includes('--impact')) a.push('--impact', 'service');
  const trae = { name: 'trae', kind: 'trae', home: traeHome, healthy: true, live: true, search: true, searchLive: true,
    models, modelIds: Object.fromEntries(models.map((id) => [id, id.toUpperCase()])), windows: [],
    load: Object.fromEntries(models.map((id) => [id, { t: now, percent: 10 }])),
    quota: daily === null ? null : { daily, sampledAt } };
  fs.writeFileSync(path.join(traeHome, 'queue-state.json'), JSON.stringify({
    gpt: { t: now, position: 0, state: 'ready' }, deepseek: { t: now, position: 0, state: 'ready' },
  }));
  const personal = { name: 'main', home: path.join(tmp, 'main'), live: true, windows: [window], resets: { credits: [] } };
  const ttadk = { name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), healthy: true, live: true, seenAt: now,
    models: [SOL], windows: [], usage: { used: 90, limit: 100, resetsAt: now + 8 * h } };
  const history = path.join(tmp, 'history.jsonl');
  fs.writeFileSync(history, company ? `${JSON.stringify({ t: now - h, ttadk: { name: 'ttadk', ...ttadk.usage, used: 50 } })}\n` : '');
  const cache = path.join(tmp, 'quota.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [{ ...window, used: claudeUsed, label: 'week (all models)' }],
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
  // Security reviews are adversarial: no GPT on any account, DeepSeek-V4.1-Flash on TRAE when TTADK lists no Kimi.
  for (const flags of [[], ['--background']]) {
    const r = run(['review-high', '--security', ...flags]);
    assert.equal(r.pick.model, FLASH); assert.equal(r.pick.account, 'trae');
    assert.ok(!r.pick.model.startsWith('gpt-'));
    assert.ok(r.why.join('\n').includes('adversarial: no GPT model on any account'));
  }
  for (const args of [['image-read'], ['image-read', '--stakes', 'low'], ['image-read', '--background']]) {
    assert.ok([SOL, ASTRA, SEED].includes(run(args).pick.model));
    assert.equal(run([...args, '--security']).pick.model, SEED);
  }
  // Light rows (lookup/extract/draft, background ordinary work) start on the light list even with unknown quota;
  // normal/hard rows keep Sol (debug stays hard under --background).
  for (const [args, plain, background] of [
    [['lookup'], TERRA56, TERRA56], [['analysis'], SOL, TERRA56], [['implement'], SOL, TERRA56],
    [['debug'], SOL, SOL], [['image-read'], SOL, SOL],
  ]) {
    assert.equal(run(args, { daily: null }).pick.model, plain, `${args.join(' ')} plain`);
    assert.equal(run([...args, '--background'], { daily: null }).pick.model, background, `${args.join(' ')} background`);
  }
  const paused = path.join(tmp, 'paused'); fs.mkdirSync(paused);
  noteFailure(paused, `-32600: model \`${SOL}\` is unavailable because its metadata could not be resolved`, now, SOL);
  assert.equal(run(['analysis'], { traeHome: paused }).pick.model, SOL56);
  assert.equal(run(['debug'], { traeHome: paused }).pick.model, ASTRA);
  assert.equal(run(['implement', '--failures', '1'], { traeHome: paused }).pick.model, ASTRA);
  noteFailure(paused, `-32600: model \`${TERRA56}\` is unavailable because its metadata could not be resolved`, now, TERRA56);
  assert.equal(run(['lookup'], { traeHome: paused }).pick.model, GPT55);
  const retry = run(['implement', '--failures', '2']);
  assert.equal(retry.pick.model, ASTRA); assert.ok(!retry.needsUserOK.includes('Astra (5x Sol usage)'));
  assert.equal(retry.pick.effort, 'max'); assert.ok(retry.needsUserOK.includes('max effort'));
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
  // Sol review P1: normal-tier availability candidates must not become a weaker-GPT retry ladder.
  const unavailable = ['analysis', '--exclude-model', SOL];
  const first = run(unavailable, { daily: active }), next = run([...unavailable, '--failures', '1'], { daily: active });
  assert.deepEqual([first.pick.model, first.pick.effort], [SOL56, 'high']);
  assert.deepEqual([next.pick.model, next.pick.effort], [SOL56, 'xhigh']);
  const sameModelMax = run([...unavailable, '--failures', '2'], { daily: active, models: ids.filter((id) => id !== FLASH) });
  assert.deepEqual([sameModelMax.pick.model, sameModelMax.pick.effort], [SOL56, 'max']);
  assert.ok(sameModelMax.needsUserOK.includes('max effort'));
  // Sol review P1: a later lower-effort Astra must be removed after depleted-Sol promotion to Astra max.
  const debug = ['debug', '--impact', 'service'];
  const max = run([...debug, '--failures', '1']);
  assert.deepEqual([max.pick.model, max.pick.effort], [ASTRA, 'max']);
  assert.ok(max.needsUserOK.includes('max effort'));
  for (const failures of [2, 3]) {
    const r = run([...debug, '--failures', String(failures)]);
    assert.ok(r.pick.model !== ASTRA || r.pick.effort === 'max');
  }
  const exhaustedMax = run([...debug, '--failures', '3'], { claudeUsed: 93 });
  assert.deepEqual([exhaustedMax.pick.model, exhaustedMax.pick.effort], [ASTRA, 'max']);
  assert.ok(exhaustedMax.needsUserOK.includes('max effort'));
  const ttMax = run(['implement', '--failures', '2'], { company: true, daily: null });
  assert.deepEqual([ttMax.pick.account, ttMax.pick.effort], ['ttadk', 'max']);
  assert.ok(!ttMax.needsUserOK.includes('max effort'));
  // Kimi notes: name depleted skipped candidates; pin secondary substitution and the explicit Astra quality rung.
  const skip = run(['debug', '--exclude-model', SOL], { daily: { ...active, [ASTRA]: bucket(true) } });
  assert.equal(skip.pick.model, FLASH);
  assert.ok(skip.why.some((s) => /skipped depleted priority buckets:.*gpt-6-astra/.test(s)));
  const second = run(['review-high', '--author', 'codex']);
  assert.equal(second.pick.vendor, 'claude'); assert.equal(second.secondOpinion.model, ASTRA);
  assert.equal(second.secondOpinion.account, 'trae');
  const sameFamily = run(['design'], { claudeUsed: 93, models: ids.filter((id) => id !== FLASH) });
  assert.equal(sameFamily.secondOpinion.model, ASTRA);
  assert.ok(sameFamily.notes.some((s) => /quota substitution leaves the second opinion in the same model family/.test(s)));
  const quality = run(['analysis', '--failures', '4'], { daily: active });
  assert.equal(quality.tier, 'normal'); assert.equal(quality.pick.model, ASTRA);
  assert.equal(run(['analysis'], { daily: active }).pick.model, SOL);
  assert.equal(run(['analysis', '--exclude-model', SOL], { daily: active }).pick.model, SOL56);

  // Re-review P1: current hard-tier capacity must see Astra even when the initial CODE tier could not.
  const astraOnly = [
    { models: [ASTRA], daily: active },
    { models: [ASTRA], daily: null },
    { models: [ASTRA], daily: active, sampledAt: now - 31 * 60000 },
  ];
  for (const config of astraOnly) for (const flags of [[], ['--background'], ['--stakes', 'low'], ['--stakes', 'low', '--background']]) {
    const args = ['implement', '--impact', 'service', '--failures', '1', ...flags];
    const r = run(args, config);
    assert.equal(r.tier, 'hard'); assert.equal(r.deferred, null);
    assert.equal(r.pick.model, ASTRA); assert.equal(r.pick.account, 'trae');
    assert.ok(!personalGate(r));
    assert.equal(r.needsUserOK.includes('max effort'), r.pick.effort === 'max');
  }
  for (const config of astraOnly) {
    for (const flags of [['--security'], ['--exclude-model', ASTRA], ['--exclude-account', 'trae']]) {
      const args = ['implement', '--impact', 'service', '--failures', '1', ...flags];
      const r = run(args, config);
      assert.notEqual(r.pick?.account, 'trae'); assert.ok(personalGate(r));
      const background = run([...args, '--background'], config);
      assert.equal(background.pick, null); assert.ok(background.deferred);
      assert.ok(!personalGate(background));
    }
  }

  // Independent CLI oracles: monotonic retries and approval for actual personal fall-throughs with company capacity.
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'];
  const gptRank = ['gpt-6-luna', 'gpt-6.1-terra', GPT55, TERRA56, SOL56, SOL, ASTRA];
  const claudeRank = ['haiku', 'sonnet', 'opus', 'fable'];
  const scenarios = [
    { daily: active }, { daily: depleted }, { daily: null },
    { daily: { ...depleted, [ASTRA]: bucket(true) } },
    { daily: active, models: ids.filter((id) => id !== SOL) },
    { daily: depleted, company: true }, { daily: depleted, claudeUsed: 93 },
    { daily: active, models: [GPT55, TERRA56] },
    ...astraOnly,
  ];
  const cases = [
    ['lookup'], ['analysis', '--auto-check'], ['analysis', '--stakes', 'low'], ['analysis', '--stakes', 'high'],
    ['implement'], ['implement', '--background'], ['implement-hard', '--impact', 'throwaway'],
    ['debug'], ['science'], ['review', '--author', 'codex'], ['review-high', '--security'],
    ['design', '--background'], ['image-read', '--background'], ['second-opinion', '--against', 'claude'],
    ['analysis', '--exclude-model', SOL], ['analysis', '--exclude-account', 'trae'],
  ];
  let checks = 0, approvalChecks = 0;
  for (const config of scenarios) for (const args of cases) {
    let previous = null;
    const seen = new Map(); let topGPT = -1;
    for (let failures = 0; failures <= 7; failures++) {
      const r = run([...args, '--failures', String(failures)], config), p = r.pick;
      if (!p) { assert.ok(r.deferred); continue; }
      const label = `${args.join(' ')} failures=${failures} config=${JSON.stringify(config)}`;
      const excludeAt = args.indexOf('--exclude-model'), excludeAccountAt = args.indexOf('--exclude-account');
      const excludedModels = new Set(excludeAt < 0 ? [] : args[excludeAt + 1].split(','));
      const excludedAccounts = new Set(excludeAccountAt < 0 ? [] : args[excludeAccountAt + 1].split(','));
      const security = args.includes('--security'), category = args[0];
      const fits = (model, account) => !excludedAccounts.has(account) && !excludedModels.has(model)
        && !excludedModels.has(model.startsWith('gpt-') ? 'gpt' : model.split('-')[0])
        && !(security && account === 'trae' && model.startsWith('gpt-'));
      const tierCandidates = r.tier === 'hard' ? [SOL, ASTRA] : r.tier === 'normal' ? [SOL, SOL56, TERRA56, FLASH] : [TERRA56, GPT55, FLASH];
      const deepseekFits = category !== 'review-high' && !(['review', 'second-opinion'].includes(category) && (security || args.includes('high')));
      const companyModels = category === 'image-read' ? [SOL, ASTRA, SEED]
        : [SOL, ...tierCandidates.filter((m) => m !== FLASH || deepseekFits), ...(deepseekFits ? [FLASH] : [])];
      const traeAvailable = (config.models ?? ids).some((m) => companyModels.includes(m) && fits(m, 'trae'));
      const ttAvailable = !!config.company && fits(SOL, 'ttadk');
      const companyHasSol = ttAvailable || ((config.models ?? ids).includes(SOL) && fits(SOL, 'trae'));
      if (traeAvailable || ttAvailable) {
        for (const [pick, secondary] of [[p, false], [r.secondOpinion, true]]) {
          if (!pick) continue;
          const personal = pick.vendor === 'claude' || !['trae', 'ttadk'].includes(pick.account);
          // Standing cross-vendor exceptions authorize Claude beside company Sol, not personal Codex retries.
          const crossVendorException = pick.vendor === 'claude' && companyHasSol
            && (secondary || (category === 'review-high' && args.includes('--author') && args.includes('codex'))
              || (category === 'second-opinion' && args.includes('codex')));
          if (personal && !crossVendorException) assert.ok(personalGate(r), label);
          approvalChecks++;
        }
      }
      const key = `${p.vendor}:${p.model}`, e = effort.indexOf(p.effort), rank = gptRank.indexOf(p.model);
      if (previous) {
        if (key === `${previous.vendor}:${previous.model}`) {
          assert.ok(e >= effort.indexOf(previous.effort), label);
          if (e === effort.indexOf(previous.effort)) assert.ok(r.needsUserOK.some((s) => /escalation ladder exhausted/.test(s)), label);
        }
        else if (p.vendor === 'codex' && previous.vendor === 'codex') {
          if (rank >= 0 && gptRank.includes(previous.model)) assert.ok(rank > gptRank.indexOf(previous.model), label);
          assert.ok(previous.model !== ASTRA || ![FLASH, SEED].includes(p.model), label);
        } else if (p.vendor === 'claude' && previous.vendor === 'claude') {
          assert.ok(claudeRank.indexOf(p.model) > claudeRank.indexOf(previous.model), label);
        }
        checks++;
      }
      assert.ok(e >= (seen.get(key) ?? -1), label);
      seen.set(key, e);
      if (rank >= 0) { assert.ok(rank >= topGPT, label); topGPT = Math.max(topGPT, rank); }
      if (p.effort === 'max') assert.equal(r.needsUserOK.includes('max effort'), p.account !== 'ttadk', label);
      previous = p;
    }
  }
  console.log(`ok   availability review reproductions, max gates, secondary/quality boundaries; ${checks} monotonic retry checks; ${approvalChecks} company-capacity approval checks`);
  console.log('all pass: difficulty tiers, depletion, availability, pauses, background, balancing, safety and escalation');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
