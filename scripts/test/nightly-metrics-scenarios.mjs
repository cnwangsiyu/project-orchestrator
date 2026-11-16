#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeNightly, metricTable, nightlyBrief } from '../lib/nightly-metrics.mjs';
import { nightlyRecipients, secretaryRecipient, deliveryPlan, decisionMessage, deliverNightly } from '../lib/nightly-delivery.mjs';
import { appendEvent, readEvents, inbox, eventLine } from '../lib/worker-events.mjs';

const now = Date.parse('2026-11-17T12:00:00Z');
const review = {
  reviews: { window: {byProject: {'video-agent': { dispatches: 10, reviews: 1, targetPct: 10, requiredReviews: 0, secondReviewers: 0, reReviews: 0, yield: {blocking: 0, known: 1, unknown: 0} }}}},
  outcomes: {coverage: {completed: 10, autoCompleted: 8}},
  digestChangedAt: now - 2 * 3600000,
  globalRules: {unrouted: [], launchMismatches: [], personalQuotaWithoutOK: [], coverage: {decisionsWithoutLaunchEvidence: 0}, acknowledgements: [
    {project: 'video-agent', orchestrator: 'Video 主对话', session: 'video-session', current: true},
    {project: 'routing', orchestrator: '全局规则主对话', session: 'routing-session', current: true}]},
  workerInbox: [{owner: 'video-session', finishToAckMs: {p90: 30 * 60000}, acknowledged: 1, unacknowledged: 0, totalUnacknowledged: 0, latencyUnknown: 0, launchesWithoutIdentity: 0}],
  companyHealth: [{name: 'trae', ssoExpiresAt: now + 100 * 3600000, quotaExpiresAt: now + 100 * 3600000}]
};
const resources = {coverage: {coveragePct: 80}, utilisation: {
  cpu: {meanIdlePct: 50, hoursIdleAbove50WithReadyTasks: 0, hoursOverGate: 0}, memory: {meanAvailableGiB: 30, minAvailableGiB: 20, pressureHours: 0},
  heavyLanes: {occupancyPct: 50}, queue: {hours: 0}, quota: {ttadk: {tokensUnusedAtReset: 0}}}};
const evidence = {review: '/fixtures/review.json', resources: '/fixtures/resources.json', weekly: '/fixtures/week.json'};
const base = {day: '2026-11-17', review, resources, evidence, now};
const computed = computeNightly(base);
assert.equal(computed.needsModel, false, JSON.stringify(computed.findings));
assert.ok(metricTable(computed).split('\n').length <= 40);
console.log('PASS exact threshold boundaries: 10% review, 30min inbox, 80% outcomes/resources, zero over-gate');

for (const [id, mutate] of [
  ['review-share/video-agent', r => r.reviews.window.byProject['video-agent'].reviews = 2],
  ['unrouted', r => r.globalRules.unrouted = Array.from({length: 4}, () => ({project: 'video-agent', name: 'task'}))],
  ['mismatches', r => r.globalRules.launchMismatches = Array.from({length: 6}, () => ({project: 'video-agent', name: 'task'}))],
  ['personal-approval', r => r.globalRules.personalQuotaWithoutOK = [{project: 'video-agent', name: 'task'}]],
  ['inbox-p90/video-session', r => r.workerInbox[0].finishToAckMs.p90++],
  ['auto-outcomes', r => r.outcomes.coverage.autoCompleted = 7],
  ['sso-expiry-hours/trae', r => r.companyHealth[0].ssoExpiresAt = now + 71 * 3600000],
  ['quota-expiry-hours/trae', r => r.companyHealth[0].quotaExpiresAt = now - 3600000],
]) {
  const r = structuredClone(review); mutate(r);
  const result = computeNightly({...base, review: r});
  assert.deepEqual(result.findings.map(f => f.id), [id]);
  const prompt = nightlyBrief(result, '/fixture/attempt');
  assert.match(prompt, new RegExp('"id": "' + id + '"'));
  assert.doesNotMatch(prompt, /"metrics"/);
}
const overloaded = structuredClone(resources); overloaded.utilisation.cpu.hoursOverGate = .01;
assert.deepEqual(computeNightly({...base, resources: overloaded}).findings.map(f => f.id), ['resource-over-gate-hours']);
const stale = structuredClone(review); stale.globalRules.acknowledgements[0] = {...stale.globalRules.acknowledgements[0], current: false, at: now - 72 * 3600000};
assert.equal(computeNightly({...base, review: stale}).findings.some(f => f.class === 'stale-rules'), false, 'fresh digest gets 24h grace');
stale.digestChangedAt = now - 25 * 3600000;
assert.equal(computeNightly({...base, review: stale}).findings.some(f => f.class === 'stale-rules'), true);
console.log('PASS every configured anomaly triggers with evidence; digest age determines stale-ack grace');

const missing = computeNightly({...base, resources: null, review: null});
assert.ok(missing.unknownClasses.length); assert.ok(missing.findings.some(f => f.id === 'new-unknown-classes'));
const repeated = computeNightly({...base, resources: null, review: null, previousUnknownClasses: missing.unknownClasses});
assert.equal(repeated.needsModel, false);
assert.equal(computeNightly({...base, day: '2026-11-16'}).weekly, true);
const crowded = {...computed, metrics: Array.from({length: 100}, (_, i) => ({id: 'metric-' + i, value: i, comparison: 'observe', status: 'OK'}))};
assert.equal(metricTable(crowded).split('\n').length, 40);
console.log('PASS new UNKNOWN classes trigger once, Monday exception, table always <=40 lines');

const recipients = nightlyRecipients(review, [{name: '工作秘书 mini', sessionId: 'secretary-session', host: 'mini'}], 'Remote 主对话\n# comment');
const refreshed = nightlyRecipients(review, [{name: 'Video 主对话', sessionId: 'new-video-session'},
  {name: '工作秘书 mini', sessionId: 'secretary-session'}, {name: 'routing-nightly-secretary-relay', sessionId: 'relay-worker'}]);
assert.equal(refreshed.find(r => r.project === 'video-agent').owner, 'new-video-session');
assert.equal(secretaryRecipient(refreshed).owner, 'secretary-session');
assert.ok(!refreshed.some(r => r.owner === 'relay-worker'));
const r = structuredClone(review); r.globalRules.unrouted = [{project: 'video-agent', name: 'v1'}, {project: 'routing', name: 'r1'}, {project: 'video-agent', name: 'v2'}, {project: 'routing', name: 'r2'}];
const result = computeNightly({...base, review: r});
const decision = {id: 'd1', question: '是否调整?', options: [{label: '保持', description: '沿用当前策略'}, {label: '调整', description: '另行评估'}], recommended: 0, default: '不回答则保持现状'};
const plan = deliveryPlan(result, {actions: [], decisions: [decision]}, recipients, '/fixture/report.md');
assert.equal(plan.messages.length, 3);
assert.match(plan.messages.find(m => m.owner === 'video-session').text, /v1, v2/);
assert.doesNotMatch(plan.messages.find(m => m.owner === 'video-session').text, /r1|r2/);
assert.match(plan.messages.find(m => m.owner === 'routing-session').text, /r1, r2/);
assert.match(plan.messages.find(m => m.secretary).text, /保持（推荐）[\s\S]*不回答则保持现状/);
assert.throws(() => decisionMessage(base.day, [{...decision, default: ''}], '/report'), /explicit default/);
assert.throws(() => deliveryPlan(result, {actions: [{orchestrator: 'Video 主对话', findingIds: ['made-up'], text: 'act'}]}, recipients, '/report'), /owned/);
const weeklyResult = computeNightly({...base, day: '2026-11-16'});
const weeklyPlan = deliveryPlan(weeklyResult, {actions: [{orchestrator: 'Video 主对话', findingIds: ['weekly-full-review'], project: 'video-agent', evidence: ['/fixtures/week.json#video-agent'], text: 'own weekly proposal'}]}, recipients, '/report');
assert.equal(weeklyPlan.messages.length, 1); assert.equal(weeklyPlan.messages[0].owner, 'video-session');
console.log('PASS recipient isolation, one secretary decision bundle, validated defaults and model action scope');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-delivery-'));
const saved = process.env.RULES_SHARED; process.env.RULES_SHARED = tmp;
try {
  let receipt = await deliverNightly(plan, {day: base.day, outFile: path.join(tmp, 'outbox.json')});
  assert.equal(receipt.delivery, 'sent'); assert.equal(readEvents().length, 3);
  receipt = await deliverNightly(plan, {day: base.day, outFile: path.join(tmp, 'outbox.json')});
  assert.equal(readEvents().length, 3, 'replay after receipt loss stays deduplicated');
  assert.equal(inbox(readEvents(), 'video-session').pending.length, 1);
  assert.equal(inbox(readEvents(), 'secretary-session').pending.length, 1);
  assert.match(eventLine(inbox(readEvents(), 'secretary-session').pending[0]), /不回答则保持现状/);
  const longText = '选项说明'.repeat(1000) + '\n不回答则保持现状';
  const longReceipt = await deliverNightly({messages: [{owner: 'long-secretary', recipient: '工作秘书 mini', secretary: true, text: longText}], unresolved: []},
    {day: base.day, outFile: path.join(tmp, 'outbox.json')});
  assert.equal(longReceipt.delivery, 'sent');
  const longEvent = readEvents().find(e => e.owner === 'long-secretary');
  assert.ok(longEvent.text.length < 2000); assert.match(longEvent.text, /必须读取/);
  assert.equal(fs.readFileSync(longEvent.outFile, 'utf8'), longText + '\n');
  let relays = 0;
  receipt = await deliverNightly({messages: [{...plan.messages.at(-1), owner: null}], unresolved: []}, {
    day: base.day, outFile: '/outbox', append: appendEvent, relaySecretary: async m => { relays++; assert.equal(m.recipient, '工作秘书 mini'); }});
  assert.equal(relays, 1); assert.equal(receipt.sent[0].delivery, 'secretary-relay');
  receipt = await deliverNightly({messages: [{owner: null, recipient: null, secretary: true}], unresolved: []}, {day: base.day, outFile: '/outbox'});
  assert.equal(receipt.delivery, 'blocked');
  console.log('PASS real fixture inbox API, replay dedup, secretary-only relay and missing-identity block');
} finally { if (saved === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = saved; fs.rmSync(tmp, {recursive: true, force: true}); }
