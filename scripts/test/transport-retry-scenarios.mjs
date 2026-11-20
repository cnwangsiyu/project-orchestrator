#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { completionKind, transportLaneFailures } from '../lib/worker-completion.mjs';
import { recordWorkerOutcome } from '../lib/worker-outcome.mjs';
import { createTaskSpec } from '../lib/pipeline/taskspec.mjs';

const errors = [
  'stream disconnected before completion: Transport error: network error: error decoding response body',
  'stream disconnected before completion: Transport error: network error: connection reset by peer',
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-retry-'));
let count = 0;
const check = (label, run) => { run(); count++; console.log(`PASS ${label}`); };
const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const now = Date.now();
const routeDir = path.join(tmp, 'route'); fs.mkdirSync(routeDir);
const routeLog = path.join(routeDir, 'route.jsonl'), cache = path.join(routeDir, 'cache.json');
const route = (history = [], failures = 0, onlyMain = false) => {
  const account = (name, hours) => ({ name, kind: 'chatgpt', home: path.join(routeDir,name), live: true,
    healthy: true, windows: [{ used: 20, resetsAt: now + hours * 3600000, windowMins: 10080 }] });
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: now, codexAccounts: [account('main',80), ...(!onlyMain ? [account('alt',120)] : [])],
    claude: null, errors: {}, history: {} }));
  fs.writeFileSync(routeLog, history.map(r => JSON.stringify(r)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [path.join(scripts,'route.mjs'), 'implement', '--impact','service',
    '--project','p','--name','task','--failures',String(failures),'--dry','--json'], { encoding:'utf8',
    env: { ...process.env, HOME:routeDir, RULES_SHARED:routeDir, CODEX_ACCOUNTS:path.join(routeDir,'none.json'),
      QUOTA_CACHE:cache, ROUTE_NOW:String(now), ROUTE_LOG_FILE:routeLog, QUOTA_LOG_FILE:path.join(routeDir,'empty-quota'),
      ROUTE_SNAPSHOT_FILE:'', QUOTA_LOG:'0', TRAE_PROBE:'0', PERSONAL_FALLBACK_FILE:path.join(routeDir,'disabled.json') } });
  assert.equal(run.status,0,run.stderr); return JSON.parse(run.stdout);
};
const failed = (turn, t = now - 1000) => ({ kind:'outcome', t, project:'p', name:'task', category:'implement',
  account:'main', thread:'thread', turn, result:'transport-failed', failureKind:'transport-failed',
  actual:[{ account:'main', model:'gpt-6.1-sol', effort:'max' }], actualStatus:'KNOWN' });
try {
  check('real stream errors and exhausted provider errors are transport failures', () => {
    for (const error of [...errors, 'ECONNRESET', 'HTTP 500 after retries', 'provider 503', 'provider overloaded after retries'])
      assert.equal(completionKind({ status: 'failed', error: { message: error } }), 'transport-failed');
    for (const status of ['completed', 'interrupted', 'BLOCKED', 'TRUNCATED'])
      assert.equal(completionKind({ status, error: errors[0] }), status);
    assert.equal(completionKind({ status: 'failed', error: 'test assertions failed' }), 'failed');
  });
  check('transport outcome is durable, idempotent, and distinct from quality or partial final prose', () => {
    const log = path.join(tmp, 'outcomes.jsonl');
    const base = { project: 'p', name: 'task', category: 'implement', thread: 'thread', turn: 'turn',
      account: 'a', actualModel: 'gpt-6.1-sol', effort: 'high', command: 'start', terminal: true,
      status: 'failed', error: errors[0], exit: 1, final: 'BLOCKED: partial task report', log };
    const row = recordWorkerOutcome(base);
    assert.equal(row.result, 'transport-failed'); assert.equal(row.failureKind, 'transport-failed');
    assert.equal(row.cause, 'transport'); assert.equal(row.rounds, 0);
    assert.equal(recordWorkerOutcome(base), null);
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).result, 'transport-failed');
    const success = recordWorkerOutcome({ ...base, turn: 'continued', command: 'turn', status: 'completed', exit: 0, final: 'DONE' });
    assert.equal(success.result, 'pass'); assert.equal(success.rounds, 0);
  });
  check('router ledger joins terminal transport errors, ignores failures and stronger launch dominance', () => {
    const outcome = failed('turn');
    const launch = { ...outcome, kind:'launch-model', accepted:true, state:'failed', failureKind:'quality',
      actual:{ accountId:'main', modelId:'gpt-6-astra', effort:'max' }, result:undefined };
    const r = route([launch,outcome],1);
    assert.equal(r.failures,0); assert.equal(r.plan.task.qualityFailures,0); assert.equal(r.plan.task.previousAttempts.length,0);
    assert.equal(r.blocked,false); assert.equal(r.pick.model,'gpt-6.1-sol'); assert.notEqual(r.pick.effort,'max');
    assert.match(r.why.join('\n'),/Ignored 1 transport-failed/);
    const direct = createTaskSpec({ category:'implement', taskId:'task', requestId:'transport-test', sandboxCeiling:'danger-full-access',
      flags:{ name:'task', impact:'service', failures:'2' }, previousAttempts:[
        { id:'transport',taskId:'task',state:'transport-failed',failureKind:'quality',actualStatus:'KNOWN' },
        { id:'quality',taskId:'task',state:'failed',failureKind:'quality',actualStatus:'KNOWN',
          actual:{accountId:'main',modelId:'gpt-6.1-sol',effort:'high'} }] });
    assert.equal(direct.failures,1); assert.equal(direct.qualityFailures,1); assert.equal(direct.previousAttempts.length,1);
    assert.equal(createTaskSpec(direct).failures,1, 'normalization must not subtract twice');
  });
  check('lane demotion lasts 30 minutes, dedupes turns, and never bans the only lane', () => {
    const recent = [failed('first'),failed('second')];
    assert.equal(transportLaneFailures([...recent,recent[0],failed('old',now-1800001),failed('future',now+1)],'main','gpt-6.1-sol',now),2);
    assert.equal(route().pick.account,'main');
    assert.equal(route(recent).pick.account,'alt');
    assert.match(route(recent).why.join('\n'),/Transport lane demoted: main:gpt-6.1-sol/);
    assert.equal(route(recent,0,true).pick.account,'main');
    assert.equal(route(recent.map(r=>({...r,t:now-1800001}))).pick.account,'main');
  });
  console.log(`${count} scenarios passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
