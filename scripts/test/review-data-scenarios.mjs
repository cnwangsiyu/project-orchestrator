#!/usr/bin/env node
// Review-budget and TRAE points↔tokens telemetry against isolated route/quota/session fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const review = path.join(scripts, 'review-data.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-data-test-'));
const home = path.join(tmp, 'home'), bin = path.join(tmp, 'bin'), sessions = path.join(tmp, 'sessions');
const routeLog = path.join(tmp, 'routes.jsonl'), quotaLog = path.join(tmp, 'quota.jsonl'), cache = path.join(tmp, 'cache.json');
const now = Date.now(), h = 3600000, reset = now + h, start = reset - 24 * h;
for (const dir of [home, bin, sessions]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fixture\\n"\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o755 });
fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: null, codexAccounts: [], errors: {}, history: {} }));
fs.writeFileSync(path.join(tmp, 'profiles.json'), '{}');

const pick = { vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high', account: 'ttadk' };
const row = (minutes, project, name, category, extra = {}) => ({ t: now - minutes * 60000, project, name, category, pick, ...extra });
const routes = [
  row(50, 'p', 'T1', 'implement'),
  row(40, 'p', 'T1-R', 'review', { second: { ...pick, model: 'kimi-k3' }, reviewResult: 'found P1', secondFindings: 'no P0/P1 findings' }),
  row(30, 'p', 'T1-R2', 'review-high', { reviewClass:'B',reviewReason:'authentication logic',reviewResult: 'no P0/P1 findings' }),
  row(20, 'p', 'T2', 'implement', { reviewClass:'A',reviewReason:'irreversible release',impact: 'release', second: { ...pick, model: 'gpt-6-astra' } }),
  row(10, 'q', 'Q1', 'analysis'),
];
fs.writeFileSync(routeLog, routes.map((r) => JSON.stringify(r)).join('\n') + '\n');

const daily = (used) => ({
  'gpt-5.6-sol': { used, limit: 80, resetsAt: reset },
  'gpt-6.2-astra': { used: used ? 58 : 0, limit: 58, resetsAt: reset },
  'gpt-6.1-sol': { used, limit: 80, resetsAt: reset },
});
const quotaRows = [
  { t: start + 10 * 60000, trae: { sampledAt: start + 10 * 60000, daily: daily(0) } },
  { t: now, trae: { sampledAt: now, daily: daily(80) } },
];
fs.writeFileSync(quotaLog, quotaRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const session = (file, model, input) => {
  const half = Math.floor(input / 2);
  const rows = [
    { timestamp: new Date(start + 20 * 60000).toISOString(), type: 'turn_context', payload: { model } },
    { timestamp: new Date(start + 30 * 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: half, cached_input_tokens: 0, output_tokens: 0 } } } },
    { timestamp: new Date(now - 10 * 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 } } } },
  ];
  fs.writeFileSync(path.join(sessions, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
session('sol56.jsonl', 'GPT-5.6-Sol', 20_000_000); // $80 at the public $4/M input price.
session('astra.jsonl', 'GPT-6.2-Astra', 5_800_000); // $58 at the public $10/M input price.

const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ROUTE_LOG_FILE: routeLog,
  QUOTA_LOG_FILE: quotaLog, QUOTA_CACHE: cache, CODEX_ACCOUNTS: path.join(tmp, 'profiles.json'),
  TRAE_SESSIONS_DIR: sessions, RESOURCE_LOG_FILE: path.join(tmp, 'no-resources.jsonl'), RULES_LEDGER_ROOT: path.join(tmp, 'no-ledgers'),
  ROUTE_LOG: '0', QUOTA_LOG: '0', TRAE_PROBE: '0' };

try {
  const json = JSON.parse(execFileSync(process.execPath, [review, '--hours', '168', '--json'], { env, encoding: 'utf8' }));
  const p = json.reviews.rolling24h.byProject.p;
  assert.deepEqual([p.dispatches, p.reviews, p.reviewSharePct], [6, 4, 66.7]);
  assert.deepEqual([p.secondReviewers, p.secondReviewerSharePct, p.reReviews, p.reReviewSharePct], [2, 50, 1, 25]);
  assert.deepEqual(p.tasksAtLeast3, [{ task: 'p/T1', reviews: 3 }]);
  assert.deepEqual(p.yield, { foundP0P1: 1, none: 2, unknown: 1, blocking:1,known:3,blockingRatePct:33.3 });
  assert.deepEqual([p.requiredReviews, p.requiredReviewSharePct], [2, 33.3]);
  assert.equal(json.reviews.rolling24h.byProject.q.reviewSharePct, 0);
  assert.ok(Object.keys(json.reviews.rolling7d.byProjectDay).some((k) => k.endsWith('/p')));
  console.log('PASS per-project/day review share, second/re-review shares, yield, required reviews and ≥3 flags');

  execFileSync(process.execPath,[path.join(scripts,'outcome.mjs'),'--project','p','--name','T1-R','--result','pass','--review-result','none'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  let recorded=JSON.parse(execFileSync(process.execPath,[review,'--hours','24','--json'],{env,encoding:'utf8'}));
  assert.equal(recorded.reviews.rolling24h.byProject.p.yield.blocking,0,'explicit outcome none overrides route P1 text');
  execFileSync(process.execPath,[path.join(scripts,'outcome.mjs'),'--project','p','--name','T1-R','--review-result','blocking'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  recorded=JSON.parse(execFileSync(process.execPath,[review,'--hours','24','--json'],{env,encoding:'utf8'}));
  assert.equal(recorded.reviews.rolling24h.byProject.p.yield.blocking,1);
  const meta=fs.readFileSync(routeLog,'utf8').trim().split('\n').map(JSON.parse).at(-1);assert.equal(meta.kind,'outcome');assert.ok(!Object.hasOwn(meta,'result'),'metadata-only result preserves accepted outcome');
  const targets=JSON.parse(fs.readFileSync(path.join(scripts,'../references/project-risk-profiles.json'),'utf8'));
  assert.equal(targets['video-agent'].reviewTargetPct,10);assert.equal(targets['vesdk-mainline'].reviewTargetPct,20);
  assert.equal(recorded.reviews.rolling24h.targetPct,null,'aggregate target is observational');
  fs.appendFileSync(routeLog,['evelyns-world','acq','autotrader'].map(project=>JSON.stringify(row(5,project,'private-feature','implement'))).join('\n')+'\n');
  recorded=JSON.parse(execFileSync(process.execPath,[review,'--hours','24','--json'],{env,encoding:'utf8'}));
  for(const project of ['evelyns-world','acq','autotrader']) {const p=recorded.reviews.rolling24h.byProject[project];assert.equal(p.targetPct,null);assert.equal(p.overBudget,null);assert.equal(p.targetExcluded,true);assert.deepEqual(recorded.reviews.rolling24h.noReviewProjects[project],{dispatches:1,reviews:0});}
  console.log('PASS explicit outcome yield/correction precedence and per-project targets');
  const windows = json.quota.traeReconciliation.windows;
  const byModel = (model) => windows.find((w) => w.model === model);
  assert.deepEqual([byModel('gpt-5.6-sol').publicListCostUsd, byModel('gpt-5.6-sol').dollarsPerUnit, byModel('gpt-5.6-sol').coveragePct], [80, 1, 100]);
  assert.deepEqual([byModel('gpt-6.2-astra').publicListCostUsd, byModel('gpt-6.2-astra').dollarsPerUnit, byModel('gpt-6.2-astra').coveragePct], [58, 1, 100]);
  assert.equal(byModel('gpt-6.1-sol').status, 'UNKNOWN'); assert.equal(byModel('gpt-6.1-sol').coveragePct, null);
  assert.ok(byModel('gpt-5.6-sol').quotaLogSpanPct > 90); assert.ok(byModel('gpt-5.6-sol').sessionTelemetrySpanPct > 90);
  console.log('PASS TRAE reset-window units, token pricing, ratio, coverage and UNKNOWN gaps');

  const text = execFileSync(process.execPath, [review, '--hours', '24'], { env, encoding: 'utf8' });
  assert.match(text, /## review budget/); assert.match(text, /traeReconciliation/);
  console.log('PASS review-data text and JSON expose review budget and reconciliation');

  const old = { kind: 'outcome', project: 'p', name: 'old-finished', t: now - 30 * h, result: 'rework', cause: 'spec', rounds: 2, first: pick };
  const recent = { kind: 'outcome', project: 'p', name: 'non-code', t: now - h, result: 'rework', cause: 'infra', rounds: 2, first: pick };
  fs.appendFileSync(routeLog, [old, { ...old, t: now, correction: true, note: 'Corrected after completion' }, recent].map(JSON.stringify).join('\n') + '\n');
  const eventShared = path.join(home, '.claude/orchestrator/_shared'); fs.mkdirSync(eventShared, { recursive: true });
  const question = { id: 'question', runId: 'question-run', event: 'question', owner: 'owner', account: 'trae', thread: 'thread', questionId: 'q', t: now - h, expiresAt: now - 20 * 60000, default: 'continue' };
  fs.mkdirSync(path.join(eventShared, 'worker-event-history'));
  fs.writeFileSync(path.join(eventShared, 'worker-event-history/questions.jsonl'), JSON.stringify(question) + '\n');
  fs.writeFileSync(path.join(eventShared, 'worker-events.jsonl'), '');
  const statistics = JSON.parse(execFileSync(process.execPath, [review, '--hours', '24', '--json'], { env: { ...env, RULES_SHARED: eventShared }, encoding: 'utf8' }));
  assert.ok(!statistics.outcomes.byCause.spec, 'a correction does not move old completion into the current report window');
  assert.equal(statistics.outcomes.byVendor.codex.nonCodeRework, 1);
  assert.equal(statistics.outcomes.byVendor.codex.firstPass, '0/1');
  assert.equal(statistics.outcomes.corrected.find(r => r.task.endsWith('/old-finished')).completedAt, old.t);
  assert.equal(statistics.overdueQuestions.length, 1); assert.equal(statistics.overdueQuestions[0].questionId, 'q');
  assert.equal(statistics.residents.status, 'UNCONFIGURED');
  assert.match(statistics.reviews.evidenceBasis, /routing decisions/);
  console.log('PASS completion windows, non-code rework, overdue questions and missing resident registration');

  const completed = ['auto-task', 'missing-task', 'review-R'].map((name, i) => ({id: `done-${i}`, runId: `run-${i}`, owner: 'owner',
    event: 'finished', t: now - 1000, project: 'p', name, category: name === 'review-R' ? 'review' : 'implement'}));
  fs.writeFileSync(path.join(eventShared, 'worker-events.jsonl'), [...completed,
    {id: 'unknown-done', runId: 'unknown-run', owner: 'owner', event: 'finished', t: now - 1000},
    {id: 'still-running', runId: 'active-run', owner: 'owner', event: 'failed', mayRun: true, project: 'p', name: 'active', t: now - 1000}].map(JSON.stringify).join('\n') + '\n');
  fs.appendFileSync(routeLog, JSON.stringify({kind: 'outcome', project: 'p', name: 'auto-task', t: now - 1000, auto: true, result: 'pass', first: pick}) + '\n');
  fs.appendFileSync(routeLog, JSON.stringify({kind: 'outcome', project: 'p', name: 'auto-task', t: now, correction: true, result: 'rework', rounds: 1, first: pick}) + '\n');
  const beforeCache = fs.readFileSync(cache, 'utf8');
  const machine = JSON.parse(execFileSync(process.execPath, [review, '--hours', '24', '--json', '--cached'], {env: {...env, RULES_SHARED: eventShared}, encoding: 'utf8'}));
  assert.deepEqual([machine.outcomes.autoCoverage.completed, machine.outcomes.autoCoverage.autoCompleted, machine.outcomes.autoCoverage.unknownTerminalIdentity], [2, 1, 1]);
  assert.equal(fs.readFileSync(cache, 'utf8'), beforeCache, 'cached collection never refreshes or rewrites public quota state');
  assert.ok(Number.isFinite(machine.collectedAt)); assert.ok(Number.isFinite(machine.digestChangedAt));
  console.log('PASS terminal-task denominator retains missing outcomes, excludes reviews/active turns, preserves cached state');

  console.log('\nall pass');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
