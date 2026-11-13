#!/usr/bin/env node
// Real hook/launch/wrapper/review entry points; synthetic metadata and stub providers/res only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { loadDigest } from '../lib/global-rules.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-enforcement-'));
const shared = path.join(tmp, '.claude/orchestrator/_shared'), log = path.join(shared, 'route-log.jsonl');
const env = { ...process.env, HOME: tmp, RULES_SHARED: shared, ROUTE_LOG_FILE: log, TRAE_PROBE: '0', QUOTA_LOG: '0' };
const append = (row) => fs.appendFileSync(log, JSON.stringify(row) + '\n');
const rows = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const cli = (script, args = [], overrides = {}) => execFileSync(process.execPath, [path.join(scripts, script), ...args],
  { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  fs.mkdirSync(shared, { recursive: true }); fs.writeFileSync(log, '');
  const digest = loadDigest();
  assert.ok(digest.text.split('\n').length <= 60);
  const invoke = (input, overrides = {}) => {
    const start = performance.now();
    const result = spawnSync(process.execPath, [path.join(scripts, 'rules-digest-hook.mjs')],
      { env: { ...env, ...overrides }, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 1000 });
    assert.equal(result.status, 0); assert.ok(performance.now() - start < 300, 'hook must complete under 300ms');
    assert.equal(result.stderr, ''); return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  const event = (extra = {}) => ({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's1', cwd: tmp, ...extra });
  assert.equal(invoke(event()), null);
  let output = invoke(event({ session_title: 'Test 主对话' }));
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(output.hookSpecificOutput.additionalContext.includes(digest.text));
  assert.equal(JSON.parse(fs.readFileSync(path.join(shared, 'rules-seen.json'))).s1.version, digest.version);
  assert.match(invoke(event({ source: 'compact' })).hookSpecificOutput.additionalContext, /No changes since/);
  fs.writeFileSync(path.join(shared, 'orchestrators.txt'), '# comment\nRoster owner\n');
  assert.ok(invoke(event({ session_id: 's2', session_title: 'Roster owner' })));
  const transcript = path.join(tmp, '.claude/projects/fixture/session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ tool_input: { file_path: '/skills/project-orchestrator/SKILL.md' } }));
  assert.ok(invoke(event({ session_id: 's3', transcript_path: transcript })));
  const changed = path.join(tmp, 'digest.md');
  const [versionDate, revision] = digest.version.split('.');
  const changedVersion = `${versionDate}.${Number(revision) + 1}`, removedVersion = `${versionDate}.${Number(revision) + 2}`;
  fs.writeFileSync(changed, digest.text.replace(digest.version, changedVersion).replace('## Details', '- New version test rule.\n\n## Details'));
  output = invoke(event({ source: 'resume' }), { RULES_DIGEST: changed });
  assert.ok(output.hookSpecificOutput.additionalContext.includes(`${digest.version} -> ${changedVersion}`));
  assert.match(output.hookSpecificOutput.additionalContext, /New version test rule/);
  fs.writeFileSync(changed, fs.readFileSync(changed, 'utf8').replace(changedVersion, removedVersion).replace('- New version test rule.\n', ''));
  assert.match(invoke(event({ source: 'compact' }), { RULES_DIGEST: changed }).hookSpecificOutput.additionalContext,
    /Removed\/replaced:\n- New version test rule/);
  for (const input of ['{broken', '{}', event({ source: 'clear' }), event({ session_id: '__proto__' })]) assert.equal(invoke(input), null);
  assert.equal(invoke(event({ session_title: 'Fail 主对话' }), { RULES_DIGEST: path.join(tmp, 'missing') }), null);
  fs.mkdirSync(path.join(shared, 'rules-seen.json.lock'));
  assert.ok(invoke(event({ session_title: 'Contended 主对话', session_id: 's4' })));
  assert.equal(JSON.parse(fs.readFileSync(path.join(shared, 'rules-seen.json'))).s4, undefined);
  fs.rmdirSync(path.join(shared, 'rules-seen.json.lock'));
  console.log('ok   hook identity, roster/transcript, versions, fail-open parsing/contention and <300ms');

  const stalledIO = path.join(tmp, 'stalled-io.mjs');
  fs.writeFileSync(stalledIO, `import fs from 'node:fs/promises';
const open=fs.open, write=fs.writeFile, realpath=fs.realpath;
const stalled=()=>new Promise(()=>{});
fs.open=(file,...args)=>((process.env.STALL_PHASE==='seen'&&String(file).endsWith('rules-seen.json'))||(process.env.STALL_PHASE==='digest'&&String(file).endsWith('global-rules.md')))?stalled():open(file,...args);
fs.writeFile=(file,...args)=>process.env.STALL_PHASE==='write'?stalled():write(file,...args);
fs.realpath=(file,...args)=>process.env.STALL_PHASE==='transcript'?stalled():realpath(file,...args);
`);
  for (const phase of ['seen', 'digest', 'write', 'transcript']) {
    const start = performance.now();
    const input = phase === 'transcript' ? event({ session_id: 'stall-transcript', transcript_path: transcript }) : event({ session_id: 'stall-' + phase, session_title: 'Stall 主对话' });
    const result = spawnSync(process.execPath, ['--import', stalledIO, path.join(scripts, 'rules-digest-hook.mjs')],
      { env: { ...env, STALL_PHASE: phase }, input: JSON.stringify(input), encoding: 'utf8', timeout: 1500 });
    const elapsed = performance.now() - start;
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.ok(elapsed >= 600 && elapsed < 1000, `${phase}: hard fail-open deadline, ${elapsed}ms`);
    fs.rmSync(path.join(shared, 'rules-seen.json.lock'), { recursive: true, force: true });
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(scripts, '../templates/session-start-hook.json'))).hooks.SessionStart[0].hooks[0].timeout, 2);
  console.log('ok   async hook hard deadline under stalled seen/digest/transcript reads and atomic writes');

  const now = Date.now();
  append({ t: now - 1000, project: 'p', name: 'T1', category: 'implement', pick: { vendor: 'codex', model: 'gpt-6.1-sol', account: 'ttadk' } });
  cli('launch-audit.mjs', ['--name', 'p-T1-fix1', '--account', 'ttadk', '--model', 'gpt-6.1-sol', '--vendor', 'codex']);
  assert.equal(rows().at(-1).routeAt, now - 1000);
  assert.equal(rows().filter((row) => row.kind === 'unrouted').length, 0);
  const missing = spawnSync(process.execPath, [path.join(scripts, 'launch-audit.mjs'), '--name', 'T10', '--account', 'main', '--model', 'gpt-6.1-sol'], { env, encoding: 'utf8' });
  assert.equal(missing.status, 0); assert.match(missing.stderr, /unrouted-launch/);
  assert.equal(rows().filter((row) => row.kind === 'unrouted').length, 1);
  append({ t: now - 25 * 3600000, name: 'old', category: 'lookup' });
  cli('launch-audit.mjs', ['--name', 'old', '--account', 'main', '--model', 'gpt-6.1-sol']);
  assert.equal(rows().filter((row) => row.kind === 'unrouted').length, 2);
  console.log('ok   launch detection: exact/project/task prefix, word boundaries, stale decisions and nonblocking warning');

  const transport = path.join(tmp, 'transport.mjs'), captured = path.join(tmp, 'instructions.json');
  fs.writeFileSync(transport, `import fs from 'node:fs';
globalThis.WebSocket=class { constructor(){setImmediate(()=>this.onopen());} close(){} send(raw){
const m=JSON.parse(raw);if(m.id==null)return;if(m.method==='thread/start')fs.writeFileSync(process.env.CAPTURE,JSON.stringify(m.params));
setImmediate(()=>{this.onmessage({data:JSON.stringify({id:m.id,result:m.method==='thread/start'?{thread:{id:'fixture'}}:m.method==='turn/start'?{turn:{id:'turn'}}:{}})});
if(m.method==='turn/start')setImmediate(()=>this.onmessage({data:JSON.stringify({method:'turn/completed',params:{threadId:'fixture',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'DONE'}]}}})}));});}};`);
  const profiles = path.join(tmp, 'profiles.json'); fs.writeFileSync(profiles, JSON.stringify({ main: { home: tmp, hub: 'ws://127.0.0.1:1' } }));
  execFileSync(process.execPath, ['--import', transport, path.join(scripts, 'codex-worker.mjs'), '--account', 'main', 'start',
    '--cwd', tmp, '--effort', 'high', '--sandbox', 'read-only', '--model', 'gpt-6.1-sol', '--name', 'p-T1', '--log', path.join(tmp, 'worker.jsonl'), 'reply DONE'],
  { env: { ...env, CODEX_ACCOUNTS: profiles, CAPTURE: captured }, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(fs.readFileSync(captured)).developerInstructions, `Global worker rules ${digest.version}\n${digest.worker}`);
  assert.equal(rows().at(-1).kind, 'launch'); assert.equal(rows().at(-1).account, 'main');
  console.log('ok   real codex-worker start injects the single-source worker digest and records launch evidence');
  const probeBin = path.join(tmp, 'probe-bin'), spawned = path.join(tmp, 'unexpected-hub-spawn');
  fs.mkdirSync(probeBin);
  fs.writeFileSync(path.join(probeBin, 'codex'), `#!/bin/sh\ntouch '${spawned}'\nexit 1\n`, { mode: 0o755 });
  const reachableHub = cli('codex-worker.mjs', ['--account', 'main', 'hub'], { CODEX_ACCOUNTS: profiles,
    NODE_OPTIONS: `--import ${transport}`, PATH: `${probeBin}:${process.env.PATH}` });
  assert.match(reachableHub, /hub up/); assert.ok(!fs.existsSync(spawned));
  console.log('ok   real hub command probes with list and never starts a duplicate reachable hub');

  const res = path.join(tmp, 'res'), reslog = path.join(tmp, 'res.jsonl'), holds = path.join(tmp, 'holds.json');
  fs.writeFileSync(res, `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2),id=a[1],by=a[a.indexOf('--by')+1];
fs.appendFileSync(process.env.RES_LOG,JSON.stringify({cmd:a[0],id,args:a})+'\\n');
let h={};try{h=JSON.parse(fs.readFileSync(process.env.RES_HOLDS));}catch{}
if(a[0]==='wait'){if(process.env.BLOCK_ID===id){setInterval(()=>{},1000);}else if(process.env.FAIL_ID===id){process.exit(2);}else{h[id]=by;fs.writeFileSync(process.env.RES_HOLDS,JSON.stringify(h));if(process.env.INTERRUPT_RESOURCE===id){process.kill(Number(a[a.indexOf('--pid')+1]),process.env.RACE_SIGNAL);setInterval(()=>{},1000);}}}
if(a[0]==='return'){if(h[id]!==by)process.exit(2);if(process.env.REPEAT_RETURN_SIGNAL){for(const sig of ['SIGTERM','SIGHUP','SIGINT'])process.kill(process.ppid,sig);}delete h[id];fs.writeFileSync(process.env.RES_HOLDS,JSON.stringify(h));}
`, { mode: 0o755 });
  const buildEnv = { ...env, RES_COMMAND: res, RES_LOG: reslog, RES_HOLDS: holds, HEAVY_BUILD_BY: 'fixture-holder',
    HEAVY_BUILD_PROJECT: 'p', HEAVY_BUILD_TASK: 'B1', HEAVY_BUILD_TIMEOUT: '0.01' };
  const reset = () => { fs.writeFileSync(reslog, ''); fs.writeFileSync(holds, '{}'); };
  const resrows = () => fs.readFileSync(reslog, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  for (const status of [0, 7]) {
    reset();
    const result = spawnSync('/bin/bash', [path.join(scripts, 'heavy-build.sh'), '/bin/sh', '-c', `exit ${status}`], { env: buildEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(resrows().map((row) => `${row.cmd}:${row.id}`), ['wait:heavy-build', 'wait:heavy-lane-1', 'return:heavy-lane-1', 'return:heavy-build']);
    assert.deepEqual(JSON.parse(fs.readFileSync(holds)), {});
    assert.ok(resrows().filter((row) => row.cmd === 'wait').every((row) => row.args.includes('--pid') && row.args.includes('--timeout')));
  }
  reset();
  assert.equal(spawnSync('/bin/bash', [path.join(scripts, 'heavy-build.sh'), '/bin/true'], { env: { ...buildEnv, FAIL_ID: 'heavy-lane-1' }, timeout: 5000 }).status, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(holds)), {});
  assert.deepEqual(resrows().filter((row) => row.cmd === 'return').map((row) => row.id), ['heavy-build']);
  const raceDriver = path.join(tmp, 'race-driver.sh');
  fs.writeFileSync(raceDriver, `set -T
hit=0
race() {
  local cmd="$1"
  [ "$hit" -eq 0 ] || return 0
  case "$RACE_STAGE" in
    before_pid) [ "$cmd" = 'child=$!' ] && [ "\${acquiring:-}" = "$RACE_RESOURCE" ] ;;
    after_wait) [ "$cmd" = 'status=$?' ] && [ "\${acquiring:-}" = "$RACE_RESOURCE" ] ;;
    clear_child) [ "$cmd" = "child=''" ] && [ "\${acquiring:-}" = "$RACE_RESOURCE" ] ;;
    before_return) [ "$cmd" = 'return "$status"' ] && [ "\${acquiring:-}" = "$RACE_RESOURCE" ] ;;
    before_held) { [ "$cmd" = 'build_held=1' ] && [ "$RACE_RESOURCE" = heavy-build ]; } || { [ "$cmd" = 'lane_held=1' ] && [ "$RACE_RESOURCE" = heavy-lane-1 ]; } ;;
    after_held) [ "$cmd" = "acquiring=''" ] && [ "\${acquiring:-}" = "$RACE_RESOURCE" ] ;;
    payload_pid) [ "$cmd" = 'child=$!' ] && [ -z "\${acquiring:-}" ] && [ "\${lane_held:-0}" -eq 1 ] ;;
    *) return 0 ;;
  esac || return 0
  hit=1
  kill -s "$RACE_SIGNAL" "$$"
}
trap 'race "$BASH_COMMAND"' DEBUG
source "$BUILD_WRAPPER" "$@"
`);
  for (const resource of ['heavy-build', 'heavy-lane-1']) for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    for (const stage of ['before_pid', 'after_wait', 'clear_child', 'before_return', 'before_held', 'after_held']) {
      reset();
      const result = spawnSync('/bin/bash', [raceDriver, '/bin/true'], { env: { ...buildEnv, BUILD_WRAPPER: path.join(scripts, 'heavy-build.sh'), RACE_RESOURCE: resource, RACE_SIGNAL: signal, RACE_STAGE: stage, REPEAT_RETURN_SIGNAL: '1' }, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }[signal], `${resource} ${stage}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(fs.readFileSync(holds)), {}, `${resource} ${stage}`);
      const returns = resrows().filter((row) => row.cmd === 'return').map((row) => row.id);
      assert.equal(returns.length, new Set(returns).size, 'no double return after held-flag assignment');
    }
    reset();
    const interrupted = spawnSync('/bin/bash', [path.join(scripts, 'heavy-build.sh'), '/bin/true'], { env: { ...buildEnv, INTERRUPT_RESOURCE: resource, RACE_SIGNAL: signal, REPEAT_RETURN_SIGNAL: '1' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(interrupted.status, { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }[signal]);
    assert.deepEqual(JSON.parse(fs.readFileSync(holds)), {});
  }
  reset();
  assert.equal(spawnSync('/bin/bash', [raceDriver, '/bin/sleep', '10'], { env: { ...buildEnv, BUILD_WRAPPER: path.join(scripts, 'heavy-build.sh'), RACE_RESOURCE: 'heavy-lane-1', RACE_STAGE: 'payload_pid', RACE_SIGNAL: 'SIGTERM' }, timeout: 5000 }).status, 143);
  assert.deepEqual(JSON.parse(fs.readFileSync(holds)), {});
  console.log('ok   interrupted acquisition before/after PID, wait, return and held flags; cleanup survives repeated signals');
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    reset();
    const ready = path.join(tmp, `child-${signal}`);
    const child = spawn('/bin/bash', [path.join(scripts, 'heavy-build.sh'), process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`], { env: buildEnv, stdio: 'ignore' });
    const exited = once(child, 'exit');
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await tick(20);
    assert.ok(fs.existsSync(ready));
    const commandPid = Number(fs.readFileSync(ready, 'utf8'));
    child.kill(signal); const [code] = await exited;
    assert.equal(code, { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }[signal]);
    assert.deepEqual(JSON.parse(fs.readFileSync(holds)), {});
    assert.throws(() => process.kill(commandPid, 0));
  }
  reset();
  const waiting = spawn('/bin/bash', [path.join(scripts, 'heavy-build.sh'), '/bin/true'], { env: { ...buildEnv, BLOCK_ID: 'heavy-lane-1' }, stdio: 'ignore' });
  const waitingExit = once(waiting, 'exit');
  for (let i = 0; i < 100 && !resrows().some((row) => row.id === 'heavy-lane-1'); i++) await tick(20);
  waiting.kill('SIGTERM'); assert.equal((await waitingExit)[0], 143);
  assert.deepEqual(JSON.parse(fs.readFileSync(holds)), {});
  console.log('ok   heavy wrapper locks/order/PID/timeout and return on success, failure, lane miss and INT/TERM/HUP');

  const root = path.join(tmp, '.claude/orchestrator'), ledger = path.join(root, 'p/ledger.md');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, `Orchestrator session: Fixture 主对话\nrules-ack 2026-11-12.1\n`);
  const personal = { t: Date.now() - 1000, name: 'personal', project: 'p', category: 'implement',
    pick: { vendor: 'codex', model: 'gpt-6.1-sol', account: 'main' }, needsOK: ['personal quota: ask first'] };
  append(personal); cli('launch-audit.mjs', ['--name', 'personal', '--vendor', 'codex', '--account', 'main', '--model', 'gpt-6.1-sol']);
  append({ ...personal, t: personal.t + 1, name: 'approved' });
  cli('launch-audit.mjs', ['--name', 'approved', '--vendor', 'codex', '--account', 'main', '--model', 'gpt-6.1-sol', '--user-ok', 'card-123']);
  append({ t: personal.t + 2, name: 'security', project: 'p', category: 'review', security: true,
    pick: { vendor: 'codex', account: 'trae', model: 'deepseek-v4.1-flash' } });
  cli('launch-audit.mjs', ['--name', 'security', '--vendor', 'codex', '--account', 'trae', '--model', 'GPT-6.1-Sol']);
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf \'fixture\\n\'\n', { mode: 0o755 });
  const cache = path.join(tmp, 'quota.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: Date.now(), claude: [{ label: 'week (all models)', used: 10,
    resetsAt: Date.now() + 120 * 3600000, windowMins: 10080 }], codexAccounts: [], errors: {}, history: {} }));
  const before = fs.readFileSync(log, 'utf8');
  const report = JSON.parse(cli('review-data.mjs', ['--json'], { PATH: `${bin}:${process.env.PATH}`, CODEX_ACCOUNTS: profiles,
    QUOTA_CACHE: cache, QUOTA_LOG_FILE: path.join(tmp, 'empty-quota') }));
  assert.equal(fs.readFileSync(log, 'utf8'), before);
  assert.equal(report.globalRules.unrouted.length, 2);
  assert.deepEqual(report.globalRules.personalQuotaWithoutOK.map((row) => row.name), ['personal']);
  assert.deepEqual(report.globalRules.traeGPTOnSecurity.map((row) => row.name), ['security']);
  assert.equal(report.globalRules.acknowledgements[0].current, false);
  assert.ok(report.globalRules.byOrchestrator['Fixture 主对话'].length >= 3);
  assert.equal(report.globalRules.orchUsage.script, 'scripts/orch-usage.mjs');
  assert.equal(report.routing.decisions, rows().filter((row) => !row.kind && row.t > Date.now() - 86400000).length);
  console.log('ok   real review-data globalRules: actual launches/OK/security/ack/owner flags without counting events as decisions');
  console.log('\nall pass');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
