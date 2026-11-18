#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { lifecycle, signalExit, resolveOwner, setEventObserver } from './lib/worker-events.mjs';
import { redactWorkerTurn, hubThreadIdle } from './lib/worker-redaction.mjs';
import { maskPasswordStyleValues } from './lib/nightly-audit.mjs';
import { canonicalPathOptions, canonicalLaunchArgv } from './lib/launch-paths.mjs';
import { requestBoardRefresh } from './lib/board-refresh.mjs';
import { projectForOwner } from './lib/task-board.mjs';
import { loadDigest, workerInstructions } from './lib/global-rules.mjs';

const args = process.argv.slice(2), sep = args.indexOf('--'), opts = {};
for (let i = 0; i < (sep < 0 ? args.length : sep); i += 2) opts[args[i].replace(/^--/, '')] = args[i + 1];
canonicalPathOptions(opts);
setEventObserver(requestBoardRefresh);
const tracker = lifecycle({ owner: opts.owner, name: opts.name ?? 'exec', account: opts.account ?? 'main', model: opts.model ?? null,
  effort: opts.effort ?? null, followerCommand: 'exec',
  project: opts.project ?? (process.env.ORCHESTRATOR_PROJECT || projectForOwner(resolveOwner(opts.owner))),
  task: opts.task ?? opts.name ?? 'exec', taskDir: opts['task-dir'] ? path.resolve(opts['task-dir']) : null,
  outFile: opts.out ? path.resolve(opts.out) : null, logFile: opts.log ? path.resolve(opts.log) : null });
if (sep < 0 || !args[sep + 1]) { console.error('run-tracked: expected options -- command [args...]'); process.exit(2); }
const outStamp = () => { try { const s = fs.statSync(opts.out, { bigint: true }); return `${s.ino}:${s.mtimeNs}:${s.size}`; } catch { return null; } };
const beforeOut = outStamp();
let child, logFd, signalled = null, ending = false, watchdog, drainTimer, stderrTail='', stdoutPending='', accepted=false;
let thread = opts.thread ?? null, turn = null;
const stdoutLine = line => {
  const previousThread = thread;
  const pair = line.match(/^thread=(\S+) turn=(\S+)/);
  if (pair) { thread = pair[1]; turn = pair[2]; accepted = true; }
  try {
    const row = JSON.parse(line);
    if (/thread|turn/.test(row.type ?? row.method ?? '')) {
      thread ??= row.thread_id ?? row.threadId ?? row.params?.threadId ?? null;
      turn = row.turn_id ?? row.turnId ?? row.params?.turnId ?? row.params?.turn?.id ?? turn;
      if (thread || turn) accepted = true;
    }
  } catch {}
  if (thread && thread !== previousThread) tracker.update({ thread, turn });
  else tracker.set({ thread, turn });
};
const signalOwned = (signal) => {
  try { if (process.platform === 'win32') child?.kill(signal); else if (child?.pid) process.kill(-child.pid, signal); } catch {}
};
const finish = async (code) => {
  if (ending) return;
  ending = true;
  clearTimeout(watchdog);
  clearTimeout(drainTimer);
  signalOwned('SIGTERM');
  if (process.platform !== 'win32' && child?.pid) {
    const until = Date.now() + 500;
    for (;;) {
      try { process.kill(-child.pid, 0); } catch { break; }
      if (Date.now() >= until) { signalOwned('SIGKILL'); break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (logFd !== undefined) { fs.closeSync(logFd); logFd = undefined; }
  if (stdoutPending) stdoutLine(stdoutPending);
  stderrTail = maskPasswordStyleValues(stderrTail).text;
  let final = '';
  let outFd;
  try {
    if (outStamp() !== beforeOut) {
      outFd = fs.openSync(opts.out, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (fs.fstatSync(outFd).isFile()) {
        const buf = Buffer.alloc(4096), n = fs.readSync(outFd, buf, 0, buf.length, 0);
        final = buf.subarray(0, n).toString('utf8').trim();
      }
    }
  } catch {} finally { if (outFd !== undefined) fs.closeSync(outFd); }
  if(code===0&&opts.out&&outStamp()===beforeOut){code=1;console.error(`run-tracked: the command exited 0 but wrote nothing to ${opts.out}; treating as failed.${stderrTail.trim()?`\n${stderrTail.trim()}`:''}`);}
  const launchFailed=!accepted&&(code!==0||!!opts.out&&!final);
  if(launchFailed) {
    code=code||1;
    console.error(`run-tracked: launch failed before producing a thread/turn (exit ${code})${stderrTail.trim()?`\n${stderrTail.trim()}`:''}`);
  }
  try {
    let profiles = {};
    if (thread) try { profiles = JSON.parse(fs.readFileSync(process.env.CODEX_ACCOUNTS
      ?? path.join(os.homedir(), '.claude/orchestrator/_shared/codex-accounts.json'), 'utf8')); } catch {}
    const profile = profiles[opts.account ?? 'main'];
    await redactWorkerTurn({ home: opts.home ?? profile?.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
      thread, log: opts.log ? path.resolve(opts.log) : null, out: opts.out ? path.resolve(opts.out) : null, tracker,
      checkIdle: () => hubThreadIdle(opts.hub ?? profile?.hub ?? process.env.CODEX_HUB ?? 'ws://127.0.0.1:47321', thread) });
  } catch {
    console.error('redaction warning: turn-end redaction could not complete');
  }
  final = maskPasswordStyleValues(final).text;
  tracker.result(launchFailed?'failed':/^(?:\S+\s+)?(?:BLOCKED|QUESTION)\b/.test(final) ? 'needs-user' : code === 0 ? 'finished' : 'failed',
    { finalLine: final.split('\n').find((line) => line.trim()) ?? '' });
  if (signalled) tracker.result('follower-ended', { signal: signalled, mayRun: false });
  process.exit(code);
};
try {
  if (opts.log) { fs.mkdirSync(path.dirname(path.resolve(opts.log)), { recursive: true }); logFd = fs.openSync(opts.log, 'w', 0o600); }
  // A private process group is cleanup ownership, not a daemon: no unref, and the wrapper stays attached.
  const command = args[sep + 1], commandArgs = args.slice(sep + 2);
  const cliPaths = /^(codex|traex|traecli)$/.test(path.basename(command))
    || /codex-worker\.mjs$/.test(commandArgs[0] ?? '');
  let env = process.env;
  if (opts['inject-rules'] === 'on') {
    const digest = loadDigest();
    tracker.update({ rulesVersion: digest.version });
    env = { ...env, ORCHESTRATOR_WORKER_RULES_CONFIG: `developer_instructions=${JSON.stringify(workerInstructions(digest))}` };
  }
  child = spawn(command, cliPaths ? canonicalLaunchArgv(commandArgs, opts.cwd) : commandArgs, { cwd: opts.cwd, detached: process.platform !== 'win32',
    env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data',chunk=>{
    if(logFd!==undefined) fs.writeSync(logFd,chunk); else process.stdout.write(chunk);
    stdoutPending=(stdoutPending+chunk.toString()).slice(-65536);
    const lines=stdoutPending.split('\n');stdoutPending=lines.pop();
    for(const line of lines) stdoutLine(line);
  });
  child.stderr.on('data',chunk=>{stderrTail=(stderrTail+chunk.toString()).slice(-4096);if(logFd!==undefined)fs.writeSync(logFd,chunk);else process.stderr.write(chunk);});
  child.once('exit',(code,signal)=>{signalOwned('SIGTERM');drainTimer=setTimeout(()=>finish(code??signalExit(signal)),1000);});
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    signalled = signal;
    signalOwned(signal);
    watchdog ??= setTimeout(() => finish(signalExit(signal)), 2000);
  });
  child.on('error', (error) => { console.error(`run-tracked: ${error.message}`); finish(1); });
  child.on('close', (code, signal) => finish(code ?? signalExit(signal)));
} catch (error) { console.error(`run-tracked: ${error.message}`); finish(1); }
