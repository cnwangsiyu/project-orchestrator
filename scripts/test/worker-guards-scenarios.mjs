#!/usr/bin/env node
// Launcher regressions use only synthetic homes, public records, and an in-memory hub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDigest } from '../lib/global-rules.mjs';
import { inbox } from '../lib/worker-events.mjs';
import { WORKER_NOTES, FF_MAIN_WORKER_NOTE } from '../lib/fixed-worker-notes.mjs';
import { modelFamily, modelObservation, rolloutTurnModel } from '../lib/worker-model.mjs';
import { failureKind, pauseDecision, noteFailure } from '../lib/trae-health.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-guards-')));
const transport = path.join(scripts, 'test/fixtures/worker-guards-transport.mjs');
let passed = 0;
const rows = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const fixture = (label, kind = 'trae') => {
  const dir = path.join(tmp, label), home = path.join(dir, 'home'), accountHome = path.join(home, 'account');
  fs.mkdirSync(accountHome, { recursive: true });
  fs.writeFileSync(path.join(dir,'fallback-off.json'), '{"enabled":false}');
  const profiles = path.join(dir, 'accounts.json'), rpc = path.join(dir, 'rpc.jsonl'), log = path.join(dir, 'route.jsonl');
  fs.writeFileSync(profiles, JSON.stringify({ fixture: { kind, home: accountHome, hub: 'ws://127.0.0.1:1',
    modelIds: { 'gpt-6.1-sol': 'GPT-6.1-Sol' } } }));
  return { dir, accountHome, rpc, log, env: { ...process.env, HOME: home, CODEX_HOME: accountHome, CODEX_HUB: 'ws://127.0.0.1:1',
    CODEX_ACCOUNTS: profiles, RULES_SHARED: dir, PERSONAL_FALLBACK_FILE:path.join(dir,'fallback-off.json'), ROUTE_LOG_FILE: log, NODE_OPTIONS: '', ORCHESTRATOR_OWNER: '',
    CLAUDE_SESSION_ID: '', CLAUDE_JOB_DIR: '', CLAUDECODE: '' } };
};
const run = (f, cmd = 'start', config = {}, flags = []) => {
  const r = spawnSync(process.execPath, ['--import', transport, path.join(scripts, 'codex-worker.mjs'), '--account', f.account ?? 'fixture', cmd,
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
  check('interrupt resolves an omitted turn and honors an explicit string target',()=>{
    for (const explicit of [false,true]) {
      const r=run(fixture(`interrupt-target-${explicit}`),'interrupt',{},explicit?['--turn','explicit-turn']:[]);
      assert.equal(r.status,0,r.stderr);
      const call=r.calls.find(c=>c.method==='turn/interrupt');
      assert.deepEqual(call.params,{threadId:'guard-thread',turnId:explicit?'explicit-turn':'guard-turn'});
      assert.equal(r.calls.some(c=>c.method==='thread/read'),!explicit);
      assert.deepEqual(r.events,[]);
    }
  });
  check('interrupt rejects malformed IDs before RPC and explains unresolved turns',()=>{
    for (const flags of [['--turn'],['--turn','true'],['--thread']]) {
      const r=run(fixture(`interrupt-invalid-${flags.join('-')}`),'interrupt',{},flags);
      assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/--turn|--thread/);assert.equal(r.calls.length,0);
    }
    for (const config of [{turn:true},{rpcFailure:'thread/read'},{status:'completed'}]) {
      const r=run(fixture(`interrupt-unresolved-${JSON.stringify(config).replaceAll(/[^a-z]/g,'')}`),'interrupt',config);
      assert.ok([2,3].includes(r.status),r.stderr);assert.match(r.stderr,/--turn <public turn-id>/);
      assert.ok(!r.calls.some(c=>c.method==='turn/interrupt'));
    }
  });
  check('BC-35 one-shot startup failure surfaces stderr and records a failed worker',()=>{
    const f=fixture('one-shot-failure','chatgpt'),out=path.join(f.dir,'start.out'),log=path.join(f.dir,'start.log');
    const r=spawnSync('/bin/sh',[path.join(scripts,'run-tracked.sh'),'--name','one-shot-failure','--owner','053283ad-1bc8-5a31-ad44-d68e6b199eb6','--account','fixture',
      '--model','gpt-6.1-sol','--log',log,'--out',out,'--',process.execPath,'-e',
      'console.error("Not inside a trusted directory and --skip-git-repo-check was not specified");process.exit(9)'],{env:f.env,encoding:'utf8',timeout:5000});
    assert.equal(r.status,9);assert.match(r.stderr,/launch failed before producing a thread\/turn/);assert.match(r.stderr,/Not inside a trusted directory/);
    assert.equal(rows(path.join(f.dir,'worker-events.jsonl')).at(-1).event,'failed');assert.match(fs.readFileSync(log,'utf8'),/skip-git-repo-check/);
    assert.ok(!fs.existsSync(out));
  });
  check('main c702ec4: accepted one-shot exit zero without output still fails',()=>{
    const f=fixture('accepted-no-output','chatgpt'),out=path.join(f.dir,'missing.out');
    const r=spawnSync('/bin/sh',[path.join(scripts,'run-tracked.sh'),'--name','accepted-no-output','--owner','053283ad-1bc8-5a31-ad44-d68e6b199eb6','--account','fixture',
      '--model','gpt-6.1-sol','--out',out,'--',process.execPath,'-e',
      'console.log(JSON.stringify({type:"thread.started",thread_id:"accepted-thread"}));'],{env:f.env,encoding:'utf8',timeout:5000});
    assert.equal(r.status,1);assert.equal(rows(path.join(f.dir,'worker-events.jsonl')).at(-1).event,'failed');assert.ok(!fs.existsSync(out));
  });
  check('company unavailability is scoped for TTADK and TRAE; resume injects current digest',()=>{
    for(const kind of ['ttadk','trae']) {
      const f=fixture(`company-unavailable-${kind}`,kind);
      const r=run(f,'start',{failure:'model gpt-6.1-sol unavailable because metadata could not be resolved'});
      assert.equal(r.status,1,r.stderr+r.stdout);{const health=JSON.parse(fs.readFileSync(path.join(f.accountHome,'worker-health.json'),'utf8'));assert.ok(health.modelPauses['gpt-6.1-sol']);assert.ok(!health.pools?.gpt,'ordinary unavailable is not a family restriction');}
    }
    const r=run(fixture('resume-current-digest'),'turn');const resume=r.calls.find(c=>c.method==='thread/resume');
    assert.ok(resume.params.developerInstructions.includes(loadDigest().worker));
    for(const clause of Object.values(WORKER_NOTES)) assert.ok(resume.params.developerInstructions.includes(clause),clause);
    assert.match(resume.params.developerInstructions,/never overwrite, delete or move files outside the task's scope.*restore.*byte-for-byte/);
    assert.match(resume.params.developerInstructions,/no sub-agents/);assert.match(resume.params.developerInstructions,/dependencies and build tools/);
  });
  check('TTADK setup accepts a fresh qualified catalog without Sol',()=>{
    const f=fixture('setup-no-sol','ttadk'),preload=path.join(f.dir,'setup-preload.mjs');
    fs.writeFileSync(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.execFileSync=(bin,args)=>{if(bin==='/bin/zsh')return '/fixture/ttadk\\n';if(bin==='/fixture/ttadk'&&args[0]==='auth')return JSON.stringify({providers:[{provider:'sso',status:'active'}]});if(bin==='/fixture/ttadk'&&args[0]==='models')return JSON.stringify([{id:'gpt-5.6-terra',availableAgents:['codex']}]);throw Error('fixture forbids external subprocess: '+bin);};syncBuiltinESMExports();`);
    const r=spawnSync(process.execPath,['--import',preload,path.join(scripts,'codex-worker.mjs'),'ttadk-setup','--name','gateway','--home',f.accountHome,'--port','49901'],{env:f.env,encoding:'utf8',timeout:5000});
    assert.equal(r.status,0,r.stderr+r.stdout);assert.match(fs.readFileSync(path.join(f.accountHome,'config.toml'),'utf8'),/model = "gpt-5.6-terra"/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.env.CODEX_ACCOUNTS,'utf8')).gateway.models,['gpt-5.6-terra']);
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
      assert.deepEqual(r.events, [], 'control commands never write caller-owned run events');
    });
  }
  for (const unrelatedChatter of [false, true]) check(`zero own events stalls with unrelated chatter=${unrelatedChatter}`, () => {
    const r = run(fixture(`idle-${unrelatedChatter}`), 'start', { quiet: true, unrelatedChatter }, ['--stall-min', '0.003']);
    assert.equal(r.status, 4, r.stderr + r.stdout); assert.match(r.stdout, /stalled: no events/);
    assert.equal(r.events.at(-1).phase, 'follow'); assert.equal(r.events.at(-1).mayRun, true);
  });
  for (const listData of [[], [{ id: 'guard-thread', status: { type: 'idle' } }],
    [{ id: 'guard-thread', status: { type: 'active' } }], [{ id: 'guard-thread' }]]) {
    check(`setup settlement: ${JSON.stringify(listData)}`, () => {
      const f = fixture(`settlement-${passed}`), r = run(f, 'turn', { hang: 'thread/resume', listData }, ['--stall-min', '0.003', '--owner', '0ad99da2-c51e-56ce-9fb8-8a5d5919b31e']);
      assert.equal(r.status, 4, r.stderr);
      const settled = !listData.length || listData[0].status?.type === 'idle';
      assert.equal(r.events.at(-1).settled === true, settled);
      assert.equal(r.events.at(-1).mayRun, !settled);
      assert.equal(inbox(r.events, '0ad99da2-c51e-56ce-9fb8-8a5d5919b31e').running.length, settled ? 0 : 1, 'mine no longer sees a settled setup as unknown');
    });
  }
  check('large rollout and cumulative token guards refuse before contacting hub', () => {
    const f = fixture('large-rollout'), dir = path.join(f.accountHome, 'cli/sessions/2020/01/01');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-old-guard-thread.jsonl');
    fs.writeFileSync(file, ''); fs.truncateSync(file, 6 * 1024 * 1024);
    const route = ['implement', '--project', 'guards', '--name', 'large', '--impact', 'service', '--failure-kind', 'quality'];
    let r = run(f, 'turn', {}, ['--route-args', JSON.stringify(route)]);
    assert.equal(r.status, 9); assert.match(r.stderr, /fresh thread with a handoff brief/);
    assert.match(r.stderr, /'--project' 'guards'.*'--failure-kind' 'infra'/); assert.deepEqual(r.calls, []);
    assert.equal(r.events.at(-1).settled, true);
    r = run(f, 'turn', {}, ['--force-large']); assert.equal(r.status, 0, r.stderr);
    r = run(f, 'turn', {}, ['--max-rollout-mb', '7']); assert.equal(r.status, 0, r.stderr);
    fs.writeFileSync(file, JSON.stringify({ payload: { info: { total_token_usage: { input_tokens: 20000001 } } } }) + '\n');
    const before = rows(f.rpc).length;
    r = run(f, 'turn'); assert.equal(r.status, 9); assert.equal(r.calls.length, before);
    r = run(f, 'turn', {}, ['--max-input-tokens', '21000000']); assert.equal(r.status, 0, r.stderr);
    f.env.CODEX_WORKER_MAX_INPUT_TOKENS = '10';
    r = run(f, 'turn'); assert.equal(r.status, 9);
    f.env.CODEX_WORKER_MAX_INPUT_TOKENS = '21000000'; f.env.CODEX_WORKER_MAX_ROLLOUT_MB = '.00001';
    r = run(f, 'turn'); assert.equal(r.status, 9);
  });
  check('BC-75 request buffer errors are thread-too-large, never account/model health failures', () => {
    const f = fixture('request-buffer-health', 'ttadk'), now = Date.now();
    for (const error of ['-4399: upstream rejected request', '{"code":-4399}', 'exceeded request buffer limit while retrying upstream',
      'EXCEEDED REQUEST BUFFER LIMIT; model gpt-6.1-sol unavailable; 429 rate limit']) {
      assert.equal(failureKind(error), 'thread-too-large');
      assert.equal(pauseDecision([{ t: now, why: error }, { t: now, why: error }], now), null);
      assert.equal(pauseDecision([{ t: now, why: error }, { t: now, why: 'gateway timeout' }], now), null);
      assert.equal(noteFailure(f.accountHome, error, now, 'gpt-6.1-sol'), null);
      assert.ok(!fs.existsSync(path.join(f.accountHome, 'worker-health.json')));
    }
    for (const [error, kind] of [['-43990: gateway error', 'transient'], ['4399: gateway error', 'transient'],
      ['request queue size is exceed', 'transient'], ['429 too many requests', 'transient'], ['401 Unauthorized', 'auth'],
      ['403 Forbidden: quota exceeded', 'hard'], ['model gpt-6.1-sol unavailable', 'unavailable']]) assert.equal(failureKind(error), kind);
    const file = path.join(f.accountHome, 'worker-health.json'), prior = '{"failures":[{"t":1,"why":"gateway timeout"}]}\n';
    fs.writeFileSync(file, prior);
    noteFailure(f.accountHome, '-4399: upstream rejected request', now, 'gpt-6.1-sol');
    assert.equal(fs.readFileSync(file, 'utf8'), prior);
  });
  for (const kind of ['ttadk', 'trae']) for (const cmd of ['start', 'turn']) {
    check(`BC-75 ${kind} ${cmd} terminal buffer failure persists and refuses the next turn`, () => {
      const f = fixture(`request-buffer-terminal-${kind}-${cmd}`, kind);
      const route = ['implement', '--project', 'guards', '--name', 'buffer', '--impact', 'service', '--failure-kind', 'quality'];
      const error = cmd === 'start' ? { code: -4399, message: 'upstream rejected request' }
        : { message: 'exceeded request buffer limit while retrying upstream; model gpt-6.1-sol unavailable; 429 rate limit' };
      const r = run(f, cmd, { failure: error, status: 'failed', hang: 'thread/read' }, ['--route-args', JSON.stringify(route), '--auto-reroute-depth', '2']);
      assert.equal(r.status, 9, r.stderr + r.stdout);
      assert.match(r.stderr, /large-thread: guard-thread: provider request buffer exceeded on \d{4}-/);
      assert.match(r.stderr, /'--project' 'guards'.*'--failure-kind' 'infra'/);
      assert.doesNotMatch(r.stdout, /rate-limited:|trae-failed:|trae-paused:|model-unavailable:|rerout/);
      assert.equal(r.calls.filter(c => c.method === 'turn/start').length, 1);
      assert.ok(!r.calls.some(c => c.method === 'thread/read'), 'buffer rejection must not await a recovery read');
      assert.ok(!r.records.some(row => row.kind === 'reroute'));
      assert.ok(!fs.existsSync(path.join(f.accountHome, 'worker-health.json')));
      const launch = path.join(f.dir, 'worker-launches/fixture/guard-thread.json');
      const saved = JSON.parse(fs.readFileSync(launch, 'utf8'));
      assert.equal(saved.defaults['route-args'], JSON.stringify(route));
      assert.ok(Number.isFinite(saved.requestBufferExceededAt));
      assert.equal(r.events.at(-1).event, 'needs-user');
      assert.equal(r.events.at(-1).reason, 'thread-too-large');
      assert.equal(r.events.at(-1).phase, 'thread-size');
      assert.equal(r.events.at(-1).settled, true); assert.equal(r.events.at(-1).mayRun, false);
      let next = run(f, 'turn');
      assert.equal(next.status, 9, next.stderr + next.stdout); assert.deepEqual(next.calls, r.calls);
      assert.ok(next.stderr.includes(new Date(saved.requestBufferExceededAt).toISOString()));
      assert.match(next.stderr, /'--project' 'guards'.*'--failure-kind' 'infra'/);
      next = run(f, 'turn', {}, ['--force-large']);
      assert.equal(next.status, 0, next.stderr + next.stdout);
      assert.equal(next.calls.filter(c => c.method === 'turn/start').length, 2);
      assert.equal(JSON.parse(fs.readFileSync(launch, 'utf8')).requestBufferExceededAt, saved.requestBufferExceededAt);
      next = run(f, 'turn', { failure: error }, ['--force-large']);
      assert.equal(next.status, 9, next.stderr + next.stdout);
      assert.equal(JSON.parse(fs.readFileSync(launch, 'utf8')).requestBufferExceededAt, saved.requestBufferExceededAt);
      const afterForce = next.calls;
      next = run(f, 'turn', {}, ['--max-rollout-mb', '100', '--max-input-tokens', '100000000']);
      assert.equal(next.status, 9); assert.deepEqual(next.calls, afterForce, 'larger local limits cannot bypass the provider marker');
      next = run(f, 'turn', { thread: 'fresh-thread' }, ['--thread', 'fresh-thread']);
      assert.equal(next.status, 0, next.stderr + next.stdout);
      const profiles = JSON.parse(fs.readFileSync(f.env.CODEX_ACCOUNTS, 'utf8'));
      profiles.other = profiles.fixture; fs.writeFileSync(f.env.CODEX_ACCOUNTS, JSON.stringify(profiles));
      next = run({ ...f, account: 'other' }, 'turn'); assert.equal(next.status, 0, next.stderr + next.stdout);
    });
  }
  for (const cmd of ['start', 'turn']) for (const method of ['turn/start', 'thread/resume']) {
    check(`BC-75 ${cmd} RPC buffer failure at ${method} stops before retry/reroute`, () => {
      const f = fixture(`request-buffer-rpc-${cmd}-${method.replace('/', '-')}`, 'ttadk');
      const r = run(f, cmd, { rpcFailure: method, rpcError: { code: -4399, message: 'upstream rejected request' } },
        ['--route-args', JSON.stringify(['implement', '--impact', 'service']), '--auto-reroute-depth', '2']);
      assert.equal(r.status, 9, r.stderr + r.stdout); assert.match(r.stderr, /large-thread: guard-thread: provider request buffer exceeded/);
      assert.equal(r.calls.filter(c => c.method === 'turn/start').length, method === 'turn/start' ? 1 : 0);
      assert.ok(Number.isFinite(JSON.parse(fs.readFileSync(path.join(f.dir, 'worker-launches/fixture/guard-thread.json'), 'utf8')).requestBufferExceededAt));
      assert.equal(r.events.at(-1).phase, 'thread-size');
      const next = run(f, 'turn'); assert.equal(next.status, 9); assert.deepEqual(next.calls, r.calls);
      assert.match(next.stderr, /'implement' '--impact' 'service' '--failure-kind' 'infra'/);
    });
  }
  check('BC-75 buffer failure before thread creation prints guidance without inventing a thread marker', () => {
    const f = fixture('request-buffer-thread-start', 'ttadk');
    const r = run(f, 'start', { rpcFailure: 'thread/start', rpcError: { code: -4399, message: 'upstream rejected request' } });
    assert.equal(r.status, 9, r.stderr + r.stdout); assert.match(r.stderr, /large-thread: <not created>.*fresh thread with a handoff brief/);
    assert.match(r.stderr, /No saved --route-args/); assert.ok(!fs.existsSync(path.join(f.dir, 'worker-launches')));
    assert.equal(r.events.at(-1).thread, null); assert.equal(run(f, 'turn').status, 0);
  });
  check('BC-75 buffer failure preserves partial final output and unrelated RPC errors retain their fallback', () => {
    const f = fixture('request-buffer-partial', 'ttadk'), out = path.join(f.dir, 'final.md');
    const r = run(f, 'turn', { failure: { code: -4399 }, failureItems: [{ type: 'agentMessage', text: 'Partial work completed.' }] }, ['--out', out]);
    assert.equal(r.status, 9, r.stderr + r.stdout); assert.equal(fs.readFileSync(out, 'utf8'), 'Partial work completed.\n');
    for (const cmd of ['start', 'turn']) {
      const other = fixture(`ordinary-rpc-${cmd}`, 'ttadk');
      assert.equal(run(other, cmd, { rpcFailure: 'turn/start' }).status, 1);
      assert.equal(run(other, cmd, { rpcFailure: 'thread/resume' }).status, 0);
      assert.ok(!JSON.parse(fs.readFileSync(path.join(other.dir, 'worker-launches/fixture/guard-thread.json'), 'utf8')).requestBufferExceededAt);
    }
  });
  check('status preserves JSON stdout', () => {
    const r = run(fixture('status-json'), 'status'); assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).last.id, 'guard-turn');
  });
  check('continuation inherits ownership, routing, hop depth and absolute outputs; explicit flags win', () => {
    const f = fixture('inheritance'), log = path.join(f.dir, 'worker.jsonl'), out = path.join(f.dir, 'final.md');
    const route = ['analysis', '--failures', '2', '--exclude-account', 'main,b', '--exclude-model', 'gemini', '--auto-reroute-depth', '1'];
    let r = run(f, 'start', {}, ['--route-args', JSON.stringify(route), '--owner', '992e5f12-ce02-5dfc-a7c4-fc2141571136', '--name', 'saved-name', '--log', log, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(f.dir, 'worker-launches/fixture/guard-thread.json');
    let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.defaults['auto-reroute-depth'], 1);
    const startCount = r.events.length;
    r = run(f, 'turn', {}, ['--cwd', tmp]); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /inherited:.*route-args.*992e5f12-ce02-5dfc-a7c4-fc2141571136/);
    const first = r.events[startCount]; assert.equal(first.owner, '992e5f12-ce02-5dfc-a7c4-fc2141571136'); assert.equal(first.name, 'saved-name');
    assert.equal(first.logFile, log); assert.equal(first.outFile, out);
    assert.deepEqual(r.events.at(-1).routeArgs, route); assert.equal(r.events.at(-1).rerouteDepth, 1);
    assert.match(fs.readFileSync(out, 'utf8'), /DONE guard fixture/);
    const override = ['analysis', '--failures', '0'];
    r = run(f, 'turn', {}, ['--owner', '53c2153d-01d9-58cb-8ce2-af1dcc0581be', '--route-args', JSON.stringify(override), '--auto-reroute-depth', '2', '--out', path.join(f.dir, 'override.md')]);
    assert.equal(r.status, 0, r.stderr); assert.equal(r.events.at(-1).owner, '53c2153d-01d9-58cb-8ce2-af1dcc0581be');
    assert.deepEqual(r.events.at(-1).routeArgs, override); assert.equal(r.events.at(-1).rerouteDepth, 2);
    saved = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(saved.defaults.out, path.join(f.dir, 'override.md'));
    assert.equal(saved.defaults.cwd, tmp); assert.equal(saved.defaults.log, log);
  });
  check('legacy continuation has no invented routing context', () => {
    const r = run(fixture('legacy'), 'turn'); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /inherited: no saved launch/); assert.equal(r.events.at(-1).routeArgs, null);
  });
  check('project landing permission is injected for starts and inherited turns only when opted in', () => {
    for (const kind of ['trae', 'ttadk']) for (const project of ['video-agent', 'guards', null]) {
      const f = fixture(`landing-${kind}-${project ?? 'none'}`, kind);
      const route = ['implement', '--impact', 'service', ...(project ? ['--project', project] : [])];
      let r = run(f, 'start', {}, ['--route-args', JSON.stringify(route)]);
      assert.equal(r.status, 0, r.stderr);
      const start = r.calls.find((c) => c.method === 'thread/start').params.developerInstructions;
      r = run(f, 'turn'); assert.equal(r.status, 0, r.stderr);
      const resume = r.calls.filter((c) => c.method === 'thread/resume').at(-1).params.developerInstructions;
      for (const instructions of [start, resume]) {
        if (project === 'video-agent') {
          assert.ok(instructions.includes(FF_MAIN_WORKER_NOTE));
          assert.doesNotMatch(instructions, /never push to main/);
          assert.equal(instructions.replace(FF_MAIN_WORKER_NOTE, WORKER_NOTES.commits).includes(loadDigest().worker), true);
        } else {
          assert.ok(instructions.includes(WORKER_NOTES.commits));
          assert.ok(!instructions.includes(FF_MAIN_WORKER_NOTE));
        }
      }
      assert.deepEqual(r.events.at(-1).routeArgs, route, 'project permission does not alter route args');
    }
  });
  check('inherited queue cancellation still enforces two-hop limit', () => {
    const f = fixture('inherited-queue');
    let r = run(f, 'start', {}, ['--owner', '6d7e64f9-44ee-59b9-9db9-22df760e91f3', '--route-args', JSON.stringify(['analysis', '--failures', '1', '--exclude-account', 'main,b']),
      '--auto-reroute-depth', '2', '--queue-patience-min', '0.0001']);
    assert.equal(r.status, 0, r.stderr);
    r = run(f, 'turn', { quiet: true, messages: [{ method: 'queue/status', params: { threadId: 'guard-thread', turnId: 'guard-turn', state: 'queued', position: 100 } }] });
    assert.equal(r.status, 10, r.stderr + r.stdout); assert.match(r.stdout, /reroute-depth-limit/);
    assert.ok(r.calls.some((call) => call.method === 'turn/interrupt')); assert.equal(r.events.at(-1).owner, '6d7e64f9-44ee-59b9-9db9-22df760e91f3');
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
