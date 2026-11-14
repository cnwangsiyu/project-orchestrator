#!/usr/bin/env node
// cyberPolicy classification and the kind:'policy-block' record (2026-11-13): a blocked GPT security review must be
// recognised, recorded for the nightly review, and never paused or retried as an infrastructure failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPolicyBlock, policyBlockRecord, appendPolicyBlock, POLICY_BLOCK_RE, policyBlockAction } from '../lib/policy-block.mjs';
import { noteFailure, notePolicyRestriction, readPoolPauses } from '../lib/trae-health.mjs';

let fail = 0;
const check = (label, fn) => { try { fn(); console.log(`ok   ${label}`); } catch (e) { fail++; console.log(`FAIL ${label}: ${e.message}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-block-test-'));
const turn = (status, error) => ({ status, error });

check('classifies codexErrorInfo=cyberPolicy and the vendor message, only on failed turns', () => {
  assert.equal(POLICY_BLOCK_RE.test('{"codexErrorInfo":"cyberPolicy"}'), true);
  assert.equal(isPolicyBlock(turn('failed', { codexErrorInfo: 'cyberPolicy' })), true);
  assert.equal(isPolicyBlock(turn('failed', 'flagged for possible cybersecurity risk; apply for Daybreak access')), true);
  assert.equal(isPolicyBlock(turn('completed', { codexErrorInfo: 'cyberPolicy' })), false);
  assert.equal(isPolicyBlock(turn('failed', 'rate limit exceeded')), false);
  assert.equal(isPolicyBlock(turn('failed', null)), false);
  assert.equal(isPolicyBlock(null), false);
});

check('record shape carries account/model/vendor and the capped error text', () => {
  const rec = policyBlockRecord({ account: 'ttadk', vendor: 'codex', model: 'gpt-6.1-sol', error: { codexErrorInfo: 'cyberPolicy' }, t: 42 });
  assert.deepEqual({ ...rec, why: undefined }, { kind: 'policy-block', t: 42, account: 'ttadk', vendor: 'codex', model: 'gpt-6.1-sol', why: undefined });
  assert.match(rec.why, /cyberPolicy/);
  const long = policyBlockRecord({ error: 'x'.repeat(2000) });
  assert.equal(long.why.length, 500);
  assert.deepEqual(policyBlockRecord({}), { kind: 'policy-block', t: policyBlockRecord({}).t, account: null, vendor: 'codex', model: null, why: '""' });
});

check('appends one JSONL row and creates the log directory', () => {
  const log = path.join(tmp, 'nested', 'route-log.jsonl');
  appendPolicyBlock(log, policyBlockRecord({ account: 'trae', vendor: 'trae', model: 'gpt-6.1-sol', error: 'cyberPolicy', t: 7 }));
  appendPolicyBlock(log, policyBlockRecord({ account: 'ttadk', model: 'gpt-6.1-sol', error: 'cyberPolicy', t: 8 }));
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'policy-block'); assert.equal(rows[0].account, 'trae'); assert.equal(rows[0].vendor, 'trae');
  assert.equal(rows[1].t, 8);
});

check('TRAE records the 983-style restriction, TTADK stays telemetry-only', () => {
  const t = Date.parse('2026-11-13T21:00:00Z'), midnight = Date.parse('2026-11-14T00:00:00Z');
  assert.deepEqual(policyBlockAction('trae'), { restrictFamily: true });
  assert.deepEqual(policyBlockAction('ttadk'), { restrictFamily: false });
  assert.deepEqual(policyBlockAction(undefined), { restrictFamily: false });
  // TRAE: the worker applies the same health record as a 983 restriction, so route.mjs skips the gpt family.
  const traeHome = path.join(tmp, 'trae'); fs.mkdirSync(traeHome);
  const p = notePolicyRestriction(traeHome, 'cyberPolicy blocked this turn: {"codexErrorInfo":"cyberPolicy"}', t, 'GPT-6.1-Sol');
  assert.equal(p.pool, 'gpt'); assert.equal(p.restricted, true); assert.equal(p.kind, 'hard'); assert.equal(p.pausedUntil, midnight);
  assert.match(p.reason, /cyberPolicy/); assert.match(p.reason, /00:00 UTC/);
  assert.equal(readPoolPauses(traeHome, t + 1).gpt?.restricted, true);
  const health = JSON.parse(fs.readFileSync(path.join(traeHome, 'worker-health.json'), 'utf8'));
  assert.equal(health.pools.gpt.restricted, true); assert.equal(health.pools.gpt.pausedUntil, midnight);
  // TTADK: the same decision seam writes no health record and pauses nothing.
  const ttadkHome = path.join(tmp, 'ttadk'); fs.mkdirSync(ttadkHome);
  if (policyBlockAction('ttadk').restrictFamily) notePolicyRestriction(ttadkHome, 'cyberPolicy', t, 'gpt-6.1-sol');
  assert.equal(fs.existsSync(path.join(ttadkHome, 'worker-health.json')), false);
  assert.deepEqual(readPoolPauses(ttadkHome, t + 1), {});
});

check('the policy restriction matches the 983 record and scopes to the model family', () => {
  const t = Date.parse('2026-11-13T21:00:00Z');
  const r983Home = path.join(tmp, 'r983'); fs.mkdirSync(r983Home);
  const polHome = path.join(tmp, 'pol'); fs.mkdirSync(polHome);
  const r983 = noteFailure(r983Home, 'stream disconnected: Model access temporarily restricted. (983)', t, 'GPT-6.1-Sol');
  const pol = notePolicyRestriction(polHome, 'cyberPolicy blocked this turn', t, 'GPT-6.1-Sol');
  for (const k of ['pool', 'kind', 'restricted', 'pausedUntil']) assert.equal(pol[k], r983[k], k);
  // A DeepSeek block restricts only deepseek; the gpt family stays untouched.
  const deep = notePolicyRestriction(polHome, 'cyberPolicy blocked this turn', t, 'deepseek-v4.1-flash');
  assert.equal(deep.pool, 'deepseek');
  const pools = JSON.parse(fs.readFileSync(path.join(polHome, 'worker-health.json'), 'utf8')).pools;
  assert.equal(pools.deepseek.restricted, true); assert.equal(pools.gpt.restricted, true);
  // No model → no family to scope; nothing is written and the caller keeps the policy-block row.
  const noModelHome = path.join(tmp, 'nomodel'); fs.mkdirSync(noModelHome);
  assert.equal(notePolicyRestriction(noModelHome, 'cyberPolicy', t, null), null);
  assert.equal(fs.existsSync(path.join(noModelHome, 'worker-health.json')), false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
