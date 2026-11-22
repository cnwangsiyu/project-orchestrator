#!/usr/bin/env node
// Fixture-only turn-end checks. Never read actual worker logs or account homes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactWorkerTurn, threadIsIdle, checkThreadIdle } from '../lib/worker-redaction.mjs';
import { redactLogFile } from '../lib/log-redaction.mjs';
import { maskedRolloutFile } from '../lib/rollout-redaction.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = path.join(scripts, 'test/fixtures/worker-redaction-transport.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-redaction-'));
const fake = 'fake-secret-123';
const owner = '47ba610f-34a8-5362-a84d-d009bffc3f5f';
const fixture = name => {
  const root = path.join(tmp, name), home = path.join(root, 'home'), thread = `${name}-thread`;
  const dir = path.join(home, 'sessions/2026/11/16'); fs.mkdirSync(dir, { recursive: true });
  const rollout = path.join(dir, `rollout-fixture-${thread}.jsonl`);
  const log = path.join(root, 'worker.jsonl'), out = path.join(root, 'last.md'), shared = path.join(root, 'shared');
  fs.mkdirSync(shared); fs.writeFileSync(rollout, JSON.stringify({ output: `-signing.storePassword=${fake}` }) + '\n');
  const accounts = path.join(root, 'accounts.json'); fs.writeFileSync(accounts, JSON.stringify({ fixture: { home, hub: 'ws://fixture' } }));
  const env = { ...process.env, HOME: home, CODEX_HOME: home, CODEX_HUB: 'ws://fixture', CODEX_ACCOUNTS: accounts,
    RULES_SHARED: shared, ROUTE_LOG_FILE: path.join(shared, 'route-log.jsonl'), ORCHESTRATOR_OWNER: '',
    CLAUDECODE: '', CLAUDE_JOB_DIR: '', NODE_OPTIONS: '', WORKER_REDACTION_FIXTURE: JSON.stringify({ thread, rollout }) };
  return { root, home, thread, rollout, log, out, shared, env,
    rolloutBefore: fs.readFileSync(rollout, 'utf8'), rolloutStat: fs.statSync(rollout) };
};
const events = f => fs.readFileSync(path.join(f.shared, 'worker-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const hub = (name, config = {}, command = 'start', existing = null) => {
  const f = existing ?? fixture(name);
  if (config.output) fs.writeFileSync(f.rollout, JSON.stringify({ output: config.output }) + '\n');
  f.rolloutBefore = fs.readFileSync(f.rollout, 'utf8'); f.rolloutStat = fs.statSync(f.rollout);
  fs.writeFileSync(f.log, JSON.stringify({ output: `token=${fake}` }) + '\n');
  fs.writeFileSync(f.out, `secret=${fake}\n`);
  f.env.WORKER_REDACTION_FIXTURE = JSON.stringify({ thread: f.thread, rollout: f.rollout, ...config });
  const result = spawnSync(process.execPath, ['--import', transport, path.join(scripts, 'codex-worker.mjs'), '--account', 'fixture', command,
    '--owner', owner, '--name', name, ...(command === 'start' ? ['--cwd', f.root, '--sandbox', 'read-only'] : ['--thread', f.thread]),
    '--effort', 'high', '--model', 'fixture', '--log', f.log, '--out', f.out, ...(command === 'wait' ? [] : ['Fixture only.'])],
  { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fake), 'launcher exposed fixture value');
  return { f, result };
};
const verify = (f, result, counts, exit, event) => {
  assert.equal(result.status, exit, result.stderr);
  assert.equal(fs.readFileSync(f.rollout, 'utf8'), f.rolloutBefore, 'durable rollout was rewritten');
  const current = fs.statSync(f.rollout);
  for (const field of ['ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(current[field], f.rolloutStat[field]);
  f = { ...f, rollout: maskedRolloutFile(f.rollout) };
  const rows = events(f), terminal = rows.filter(row => !['running', 'message'].includes(row.event)).at(-1);
  assert.equal(terminal.event, event); assert.equal(terminal.exit, exit); assert.deepEqual(terminal.masked, counts);
  const notes = rows.filter(row => row.event === 'message');
  assert.equal(notes.length, 1); assert.equal(notes[0].kind, 'info'); assert.equal(notes[0].wake, false);
  assert.match(notes[0].text, /secret-like values were printed and have been masked in the logs/);
  assert.ok(!JSON.stringify(rows).includes(fake));
  assert.match(result.stdout, new RegExp(`redacted: log=${counts.log} rollout=${counts.rollout} out=${counts.out}`));
  for (const key of ['log', 'out', 'rollout']) if (counts[key]) {
    assert.ok(!fs.readFileSync(f[key], 'utf8').includes(fake), `${key} retained fixture value`);
    assert.equal(redactLogFile(f[key], { force: true, markdown: key === 'out' }).masked, 0);
  }
};
try {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const { f, result } = hub(status, { status });
    verify(f, result, { log: 3, rollout: 1, out: 1 }, status === 'completed' ? 0 : 1, status === 'completed' ? 'finished' : 'failed');
  }
  const dsl = hub('dsl-repository-credentials', {
    output: `storePassword '${fake}'\nkeyPassword.set("${fake}")\nNEXUS_MAGIC_WORD=${fake}`,
    message: `DONE fixture\nnexusMagicWordPwd("${fake}")\nREPO_USERNAME: ${fake}`,
  });
  verify(dsl.f, dsl.result, { log: 6, rollout: 3, out: 2 }, 0, 'finished');
  console.log('PASS DSL and repository credentials masked across launcher log, rollout and final output');
  const waited = hub('stalled-then-ended', { idleStatus: 'completed' }, 'wait');
  verify(waited.f, waited.result, { log: 1, rollout: 1, out: 1 }, 0, 'finished');
  const interrupted = hub('signal', { signal: true });
  verify(interrupted.f, interrupted.result, { log: 2, rollout: 1, out: 1 }, 143, 'follower-ended');
  const unreadable = hub('unreadable', { unreadable: true });
  verify(unreadable.f, unreadable.result, { log: 3, rollout: 0, out: 1 }, 0, 'finished');
  assert.match(unreadable.result.stderr, /redaction warning: rollout/);
  for (const config of [{ stillRunning: true }, { otherRunning: true }]) {
    const { f, result } = hub(`running-${config.stillRunning ? 'own' : 'other'}`, config);
    assert.equal(result.status, 0); assert.match(result.stderr, /running or hub status unconfirmed/);
    assert.deepEqual(events(f).at(-1).masked, { log: 0, rollout: 0, out: 0 });
    assert.equal(events(f).filter(row => row.event === 'message').length, 0);
    for (const file of [f.log, f.out, f.rollout]) assert.ok(fs.readFileSync(file, 'utf8').includes(fake));
  }
  console.log('PASS hub completed/failed/interrupted/wait/signal, running guards, counts, non-waking note and fail-open I/O');

  for (const [name, exit, config] of [['exec-ok', 0, {}], ['exec-failed', 1, {}],
    ['exec-unreadable', 0, { unreadable: true }], ['exec-running', 0, { idleStatus: 'inProgress' }]]) {
    const f = fixture(name);
    f.env.WORKER_REDACTION_FIXTURE = JSON.stringify({ thread: f.thread, rollout: f.rollout, idleStatus: exit ? 'failed' : 'completed', ...config });
    const code = `const fs=require('node:fs'); console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(f.thread)}}));
      console.log(JSON.stringify({type:'tool_output',output:'MAVEN_PASSWORD=fake-secret-123'}));
      fs.writeFileSync(${JSON.stringify(f.out)},'DONE fixture\\nsecret=fake-secret-123\\n'); process.exit(${exit});`;
    const result = spawnSync(process.execPath, ['--import', transport, path.join(scripts, 'run-tracked.mjs'),
      '--account', 'fixture', '--owner', owner, '--name', name, '--out', f.out, '--log', f.log,
      '--', process.execPath, '-e', code], { env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(fake));
    if (config.idleStatus === 'inProgress') {
      assert.equal(result.status, exit);
      assert.deepEqual(events(f).at(-1).masked, { log: 0, rollout: 0, out: 0 });
      assert.equal(events(f).filter(row => row.event === 'message').length, 0);
      for (const file of [f.log, f.out, f.rollout]) assert.ok(fs.readFileSync(file, 'utf8').includes(fake));
    } else verify(f, result, { log: 1, rollout: config.unreadable ? 0 : 1, out: 1 }, exit, exit ? 'failed' : 'finished');
    if (name === 'exec-ok') {
      const state = events(f).at(-1), before = [f.log, f.out, f.rollout].map(file => fs.statSync(file).ino);
      const output = [];
      const counts = await redactWorkerTurn({ ...f, checkIdle: () => true,
        tracker: { metadata: () => state, set: value => Object.assign(state, value) }, print: line => output.push(line) });
      assert.deepEqual(counts, { log: 0, rollout: 0, out: 0 }); assert.deepEqual(output, []);
      assert.equal(events(f).filter(row => row.event === 'message').length, 1);
      assert.deepEqual([f.log, f.out, f.rollout].map(file => fs.statSync(file).ino), before);
    }
  }
  {
    const f = fixture('exec-signal');
    f.env.WORKER_REDACTION_FIXTURE = JSON.stringify({ thread: f.thread, rollout: f.rollout, idleStatus: 'interrupted' });
    const code = `const fs=require('node:fs');console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(f.thread)}}));
      console.log(JSON.stringify({type:'tool_output',output:'password=fake-secret-123'}));
      fs.writeFileSync(${JSON.stringify(f.out)},'DONE fixture\\nsecret=fake-secret-123\\n');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--import', transport, path.join(scripts, 'run-tracked.mjs'),
      '--account', 'fixture', '--owner', owner, '--name', 'exec-signal', '--out', f.out, '--log', f.log,
      '--', process.execPath, '-e', code], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise(resolve => child.on('close', status => resolve({ status, stdout, stderr })));
    try {
      const until = Date.now() + 5000;
      while (!fs.existsSync(f.out)) {
        assert.ok(Date.now() < until, 'exec fixture did not start');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      child.kill('SIGTERM');
      verify(f, await done, { log: 1, rollout: 1, out: 1 }, 143, 'follower-ended');
    } finally { child.kill('SIGTERM'); await done; }
  }
  console.log('PASS exec thread capture, signal, running guard, fail-open I/O, unchanged exits and automatic idempotence');

  assert.equal(threadIsIdle({ thread: { turns: [{ status: 'completed' }, { status: 'inProgress' }] } }), false);
  assert.equal(threadIsIdle({}), false);
  for (const status of ['notLoaded', 'idle', 'active', 'unknown']) {
    const idle = await checkThreadIdle(async method => {
      if (method === 'thread/read') throw Error('fixture not loaded');
      return { data: [{ id: 'fixture', status: { type: status } }] };
    }, 'fixture');
    assert.equal(idle, ['notLoaded', 'idle'].includes(status));
  }
  for (const kind of ['grow', 'restart']) {
    const f = fixture(`guard-${kind}`), state = {}, warnings = [];
    fs.writeFileSync(f.log, `password=${fake}`); fs.writeFileSync(f.out, `secret=${fake}`);
    let checks = 0;
    const timer = kind === 'grow' ? setTimeout(() => fs.appendFileSync(f.rollout, '\nnew writer'), 100) : null;
    const counts = await redactWorkerTurn({ ...f, tracker: { set: value => Object.assign(state, value) },
      checkIdle: () => ++checks === 1 || kind !== 'restart', warn: message => warnings.push(message) });
    clearTimeout(timer);
    assert.deepEqual(counts, { log: 0, rollout: 0, out: 0 }); assert.deepEqual(state.masked, counts);
    assert.ok(warnings.length); for (const file of [f.log, f.out, f.rollout]) assert.ok(fs.readFileSync(file, 'utf8').includes(fake));
  }
  {
    const f = fixture('status-timeout'), started = performance.now(), warnings = [];
    fs.writeFileSync(f.log, `password=${fake}`);
    const counts = await redactWorkerTurn({ ...f, checkIdle: () => new Promise(() => {}), warn: message => warnings.push(message) });
    assert.deepEqual(counts, { log: 0, rollout: 0, out: 0 });
    assert.ok(performance.now() - started < 1500); assert.ok(warnings.length);
    assert.ok(fs.readFileSync(f.log, 'utf8').includes(fake));
  }
  console.log('PASS rollout growth/restarted turn untouched and bounded status guard');

  {
    const first = hub('two-turns', { status: 'completed' });
    verify(first.f, first.result, { log: 3, rollout: 1, out: 1 }, 0, 'finished');
    const projectedBytes = first.f.rolloutStat.size;
    const second = hub('two-turns', { status: 'completed', projectedBytes }, 'turn', first.f);
    assert.equal(second.result.status, 0, 'second turn could not project durable history');
    assert.equal(fs.readFileSync(second.f.rollout, 'utf8'), first.f.rolloutBefore);
    assert.deepEqual(events(second.f).filter(row => row.event === 'finished').at(-1).masked, { log: 3, rollout: 0, out: 1 });
    assert.match(second.result.stdout, /redacted: log=3 rollout=0 out=1/);
    assert.ok(!fs.readFileSync(maskedRolloutFile(second.f.rollout), 'utf8').includes(fake));
  }
  console.log('PASS two launcher turns retain durable projection and masked reporting');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
