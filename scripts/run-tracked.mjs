#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lifecycle, signalExit } from './lib/worker-events.mjs';

const args = process.argv.slice(2), sep = args.indexOf('--'), opts = {};
for (let i = 0; i < (sep < 0 ? args.length : sep); i += 2) opts[args[i].replace(/^--/, '')] = args[i + 1];
const tracker = lifecycle({ owner: opts.owner, name: opts.name ?? 'exec', account: opts.account ?? 'main', model: opts.model ?? null,
  effort: opts.effort ?? null,
  outFile: opts.out ? path.resolve(opts.out) : null, logFile: opts.log ? path.resolve(opts.log) : null });
if (sep < 0 || !args[sep + 1]) { console.error('run-tracked: expected options -- command [args...]'); process.exit(2); }
const outStamp = () => { try { const s = fs.statSync(opts.out, { bigint: true }); return `${s.ino}:${s.mtimeNs}:${s.size}`; } catch { return null; } };
const beforeOut = outStamp();
let child, logFd, signalled = null, ending = false, watchdog;
const signalOwned = (signal) => {
  try { if (process.platform === 'win32') child?.kill(signal); else if (child?.pid) process.kill(-child.pid, signal); } catch {}
};
const finish = async (code) => {
  if (ending) return;
  ending = true;
  clearTimeout(watchdog);
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
  tracker.result(/^(?:\S+\s+)?(?:BLOCKED|QUESTION)\b/.test(final) ? 'needs-user' : code === 0 ? 'finished' : 'failed',
    { finalLine: final.split('\n').find((line) => line.trim()) ?? '' });
  if (signalled) tracker.result('follower-ended', { signal: signalled, mayRun: false });
  process.exit(code);
};
try {
  if (opts.log) { fs.mkdirSync(path.dirname(path.resolve(opts.log)), { recursive: true }); logFd = fs.openSync(opts.log, 'w', 0o600); }
  // A private process group is cleanup ownership, not a daemon: no unref, and the wrapper stays attached.
  child = spawn(args[sep + 1], args.slice(sep + 2), { cwd: opts.cwd, detached: process.platform !== 'win32',
    stdio: ['ignore', logFd ?? 'inherit', logFd ?? 'inherit'] });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    signalled = signal;
    signalOwned(signal);
    watchdog ??= setTimeout(() => finish(signalExit(signal)), 2000);
  });
  child.on('error', (error) => { console.error(`run-tracked: ${error.message}`); finish(1); });
  child.on('close', (code, signal) => finish(code ?? signalExit(signal)));
} catch (error) { console.error(`run-tracked: ${error.message}`); finish(1); }
