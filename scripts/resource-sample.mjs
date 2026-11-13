#!/usr/bin/env node
// No sudo, device probes, environments, session/credential files or model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { attribute, category, commandName, GIB, LOG, SHARED, parseCpu, parseCwd, parsePs, parseSwap, parseVm, readLeases, readRegistry, unsafeFile } from './lib/resource-data.mjs';
import { lockSnapshot, matchBuildLock, observeWaiters, parseHeavyCheck, parseHeavyStatus, readLockJournal, workload } from './lib/resource-locks.mjs';
import { parseCcacheStats, parseHubListeners } from './lib/resource-extras.mjs';
const exec = promisify(execFile);
export async function collect({ registry = null, budgetMs = 1750, probe = null, leases = null, journal = null, shared = SHARED, statusText = null } = {}) {
  const start = performance.now(), psStartedAt = Date.now(), errors = [];
  const failedProbes = new Set();
  const failProbe = (label, reason) => {
    if (!failedProbes.has(label)) errors.push(`${label}: ${reason} (output omitted)`);
    failedProbes.add(label);
    return '';
  };
  const run = async (label, exe, args) => {
    try {
      const result = probe ? await probe(label, exe, args) : await exec(exe, args, { timeout: Math.max(1, Math.floor(budgetMs - (performance.now() - start))), maxBuffer: 4 * 2 ** 20, env: { ...process.env, LC_ALL: 'C' } });
      if (typeof result === 'string') return result;
      if (result?.exitCode !== undefined && result.exitCode !== 0) return failProbe(label, 'unavailable');
      return typeof result?.stdout === 'string' ? result.stdout : failProbe(label, 'invalid probe result');
    } catch (e) { return failProbe(label, e?.killed ? 'timeout' : 'unavailable'); }
  };
  const gateProbe = async () => {
    try {
      const result = probe ? await probe('heavy-check', path.join(shared, 'res'), ['heavy-check']) : await exec(path.join(shared, 'res'), ['heavy-check'], {
        timeout: Math.max(1, Math.floor(budgetMs - (performance.now() - start))), maxBuffer: 16384,
        // Do not inherit injected test metrics or RES_DIR overrides into the live observation.
        env: { HOME: os.homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
      });
      return parseHeavyCheck(typeof result === 'string' ? result : result?.stdout ?? '', typeof result === 'string' ? 0 : result?.exitCode ?? 0);
    } catch (e) { return parseHeavyCheck(e?.stdout ?? '', e?.killed ? 'timeout' : e?.code ?? 'unavailable'); }
  };
  const extraProbe = async (label, exe, args, extraEnv = {}) => {
    try {
      const result = probe ? await probe(label, exe, args) : await exec(exe, args, {
        timeout: Math.max(1, Math.floor(budgetMs - (performance.now() - start))), maxBuffer: 16384,
        env: { HOME: os.homedir(), PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', ...extraEnv },
      });
      if (typeof result === 'string') return { stdout: result, exitCode: 0 };
      if (typeof result?.stdout !== 'string') return { stdout: '', exitCode: 'invalid' };
      return { ...result, stderr: typeof result.stderr === 'string' ? result.stderr : '', exitCode: result.exitCode ?? 0 };
    } catch (e) { return { stdout: e?.stdout ?? '', stderr: e?.stderr ?? '', exitCode: e?.killed ? 'timeout' : e?.code ?? 'unavailable' }; }
  };
  const ccacheExe = ['/opt/homebrew/bin/ccache', '/usr/local/bin/ccache', '/usr/bin/ccache'].find((f) => fs.existsSync(f)) ?? '/opt/homebrew/bin/ccache';
  const cacheDir = path.join(os.homedir(), '.vesdk-dev/ccache');
  const [ps, cwdText, cpuText, vmText, pressureText, swapText, memLevel, heavyGate, hubsReading, cacheReading] = await Promise.all([
    run('ps', '/bin/ps', ['-axo', 'pid=,ppid=,uid=,etime=,pcpu=,rss=,state=,time=,lstart=,command=']),
    run('cwd', '/usr/sbin/lsof', ['-nP', '-a', '-u', String(process.getuid()), '-d', 'cwd', '-Fpfn']),
    run('CPU', '/usr/bin/top', ['-l', '2', '-s', '1', '-n', '0']),
    run('memory pages', '/usr/bin/vm_stat', []),
    run('memory pressure', '/usr/bin/memory_pressure', ['-Q']),
    run('swap', '/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
    run('memorystatus', '/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']),
    gateProbe(),
    extraProbe('hub listeners', '/usr/sbin/lsof', ['-nP', '-iTCP:47321-47324', '-sTCP:LISTEN', '-Fpn']),
    extraProbe('ccache', ccacheExe, ['-s'], { CCACHE_DIR: cacheDir, CCACHE_CONFIGPATH: '/dev/null', CCACHE_LOGFILE: '', CCACHE_STATSLOG: '' }),
  ]);
  const hubs = parseHubListeners(hubsReading.stdout ?? '', hubsReading);
  const ccache = parseCcacheStats(cacheReading.stdout ?? '', { ...cacheReading, scope: cacheDir });
  if (!heavyGate.authoritative) failProbe('heavy-check', heavyGate.error);
  if (!hubs.complete) failProbe('hub listeners', hubs.error);
  if (!ccache.complete) failProbe('ccache', ccache.error);
  if (registry === null) {
    try { registry = await readRegistry(); }
    catch { registry = { complete: false, errors: ['registry: unavailable'], tasks: [], projects: [], mappings: [] }; }
  }
  leases ??= readLeases(shared);
  journal ??= readLockJournal(shared);
  const parsed = parsePs(ps), cwds = parseCwd(cwdText);
  errors.push(...parsed.errors);
  if (!parsed.rows.length || parsed.errors.length) failProbe('ps', 'empty/malformed process listing / UNKNOWN');
  if (!cwds.size) failProbe('cwd', 'empty/malformed cwd listing / UNKNOWN');
  const rows = parsed.rows.map((p) => ({ ...p, cwd: cwds.get(p.pid) ?? null }));
  const owners = attribute(rows, registry), cpu = parseCpu(cpuText), vm = parseVm(vmText);
  const swapUsedBytes = parseSwap(swapText);
  const pressureValue = Number(pressureText.match(/free percentage:\s*(\d+)%/)?.[1]);
  const pressurePct = Number.isFinite(pressureValue) && pressureValue >= 0 && pressureValue <= 100 ? pressureValue : NaN;
  const level = /^\s*\d+(?:\.\d+)?\s*$/.test(memLevel) ? Number(memLevel) : null;
  const validLevel = level !== null && level >= 0 && level <= 100;
  if (!cpu) failProbe('CPU', 'empty/malformed CPU reading');
  if (!vm) failProbe('memory pages', 'empty/malformed memory reading');
  if (!Number.isFinite(pressurePct)) failProbe('memory pressure', 'empty/malformed pressure reading');
  if (swapUsedBytes === null) failProbe('swap', 'empty/malformed swap reading');
  if (!validLevel) failProbe('memorystatus', 'empty/malformed memorystatus reading; fallback is diagnostic only');
  const totalBytes = os.totalmem(), availableBytes = validLevel ? totalBytes * level / 100 : vm?.pageHeadroomBytes ?? null;
  const processes = rows.map(({ _command, ...p }) => ({ ...p, id: `${p.pid}:${p.started}:${crypto.createHash('sha256').update(_command).digest('hex').slice(0, 16)}`, name: commandName(_command), kind: category(_command), owner: owners.get(p.pid) }));
  const processComplete = parsed.rows.length > 0 && !failedProbes.has('ps'), t = Date.now();
  const heavyLocks = lockSnapshot(leases, rows, { host: os.hostname(), psStartedAt, now: t, processComplete });
  heavyLocks.journal = journal;
  heavyLocks.waiters = observeWaiters(rows, processes, psStartedAt);
  heavyLocks.waitersComplete = processComplete;
  if (statusText !== null) heavyLocks.capturedStatus = parseHeavyStatus(statusText);
  const counts = Object.fromEntries(['xcodebuild', 'gradle', 'native', 'node-test', 'worker', 'simulator', 'device', 'chrome', 'headless', 'daemon'].map((k) => [k, processComplete ? processes.filter((p) => p.kind === k).length : null]));
  const heavy = new Set(['xcodebuild', 'gradle', 'native', 'node-test']);
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const scopes = new Map(rows.filter((p) => heavy.has(category(p._command))).map((p) => [p.pid, workload(p, rows)]));
  const heavyRoots = processes.filter((p) => {
    if (!heavy.has(p.kind)) return false;
    const scope = scopes.get(p.pid).class;
    let q = p; const seen = new Set([p.pid]);
    while (byPid.has(q.ppid) && q.ppid > 1 && !seen.has(q.ppid)) {
      q = byPid.get(q.ppid); seen.add(q.pid); const ancestor = scopes.get(q.pid)?.class;
      // A lightweight test/native driver must not hide a package build nested beneath it.
      if (scope === 'package' ? ancestor === 'package' : scope === 'lane' ? ['package', 'lane'].includes(ancestor) : heavy.has(q.kind)) return false;
    }
    return true;
  }).map((p) => {
    const scope = scopes.get(p.pid);
    const buildLock = scope.class === 'package' ? matchBuildLock(p, rows, heavyLocks, 'build') : null;
    const laneLock = ['package', 'lane'].includes(scope.class) ? matchBuildLock(p, rows, heavyLocks, 'lane') : null;
    return { id: p.id, pid: p.pid, kind: p.kind, owner: p.owner, workload: scope, buildLock, laneLock };
  });
  let disk = null;
  try { const d = fs.statfsSync(os.homedir()); disk = { path: os.homedir(), freeBytes: Number(d.bavail) * Number(d.bsize), totalBytes: Number(d.blocks) * Number(d.bsize) }; }
  catch { failProbe('disk', 'unavailable'); }
  let load = null; try { const v = os.loadavg(); if (v.length === 3 && v.every(Number.isFinite)) load = v; } catch {}
  if (!load) failProbe('load', 'unavailable');
  return { schema: 1, t, at: new Date(t).toISOString(), host: os.hostname(), cores: os.availableParallelism?.() ?? os.cpus().length,
    complete: processComplete && [...failedProbes].every((label) => label === 'ccache') && heavyLocks.complete,
    processComplete, cwdComplete: !failedProbes.has('cwd'), attributionComplete: registry.complete, failedProbes: [...failedProbes], errors, attributionErrors: registry.errors,
    durationMs: Math.round(performance.now() - start), load, cpu,
    memory: { totalBytes, availableBytes, availableBasis: validLevel ? 'memorystatus-level' : vm ? 'free+inactive+speculative (estimate)' : 'unknown', pageHeadroomBytes: vm?.pageHeadroomBytes ?? null,
      pressureFreePct: Number.isFinite(pressurePct) ? pressurePct : null, pressure: Number.isFinite(pressurePct) ? (pressurePct < 10 ? 'critical' : pressurePct < 20 ? 'warning' : 'normal') : 'unknown', swapUsedBytes, pages: vm?.pages ?? null },
    disk, counts, heavyRoots, processes, heavyGate, heavyLocks, hubs, ccache,
    topCpu: [...processes].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 20).map((p) => p.id),
    topRss: [...processes].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 20).map((p) => p.id),
    tasks: registry.tasks.filter((t) => !['unknown', 'done', 'finished', 'completed', 'merged', 'abandoned', 'cancelled', 'canceled'].includes(t.status)).map(({ project, task, status, ready, waitReason }) => ({ project, task, status, ready, waitReason })),
    taskStateCounts: Object.fromEntries([...new Set(registry.tasks.map((t) => t.status))].map((s) => [s, registry.tasks.filter((t) => t.status === s).length])),
    devices: { source: 'read-only resource lease metadata + host processes; no device probe or real device utilisation', inUseProcessCount: counts.device, simulatorProcessCount: counts.simulator, leases },
    chrome: { guiProcessCount: counts.chrome, headlessProcessCount: counts.headless, state: processComplete ? counts.chrome ? 'running (responsiveness unknown)' : 'not observed' : 'unknown' },
  };
}
export function appendSample(sample, file = LOG, { maxBytes = 50 * 2 ** 20, archives = 6 } = {}) {
  if (unsafeFile(file) || !file.endsWith('.jsonl')) throw Error('non-telemetry path refused');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`; let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) { throw Error(`sample lock busy/unavailable: ${e.code}; no stale-lock deletion`); }
  try {
    for (const f of [file, ...Array.from({ length: archives }, (_, i) => `${file}.${i + 1}`)]) if (fs.existsSync(f) && fs.lstatSync(f).isSymbolicLink()) throw Error('symlink telemetry file refused');
    const line = JSON.stringify(sample) + '\n';
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
      const last = `${file}.${archives}`; if (fs.existsSync(last)) fs.unlinkSync(last);
      for (let i = archives - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, line, { mode: 0o600 }); fs.chmodSync(file, 0o600);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
async function main() {
  const args = process.argv.slice(2), allowed = new Set(['--read-only', '--dry-run', '--json']);
  for (const arg of args) if (!allowed.has(arg)) throw Error(`unknown option: ${arg}`);
  const sample = await collect(), readOnly = args.includes('--read-only') || args.includes('--dry-run');
  if (!readOnly) appendSample(sample);
  console.log(JSON.stringify(sample));
  console.error(`${readOnly ? 'READ ONLY' : 'APPENDED'}: ${sample.complete ? 'COMPLETE' : 'INCOMPLETE / UNKNOWN'}; ${sample.processes.length} processes; ${sample.durationMs} ms; available=${sample.memory.availableBytes === null ? 'unknown' : (sample.memory.availableBytes / GIB).toFixed(1) + ' GiB'}`);
  if (sample.failedProbes.length) console.error(`Failed probes (UNKNOWN): ${sample.failedProbes.join(', ')}`);
  if (!sample.complete) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`BLOCKED: ${e.message}`); process.exitCode = 2; });
