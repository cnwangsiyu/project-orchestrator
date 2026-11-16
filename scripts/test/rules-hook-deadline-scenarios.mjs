#!/usr/bin/env node
// Bounded SessionStart probes with synthetic transcripts and Git; no network or shared writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-hook-deadline-'));
const shared = path.join(tmp, 'shared'), projects = path.join(tmp, '.claude/projects'), transcript = path.join(projects, 'unknown.jsonl');
fs.mkdirSync(shared); fs.mkdirSync(projects, { recursive: true });
fs.writeFileSync(transcript, JSON.stringify({ text: '# project-orchestrator' }) + '\n');
const preload = path.join(tmp, 'delay.mjs'), marker = path.join(tmp, 'git-start');
fs.writeFileSync(preload, `import fs from 'node:fs/promises';
import sync from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const delay=()=>new Promise(resolve=>setTimeout(resolve,1600));
const realpath=fs.realpath, rmdir=fs.rmdir;
fs.realpath=async(file,...args)=>{if(process.env.SLOW_SCAN==='1'&&String(file).endsWith('.jsonl')||process.env.SLOW_ENTRY==='1'&&String(file)===process.argv[1])await delay();return realpath(file,...args);};
fs.rmdir=async(file,...args)=>{if(process.env.SLOW_CLEANUP==='1'&&String(file).endsWith('rules-seen.json.lock'))await delay();return rmdir(file,...args);};
// Any accidental synchronous hook cleanup would overrun its own timer.
sync.unlinkSync=sync.rmdirSync=()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1600);throw Error('sync cleanup on hook path');};
const exec=cp.execFile;
cp.execFile=(bin,args,options,callback)=>{if(bin!=='git')return exec(bin,args,options,callback);
 fs.writeFile(process.env.GIT_MARKER,'started');
 const timer=setTimeout(()=>callback(null,args.includes('--show-toplevel')?process.env.FIXTURE_ROOT:args.includes('--short')?'fixture-branch':'',''),process.env.SLOW_GIT==='1'?1600:0);
 return {kill(){clearTimeout(timer);}};};
syncBuiltinESMExports();
`);
const env = { ...process.env, HOME: tmp, RULES_SHARED: shared, CODEX_WORKER_THREAD: '', CLAUDE_ENV_FILE: '',
  NODE_OPTIONS: `--import=${preload}`, GIT_MARKER: marker, FIXTURE_ROOT: tmp };
const base = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'cold', cwd: tmp, session_title: 'Fixture 主对话' };
const run = (input, extra = {}) => {
  const started = performance.now();
  const r = spawnSync(process.execPath, [path.join(scripts, 'rules-digest-hook.mjs')], {
    env: { ...env, ...extra }, input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  const ms = performance.now() - started;
  assert.equal(r.status, 0, r.stderr + String(r.error ?? '')); assert.equal(r.stderr, '');
  assert.ok(ms < 1100, `hook self-deadline: ${Math.round(ms)} ms`);
  return { ms, out: r.stdout ? JSON.parse(r.stdout) : null };
};
try {
  const cold = run(base), warm = run(base);
  assert.match(cold.out.hookSpecificOutput.additionalContext, /First injection/);
  assert.match(warm.out.hookSpecificOutput.additionalContext, /No changes/);
  const slowEntry = run({ ...base, session_id: 'entry' }, { SLOW_ENTRY: '1' });
  assert.ok(slowEntry.out, 'updater import cannot await its main-entry realpath before the deadline');
  const slowScan = run({ ...base, session_id: 'unknown', session_title: undefined, transcript_path: transcript }, { SLOW_SCAN: '1' });
  assert.equal(slowScan.out, null);
  const slowGit = run({ ...base, session_id: 'git' }, { SLOW_GIT: '1' });
  assert.ok(slowGit.out, 'digest still delivered while detached Git is slow');
  const end = Date.now() + 1000;
  while (!fs.existsSync(marker) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(marker), 'SessionStart re-enabled the updater');
  run({ ...base, session_id: 'cleanup' }, { SLOW_CLEANUP: '1' });
  console.log(`PASS hook deadline: cold ${Math.round(cold.ms)} ms, warm ${Math.round(warm.ms)} ms; slow import ${Math.round(slowEntry.ms)} ms; slow scan ${Math.round(slowScan.ms)} ms, slow git ${Math.round(slowGit.ms)} ms`);
  // The fixture coordinator owns its Git budget and lock beyond the hook deadline.
  await new Promise(resolve => setTimeout(resolve, 5500));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
