#!/usr/bin/env node
// Missing Astra load: fixture-only adapter, public queue/health metadata, no hubs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { noteFailure, noteSuccess } from '../lib/trae-health.mjs';

const route = new URL('../route.mjs', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-telemetry-'));
const home = path.join(tmp, 'trae'); fs.mkdirSync(home);
const now = 1800000000000, minute = 60000, ASTRA = 'gpt-6-astra', SOL = 'gpt-6.1-sol';
const env = { ...process.env, HOME: tmp, RULES_SHARED: tmp, ROUTE_NOW: String(now),
  CODEX_ACCOUNTS: path.join(tmp, 'accounts.json'), QUOTA_CACHE: path.join(tmp, 'cache.json'),
  ROUTE_LOG_FILE: path.join(tmp, 'routes.jsonl'), QUOTA_LOG_FILE: path.join(tmp, 'quota-log.jsonl'),
  ROUTE_RR: path.join(tmp, 'rotation'), ROUTE_LOG: '0', QUOTA_LOG: '0', TRAE_PROBE: '0' };
delete env.ROUTE_SNAPSHOT_FILE;
fs.writeFileSync(env.CODEX_ACCOUNTS, JSON.stringify({ trae: { kind: 'trae', home },
  ttadk: { kind: 'ttadk', home: path.join(tmp, 'ttadk') } }));
const bucket = (used = 0, limit = 58) => ({ used, limit, remaining: limit - used, depleted: used >= limit, resetsAt: now + 12 * 3600000 });
const fixture = () => ({ checkedAt: now, codexAccounts: [
  { name: 'trae', kind: 'trae', home, healthy: true, live: true, seenAt: now,
    models: [ASTRA, SOL], modelIds: { [ASTRA]: 'GPT-6-Astra', [SOL]: 'GPT-6.1-Sol' },
    load: { [SOL]: { percent: 35, t: now } }, windows: [],
    quota: { sampledAt: now, daily: { [ASTRA]: bucket(), [SOL]: bucket(20, 80) } } },
  { name: 'ttadk', kind: 'ttadk', home: path.join(tmp, 'ttadk'), healthy: true, live: true,
    seenAt: now, models: [SOL], windows: [], usage: { used: 10, limit: 100, resetsAt: now + 12 * 3600000 } },
] });
const write = (file, value) => fs.writeFileSync(path.join(home, file), JSON.stringify(value));
const clear = () => {
  for (const file of ['queue-status.json', 'thread-models.json', 'lane-state.json', 'queue-state.json', 'worker-health.json']) fs.rmSync(path.join(home, file), { force: true });
};
let checks = 0;
const check = (label, setup, expected = ASTRA, account = 'trae', args = []) => {
  clear(); const raw = fixture(); setup?.(raw.codexAccounts[0], raw);
  fs.writeFileSync(env.QUOTA_CACHE, JSON.stringify(raw));
  const o = JSON.parse(execFileSync(process.execPath, [route, 'implement-hard', '--impact', 'service', '--writes', ...args, '--dry', '--json'],
    { env, encoding: 'utf8', maxBuffer: 16 << 20 }));
  assert.equal(o.kind, 'launch', label); assert.equal(o.pick.model, expected, label); assert.equal(o.pick.account, account, label);
  assert.ok(o.pick.command); assert.equal(o.needsUserOK.length, 0, label);
  if (expected === ASTRA && !raw.codexAccounts[0].load[ASTRA]) {
    const units=raw.codexAccounts[0].quota.daily[ASTRA];
    assert.ok(o.why.some(s=>s.includes(`Astra load not published; units ${units.used}/${units.limit} used; no queue observed`)));
    assert.equal(o.plan.primary.estimate.balance.load, null);
    assert.deepEqual(o.plan.primary.estimate.balance.astraUnitsEvidence, { used: units.used, limit: units.limit });
  }
  checks++; console.log(`PASS ${label}: ${expected}@${account}`); return o;
};
try {
  check('no load, fresh units, no queue');
  const newer = 'gpt-6.2-astra';
  const upgraded = tr => { tr.models.push(newer); tr.quota.daily[newer] = bucket(1); };
  check('TRAE selects its newest listed Astra with fresh daily units', upgraded, newer);
  const retry = check('quality retry on upgraded Astra advances effort', upgraded, newer, 'trae',
    ['--failures', '1', '--actual', `codex:${ASTRA}:high@trae`]);
  assert.equal(retry.pick.effort, 'xhigh');
  check('unversioned Astra exclusion covers the upgraded TRAE lane', upgraded, SOL, 'trae', ['--exclude-model', 'astra']);
  check('upgraded Astra retains queue evidence across Sol success', tr => {
    upgraded(tr); noteFailure(home, 'stalled', now - minute, newer); noteSuccess(home, SOL, now);
  }, SOL);
  check('one unit remaining still qualifies', tr => { tr.quota.daily[ASTRA] = bucket(57); });
  check('Sol retry uses free Astra when no Sol company lane is free', (tr, raw) => {
    delete tr.load[SOL]; raw.codexAccounts.find(a=>a.kind==='ttadk').healthy=false;
  }, ASTRA, 'trae',
    ['--failures', '1', '--actual', `codex:${SOL}:xhigh@trae`]);
  check('sibling load cannot stand in for Astra', tr => { tr.load[SOL].percent = 95; });
  check('no load, depleted bucket', tr => { tr.quota.daily[ASTRA] = bucket(58); }, SOL);
  check('no load, explicit zero remaining', tr => { tr.quota.daily[ASTRA].remaining = 0; }, SOL);
  check('no load, expired units', tr => { tr.quota.daily[ASTRA].resetsAt = now - 1; }, SOL);
  check('no load, stale quota sample', tr => { tr.quota.sampledAt = now - 30 * minute - 1; }, SOL, 'ttadk');
  check('no load, missing bucket', tr => { delete tr.quota.daily[ASTRA]; }, SOL);
  check('healthy hub required', tr => { tr.healthy = false; }, SOL, 'ttadk');
  check('positive auth does not substitute for hub health', tr => { tr.healthy=false; tr.auth=true; tr.transport=true; }, SOL);
  check('unknown hub health does not qualify', tr => { delete tr.healthy; tr.auth=true; tr.transport=true; }, SOL);
  check('published Astra load 70', tr => { tr.load[ASTRA] = { percent: 70, t: now }; }, SOL);
  check('published Astra load 60', tr => { tr.load[ASTRA] = { percent: 60, t: now }; }, SOL);
  const loaded = check('published Astra load 55', tr => { tr.load[ASTRA] = { percent: 55, t: now }; });
  assert.match(loaded.why.join('\n'), /gpt-6-astra load 55%/);
  check('published free depleted lane unchanged', tr => {
    tr.load[ASTRA] = { percent: 55, t: now }; tr.quota.daily[ASTRA] = bucket(58);
    write('lane-state.json', { [ASTRA]: { t: now, position: 0, state: 'ready' } });
  });
  check('depleted units cannot replace unpublished load even with ready telemetry', tr => {
    tr.quota.daily[ASTRA] = bucket(58); write('lane-state.json', { [ASTRA]: { t: now, position: 0, state: 'ready' } });
  }, SOL);
  for (const state of ['queued', 'waiting']) check(`fresh Astra lane ${state}`, () => {
    write('lane-state.json', { [ASTRA]: { t: now, position: 10, state, drainPerMin: state === 'waiting' ? 0 : 5 } });
  }, SOL);
  check('fresh family queue retained', () => { write('queue-state.json', { gpt: { t: now, position: 10, state: 'queued' } }); }, SOL, 'ttadk');
  for (const state of ['queued', 'waiting', 'stalled']) check(`recent Astra turn ${state}`, () => {
    write('thread-models.json', { thread: 'GPT-6-Astra' });
    write('queue-status.json', { thread: { at: now - minute, position: 10, state, turnId: 'fixture' } });
  }, SOL);
  check('recent Sol queue does not veto Astra', () => {
    write('thread-models.json', { thread: SOL }); write('queue-status.json', { thread: { at: now - minute, position: 10, state: 'queued' } });
  });
  check('cleared recent Astra turn', () => {
    write('thread-models.json', { thread: ASTRA }); write('queue-status.json', { thread: { at: now - minute, position: 0, state: 'ready' } });
  });
  check('stale recent queue ignored', () => {
    write('thread-models.json', { thread: ASTRA }); write('queue-status.json', { thread: { at: now - 30 * minute - 1, position: 10, state: 'queued' } });
  });
  for (const why of ['request queue size is exceed', 'stalled 1 min (queued for capacity?)', 'queuing for capacity', 'queues full', 'REQUEST_QUEUE_FULL']) check(`recent health ${why}`, () => {
    noteFailure(home, why, now - minute, 'GPT-6-Astra');
  }, SOL);
  check('legacy health model attribution', () => {
    write('worker-health.json', { pools: { gpt: { model: ASTRA, failures: [{ t: now - minute, why: 'stalled' }] } } });
  }, SOL);
  check('older Astra failure remains attributed after Sol failure', () => {
    noteFailure(home, 'request queue size is exceed', now - minute, ASTRA);
    noteFailure(home, 'gateway error', now - minute / 2, SOL);
  }, SOL, 'ttadk');
  check('Sol success retains recent Astra queue evidence', () => {
    noteFailure(home, 'request queue size is exceed', now - minute, ASTRA); noteSuccess(home, SOL, now);
  }, SOL);
  check('Astra success clears its queue evidence', () => {
    noteFailure(home, 'request queue size is exceed', now - minute, ASTRA); noteSuccess(home, ASTRA, now);
  });
  check('expired Astra pause still records its recent queue', () => {
    noteFailure(home, 'request queue size is exceed', now - 9 * minute, ASTRA);
    noteFailure(home, 'request queue size is exceed', now - 8 * minute, ASTRA);
    noteFailure(home, 'gateway error', now - minute, SOL);
  }, SOL);
  check('Sol pause reason is not attributed to later Astra failure', () => {
    noteFailure(home, 'request queue size is exceed', now - 9 * minute, SOL);
    noteFailure(home, 'request queue size is exceed', now - 8 * minute, SOL);
    noteFailure(home, 'gateway error', now - minute, ASTRA);
  });
  check('stale health signal ignored', () => { noteFailure(home, 'stalled', now - 30 * minute - 1, ASTRA); });
  check('installation error is not a stall signal', () => { noteFailure(home, 'package installation failed', now - minute, ASTRA); });
  check('corrupt recent queue cannot assert a clear lane', () => { fs.writeFileSync(path.join(home, 'queue-status.json'), '{bad'); }, SOL);
  check('corrupt lane telemetry cannot assert a clear lane', () => { fs.writeFileSync(path.join(home, 'lane-state.json'), '{bad'); }, SOL);
  check('Sol missing load still needs its normal evidence', tr => {
    delete tr.load[SOL]; tr.quota.daily[ASTRA] = bucket(58);
  }, SOL, 'ttadk');
  console.log(`Astra telemetry: ${checks} scenarios passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
