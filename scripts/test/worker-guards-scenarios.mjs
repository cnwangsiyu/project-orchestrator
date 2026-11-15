#!/usr/bin/env node
// Launcher regressions use only synthetic homes, public records, and an in-memory hub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelFamily, modelObservation, rolloutTurnModel } from '../lib/worker-model.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-guards-'));
const transport = path.join(scripts, 'test/fixtures/worker-guards-transport.mjs');
let passed = 0;
const rows = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const fixture = (label, kind = 'trae') => {
  const dir = path.join(tmp, label), home = path.join(dir, 'home'), accountHome = path.join(home, 'account');
  fs.mkdirSync(accountHome, { recursive: true });
  const profiles = path.join(dir, 'accounts.json'), rpc = path.join(dir, 'rpc.jsonl'), log = path.join(dir, 'route.jsonl');
  fs.writeFileSync(profiles, JSON.stringify({ fixture: { kind, home: accountHome, hub: 'ws://127.0.0.1:1',
    modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol' } } }));
  return { dir, accountHome, rpc, log, env: { ...process.env, HOME: home, CODEX_HOME: accountHome, CODEX_HUB: 'ws://127.0.0.1:1',
    CODEX_ACCOUNTS: profiles, RULES_SHARED: dir, ROUTE_LOG_FILE: log, NODE_OPTIONS: '', ORCHESTRATOR_OWNER: '',
    CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '' } };
};
const run = (f, cmd = 'start', config = {}, flags = []) => {
  const r = spawnSync(process.execPath, ['--import', transport, path.join(scripts, 'codex-worker.mjs'), '--account', 'fixture', cmd,
    ...(cmd === 'start' ? ['--cwd', f.dir, '--sandbox', 'read-only'] : ['--thread', 'guard-thread']),
    ...(['start', 'turn'].includes(cmd) ? ['--effort', 'high', '--model', 'gpt-6.1-sol'] : []),
    ...flags, ...(['start', 'turn', 'steer'].includes(cmd) ? ['Follow the synthetic brief.'] : [])],
  { env: { ...f.env, WORKER_GUARDS_FIXTURE: JSON.stringify({ thread: 'guard-thread', rpc: f.rpc, ...config }) }, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.error, undefined, r.stderr + r.stdout);
  return { ...r, events: rows(path.join(f.dir, 'worker-events.jsonl')), calls: rows(f.rpc), records: rows(f.log) };
};
const check = (label, fn) => { fn(); passed++; console.log(`ok   ${label}`); };
const usage = (model, params = {}) => ({ method: 'thread/tokenUsage/updated', params: {
  threadId: 'guard-thread', turnId: 'guard-turn', context: { model }, ...params } });
const delegated = (model, params = {}) => ({ method: 'item/completed', params: { threadId: 'guard-thread', turnId: 'guard-turn',
  item: { type: 'collabAgentToolCall', senderThreadId: 'guard-thread', receiverThreadIds: ['child-thread'],
    model, reasoningEffort: 'high' }, ...params } });
try {
  check('BC-35 one-shot startup failure surfaces stderr and records a failed worker',()=>{
    const f=fixture('one-shot-failure','chatgpt'),out=path.join(f.dir,'start.out'),log=path.join(f.dir,'start.log');
    const r=spawnSync('/bin/sh',[path.join(scripts,'run-tracked.sh'),'--name','one-shot-failure','--owner','guard-owner','--account','fixture',
      '--model','gpt-6.1-sol','--log',log,'--out',out,'--',process.execPath,'-e',
      'console.error("Not inside a trusted directory and --skip-git-repo-check was not specified");process.exit(9)'],{env:f.env,encoding:'utf8',timeout:5000});
    assert.equal(r.status,9);assert.match(r.stderr,/launch failed before producing a thread\/turn/);assert.match(r.stderr,/Not inside a trusted directory/);
    assert.equal(rows(path.join(f.dir,'worker-events.jsonl')).at(-1).event,'failed');assert.match(fs.readFileSync(log,'utf8'),/skip-git-repo-check/);
    assert.ok(!fs.existsSync(out));
  });
  check('read-only network access stays read-only in the actual start request',()=>{
    const r=run(fixture('readonly-network'),'start',{},['--network','on']);assert.equal(r.status,0,r.stderr);
    assert.equal(r.calls.find(c=>c.method==='thread/start').params.sandbox,'read-only');
    assert.deepEqual(r.calls.find(c=>c.method==='turn/start').params.sandboxPolicy,{type:'readOnly',networkAccess:true});
  });
  check('launch mismatch warns for model, effort and wider sandbox without holding company work',()=>{
    const f=fixture('launch-warning');
    fs.writeFileSync(f.log,JSON.stringify({t:Date.now()-1000,kind:'route',name:'launch-warning',project:'guards',category:'analysis',
      pick:{vendor:'codex',account:'fixture',company:true,model:'gpt-6.1-sol',effort:'medium',sandbox:'read-only'}})+'\n');
    const r=run(f,'start',{},['--name','launch-warning','--project','guards','--model','deepseek-v4.1-flash','--sandbox','danger-full-access']);
    assert.equal(r.status,0,r.stderr);assert.equal(r.stderr.split('\n').filter(x=>x.startsWith('launch-mismatch:')).length,1);
    const mismatch=r.records.find(x=>x.kind==='launch-mismatch');assert.ok(mismatch.modelFamilyChanged);assert.ok(mismatch.widerSandbox);
    assert.deepEqual(mismatch.differences.map(x=>x.field),['model','effort','sandbox']);
  });
  check('company route on a personal start blocks until the route records a free-text approval',()=>{
    const f=fixture('personal-replacement','chatgpt'),record={t:Date.now()-1000,kind:'route',name:'personal-replacement',project:'guards',category:'analysis',
      pick:{vendor:'codex',account:'trae',company:true,model:'gpt-6.1-sol',effort:'high',sandbox:'read-only'}};
    fs.writeFileSync(f.log,JSON.stringify(record)+'\n');
    let r=run(f,'start',{},['--name','personal-replacement','--project','guards','--user-ok','not-on-route']);
    assert.equal(r.status,1,r.stderr);assert.ok(!r.calls.some(c=>c.method==='turn/start'));assert.match(r.stderr,/re-route or pass the approval recorded/);
    assert.equal(r.events.at(-1).event,'failed');
    const ref="Owner recorded yes for alt; user's review on 2026-11-15";
    fs.appendFileSync(f.log,JSON.stringify({...record,t:Date.now()-10,approvalRef:ref})+'\n');
    r=run(f,'start',{},['--name','personal-replacement','--project','guards']);assert.equal(r.status,0,r.stderr);
    assert.equal(r.records.findLast(x=>x.kind==='launch').userOK,ref);
  });
  check('continuation cross-check blocks a personal turn on a saved company seat',()=>{
    const f=fixture('turn-mismatch'),name='turn-mismatch';
    fs.writeFileSync(f.log,JSON.stringify({t:Date.now()-1000,kind:'route',name,project:'guards',category:'analysis',
      pick:{vendor:'codex',account:'fixture',company:true,model:'gpt-6.1-sol',effort:'high',sandbox:'read-only'}})+'\n');
    let r=run(f,'start',{},['--name',name,'--project','guards']);assert.equal(r.status,0,r.stderr);
    const profiles=JSON.parse(fs.readFileSync(f.env.CODEX_ACCOUNTS,'utf8'));profiles.fixture.kind='chatgpt';fs.writeFileSync(f.env.CODEX_ACCOUNTS,JSON.stringify(profiles));
    r=run(f,'turn');assert.equal(r.status,1,r.stderr);assert.ok(!r.calls.slice(-2).some(c=>c.method==='turn/start'));
    assert.ok(r.records.some(x=>x.kind==='launch-mismatch'&&x.blocked));
  });
  for (const [cmd, hang] of [['start', 'websocket/open'], ['start', 'initialize'], ['start', 'thread/start'],
    ['turn', 'thread/resume'], ['start', 'turn/start'], ['turn', 'turn/start'], ['wait', 'thread/resume']]) {
    check(`${cmd} deadline covers ${hang}`, () => {
      const f = fixture(`deadline-${cmd}-${hang.replaceAll('/', '-')}`);
      const r = run(f, cmd, { hang }, ['--stall-min', '0.003', '--log', path.join(f.dir, 'worker.jsonl')]);
      assert.equal(r.status, 4, r.stderr + r.stdout); assert.match(r.stdout, /connecting:.*setup deadline/);
      assert.ok(r.stdout.includes(`waiting for ${hang}`));
      assert.equal(r.events.at(-1).event, 'stalled'); assert.equal(r.events.at(-1).phase, hang);
      assert.ok(rows(path.join(f.dir, 'worker.jsonl')).some((row) => row.stalled && row.phase === hang));
      assert.ok(!r.calls.some((call) => call.method === 'turn/interrupt'));
      assert.ok(!r.records.some((row) => row.kind === 'reroute'));
    });
  }
  for (const [cmd, hang] of [['interrupt', 'websocket/open'], ['interrupt', 'initialize'], ['interrupt', 'thread/resume'],
    ['interrupt', 'thread/read'], ['interrupt', 'turn/interrupt'], ['steer', 'thread/resume'], ['steer', 'turn/steer'], ['status', 'thread/read']]) {
    check(`${cmd} bounded wait at ${hang}`, () => {
      const f = fixture(`control-${cmd}-${hang.replaceAll('/', '-')}`);
      const r = run(f, cmd, { hang }, ['--interrupt-timeout-sec', '0.18']);
      assert.equal(r.status, 7, r.stderr + r.stdout); assert.ok(r.stderr.includes(`waiting for ${hang}`));
      assert.equal(r.events.at(-1).event, 'stalled'); assert.equal(r.events.at(-1).exit, 7);
    });
  }
  for (const unrelatedChatter of [false, true]) check(`zero own events stalls with unrelated chatter=${unrelatedChatter}`, () => {
    const r = run(fixture(`idle-${unrelatedChatter}`), 'start', { quiet: true, unrelatedChatter }, ['--stall-min', '0.003']);
    assert.equal(r.status, 4, r.stderr + r.stdout); assert.match(r.stdout, /stalled: no events/);
    assert.equal(r.events.at(-1).phase, 'follow'); assert.equal(r.events.at(-1).mayRun, true);
  });
  check('status preserves JSON stdout', () => {
    const r = run(fixture('status-json'), 'status'); assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).last.id, 'guard-turn');
  });
  check('continuation inherits ownership, routing, hop depth and absolute outputs; explicit flags win', () => {
    const f = fixture('inheritance'), log = path.join(f.dir, 'worker.jsonl'), out = path.join(f.dir, 'final.md');
    const route = ['analysis', '--failures', '2', '--exclude-account', 'main,b', '--exclude-model', 'gemini', '--auto-reroute-depth', '1'];
    let r = run(f, 'start', {}, ['--route-args', JSON.stringify(route), '--owner', 'saved-owner', '--name', 'saved-name', '--log', log, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(f.dir, 'worker-launches/fixture/guard-thread.json');
    let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.defaults['auto-reroute-depth'], 1);
    const startCount = r.events.length;
    r = run(f, 'turn', {}, ['--cwd', tmp]); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /inherited:.*route-args.*saved-owner/);
    const first = r.events[startCount]; assert.equal(first.owner, 'saved-owner'); assert.equal(first.name, 'saved-name');
    assert.equal(first.logFile, log); assert.equal(first.outFile, out);
    assert.deepEqual(r.events.at(-1).routeArgs, route); assert.equal(r.events.at(-1).rerouteDepth, 1);
    assert.match(fs.readFileSync(out, 'utf8'), /DONE guard fixture/);
    const override = ['analysis', '--failures', '0'];
    r = run(f, 'turn', {}, ['--owner', 'explicit-owner', '--route-args', JSON.stringify(override), '--auto-reroute-depth', '2', '--out', path.join(f.dir, 'override.md')]);
    assert.equal(r.status, 0, r.stderr); assert.equal(r.events.at(-1).owner, 'explicit-owner');
    assert.deepEqual(r.events.at(-1).routeArgs, override); assert.equal(r.events.at(-1).rerouteDepth, 2);
    saved = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(saved.defaults.out, path.join(f.dir, 'override.md'));
    assert.equal(saved.defaults.cwd, tmp); assert.equal(saved.defaults.log, log);
  });
  check('legacy continuation has no invented routing context', () => {
    const r = run(fixture('legacy'), 'turn'); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /inherited: no saved launch/); assert.equal(r.events.at(-1).routeArgs, null);
  });
  check('inherited queue cancellation still enforces two-hop limit', () => {
    const f = fixture('inherited-queue');
    let r = run(f, 'start', {}, ['--owner', 'queue-owner', '--route-args', JSON.stringify(['analysis', '--failures', '1', '--exclude-account', 'main,b']),
      '--auto-reroute-depth', '2', '--queue-patience-min', '0.0001']);
    assert.equal(r.status, 0, r.stderr);
    r = run(f, 'turn', { quiet: true, messages: [{ method: 'queue/status', params: { threadId: 'guard-thread', turnId: 'guard-turn', state: 'queued', position: 100 } }] });
    assert.equal(r.status, 10, r.stderr + r.stdout); assert.match(r.stdout, /reroute-depth-limit/);
    assert.ok(r.calls.some((call) => call.method === 'turn/interrupt')); assert.equal(r.events.at(-1).owner, 'queue-owner');
    assert.ok(!r.records.some((row) => row.kind === 'reroute'));
  });
  check('own model evidence ignores unrelated threads, turns and child senders', () => {
    const f = fixture('model-match');
    const r = run(f, 'start', { messages: [usage('GPT-6.1-Sol'), usage('DeepSeek-V4.1-Flash', { threadId: 'other-thread' }),
      usage('DeepSeek-V4.1-Flash', { turnId: 'old-turn' }), usage('DeepSeek-V4.1-Flash', { threadId: undefined }),
      delegated('DeepSeek-V4.1-Flash', { threadId: 'other-thread' })] }, ['--require-model']);
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(r.events.at(-1).actualModel, 'GPT-6.1-Sol');
    assert.deepEqual(r.events.at(-1).delegatedModels, []); assert.ok(!r.stdout.includes('DeepSeek'));
    const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'worker-launches/fixture/guard-thread.json'), 'utf8'));
    assert.equal(saved.requestedModel, 'gpt-6.1-sol'); assert.equal(saved.effectiveModel, 'GPT-6.1-Sol');
    assert.equal(saved.actualModelSource, 'usage-context'); assert.equal(saved.turn, 'guard-turn');
    assert.ok(r.records.some((row) => row.kind === 'launch-model' && row.thread === 'guard-thread' && row.turn === 'guard-turn'));
  });
  check('execution evidence arriving before turn/start reply is retained', () => {
    const r = run(fixture('early-model'), 'start', { beforeReply: true, messages: [usage('GPT-6.1-Sol')] }, ['--name', 'review']);
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /actual-model: GPT-6.1-Sol/);
  });
  for (const flags of [['--require-model'], ['--name', 'review'], ['--route-args', '["review-high"]'], ['--route-args', '["second-opinion"]']]) {
    check(`execution family mismatch rejects ${flags.join(' ')}`, () => {
      const f = fixture(`mismatch-${passed}`), out = path.join(f.dir, 'review.md');
      const r = run(f, 'start', { messages: [usage('DeepSeek-V4.1-Flash')] }, [...flags, '--out', out]);
      assert.equal(r.status, 5, r.stderr + r.stdout); assert.match(r.stderr, /review-model-rejected/);
      assert.equal(r.events.at(-1).event, 'failed'); assert.equal(r.events.at(-1).modelMismatch, true);
      assert.match(fs.readFileSync(out, 'utf8'), /DONE guard fixture/);
    });
  }
  check('T107 parent GPT execution and delegated DeepSeek author remain distinct and reject review', () => {
    const r = run(fixture('delegated-author'), 'start', { messages: [usage('GPT-6.1-Sol'), delegated('DeepSeek-V4.1-Flash'), delegated('DeepSeek-V4.1-Flash')] }, ['--name', 'T107-review']);
    assert.equal(r.status, 5, r.stderr + r.stdout); assert.equal(r.events.at(-1).actualModel, 'GPT-6.1-Sol');
    assert.equal(r.events.at(-1).delegatedModels.length, 1); assert.match(r.stdout, /delegated-model: DeepSeek-V4.1-Flash/);
  });
  check('same-family delegation passes and missing execution evidence rejects', () => {
    let r = run(fixture('same-family'), 'start', { messages: [usage('GPT-6.1-Sol', { turnId: undefined }), delegated('GPT-5.5')] }, ['--require-model']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = run(fixture('missing-model'), 'start', {}, ['--require-model']); assert.equal(r.status, 5, r.stderr + r.stdout);
    assert.equal(r.events.at(-1).actualModel, null); assert.equal(r.events.at(-1).event, 'failed');
  });
  check('ordinary turns record cross-family execution without review rejection', () => {
    const r = run(fixture('ordinary-mismatch'), 'start', { messages: [usage('DeepSeek-V4.1-Flash')] });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.events.at(-1).modelMismatch, true);
  });
  check('TTADK matching rollout turn_context wins over metadata and other turns', () => {
    const f = fixture('ttadk-context', 'ttadk'), sessions = path.join(f.accountHome, 'sessions/2026/11/15');
    fs.mkdirSync(sessions, { recursive: true }); const rollout = path.join(sessions, 'rollout-fixture-guard-thread.jsonl');
    fs.writeFileSync(rollout, [
      { type: 'session_meta', payload: { model_provider: 'ttadk_app' } },
      { type: 'turn_context', payload: { turn_id: 'old-turn', model: 'deepseek-v4.1-flash' } },
      { type: 'turn_context', payload: { turn_id: 'guard-turn', model: 'gpt-6.1-sol', effort: 'high' } },
      { type: 'turn_context', payload: { turn_id: 'other-turn', model: 'kimi-k3' } },
    ].map(JSON.stringify).join('\n'));
    const r = run(f, 'turn', { rollout, metadataModel: 'kimi-k3' }, ['--require-model']);
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /actual-model: gpt-6.1-sol.*source turn-context/);
    assert.equal(r.events.at(-1).actualModelProvider, 'ttadk_app');
    assert.equal(rolloutTurnModel(f.accountHome, rollout, 'guard-thread', 'absent-turn'), null);
    const outside = path.join(f.dir, 'rollout-other-guard-thread.jsonl'); fs.copyFileSync(rollout, outside);
    assert.equal(rolloutTurnModel(f.accountHome, outside, 'guard-thread', 'guard-turn'), null);
  });
  assert.equal(modelFamily('doubao-pro'), modelFamily('Seed-2.1-Pro'));
  assert.equal(modelObservation(delegated('DeepSeek-V4.1-Flash', { item: { type: 'collabAgentToolCall', senderThreadId: 'other', receiverThreadIds: ['child'], model: 'DeepSeek-V4.1-Flash' } }), 'guard-thread', 'guard-turn'), null);
  console.log(`Worker guards: ${passed}/${passed} passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
