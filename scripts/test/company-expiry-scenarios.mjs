#!/usr/bin/env node
// Company quota expiry is advisory, never a reason to spend TTADK before free TRAE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'company-expiry-'));
const saved = { ...process.env }, now = 1800000000000, hour = 3600000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOL = 'gpt-6.1-sol', home = path.join(tmp, 'trae');
Object.assign(process.env, { RULES_SHARED: tmp, RES_DIR: path.join(tmp, 'res'), TRAE_PROBE: '0' });
const { acquireRoute } = await import('../lib/route-data.mjs');
const { parseTaskSpec, routePure } = await import('../lib/pipeline/index.mjs');
fs.mkdirSync(home);
const cache = path.join(tmp, 'quota.json'), history = path.join(tmp, 'quota-log.jsonl');
fs.writeFileSync(path.join(tmp, 'fallback.json'), '{"enabled":false}');
fs.writeFileSync(history, JSON.stringify({ t: now - hour, ttadk: { name: 'ttadk', used: 10, limit: 100, resetsAt: now + hour } }) + '\n');
const env = { ...process.env, ROUTE_NOW: String(now), QUOTA_CACHE: cache,
  CODEX_ACCOUNTS: path.join(tmp, 'no-registry.json'), ROUTE_LOG_FILE: path.join(tmp, 'no-routes.jsonl'),
  QUOTA_LOG_FILE: history, PERSONAL_FALLBACK_FILE: path.join(tmp, 'fallback.json') };
function fixture({ category = 'implement', percent = 10, depleted = false, telemetry = {} } = {}) {
  fs.writeFileSync(path.join(home, 'lane-state.json'), JSON.stringify({ [SOL]: telemetry }));
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [], codexAccounts: [
    { name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), models: [SOL], healthy: true, live: true, windows: [],
      usage: { used: 20, limit: 100, resetsAt: now + hour } },
    { name: 'trae', kind: 'trae', home, models: [SOL], healthy: true, live: true, windows: [],
      load: { [SOL]: { t: now, percent } }, quota: { sampledAt: now, daily: {
        [SOL]: { used: depleted ? 80 : 1, limit: 80, depleted, resetsAt: now + 8 * hour },
      } } },
  ] }));
  const parsed = parseTaskSpec([category, '--impact', 'service', '--dry'], { taskId: 'fixture', requestId: 'fixture' });
  const context = acquireRoute(parsed, { root, now, env });
  return routePure(context.task, context.snapshot);
}
try {
  for (const category of ['implement', 'debug']) {
    const plan = fixture({ category });
    assert.equal(plan.trace.candidates.find(r => r.candidate.accountId === 'ttadk').estimate.expiryOpportunity, true);
    assert.equal(plan.primary.candidate.accountId, 'trae', 'free TRAE wins even while TTADK quota expires unused');
  }
  assert.equal(fixture({ depleted: true, telemetry: { t: now, state: 'ready', position: 0, lastProgressAt: now } }).primary.candidate.accountId, 'ttadk');
  assert.equal(fixture({ percent: 65 }).primary.candidate.accountId, 'ttadk');
  assert.equal(fixture({ depleted: true, telemetry: { t: now, state: 'queued', position: 500, drainPerMin: 1 } }).primary.candidate.accountId, 'ttadk');
  console.log('PASS free TRAE remains eligible; generic progress on an exhausted model yields to ready TTADK');
} finally {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  fs.rmSync(tmp, { recursive: true, force: true });
}
