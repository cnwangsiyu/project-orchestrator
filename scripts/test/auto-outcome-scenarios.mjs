#!/usr/bin/env node
// All launchers use an in-memory fixture transport and isolated homes/ledgers; no real hubs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dedupeOutcomes } from '../lib/pipeline/outcomes.mjs';
import { dedupeOutcomes as stateDedupe } from '../lib/state.mjs';
import { parseReviewResult, unresolvedFinal, recordWorkerOutcome } from '../lib/worker-outcome.mjs';
import { parseTaskSpec } from '../lib/pipeline/taskspec.mjs';
import { acquireRoute } from '../lib/route-data.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-outcome-'));
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const fixture = (name, category = 'implement', role = 'primary') => {
  const dir = path.join(tmp, name), home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(bin);
  const log = path.join(dir, 'routes.jsonl'), rpc = path.join(dir, 'rpc.jsonl'), profiles = path.join(dir, 'profiles.json');
  const pick = { vendor: 'codex', account: 'fixture', company: true, model: 'gpt-6.1-sol', effort: 'high', sandbox: 'read-only' };
  fs.writeFileSync(profiles, JSON.stringify({ fixture: { kind: 'trae', home, hub: 'ws://127.0.0.1:1' } }));
  fs.writeFileSync(log, JSON.stringify({ kind: 'route', t: Date.now() - 120000, project: 'p', name, category, pick }) + '\n');
  for (const [cmd, output] of [['codex', '{"models":[]}'], ['claude', 'fixture']])
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
  const cache = path.join(dir, 'cache.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: Date.now(), claude: null, codexAccounts: [], errors: {}, history: {} }));
  const seat = { project: 'p', name, category, role, ...pick };
  const env = { ...process.env, HOME: home, RULES_SHARED: dir, CODEX_HOME: home, CODEX_HUB: 'ws://127.0.0.1:1',
    CODEX_ACCOUNTS: profiles, ROUTE_LOG_FILE: log, QUOTA_CACHE: cache, QUOTA_LOG_FILE: path.join(dir, 'empty-quota'),
    RESOURCE_LOG_FILE: path.join(dir, 'empty-resources'), RULES_LEDGER_ROOT: path.join(dir, 'empty-ledgers'),
    PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: '', ORCHESTRATOR_OWNER: '', CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '',
    QUOTA_LOG: '0', TRAE_PROBE: '0', TRAE_SESSIONS_DIR: path.join(dir, 'empty-sessions') };
  const run = (cmd = 'start', config = {}, extra = []) => {
    const args = ['--account', 'fixture', cmd,
      ...(cmd === 'start' ? ['--cwd', dir, '--sandbox', 'read-only', '--name', name, '--project', 'p', '--role', role,
        '--routed-seat', JSON.stringify(seat)] : ['--thread', 'guard-thread']),
      ...(['start', 'turn'].includes(cmd) ? ['--effort', 'high', '--model', 'gpt-6.1-sol'] : []),
      '--out', path.join(dir, 'final.md'), ...extra, ...(['start', 'turn'].includes(cmd) ? ['Follow fixture.'] : [])];
    const messages = [{ method: 'thread/tokenUsage/updated', params: { threadId: 'guard-thread',
      turnId: config.turn ?? 'guard-turn', context: { model: 'GPT-6.1-Sol' } } }];
    const r = spawnSync(process.execPath, ['--import', path.join(scripts, 'test/fixtures/worker-guards-transport.mjs'),
      path.join(scripts, 'codex-worker.mjs'), ...args], { env: { ...env,
      WORKER_GUARDS_FIXTURE: JSON.stringify({ thread: 'guard-thread', rpc, messages, ...config }) }, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.error, undefined, r.stderr + r.stdout);
    assert.doesNotMatch(r.stderr, /auto-outcome: NOT RECORDED/);
    return r;
  };
  return { dir, log, rpc, env, run, outcomes: () => rows(log).filter(r => r.kind === 'outcome') };
};
let count = 0;
const check = (label, fn) => { fn(); count++; console.log(`PASS ${label}`); };
try {
  check('exit zero records actual model and minutes from the first launch', () => {
    const f = fixture('pass'); assert.equal(f.run().status, 0);
    const o = f.outcomes()[0]; assert.equal(o.auto, true); assert.equal(o.result, 'pass'); assert.equal(o.rounds, 0);
    assert.equal(o.project, 'p'); assert.equal(o.name, 'pass'); assert.equal(o.category, 'implement');
    assert.ok(o.minutes >= 0 && o.minutes < 1, 'time begins at launch, not the earlier routing decision'); assert.deepEqual(o.actual[0], { vendor: 'codex', model: 'GPT-6.1-Sol', effort: 'high', account: 'fixture' });
    assert.equal(fs.readFileSync(path.join(f.dir, 'final.md'), 'utf8'), 'DONE guard fixture\n');
  });
  check('launcher and hub failure exits record infra fail', () => {
    for (const [name, config] of [['rpc-fail', { rpcFailure: 'thread/start' }], ['hub-fail', { failure: 'fixture hub failure' }]]) {
      const f = fixture(name); assert.notEqual(f.run('start', config).status, 0);
      assert.equal(f.outcomes().length, 1); assert.equal(f.outcomes()[0].result, 'fail'); assert.equal(f.outcomes()[0].cause, 'infra');
    }
  });
  check('BLOCKED, FAILED and needs-user reports remain unresolved; old output cannot imply pass', () => {
    for (const [i, final] of ['BLOCKED: login required', '**BLOCKED**: login required', 'T1 FAILED: checks failed', 'Result: needs-user'].entries()) {
      const f = fixture(`unresolved-${i}`); fs.writeFileSync(path.join(f.dir, 'final.md'), 'old DONE');
      assert.equal(f.run('start', { final }).status, 0); assert.equal(f.outcomes().length, 0);
    }
    assert.equal(unresolvedFinal('DONE. No BLOCKED tasks remain.'), false);
  });
  check('continuations add rework rounds and wait reattachments are idempotent', () => {
    const f = fixture('continuation'); assert.equal(f.run().status, 0);
    assert.equal(f.run('turn', { turn: 'turn-2' }).status, 0);
    assert.equal(f.run('turn', { turn: 'turn-3' }).status, 0);
    assert.deepEqual(f.outcomes().map(o => [o.result, o.rounds]), [['pass', 0], ['rework', 1], ['rework', 2]]);
    assert.equal(f.run('wait', { turn: 'turn-3', status: 'completed' }).status, 0);
    assert.equal(f.outcomes().length, 3); assert.equal(dedupeOutcomes(f.outcomes()).length, 1);
    assert.equal(dedupeOutcomes(f.outcomes())[0].rounds, 2);
    f.run('turn', { turn: 'turn-4', final: 'BLOCKED: waiting' });
    f.run('turn', { turn: 'turn-5' });
    assert.equal(f.outcomes().at(-1).rounds, 4, 'unresolved continuation still consumed a fix round');
  });
  check('review marker injection covers primary, adversarial and second seats plus continuations', () => {
    for (const [i, category, role] of [[1, 'review', 'primary'], [2, 'review-high', 'primary'], [3, 'adversarial', 'primary'], [4, 'implement', 'second'], [5, 'second-opinion', 'primary']]) {
      const f = fixture(`marker-${i}`, category, role); assert.equal(f.run('start', { final: 'DONE\nREVIEW-RESULT: blocking' }).status, 0);
      assert.equal(f.outcomes()[0].reviewResult, 'blocking'); assert.equal(f.outcomes()[0].reviewRun, true);
      for (const call of rows(f.rpc).filter(c => ['thread/start', 'thread/resume'].includes(c.method)))
        assert.match(call.params.developerInstructions, /exactly one line REVIEW-RESULT: blocking or REVIEW-RESULT: none/);
      assert.equal(f.run('turn', { turn: 'turn-2', final: 'DONE\nREVIEW-RESULT: none' }).status, 0);
      assert.equal(f.outcomes().at(-1).reviewResult, 'none');
    }
  });
  check('strict marker parsing keeps missing, duplicate or nonfinal lines unknown', () => {
    assert.equal(parseReviewResult('DONE\nREVIEW-RESULT: none\n'), 'none');
    assert.equal(parseReviewResult('DONE\r\nREVIEW-RESULT: blocking\r\n'), 'blocking');
    for (const text of ['No P0/P1 findings', 'REVIEW-RESULT: none\nMore text', 'REVIEW-RESULT: none\nREVIEW-RESULT: blocking', ' REVIEW-RESULT: none', 'REVIEW-RESULT: clean'])
      assert.equal(parseReviewResult(text), null);
    const f = fixture('missing-marker', 'review'); f.run('start', { final: 'DONE no P0/P1 findings' });
    assert.equal(f.outcomes()[0].reviewResult, null);
    const blocked = fixture('blocking-verdict', 'review'); blocked.run('start', { final: 'BLOCKED: fix P1\nREVIEW-RESULT: blocking' });
    assert.equal(blocked.outcomes()[0].reviewResult, 'blocking'); assert.ok(!Object.hasOwn(blocked.outcomes()[0], 'result'));
  });
  check('manual CLI results and metadata override newer auto records in both readers', () => {
    const f = fixture('manual'); f.run();
    const manual = args => {
      const r = spawnSync(process.execPath, [path.join(scripts, 'outcome.mjs'), '--project', 'p', '--name', 'manual', ...args], { env: f.env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr); return r;
    };
    manual(['--actual', 'codex:correct-model:high@fixture']);
    manual(['--result', 'pass']);
    f.run('turn', { turn: 'turn-2' }); f.run('turn', { turn: 'turn-3' });
    let effective = dedupeOutcomes(f.outcomes())[0];
    assert.equal(effective.auto, false); assert.equal(effective.result, 'pass'); assert.equal(effective.rounds, 0);
    assert.equal(effective.actual[0].model, 'correct-model'); assert.deepEqual(stateDedupe(f.outcomes()), dedupeOutcomes(f.outcomes()));
    manual(['--correct', '--result', 'rework', '--rounds', '1', '--cause', 'scope']);
    f.run('turn', { turn: 'turn-4' }); effective = dedupeOutcomes(f.outcomes())[0];
    assert.equal(effective.rounds, 1); assert.equal(effective.cause, 'scope');
  });
  check('nightly coverage and seat yields honor manual overrides and missing markers', () => {
    const f = fixture('review-summary', 'review');
    const route = rows(f.log)[0];
    fs.writeFileSync(f.log, JSON.stringify({ ...route, second: route.pick, findings: 'found P1' }) + '\n');
    f.run('start', { final: 'DONE no P0/P1 findings' });
    recordWorkerOutcome({ project: 'p', name: 'review-summary-second', category: 'review', role: 'second', account: 'fixture',
      model: 'gpt-6.1-sol', effort: 'high', startedAt: Date.now(), command: 'start', exit: 0, terminal: true,
      thread: 'second-thread', turn: 'second-turn', final: 'DONE\nREVIEW-RESULT: none', log: f.log });
    const report = () => {
      const r = spawnSync(process.execPath, [path.join(scripts, 'review-data.mjs'), '--json'], { env: f.env, encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
    };
    let data = report(); assert.equal(data.outcomes.recorded, 0);
    assert.equal(data.reviews.window.yield.unknown, 1); assert.equal(data.reviews.window.yield.none, 1);
    assert.deepEqual(data.outcomes.coverage, { auto: 2, manual: 0, autoRecords: 2, manualRecords: 0 });
    const m = spawnSync(process.execPath, [path.join(scripts, 'outcome.mjs'), '--project', 'p', '--name', 'review-summary', '--review-result', 'blocking'], { env: f.env, encoding: 'utf8' });
    assert.equal(m.status, 0, m.stderr);
    f.run('turn', { turn: 'turn-2', final: 'DONE\nREVIEW-RESULT: none' });
    data = report(); assert.equal(data.reviews.window.yield.blocking, 1); assert.equal(data.reviews.window.yield.none, 1);
    assert.equal(data.outcomes.coverage.manual, 1); assert.equal(data.outcomes.coverage.auto, 1);
  });
  check('routing snapshot consumes automatic tasks, excludes review seats and honors manual correction', () => {
    const f = fixture('routing-summary'); f.run();
    fs.appendFileSync(f.log, JSON.stringify({ kind: 'outcome', t: Date.now(), project: 'p', name: 'seat', auto: true,
      category: 'review', reviewRun: true, result: 'pass', rounds: 0, reviewResult: 'none' }) + '\n');
    const parsed = parseTaskSpec(['analysis', '--project', 'p', '--name', 'next-task'], { taskId: 'next-task', requestId: 'auto-outcome-test' });
    const snapshot = () => acquireRoute(parsed, { env: { ...f.env, ROUTE_NOW: String(Date.now()) },
      root: path.dirname(scripts), readAccount: () => { throw Error('fixture forbids provider calls'); },
      readClaude: () => { throw Error('fixture forbids provider calls'); } }).snapshot;
    assert.equal(snapshot().outcomes.length, 1); assert.equal(snapshot().outcomes[0].result, 'pass');
    fs.appendFileSync(f.log, JSON.stringify({ kind: 'outcome', correction: true, t: Date.now(), project: 'p', name: 'routing-summary',
      result: 'rework', rounds: 1, cause: 'scope' }) + '\n');
    f.run('turn', { turn: 'turn-2' }); assert.equal(snapshot().outcomes[0].result, 'rework');
  });
  check('RULES_SHARED alone confines writes and stalled/handoff exits add no outcome', () => {
    const log = path.join(tmp, 'isolated', 'route-log.jsonl'); process.env.RULES_SHARED = path.dirname(log);
    const base = { project: 'p', name: 'isolation', category: 'analysis', terminal: true, exit: 0, final: 'DONE' };
    recordWorkerOutcome(base); assert.equal(rows(log).length, 1);
    for (const exit of [4, 7, 8, 9, 10, 130, 143]) assert.equal(recordWorkerOutcome({ ...base, exit }), null);
    assert.equal(rows(log).length, 1);
  });
  check('routing uses the latest cumulative input per finished TTADK thread', () => {
    const f = fixture('reserve-summary'), t = Date.now();
    const done = { project: 'p', name: 'reserve-summary', category: 'analysis', account: 'ttadk', thread: 'one-thread',
      terminal: true, exit: 0, final: 'DONE', log: f.log };
    recordWorkerOutcome({ ...done, turn: 'first', cumulativeInput: 100, time: t - 1000 });
    recordWorkerOutcome({ ...done, turn: 'second', cumulativeInput: 200, time: t });
    recordWorkerOutcome({ ...done, turn: 'still-running', terminal: false, exit: 4, cumulativeInput: 300, time: t });
    const parsed = parseTaskSpec(['analysis', '--name', 'next-task'], { taskId: 'next-task', requestId: 'reserve-test' });
    const { snapshot } = acquireRoute(parsed, { env: { ...f.env, ROUTE_NOW: String(t) }, root: path.dirname(scripts) });
    assert.deepEqual(snapshot.runUsage, [{ t, accountId: 'ttadk', category: 'analysis', cumulativeInput: 200 }]);
  });
  console.log(`\n${count} scenarios passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
