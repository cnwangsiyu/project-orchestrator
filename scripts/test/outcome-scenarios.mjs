#!/usr/bin/env node
// Exercise the outcome/review CLIs with synthetic logs and stubbed provider commands only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dedupeOutcomes } from '../lib/state.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-test-'));
const log = path.join(tmp, 'routes.jsonl'), cache = path.join(tmp, 'quota.json'), profiles = path.join(tmp, 'profiles.json');
const bin = path.join(tmp, 'bin'), now = Date.now(), h = 3600000;
const pick = (account, model = 'gpt-6.1-sol', vendor = 'codex') => ({ vendor, model, effort: 'high', account });
const route = (name, extra = {}) => ({ t: now - h, project: 'p', name, category: 'implement', impact: 'release', pick: pick('ttadk'), ...extra });
const outcome = (name, extra = {}) => ({ t: now - h, kind: 'outcome', project: 'p', name, result: 'rework', rounds: 2,
  cause: 'code', retries: 3, scopeChanges: 1, reviewed: true, minutes: 12, first: pick('ttadk'), accepted: pick('ttadk'),
  category: 'implement', impact: 'release', ...extra });
const rows = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const append = (r) => fs.appendFileSync(log, JSON.stringify(r) + '\n');
const env = { ...process.env, HOME: tmp, PATH: `${bin}:${process.env.PATH}`, CODEX_ACCOUNTS: profiles, QUOTA_CACHE: cache,
  ROUTE_LOG_FILE: log, QUOTA_LOG_FILE: path.join(tmp, 'empty-quota-log'), QUOTA_LOG: '0', TRAE_PROBE: '0' };
const cli = (...args) => execFileSync(process.execPath, [path.join(scripts, 'outcome.mjs'), '--project', 'p', ...args],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf \'fixture\\n\'\n', { mode: 0o755 });
  fs.writeFileSync(profiles, JSON.stringify({ main: { home: path.join(tmp, 'main') }, trae: { kind: 'trae', home: path.join(tmp, 'trae') } }));
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, claude: [{ label: 'week (all models)', used: 10, resetsAt: now + 120 * h, windowMins: 10080 }], codexAccounts: [], errors: {}, history: {} }));
  fs.writeFileSync(log, [route('T72'), outcome('T72')].map(JSON.stringify).join('\n') + '\n');
  const before = fs.readFileSync(log, 'utf8');
  cli('--name', 'p-T72', '--correct', '--result', 'pass', '--rounds', '0', '--note', 'bookkeeping');
  assert.ok(fs.readFileSync(log, 'utf8').startsWith(before));
  const correction = rows().at(-1);
  assert.equal(correction.correction, true); assert.equal(correction.rounds, 0);
  for (const field of ['reviewed', 'minutes', 'cause', 'retries', 'scopeChanges', 'first', 'accepted']) assert.ok(!Object.hasOwn(correction, field));
  let effective = dedupeOutcomes(rows().filter((r) => r.kind === 'outcome'))[0];
  assert.equal(effective.result, 'pass'); assert.equal(effective.reviewed, true); assert.equal(effective.minutes, 12);
  assert.equal(effective.dupes, 1); assert.equal(effective.retries, 3);
  const count = rows().length;
  for (const args of [
    ['--name', 'absent', '--correct', '--result', 'pass'],
    ['--name', 'absent', '--actual', 'codex:gpt-6.1-sol:high@trae'],
    ['--name', 'T72', '--actual', 'codex:gpt-6.1-sol:high'],
    ['--name', 'T72', '--actual', 'codex:gpt-6.1-sol:typo@trae'],
    ['--name', 'T72', '--actual', 'codex:gpt-6.1-sol:high@trae', '--actual'],
    ['--name', 'T72', '--result', 'pass', '--rounds'],
  ]) assert.throws(() => cli(...args), (e) => e.status === 2);
  assert.equal(rows().length, count);
  console.log('ok   append-only correction, prefix join, metadata inheritance and validation');

  append(route('T63')); append(outcome('T63'));
  cli('--name', 'T63', '--correct', '--result', 'fail', '--rounds', 'null', '--cause', 'code',
    '--actual', 'codex:gpt-6.1-sol:xhigh@trae', '--actual', 'codex:deepseek-v4-pro:xhigh@trae');
  assert.deepEqual(rows().at(-1).actual.map((p) => p.model), ['gpt-6.1-sol', 'deepseek-v4-pro']);
  assert.equal(rows().at(-1).rounds, null);
  append(route('T37')); append(outcome('T37', { result: 'fail', cause: 'infra', minutes: 60 }));
  cli('--name', 'T37', '--actual', 'codex:gpt-6.1-sol:medium@main', '--actual', 'codex:gpt-6.1-sol:medium@trae', '--note', 'mixed harness');
  assert.ok(!Object.hasOwn(rows().at(-1), 'result')); assert.ok(!Object.hasOwn(rows().at(-1), 'rounds'));
  effective = dedupeOutcomes(rows().filter((r) => r.kind === 'outcome')).find((o) => o.name === 'T37');
  assert.equal(effective.result, 'fail'); assert.equal(effective.cause, 'infra'); assert.equal(effective.minutes, 60);
  append(route('actualNew'));
  cli('--name', 'actualNew', '--result', 'pass', '--reviewed', '--actual', 'claude:opus:high@main');
  assert.equal(rows().at(-1).actual[0].vendor, 'claude');
  console.log('ok   ordered actual launches, null rounds, metadata-only append and normal recording');

  // Later normal duplicates cannot resurrect MAX rounds after an explicit correction.
  cli('--name', 'T72', '--result', 'rework', '--rounds', '9', '--cause', 'code');
  append(route('background', { background: true }));
  append(route('background-fix1', { background: true }));
  append(outcome('background', { result: 'pass', rounds: 0, minutes: 120 }));
  append(route('queued', { background: true, pick: null, deferred: 'waiting' }));
  append(route('old-background', { t: now - 30 * h, background: true }));
  append(outcome('old-background', { result: 'pass', rounds: 0, minutes: 1500 }));
  append(route('background-R', { background: true, category: 'review' }));
  const factors = { selected: true, triggers: ['TTADK projected to run out'], remainingShare: 0.62,
    load: { percent: 35, t: now - h }, queue: { position: 250, t: now - h }, burn: { beforeReset: true, outAt: now + h } };
  append(route('balanced', { company: 'trae', pick: pick('trae'), balance: factors, why: ['balanced to TRAE: TTADK projected to run out'] }));
  append(route('not-balanced', { company: 'ttadk', balance: { ...factors, selected: false } }));
  append(route('old-balanced', { t: now - 30 * h, company: 'trae', balance: factors }));
  const hour = Math.floor(now / h) * h - 2 * h;
  const snapshot = (t, used, load, position) => ({ t, ttadk: { name: 'ttadk', used, limit: 100, resetsAt: now + h },
    trae: { name: 'trae', daily: { 'gpt-6.1-sol': { used: 40, limit: 100, resetsAt: now + h } },
      load: { 'gpt-6.1-sol': { percent: load, t } }, queue: { gpt: { position, t, state: 'queued' } } } });
  const observations = [snapshot(hour + 1000, 80, 35, 250), snapshot(hour + 5000, 100, 70, 500),
    { t: hour + h + 1000, ttadk: { name: 'ttadk', used: 0, limit: 100, resetsAt: now + 25 * h } }];
  fs.writeFileSync(env.QUOTA_LOG_FILE, [...observations, snapshot(now - 30 * h, 30, 1, 1), { t: now }].map(JSON.stringify).join('\n') + '\n');
  const beforeReview = fs.readFileSync(log, 'utf8');
  const report = JSON.parse(execFileSync(process.execPath, [path.join(scripts, 'review-data.mjs'), '--json'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(fs.readFileSync(log, 'utf8'), beforeReview);
  const out = report.outcomes;
  assert.equal(out.recorded, 6); assert.equal(out.corrections, 2);
  assert.deepEqual(out.duplicates.sort(), ['p/T37 ×2', 'p/T72 ×2']);
  const corrected = out.corrected.find((o) => o.task.endsWith('/T72'));
  assert.equal(corrected.from.rounds, 9); assert.equal(corrected.to.rounds, 0); assert.equal(corrected.to.result, 'pass');
  assert.equal(out.byVendor.claude.tasks, 1); assert.equal(out.byVendor.codex.tasks, 5);
  assert.equal(out.byVendorCategory['claude:implement'].tasks, 1);
  assert.equal(out.reviewedReleaseByVendor.claude.tasks, 1);
  assert.equal(out.byModel['codex:gpt-6.1-sol:xhigh'].tasks, 1);
  assert.equal(out.byModelAccount['codex:gpt-6.1-sol:xhigh@trae'].tasks, 1);
  assert.equal(out.byModelAccount['codex:gpt-6.1-sol:xhigh@ttadk'], undefined);
  assert.deepEqual(out.actualMismatches.map((o) => o.task).sort(), ['p/T37', 'p/T63', 'p/actualNew']);
  assert.equal(out.fails.find((o) => o.name === 'T63').actual.length, 2);
  assert.ok(out.traeVsCodex.mixed.some((o) => o.task === 'p/T37' && o.cause === 'infra'));
  assert.equal(out.traeVsCodex.rows.find((o) => o.key === 'gpt-6.1-sol').trae.tasks, 1);
  assert.deepEqual(report.background, { tasks: 3, completed: 2, timed: 2, totalMinutes: 1620, meanMinutes: 810 });
  console.log('ok   review-data corrections, effective attribution, mixed harnesses and background wall-clock summary');
  const policy = report.routing.companyPolicies;
  assert.equal(policy.balanced, 1); assert.equal(policy.background, 4); // Dispatches include the review; background.tasks does not.
  assert.equal(policy.decisions.length, 6); assert.ok(!policy.decisions.some((r) => r.name === 'old-balanced'));
  assert.deepEqual(policy.decisions.find((r) => r.name === 'balanced').balance, factors);
  assert.deepEqual(policy.decisions.find((r) => r.name === 'balanced').why, ['balanced to TRAE: TTADK projected to run out']);
  const hourly = report.quota.companyByHour, firstHour = new Date(hour).toISOString().slice(0, 13) + ':00:00Z';
  assert.equal(Object.keys(hourly).length, 2);
  assert.deepEqual(hourly[firstHour], observations.slice(0, 2));
  assert.equal(hourly[firstHour][1].trae.queue.gpt.position, 500); // Preserve the peak, not an hourly average.
  assert.deepEqual(Object.values(hourly)[1], [{ ...observations[2], trae: null }]);
  console.log('ok   nightly tuning: dispatch counts/factors, effective account outcomes and timestamped hourly company telemetry');
  console.log('\nall pass');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
