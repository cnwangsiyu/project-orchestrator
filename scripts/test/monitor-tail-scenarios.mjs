#!/usr/bin/env node
// Fixture-only monitoring scenarios. No live account, resident, install or registry mutations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-tail-'));
const previous = { HOME: process.env.HOME, RULES_SHARED: process.env.RULES_SHARED, MONITOR_OWNER: process.env.MONITOR_OWNER };
process.env.HOME = tmp;
const shared = path.join(tmp, '.claude/orchestrator/_shared');
process.env.RULES_SHARED = shared;
process.env.MONITOR_OWNER = 'owner-full';
fs.mkdirSync(shared, { recursive: true });
const now = Date.now(), minute = 60000, h = 60 * minute;
try {
  const { checkResidents } = await import('../resident-check.mjs');
  const { appendEvent, readEvents } = await import('../lib/worker-events.mjs');
  const { notifyMonitorFailure } = await import('../lib/monitor-notify.mjs');
  const { notifySampleFailures } = await import('../resource-sample.mjs');
  const { probeHub, writeHubState } = await import('../lib/hub-state.mjs');
  const { runningWorkers } = await import('../lib/running-workers.mjs');
  const { auditGlobalRules } = await import('../lib/global-rules-audit.mjs');
  const { auditLaunch } = await import('../lib/global-rules.mjs');
  const { dedupeOutcomes, modelView } = await import('../lib/state.mjs');
  const { passwordStyleFindings } = await import('../lib/nightly-audit.mjs');
  const heartbeat = path.join(tmp, 'resident.heartbeat');
  const registryFile = path.join(shared, 'resident-workers.json');
  const entry = { name: 'watcher', owner: 'owner-full', heartbeatFile: heartbeat, maxAgeMinutes: 10, notify: 'worker-event' };
  fs.writeFileSync(heartbeat, 'not read'); fs.writeFileSync(registryFile, JSON.stringify([entry]));
  assert.equal(checkResidents({ now }).status, 'HEALTHY');
  fs.utimesSync(heartbeat, (now - 20 * minute) / 1000, (now - 20 * minute) / 1000);
  assert.equal(checkResidents({ now, notify: true }).missing[0].status, 'STALE');
  checkResidents({ now: now + 2 * h, notify: true });
  assert.equal(readEvents().filter(row => row.resident && row.event === 'stalled').length, 1);
  // Incident state outlives event retention/acknowledgement.
  fs.writeFileSync(path.join(shared, 'worker-events.jsonl'), '');
  checkResidents({ now: now + 8 * 24 * h, notify: true });
  assert.equal(readEvents().length, 0);
  fs.utimesSync(heartbeat, now / 1000, now / 1000); checkResidents({ now, notify: true });
  fs.unlinkSync(heartbeat); checkResidents({ now, notify: true });
  assert.equal(readEvents().filter(row => row.event === 'stalled').length, 1);
  assert.equal(readEvents().find(row => row.event === 'stalled').owner, 'owner-full');
  fs.writeFileSync(registryFile, '{broken'); assert.equal(checkResidents().status, 'UNKNOWN');
  console.log('PASS BC-16 resident heartbeat, missing/UNKNOWN, persistent dedup and recovery');

  const sample = { failedProbes: ['CPU'], heavyLocks: { complete: false, journal: { complete: false } }, hubSupervisors: { complete: false } };
  assert.equal(notifySampleFailures(sample).filter(r => r.notified).length, 3);
  assert.equal(notifySampleFailures(sample).filter(r => r.suppressed).length, 3);
  assert.equal(notifyMonitorFailure('sampler/CPU', { now: Date.now() + 6 * h }).notified, true);
  assert.equal(notifyMonitorFailure('sampler/CPU', { owner: null }).unknown, 'monitoring owner is unconfigured');
  const before = readEvents().length;
  writeHubState(tmp, 'fixture', { mode: 'BACKOFF', failures: 1, t: now, retryAt: now + h, reason: 'CHILD_EXIT' });
  assert.equal(readEvents().length, before + 1);
  writeHubState(tmp, 'fixture', { mode: 'BACKOFF', failures: 2, t: now, retryAt: now + h, reason: 'CHILD_EXIT' });
  assert.equal(readEvents().length, before + 1);
  assert.ok(readEvents().filter(row => row.monitorCause).every(row => row.owner === 'owner-full'));
  for (let n = 0; n < 2; n++) {
    const checked = spawnSync(process.execPath, [path.join(scripts, 'resource-review.mjs'), '--json'], { env: process.env, encoding: 'utf8' });
    assert.equal(checked.status, 2); assert.equal(JSON.parse(checked.stdout).freshness.status, 'UNKNOWN');
  }
  assert.equal(readEvents().filter(row => row.monitorCause === 'resource-telemetry/freshness-timeout').length, 1);
  console.log('PASS AU-5 sampler, lock telemetry and hub failures wake owner once per cause per 6h');

  const up = await probeHub({ home: tmp, account: 'fixture', hub: 'ws://127.0.0.1:1', health: async () => true, probe: async () => ({}) });
  const slow = await probeHub({ home: tmp, account: 'fixture', hub: 'ws://127.0.0.1:1', health: async () => true, probe: async () => { throw Error('slow'); } });
  const down = await probeHub({ home: tmp, account: 'fixture', hub: 'ws://127.0.0.1:1', health: async () => false, probe: async () => false });
  assert.deepEqual([up.state, slow.state, down.state], ['up', 'slow-probe', 'down']);
  const rows = [
    { account: 'trae', thread: 'one', runId: 'r1', t: now - 3 * minute, event: 'running', pid: 1, owner: 'owner-full', model: 'GPT-6.1-Sol' },
    { account: 'trae', thread: 'one', runId: 'r1', t: now - minute, event: 'running', pid: 1, owner: 'owner-full', model: 'GPT-6.1-Sol' },
    { account: 'trae', thread: 'one', t: now, event: 'message' },
    { account: 'ttadk', thread: 'one', runId: 'r2', t: now, event: 'running', pid: 2 },
    { account: 'trae', thread: 'done', runId: 'r3', t: now - minute, event: 'running', pid: 1 },
    { account: 'trae', thread: 'done', runId: 'r3', t: now, event: 'finished', pid: 1 },
    { account: 'trae', thread: 'unknown', runId: 'r4', t: now, event: 'running', pid: 3 },
  ];
  const running = await runningWorkers({ rows, alive: pid => pid === 1, knownThread: async (account) => {
    if (account === 'ttadk') return true; throw Error('unavailable');
  } });
  assert.equal(running.threads.length, 2); assert.equal(running.unresolved.length, 1);
  assert.equal(running.byAccount.trae[0].startedAt, now - 3 * minute);
  assert.equal(running.byAccount.trae[0].lastActivityAt, now);
  appendEvent({ runId: 'cli-running', event: 'running', account: 'trae', thread: 'cli-thread', pid: process.pid, owner: 'owner-full', model: 'GPT-6.1-Sol' });
  fs.writeFileSync(path.join(shared, 'codex-accounts.json'), JSON.stringify({ trae: { hub: 'ws://127.0.0.1:1' } }));
  const shown = JSON.parse(execFileSync(process.execPath, [path.join(scripts, 'quota.mjs'), '--running', '--json'], { env: process.env, encoding: 'utf8' }));
  assert.equal(shown.threads[0].thread, 'cli-thread'); assert.equal(shown.threads[0].owner, 'owner-full');
  console.log('PASS BC-10/17 three hub states and codex-worker-independent running thread listing');

  const root = path.join(tmp, 'ledgers'); fs.mkdirSync(root);
  const version = '2026-11-15.5';
  for (const project of ['video-agent', 'webview', 'global-rules']) {
    const target = path.join(tmp, `project-${project}`); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'ledger.md'), `- **Orchestrator session**: "${project}-owner"\n- **rules-ack**: \`${version}\`\n`);
    fs.symlinkSync(target, path.join(root, project));
  }
  fs.mkdirSync(path.join(root, 'unreadable')); fs.mkdirSync(path.join(root, 'unreadable/ledger.md'));
  const ack = auditGlobalRules({ records: [], version, since: now - h, ledgerRoot: root });
  assert.equal(ack.acknowledgements.filter(r => r.current === true).length, 3);
  assert.equal(ack.acknowledgements.find(r => r.project === 'webview').orchestrator, 'webview-owner');
  assert.equal(ack.acknowledgements.find(r => r.project === 'unreadable').status, 'UNKNOWN');
  assert.ok(!Object.values(ack.byOrchestrator).flat().some(r => /missing !=/.test(r.violation)));
  console.log('PASS NR-02 three symlinked project ledgers, Markdown list/bold form and unreadable UNKNOWN');

  const routeFile = path.join(tmp, 'routes.jsonl');
  const unrouted = { kind: 'unrouted', t: now - minute, name: 'res-v14-fixture', auditId: 'old-launch', project: 'global-rules' };
  const original = JSON.stringify(unrouted) + '\n'; fs.writeFileSync(routeFile, original);
  const env = { ...process.env, ROUTE_LOG_FILE: routeFile };
  execFileSync(process.execPath, [path.join(scripts, 'launch-audit.mjs'), '--attribute', unrouted.name, '--owner', 'owner-full', '--note', 'Historical test launch'], { env, encoding: 'utf8' });
  const attributedText = fs.readFileSync(routeFile, 'utf8'); assert.ok(attributedText.startsWith(original));
  const audit = auditGlobalRules({ records: attributedText.trim().split('\n').map(JSON.parse), version, since: now - h, ledgerRoot: root });
  assert.equal(audit.unrouted[0].attributedOwner, 'owner-full'); assert.equal(audit.byOrchestrator['owner-full'][0].violation, 'unrouted launch');
  assert.notEqual(spawnSync(process.execPath, [path.join(scripts, 'launch-audit.mjs'), '--attribute', 'absent', '--owner', 'owner-full', '--note', 'test'], { env }).status, 0);
  const approval = 'User card: 2026-11-14\n  exact approval reference';
  fs.appendFileSync(routeFile, JSON.stringify({ kind: 'route', t: now, name: 'approved', project: 'p', category: 'analysis', approvalRef: approval, pick: { account: 'personal', model: 'm', vendor: 'codex' } }) + '\n');
  auditLaunch({ name: 'approved', project: 'p', account: 'personal', model: 'm', log: routeFile, time: now + 1 });
  const launch = fs.readFileSync(routeFile, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(launch.routeApprovalRef, approval); assert.equal(launch.userOK, approval);
  console.log('PASS NR-03 append-only attribution and NR-04 existing verbatim approval-reference preservation');

  const outcomes = dedupeOutcomes([{ kind: 'outcome', project: 'p', name: 'old', t: now - 30 * h, result: 'rework', cause: 'spec', rounds: 2 },
    { kind: 'outcome', project: 'p', name: 'old', t: now, correction: true, note: 'corrected note' }]);
  assert.equal(outcomes[0].completedAt, now - 30 * h); assert.equal(outcomes[0].correctedAt, now); assert.equal(outcomes[0].t, now - 30 * h);
  assert.equal(modelView(outcomes[0]).result, 'rework'); assert.equal(modelView(outcomes[0]).nonCodeRework, true);
  assert.equal(passwordStyleFindings('PASS: signed\npassword=$SIGNING_PASS\npassword="${SIGNING_PASS}"\npassword=[REDACTED]\npassword=<redacted>\npassphrase=*****').length, 0);
  assert.deepEqual(passwordStyleFindings('password=fixture-sensitive-value'), [{ line: 1, field: 'password', value: '[MASKED]' }]);
  const logFile = path.join(tmp, 'worker.log'); fs.writeFileSync(logFile, 'PASS: signed\npassword=$TEST_VARIABLE\npassword=[REDACTED]');
  const scan = execFileSync(process.execPath, [path.join(scripts, 'nightly-review.mjs'), 'scan-log', '--file', logFile], { env: { ...env, NIGHTLY_DIR: path.join(tmp, 'nightly') }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(scan), { findings: [] });
  console.log('PASS AU-6 completion/correction split, non-code rework, and NR-09 masked scan false positives');
  console.log('\nall pass');
} finally {
  for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  fs.rmSync(tmp, { recursive: true, force: true });
}
