#!/usr/bin/env node
// Frozen synthetic catalogs and telemetry; never query providers or live state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sol62-quota-'));
const saved = { ...process.env };
const now = 1800000000000, hour = 3600000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOL = 'gpt-6.2-sol', OLD = 'gpt-6.1-sol';
Object.assign(process.env, { RULES_SHARED: tmp, RES_DIR: path.join(tmp, 'res'), TRAE_PROBE: '0' });
const { normalizeTraeDaily } = await import('../lib/trae-quota-aliases.mjs');
const { traeQuota } = await import('../lib/state.mjs');
const { freshTraeQuota } = await import('../lib/company-load.mjs');
const { acquireRoute } = await import('../lib/route-data.mjs');
const { parseTaskSpec, routePure, renderPlan } = await import('../lib/pipeline/index.mjs');

const bucket = { used: 80, limit: 80, remaining: 0, depleted: true, resetsAt: now + hour };
const home = path.join(tmp, 'trae');
fs.mkdirSync(home);
fs.writeFileSync(path.join(tmp, 'fallback.json'), '{"enabled":false}');
const cache = path.join(tmp, 'quota.json');
const env = { ...process.env, ROUTE_NOW: String(now), QUOTA_CACHE: cache,
  CODEX_ACCOUNTS: path.join(tmp, 'no-registry.json'), ROUTE_LOG_FILE: path.join(tmp, 'no-routes.jsonl'),
  QUOTA_LOG_FILE: path.join(tmp, 'no-quota-log.jsonl'), PERSONAL_FALLBACK_FILE: path.join(tmp, 'fallback.json') };
function fixture({ daily = { gpt_6_2: bucket }, sampledAt = now, telemetry = { t: now, state: 'ready', position: 0, lastProgressAt: now }, load = 47 } = {}) {
  fs.writeFileSync(path.join(home, 'lane-state.json'), JSON.stringify({ [SOL]: telemetry }));
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [], codexAccounts: [
    { name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), models: [OLD], healthy: true, live: true, windows: [],
      usage: { used: 10, limit: 100, resetsAt: now + 8 * hour } },
    { name: 'trae', kind: 'trae', home, models: [SOL, OLD], healthy: true, live: true, windows: [],
      quota: { daily, sampledAt }, load: { [SOL]: { t: now, percent: load }, [OLD]: { t: now, percent: 22 } } },
  ] }));
  const parsed = parseTaskSpec(['implement', '--impact', 'service', '--dry'], { taskId: 'fixture', requestId: 'fixture' });
  const context = acquireRoute(parsed, { root, now, env });
  return { ...context, plan: routePure(context.task, context.snapshot) };
}
try {
  const payload = { dailyUsage: [{ quotaKey: 'gpt_6_2', quotaUsed: '80', quotaLimit: '80', quotaRemaining: '0',
    isDepleted: true, resetTime: (now + hour) / 1000 }], modelQuotas: {} };
  const parsed = traeQuota(payload, now);
  assert.equal(parsed.daily[SOL].depleted, true);
  assert.equal(parsed.daily[SOL].used, 80);
  assert.equal(parsed.daily.gpt_6_2, undefined);
  assert.deepEqual(traeQuota({ ...payload, modelQuotas: { [SOL]: 'gpt_6_2' } }, now), parsed);
  const explicit = { ...bucket, used: 20, depleted: false };
  assert.equal(normalizeTraeDaily({ gpt_6_2: bucket, [SOL]: explicit })[SOL], explicit);
  assert.equal(normalizeTraeDaily({ [SOL]: explicit, gpt_6_2: bucket })[SOL], explicit);
  assert.deepEqual(normalizeTraeDaily({ gpt_6_3: bucket }), { gpt_6_3: bucket });
  assert.equal(freshTraeQuota({ sampledAt: now - 31 * 60000, daily: { gpt_6_2: bucket } }, now).daily[SOL], null);
  let result = fixture();
  assert.equal(result.snapshot.lanes.find(l => l.accountId === 'trae' && l.modelId === SOL).mode, 'low-priority');
  assert.equal(result.plan.primary.candidate.accountId, 'trae');
  assert.equal(result.plan.primary.candidate.modelId, SOL);
  assert.equal(result.plan.primary.candidate.effort, 'high');
  // Depletion without direct readiness is not demonstrated immediate capacity.
  const unavailable = fixture({ telemetry: {} });
  assert.equal(unavailable.plan.primary.candidate.accountId, 'ttadk');
  const explanation = renderPlan(unavailable.plan, unavailable).why.join('\n');
  assert.match(explanation, /stays on TTADK: gpt-6\.2-sol: no demonstrated immediate uncongested TRAE lane/);
  assert.doesNotMatch(explanation, /no qualified same-model TRAE lane/);
  assert.equal(fixture({ telemetry: { t: now, state: 'queued', position: 500, drainPerMin: 1 } }).plan.primary.candidate.accountId, 'ttadk');
  assert.equal(fixture({ load: 65 }).plan.primary.candidate.accountId, 'ttadk');
  // An alias must also recover fresh priority capacity from an older cache.
  result = fixture({ daily: { gpt_6_2: explicit }, telemetry: {} });
  assert.equal(result.plan.primary.candidate.accountId, 'trae');
  assert.equal(result.plan.primary.candidate.modelId, SOL);
  assert.equal(result.snapshot.lanes.find(l => l.accountId === 'trae' && l.modelId === SOL).mode, 'priority');
  assert.equal(fixture({ daily: {} }).snapshot.lanes.find(l => l.accountId === 'trae' && l.modelId === SOL).mode, 'UNKNOWN');
  const docs = fs.readFileSync(path.join(root, 'references/model-routing.md'), 'utf8');
  assert.match(docs, /TRAE offers\s+`gpt-6\.2-sol`, `gpt-6\.1-sol` and `gpt-6-astra`/);
  assert.match(docs, /`gpt_6_2` maps to `gpt-6\.2-sol`/);
  console.log('PASS Sol 6.2 provider/cached aliases, company-first routing, latest release and telemetry boundaries');
} finally {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  fs.rmSync(tmp, { recursive: true, force: true });
}
