#!/usr/bin/env node
// Linux work runs under a public res hold; this process never takes a mini lane.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { privateKeyBlockStream } from './lib/private-key-blocks.mjs';
import { attemptTiming, timingLine } from './lib/devbox-phase-timing.mjs';
import { redactLogFile } from './lib/log-redaction.mjs';
import { maskLogText } from './lib/nightly-audit.mjs';
import { manifest, duration, inputKey, indexFile, readIndex, inputSettings, placement, warmCost, warmInput, median, observedCost, fingerprint, inputPython, seedPython } from './lib/devbox-inputs.mjs';
import { transferFindings } from './lib/devbox-transfer-check.mjs';
import { fileDigest, artifactName, readArtifactManifest, retainedArtifactPython, artifactRangePython, readArchive, artifactTimeoutMs } from './lib/devbox-artifacts.mjs';
import { controlOptions, muxFailure, muxRetrySafe } from './lib/devbox-ssh.mjs';
import { retentionPython } from './lib/devbox-retention.mjs';
import { cleanupEvidencePython } from './lib/devbox-cleanup-pending.mjs';
import { treeSettings, treePreference, treeScript } from './lib/devbox-trees.mjs';

const script = fileURLToPath(import.meta.url);
const GiB = 1024 ** 3;
const sensitive = /password|passwd|token|secret|apikey|api_key|credential|authorization/i;
const sensitiveFile = /(^|\/)(\.env(?:\..*)?|\.netrc|\.pypirc|\.git|\.ssh|\.aws|\.kube|id_rsa|id_ed25519)(\/|$)|\.(?:pem|p12|pfx|key|keystore)$/i;
// Bundles include ancestors. Limit the history query to matching paths so a
// deleted sensitive file cannot ride along behind an otherwise clean commit.
const privateNames = ['.env', '.env.*', '.netrc', '.pypirc', '.git', '.ssh', '.aws', '.kube', 'id_rsa', 'id_ed25519'];
const privateHistoryPaths = [
  ...privateNames.flatMap(name => [`**/${name}`, `**/${name}/**`]),
  ...['pem', 'p12', 'pfx', 'key', 'keystore'].map(ext => `**/*.${ext}`),
].map(glob => `:(glob,icase)${glob}`);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cacheDir = () => process.env.DEVBOX_CACHE_DIR || sharedDir();
const sharedDir = () => process.env.RES_DIR || process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared');
const resCommand = () => process.env.RES_COMMAND || (fs.existsSync(path.join(sharedDir(), 'res')) ? path.join(sharedDir(), 'res') : 'res');

export function parseArgs(args) {
  const opts = { ref: 'HEAD', pool: 'devbox-cn', shards: 1, timeout: 120, fetchTimeout: 15, artifactTimeout: 120, artifactFetch: 'all', artifactStreams: 1, retainHours: 24, artifacts: [], env: {}, days: 7, need: [], excludeSlot: [], excludeHost: [], inputs: [] };
  if (args[0] === 'gc') { opts.gc = true; args = args.slice(1); }
  if (args[0] === 'prewarm') { opts.prewarm = true; opts.ref = 'main'; opts.task = 'prewarm'; args = args.slice(1); }
  const names = new Map(['project', 'task', 'repo', 'ref', 'pool', 'shards', 'out', 'timeout', 'queue-timeout', 'prefer-host', 'watch-pid', 'affinity', 'host', 'days', 'units-file', 'command', 'fetch-timeout', 'artifact-timeout', 'artifact-fetch', 'artifact-streams', 'retain-hours', 'exclude-reason', 'prefer-slot', 'warm-cost', 'inputs'].map(n => [`--${n}`, n.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { if (opts.command) throw Error('provide only one command'); opts.command = args.slice(i + 1).join(' '); break; }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--submodules') { opts.submodules = true; continue; }
    if (arg === '--rerun-on-fail') { opts.rerunOnFail = true; continue; }
    if (arg === '--allow-flaky') { opts.allowFlaky = true; continue; }
    if (arg === '--retain-on-fail') { opts.retainOnFail = true; continue; }
    if (!names.has(arg) && !['--env', '--artifact', '--need', '--exclude-slot', '--exclude-host', '--input'].includes(arg)) throw Error(`unknown option ${arg}`);
    const value = args[++i];
    if (value === undefined || value === '--') throw Error(`missing value for ${arg}`);
    if (arg === '--command' && !opts.prewarm) throw Error('--command is for prewarm; use -- COMMAND for runs');
    if (opts.prewarm && ['--shards', '--units-file'].includes(arg)) throw Error('prewarm builds once per idle host, without unit sharding');
    if (arg === '--input') { opts.inputs.push(value); continue; }
    if (['--need', '--exclude-host', '--exclude-slot'].includes(arg)) {
      const caps = value.split(',');
      if (caps.some(cap => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(cap))) throw Error('invalid capability');
      const field = { '--need': 'need', '--exclude-slot': 'excludeSlot', '--exclude-host': 'excludeHost' }[arg];
      opts[field].push(...caps);
    } else if (arg === '--artifact') {
      if (path.posix.isAbsolute(value) || value.split('/').includes('..') || value.includes('\0')) throw Error('artifacts must be workspace-relative globs');
      opts.artifacts.push(value);
    } else if (arg === '--env') {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
      if (!match || sensitive.test(match[1]) || /^(HOME|USER|SSH_.*|KRB5.*|GIT_.*|LD_.*|DYLD_.*|BASH_ENV|ENV)$/.test(match[1])) throw Error('invalid or credential-related --env name');
      opts.env[match[1]] = match[2];
    } else if (arg === '--inputs') {
      const declared = JSON.parse(fs.readFileSync(value,'utf8'));
      const values = Array.isArray(declared) ? declared : declared.inputs;
      if (!Array.isArray(values)) throw Error('--inputs needs an input array');
      opts.inputs.push(...values);
    } else opts[names.get(arg)] = value;
  }
  if (opts.excludeReason !== undefined && (!opts.excludeReason.trim() || /[\t\r\n]/.test(opts.excludeReason))) throw Error('invalid --exclude-reason');
  opts.days = Number(opts.days);
  if (!Number.isFinite(opts.days) || opts.days < 1) throw Error('--days must be at least 1');
  if (opts.gc) return opts;
  opts.retainHours = Number(opts.retainHours);
  if (!Number.isFinite(opts.retainHours) || opts.retainHours <= 0 || opts.retainHours > 72) throw Error('--retain-hours must be >0 and <=72');
  if (!['manifest', 'all'].includes(opts.artifactFetch)) throw Error('--artifact-fetch must be manifest or all');
  opts.artifactStreams = Number(opts.artifactStreams);
  if (!Number.isInteger(opts.artifactStreams) || opts.artifactStreams < 1 || opts.artifactStreams > 4) throw Error('--artifact-streams must be 1..4');
  opts.inputs = manifest(opts.inputs);
  if (opts.warmCost !== undefined) opts.warmCost = duration(opts.warmCost);
  if (opts.prewarm && opts.inputs.length && !opts.command) opts.command='true';
  if (opts.prewarm && !opts.project) throw Error('prewarm requires --project');
  for (const name of (opts.project === undefined ? ['task'] : ['project', 'task'])) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(opts[name] || '')) throw Error(`--${name} needs a simple identifier`);
  if (!opts.repo || !opts.command?.trim()) throw Error('--repo and a command after -- are required');
  if (!['devbox-cn', 'devbox-cn-light'].includes(opts.pool)) throw Error('unsupported pool');
  opts.shards = opts.shards === 'auto' ? 'auto' : Number(opts.shards); opts.timeout = Number(opts.timeout);
  if (opts.shards !== 'auto' && (!Number.isInteger(opts.shards) || opts.shards < 1 || opts.shards > 64)) throw Error('--shards must be auto or 1..64');
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0 || opts.timeout > 120) throw Error('--timeout must be >0 and <=120 minutes');
  opts.queueTimeout = opts.queueTimeout === undefined ? Math.max(opts.timeout, 30) : Number(opts.queueTimeout);
  if (!Number.isFinite(opts.queueTimeout) || opts.queueTimeout <= 0 || opts.queueTimeout > 120) throw Error('--queue-timeout must be >0 and <=120 minutes');
  opts.fetchTimeout = Number(opts.fetchTimeout);
  if (!Number.isFinite(opts.fetchTimeout) || opts.fetchTimeout <= 0 || opts.fetchTimeout > 120) throw Error('--fetch-timeout must be >0 and <=120 minutes');
  opts.artifactTimeout = Number(opts.artifactTimeout);
  if (!Number.isFinite(opts.artifactTimeout) || opts.artifactTimeout <= 0 || opts.artifactTimeout > 120) throw Error('--artifact-timeout must be >0 and <=120 minutes');
  if (opts.watchPid && (!/^\d+$/.test(opts.watchPid) || Number(opts.watchPid) < 2)) throw Error('invalid --watch-pid');
  opts.repo = fs.realpathSync(opts.repo);
  if (opts.unitsFile) opts.unitsFile = path.resolve(opts.unitsFile);
  if (opts.prewarm && opts.command.includes('{units}')) throw Error('prewarm does not support {units}');
  opts.repoName = path.basename(opts.repo).replace(/[^A-Za-z0-9_.-]/g, '_');
  opts.out = path.resolve(opts.out || path.join(os.tmpdir(), `devbox-run-output-${Date.now()}-${process.pid}`));
  return opts;
}

function registryRows(dir) {
  const rows = fs.readFileSync(path.join(dir, 'resources.tsv'), 'utf8').trim().split('\n').map(line => {
    const [slot, kind, policy, , ...description] = line.split('\t');
    const addresses = [...description.join('\t').matchAll(/\b([A-Za-z_][A-Za-z0-9_.-]*)@((?:\d{1,3}\.){3}\d{1,3})\b/g)];
    const unique = [...new Set(addresses.map(m => `${m[1]}@${m[2]}`))];
    const caps = /\bcaps=([A-Za-z0-9_,.-]+)/.exec(description.join(' '))?.[1].split(',') || [];
    return { slot, kind, policy, caps, ...(unique.length === 1 ? { user: addresses[0][1], host: addresses[0][2], target: unique[0] } : {}) };
  });
  return rows;
}

export function readRegistry(dir, pool) {
  const pattern = pool === 'devbox-cn' ? /^devbox-cn-\d+$/ : /^devbox-cn-light(?:-\d+)?$/;
  return registryRows(dir).filter(row => row.kind === 'remote' && row.policy === 'open' && pattern.test(row.slot));
}

const lockPath = (dir, slot) => path.join(dir, 'locks', `${slot}.d`);
function previousSlotJob(slot, by) {
  try {
    const lines=fs.readFileSync(path.join(sharedDir(),'log.tsv'),'utf8').trimEnd().split('\n');
    for (const line of lines.reverse()) {
      const [,action,id,holder]=line.split('\t');
      if(action==='take' && id===slot && holder && !holder.startsWith(by+' ('))
        return /\(([^()]*)\)$/.exec(holder)?.[1] || holder;
    }
  } catch(error) { if(error.code!=='ENOENT') throw error; }
}
const freeSlot = (dir, row) => !fs.existsSync(lockPath(dir, row.slot));
const hasCapabilities = (opts, row) => opts.need.every(cap => row.caps.includes(cap));
const eligibleSlot = (opts, row) => hasCapabilities(opts, row)
  && !opts.excludeSlot.includes(row.slot) && !opts.excludeHost.includes(row.host);
const runRows = opts => opts.prewarm
  ? [...readRegistry(sharedDir(), 'devbox-cn'), ...readRegistry(sharedDir(), 'devbox-cn-light')]
  : readRegistry(sharedDir(), opts.pool);

function quarantinedHosts(dir) {
  let health;
  try { health = JSON.parse(fs.readFileSync(path.join(dir, 'box-health.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw Error('invalid box-health.json for automatic placement');
  }
  if (!health || typeof health !== 'object' || Array.isArray(health)) throw Error('invalid box-health.json for automatic placement');
  const blocked = new Set(), now = Date.now() / 1000;
  for (const [host, entry] of Object.entries(health)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || (entry.manual !== undefined && typeof entry.manual !== 'boolean')
      || (entry.autoQuarantined !== undefined && typeof entry.autoQuarantined !== 'boolean')
      || (entry.quarantinedUntil !== undefined && (!Number.isFinite(entry.quarantinedUntil) || entry.quarantinedUntil < 0))
      || (entry.failures !== undefined && (!Array.isArray(entry.failures)
        || entry.failures.some(failure => !failure || typeof failure !== 'object' || !Number.isFinite(failure.at)))))
      throw Error('invalid box-health.json for automatic placement');
    if (entry.manual || (entry.quarantinedUntil || 0) > now) blocked.add(host);
  }
  return blocked;
}

function heldSlots(dir, host, liveOnly = false) {
  return registryRows(dir).filter(row => {
    if (row.kind !== 'remote' || row.host !== host || !/^devbox-cn-(?:\d+|light(?:-\d+)?)$/.test(row.slot) || freeSlot(dir, row)) return false;
    if (liveOnly) {
      try {
        const info = Object.fromEntries(fs.readFileSync(path.join(lockPath(dir, row.slot), 'info'), 'utf8').trim().split('\n').map(line => line.split('\t')));
        if (info.host === os.hostname() && /^[1-9]\d*$/.test(info.pid || '')) {
          try { process.kill(Number(info.pid), 0); } catch (error) { if (error.code === 'ESRCH') return false; }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Missing/remote PID metadata does not prove a hold dead.
    return true;
  });
}

export function cpuBudget(dir, host, hostCores) {
  if (!Number.isInteger(hostCores) || hostCores < 1) throw Error(`missing valid core count for ${host}`);
  const heavyHolders = heldSlots(dir, host, true).filter(row => /^devbox-cn-\d+$/.test(row.slot)).length;
  return { cpus: Math.min(hostCores, Math.max(2, Math.floor(hostCores / Math.max(1, heavyHolders)))), hostCores, heavyHolders };
}

export function cpuEnvironment(cpus) {
  return { DEVBOX_CPUS: String(cpus), MAKEFLAGS: `-j${cpus}`, CMAKE_BUILD_PARALLEL_LEVEL: String(cpus),
    NODE_TEST_WORKERS: String(cpus), VITEST_MAX_THREADS: String(cpus), JEST_WORKERS: String(cpus), npm_config_jobs: String(cpus) };
}

export function parseUnits(text) {
  const units = text.split(/\r?\n/).filter(line => line.trim());
  if (!units.length) throw Error('unit list is empty');
  if (units.some(unit => path.posix.isAbsolute(unit) || unit.includes('\0') || unit.split('/').some(part => !part || part === '..' || part === '.') || sensitiveFile.test(unit)))
    throw Error('units must be source-only workspace-relative paths');
  if (new Set(units).size !== units.length) throw Error('duplicate unit in list');
  return units;
}

export function discoverUnits(files) {
  return files.filter(file => /(?:^|\/)(?:__tests__\/.*\.(?:[cm]?[jt]sx?)|test_[^/]+\.py|[^/]+_test\.go|[^/]+Test\.(?:java|kt))$|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)).sort();
}

export function assignUnits(units, shards, durations = {}) {
  const balanced = units.every(unit => Number.isFinite(durations[unit]?.durationSec) && durations[unit].durationSec > 0);
  const groups = Array.from({ length: shards }, () => []), loads = Array(shards).fill(0);
  const ordered = balanced ? units.toSorted((a, b) => durations[b].durationSec - durations[a].durationSec) : units;
  ordered.forEach((unit, index) => {
    const shard = balanced ? loads.indexOf(Math.min(...loads)) : index % shards;
    groups[shard].push(unit); loads[shard] += balanced ? durations[unit].durationSec : 0;
  });
  return { groups, loads, strategy: balanced ? 'longest-first' : 'round-robin' };
}

export function planShards(requested, freeSlots, units, history = {}, commandKey) {
  const duration = units?.every(unit => history.units?.[unit]?.durationSec > 0)
    ? units.reduce((total, unit) => total + history.units[unit].durationSec, 0) : history.commands?.[commandKey]?.durationSec;
  let count = requested;
  if (requested === 'auto') {
    if (!freeSlots) throw Error('no free eligible slots for --shards auto; explicit N can queue');
    count = Math.min(64, freeSlots, units?.length || 64, Number.isFinite(duration) ? Math.max(1, Math.floor(duration / 120)) : 1);
    // Average time alone is insufficient when one long unit dominates.
    while (units && count > 1) {
      const plan = assignUnits(units, count, history.units);
      if (plan.strategy !== 'longest-first' || Math.min(...plan.loads) >= 120) break;
      count--;
    }
  }
  if (units && count > units.length) throw Error('--shards exceeds the number of units');
  return { count, expectedDurationSec: Number.isFinite(duration) ? duration : null,
    ...(units ? assignUnits(units, count, history.units) : { groups: Array.from({ length: count }, () => null), strategy: 'command' }) };
}

// Output is line-buffered so assignments split across SSH chunks are still masked.
function lineSink(write, values = [], intercept, strictOutput = true, initialPrivateBlock = false) {
  let pending = '', dropping = false;
  const visibleLine = line => {
    const masked = redact(line);
    return line.startsWith('[cleanup-ineffective] ') && !masked.startsWith('[cleanup-ineffective] ')
      ? '[cleanup-ineffective] ' + masked : masked;
  };
  const redact = line => {
    for (const value of values) line = line.replaceAll(value, '[MASKED]');
    line = maskLogText(line).text;
    if (strictOutput && (sensitive.test(line) || /ACCESS|SCRECT|KEY(?!ALIAS)|PASS|PWD|AUTH|NEXUS|MAGIC|PRIVATE/i.test(line)) && /[=:]|bearer\s/i.test(line)) return '[MASKED sensitive output]';
    return line.replace(/\bAKIA[A-Z0-9]{16}\b/g, '[MASKED access key]');
  };
  const stream = privateKeyBlockStream(text => {
      pending += text;
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!dropping && !intercept?.(line)) write(`${visibleLine(line)}\n`);
        dropping = false;
      }
      if (pending.length > 1024 * 1024) { if (!dropping) write('[suppressed oversized output line]\n'); pending = ''; dropping = true; }
  }, { initialActive: initialPrivateBlock });
  return {
    push(chunk) { stream.push(chunk); },
    end() { stream.end(); if (pending && !dropping) write(visibleLine(pending)); },
    get privateBlockOpen() { return stream.active; },
  };
}

function ownChild(child) {
  const pid = child.pid;
  let active = true;
  child.once('exit', () => { active = false; });
  child.once('error', () => { if (!child.pid) active = false; });
  // The ChildProcess handle is the per-spawn identity. Never reopen it by PID.
  return sig => active && pid > 0 && child.pid === pid && child.exitCode === null
    && child.signalCode === null && child.kill(sig);
}

export function execute(file, args, { input, inputFile, outputFile, appendOutput = false, onBytes, onStderrLine, onStdoutLine, onOutput, timeout = 60000, state, cancellable = true, rawCapture = !onOutput && !outputFile, interceptStderr, interceptStdout, env = process.env, strictOutput = true, deferOutputEnd = false } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '', stdoutBytes = 0, stdinBytes = 0, timedOut = false, spawnError, sinkFailed = false;
    const sink = outputFile ? fs.createWriteStream(outputFile, { mode: 0o600, flags: appendOutput ? 'a' : 'w' }) : null;
    const rawDecoder = new StringDecoder('utf8');
    const out = lineSink(text => { if (!rawCapture) stdout = (stdout + text).slice(-2 * 1024 * 1024); onOutput?.(text, 'stdout'); }, state?.values, line => {
      const duration = onStdoutLine?.(line);
      if (Number.isFinite(duration) && duration > 0) resetTimeout(duration);
      return interceptStdout?.(line);
    }, strictOutput);
    let timer;
    const resetTimeout = duration => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; stop(); }, duration); };
    const err = lineSink(text => {
      stderr = (stderr + text).slice(-2 * 1024 * 1024); onOutput?.(text, 'stderr');
      const duration = onStderrLine?.(text);
      if (Number.isFinite(duration) && duration > 0) resetTimeout(duration);
    }, state?.values, interceptStderr, strictOutput);
    const signalChild = ownChild(child);
    if (state && cancellable) state.children.add(signalChild);
    let killTimer;
    const stop = () => { signalChild('SIGTERM'); killTimer ??= setTimeout(() => signalChild('SIGKILL'), 30000); };
    sink?.on('error', error => { sinkFailed = true; spawnError = `output file ${error.code || 'write failure'}`; child.stdout.resume(); stop(); });
    sink?.on('drain', () => child.stdout.resume());
    resetTimeout(timeout);
    let source;
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      onBytes?.(chunk.length);
      if (sink) { if (!sinkFailed && !sink.write(chunk)) child.stdout.pause(); }
      else if (rawCapture) {
        stdout += rawDecoder.write(chunk);
        if (onOutput) out.push(chunk);
        if (stdout.length > 64 * 1024 * 1024) { spawnError = 'capture limit exceeded'; stop(); }
      } else out.push(chunk);
    });
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => { spawnError = error.code || 'spawn failed'; });
    child.on('close', async (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); source?.destroy();
      state?.children.delete(signalChild);
      const resumeOutput = deferOutputEnd && code === 255 && !spawnError && !timedOut;
      if (!resumeOutput) out.end(); err.end();
      if (rawCapture) stdout += rawDecoder.end();
      if (sink && !sinkFailed) await new Promise(done => { sink.once('error', done); sink.end(done); });
      resolve({ code: spawnError ? 1 : timedOut ? 124 : code ?? (signal === 'SIGTERM' ? 143 : 1), stdout, stdoutBytes, stdinBytes,
        ...(resumeOutput ? { stdoutSink: out } : {}), stdoutPrivateBlockOpen: out.privateBlockOpen,
        stderr: stderr || spawnError || '', error: spawnError, signal, timedOut });
    });
    if (inputFile) { source = fs.createReadStream(inputFile); source.on('data', chunk => { stdinBytes += chunk.length; }); source.on('error', error => { spawnError = `input file ${error.code || 'read failure'}`; stop(); }); source.pipe(child.stdin); }
    else { stdinBytes = input ? Buffer.byteLength(input) : 0; child.stdin.end(input); }
    if (state?.cancel && cancellable) stop();
  });
}

function executeRes(args, options) {
  // Local res diagnostics still get value masking, but keep their surrounding text.
  const operation = () => execute(resCommand(), args, { ...options, strictOutput: false });
  return options?.state?.currentAttemptTiming?.measure('res.' + args[0], operation) || operation();
}

function checked(result, label) {
  if (result.code) { const error = Error(`${label} failed (${result.code})${result.stderr ? `: ${result.stderr.trim()}` : ''}`); error.code = result.code; error.infraFailure = result.infraFailure; throw error; }
  return result.stdout;
}

function remoteCommand(operation, python, data) {
  return `# devbox-run:${operation}\npython3 -c ${quote(python)} ${quote(Buffer.from(JSON.stringify(data)).toString('base64'))}`;
}
const pythonHeader = 'import os, sys, json, base64, pathlib, time, signal\n# Source-only worktrees: never run git-lfs smudge (the bare store has no remote; boxes differ in global git-lfs setup).\nimport shutil as _sh\n_lfs=[("filter.lfs.smudge","git-lfs smudge --skip -- %f"),("filter.lfs.process","git-lfs filter-process --skip")] if _sh.which("git-lfs") else []\n_lfs.append(("filter.lfs.required","false"))\n_lfs.append(("core.hooksPath","/dev/null"))  # runner checkouts never run repo hooks (e.g. git-lfs post-checkout)\nos.environ.update({"GIT_LFS_SKIP_SMUDGE":"1","GIT_CONFIG_COUNT":str(len(_lfs))})\nif not _sh.which("git-lfs"): os.environ.update({"GIT_CONFIG_GLOBAL":"/dev/null","GIT_CONFIG_NOSYSTEM":"1"})  # no git-lfs: drop any global/system lfs driver; undefined filters are no-ops\nfor _i,(_k,_v) in enumerate(_lfs): os.environ["GIT_CONFIG_KEY_%d"%_i]=_k; os.environ["GIT_CONFIG_VALUE_%d"%_i]=_v\nd=json.loads(base64.b64decode(sys.argv[1]))\n';

const remoteRunIdentity = `ctl=pathlib.Path(d['control'])
run_id=ctl.name
def read_own(file):
    record=json.loads(file.read_text())
    if record.get('run')!=run_id: sys.exit(70)
    return record
def alive(record):
    try:
        fields=pathlib.Path('/proc/'+str(record['pid'])+'/stat').read_text().rsplit(')',1)[1].split()
        return fields[0]!='Z' and fields[19]==record['start']
    except FileNotFoundError: return False
def group_gone():
    file=ctl/'group.json'
    if not file.exists(): return True
    group=read_own(file); pgid=group['pid']
    current=pathlib.Path('/proc/'+str(pgid)+'/stat')
    try:
        if current.read_text().rsplit(')',1)[1].split()[19]!=group['start']: return True
    except FileNotFoundError: pass
    try: os.killpg(pgid,0); return False
    except ProcessLookupError: return True
`;

const inputMapPython = `ctl=pathlib.Path(d['control']); ctl.mkdir(parents=True,exist_ok=True)
disk=os.statvfs(d['root'])
if disk.f_bavail*disk.f_frsize<53*1073741824: sys.exit(72)
if 'records' in globals():
    for name,p in list(d['paths'].items()):
        record=next((r for r in records if r['path']==p),None)
        if record and not record['present']: d['paths'][name]=d['defaultPaths'][name]
file=ctl/'inputs.json'; temporary=ctl/'inputs.tmp'
temporary.write_text(json.dumps(d['paths'])); temporary.replace(file)
`;

export const runDataCleanupPython = `import re, stat as data_stat, subprocess
# Inspect identity, cwd and fd link names only; never argv, environment or fd contents.
def process_exists(process):
    try: process.lstat(); return True
    except (FileNotFoundError,ProcessLookupError): return False
    except OSError: return True # Inaccessibility cannot prove that a PID is dead.

def probe_link(link):
    target=os.readlink(link)
    if target.endswith(' (deleted)'): target=target[:-10]
    return pathlib.Path(target).resolve() if target.startswith('/') else None

def process_snapshot(proc_root,probe):
    # Path.glob hides directory PermissionError. Explicit enumeration must fail closed.
    try: inventory=list(proc_root.iterdir())
    except OSError as error:
        probe['inventoryErrors']+=1
        raise RuntimeError('process inventory unreadable ('+type(error).__name__+')')
    rows=[]
    for process in inventory:
        if not process.name.isdigit(): continue
        if proc_root==pathlib.Path('/proc') and process.name==str(os.getpid()): continue
        probe['scanned']+=1
        fields=None; errors=[]; comm='(unknown)'
        try:
            identity,tail=(process/'stat').read_bytes().rsplit(b')',1)
            comm=identity.partition(b'(')[2].decode('utf-8','replace')
            fields=tail.decode('ascii').split()
            if fields[0]=='Z': probe['zombiesIgnored']+=1; continue
            if int(fields[6]) & 0x00200000: continue # Kernel threads are not app workspace users.
        except (FileNotFoundError,ProcessLookupError):
            if not process_exists(process): continue
            probe['statErrors']+=1; errors.append('stat unavailable')
        except (OSError,ValueError,IndexError) as error:
            probe['statErrors']+=1; errors.append('stat unreadable ('+type(error).__name__+')')
        probe['eligible']+=1
        # A non-dumpable process can have root-owned /proc entries even for our UID.
        # Read the effective UID in status, keeping identity for receipt matching.
        try:
            uid_line=next(line for line in (process/'status').read_bytes().splitlines() if line.startswith(b'Uid:'))
            uid=int(uid_line.split()[2])
        except (OSError,StopIteration,ValueError,IndexError):
            if not process_exists(process): continue
            uid=None # Unknown ownership does not qualify for either exclusion.
        row={'pid':process.name,'fields':fields,'cwd':None,'cwdReadable':False,'paths':[],'errors':errors}
        if uid is not None and uid!=os.geteuid():
            probe['ignoredOtherUid']+=1
            row['ignored']=True
            rows.append(row); continue
        cwd=None; cwd_readable=False; paths=[]
        try: cwd=probe_link(process/'cwd'); cwd_readable=cwd is not None
        except (OSError,ValueError,RuntimeError) as error:
            if not process_exists(process): continue
            probe['cwdErrors']+=1; errors.append('cwd unreadable ('+type(error).__name__+')')
        fd_readable=False; fd_denied=False
        try:
            descriptors=list((process/'fd').iterdir()); fd_readable=not descriptors
        except OSError as error:
            if not process_exists(process): continue
            descriptors=[]; fd_denied=True; probe['fdErrors']+=1; errors.append('fd inventory unreadable ('+type(error).__name__+')')
        for descriptor in descriptors:
            try:
                target=probe_link(descriptor); fd_readable=True
                if target is not None: paths.append(target)
            except (FileNotFoundError,ProcessLookupError): continue # A closed descriptor no longer holds a file.
            except (OSError,ValueError,RuntimeError) as error:
                fd_denied=True; probe['fdErrors']+=1; errors.append('fd link unreadable ('+type(error).__name__+')')
        if uid==os.geteuid() and not cwd_readable and fd_denied and not fd_readable:
            probe['ignoredUnreadableOwn']+=1
            names=probe['ignoredUnreadableOwnComms']; names[comm]=names.get(comm,0)+1
            row['ignored']=True
        row.update(cwd=cwd,cwdReadable=cwd_readable,paths=paths)
        rows.append(row)
    return rows

def group_records(root,probe):
    try: controls=list((root/'runs').iterdir())
    except FileNotFoundError: return []
    except OSError as error:
        probe['receiptInventoryErrors']+=1
        raise RuntimeError('receipt inventory unreadable ('+type(error).__name__+')')
    records=[]
    for ctl in controls:
        if not re.fullmatch(r'[0-9a-f-]{36}',ctl.name) or ctl.is_symlink(): continue
        file=ctl/'group.json'
        try:
            info=file.lstat()
            if data_stat.S_ISLNK(info.st_mode): raise ValueError('receipt symlink')
            record=json.loads(file.read_text())
            if not isinstance(record,dict): record={}
        except FileNotFoundError: continue # The process scan covers the publication window.
        except (OSError,ValueError): probe['receiptErrors']+=1; record={}
        value=record.get('workspace'); scope=None
        if isinstance(value,str) and pathlib.Path(value).is_absolute():
            try: scope=pathlib.Path(value).resolve()
            except (OSError,ValueError,RuntimeError): pass
        records.append({'pid':record.get('pid'),'start':record.get('start'),'scope':scope,'scopeUnknown':scope is None})
    return records

def workspace_process_live(workspace,root,rows,records,probe):
    def inside(target,base): return target is not None and (target==base or target.is_relative_to(base))
    roots={root.resolve()}
    # Numbered workspace layout also identifies another workspace's affiliation,
    # including a registered secondary tree represented by a receipt.
    for target in [workspace]+[record['scope'] for record in records if record['scope'] is not None]:
        parts=target.parts
        for i,part in enumerate(parts):
            if part=='wt' and len(parts)>=i+4 and parts[i+2].startswith('id-') and re.fullmatch(r'devbox-cn-(?:[0-9]+|light(?:-[0-9]+)?)',parts[i+3]):
                roots.add(pathlib.Path(*parts[:i])); break
    def affiliation(target):
        if inside(target,workspace): return workspace
        if target is None: return None
        for base in roots:
            try: parts=target.relative_to(base/'wt').parts
            except ValueError: continue
            if len(parts)>=3 and parts[1].startswith('id-') and re.fullmatch(r'devbox-cn-(?:[0-9]+|light(?:-[0-9]+)?)',parts[2]):
                return base/'wt'/pathlib.Path(*parts[:3])
        return None
    table={row['pid']:row for row in rows}; holds=False; warnings=[]
    for row in rows:
        # Cwd and open-file positives are established before any receipt identity exclusion.
        direct=inside(row['cwd'],workspace) or any(inside(target,workspace) for target in row['paths'])
        scopes=[]; record_unknown=False
        fields=row['fields']; pgid=None
        try: pgid=int(fields[2])
        except (TypeError,ValueError,IndexError): pass
        for record in records:
            pid=record['pid']
            if type(pid) is int and pid>0:
                if str(pid)!=row['pid'] and pid!=pgid: continue
                leader=table.get(str(pid)); observed=None
                try: observed=leader['fields'][19]
                except (TypeError,IndexError): pass
                start=record['start']
                if isinstance(start,str) and re.fullmatch(r'[0-9]+',start) and isinstance(observed,str) and re.fullmatch(r'[0-9]+',observed) and int(start)!=int(observed): continue
            elif record['scope'] is None: continue
            if record['scope'] is not None: scopes.append(record['scope'])
            else: record_unknown=True
        recorded=any(inside(scope,workspace) for scope in scopes)
        holds=holds or direct or recorded
        if row.get('ignored') and not record_unknown: continue
        errors=row['errors'] or (['ambiguous live receipt'] if row.get('ignored') else [])
        if not errors: continue
        affiliations={value for value in [affiliation(row['cwd'])]+[affiliation(scope) for scope in scopes] if value is not None}
        reason=', '.join(sorted(set(errors)))
        if workspace in affiliations or recorded or direct:
            probe['uncertaintyHere']+=1; holds=True
            warnings.append('workspace process evidence unreadable: '+reason)
        elif affiliations:
            probe['uncertaintyElsewhere']+=1
        elif row['cwdReadable'] and not record_unknown:
            # Readable cwd and recorded directories outside every workspace scope
            # make an inaccessible descriptor unrelated to this collector.
            probe['uncertaintyUnrelatedIgnored']+=1
        else:
            probe['uncertaintyUnattributed']+=1; holds=True
            warnings.append('unattributed process evidence unreadable: '+reason)
    if warnings: raise RuntimeError('; '.join(sorted(set(warnings))))
    return holds

def data_group_live(root,workspace,proc_root=pathlib.Path('/proc'),probe=None):
    if probe is None: probe={}
    for name in ['scanned','eligible','ignoredOtherUid','ignoredUnreadableOwn','inventoryErrors','receiptInventoryErrors','receiptErrors','zombiesIgnored','statErrors','cwdErrors','fdErrors','uncertaintyHere','uncertaintyElsewhere','uncertaintyUnrelatedIgnored','uncertaintyUnattributed']: probe.setdefault(name,0)
    probe.setdefault('ignoredUnreadableOwnComms',{})
    workspace=workspace.resolve()
    rows=process_snapshot(proc_root,probe)
    records=group_records(root,probe)
    return workspace_process_live(workspace,root,rows,records,probe)

def docker_socket_present():
    sockets=[pathlib.Path('/var/run/docker.sock')]
    endpoint=os.environ.get('DOCKER_HOST','')
    if endpoint.startswith('unix://'): sockets.append(pathlib.Path(endpoint[7:]))
    runtime=os.environ.get('XDG_RUNTIME_DIR')
    if runtime: sockets.append(pathlib.Path(runtime)/'docker.sock')
    return any(socket.is_socket() for socket in sockets)

def docker_workspace_live(workspace):
    def query(*args):
        return subprocess.check_output(['docker',*args],timeout=5,stderr=subprocess.DEVNULL)
    try:
        ids=query('ps','-q').decode('ascii').split()
        if ids:
            # Emit only JSON-escaped source paths, including names with spaces/newlines.
            sources=query('inspect','--type','container','--format','{{range .Mounts}}{{json .Source}}{{println}}{{end}}',*ids)
            for line in sources.splitlines():
                if not line.strip(): continue
                source=pathlib.Path(json.loads(line))
                if source.is_absolute() and source.resolve().is_relative_to(workspace): return True
    except (OSError,subprocess.SubprocessError,ValueError,TypeError,RuntimeError):
        if docker_socket_present(): raise RuntimeError('docker-unqueryable')
    return False

def cleanup_run_data(d,proc_root=pathlib.Path('/proc')):
    result={'entries':[],'bytes':0,'warnings':[],'processProbe':{}}
    if d.get('env',{}).get('DEVBOX_KEEP_RUN_DATA')=='1':
        return {**result,'skipped':'DEVBOX_KEEP_RUN_DATA=1'}
    data_fd=None
    try:
        root=pathlib.Path(d['root']); workspace=pathlib.Path(d['workspace']); slot=d['slot']
        relative=workspace.relative_to(root)
        if (len(relative.parts)!=4 or relative.parts[0]!='wt' or not relative.parts[2].startswith('id-')
                or relative.parts[3]!=slot or not re.fullmatch(r'devbox-cn-(?:[0-9]+|light(?:-[0-9]+)?)',slot)
                or workspace.resolve()!=root.resolve()/relative): raise RuntimeError('data cleanup workspace outside slot scope')
        control=pathlib.Path(d['control'])
        if control.parent!=root/'runs' or not re.fullmatch(r'[0-9a-f-]{36}',control.name) or control.is_symlink(): raise RuntimeError('data cleanup control outside runner scope')
        data=workspace/'.data'
        if data.is_symlink(): raise RuntimeError('data directory symlink refused')
        if not data.exists(): return result
        base=data.resolve(strict=True)
        if base!=workspace.resolve()/'.data': raise RuntimeError('data directory outside slot scope')
        data_fd=os.open(data,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        current=[value for value in [d.get('runId'),pathlib.Path(d['control']).name] if value]
        protected=set(); keep_all=False
        for record in retained_inventory(root):
            if record.get('slot')!=slot or record['expiresAt']<=time.time(): continue
            if record.get('workspace') and pathlib.Path(record['workspace']).resolve()!=workspace.resolve(): continue
            entries=record.get('dataEntries',[])
            if not isinstance(entries,list) or not all(isinstance(name,str) and name not in ('','.','..') and '/' not in name for name in entries): raise RuntimeError('invalid retained data entries')
            protected.update(entries)
            ctl=artifact_control(root,record['run']); manifest=ctl/'artifact-manifest.json'
            if manifest.is_symlink(): raise RuntimeError('artifact manifest symlink')
            if manifest.is_file():
                receipt=json.loads(manifest.read_text())
                for item in receipt.get('artifacts',[]):
                    parts=pathlib.PurePosixPath(item['name']).parts
                    if len(parts)>1 and parts[0]=='.data': protected.add(parts[1])
            elif record.get('dataEntries') is None and (ctl/'artifact-archive.tar').exists():
                keep_all=True # Legacy archives have no list of source data entries.
        if keep_all: return {**result,'skipped':'unexpired legacy retained archive'}
        inputs=pathlib.Path(d['control'])/'inputs.json'
        if inputs.is_symlink(): raise RuntimeError('input map symlink')
        paths=list(d.get('dataInputPaths',[]))
        if (workspace/'.git').exists():
            import subprocess
            tracked=subprocess.check_output(['git','-C',str(workspace),'ls-files','-z','--','.data'],timeout=5)
            for name in tracked.decode('utf-8','surrogateescape').split('\\0'):
                parts=pathlib.PurePosixPath(name).parts
                if len(parts)>1 and parts[0]=='.data': protected.add(parts[1])
        for name in d.get('untracked',[]):
            parts=pathlib.PurePosixPath(name).parts
            if len(parts)>1 and parts[0]=='.data': protected.add(parts[1])
        if inputs.is_file(): paths+=list(json.loads(inputs.read_text()).values())
        for value in paths:
            target=pathlib.Path(value).resolve()
            if target==base: return {**result,'skipped':'declared data directory input'}
            if target.is_relative_to(base): protected.add(target.relative_to(base).parts[0])
        live=data_group_live(root,workspace.resolve(),proc_root,result['processProbe'])
        if docker_workspace_live(workspace.resolve()): raise RuntimeError('live container mount protects workspace')
        if live: raise RuntimeError('live process group or workspace user protects workspace')
        private=re.compile(r'^(?:login|sessions?|cookies?|\\.env(?:\\..*)?|\\.netrc|\\.npmrc|\\.pypirc|\\.ssh|\\.aws|\\.kube|node_modules)$|\\.(?:pem|p12|pfx|key|keystore)$',re.I)
        def inspect_entry(entry):
            belongs=False
            todo=[entry]
            while todo:
                target=todo.pop(); info=target.lstat()
                parts=target.relative_to(data).parts
                if any(private.search(part) for part in parts): raise RuntimeError('private/cache state refused')
                if not target.resolve().is_relative_to(base): raise RuntimeError('symlink escape refused')
                if any(value in part for value in current for part in parts): belongs=True
                if data_stat.S_ISDIR(info.st_mode): todo+=list(target.iterdir())
                elif not (data_stat.S_ISREG(info.st_mode) or data_stat.S_ISLNK(info.st_mode)): raise RuntimeError('special entry refused')
            return belongs
        def remove_entry(parent,name,deleted):
            info=os.stat(name,dir_fd=parent,follow_symlinks=False)
            if data_stat.S_ISDIR(info.st_mode):
                fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                try:
                    opened=os.fstat(fd)
                    if (opened.st_dev,opened.st_ino)!=(info.st_dev,info.st_ino): raise RuntimeError('entry changed during cleanup')
                    with os.scandir(fd) as children:
                        for child in list(children): remove_entry(fd,child.name,deleted)
                finally: os.close(fd)
                latest=os.stat(name,dir_fd=parent,follow_symlinks=False)
                if (latest.st_dev,latest.st_ino)!=(info.st_dev,info.st_ino): raise RuntimeError('entry changed during cleanup')
                os.rmdir(name,dir_fd=parent); deleted['removed']+=1
            elif data_stat.S_ISREG(info.st_mode) or data_stat.S_ISLNK(info.st_mode):
                os.unlink(name,dir_fd=parent); deleted['removed']+=1
                if data_stat.S_ISREG(info.st_mode): deleted['bytes']+=info.st_size
            else: raise RuntimeError('special entry refused')
        for entry in sorted(data.iterdir()):
            if entry.name in protected: continue
            deleted={'name':entry.name,'bytes':0,'removed':0}
            try:
                if inspect_entry(entry): continue
                before=data.stat(); opened=os.fstat(data_fd)
                if (before.st_dev,before.st_ino)!=(opened.st_dev,opened.st_ino): raise RuntimeError('data directory changed during cleanup')
                remove_entry(data_fd,entry.name,deleted)
                result['entries'].append(deleted); result['bytes']+=deleted['bytes']
            except Exception as error:
                if deleted['removed']:
                    result['entries'].append({**deleted,'complete':False}); result['bytes']+=deleted['bytes']
                result['warnings'].append(entry.name+': '+str(error))
    except Exception as error: result['warnings'].append(str(error))
    finally:
        if data_fd is not None:
            try: os.close(data_fd)
            except OSError: result['warnings'].append('data handle close failed')
    return result

def print_data_cleanup(result):
    print('DEVBOX_DATA_CLEANUP='+json.dumps(result),flush=True)
    if result.get('bytes')==0 and result.get('warnings'):
        print('[cleanup-ineffective] '+json.dumps(result['warnings']),flush=True)
`;

export const remoteScripts = {
  'cleanup-pending': pythonHeader + cleanupEvidencePython,
  'list-retained': pythonHeader + retentionPython + `print(json.dumps(retained_inventory(d['root'])))\n`,
  'retire-artifacts': pythonHeader + retentionPython + `ctl=artifact_control(d['root'],d['receipt'])\nprint(json.dumps({'receipt':d['receipt'],'retiredBytes':retire_payload(ctl),'remainingBytes':payload_bytes(ctl)}))\n`,
  'expire-artifacts': pythonHeader + retentionPython + `print(json.dumps({'reclaimedBytes':expire_payloads(d['root'])}))\n`,
  'retained-disk': pythonHeader + retentionPython + `totals={}\nfor r in retained_inventory(d['root']):\n    if r.get('slot'): totals[r['slot']]=totals.get(r['slot'],0)+r['bytes']\nprint(json.dumps(totals))\n`,
  'input-map': pythonHeader + inputMapPython,
  'inputs-ready': pythonHeader + inputPython.replace('print(json.dumps(records))', '') + inputMapPython + `print(json.dumps({'records':records,'free':disk.f_bavail*disk.f_frsize,'map':str(file)}))\n`,
  inputs: pythonHeader + inputPython,
  seed: pythonHeader + seedPython,
  metrics: pythonHeader + `load5=float(pathlib.Path('/proc/loadavg').read_text().split()[1])
mem=next(int(line.split()[1])/1048576 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
disk=os.statvfs(d['root'])
io={'io_some_avg10':None,'io_some_avg60':None,'io_full_avg10':None}
try:
    for line in pathlib.Path('/proc/pressure/io').read_text().splitlines():
        fields=line.split()
        if not fields: continue
        for field in fields[1:]:
            name,sep,value=field.partition('=')
            metric='io_'+fields[0]+'_'+name
            if sep and metric in io:
                reading=float(value)
                if 0 <= reading <= 100: io[metric]=reading
except (OSError,ValueError): pass
print(json.dumps({'cores':os.cpu_count(),'load5':load5,'memAvailableGiB':mem,'freeGiB':disk.f_bavail*disk.f_frsize/1073741824,**io}))
`,
  probe: pythonHeader + `import subprocess, datetime, tempfile
data=pathlib.Path('/data00'); home=pathlib.Path(os.path.expanduser('~'))
candidates=([data/'home'/d['user']/'devbox-run',data/d['user']/'devbox-run'] if data.is_dir() else [])+[home/'devbox-run']
root=None
for candidate in candidates:
    try:
        candidate.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryFile(dir=candidate): pass
        root=str(candidate); break
    except OSError: continue
if root is None: raise RuntimeError('no writable workspace root')
v=os.statvfs(root)
mount=subprocess.check_output(['df','-P',root],text=True).splitlines()[-1].split()[-1]
mem=next(int(x.split()[1])/1048576 for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemTotal:'))
print(json.dumps({'root':root,'user':d['user'],'fs':mount,'freeGiB':v.f_bavail*v.f_frsize/1073741824,'totalGiB':v.f_blocks*v.f_frsize/1073741824,'cores':os.cpu_count(),'memGiB':mem,'probedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
`,
  store: pythonHeader + `import subprocess, fcntl, re
root=pathlib.Path(d['root']); key=d['key']; parent=root/'repos'/d['project']
index=root/'store-index'; index.mkdir(exist_ok=True); record=index/key
with open(str(record)+'.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    if record.exists():
        name=record.read_text()
    else:
        name=key
        # Old stores had no identity field. Adopt only in the explicit project
        # namespace and only with a matching commit, keeping all worktree links.
        if parent.is_dir() and d['legacy']:
            candidates=sorted(parent.iterdir(), key=lambda p: (p.name!=d['legacy'],p.name))
            for repo in candidates:
                if repo.name.startswith('id-') or repo.is_symlink() or not (repo/'HEAD').is_file(): continue
                probe=subprocess.run(['git','--git-dir='+str(repo),'cat-file','--batch-check=%(objecttype)'],
                                     input='\\n'.join(d['anchors'])+'\\n',text=True,capture_output=True,check=True)
                if 'commit' in probe.stdout.splitlines():
                    name=repo.name; break
        tmp=record.with_suffix('.tmp'); tmp.write_text(name); tmp.replace(record)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+',name) or name in ('.','..'): raise ValueError('invalid store name')
    print(name)
`,
  submodule: pythonHeader + `import subprocess
ws=pathlib.Path(d['workspace']).resolve(); parent=ws/d['parent']; rel=d['relative']; store=d['repository']
if (parent/rel).resolve()!=parent/rel or not (parent/rel).is_relative_to(ws): raise ValueError('invalid submodule destination')
env={**os.environ,'GIT_ALLOW_PROTOCOL':'file','GIT_TERMINAL_PROMPT':'0'}
def git(args):
    return subprocess.check_output(['git','-C',str(parent),*args],env=env)
name=d['name']
if git(['config','--file','.gitmodules','--get','submodule.'+name+'.path']).decode().rstrip('\\n')!=rel: raise ValueError('submodule mapping differs from pin')
# Explicitly walk one level at a time so every nested clone has a local URL.
# --reference makes future pins visible even in an existing slot clone.
git(['-c','submodule.'+name+'.url='+store,'submodule','update','--init','--checkout','--no-fetch','--reference',store,'--',rel])
if git(['-C',rel,'rev-parse','HEAD']).decode().strip()!=d['commit']: raise ValueError('submodule pin mismatch')
`,
  inspect: pythonHeader + `import subprocess
root=pathlib.Path(d['root']); root.mkdir(parents=True,exist_ok=True)
ctl=pathlib.Path(d['control']); ctl.mkdir(parents=True,exist_ok=True)
disk=os.statvfs(root)
def inspect(item):
    repo=pathlib.Path(item['repository']); known=[]; present=False
    if repo.exists():
        present=subprocess.run(['git','--git-dir='+str(repo),'cat-file','-e',item['commit']+'^{commit}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
        if not present: known=subprocess.check_output(['git','--git-dir='+str(repo),'for-each-ref','--format=%(objectname)'],text=True).splitlines()
    return {'known':known,'present':present}
result={'free':disk.f_bavail*disk.f_frsize,**inspect(d),'modules':[inspect(item) for item in d.get('modules',[])],'sameRefClean':False}
ws=pathlib.Path(d.get('workspace','/'))
def clean(tree,commit):
    if not (tree/'.git').exists(): return False
    try:
        left=lambda:max(.001,clean_deadline-time.monotonic())
        head=subprocess.check_output(['git','-C',str(tree),'rev-parse','HEAD'],text=True,timeout=left()).strip()
        status=subprocess.check_output(['git','-C',str(tree),'status','--porcelain','-z','--untracked-files=all','--ignore-submodules=none'],timeout=left())
        empty=subprocess.check_output(['git','-C',str(tree),'clean','-nd','--'],timeout=left())
        return head==commit and not status and not empty
    except (subprocess.SubprocessError,OSError): return False
clean_deadline=time.monotonic()+min(10,max(.001,d.get('cleanTimeoutSec',10)))
if d.get('reuseAllowed') and result['present'] and all(item['present'] for item in result['modules']):
    result['sameRefClean']=clean(ws,d['commit']) and all(clean(ws/item['parent']/item['relative'],item['commit']) for item in d.get('modules',[]))
    if result['sameRefClean']:
        meta=ws/'.devbox-run.json'
        old=json.loads(meta.read_text()) if meta.is_file() and not meta.is_symlink() else {}
        result['sameRefClean']=old.get('repository')==d['repository'] and old.get('slot')==d['slot'] and not old.get('untracked')
        if result['sameRefClean']:
            meta.write_text(json.dumps({'slot':d['slot'],'repository':d['repository'],'lastUsed':time.time(),'untracked':[],'job':d['job'],'affinity':d.get('affinity')}))
            for name in ['gradle','npm','pnpm','ccache','pip','toolchains']: (root/'shared'/name).mkdir(parents=True,exist_ok=True)
print(json.dumps(result))
`,
  bundle: pythonHeader + `import subprocess, fcntl, shutil
repo=pathlib.Path(d['repository']); repo.parent.mkdir(parents=True,exist_ok=True)
bundle=pathlib.Path(d['control'])/'incoming.bundle'
try:
    with bundle.open('wb') as out: shutil.copyfileobj(sys.stdin.buffer,out)
    with open(str(repo)+'.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if not repo.exists(): subprocess.run(['git','init','--bare',str(repo)],check=True,stdout=subprocess.DEVNULL)
        subprocess.run(['git','-c','gc.auto=0','--git-dir='+str(repo),'fetch','--no-write-fetch-head',str(bundle),'refs/heads/export:refs/devbox-run/'+d['commit']],check=True,stdout=subprocess.DEVNULL)
finally: bundle.unlink(missing_ok=True)
`,
  checkout: pythonHeader + `import subprocess, fcntl, shutil
repo=pathlib.Path(d['repository']); ws=pathlib.Path(d['workspace'])
meta=ws/'.devbox-run.json'
with open(str(repo)+'.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    if (ws/'.git').exists():
        old=json.loads(meta.read_text()) if meta.exists() else {}
        # Save all tracked edits before removing overlays or resetting any gitlink.
        trees=[]
        def modules(tree):
            trees.append(tree)
            entries=subprocess.check_output(['git','-C',str(tree),'ls-files','--stage','-z']).split(b'\\0')
            visited=set()
            for entry in entries:
                if not entry.startswith(b'160000 '): continue
                rel=entry.split(b'\\t',1)[1].decode(); child=tree/rel
                if rel in visited: continue
                visited.add(rel)
                if (child/'.git').exists(): modules(child)
        modules(ws)
        saved=[]
        for tree in trees:
            diff=subprocess.check_output(['git','-C',str(tree),'diff','--binary','HEAD','--'])
            if not diff: continue
            ctl=pathlib.Path(d['control'])/'slot-edits'; ctl.mkdir(parents=True,exist_ok=True)
            relative=tree.relative_to(ws).as_posix()
            import hashlib, uuid
            patch=ctl/(hashlib.sha256(relative.encode()).hexdigest()[:16]+'-'+uuid.uuid4().hex+'.patch')
            with patch.open('xb') as output:
                os.chmod(patch,0o600); output.write(diff)
            saved.append({'tree':relative,'patch':str(patch)})
        if saved:
            print(json.dumps({'previousJob':d.get('previousJob') or old.get('job','unknown (legacy slot receipt)'), 'patches':saved}))
        for tree in reversed(trees[1:]):
            subprocess.run(['git','-C',str(tree),'reset','--hard','HEAD'],check=True,stdout=subprocess.DEVNULL)
            subprocess.run(['git','-C',str(tree),'clean','-ffd','-q'],check=True,stdout=subprocess.DEVNULL)
        for name in old.get('untracked',[]):
            parts=pathlib.PurePosixPath(name).parts
            if not parts or name.startswith('/') or '..' in parts: raise RuntimeError('invalid overlay path')
            if parts[0]=='.data': continue # Let scoped run-data cleanup apply its protections.
            target=ws
            for part in parts:
                target=target/part
                if target.is_symlink(): target.unlink(); break
            else:
                if target.is_file(): target.unlink()
        subprocess.run(['git','-C',str(ws),'reset','--hard',d['commit']],check=True,stdout=subprocess.DEVNULL)
        # BC-117: drop untracked leftovers of earlier runs (not ignored build caches) so each run sees only its own overlay.
        subprocess.run(['git','-C',str(ws),'clean','-ffd','-q','-e','.data/'],check=True,stdout=subprocess.DEVNULL)
    else:
        ws.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['git','--git-dir='+str(repo),'worktree','add','--detach',str(ws),d['commit']],check=True,stdout=subprocess.DEVNULL)
    meta.write_text(json.dumps({'slot':d['slot'],'repository':str(repo),'lastUsed':time.time(),'untracked':d['untracked'],'job':d.get('job','unknown'),'affinity':d.get('affinity')}))
    exclude=pathlib.Path(subprocess.check_output(['git','-C',str(ws),'rev-parse','--path-format=absolute','--git-path','info/exclude'],text=True).strip())
    exclude.parent.mkdir(parents=True,exist_ok=True)
    previous=exclude.read_bytes() if exclude.exists() else b''
    if b'/.devbox-run.json' not in previous.splitlines():
        with exclude.open('ab') as out:
            if previous and not previous.endswith(b'\\n'): out.write(b'\\n')
            out.write(b'/.devbox-run.json\\n')
for name in ['gradle','npm','pnpm','ccache','pip','toolchains']:
    (pathlib.Path(d['root'])/'shared'/name).mkdir(parents=True,exist_ok=True)
`,
  inventory: pythonHeader + `root=pathlib.Path(d['root']); cutoff=time.time()-d['days']*86400; rows=[]
for meta in (root/'wt').glob('*/*/*/.devbox-run.json'):
    if meta.is_symlink() or not meta.resolve().is_relative_to(root.resolve()): continue
    row=json.loads(meta.read_text())
    if row.get('lastUsed',time.time())<cutoff:
        rows.append({'slot':row['slot'],'workspace':str(meta.parent),'repository':row['repository']})
print(json.dumps(rows))
`,
  'warm-path': pythonHeader + `root=pathlib.Path(d['root']); record=root/'store-index'/d['key']
name=record.read_text() if record.is_file() else d['key']
if not name or '/' in name or name in ('.','..'): raise RuntimeError('invalid store index')
ws=root/'wt'/d['project']/name/d['slot']
meta=ws/'.devbox-run.json'
valid=(ws/'.git').is_file() and meta.is_file()
if valid and d.get('affinity'): valid=json.loads(meta.read_text()).get('affinity')==d['affinity']
print(json.dumps(str(ws) if valid else None))
`,
  workspaces: pythonHeader + `root=pathlib.Path(d['root']); record=root/'store-index'/d['key']
name=record.read_text() if record.is_file() else d['key']
if not name or '/' in name or name in ('.','..'): raise RuntimeError('invalid store index')
print(json.dumps([slot for slot in d['slots'] if (root/'wt'/d['project']/name/slot/'.git').is_file()]))
`,
  recent: pythonHeader + `root=pathlib.Path(d['root']); recent={}
for meta in (root/'wt'/d['project']).glob('*/*/.devbox-run.json'):
    if meta.is_symlink() or not meta.resolve().is_relative_to(root.resolve()): continue
    row=json.loads(meta.read_text()); slot=row.get('slot')
    if slot: recent[slot]=max(recent.get(slot,0),row.get('lastUsed',0))
print(json.dumps(recent))
`,
  units: pythonHeader + `import subprocess, shlex
ctl=pathlib.Path(d['control']); records=[]; result=0
for unit in d['units']:
    command=d['command'].replace('{units}',shlex.quote(unit)) if '{units}' in d['command'] else d['command']+' '+shlex.quote(unit)
    start=time.monotonic()
    code=subprocess.run(['bash','-c',command],stdin=subprocess.DEVNULL).returncode
    code=code if code>=0 else 128-code
    records.append({'unit':unit,'durationSec':time.monotonic()-start,'exit':code})
    tmp=ctl/'units.tmp'; tmp.write_text(json.dumps({'run':ctl.name,'units':records})); tmp.replace(ctl/'units.json')
    if code and not result: result=code
sys.exit(result)
`,
  timings: pythonHeader + `ctl=pathlib.Path(d['control']); records={'units':[]}
file=ctl/'units.json'
if file.exists():
    records=json.loads(file.read_text())
    if records.get('run')!=ctl.name: raise RuntimeError('unit timing run mismatch')
print(json.dumps(records))
`,
  gc: pythonHeader + `import subprocess, fcntl, shutil
root=pathlib.Path(d['root']); ws=pathlib.Path(d['workspace']); repo=pathlib.Path(d['repository'])
before=os.statvfs(root); before=before.f_bavail*before.f_frsize
if not ws.resolve().is_relative_to((root/'wt').resolve()) or not repo.resolve().is_relative_to((root/'repos').resolve()): raise RuntimeError('GC path outside runner root')
meta=ws/'.devbox-run.json'
with open(str(repo)+'.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    if meta.exists():
        row=json.loads(meta.read_text())
        if row['slot']!=d['slot'] or row['lastUsed']>=time.time()-d['days']*86400: sys.exit(0)
        subprocess.run(['git','--git-dir='+str(repo),'worktree','remove','--force',str(ws)],check=True)
    subprocess.run(['git','--git-dir='+str(repo),'worktree','prune'],check=True)
    subprocess.run(['git','-c','gc.autoDetach=false','--git-dir='+str(repo),'gc','--auto'],check=True)
if d.get('docker') and shutil.which('docker'):
    subprocess.run(['docker','image','prune','--force'],check=True)
after=os.statvfs(root)
print(json.dumps({'reclaimedBytes':after.f_bavail*after.f_frsize-before}))
`,
  maintenance: pythonHeader + retentionPython + `import subprocess, fcntl, shutil
root=pathlib.Path(d['root']); before=os.statvfs(root); before=before.f_bavail*before.f_frsize
expire_payloads(root)
for repo in (root/'repos').glob('*/*'):
    if not repo.is_dir() or repo.is_symlink() or not (repo/'HEAD').is_file(): continue
    with open(str(repo)+'.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        subprocess.run(['git','--git-dir='+str(repo),'worktree','prune'],check=True)
        subprocess.run(['git','-c','gc.autoDetach=false','--git-dir='+str(repo),'gc','--auto'],check=True)
if shutil.which('docker'): subprocess.run(['docker','image','prune','--force'],check=True)
after=os.statvfs(root)
print(json.dumps({'reclaimedBytes':after.f_bavail*after.f_frsize-before}))
`,
  patch: pythonHeader + `import subprocess
os.chdir(d['workspace'])
sys.exit(subprocess.run(['git','apply','--index','--binary','--whitespace=nowarn','-'], input=sys.stdin.buffer.read()).returncode)
`,
  // The SSH-owned supervisor is a Linux subreaper OUTSIDE the command group.
  // It continuously reaps adopted children and owns cancellation/start arbitration.
  run: pythonHeader + retentionPython + runDataCleanupPython + `import ctypes, subprocess, shlex, shutil
if d.get('root'):
    disk=os.statvfs(d['root'])
    if disk.f_bavail*disk.f_frsize<53*1073741824:
        print('DEVBOX_LAUNCH_DISK_GUARD',file=sys.stderr,flush=True); sys.exit(72)
ctl=pathlib.Path(d['control']); cancelled=False
# The streaming SSH process follows a detached, bounded supervisor. Only the
# supervisor owns the command group; a lost stream cannot cancel its command.
if d.get('stream'):
    output=ctl/'output.log'
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    child=os.fork()
    if child:
        os.close(fd)
        try:
            with open(output,'rb') as log:
                while True:
                    chunk=log.read(65536)
                    if chunk: os.write(1,chunk); continue
                    done=ctl/'done.json'
                    if done.exists():
                        record=json.loads(done.read_text())
                        if record.get('run')!=ctl.name: sys.exit(70)
                        os.waitpid(child,0)
                        sys.exit(record['exit'])
                    time.sleep(.05)
        except (BrokenPipeError,ConnectionError): sys.exit(255)
    os.setsid()
    os.dup2(fd,1); os.dup2(fd,2); os.close(fd)
def cancel(signum, frame):
    global cancelled
    cancelled=True
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig,cancel)
libc=ctypes.CDLL(None, use_errno=True)
if libc.prctl(36,1,0,0,0) != 0: raise OSError(ctypes.get_errno(),'subreaper unavailable')
run_id=ctl.name
def stat(pid):
    try: return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
    except ProcessLookupError: return None
    except FileNotFoundError: return None
def save(name, data):
    tmp=ctl/(name+'.tmp'); tmp.write_text(json.dumps(dict(data,run=run_id))); tmp.replace(ctl/name)
save('owner.json',{'pid':os.getpid(),'start':stat(os.getpid())[19]})
if d.get('stream') and not cancelled and not (ctl/'cancel').exists():
    data_cleanup=cleanup_run_data(d)
    print_data_cleanup(data_cleanup)
    try: save('data-cleanup.json',data_cleanup)
    except Exception: print('devbox-run: data cleanup receipt warning',file=sys.stderr,flush=True)
proc=None; leader_start=None; result=1; command_start=None
def adopted():
    ids=pathlib.Path('/proc/'+str(os.getpid())+'/task/'+str(os.getpid())+'/children').read_text().split()
    return [int(pid) for pid in ids if not proc or int(pid)!=proc.pid]
def reap():
    for pid in adopted():
        try: os.waitpid(pid,os.WNOHANG)
        except ChildProcessError: pass
def exited():
    # Observe completion but keep the leader waitable until the LAST group signal.
    # Its PID/PGID cannot be reused while our child remains unreaped.
    return os.waitid(os.P_PID,proc.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
def signal_owned(pid,start,sig,group=False):
    fields=stat(pid)
    if not fields or fields[19]!=start or int(fields[1])!=os.getpid(): return
    if group and int(fields[2])!=pid: return
    try:
        if group: os.killpg(pid,sig)
        else: os.kill(pid,sig)
    except ProcessLookupError: pass
def stop_group(sig):
    if proc: signal_owned(proc.pid,leader_start,sig,True)
    # Detached descendants become our direct, waitable children on adoption.
    for pid in adopted():
        fields=stat(pid)
        if fields: signal_owned(pid,fields[19],sig)
try:
    if cancelled or (ctl/'cancel').exists(): result=143
    else:
        bootstrap='if [ -f "$HOME/devbox-env.sh" ]; then . "$HOME/devbox-env.sh"; else export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"; fi'
        exports='; '.join('export '+key+'='+shlex.quote(value) for key,value in d['env'].items())
        parallel=('export GRADLE_OPTS="'+'\u0024{GRADLE_OPTS:+\u0024GRADLE_OPTS }-Dorg.gradle.workers.max='+str(d['cpus'])+'"') if d.get('cpus') else ''
        shell=bootstrap+'\\n'+exports+'\\n'+parallel+'\\n'+d['command']
        proc=subprocess.Popen([shutil.which('bash'),'-lc',shell], start_new_session=True, cwd=d['workspace'], env={**os.environ,**d['env']}, stdin=subprocess.DEVNULL)
        command_start=time.monotonic(); deadline=command_start+d['seconds']
        leader_start=stat(proc.pid)[19]
        save('group.json',{'pid':proc.pid,'start':leader_start,'workspace':d['workspace'],'slot':d['slot']})
        if d.get('commandMarker'): print(d['commandMarker'],flush=True)
        while True:
            reap(); status=exited()
            if status:
                result=status.si_status if status.si_code==os.CLD_EXITED else 128+status.si_status
                break
            if cancelled or (ctl/'cancel').exists(): result=143; break
            if time.monotonic()>=deadline: result=124; break
            time.sleep(.05)
finally:
    stop_group(signal.SIGTERM)
    limit=time.monotonic()+10
    while time.monotonic()<limit:
        reap()
        if (not proc or exited()) and not adopted(): break
        if time.monotonic()>limit-8: stop_group(signal.SIGKILL)
        time.sleep(.05)
    reap()
    gone=(not proc or exited() is not None) and not adopted()
    if gone and proc: proc.wait()
    save('done.json',{'gone':gone,'exit':result if gone else 70,'commandDurationSec':time.monotonic()-command_start if command_start is not None else 0})
sys.exit(result if gone else 70)
`,
  'dead-slot': pythonHeader + `import re, subprocess
if not re.fullmatch(r'devbox-cn-(?:[0-9]+|light(?:-[0-9]+)?)',d['slot']): sys.exit(70)
root=pathlib.Path(d['root'])
# Every project/store path for this named slot, including legacy holders.
paths=list((root/'wt').glob('*/*/'+d['slot']))
if len(paths)>1024: sys.exit(70)
paths=[str(p.resolve()) for p in paths]
if d.get('workspace'): paths.append(d['workspace'])
limit=time.monotonic()+4
listing=subprocess.run(['ps','-axo','pid=,state=,args='],capture_output=True,text=True,timeout=2)
if listing.returncode: sys.exit(70)
arguments={}
for line in listing.stdout.splitlines():
    fields=line.strip().split(None,2)
    if len(fields)==3 and fields[0].isdigit() and not fields[1].startswith('Z'): arguments[int(fields[0])]=fields[2]
count=0
for proc in pathlib.Path('/proc').iterdir():
    if time.monotonic()>limit: sys.exit(70)
    if not proc.name.isdigit() or int(proc.name)==os.getpid(): continue
    try:
        fields=(proc/'stat').read_text().rsplit(')',1)[1].split()
        if fields[0]=='Z': continue
        args=arguments.get(int(proc.name),'')
        try: cwd=os.readlink(proc/'cwd')
        except PermissionError: cwd=''  # All-process ps arguments remain available.
    except FileNotFoundError: continue
    except (PermissionError,OSError): sys.exit(70)
    if any(cwd==p or cwd.startswith(p+'/') or re.search(r'(?<![\\w/.-])'+re.escape(p)+r'(?=/|[\\s\\x00\\x22\\x27]|$)',args) for p in paths): count+=1
print(json.dumps({'clean':count==0,'count':count,'worktrees':len(paths)}))
`,
  reconnect: pythonHeader + remoteRunIdentity + `done=ctl/'done.json'; owner=ctl/'owner.json'; group=ctl/'group.json'
if done.exists() and read_own(done)['gone'] and group_gone():
    print('group-gone')
elif owner.exists() and alive(read_own(owner)) or group.exists() and not group_gone():
    print('group-running')
elif group.exists() and owner.exists() and not done.exists():
    print('group-gone')
else: sys.exit(70)
`,
  result: pythonHeader + remoteRunIdentity + `import base64
done=ctl/'done.json'; limit=time.monotonic()+d.get('seconds',0)
while not done.exists() and time.monotonic()<limit:
    time.sleep(.1)
record=read_own(done) if done.exists() else None
if record and (type(record.get('exit')) is not int or not 0<=record['exit']<=255): sys.exit(70)
output=ctl/'output.log'
offset=d.get('offset',0)
if type(offset) is not int or offset<0: sys.exit(70)
tail=b''
if output.exists():
    with open(output,'rb') as log:
        log.seek(offset); tail=log.read(1024*1024)
print(json.dumps({'exit':record['exit'] if record else None,'tail':base64.b64encode(tail).decode(),'offset':offset+len(tail),'more':output.exists() and output.stat().st_size>offset+len(tail)}))
`,
  cleanup: pythonHeader + remoteRunIdentity + `ctl.mkdir(parents=True, exist_ok=True)
for file in ('owner.json','group.json','done.json'):
    if (ctl/file).exists(): read_own(ctl/file)
(ctl/'cancel').touch()
group=read_own(ctl/'group.json') if (ctl/'group.json').exists() else None
owner=read_own(ctl/'owner.json') if (ctl/'owner.json').exists() else None
pgid=group['pid'] if group else None
def members():
    if not group: return []
    try:
        fields=pathlib.Path('/proc/'+str(pgid)+'/stat').read_text().rsplit(')',1)[1].split()
        if fields[19]!=group['start']: return []
    except (FileNotFoundError,ProcessLookupError): pass
    found=[]
    for file in pathlib.Path('/proc').glob('[0-9]*/stat'):
        try: fields=file.read_text().rsplit(')',1)[1].split()
        except (FileNotFoundError,ProcessLookupError): continue
        if fields[0]!='Z' and int(fields[2])==pgid:
            # A command group always owns its session. Refuse unrelated/reused IDs.
            if int(fields[3])!=pgid or int(fields[19])<int(group['start']): raise RuntimeError('group identity mismatch')
            found.append(int(file.parent.name))
    return found
def status():
    group_count=len(members()); owner_alive=bool(owner and alive(owner))
    return {'run':run_id,'pgid':pgid,'count':group_count+int(owner_alive),'groupCount':group_count,'ownerAlive':owner_alive}
def report(value): print('DEVBOX_CLEANUP='+json.dumps(value),file=sys.stderr,flush=True)
def signal_group(sig):
    if members():
        try: os.killpg(pgid,sig)
        except ProcessLookupError: pass
# Cleanup uses an independent connection. Signal the recorded group directly;
# the cancellation file alone cannot reach a dead or unresponsive supervisor.
signal_group(signal.SIGTERM)
if owner and alive(owner):
    try: os.kill(owner['pid'],signal.SIGTERM)
    except ProcessLookupError: pass
limit=time.monotonic()+20
while time.monotonic()<limit:
    # Re-read arbitration records: a supervisor may publish owner/group after cancel.
    owner=read_own(ctl/'owner.json') if (ctl/'owner.json').exists() else owner
    group=read_own(ctl/'group.json') if (ctl/'group.json').exists() else group
    pgid=group['pid'] if group else None
    value=status()
    if not value['count'] and not value['ownerAlive']:
        report(value); print('group-gone'); sys.exit(0)
    if time.monotonic()>limit-18: signal_group(signal.SIGKILL)
    time.sleep(.1)
report(status())
sys.exit(70)
`,
  'fetch-artifact': pythonHeader + retainedArtifactPython,
  'artifact-range': pythonHeader + artifactRangePython,
  'artifact-release': pythonHeader + artifactRangePython.slice(0, artifactRangePython.indexOf('offset=d')) + `(ctl/'artifact-archive.tar').unlink()\n(ctl/'artifact-archive.json').unlink()\n`,
  artifacts: pythonHeader + retentionPython + `import glob, tarfile, hashlib, stat
collection_started=time.monotonic(); transfer_seconds=0
os.chdir(d['workspace']); names=set()
for pattern in d['patterns']:
    if pathlib.PurePosixPath(pattern).is_absolute() or '..' in pathlib.PurePosixPath(pattern).parts: raise RuntimeError('artifact pattern must be workspace-relative')
for pattern in d['patterns']:
    matches=glob.glob(pattern,recursive=True)
    if not matches: print('artifact pattern had no matches',file=sys.stderr); sys.exit(66)
    for name in matches:
        p=pathlib.Path(name)
        if p.is_dir(): names.update(x.as_posix() for x in p.rglob('*') if x.is_file() or x.is_symlink())
        else: names.add(p.as_posix())
for name in names:
    p=pathlib.Path(name)
    if p.is_symlink() or not p.resolve().is_relative_to(pathlib.Path.cwd()): raise RuntimeError('artifact leaves workspace')
    if not p.is_file(): raise RuntimeError('artifact special file refused')
    if any(x in ('.git','.ssh','.aws','.kube','.npmrc','.netrc') or x=='.env' or x.startswith('.env.') for x in p.parts) or p.suffix.lower() in ('.pem','.p12','.pfx','.key','.keystore'): raise RuntimeError('credential-related artifact refused')
class DigestOutput:
    def __init__(self,destination): self.digest=hashlib.sha256(); self.destination=destination
    def write(self,payload):
        global transfer_seconds
        self.digest.update(payload)
        started=time.monotonic()
        try: return self.destination.write(payload)
        finally: transfer_seconds+=time.monotonic()-started
if d.get('fetch')=='manifest':
    ctl=pathlib.Path(d['control']); root=pathlib.Path(d['root'])
    if ctl.parent!=root/'runs' or ctl.is_symlink() or not ctl.resolve().is_relative_to(root.resolve()/'runs'):
        raise RuntimeError('artifact receipt outside runner root')
    total=sum(pathlib.Path(name).stat().st_size for name in names)
    disk=os.statvfs(root)
    reserved=sum(r['bytes'] for r in retained_inventory(root) if r.get('slot')==d['slot'])
    if disk.f_bavail*disk.f_frsize-total-reserved<53*1073741824: raise RuntimeError('artifact retention disk reservation guard')
    if any(part.lower() in {'login','session','sessions','cookie','cookies','.netrc','.npmrc','.pypirc','.ssh','.aws','.kube','.env','.git'} for name in names for part in (ctl/'artifacts'/name).parts):
        raise RuntimeError('artifact manifest name contains private-state component')
    retention=begin_retention(d)
    retention.update({'workspace':d['workspace'],'dataEntries':sorted({pathlib.PurePosixPath(name).parts[1] for name in names if len(pathlib.PurePosixPath(name).parts)>1 and pathlib.PurePosixPath(name).parts[0]=='.data'})})
    temporary=ctl/'artifact-retention.tmp'; temporary.write_text(json.dumps(retention)); temporary.replace(ctl/'artifact-retention.json')
    retained=ctl/'artifacts'; retained.mkdir(mode=0o700)
    records=[]
    try:
      for name in sorted(names):
        parts=pathlib.PurePosixPath(name).parts
        if not parts or name.startswith('/') or any(part in ('.','..') for part in parts): raise RuntimeError('invalid artifact name')
        target=retained/name; target.parent.mkdir(parents=True,exist_ok=True)
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as source, target.open('xb') as dest:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise RuntimeError('artifact special file refused')
            os.chmod(target,0o600); h=hashlib.sha256(); size=0
            while True:
                chunk=source.read(1048576)
                if not chunk: break
                dest.write(chunk); h.update(chunk); size+=len(chunk)
        records.append({'name':name,'size':size,'sha256':h.hexdigest()})
    except BaseException:
        shutil.rmtree(retained); (ctl/'artifact-retention.json').unlink(missing_ok=True); raise
    receipt={**retention,'control':str(ctl),'artifacts':records}
    (ctl/'artifact-manifest.json').write_text(json.dumps(receipt))
    print(json.dumps(receipt))
    print('DEVBOX_ARTIFACT_COLLECTION='+json.dumps({'seconds':time.monotonic()-collection_started}),file=sys.stderr,flush=True)
    sys.exit(0)
ctl=pathlib.Path(d['control']); root=pathlib.Path(d['root'])
disk=os.statvfs(root)
reserved=sum(r['bytes'] for r in retained_inventory(root) if r.get('slot')==d['slot'])
total=sum(pathlib.Path(name).stat().st_size for name in names)
space=disk.f_bavail*disk.f_frsize-total-10485760-reserved>=53*1073741824
staged=space and (total>=32*1048576 or d.get('forceStage',False))
reason='low disk' if not space else 'small set'
if d.get('forceStage') and not staged:
    print('archive cannot be staged (low disk)',file=sys.stderr); sys.exit(75)
if staged:
    retention=begin_retention(d)
    retention.update({'workspace':d['workspace'],'dataEntries':sorted({pathlib.PurePosixPath(name).parts[1] for name in names if len(pathlib.PurePosixPath(name).parts)>1 and pathlib.PurePosixPath(name).parts[0]=='.data'})})
    temporary=ctl/'artifact-retention.tmp'; temporary.write_text(json.dumps(retention)); temporary.replace(ctl/'artifact-retention.json')
    destination=(ctl/'artifact-archive.tar').open('xb'); os.chmod(ctl/'artifact-archive.tar',0o600)
else: destination=sys.stdout.buffer
output=DigestOutput(destination)
with tarfile.open(fileobj=output,mode='w|',bufsize=1048576) as tar:
    entries=[(name,tar.gettarinfo(name,arcname=name)) for name in sorted(names)]
    size=sum(len(info.tobuf(tar.format,tar.encoding,tar.errors))+((info.size+511)//512)*512 for name,info in entries)+1024
    size=((size+10239)//10240)*10240
    if not staged:
        print('DEVBOX_ARTIFACT_SIZE='+json.dumps({'size':size,'reason':reason}),file=sys.stderr,flush=True)
    for name,info in entries:
        if info.isreg():
            with open(name,'rb') as source: tar.addfile(info,source)
        else: tar.addfile(info)
destination.flush()
if staged:
    destination.close()
    receipt={**retention,'control':str(ctl),'size':(ctl/'artifact-archive.tar').stat().st_size,'sha256':output.digest.hexdigest()}
    (ctl/'artifact-archive.json').write_text(json.dumps(receipt))
    print(json.dumps(receipt))
    print('DEVBOX_ARTIFACT_PLAN='+json.dumps(receipt),file=sys.stderr,flush=True)
print('DEVBOX_ARTIFACT_SHA256='+output.digest.hexdigest(),file=sys.stderr,flush=True)
print('DEVBOX_ARTIFACT_COLLECTION='+json.dumps({'seconds':max(0,time.monotonic()-collection_started-(0 if staged else transfer_seconds))}),file=sys.stderr,flush=True)
`,
};

async function ssh(row, operation, data, opts = {}) {
  const call = () => sshCall(row, operation, data, opts);
  return opts.state?.currentAttemptTiming?.measure('ssh.' + operation, call) || call();
}

async function sshCall(row, operation, data, opts = {}) {
  if (data.root && !Object.hasOwn(data, 'treeConfig')) {
    const settings = opts.state ? opts.state.treeSettings ||= treeSettings(sharedDir()) : treeSettings(sharedDir());
    if (settings[row.host]) data = { ...data, treeConfig: settings[row.host] };
  }
  if (opts.state) opts.state.sshMux ||= { degraded: false, fallbackCount: 0 };
  if (opts.state?.sshStartDelay && !opts.state.sshStarted) {
    opts.state.sshStarted = true;
    await pause(opts.state.sshStartDelay);
  }
  const base = operation === 'upload'
    ? `# devbox-run:upload\nmkdir -p ${quote(data.workspace)} && tar -xf - -C ${quote(data.workspace)}`
    : remoteCommand(operation, treeScript(operation, remoteScripts[operation], pythonHeader, data), data);
  let muxRetried = false;
  for (let retry = 0; ; retry++) {
    let started = false;
    const marker = `DEVBOX_STARTED_${randomUUID()}`;
    const command = base.replace('\n', `\nprintf '%s\\n' ${quote(marker)} >&2\n`);
    const result = await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'ConnectTimeout=15', '-o', 'ForwardAgent=no', '-o', 'GSSAPIDelegateCredentials=no', ...controlOptions(operation, opts.state), ...(['artifacts', 'fetch-artifact', 'artifact-range'].includes(operation) ? ['-o', 'Compression=no', '-o', 'Ciphers=^aes128-gcm@openssh.com'] : []), row.target, command], {
      ...opts, interceptStderr: line => { if (line === marker) { started = true; return true; } return false; },
    });
    opts.state?.currentAttemptTiming?.addBytes(result.stdinBytes || 0, result.stdoutBytes || 0);
    if (opts.state?.sshControlDir) (opts.state.sshTargets ||= new Map()).set(row.target, row);
    if (muxFailure(result)) {
      const mux = opts.state?.sshMux;
      if (mux) mux.degraded = true;
      if (!muxRetried && muxRetrySafe(operation, started) && !(opts.state?.cancel && opts.cancellable !== false)) {
        muxRetried = true;
        if (mux) mux.fallbackCount++;
        const receipt = { sshMuxFallback: true, sshMuxFallbackCount: mux?.fallbackCount || 1 };
        if (opts.state?.currentAttempt) Object.assign(opts.state.currentAttempt, receipt);
        if (opts.state?.currentAttemptTiming) Object.assign(opts.state.currentAttemptTiming.data, receipt);
        console.error(`devbox-run: SSH mux transport failed during ${operation}; retrying once independently`);
        result.stdoutSink?.end();
        retry--;
        continue;
      }
      return { ...result, sshStarted: started, transportFailure: true, ...(operation !== 'run' ? { infraFailure: true } : {}) };
    }
    const transient = result.code === 255 && !started && /Permission denied \(gssapi-with-mic\)|Connection closed\b/i.test(result.stderr);
    if (opts.noRetry || operation === 'metrics' || !transient || (opts.state?.cancel && opts.cancellable !== false)) return { ...result, sshStarted: started };
    result.stdoutSink?.end();
    if (retry === 3) return { ...result, infraFailure: true, stderr: `SSH establishment failed after 4 attempts: ${result.stderr}` };
    await pause(2000 + Math.floor(Math.random() * 8001));
  }
}

async function reconnectRun(row, data, state, requireAccess = false) {
  for (const delay of [0, 1000, 2000]) {
    if (delay) await pause(delay);
    const result = await ssh(row, 'reconnect', { control: data.control }, { state, cancellable: false, timeout: 8000, noRetry: true });
    if (result.code === 0 && ['group-gone', 'group-running'].includes(result.stdout.trim())) return result.stdout.trim();
    if (/permission denied|gssapi|authentication failed/i.test(result.stderr)) {
      if (requireAccess) throw Error('BLOCKED: SSH authentication error during dead-slot confirmation');
      break;
    }
  }
  return 'unknown';
}

async function closeControlConnections(state) {
  if (!state.sshControlDir) return;
  for (const target of state.sshTargets?.keys() || []) for (const socket of state.sshControlPaths || []) {
    await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ControlPath=' + socket, '-O', 'exit', target],
      { state, cancellable: false, timeout: 10000 });
  }
  fs.rmSync(state.sshControlDir, { recursive: true, force: true });
  delete state.sshControlDir; state.sshTargets?.clear(); state.sshControlPaths?.clear();
}

function validateArchivePlan(row, data, plan) {
  if (!Number.isSafeInteger(plan.size) || plan.size <= 0 || !/^[a-f0-9]{64}$/.test(plan.sha256)
      || plan.run !== path.posix.basename(data.control) || plan.commit !== data.commit || plan.slot !== row.slot) throw Error('invalid archive plan');
}

function artifactProgress(emit, shard, value, detail = '') {
  emit(`[shard ${shard}] artifact ${detail}${value.resuming ? 'resume ' + value.resumeCount + ': ' : ''}received=${value.receivedBytes}/${value.bytes} bytes (${(value.receivedBytes / value.bytes * 100).toFixed(1)}%) ${value.averageMBps.toFixed(2)} MB/s\n`);
}

async function collectArtifacts(row, data, out, state, opts, emit) {
  let announced, received = 0, startedAt = performance.now(), timer;
  const stats = () => ({ method: 'direct', resumable: false, reason: announced.reason, bytes: announced.size,
    receivedBytes: received, averageMBps: received / 1e6 / Math.max(0.001, (performance.now() - startedAt) / 1000),
    resumeCount: 0, restartCount: 0, timeoutSec: artifactTimeoutMs(announced.size, opts.artifactTimeout) / 1000 });
  const progress = () => artifactProgress(emit, opts.shard, stats(),
    announced.reason === 'low disk' ? 'not resumable (low disk): ' : 'direct (small set): ');
  try {
    const transferState = { ...state, cancel: state.cancel === 124 ? 0 : state.cancel };
    const fetched = await ssh(row, 'artifacts', data, { outputFile: out, state: transferState,
      timeout: opts.fetchTimeout * 60000, noRetry: true,
      onBytes: bytes => { received += bytes; },
      onStderrLine: line => {
        const record = /^DEVBOX_ARTIFACT_SIZE=(\{[^\n]*\})/.exec(line);
        if (!record || announced) return;
        const value = JSON.parse(record[1]);
        if (!Number.isSafeInteger(value.size) || value.size <= 0 || !['low disk', 'small set'].includes(value.reason)) return;
        announced = value;
        if (!received) startedAt = performance.now();
        progress(); timer = setInterval(progress, 30000);
        return artifactTimeoutMs(value.size, opts.artifactTimeout);
      },
    });
    return { ...fetched, ...(announced ? { direct: { ...stats(), startedAt } } : {}) };
  } finally {
    clearInterval(timer);
    if (announced) state.currentAttemptTiming.data.transferOut = stats();
  }
}

async function fetchArchiveRanges(row, data, plan, out, streams, state, capMinutes, emit, shard, resume = {}) {
  validateArchivePlan(row, data, plan);
  emit(`[shard ${shard}] artifact archive bytes=${plan.size} streams=${streams} timeoutCap=${capMinutes} min\n`);
  await readArchive(plan, out, { streams, capMinutes, ...resume,
    readRange: async ({ offset, length, ...options }) => {
      if (state.cancel && state.cancel !== 124) return { code: state.cancel, fatal: true };
      // Timed-out commands still return their logs; user/parent cancellation stops transfer children.
      const transferState = { ...state, cancel: state.cancel === 124 ? 0 : state.cancel };
      const result = await ssh(row, 'artifact-range', { ...data, sha256: plan.sha256, offset, length },
        { ...options, appendOutput: true, state: transferState, noRetry: true });
      return { ...result, fatal: Boolean(state.cancel && state.cancel !== 124)
        || /Permission denied|Authentication failed|No supported authentication/i.test(result.stderr) };
    },
    onProgress: value => artifactProgress(emit, shard, value),
    onStats: value => { state.currentAttemptTiming.data.transferOut = { ...value, resumable: true }; },
  });
  const released = await ssh(row, 'artifact-release', { ...data, sha256: plan.sha256 },
    { state, cancellable: false, timeout: 30000 });
  return released;
}

async function recoverRunResult(row, data, state, offset, emit, privateBlockOpen = false, stdoutSink) {
  const tail = stdoutSink || lineSink(emit, state.values, undefined, true, privateBlockOpen);
  const deadline = Date.now() + 27000;
  let exit = null;
  try {
    for (const delay of [0, 1000, 2000]) {
      if (delay) await pause(delay);
      const result = await ssh(row, 'result', { control: data.control, offset, seconds: 7 },
        { state, cancellable: false, timeout: 8000, noRetry: true });
      if (result.code) continue;
      try {
        const record = JSON.parse(result.stdout);
        if (!Number.isSafeInteger(record.offset) || record.offset < offset || typeof record.tail !== 'string') continue;
        const bytes = Buffer.from(record.tail, 'base64');
        if (record.offset !== offset + bytes.length) continue;
        tail.push(bytes); offset = record.offset;
        if (Number.isInteger(record.exit) && record.exit >= 0 && record.exit <= 255) exit = record.exit;
        // Drain a large tail in bounded pages without repeating delivered bytes.
        for (let page = 0; record.more && page < 63 && Date.now() < deadline; page++) {
          const fetched = await ssh(row, 'result', { control: data.control, offset },
            { state, cancellable: false, timeout: Math.min(8000, deadline - Date.now()), noRetry: true });
          if (fetched.code) break;
          const next = JSON.parse(fetched.stdout), chunk = Buffer.from(next.tail, 'base64');
          if (next.offset !== offset + chunk.length) break;
          tail.push(chunk); offset = next.offset; record.more = next.more;
        }
        if (exit !== null) return exit;
      } catch { /* A partial or unreadable receipt is retried on a fresh connection. */ }
    }
    return null;
  } finally { tail.end(); }
}

function readHold(row) {
  try {
    const text = fs.readFileSync(path.join(lockPath(sharedDir(), row.slot), 'info'), 'utf8');
    return { text, fields: Object.fromEntries(text.trimEnd().split('\n').filter(line => line.includes('\t')).map(line => line.split('\t'))) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function oldDeadHold(hold) {
  if (!hold || hold.fields.host !== os.hostname() || !/^[1-9]\d*$/.test(hold.fields.pid || '')
      || !/^[1-9]\d*$/.test(hold.fields.start || '') || !hold.fields.by
      || Date.now() / 1000 - Number(hold.fields.start) <= 900) return false;
  try { process.kill(Number(hold.fields.pid), 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
function sameHolder(a, b) {
  return ['by','pid','host','start'].every(key => a?.[key] === b?.[key]);
}
function heavyStaleEnabled() {
  try {
    const fd = fs.openSync(path.join(sharedDir(), 'machine.conf'), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) return false;
      const text = fs.readFileSync(fd, 'utf8');
      const matches = [...text.matchAll(/^[ \t]*DEVBOX_HEAVY_STALE_RECLAIM[ \t]*=[ \t]*([^\n]*)/gm)];
      return text.endsWith('\n') && matches.length === 1 && matches[0][1].trim() === '1';
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}
export async function confirmDeadSlot(row, state) {
  const hold = readHold(row);
  if (!oldDeadHold(hold)) return null;
  const root = await hostRoot(row, state, { deadline: Date.now() + 15000 });
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(sharedDir(), 'devbox-run-holds', row.slot + '.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (record && (record.slot !== row.slot || !sameHolder(record.holder, hold.fields))) record = null;
  if (record?.control) {
    if (!record.control.startsWith(root + '/runs/') || !/^[0-9a-f-]{36}$/.test(path.posix.basename(record.control))) throw Error('invalid held run identity');
    const pending = await ssh(row,'cleanup-pending',{root,control:record.control},{state,timeout:8000,noRetry:true});
    if (pending.code || JSON.parse(pending.stdout).clean !== true) return null;
  } else if (hold.fields.remote_cleanup_required) return null;
  const evidence = await ssh(row, 'dead-slot', { root, slot: row.slot, workspace: record?.workspace },
    { state, timeout: 8000, noRetry: true });
  if (evidence.code !== 0) {
    if (/permission denied|gssapi|authentication failed/i.test(evidence.stderr)) throw Error('BLOCKED: SSH authentication error during dead-slot confirmation');
    return null;
  }
  const verified = JSON.parse(evidence.stdout);
  if (verified.clean !== true || verified.count !== 0) return null;
  const current = readHold(row);
  if (!oldDeadHold(current) || current.text !== hold.text) return null;
  const dir = path.join(sharedDir(), 'devbox-stale-confirmations'); fs.mkdirSync(dir, { recursive: true });
  writeJSON(path.join(dir, row.slot + '.json'), { slot: row.slot, digest: createHash('sha256').update(hold.text).digest('hex'),
    at: Date.now() / 1000, clean: true, target: row.target });
  return { ...hold, ...verified };
}
export async function releaseDeadSlot(slot) {
  const row = [...readRegistry(sharedDir(), 'devbox-cn'), ...readRegistry(sharedDir(), 'devbox-cn-light')].find(row => row.slot === slot);
  if (!row?.target) throw Error('release-dead requires an open registered devbox slot with user@ip');
  const confirmed = await confirmDeadSlot(row);
  if (!confirmed) throw Error('BLOCKED: local holder death/age or remote cleanup unconfirmed; retaining ' + slot);
  checked(await executeRes(['release-dead', slot, '--by', confirmed.fields.by, '--pid', confirmed.fields.pid]), 'dead slot return');
  console.log(`returned ${slot}: local PID ${confirmed.fields.pid} dead, hold >15 minutes, remote worktrees=${confirmed.worktrees} processes=0, recorded group gone when available`);
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, file);
}

function normalizedOrigin(raw, repo) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw Error('invalid origin URL'); }
    if (url.protocol === 'file:') return path.resolve(decodeURIComponent(url.pathname)).replace(/\.git\/?$/, '');
    return url.host.toLowerCase() + '/' + url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  }
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(raw);
  return scp ? scp[1].toLowerCase() + '/' + scp[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
    : path.resolve(repo, raw).replace(/\.git$/, '');
}

export async function storeIdentity(repo, project, state) {
  let identity;
  if (project) identity = 'project:' + project;
  else {
    const result = await execute('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { state });
    const common = fs.realpathSync(checked(result, 'Git common directory').trim());
    const origin = await execute('git', ['-C', repo, 'config', '--get', 'remote.origin.url'], { state, rawCapture: true });
    if (origin.code === 0) identity = 'origin:' + normalizedOrigin(origin.stdout.trim(), path.dirname(common));
    else if (origin.code === 1) identity = 'local:' + common;
    else throw Error('cannot resolve repository identity');
  }
  return 'id-' + createHash('sha256').update(identity).digest('hex');
}

async function scanTransfer(snapshot, scope, bases, state, env = process.env) {
  const transferChecker = fileURLToPath(new URL('./lib/devbox-transfer-check.mjs', import.meta.url));
  const args = [transferChecker, '--repo', snapshot.sourceRepo, '--commit', snapshot.commit, '--mode', snapshot.mode,
    '--repo-id', snapshot.scanId, '--scope', scope, '--cache-dir', cacheDir(), ...bases.flatMap(oid => ['--base', oid])];
  const admission = await execute(process.execPath, args, { state, timeout: 300000, env });
  if (!admission.code) return;
  const progress = admission.stderr.match(/scanProgress phase=\S+ blobsDiscovered=\d+ blobsProcessed=\d+ cacheHits=\d+/g)?.at(-1);
  if (admission.code === 124) {
    const error = Error(`pre-transfer credential scan timed out after 300s${progress ? `: ${progress}` : ''}`);
    error.code = 124; throw error;
  }
  let findings;
  try { findings = JSON.parse(admission.stdout); }
  catch { findings = [{ path: '[source scan]', key: 'SCAN_UNAVAILABLE', count: 1 }]; }
  throw Error('pre-transfer credential gate refused: ' + findings.map(hit => `${JSON.stringify(hit.path)} key=${hit.key} count=${hit.count}`).join('; ')
    + `${progress && findings.some(hit => hit.key === 'SCAN_UNAVAILABLE') ? ` (${progress})` : ''}`
    + '. Use a source-only export with those fields blanked, or a repo-level allow entry in references/devbox-run.md for proven non-secrets.');
}

async function snapshot(opts, temp, state, ancestors = new Set(), parentObjects = []) {
  const gitEnv = parentObjects.length ? { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES:
    [process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, ...parentObjects.map(dir => JSON.stringify(dir))].filter(Boolean).join(path.delimiter) } : process.env;
  const git = async args => checked(await execute('git', ['-C', opts.repo, ...args], { state, rawCapture: true, env: gitEnv }), 'git snapshot');
  const top = (await git(['rev-parse', '--show-toplevel'])).trim();
  if (fs.realpathSync(top) !== opts.repo) throw Error('--repo must be the repository root');
  const commit = (await git(['rev-parse', '--verify', '--end-of-options', `${opts.ref === 'worktree' ? 'HEAD' : opts.ref}^{commit}`])).trim();
  const storeKey = await storeIdentity(opts.repo, opts.project, state);
  if (ancestors.has(storeKey + commit)) throw Error('recursive submodule cycle');
  opts.project ||= storeKey;
  const branch = opts.ref === 'HEAD' || opts.ref === 'worktree' ? (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() : opts.ref;
  opts.legacyAffinity = opts.affinity || `${storeKey}+${branch}`;
  opts.refFamily = branch;
  opts.affinity = opts.affinity ? `${storeKey}+${branch}+${opts.affinity}` : `${storeKey}+${branch}`;
  let files = (await git(['ls-tree', '-rz', '--name-only', commit])).split('\0').filter(Boolean);
  let untracked = [];
  if (opts.ref === 'worktree') {
    untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      // macOS AppleDouble/.DS_Store files are Finder metadata, never sources (BC-117).
      .filter(file => !/(?:^|\/)(?:\._[^/]*|\.DS_Store)$/.test(file));
    if (untracked.some(name => name.endsWith('/'))) throw Error('nested untracked repositories cannot be archived');
    files.push(...untracked, ...(await git(['diff', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean));
  }
  files = [...new Set(files)];
  if (files.some(name => sensitiveFile.test(name))) throw Error('snapshot contains credential-related paths; use a source-only ref/worktree');
  if (untracked.some(name => path.basename(name).toLowerCase() === '.npmrc')) throw Error('untracked .npmrc refused');
  if ((await git(['rev-list', '--full-history', '--max-count=1', commit, '--', ...privateHistoryPaths])).trim())
    throw Error('bundle history contains credential-related paths; use a source-only history');
  const transferId = await storeIdentity(opts.repo, undefined, state);
  await scanTransfer({ sourceRepo: opts.repo, commit, mode: opts.ref, scanId: transferId }, 'snapshot', [], state, gitEnv);
  const checker = fileURLToPath(new URL('./lib/devbox-source-check.py', import.meta.url));
  const verdict = await execute('python3', [checker, opts.repo, commit, opts.ref], { state, timeout: 300000, env: gitEnv });
  if (verdict.code && verdict.stdout.trim()) {
    const [file, key] = JSON.parse(verdict.stdout);
    throw Error('credential setting refused in ' + JSON.stringify(file) + ' (' + key + ')');
  }
  checked(verdict, 'source content check');
  if ((await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true')
    throw Error('a complete source history is required to create an incremental bundle');
  if (files.includes('.devbox-run.json')) throw Error('reserved runner manifest path in source');
  const exportRepo = path.join(temp, 'export.git');
  checked(await execute('git', ['init', '--bare', exportRepo], { state }), 'bundle staging repository');
  const objects = fs.realpathSync((await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim());
  const objectDirs = [...new Set([objects, ...parentObjects])];
  // Some locally assembled module stores borrow blobs from their superproject.
  // Make that fallback explicit in staging, never by repairing the source store.
  fs.writeFileSync(path.join(exportRepo, 'objects/info/alternates'), `${objectDirs.join('\n')}\n`);
  checked(await execute('git', ['--git-dir', exportRepo, 'update-ref', 'refs/heads/export', commit], { state }), 'bundle export ref');
  let patchFile, extra;
  if (opts.ref === 'worktree') {
    patchFile = path.join(temp, 'worktree.patch');
    checked(await execute('git', ['-C', opts.repo, 'diff', '--binary', ...(opts.submodules ? ['--ignore-submodules=all'] : []), '--no-ext-diff', '--no-textconv', 'HEAD'], { outputFile: patchFile, state }), 'worktree diff');
    if (untracked.length) {
      const list = path.join(temp, 'untracked.list'); fs.writeFileSync(list, `${untracked.join('\0')}\0`);
      extra = path.join(temp, 'untracked.tar');
      checked(await execute('tar', ['-C', opts.repo, '--null', '-T', list, '-cf', extra], { state, timeout: 300000, env: { ...process.env, COPYFILE_DISABLE: '1' } }), 'untracked archive');
    }
  }
  const modules = [];
  if (opts.submodules) {
    const links = (await git(['ls-tree', '-rz', commit])).split('\0').filter(entry => entry.startsWith('160000 commit '));
    if (links.length) {
      const config = await git(['config', '--no-includes', '--blob', commit + ':.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.path$']);
      const names = new Map(config.split('\0').filter(Boolean).map(pair => {
        const i = pair.indexOf('\n');
        return [pair.slice(i + 1), pair.slice(10, i - 5)];
      }));
      for (const entry of links) {
        const tab = entry.indexOf('\t'), relative = entry.slice(tab + 1), ref = entry.slice(14, tab);
        const name = names.get(relative);
        if (!name || !relative || relative.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) throw Error('invalid pinned submodule path');
        const repo = path.join(opts.repo, relative);
        if (!fs.existsSync(repo) || fs.realpathSync(repo) !== repo || !fs.existsSync(path.join(repo, '.git'))) throw Error('initialize local submodule: ' + relative);
        const child = await snapshot({ repo, ref, submodules: true }, fs.mkdtempSync(path.join(temp, 'mod-')), state, new Set([...ancestors, storeKey + commit]), objectDirs);
        const { modules: nested, ...transfer } = child;
        modules.push({ ...transfer, name, relative, parent: '' }, ...nested.map(m => ({ ...m, parent: path.posix.join(relative, m.parent) })));
      }
    }
  }
  const anchors = (await git(['rev-list', '--first-parent', '--max-count=64', commit])).trim().split('\n');
  const transferFiles = new Set(files);
  for (const mod of modules) {
    if (!mod.parent) transferFiles.delete(mod.relative);
    for (const file of mod.files) transferFiles.add(path.posix.join(mod.parent, mod.relative, file));
  }
  return { commit, anchors, storeKey, modules, untracked, files: [...transferFiles], exportRepo, patchFile, extra, temp,
    sourceRepo: opts.repo, mode: opts.ref, scanId: transferId, parentObjects };
}

function bundleDiagnostics(snapshot, args) {
  const safeEnv = new Set(['TMPDIR', 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'TMPDIR' || key.startsWith('GIT_'))
    .map(([key, value]) => [key, safeEnv.has(key) && !sensitive.test(value) ? value : '[set; value omitted]']));
  const alternateFile = path.join(snapshot.exportRepo, 'objects/info/alternates');
  const alternates = [];
  const seen = new Set();
  function inspect(file, depth = 0) {
    if (seen.has(file) || depth > 8) return;
    seen.add(file);
    try {
      const entries = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      alternates.push({ file, entries });
      for (const entry of entries) inspect(path.join(path.resolve(path.dirname(path.dirname(file)), entry), 'info/alternates'), depth + 1);
    } catch (error) { if (error.code !== 'ENOENT') alternates.push({ file, error: error.code }); }
  }
  inspect(alternateFile);
  const gitPath = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'git')).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  });
  return { command: ['git', '--git-dir', snapshot.exportRepo, ...args], gitPath: gitPath || 'unresolved',
    sourceRepo: snapshot.sourceRepo || null, cwd: process.cwd(), env, alternates };
}

export async function makeBundle(snapshot, known, state) {
  const git = args => execute('git', ['--git-dir', snapshot.exportRepo, ...args], { state, timeout: 300000 });
  const bases = [];
  for (const oid of new Set(known)) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) continue;
    if (state.cancel) throw Object.assign(Error('bundle cancelled'), { code: state.cancel });
    if ((await git(['cat-file', '-e', oid + '^{commit}'])).code) continue;
    if ((await git(['merge-base', '--is-ancestor', oid, snapshot.commit])).code === 0) bases.push('^' + oid);
  }
  // A readable commit header does not guarantee pack-objects can walk its tree.
  // Try fewer prerequisites, then a self-contained pack. Never retry cancellation.
  const plans = bases.length ? [bases] : [];
  if (bases.length > 1) plans.push(bases.slice(0, Math.floor(bases.length / 2)));
  plans.push([]);
  for (const exclusions of plans) {
    if (snapshot.scanId) {
      const scanEnv = snapshot.parentObjects?.length ? { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES:
        [process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, ...snapshot.parentObjects.map(dir => JSON.stringify(dir))].filter(Boolean).join(path.delimiter) } : process.env;
      await scanTransfer(snapshot, 'history', exclusions.map(oid => oid.slice(1)), state, scanEnv);
    }
    const file = path.join(snapshot.temp, 'transfer-' + randomUUID() + '.bundle');
    const args = ['bundle', 'create', file, 'refs/heads/export', ...exclusions];
    const result = await git(args);
    if (!result.code) return file;
    fs.rmSync(file, { force: true });
    const diagnostics = { ...bundleDiagnostics(snapshot, args), exit: result.code };
    state.onBundleFailure?.(diagnostics);
    if (state.cancel || !exclusions.length || result.code === 124) {
      try { checked(result, exclusions.length ? 'incremental bundle' : 'full bundle'); }
      catch (error) {
        error.bundleDiagnostics = diagnostics;
        error.message += '\nbundleDiagnostics=' + JSON.stringify(error.bundleDiagnostics);
        throw error;
      }
    }
  }
}

// Local short critical sections merge shared JSON without losing another shard's host/key.
async function withStateLock(file, operation, maxAttempts = 1500) {
  const lock = `${file}.lock`, owner = path.join(lock, 'owner');
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // BC-145: a holder that died (killed runner) must not block later runs.
      let holder = null, age = 0;
      try { holder = Number(fs.readFileSync(owner, 'utf8')); } catch { /* owner not written yet */ }
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      let dead = false;
      if (Number.isInteger(holder) && holder > 0) { try { process.kill(holder, 0); } catch (e) { dead = e.code === 'ESRCH'; } }
      else dead = age > 30000;
      if (dead) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* another waiter removed it */ } continue; }
      if (attempt >= maxAttempts) throw Error(`state lock busy: ${lock} held by pid ${holder ?? 'unknown'} for ${Math.round(age / 1000)}s`);
      await pause(50);
    }
  }
  try { fs.writeFileSync(owner, String(process.pid)); } catch { /* best effort */ }
  try { return await operation(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

async function mergeState(file, key, value) {
  return withStateLock(file, () => {
    let data = {}; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    data[key] = value; writeJSON(file, data);
  });
}

function dynamicMetricHosts() {
  try {
    const fd = fs.openSync(path.join(sharedDir(), 'machine.conf'), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    let conf;
    try {
      if (!fs.fstatSync(fd).isFile()) return new Set();
      conf = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
    const values = key => [...conf.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*([^\\n]*)`, 'gm'))].map(match => match[1].trim());
    const enabled = values('DEVBOX_DYNAMIC_ADMISSION'), hosts = values('DEVBOX_DYNAMIC_HOSTS');
    return new Set(conf.endsWith('\n') && enabled.length === 1 && enabled[0] === '1' && hosts.length === 1 ? hosts[0].split(',') : []);
  } catch { return new Set(); }
}

async function refreshHostMetrics(rows, state, { force = false, timeout = 15000 } = {}) {
  if (state.cancel || timeout <= 0) return;
  const enabled = dynamicMetricHosts();
  const hosts = new Map(rows.filter(row => enabled.has(row.host)).map(row => [row.host, row]));
  await Promise.all([...hosts].map(async ([host, row]) => {
    const file = path.join(sharedDir(), 'devbox-metrics', `${host}.json`);
    const requestedAt = Date.now() / 1000;
    const valid = value => Number.isInteger(value?.cores) && value.cores > 0
      && [value.load5, value.memAvailableGiB, value.freeGiB].every(item => Number.isFinite(item) && item >= 0);
    const fresh = () => {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return valid(value) && Number.isFinite(value.at) && value.at <= Date.now() / 1000
          && value.at >= requestedAt - (force ? 0 : 60);
      } catch { return false; }
    };
    if (fresh()) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await withStateLock(file, async () => {
        const deadline = requestedAt * 1000 + timeout;
        if (state.cancel || deadline <= Date.now() || fresh()) return;
        const root = await hostRoot(row, state, { deadline });
        const at = Date.now() / 1000;
        if (state.cancel || deadline <= Date.now()) return;
        const result = await ssh(row, 'metrics', { root }, { state, timeout: deadline - Date.now() });
        if (result.code) return;
        const { cores, load5, memAvailableGiB, freeGiB, ...readings } = JSON.parse(result.stdout);
        const sample = { at, cores, load5, memAvailableGiB, freeGiB };
        for (const name of ['io_some_avg10', 'io_some_avg60', 'io_full_avg10']) {
          const reading = readings[name];
          sample[name] = Number.isFinite(reading) && reading >= 0 && reading <= 100 ? reading : null;
        }
        if (valid(sample)) writeJSON(file, sample);
      }, Math.floor(timeout / 50));
    } catch {
      // Admission handles an unavailable sample using the registered static slots.
    }
  }));
}

export async function hostRoot(row, state, options = {}) {
  const cached = state?.hostRoots?.get(row.host);
  if (cached?.user === row.user && cached.until > Date.now()) return cached.root;
  const operation = () => resolveHostRoot(row, state, options);
  const root = await (state?.currentAttemptTiming?.measure('hostRoot', operation) || operation());
  if (state) (state.hostRoots ||= new Map()).set(row.host, { root, user: row.user, until: Date.now() + 60000 });
  return root;
}

async function resolveHostRoot(row, state, { deadline } = {}) {
  const cacheFile = path.join(cacheDir(), 'devbox-hosts.json');
  return withStateLock(path.join(cacheDir(), `devbox-probe-${row.host}`), async () => {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let entry = cache[row.host];
  const usable = entry?.root && entry.user === row.user && Number.isInteger(entry.cores) && entry.cores > 0;
  const age = Date.now() - Date.parse(entry?.probedAt);
  const fresh = Number.isFinite(age) && age >= 0 && age < 3600000;
  if (!usable || !fresh && !(entry.retryProbeAfter > Date.now())) {
    const timeout = Math.min(usable ? 10000 : 60000, deadline === undefined ? Infinity : deadline - Date.now());
    if (timeout <= 0) throw Error('root probe deadline expired');
    try {
      const probed = JSON.parse(checked(await ssh(row, 'probe', { user: row.user }, { state, timeout, noRetry: usable || deadline !== undefined }), 'root probe').trim());
      if (probed.user !== row.user || !Number.isInteger(probed.cores) || probed.cores < 1
          || !Number.isFinite(Date.parse(probed.probedAt)) || typeof probed.root !== 'string'
          || !probed.root.startsWith('/') || !probed.root.endsWith('/devbox-run')
          || probed.root.includes('\0') || probed.root.split('/').includes('..')) throw Error('invalid host probe facts');
      entry = probed;
      await mergeState(cacheFile, row.host, entry);
    } catch (error) {
      if (!usable || state.cancel || /permission denied|gssapi|authentication failed/i.test(error.message)) throw error;
      // Keep last-known hardware/root without renewing the observation age.
      entry = { ...entry, retryProbeAfter: Date.now() + 60000 };
      await mergeState(cacheFile, row.host, entry);
      console.error(`devbox-run: stale host probe ${row.host}; refresh unavailable, retaining last-known facts`);
    }
  }
  if (typeof entry.root !== 'string' || !entry.root.startsWith('/') || !entry.root.endsWith('/devbox-run') || entry.root.includes('\0') || entry.root.split('/').includes('..')) throw Error('invalid remote workspace root');
  return entry.root;
  }, deadline === undefined ? undefined : Math.max(1, Math.floor((deadline - Date.now()) / 50)));
}

async function prepareSeeds(opts, temp, state) {
  for (const input of opts.inputs) {
    if (!input.seed) continue;
    const local = path.resolve(opts.repo, input.seed);
    if (input.seed.startsWith('cmd:') || !fs.existsSync(local) && /\s/.test(input.seed)) {
      input.seedCommand = input.seed.replace(/^cmd:/, '');
      if (transferFindings(input.seedCommand, { dsl: true }).length) throw Error(`pre-transfer credential gate refused seed command for ${input.name}`);
      continue;
    }
    if (!fs.existsSync(local)) throw Error(`seed source missing for ${input.name}`);
    const files = [];
    const inspect = file => {
      const scopedPath=file===opts.repo || file.startsWith(opts.repo+path.sep) ? path.relative(opts.repo,file) : file;
      if (sensitiveFile.test(file) || /(?:^|\/)(?:cookies?|sessions?|login|\.npmrc|\.claude|\.trae|Library)(?:\/|$)/i.test(scopedPath)) throw Error(`private seed path refused for ${input.name}`);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('seed symlink/special file refused');
      if (stat.isDirectory()) for (const name of fs.readdirSync(file)) inspect(path.join(file,name));
      else files.push(file);
    };
    inspect(local);
    for (const file of files) {
      const bytes = fs.readFileSync(file);
      if (bytes.subarray(0,6).toString() === 'bplist') throw Error('binary plist seed needs a source-only export');
      if (!bytes.includes(0) && transferFindings(bytes.toString('utf8'), { dsl: /\.(?:gradle|kts|js|mjs|ts)$/.test(file) }).length)
        throw Error(`pre-transfer credential gate refused seed contents for ${input.name}`);
    }
    const seedRepo = path.join(temp, `seed-${input.name}`); fs.mkdirSync(seedRepo);
    fs.cpSync(local,path.join(seedRepo,'content'),{recursive:true});
    const git = async args => checked(await execute('git', ['-C',seedRepo,...args],{state}), 'seed snapshot');
    await git(['init','-q']); await git(['add','--','content']);
    await git(['-c','user.name=Devbox input','-c','user.email=devbox@example.invalid','commit','-qm','Input seed']);
    const commit = (await git(['rev-parse','HEAD'])).trim();
    await scanTransfer({sourceRepo:seedRepo,commit,mode:'HEAD',scanId:'id-'+createHash('sha256').update('seed:'+input.hash).digest('hex')},'all',[],state);
    const actual = await fingerprint(path.join(seedRepo,'content'));
    if (actual.hash !== input.hash || input.sizeGiB > 0 && actual.bytes > input.sizeGiB * GiB) throw Error(`seed hash/size mismatch for ${input.name}`);
    input.seedFile = path.join(temp, `seed-${input.name}.tar`);
    checked(await execute('tar',['-cf',input.seedFile,'-C',seedRepo,'content'],{state,env:{...process.env,COPYFILE_DISABLE:'1'}}), 'seed archive');
  }
}

function inputPath(root,input) { return input.path || `${root}/inputs/${input.name}/${input.hash}`; }
async function verifyInputs(row, inputs, opts, state, { force=false, timeout=60000, prepare }={}) {
  const settings = opts.inputSettings || inputSettings(sharedDir());
  const file = indexFile(cacheDir(),row.host); fs.mkdirSync(path.dirname(file),{recursive:true});
  // Verification holds the lock across SSH hashing; other shards wait for it (up to 20 min) and then reuse the fresh index.
  return withStateLock(file, async () => {
    const index = readIndex(cacheDir(),row.host), now=Date.now()/1000;
    const root = prepare?.data.root || await hostRoot(row,state,{deadline:Date.now()+timeout});
    const probes=[];
    for (const input of inputs) {
      const key=inputKey(input)+(input.warm?'+'+row.slot:'');
      let entry=index.inputs[key];
      if (!force && entry && (!input.path || entry.path===input.path) && Number.isFinite(entry.verifiedAt) && 0<=now-entry.verifiedAt && now-entry.verifiedAt<settings.ttlSec) continue;
      // Warm paths are only learned from successful slot receipts.
      if (input.warm && !entry) {
        let affinities={}; try { affinities=JSON.parse(fs.readFileSync(path.join(cacheDir(),'devbox-affinity.json'),'utf8')); } catch(error) {if(error.code!=='ENOENT')throw error;}
        const previous=affinities[opts.affinity] || (opts.warmCost !== undefined ? affinities[opts.legacyAffinity] : undefined);
        if(previous?.host!==row.host || previous?.slot!==row.slot || !Number.isFinite(Date.parse(previous.time)) || Date.parse(previous.time)>Date.now()+1000) continue;
        const legacyPath=JSON.parse(checked(await ssh(row,'warm-path',{root,project:opts.project,key:opts.snapshot.storeKey,slot:row.slot},{state,timeout}),'warm workspace verification'));
        if(!legacyPath) continue;
        entry={path:legacyPath,legacyAffinityAt:Date.parse(previous.time)/1000};
      }
      probes.push({...input,key,path:input.path || entry?.path || inputPath(root,input),...(entry?.legacyAffinityAt?{legacyAffinityAt:entry.legacyAffinityAt}:{})});
    }
    if (probes.length || prepare) {
      const paths = prepare ? Object.fromEntries(prepare.inputs.map(input => [input.name, input.path || index.inputs[inputKey(input)]?.path || inputPath(root, input)])) : undefined;
      const result=await ssh(row,prepare ? 'inputs-ready' : 'inputs',{root,inputs:probes,affinity:opts.affinity,
        ...(prepare ? { control: prepare.data.control, paths, defaultPaths: Object.fromEntries(prepare.inputs.map(input => [input.name, inputPath(root,input)])) } : {}),
        legacyAffinity:opts.warmCost !== undefined ? opts.legacyAffinity : undefined},{state,timeout});
      const response=JSON.parse(checked(result,'input verification'));
      const records=prepare ? response.records : response;
      if (prepare) prepare.result=response;
      for (const record of records) {
        if (!probes.some(input=>input.key===record.key)) throw Error('unexpected input verification record');
        const measuredInput = probes.find(input=>input.key===record.key);
        state.currentAttemptTiming?.addInput(measuredInput.name, 'verifySec', record.verificationSec || 0);
        if (record.present) index.inputs[record.key]={path:record.path,bytes:record.bytes,verifiedAt:Date.now()/1000,...(probes.find(input=>input.key===record.key).legacyAffinityAt?{legacyAffinityAt:probes.find(input=>input.key===record.key).legacyAffinityAt}:{})};
        else delete index.inputs[record.key];
      }
      writeJSON(file,index);
    }
    return index;
  }, 24000);
}
async function inputPlan(opts,rows,state) {
  const settings=opts.inputSettings || inputSettings(sharedDir()), indices={}, holds={}, durations={};
  // BC-147: host-level inputs are verified once per host (hosts in parallel), not once per slot;
  // only per-slot warm inputs are checked for the remaining slots of a host.
  const byHost=new Map(); for (const row of rows) byHost.set(row.host,[...(byHost.get(row.host) || []),row]);
  await Promise.all([...byHost.values()].map(async hostRows => {
    let first=true;
    for (const row of hostRows) {
      const wanted=first ? opts.placementInputs : opts.placementInputs.filter(input=>input.warm);
      if (first || wanted.length) indices[row.host]=await verifyInputs(row,wanted,opts,state,{timeout:Math.min(15000,opts.deadline-Date.now())});
      first=false;
    }
  }));
  for (const row of rows) {
    try { holds[row.slot]=Object.fromEntries(fs.readFileSync(path.join(lockPath(sharedDir(),row.slot),'info'),'utf8').trim().split('\n').map(line=>line.split('\t'))); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    const history=readTimings(opts.snapshot.storeKey);
    durations[row.slot]=history.slots?.[row.slot]?.durationSec;
  }
  const history=readTimings(opts.snapshot.storeKey).commands?.[opts.commandKey]?.placement || {};
  for(const input of opts.placementInputs)if(input.warm) input.costSec=warmCost(history,opts.warmCost) ?? input.costSec;
  const table=placement(rows,opts.placementInputs,indices,history,{...settings,holds,durations});
  const slots=Object.fromEntries(table.map(value=>[value.slot,{...value,extraDiskGiB:opts.placementInputs.filter(input=>!input.warm && value.missing.includes(input.name)).reduce((sum,input)=>sum+input.sizeGiB,0)}]));
  return {version:1,at:Date.now()/1000,slots};
}
async function seedInputs(row,data,opts,attempt,state,emit,remaining,recordRun) {
  const settings=opts.inputSettings || inputSettings(sharedDir());
  const prepare={data,inputs:opts.inputs};
  const index=await verifyInputs(row,[...opts.inputs,...(opts.placementInputs || []).filter(input=>input.warm)],opts,state,{force:true,timeout:remaining(),prepare});
  attempt.seeds=[];
  attempt.missingInputs=[...(attempt.missingInputs || []).filter(name=>name.startsWith('warm.')),...opts.inputs.filter(input=>!index.inputs[inputKey(input)]).map(input=>input.name)];
  const missingGiB=opts.inputs.filter(input=>!index.inputs[inputKey(input)]).reduce((sum,input)=>sum+input.sizeGiB,0);
  const disk=prepare.result;
  if(disk.free/GiB-missingGiB<53) throw Object.assign(Error('input workspace disk guard'),{code:72});
  for (const input of opts.inputs) {
    if (index.inputs[inputKey(input)]) continue;
    if (!input.rebuildable) throw Error(`missing non-rebuildable input ${input.name} after acquisition`);
    if (!input.seed || observedCost(input,readTimings(opts.snapshot.storeKey).commands?.[opts.commandKey]?.placement)>settings.seedMaxSec && !opts.prewarm) { state.currentAttemptTiming?.missingRebuild(input.name); continue; }
    const target=inputPath(data.root,input);
    if (input.path) throw Error('seed destinations must use the runner input store');
    const started=performance.now();
    try {
    if (input.seedFile) checked(await ssh(row,'seed',{root:data.root,path:target,hash:input.hash,sizeGiB:input.sizeGiB},{inputFile:input.seedFile,state,timeout:remaining()}),'input seed');
    else {
      const job=`mkdir -p ${quote(path.posix.dirname(target))} && DEVBOX_INPUT_PATH=${quote(target)} bash -c ${quote(input.seedCommand)}`;
      attempt.seedStarted=true;
      const result=await ssh(row,'run',{...data,command:job,env:{},seconds:remaining()/1000},{state,timeout:remaining(),onOutput:emit});
      state.currentAttemptTiming?.addInput(input.name, 'rebuildSec', (performance.now()-started)/1000);
      const cleanup=await ssh(row,'cleanup',{...data,started:true},{state,cancellable:false,timeout:35000});
      if (cleanup.code || !cleanup.stdout.includes('group-gone')) throw Error('seed command cleanup unconfirmed');
      checked(result,'input seed command');
      attempt.seedStarted=false;
      // Each supervisor control directory is single-use.
      data.control=`${data.root}/runs/${randomUUID()}`;
      recordRun();
      checked(await ssh(row,'inspect',{...data,reuseAllowed:false},{state,timeout:remaining()}),'post-seed preparation');
    }
    const verified=await verifyInputs(row,[input],opts,state,{force:true,timeout:remaining()});
    if (!verified.inputs[inputKey(input)]) throw Error(`seed hash/size mismatch for ${input.name}`);
    const seed={name:input.name,key:inputKey(input),durationSec:(performance.now()-started)/1000,path:target};
    attempt.seeds.push(seed); emit(`[shard ${opts.shard}] seeded ${input.name}; hash verified\n`);
    } finally { state.currentAttemptTiming?.addInput(input.name, 'seedSec', (performance.now()-started)/1000); }
  }
  const paths=Object.fromEntries(opts.inputs.map(input=>[input.name,index.inputs[inputKey(input)]?.path || inputPath(data.root,input)]));
  const inputMap=path.join(data.control,'inputs.json');
  if (attempt.seeds.length) checked(await ssh(row,'input-map',{...data,paths},{state,timeout:remaining()}),'post-seed input path map and disk check');
  attempt.inputPaths=paths; return inputMap;
}

function timingFile(repoId) { return path.join(cacheDir(), 'timings', `${repoId}.json`); }

function readTimings(repoId) {
  try { return JSON.parse(fs.readFileSync(timingFile(repoId), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, units: {}, commands: {} }; }
}

async function recordTimings(repoId, commandKey, shards) {
  const file = timingFile(repoId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withStateLock(file, () => {
    const history = readTimings(repoId); history.units ||= {}; history.commands ||= {}; history.slots ||= {}; history.version = 1;
    const update = (map, key, durationSec) => {
      if (!Number.isFinite(durationSec) || durationSec <= 0) return;
      const previous = map[key], samples = previous?.samples || 0;
      map[key] = { ...previous, durationSec: ((previous?.durationSec || 0) * samples + durationSec) / (samples + 1), samples: samples + 1, updatedAt: new Date().toISOString() };
    };
    for (const shard of shards) {
      const units = new Map();
      for (const attempt of shard.attempts || []) for (const record of attempt.unitTimings || []) {
        if (!record.exit) units.set(record.unit, record.durationSec);
      }
      for (const [unit, duration] of units) update(history.units, unit, duration);
    }
    for (const shard of shards) for (const attempt of shard.attempts || []) {
      const command=history.commands[commandKey] ||= {};
      const thermal=command.placement ||= {cold:[],warm:[],inputs:{}};
      for (const seed of attempt.seeds || []) {
        const observations=thermal.inputs[seed.key] ||= []; observations.push(seed.durationSec); if(observations.length>21) observations.shift();
      }
      if (attempt.exit || !attempt.returned || !attempt.commandDurationSec) continue;
      update(history.slots,attempt.slot,attempt.commandDurationSec);
      const samples=thermal[attempt.warmWorkspace?'warm':'cold'] ||= [];
      samples.push(attempt.commandDurationSec); if(samples.length>21) samples.shift();
      const cacheClass=attempt.warmWorkspace?'warm':'cold';
      const missing=attempt.missingInputs.filter(name=>attempt.declaredInputKeys?.[name] && !(attempt.seeds || []).some(seed=>seed.name===name));
      const base=thermal.baselines ||= {cold:[],warm:[]};
      const runs=thermal.rebuildRuns ||= {};
      if (!missing.length && !(attempt.seeds || []).length) {
        base[cacheClass].push(attempt.commandDurationSec); if(base[cacheClass].length>21) base[cacheClass].shift();
      } else if (missing.length===1) {
        const key=attempt.declaredInputKeys[missing[0]];
        const values=runs[key+'+'+cacheClass] ||= []; values.push(attempt.commandDurationSec); if(values.length>21) values.shift();
        if(base[cacheClass].length>=3) thermal.inputs[key]=values.map(value=>Math.max(0,value-median(base[cacheClass])));
      }

      if (attempt.warmWorkspace && thermal.cold.length && thermal.warm.length>=3) command.rebuildCostSec=warmCost(thermal);
    }
    if (shards.length && shards.every(shard => !shard.exit && !shard.skipped)) {
      update(history.commands, commandKey, shards.reduce((total, shard) => total + (shard.attempts.at(-1).commandDurationSec || 0), 0));
    }
    writeJSON(file, history);
  });
}

async function planPrewarm(opts, state) {
  const rows = runRows(opts).filter(row => eligibleSlot(opts, row));
  if (rows.some(row => !row.target)) throw Error('open pool registry row lacks an unambiguous user@ip description');
  if (!rows.length) throw Error('no open slot provides all required capabilities');
  const plans = [], blocked = quarantinedHosts(sharedDir());
  for (const [host, row] of new Map(rows.map(row => [row.host, row]))) {
    if (state.cancel || blocked.has(host) || heldSlots(sharedDir(), host).length) continue;
    const root = await hostRoot(row, state);
    const recent = JSON.parse(checked(await ssh(row, 'recent', { root, project: opts.project }, { state }), 'prewarm slot history'));
    const candidates = rows.filter(member => member.host === host && freeSlot(sharedDir(), member))
      .sort((a, b) => Number(b.slot.includes('light')) - Number(a.slot.includes('light')) || (recent[b.slot] || 0) - (recent[a.slot] || 0) || a.slot.localeCompare(b.slot));
    if (candidates.length && !heldSlots(sharedDir(), host).length && !quarantinedHosts(sharedDir()).has(host)) plans.push(candidates.map(member => member.slot));
  }
  return plans;
}

async function collectGarbage({ rows, days = 7, host, state, emit = text => process.stdout.write(text), skipSlot }) {
  let reclaimed = 0;
  for (const row of [...new Map(rows.filter(row => row.target && (!host || row.host === host)).map(row => [row.host, row])).values()]) {
    const root = await hostRoot(row, state);
    const inventory = JSON.parse(checked(await ssh(row, 'inventory', { root, days }, { state }), 'GC inventory'));
    // One extra short lease performs repo/image maintenance even with no expired trees.
    const maintenance = rows.find(member => member.host === row.host && member.slot !== skipSlot && member.slot.includes('light'))
      || rows.find(member => member.host === row.host && member.slot !== skipSlot);
    const jobs = [...inventory, ...(maintenance ? [{ slot: maintenance.slot, maintenance: true }] : [])];
    for (const item of jobs) {
      const member = rows.find(r => r.slot === item.slot && r.host === row.host);
      if (!member || item.slot === skipSlot || state.cancel) continue;
      const by = `devbox-gc-${process.pid}-${randomUUID()}`;
      const take = await executeRes(['take', member.slot, '--by', by, '--project', 'devbox-run', '--task', 'gc', '--for', 'expired worktree cleanup', '--maintenance', '--pid', String(process.pid)], { state });
      if (take.code === 2 || take.code === 3) continue;
      if (take.code) {
        try {
          const info = Object.fromEntries(fs.readFileSync(path.join(sharedDir(), 'locks', `${member.slot}.d/info`), 'utf8').trim().split('\n').map(line => line.split('\t')));
          if (info.by === by && info.pid === String(process.pid)) checked(await executeRes(['return', member.slot, '--by', by], { state, cancellable: false, timeout: 30000 }), 'interrupted GC return');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      checked(take, 'GC slot acquisition');
      let clean = true;
      const config = (state.treeSettings ||= treeSettings(sharedDir()))[row.host];
      const data = { root, ...item, slot: member.slot, days, docker: false, ...(config ? { treeConfig: config } : {}) };
      const control = `${root}/gc/${randomUUID()}`;
      try {
        // Inventory is rechecked by gc AFTER leasing. GC itself gets the same supervisor.
        checked(await ssh(row, 'inspect', { root, control, reuseAllowed: false, repository: item.repository || `${root}/repos/.gc-unused`, commit: '0'.repeat(40) }, { state }), 'GC preparation');
        const op = item.maintenance ? 'maintenance' : 'gc';
        const result = await ssh(row, 'run', { workspace: root, control, slot: member.slot, command: remoteCommand(op, treeScript(op, remoteScripts[op], pythonHeader, data), data), env: {}, seconds: 120 }, { state, timeout: 140000, onOutput: emit });
        const cleanup = await ssh(row, 'cleanup', { control, started: true }, { state, cancellable: false, timeout: 35000 });
        clean = cleanup.code === 0 && cleanup.stdout.includes('group-gone');
        if (!clean) throw Error(`BLOCKED: GC cleanup unconfirmed; retaining ${member.slot}`);
        checked(result, 'GC');
        for (const line of result.stdout.split('\n')) { try { reclaimed += JSON.parse(line).reclaimedBytes || 0; } catch {} }
      } finally {
        if (clean) checked(await executeRes(['return', member.slot, '--by', by], { state, cancellable: false, timeout: 30000 }), 'GC slot return');
      }
    }
  }
  emit(`reclaimedGiB=${(reclaimed / GiB).toFixed(3)}\n`);
  return reclaimed;
}

function cancellationState(values = []) {
  const state = { children: new Set(), cancel: 0, values: values.filter(value => value.length >= 6).sort((a, b) => b.length - a.length) };
  state.stop = code => { state.cancel ||= code; for (const signalChild of state.children) signalChild('SIGTERM'); };
  return state;
}

// Queue/preparation time is cumulative across retries; each command gets a fresh budget.
export function runBudgets(opts, stop, now = Date.now, schedule = setTimeout, unschedule = clearTimeout) {
  let queueLeft = opts.queueTimeout * 60000, queueSince, timer, expiredBudget;
  const expire = budget => { expiredBudget = budget; stop(budget === 'queue-transfer' ? 125 : 124); };
  const clear = () => { unschedule(timer); timer = undefined; };
  return {
    get expiredBudget() { return expiredBudget; },
    queue() {
      clear(); queueSince = now();
      timer = schedule(() => expire('queue-transfer'), Math.max(0, queueLeft));
      return queueSince + queueLeft;
    },
    remaining() { return Math.max(1, queueLeft - (queueSince === undefined ? 0 : now() - queueSince)); },
    command() {
      if (expiredBudget) return false;
      if (queueSince !== undefined) { queueLeft -= now() - queueSince; queueSince = undefined; }
      clear();
      if (queueLeft <= 0) { expire('queue-transfer'); return false; }
      // The remote supervisor enforces the exact command deadline. Allow it to reap
      // children and publish its recorded exit before the local watchdog fires.
      timer = schedule(() => expire('command'), opts.timeout * 60000 + 15000);
      return true;
    },
    finish() {
      if (queueSince !== undefined) { queueLeft -= now() - queueSince; queueSince = undefined; }
      clear();
    },
  };
}

export function commandOutcome(exit, expiredBudget, signal, started = true) {
  if (expiredBudget === 'queue-transfer') return { outcome: 'queue-transfer-timeout', expiredBudget,
    message: 'queue/transfer limit reached; command did not get its budget' };
  if (exit === 124 || expiredBudget === 'command') return { outcome: 'command-timeout', expiredBudget: 'command', message: 'command timed out (--timeout command budget)' };
  if (signal || [129, 130, 143].includes(exit)) return { outcome: 'cancelled', message: `command cancelled (exit=${exit}${signal ? ` signal=${signal}` : ''})` };
  if (!started && exit !== 0) return { outcome: 'preparation-failed', message: `command did not start; preparation exit=${exit}` };
  return { outcome: exit === 0 ? 'success' : 'command-failed', message: exit === 0 ? 'command succeeded (exit=0)' : `command failed (exit=${exit})` };
}

async function shard(opts) {
  const state = cancellationState(Object.values(opts.env));
  state.treeSettings = treeSettings(sharedDir());
  state.sshStartDelay = (opts.shard - 1) * (500 + Math.floor(Math.random() * 1001));
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const [signal, code] of Object.entries(signals)) process.on(signal, () => state.stop(code));
  const parentWatch = setInterval(() => { try { process.kill(opts.parentPid, 0); } catch { state.stop(143); } }, 1000);
  const started = Date.now();
  const budgets = runBudgets(opts, code => state.stop(code));
  const command = opts.command.replaceAll('{shards}', String(opts.shards)).replaceAll('{shard}', String(opts.shard));
  const by = `${opts.task}-s${opts.shard}-${process.pid}`;
  const recordRun = (row, data) => {
    const hold = readHold(row);
    if (!hold || hold.fields.by !== by || hold.fields.pid !== String(process.pid)) throw Error('slot ownership changed before remote preparation');
    writeJSON(path.join(sharedDir(), 'devbox-run-holds', row.slot + '.json'), { runId: opts.runId, slot: row.slot, holder: hold.fields, workspace: data.workspace, control: data.control });
    // Refresh on seed supervisor rotation as well as initial preparation.
    writeJSON(path.join(opts.out, `active-${opts.shard}.json`), { runId: opts.runId, slot: row.slot,
      retainedRun: { control: data.control, root: data.root, target: row.target, by, pid: process.pid } });
  };
  const log = path.join(opts.out, `shard-${opts.shard}.log`);
  const fd = fs.openSync(log, 'wx', 0o600);
  let logFailed = false;
  process.stdout.on('error', () => state.stop(143));
  const emit = line => {
    if (!logFailed) try { fs.writeSync(fd, line); } catch { logFailed = true; state.stop(74); }
    if (!process.stdout.destroyed) process.stdout.write(line);
  };
  const attempts = []; let firstFailure = 0, diskRetries = 0, reruns = 0, avoid;
  const failedSlots = new Set(), diskHosts = new Set();
  let softExclusionsDropped;
  const remaining = () => budgets.remaining();
  const stateFile = path.join(opts.out, `shard-${opts.shard}-state.json`);
  const resEvents = [];
  const runRes = (args, cleanup = false) => executeRes(args, {
    state, cancellable: !cleanup, timeout: cleanup ? 30000 : remaining(), rawCapture: true,
    interceptStdout: line => {
      if (line.startsWith('placement=') && state.currentAttempt) {
        try { (state.currentAttempt.placementDecisions ||= []).push(JSON.parse(line.slice(10))); } catch { state.stop(74); }
      }
      const slot = /^slot=(devbox-cn-(?:\d+|light(?:-\d+)?))$/.exec(line)?.[1];
      if (slot) state.reportedSlot = slot;
      return false;
    },
    onOutput: (text, stream) => {
      const time = new Date().toISOString(), message = text.trimEnd();
      const kind = /^slot=/.test(message) ? 'slot' : /\b(waiter-start|rollback|return|ack)\b/.exec(message)?.[1] || 'progress';
      const event = { time, operation: args[0], stream, kind, message: message.slice(0, 2000) };
      resEvents.push(event);
      if (resEvents.length > 500) resEvents.splice(10, 1);
      emit(`[${time}] [shard ${opts.shard}] res ${args[0]} ${stream}: ${message}\n`);
      try {
        writeJSON(stateFile, { shard: opts.shard, updatedAt: time, status: cleanup ? 'returning' : 'acquiring', reportedSlot: state.reportedSlot || null, resEvents });
      } catch { state.stop(74); }
    },
  });
  async function release(slot) {
    const treeLease = state.treeLeases?.get(slot);
    if (treeLease) {
      try { checked(await ssh(treeLease.row, 'tree-release', { root: treeLease.root, slot, owner: treeLease.owner },
        { state, cancellable: false, timeout: 10000 }), 'tree reservation return'); }
      catch { emit(`[shard ${opts.shard}] tree reservation release unconfirmed for ${slot}; conservative reserve retained\n`); }
      state.treeLeases.delete(slot);
    }
    checked(await runRes(['return', slot, '--by', by], true), `return ${slot}`);
  }
  try {
    while (!state.cancel) {
      opts.deadline = budgets.queue();
      const attempt = { slot: null, host: null, exit: 1, durationSec: 0, log, returned: false };
      const attemptStart = Date.now(); let row, data, prepared = false, launched = false, clean = true;
      const phases = attemptTiming(); state.currentAttemptTiming = phases;
      attempt.phaseTimings = phases.data;
      for (const input of opts.inputs) phases.addInput(input.name, 'verifySec', 0);
      attempts.push(attempt); state.currentAttempt=attempt;
      state.onBundleFailure = diagnostics => {
        (attempt.bundleFailures ||= []).push(diagnostics);
        emit(`[shard ${opts.shard}] bundleFailure=${JSON.stringify(diagnostics)}\n`);
      };
      try {
        let rows = runRows(opts);
        if (!rows.length) throw Error('no open slots in pool');
        const eligible = item => hasCapabilities(opts, item) && (!opts.prewarmSlots || opts.prewarmSlots.includes(item.slot));
        const callerAllows = item => softExclusionsDropped || eligibleSlot(opts, item);
        rows = rows.filter(eligible);
        if (!rows.length) throw Error('no open slot provides all required capabilities');
        // Bad descriptions must not cause a lease or an implicit local-user SSH login.
        if (rows.some(item => !item.target)) throw Error('open pool registry row lacks an unambiguous user@ip description');
        const retryHosts = new Set(diskHosts);
        const mayRetry = item => !failedSlots.has(item.slot) && !retryHosts.has(item.host);
        if (avoid && rows.some(item => item.host !== avoid.host && callerAllows(item) && mayRetry(item))) retryHosts.add(avoid.host);
        const internalChoices = rows.filter(mayRetry);
        const choices = internalChoices.filter(callerAllows);
        const possible = opts.splitExclusions && !opts.prewarm ? internalChoices : choices;
        if (!possible.length) throw Error('no open slot meets the requested placement constraints');
        let affinities = {}; try { affinities = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'devbox-affinity.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        let affinity = affinities[opts.affinity];
        if (affinity?.project !== opts.project || affinity?.repository !== opts.snapshot.storeKey || affinity?.refFamily !== opts.refFamily) affinity = undefined;
        if (affinity) {
          const candidate = possible.find(item => item.slot === affinity.slot && item.host === affinity.host);
          if (candidate) {
            const root = await hostRoot(candidate, state, { deadline: opts.deadline });
            const workspace = JSON.parse(checked(await ssh(candidate, 'warm-path', { root, project: opts.project,
              key: opts.snapshot.storeKey, slot: candidate.slot, affinity: opts.affinity }, { state, timeout: Math.min(10000, remaining()) }), 'affinity workspace verification'));
            if (!workspace) {
              const file = path.join(cacheDir(), 'devbox-affinity.json');
              await withStateLock(file, () => {
                const current = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (current[opts.affinity]?.time === affinity.time && current[opts.affinity]?.slot === affinity.slot) {
                  current[opts.affinity] = { ...current[opts.affinity], verifiedWorkspace: false }; writeJSON(file, current);
                }
              });
              affinity = undefined;
            }
          } else affinity = undefined;
        }
        const affinitySlot = opts.preferSlot || affinity?.slot;
        const preferred = avoid ? (possible.find(item => item.host !== avoid.host) || possible[0]).host : opts.preferHost || affinity?.host;
        const common = ['--by', by, '--project', opts.project, '--task', opts.task, '--for', opts.task, '--pid', String(process.pid)];
        const placementFile=path.join(opts.out,`shard-${opts.shard}-placement.json`);
        const inputRows=()=>runRows(opts).filter(eligible).filter(mayRetry).filter(item=>(opts.splitExclusions && !opts.prewarm || callerAllows(item)) && !quarantinedHosts(sharedDir()).has(item.host));
        const refresh = async () => {
          try { opts.inputSettings=inputSettings(sharedDir()); attempt.inputConfigWarned=false; }
          catch(error) {
            if(!opts.inputSettings) throw error;
            if(!attempt.inputConfigWarned) emit(`[shard ${opts.shard}] invalid machine.conf reload; keeping last-good input settings\n`);
            attempt.inputConfigWarned=true;
          }
          await phases.measure('metricsRefresh', () => refreshHostMetrics(possible, state, { timeout: Math.min(15000, remaining()) }));
          if (opts.pool === 'devbox-cn' && heavyStaleEnabled()) {
            for (const candidate of possible) {
              if (state.cancel || remaining() < 15000) break;
              try { await confirmDeadSlot(candidate, state); }
              catch (error) {
                if (/permission denied|gssapi|authentication failed/i.test(error.message)) throw error;
                emit(`[shard ${opts.shard}] stale cleanup unconfirmed for ${candidate.slot}; retaining hold\n`);
              }
            }
          }
          if (opts.placementInputs.length) {
            const plan=await phases.measure('inputPlacement', () => inputPlan(opts,inputRows(),state));
            attempt.inputPlan=plan;
            if (!Object.values(plan.slots).some(value=>value.eligible)) {
              emit(`[shard ${opts.shard}] input placement=${JSON.stringify(plan)}\n`);
              throw Error('no eligible host: '+Object.values(plan.slots).flatMap(value=>value.hardReasons).join('; '));
            }
            writeJSON(placementFile,plan);
          }
        };
        await refresh();
        const treeInventory = {};
        for (const [host, candidate] of new Map(possible.filter(item => state.treeSettings[item.host]).map(item => [item.host, item]))) {
          const root = await hostRoot(candidate, state, { deadline: opts.deadline });
          treeInventory[host] = JSON.parse(checked(await ssh(candidate, 'tree-list', { root,
            slots: possible.filter(item => item.host === host).map(item => item.slot) }, { state, timeout: remaining() }), 'tree affinity inventory'));
        }
        const treeHint = !opts.preferSlot && treePreference(choices.filter(item => state.treeSettings[item.host]
          && freeSlot(sharedDir(), item) && !quarantinedHosts(sharedDir()).has(item.host)), treeInventory, opts.project, opts.snapshot.storeKey, preferred);
        if (treeHint) {
          attempt.treeAffinity = { ...treeHint, applied: opts.preferSlotSupported };
          emit(`[shard ${opts.shard}] tree affinity=${JSON.stringify(attempt.treeAffinity)} (soft res hint)\n`);
        }
        const diskCosts = {};
        if (opts.diskCostsSupported) for (const [host, candidate] of new Map(possible.map(item => [item.host, item]))) {
          const root = await hostRoot(candidate, state, { deadline: opts.deadline });
          const present = treeInventory[host]
            ? treeInventory[host].filter(item => item.project === opts.project && item.store === opts.snapshot.storeKey).map(item => item.slot)
            : JSON.parse(checked(await ssh(candidate, 'workspaces', { root, project: opts.project, key: opts.snapshot.storeKey,
              slots: possible.filter(item => item.host === host).map(item => item.slot) }, { state, timeout: remaining() }), 'workspace disk inventory'));
          for (const slot of present) if (possible.some(item => item.host === host && item.slot === slot)) diskCosts[slot] = 0;
          const retained = JSON.parse(checked(await ssh(candidate, 'retained-disk', { root }, { state, timeout: remaining() }), 'retained disk inventory'));
          for (const [slot, bytes] of Object.entries(retained)) if (bytes > 0 && possible.some(item => item.host === host && item.slot === slot))
            diskCosts[slot] = (diskCosts[slot] ?? 20) + bytes / GiB;
        }
        const diskCostFile = path.join(opts.out, `shard-${opts.shard}-disk-costs.json`);
        if (opts.diskCostsSupported) writeJSON(diskCostFile, diskCosts);
        const diskArgs = opts.diskCostsSupported ? ['--disk-gib-file', diskCostFile] : [];
        attempt.diskCosts = diskCosts;
        const args = ['wait-pool', opts.pool, ...common, '--timeout', String(remaining() / 60000), ...diskArgs, ...(opts.placementInputs.length ? ['--placement-file',placementFile] : [])];
        if (opts.warmFamilySupported) args.push('--warm-family', opts.refFamily);
        const callerSlots = softExclusionsDropped ? [] : opts.excludeSlot;
        const callerHosts = softExclusionsDropped ? [] : opts.excludeHost;
        if (opts.splitExclusions) {
          if (failedSlots.size) args.push('--hard-exclude-slot', [...failedSlots].join(','));
          if (retryHosts.size) args.push('--hard-exclude-host', [...retryHosts].join(','));
          if ((callerSlots.length || callerHosts.length) && opts.excludeReason) args.push('--exclude-reason', opts.excludeReason);
        }
        const skipSlots = opts.splitExclusions ? callerSlots : [...new Set([...callerSlots, ...failedSlots])];
        const skipHosts = opts.splitExclusions ? callerHosts : [...new Set([...callerHosts, ...retryHosts])];
        if (opts.excludeSlotSupported && skipSlots.length) args.push('--exclude-slot', skipSlots.join(','));
        if (opts.excludeHostSupported && skipHosts.length) args.push('--exclude-host', skipHosts.join(','));
        if (preferred && opts.preferSupported) args.push('--prefer-host', preferred);
        if (opts.needSupported && opts.need.length) args.push('--need', opts.need.join(','));
        const warm = choices.find(item => item.slot === affinitySlot && (opts.preferSlot || item.host === preferred));
        if (opts.preferSlotSupported && (opts.preferSlot || treeHint || warm)) args.push('--prefer-slot', opts.preferSlot || treeHint?.slot || warm.slot);
        let acquire;
        const preferredSlots = opts.preferSlotSupported ? [] : warm ? [warm] : !opts.preferSupported ? choices.filter(item => item.host === preferred) : [];
        if (opts.prewarm) {
          const candidates = opts.prewarmSlots.map(slot => choices.find(item => item.slot === slot)).filter(Boolean);
          for (const candidate of candidates) {
            if (quarantinedHosts(sharedDir()).has(candidate.host) || heldSlots(sharedDir(), candidate.host).length) break;
            const inputScore=attempt.inputPlan?.slots[candidate.slot];
            if (inputScore && !inputScore.eligible) continue;
            const prewarmArgs=[...diskArgs,...(inputScore ? ['--extra-disk-gib',String(inputScore.extraDiskGiB)] : [])];
            const take = await runRes(['take', candidate.slot, ...common, ...prewarmArgs]);
            if (!take.code) { acquire = { ...take, stdout: `slot=${candidate.slot}\n` }; break; }
            if (take.code !== 2 && take.code !== 3) checked(take, 'prewarm slot acquisition');
          }
          if (!acquire) { attempt.skipped = true; attempt.exit = 0; emit(`[shard ${opts.shard}] prewarm skipped: host is busy\n`); break; }
        } else if (!avoid && !opts.placementInputs.length) for (const candidate of preferredSlots) {
          const take = await runRes(['take', candidate.slot, ...common, ...diskArgs]);
          if (!take.code) { acquire = { ...take, stdout: `slot=${candidate.slot}\n` }; break; }
          if (take.code !== 2 && take.code !== 3) checked(take, 'affinity slot acquisition');
        }
        if (!acquire) {
          let refreshing;
          const timer = setInterval(() => {
            if (!refreshing) refreshing = refresh().catch(error=>{attempt.placementError=error.message; state.stop(74);}).finally(() => { refreshing = null; });
          }, heavyStaleEnabled() ? 30000 : 60000);
          try { acquire = await runRes(args); }
          finally { clearInterval(timer); await refreshing; }
        }
        const dropped = /^softExclusionsDropped=(\{.*\})$/m.exec(acquire.stdout);
        if (opts.splitExclusions && dropped) softExclusionsDropped = attempt.softExclusionsDropped = JSON.parse(dropped[1]);
        const match = /^slot=(\S+)$/m.exec(acquire.stdout);
        if (match) attempt.slot = match[1];
        checked(acquire, 'slot acquisition');
        if (!attempt.slot) throw Error('res did not return slot=');
        rows = runRows(opts);
        row = rows.find(item => item.slot === attempt.slot);
        if (!row?.target) throw Error('acquired slot is no longer an open mapped pool member');
        if (!eligible(row) || !callerAllows(row) || !mayRetry(row)) {
          await release(row.slot); attempt.slot = null;
          if (opts.prewarm) { attempt.returned = true; attempt.skipped = true; attempt.exit = 0; break; }
          // Old controllers have no preference/exclusion flag. Keep arbitration in res.
          row = choices.find(item => avoid && item.host !== avoid.host) || choices[0];
          if (!row) throw Error('no alternate slot meets the requested placement constraints');
          const result = await runRes(['wait', row.slot, ...common, ...diskArgs, '--timeout', String(remaining() / 60000)]);
          if (!result.code) attempt.slot = row.slot;
          checked(result, 'alternate slot acquisition');
        }
        attempt.host = row.host;
        phases.phase('sourceTransferIn');
        attempt.missingInputs=attempt.inputPlan?.slots[row.slot]?.missing || [];
        attempt.declaredInputKeys=Object.fromEntries(opts.inputs.map(input=>[input.name,inputKey(input)]));
        if (opts.prewarm && (quarantinedHosts(sharedDir()).has(row.host) || heldSlots(sharedDir(), row.host).some(member => member.slot !== row.slot))) {
          attempt.skipped = true; attempt.exit = 0; emit(`[shard ${opts.shard}] prewarm skipped: host became busy\n`); break;
        }
        if (state.cancel) throw Object.assign(Error('cancelled'), { code: state.cancel });
        emit(`[shard ${opts.shard}] slot=${row.slot} host=${row.host}\n`);
        const root = await hostRoot(row, state);
        const storeName = checked(await ssh(row, 'store', { root, project: opts.project, key: opts.snapshot.storeKey, legacy: opts.repoName, anchors: opts.snapshot.anchors }, { state }), 'resolve shared store').trim();
        let workspace = `${root}/wt/${opts.project}/${storeName}/${row.slot}`;
        const repository = `${root}/repos/${opts.project}/${storeName}`;
        attempt.repository = repository;
        let tree;
        if (state.treeSettings[row.host] && storeName.startsWith('id-')) {
          const own = readHold(row);
          if (!own || own.fields.by !== by || own.fields.pid !== String(process.pid)) throw Error('slot ownership changed before tree placement');
          const heldTreeOwners = Object.fromEntries(heldSlots(sharedDir(), row.host).map(member => {
            const hold = readHold(member);
            return [member.slot, hold ? createHash('sha256').update(hold.text).digest('hex') : null];
          }));
          (state.treeLeases ||= new Map()).set(row.slot, { row, root, owner: heldTreeOwners[row.slot] });
          tree = JSON.parse(checked(await phases.measure('treePlacement', () => ssh(row, 'tree-place', { root,
            project: opts.project, store: storeName, slot: row.slot, heldTreeOwners }, { state, timeout: remaining() })), 'tree placement'));
          workspace = tree.workspace;
          Object.assign(attempt, tree); Object.assign(phases.data, tree);
          emit(`[shard ${opts.shard}] tree placement=${JSON.stringify(tree)}\n`);
        }
        data = { root, workspace, repository, slot: row.slot, runId: opts.runId, ...(tree || state.treeSettings[row.host] ? { treeConfig: tree ? state.treeSettings[row.host] : null, ...tree } : {}), dataInputPaths: opts.inputs.filter(input=>input.path).map(input=>input.path), job: `${opts.project}/${opts.task}`, affinity:opts.affinity, previousJob:previousSlotJob(row.slot,by), control: `${root}/runs/${randomUUID()}`, commit: opts.snapshot.commit, untracked: opts.snapshot.untracked };
        data.modules = opts.snapshot.modules.map(mod => ({ repository: `${root}/repos/submodules/${mod.storeKey}`, commit: mod.commit, parent: mod.parent, relative: mod.relative }));
        data.reuseAllowed = !opts.snapshot.extra && !(opts.snapshot.patchFile && fs.statSync(opts.snapshot.patchFile).size) && !opts.snapshot.untracked.length;
        recordRun(row, data);
        let inspection = JSON.parse(checked(await phases.measure('inspect', () => ssh(row, 'inspect', data, { state, timeout: Math.min(60000, remaining()) })), 'workspace inspection'));
        if (inspection.free < 73 * GiB) {
          await collectGarbage({ rows: [...readRegistry(sharedDir(), 'devbox-cn'), ...readRegistry(sharedDir(), 'devbox-cn-light')], host: row.host, state, emit, skipSlot: row.slot });
          inspection = JSON.parse(checked(await ssh(row, 'inspect', { ...data, reuseAllowed: false }, { state }), 'disk recheck'));
        }
        if (inspection.free < 53 * GiB) {
          attempt.diskGuard = true; emit(`[shard ${opts.shard}] disk guard refused ${row.host}: need 53 GiB free\n`);
          throw Object.assign(Error('workspace disk guard'), { code: 72 });
        }
        attempt.warmWorkspace=opts.placementInputs.some(input=>input.warm) ? !attempt.missingInputs.some(name=>name.startsWith('warm.')) : inspection.present && Object.hasOwn(diskCosts,row.slot);
        prepared = true;
        attempt.checkoutSkipped = Boolean(inspection.sameRefClean);
        for (let uploadTry = 0; ; uploadTry++) {
          try {
            if (uploadTry) inspection = JSON.parse(checked(await ssh(row, 'inspect', data, { state }), 'retry inspection'));
            const feed = async (source, target, info, counter) => {
              if (info.present) return;
              const bundle = await phases.measure('bundleCreation', () => makeBundle(source, info.known, state));
              attempt[counter] = (attempt[counter] || 0) + fs.statSync(bundle).size;
              try { checked(await phases.measure('bundleUpload', () => ssh(row, 'bundle', target, { inputFile: bundle, state, timeout: remaining() })), 'bundle upload'); }
              finally { fs.unlinkSync(bundle); }
            };
            await feed(opts.snapshot, data, inspection, 'bundleBytes');
            if (inspection.sameRefClean) break;
            const checkout=await phases.measure('checkout', () => ssh(row, 'checkout', data, { state, timeout: remaining() }));
            checked(checkout,'worktree checkout');
            const hygiene=checkout.stdout.trim();
            if (hygiene) { attempt.slotHygiene=JSON.parse(hygiene); emit(`[shard ${opts.shard}] slot hygiene=${hygiene}\n`); }
            if (opts.snapshot.patchFile && fs.statSync(opts.snapshot.patchFile).size) checked(await phases.measure('patch', () => ssh(row, 'patch', data, { inputFile: opts.snapshot.patchFile, state, timeout: remaining() })), 'worktree patch');
            if (opts.snapshot.extra) checked(await phases.measure('overlay', () => ssh(row, 'upload', data, { inputFile: opts.snapshot.extra, state, timeout: remaining() })), 'untracked upload');
            for (const mod of opts.snapshot.modules) {
              const target = { ...data, repository: `${root}/repos/submodules/${mod.storeKey}`, commit: mod.commit,
                relative: mod.relative, parent: mod.parent, name: mod.name };
              const info = inspection.modules[opts.snapshot.modules.indexOf(mod)];
              await feed(mod, target, info, 'submoduleBundleBytes');
              checked(await phases.measure('submoduleCheckout', () => ssh(row, 'submodule', target, { state, timeout: remaining() })), 'offline submodule update');
            }
            break;
          } catch (error) {
            if (state.cancel || uploadTry || !/broken pipe|message authentication code incorrect|corrupted mac/i.test(error.message)) throw error;
            emit(`[shard ${opts.shard}] retrying interrupted upload on a fresh connection\n`);
            await closeControlConnections(state);
          }
        }
        // Transfers can consume substantial space; check again before launching work.
        const ready = inspection.sameRefClean ? inspection : JSON.parse(checked(await phases.measure('postUploadInspect', () => ssh(row, 'inspect', { ...data, reuseAllowed: false }, { state, timeout: Math.min(60000, remaining()) })), 'post-upload disk check'));
        if (ready.free < 53 * GiB) {
          attempt.diskGuard = true;
          emit(`[shard ${opts.shard}] disk guard refused ${row.host} after upload: need 53 GiB free\n`);
          throw Object.assign(Error('post-upload workspace disk guard'), { code: 72 });
        }
        await mergeState(path.join(cacheDir(), 'devbox-affinity.json'), opts.affinity, { host: row.host, slot: row.slot,
          project: opts.project, repository: opts.snapshot.storeKey, refFamily: opts.refFamily, verifiedWorkspace: true, time: new Date().toISOString() });
        if (state.cancel) throw Object.assign(Error('cancelled'), { code: state.cancel });
        const hosts = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'devbox-hosts.json'), 'utf8'));
        Object.assign(attempt, cpuBudget(sharedDir(), row.host, hosts[row.host]?.cores));
        emit(`[shard ${opts.shard}] cpus=${attempt.cpus} cores=${attempt.hostCores} heavyHolders=${attempt.heavyHolders}\n`);
        phases.phase('inputPreparation');
        const inputMap=opts.inputs.length ? await seedInputs(row,data,opts,attempt,state,emit,remaining,() => recordRun(row, data)) : null;
        let job = opts.units ? remoteCommand('units', remoteScripts.units, { control: data.control, command, units: opts.units }) : command;
        if (opts.prewarm) job = `nice -n 10 bash -c ${quote(job)}`;
        launched = true;
        const caches = { GRADLE_USER_HOME: `${root}/shared/gradle`, npm_config_cache: `${root}/shared/npm`, PNPM_STORE_DIR: `${root}/shared/pnpm`, CCACHE_DIR: `${root}/shared/ccache`, CCACHE_MAXSIZE: '20G', PIP_CACHE_DIR: `${root}/shared/pip`, DEVBOX_TOOLCHAINS: `${root}/shared/toolchains` };
        const commandStart = Date.now();
        const commandMarker = `DEVBOX_COMMAND_STARTED_${path.posix.basename(data.control)}`;
        const result = await ssh(row, 'run', { ...data, stream: true, command: job, commandMarker, cpus: attempt.cpus, env: { ...caches, ...opts.env, ...cpuEnvironment(attempt.cpus), DEVBOX_RUN_RECEIPT: `${workspace}/.devbox-run.json`, ...(inputMap?{DEVBOX_INPUTS_FILE:inputMap,DEVBOX_INPUTS_DIR:`${root}/inputs`}:{}) }, seconds: opts.timeout * 60 }, {
          state, timeout: remaining(), onOutput: emit, deferOutputEnd: true,
          onStdoutLine: line => {
            const cleanup = /^DEVBOX_DATA_CLEANUP=(\{[^\n]*\})$/.exec(line);
            if (cleanup) {
              try { const record = JSON.parse(cleanup[1]); if (Array.isArray(record.entries) && Number.isFinite(record.bytes) && record.bytes >= 0) attempt.dataCleanup = record; } catch { /* Cleanup telemetry cannot fail a command. */ }
            }
            if (line !== commandMarker || attempt.commandStarted) return;
            if (!budgets.command()) return;
            attempt.commandStarted = true;
            attempt.commandBudgetSec = opts.timeout * 60;
            phases.phase('remoteCommand');
            return opts.timeout * 60000 + 15000;
          },
          interceptStdout: line => line === commandMarker,
        });
        attempt.commandDurationSec = (Date.now() - commandStart) / 1000;
        const loginFailure = result.code === 255 && !result.sshStarted && /permission denied|gssapi|authentication failed/i.test(result.stderr);
        if (result.code === 255 && !loginFailure) { attempt.sshDropped = true; attempt.sshExit = result.code; }
        attempt.exit = state.cancel || result.code;
        attempt.commandExit = result.code;
        if (result.signal) attempt.commandSignal = result.signal;
        if (result.code === 72 && /(?:^|\n)DEVBOX_LAUNCH_DISK_GUARD(?:\n|$)/.test(result.stderr)) attempt.diskGuard = true;
        if (attempt.sshDropped) {
          const recoveredExit = await recoverRunResult(row, data, state, result.stdoutBytes, emit, result.stdoutPrivateBlockOpen, result.stdoutSink);
          if (recoveredExit !== null) {
            attempt.exit = state.cancel || recoveredExit;
            attempt.commandExit = recoveredExit;
            attempt.sshDropRecovered = true;
            emit(`[shard ${opts.shard}] SSH drop recovered: recorded remote exit=${recoveredExit}\n`);
          } else {
            attempt.reason = 'ssh-drop-unconfirmed';
            emit(`[shard ${opts.shard}] ssh-drop-unconfirmed: recorded remote exit unavailable\n`);
          }
        }
        if (result.infraFailure) attempt.infraFailure = true;
        else if (loginFailure) attempt.authenticationBlocked = true;
      } catch (error) {
        attempt.exit = state.cancel || error.code || 1; attempt.error = error.message;
        if (error.bundleDiagnostics) attempt.bundleDiagnostics = error.bundleDiagnostics;
        if (error.infraFailure) attempt.infraFailure = true;
        else if (/permission denied|gssapi|authentication failed/i.test(error.message)) attempt.authenticationBlocked = true;
        emit(`[shard ${opts.shard}] ${error.message}\n`);
      } finally {
        // Execution has ended; readback has its own bounded connection budgets.
        budgets.finish();
        Object.assign(attempt, commandOutcome(state.cancel || (attempt.commandExit ?? attempt.exit), budgets.expiredBudget, attempt.commandSignal, launched));
        // A recovered receipt establishes command execution even if its start marker
        // was lost with the stream. Deadline status always outranks transport status.
        if (budgets.expiredBudget) attempt.exit = budgets.expiredBudget === 'queue-transfer' ? 125 : 124;
        emit(`[shard ${opts.shard}] ${attempt.message}\n`);
        phases.phase('cleanup');
        if (data && prepared) {
          if (attempt.sshDropped) {
            const recovery = await reconnectRun(row, data, state);
            clean = recovery === 'group-gone';
            attempt.sshRecovery = recovery;
            if (clean) emit(`[shard ${opts.shard}] SSH reconnected and confirmed remote cleanup\n`);
            else {
              attempt.remoteJobStillRunning = recovery === 'group-running';
              attempt.retainedRun = { control: data.control, root: data.root, target: row.target, by, pid: process.pid };
              attempt.stopCommand = `${quote(process.execPath)} ${quote(script)} stop --out ${quote(opts.out)} --run-id ${opts.runId}`;
            }
          } else if (attempt.authenticationBlocked) {
            clean = false;
          } else {
            const cleanup = await ssh(row, 'cleanup', { ...data, started: launched || attempt.seedStarted }, { cancellable: false, state, timeout: 35000 });
            clean = cleanup.code === 0 && cleanup.stdout.includes('group-gone');
          }
          if (!clean) {
            attempt.retainedRun ||= { control: data.control, root: data.root, target: row.target, by, pid: process.pid };
            attempt.stopCommand ||= `${quote(process.execPath)} ${quote(script)} stop --out ${quote(opts.out)} --run-id ${opts.runId}`;
            attempt.cleanupUnconfirmed = true;
            attempt.exit ||= 70;
            try {
              await recordCleanupPending(row,data,opts.runId);
              attempt.cleanupPending = path.join(sharedDir(),'devbox-cleanup-pending',row.slot+'.json');
            } catch (error) {
              attempt.pendingMarkerError = error.message;
              emit(`[shard ${opts.shard}] BLOCKED: cleanup pending marker could not be saved; retain owned hold: ${error.message}\n`);
            }
            if (opts.retainRemoteSupported) {
              const retained = await runRes(['retain-remote', attempt.slot, '--by', by, '--pid', String(process.pid)], true);
              if (retained.code) {
                attempt.retentionError = retained.stderr.trim() || `res exit ${retained.code}`;
                emit(`[shard ${opts.shard}] could not protect held slot from stale reclaim: ${attempt.retentionError}\n`);
              }
            }
            if (attempt.retainedRun) {
              try {
                writeJSON(path.join(opts.out, `retained-${opts.shard}.json`), { runId: opts.runId, slot: attempt.slot, retainedRun: attempt.retainedRun });
              } catch (error) {
                attempt.receiptError = error.code || 'write failed';
                emit(`[shard ${opts.shard}] immediate stop receipt unavailable; see the final summary\n`);
              }
            }
            const message = attempt.remoteJobStillRunning ? 'remote job still running' : 'remote cleanup unconfirmed';
            emit(`[shard ${opts.shard}] BLOCKED: ${message}; retaining ${attempt.slot}${attempt.stopCommand ? `; to stop: ${attempt.stopCommand}` : ''}\n`);
          }
          if (clean && launched && !attempt.exit) {
            phases.phase('inputPreparation');
            try {
              if (opts.inputs.length) await verifyInputs(row,opts.inputs,opts,state,{force:true,timeout:30000});
              const warm=warmInput(opts.project,opts.snapshot.storeKey,opts.affinity,0);
              const file=indexFile(cacheDir(),row.host); fs.mkdirSync(path.dirname(file),{recursive:true});
              await withStateLock(file,()=>{
                const index=readIndex(cacheDir(),row.host);
                // Successful command + clean supervisor establishes this slot's warm receipt.
                index.inputs[inputKey(warm)+'+'+row.slot]={path:data.workspace,verifiedAt:Date.now()/1000};
                writeJSON(file,index);
              });
            } catch(error) { attempt.exit ||= 74; attempt.inputIndexError=error.message; emit(`[shard ${opts.shard}] input index: ${error.message}\n`); }
          }
          if (clean && launched && opts.units) {
            phases.phase('transferOut');
            const timings = await ssh(row, 'timings', data, { cancellable: false, state, timeout: 30000 });
            try {
              attempt.unitTimings = JSON.parse(checked(timings, 'unit timing fetch')).units;
              if (!Array.isArray(attempt.unitTimings)) throw Error('invalid unit timing records');
              attempt.unitTimings = attempt.unitTimings.filter(record => opts.units.includes(record.unit));
            } catch (error) { attempt.timingError = error.message; emit(`[shard ${opts.shard}] ${error.message}\n`); }
          }
          if (clean && opts.artifacts.length) {
            phases.phase('transferOut');
            const manifestOnly = opts.artifactFetch === 'manifest' && (attempt.outcome === 'success' || opts.retainOnFail);
            if (opts.artifactFetch === 'manifest' && !manifestOnly) {
              attempt.artifactFetchFallback = 'all';
              emit(`[shard ${opts.shard}] ${attempt.message}: manifest retention skipped; fetching artifacts normally\n`);
            }
            const streams = Math.min(opts.artifactStreams, Math.max(1, Math.floor(8 / opts.shards)));
            const archive = path.join(opts.out, `shard-${opts.shard}-attempt-${attempts.length}.${manifestOnly ? 'manifest.json' : 'tar'}`);
            const collectionData = { ...data, host: row.host, fetch: manifestOnly ? 'manifest' : 'all', retainHours: opts.retainHours, streams, patterns: opts.artifacts };
            let fetched = await collectArtifacts(row, collectionData, archive, state, opts, emit);
            if (fetched.direct) attempt.artifactTransport = { method: 'direct-ssh', streams: 1,
              bytes: fetched.direct.bytes, resumable: false, reason: fetched.direct.reason };
            let resume;
            const verifyDirect = async result => {
              if (!result.direct || result.code) return;
              const expected = /DEVBOX_ARTIFACT_SHA256=([a-f0-9]{64})/.exec(result.stderr)?.[1];
              if (fs.statSync(archive).size === result.direct.bytes && expected && await fileDigest(archive) === expected) attempt.artifactSha256 = expected;
              else { result.code = 74; attempt.artifactIntegrityError = 'direct archive size/SHA-256 mismatch'; }
            };
            await verifyDirect(fetched);
            if (fetched.direct?.reason === 'low disk' && fetched.code === 74) {
              const first = fetched.direct;
              fs.rmSync(archive, { force: true });
              emit(`[shard ${opts.shard}] low-disk archive digest mismatch; restarting direct stream once\n`);
              fetched = await collectArtifacts(row, collectionData, archive, state, opts, emit);
              await verifyDirect(fetched);
              const stats = state.currentAttemptTiming.data.transferOut;
              stats.restartCount = 1;
              stats.averageMBps = (first.receivedBytes + stats.receivedBytes) / 1e6 / Math.max(0.001, (performance.now() - first.startedAt) / 1000);
              if (fetched.code === 74) { fs.rmSync(archive, { force: true }); stats.receivedBytes = 0; }
              else if (!fetched.code) delete attempt.artifactIntegrityError;
            }
            if (fetched.direct && fetched.code && fetched.direct.reason === 'small set'
                && !(state.cancel && state.cancel !== 124) && !/Permission denied|Authentication failed/i.test(fetched.stderr)) {
              resume = { initialBytes: fs.statSync(archive).size, initialResumes: 1, startedAt: fetched.direct.startedAt };
              emit(`[shard ${opts.shard}] small artifact stream broke; staging for resume from offset=${resume.initialBytes}\n`);
              const planFile = archive + '.staging.json';
              try { fetched = await collectArtifacts(row, { ...collectionData, forceStage: true }, planFile, state, opts, emit); }
              finally { fs.rmSync(planFile, { force: true }); }
            }
            const planRecord = /DEVBOX_ARTIFACT_PLAN=(\{[^\n]*\})/.exec(fetched.stderr);
            let recoveryManifest;
            if (!fetched.code && planRecord && !manifestOnly) {
              try {
                const plan = JSON.parse(planRecord[1]);
                validateArchivePlan(row, data, plan);
                attempt.artifactReceipt = plan;
                recoveryManifest = archive.replace(/\.tar$/, '.manifest.json');
                writeJSON(recoveryManifest, { ...plan, archive: true,
                  artifacts: [{ name: 'artifact-archive.tar', size: plan.size, sha256: plan.sha256 }] });
                const actualStreams = !resume && plan.size >= 64 * 1048576 ? streams : 1;
                attempt.artifactTransport = { method: actualStreams > 1 ? 'parallel-ssh' : 'resumable-ssh', streams: actualStreams, bytes: plan.size };
                const released = await fetchArchiveRanges(row, data, plan, archive, actualStreams, state, opts.artifactTimeout, emit, opts.shard, resume);
                attempt.artifactSha256 = plan.sha256;
                if (resume) { attempt.artifactDirectRecovered = true; delete attempt.artifactIntegrityError; }
                if (released.code) {
                  attempt.artifactReleaseError = `verified archive cleanup failed (${released.code})`;
                  attempt.artifactsRetained = { host: row.host, slot: row.slot, control: data.control };
                  attempt.artifactManifest = recoveryManifest;
                } else fs.unlinkSync(recoveryManifest);
              } catch (error) { fetched.code = error.code || 74; attempt.artifactIntegrityError = error.message; }
            }
            const collection = /DEVBOX_ARTIFACT_COLLECTION=(\{[^\n]*\})/.exec(fetched.stderr);
            if (collection) { try { phases.artifact(JSON.parse(collection[1]).seconds); } catch {} }
            if (!fetched.code && !manifestOnly) {
              if (!attempt.artifactSha256) { fetched.code = 74; attempt.artifactIntegrityError = 'missing remote archive plan'; }
            }
            if (fetched.code) {
              attempt.artifactExit = fetched.code;
              attempt.artifactsLeft = { slot: row.slot, host: row.host, workspace: data.workspace, patterns: opts.artifacts };
              if (recoveryManifest && fs.existsSync(recoveryManifest)) {
                attempt.retainedRemotely = true;
                attempt.artifactManifest = recoveryManifest;
                attempt.artifactsRetained = { host: row.host, slot: row.slot, control: data.control };
                attempt.fetchArtifactCommand = `${quote(process.execPath)} ${quote(script)} fetch-artifact --manifest ${quote(recoveryManifest)} --name artifact-archive.tar --out ${quote(archive + '.recovered.tar')} --timeout ${opts.artifactTimeout}`;
                emit(`[shard ${opts.shard}] artifact readback failed (${fetched.code}); ${attempt.message}; retainedRemotely on ${row.host} under ${data.control} for ${opts.retainHours} hours\n${attempt.fetchArtifactCommand}\n`);
              } else {
                attempt.retainedRemotely = false;
                emit(`[shard ${opts.shard}] artifact fetch failed (${fetched.code}); ${attempt.message}; artifacts not retained; files remain on ${row.slot} (${row.host}) under ${data.workspace} matching ${opts.artifacts.join(' ')} until slot reuse\n`);
              }
            }
            else if (manifestOnly) {
              attempt.artifactManifest = archive;
              attempt.artifactsRetained = { host: row.host, slot: row.slot, control: data.control };
              emit(`[shard ${opts.shard}] artifact manifest=${archive}; retained outside reusable workspace\n`);
            } else attempt.artifact = archive;
          }
        }
        if (attempt.slot && clean) {
          phases.phase('cleanup');
          try { await release(attempt.slot); attempt.returned = true; } catch (error) { attempt.exit ||= 70; attempt.returnError = error.message; emit(`[shard ${opts.shard}] BLOCKED: ${error.message}\n`); }
        }
        if (launched && clean) await refreshHostMetrics([row], state, { force: true });
        // Interrupted res can acquire before publishing slot=. Recover only this PID/holder.
        if (!attempt.slot) {
          for (const member of runRows(opts)) {
            const info = path.join(sharedDir(), 'locks', `${member.slot}.d`, 'info');
            try {
              const fields = Object.fromEntries(fs.readFileSync(info, 'utf8').trim().split('\n').map(line => line.split('\t')));
              if (fields.by === by && fields.pid === String(process.pid)) await release(member.slot);
            } catch (error) { if (error.code !== 'ENOENT') { attempt.exit ||= 70; attempt.returnError = error.message; } }
          }
        }
        phases.phase('cleanup');
        await phases.measure('controlClose', () => closeControlConnections(state));
        attempt.durationSec = (Date.now() - attemptStart) / 1000;
        phases.finish(); state.currentAttemptTiming = null;
        emit(`[shard ${opts.shard}] attempt phases ${timingLine(attempt.phaseTimings)}\n`);
      }
      if (attempt.exit && softExclusionsDropped) {
        const guidance = 'Soft exclusions were dropped automatically. Rerun with --exclude-reason if the host binding is required.';
        attempt.error = attempt.error ? `${attempt.error} ${guidance}` : guidance;
        emit(`[shard ${opts.shard}] ${guidance}\n`);
      }
      if (state.cancel || opts.prewarm || attempt.cleanupUnconfirmed || attempt.returnError || attempt.authenticationBlocked || attempt.infraFailure) break;
      if (attempt.diskGuard && diskRetries++ === 0) { diskHosts.add(row.host); avoid = row; continue; }
      if (attempt.exit && !attempt.diskGuard && opts.rerunOnFail && reruns++ === 0 && row) {
        firstFailure = attempt.exit; failedSlots.add(row.slot); avoid = row; continue;
      }
      break;
    }
    const last = attempts.at(-1);
    const flaky = Boolean(firstFailure && last?.exit === 0);
    let exit = state.cancel || (flaky && !opts.allowFlaky ? firstFailure : last?.exit ?? 1);
    const outcome = state.cancel ? commandOutcome(exit, budgets.expiredBudget, undefined, Boolean(last?.commandExit !== undefined)) : commandOutcome(exit, last?.expiredBudget, undefined, Boolean(last?.commandExit !== undefined));
    if (!state.cancel && exit !== 0 && last?.outcome === 'success') outcome.outcome = 'runner-failed';
    try { writeJSON(stateFile, { shard: opts.shard, updatedAt: new Date().toISOString(), status: 'complete', slot: last?.slot || null, exit, outcome: outcome.outcome, resEvents }); }
    catch { state.stop(74); exit = state.cancel; }
    return { shard: opts.shard, slot: last?.slot || null, host: last?.host || null, exit, outcome: outcome.outcome, ...(outcome.expiredBudget ? { expiredBudget: outcome.expiredBudget } : {}), flaky, stateFile, resEvents, ...(last?.skipped ? { skipped: true } : {}),
      ...(last?.sshDropRecovered ? { sshDropRecovered: true } : {}), ...(last?.reason ? { reason: last.reason } : {}),
      ...(opts.units ? { units: opts.units } : {}), ...(softExclusionsDropped ? { softExclusionsDropped } : {}), durationSec: (Date.now() - started) / 1000, log, attempts };
  } finally {
    budgets.finish(); clearInterval(parentWatch); fs.closeSync(fd);
    await closeControlConnections(state);
    try {
      const result = redactLogFile(log, { force: true });
      if (!process.stdout.destroyed) process.stdout.write(`[shard ${opts.shard}] log-redaction files=1 masked=${result.masked}\n`);
    } catch (error) {
      if (!process.stderr.destroyed) process.stderr.write(`[shard ${opts.shard}] log redaction failed (${error.message})\n`);
    }
  }
}

async function stopRetainedRuns(out, runId, stopId) {
  const summaryFile = path.join(out, 'summary.json');
  const receipts = [], discoveryErrors = [];
  if (fs.existsSync(summaryFile)) {
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    if (summary.runId !== runId) throw Error('summary identity mismatch');
    receipts.push(...summary.shards.flatMap(shard => (shard.attempts || []).filter(attempt => attempt.retainedRun)));
  }
  for (const name of fs.readdirSync(out).filter(name => /^(?:retained|active)-\d+\.json$/.test(name))) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
      if (receipt.runId === runId) receipts.push(receipt);
    } catch { discoveryErrors.push({ receipt: name, returned: false, error: 'unreadable stop receipt' }); }
  }
  const rows = [...readRegistry(sharedDir(), 'devbox-cn'), ...readRegistry(sharedDir(), 'devbox-cn-light')];
  // Recover pre-receipt versions through the outer UUID in pending evidence.
  // Every control must still match its registered slot; holder identity gates return.
  for (const row of rows) {
    try {
      const pending = JSON.parse(fs.readFileSync(path.join(sharedDir(), 'devbox-cleanup-pending', row.slot + '.json'), 'utf8'));
      const own = pending.runs.filter(item => item.runId === runId);
      if (!own.length) continue;
      const holdFile = path.join(sharedDir(), 'devbox-run-holds', row.slot + '.json');
      const held = fs.existsSync(holdFile) ? JSON.parse(fs.readFileSync(holdFile, 'utf8')) : null;
      for (const item of own) {
        const holder = held?.control === item.control ? held.holder : null;
        receipts.push({ slot: row.slot, retainedRun: { control: item.control, root: item.root,
          target: item.target, by: holder?.by, pid: holder?.pid } });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') discoveryErrors.push({ slot: row.slot, host: row.host, returned: false, error: 'unreadable pending/hold stop evidence' });
    }
  }
  const unique = new Map();
  for (const attempt of receipts) {
    const key = attempt.slot + ':' + attempt.retainedRun.control;
    // Pending evidence can identify the group after its holder receipt was lost.
    // Keep an existing active/retained holder identity when that fallback has none.
    if (!unique.has(key) || attempt.retainedRun.by) unique.set(key, attempt);
  }
  const retained = [...unique.values()];
  const state = cancellationState(), results = [...discoveryErrors];
  let exit = discoveryErrors.length ? 70 : 0;
  for (const error of discoveryErrors) console.error(`BLOCKED: ${error.receipt || error.slot}: ${error.error}; other shards will still be stopped`);
  try {
    for (const attempt of retained) {
      const { control, target, by, pid } = attempt.retainedRun;
      const row = rows.find(row => row.slot === attempt.slot && row.target === target);
      const result = { slot: attempt.slot, host: row?.host || target, control, pgid: null, count: null, returned: false };
      results.push(result);
      let validated = false;
      try {
        if (!row || !/^\/[^\r\n]*\/devbox-run\/runs\/[0-9a-f-]{36}$/.test(control) || control.split('/').includes('..'))
          throw Error('retained run no longer matches its registered slot');
        validated = true;
        const root = control.slice(0, control.lastIndexOf('/runs/'));
        await withStateLock(path.join(out, `stop-${runId}-${row.slot}`), async () => {
          const hold = readHold(row);
          // A returned or replaced hold can still have our pending remote group.
          // Its UUID receipt permits cleanup, but never returning the new owner's hold.
          const owned = hold && hold.fields.by === by && hold.fields.pid === String(pid);
          const cleanup = await ssh(row, 'cleanup', { control, root }, { state, timeout: 35000, noRetry: true });
          const diagnostic = /DEVBOX_CLEANUP=(\{[^\n]*\})/.exec(cleanup.stderr);
          if (diagnostic) {
            const evidence = JSON.parse(diagnostic[1]);
            if (evidence.run === path.posix.basename(control)) Object.assign(result, { pgid: evidence.pgid, count: evidence.count, ownerAlive: evidence.ownerAlive });
          }
          if (cleanup.code !== 0 || cleanup.stdout.trim() !== 'group-gone')
            throw Error(`remote cleanup unconfirmed (SSH exit=${cleanup.code})`);
          const evidence = JSON.parse(checked(await ssh(row, 'cleanup-pending', { root, control },
            { state, timeout: 8000, noRetry: true }), 'stop process confirmation'));
          Object.assign(result, { pgid: evidence.pgid ?? result.pgid, count: evidence.count, units: evidence.units });
          if (evidence.run !== path.posix.basename(control) || evidence.clean !== true || evidence.count !== 0 || evidence.units !== 0)
            throw Error('remote processes/units still present');
          result.clean = true;
          const markerFile = path.join(sharedDir(), 'devbox-cleanup-pending', row.slot + '.json');
          fs.mkdirSync(path.dirname(markerFile), { recursive: true });
          await withStateLock(markerFile, () => {
            if (!fs.existsSync(markerFile)) return;
            const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
            if (marker.slot !== row.slot || !Array.isArray(marker.runs)) throw Error('invalid cleanup pending marker');
            marker.runs = marker.runs.filter(item => item.control !== control || item.runId !== runId);
            if (marker.runs.length) writeJSON(markerFile, marker); else fs.unlinkSync(markerFile);
          });
          const current = readHold(row);
          if (owned && sameHolder(current?.fields, hold.fields)) {
            checked(await executeRes(['return', row.slot, '--by', by], { state, timeout: 30000 }), 'retained slot return');
            result.returned = true;
            console.log('confirmed remote cleanup and returned ' + row.slot);
          } else console.log('confirmed remote cleanup; lease absent or changed for ' + row.slot);
        });
      } catch (error) {
        result.error = error.message; exit ||= 70;
        if (validated && !result.clean) {
          try { await recordCleanupPending(row, { control, root: control.slice(0, control.lastIndexOf('/runs/')) }, runId); }
          catch (pendingError) { result.pendingMarkerError = pendingError.message; }
        }
        console.error(`BLOCKED: host=${result.host} pgid=${result.pgid ?? 'unknown'} processes=${result.count ?? 'unknown'} slot=${attempt.slot}: ${error.message}; ${result.clean ? 'lease return pending' : 'cleanup pending retained'}`);
      }
    }
    const receipt = { runId, stopId, exit, results };
    writeJSON(path.join(out, `stop-${stopId}.json`), receipt);
    writeJSON(path.join(out, 'stop-result.json'), receipt);
    console.log(JSON.stringify(receipt));
    return exit;
  } finally { await closeControlConnections(state); }
}

async function takeReadback(row, state, deadline, limit) {
  const dir = path.join(sharedDir(), 'devbox-readbacks', row.host);
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID(), file = path.join(dir, id + '.json');
  let announced = false;
  for (;;) {
    if (state.cancel || Date.now() >= deadline) throw Object.assign(Error('artifact readback admission cancelled or timed out'), { code: state.cancel || 124 });
    const acquired = await withStateLock(dir, () => {
      let active = 0;
      for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
        const heldFile = path.join(dir, name), holder = JSON.parse(fs.readFileSync(heldFile, 'utf8'));
        if (!Number.isInteger(holder.pid) || holder.pid <= 0 || !holder.hostname) throw Error('invalid readback holder');
        let dead = false;
        if (holder.hostname === os.hostname()) {
          try { process.kill(holder.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
        }
        if (dead) fs.unlinkSync(heldFile); else active++;
      }
      if (active >= limit) return false;
      writeJSON(file, { id, pid: process.pid, hostname: os.hostname() });
      return true;
    }, Math.max(1, Math.floor((deadline - Date.now()) / 50)));
    if (acquired) return async () => {
      await withStateLock(dir, () => {
        const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (holder.id !== id || holder.pid !== process.pid || holder.hostname !== os.hostname()) throw Error('readback ownership changed');
        fs.unlinkSync(file);
      });
    };
    if (!announced) { console.error(`devbox-run: readback waiting on ${row.host} (limit=${limit})`); announced = true; }
    await pause(Math.min(200, Math.max(1, deadline - Date.now())));
  }
}

function readbackReservedDisk(row, rows) {
  let values;
  try { values = JSON.parse(fs.readFileSync(path.join(sharedDir(), 'devbox-reservations', row.host + '.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  if (!Array.isArray(values)) throw Error('invalid readback disk reservations');
  let reserved = 0;
  const seen = new Set();
  for (const value of values) {
    if (!Array.isArray(value) || ![3, 4, 5].includes(value.length) || !value.slice(0, 3).every(n => Number.isFinite(n) && n > 0)
        || value.length >= 4 && (!Number.isFinite(value[3]) || value[3] < 0)) throw Error('invalid readback disk reservation');
    if (Date.now() / 1000 - value[0] >= (value.length >= 4 ? 900 : 300)) continue;
    if (value.length === 5) {
      const owner = value[4];
      if (!owner || !['slot', 'by', 'pid', 'host', 'start'].every(name => owner[name])) throw Error('invalid readback disk reservation owner');
      const candidate = rows.find(candidate => candidate.slot === owner.slot && candidate.host === row.host);
      const hold = candidate && readHold(candidate)?.fields;
      if (!hold || !['by', 'pid', 'host', 'start'].every(name => hold[name] === owner[name]) || seen.has(owner.slot)) continue;
      seen.add(owner.slot);
    }
    reserved += value[3] || 0;
  }
  return reserved;
}

export async function fetchArtifact(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('fetch-artifact --manifest FILE --name WORKSPACE_RELATIVE_NAME --out FILE [--timeout MIN]'); return 0;
  }
  const opts = { timeout: 15 }, fields = new Set(['--manifest', '--name', '--out', '--timeout']);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    if (!fields.has(args[i]) || seen.has(args[i]) || args[i + 1] === undefined) throw Error('usage: fetch-artifact --manifest FILE --name NAME --out FILE [--timeout MIN]');
    seen.add(args[i]); opts[args[i].slice(2)] = args[i + 1];
  }
  opts.timeout = Number(opts.timeout);
  if (!opts.manifest || !opts.out || !artifactName(opts.name) || sensitiveFile.test(opts.name)
      || !Number.isFinite(opts.timeout) || opts.timeout <= 0 || opts.timeout > 120) throw Error('invalid fetch-artifact arguments');
  const heavyRows = readRegistry(sharedDir(), 'devbox-cn'), lightRows = readRegistry(sharedDir(), 'devbox-cn-light');
  const rows = [...heavyRows, ...lightRows];
  const { receipt, artifact, row } = readArtifactManifest(opts.manifest, opts.name, rows);
  const sameOwner = candidate => candidate.host === row.host && candidate.target === row.target;
  const candidates = lightRows.filter(sameOwner);
  const readbackLimit = Number(process.env.DEVBOX_READBACK_LIMIT || 2);
  if (!Number.isInteger(readbackLimit) || readbackLimit < 1 || readbackLimit > 8) throw Error('DEVBOX_READBACK_LIMIT must be 1..8');
  const out = path.resolve(opts.out);
  const readbackId = randomUUID(), receiptFile = `${out}.readback-${readbackId}.json`;
  if (fs.existsSync(out)) throw Error('--out already exists');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const partial = out + '.' + randomUUID() + '.partial';
  const placementOpts = { placementInputs: manifest([{ name: 'retained-artifact', hash: artifact.sha256,
    rebuildable: false, cost: '0s', size: artifact.size / GiB, path: receipt.archive ? `${receipt.control}/artifact-archive.tar` : `${receipt.control}/artifacts/${artifact.name}` }]) };
  const by = `artifact-fetch-${process.pid}-${randomUUID()}`;
  const state = cancellationState();
  const stop = () => state.stop(143);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const parent = process.ppid;
  const watch = setInterval(() => { try { process.kill(parent, 0); } catch { state.stop(143); } }, 1000);
  const deadline = Date.now() + opts.timeout * 60000;
  const readbackReceipt = { readbackId, runId: receipt.run, host: row.host, out, receiptFile, bytes: artifact.size };
  let primaryError, releaseReadback;
  try {
    const root = await hostRoot(row, state, { deadline });
    if (receipt.control !== `${root}/runs/${receipt.run}`) throw Error('artifact manifest root differs from registered host root');
    await refreshHostMetrics(candidates, state, { timeout: Math.min(15000, Math.max(1, deadline - Date.now())) });
    // Direct takes bind the read to the exact registered host/user. Verify
    // the file after admission so hash checks also share the readback bound.
    let leasedRow;
    for (const candidate of candidates) {
      const take = await executeRes(['take', candidate.slot, '--by', by, '--project', 'orchestrator', '--task', 'fetch-artifact', '--for', 'retained artifact ' + opts.name,
        '--pid', String(process.pid), '--disk-gib', '0'], { state, timeout: Math.max(1, deadline - Date.now()) });
      if (state.cancel) throw Error('artifact lease cancelled');
      if (!take.code) { leasedRow = candidate; break; }
      if (![2, 3].includes(take.code)) checked(take, 'artifact lease');
    }
    if (leasedRow) {
      const hold = readHold(leasedRow);
      if (hold?.fields.by !== by || hold.fields.pid !== String(process.pid)) throw Error('artifact lease ownership changed');
      Object.assign(readbackReceipt, { readbackAdmission: 'light-slot', slot: leasedRow.slot });
    } else {
      releaseReadback = await takeReadback(row, state, deadline, readbackLimit);
      Object.assign(readbackReceipt, { readbackAdmission: 'bounded-no-slot', readbackLimit });
      leasedRow = row;
    }
    await verifyInputs(leasedRow, placementOpts.placementInputs, placementOpts, state,
      { force: true, timeout: Math.max(1, deadline - Date.now()) });
    // The no-slot path performs only bounded reads, but still checks live disk.
    const disk = JSON.parse(checked(await ssh(leasedRow, 'metrics', { root }, { state, timeout: Math.min(15000, Math.max(1, deadline - Date.now())) }), 'readback disk check'));
    const reservedDiskGiB = readbackReservedDisk(row, rows);
    if (!Number.isFinite(disk.freeGiB) || disk.freeGiB - reservedDiskGiB < 53) throw Error('artifact readback disk floor: need 53 GiB free after reservations');
    Object.assign(readbackReceipt, { freeGiB: disk.freeGiB, reservedDiskGiB });
    console.error(`devbox-run: readbackAdmission=${readbackReceipt.readbackAdmission} host=${row.host}`);
    if (receipt.archive) {
      readbackReceipt.transferOut = await readArchive(artifact, partial, { capMinutes: opts.timeout,
        readRange: async ({ offset, length, timeout, ...options }) => {
          if (state.cancel || Date.now() >= deadline) return { code: state.cancel || 124, fatal: true };
          const result = await ssh(leasedRow, 'artifact-range', { ...receipt, root, sha256: artifact.sha256, offset, length },
            { ...options, state, appendOutput: true, noRetry: true, timeout: Math.min(timeout, Math.max(1, deadline - Date.now())) });
          return { ...result, fatal: Boolean(state.cancel) || Date.now() >= deadline
            || ![0, 124, 255].includes(result.code) || /permission denied|gssapi|authentication failed/i.test(result.stderr) };
        },
      });
    } else {
      checked(await ssh(leasedRow, 'fetch-artifact', { ...receipt, root, artifact },
        { state, outputFile: partial, timeout: Math.min(artifactTimeoutMs(artifact.size, opts.timeout), Math.max(1, deadline - Date.now())) }), 'artifact readback');
    }
    if (fs.statSync(partial).size !== artifact.size || await fileDigest(partial) !== artifact.sha256) throw Error('artifact size/SHA-256 mismatch');
    if (state.cancel || Date.now() >= deadline) throw Error('artifact readback cancelled or timed out before publication');
    fs.linkSync(partial, out); fs.unlinkSync(partial);
    readbackReceipt.exit = 0;
    console.log(`artifact=${out} bytes=${artifact.size} sha256=${artifact.sha256}`);
    return 0;
  } catch (error) {
    primaryError = error; readbackReceipt.exit = error.code || 1; readbackReceipt.error = error.message; throw error;
  } finally {
    clearInterval(watch); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    const failures = [];
    const cleanup = async action => { try { await action(); } catch (error) { failures.push(error.message); } };
    await cleanup(() => { if (fs.existsSync(partial)) fs.unlinkSync(partial); });
    await cleanup(() => closeControlConnections(state));
    if (releaseReadback) await cleanup(releaseReadback);
    // Acquisition may be interrupted after res creates a hold but before it prints the slot.
    for (const candidate of rows) {
      await cleanup(async () => {
        const hold = readHold(candidate);
        if (hold?.fields.by === by && hold.fields.pid === String(process.pid))
          checked(await executeRes(['return', candidate.slot, '--by', by], { state, cancellable: false, timeout: 30000 }), 'artifact lease return');
      });
    }
    if (state.sshMux?.fallbackCount) Object.assign(readbackReceipt, { sshMuxFallback: true, sshMuxFallbackCount: state.sshMux.fallbackCount });
    if (failures.length) Object.assign(readbackReceipt, { exit: readbackReceipt.exit || 1, cleanupErrors: failures });
    await cleanup(() => fs.writeFileSync(receiptFile, JSON.stringify(readbackReceipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }));
    console.error(`devbox-run: readback receipt=${receiptFile}`);
    if (!primaryError && !failures.length) console.log(JSON.stringify(readbackReceipt));
    if (failures.length) {
      const detail = 'artifact cleanup: ' + failures.join('; ');
      if (primaryError) primaryError.message += '; ' + detail;
      else throw Error(detail);
    }
  }
}

async function recordCleanupPending(row,data,runId) {
  const file=path.join(sharedDir(),'devbox-cleanup-pending',row.slot+'.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  await withStateLock(file,()=>{
    const previous=fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {version:1,slot:row.slot,runs:[]};
    if (previous.slot !== row.slot || !Array.isArray(previous.runs)) throw Error('invalid existing cleanup pending marker');
    const record={run:path.posix.basename(data.control),runId,slot:row.slot,host:row.host,target:row.target,root:data.root,control:data.control,at:Date.now()/1000};
    if (!previous.runs.some(item=>item.run === record.run)) previous.runs.push(record);
    writeJSON(file,previous);
  });
}

export async function checkCleanupPending(slot) {
  const row=[...readRegistry(sharedDir(),'devbox-cn'),...readRegistry(sharedDir(),'devbox-cn-light')].find(row=>row.slot===slot);
  if (!row?.target) throw Error('cleanup pending requires an open registered slot');
  const file=path.join(sharedDir(),'devbox-cleanup-pending',slot+'.json');
  if (!fs.existsSync(file)) return 0;
  const state=cancellationState(), deadline=Date.now()+15000;
  try {
    return await withStateLock(file,async()=>{
      if (!fs.existsSync(file)) return 0;
      const marker=JSON.parse(fs.readFileSync(file,'utf8'));
      if (marker.version!==1 || marker.slot!==slot || !Array.isArray(marker.runs) || !marker.runs.length) throw Error('invalid cleanup pending marker');
      for (const item of marker.runs) {
        if (item.host!==row.host || item.target!==row.target || !item.root?.startsWith('/') || !item.root.endsWith('/devbox-run') || item.root.split('/').includes('..') || item.control!==`${item.root}/runs/${item.run}` || !/^[0-9a-f-]{36}$/.test(item.run))
          throw Error('cleanup pending registered host/UUID mismatch');
        const evidence=JSON.parse(checked(await ssh(row,'cleanup-pending',{root:item.root,control:item.control},
          {state,timeout:Math.max(1,Math.min(8000,deadline-Date.now())),noRetry:true}),'cleanup pending check'));
        if (evidence.run!==item.run || evidence.clean!==true || evidence.count!==0 || evidence.units!==0) {
          console.error(`cleanup pending slot=${slot} run=${item.run}: remote work still alive`); return 2;
        }
      }
      fs.unlinkSync(file);
      console.log(`cleanup pending confirmed gone slot=${slot}; marker cleared`);
      return 0;
    },Math.max(1,Math.floor((deadline-Date.now())/50)));
  } finally { await closeControlConnections(state); }
}

export async function retainedArtifacts(args, retire = false) {
  const opts = { timeout: 5 };
  for (let i = 0; i < args.length; i += 2) {
    if (!['--host','--receipt','--timeout'].includes(args[i]) || args[i+1] === undefined) throw Error('list-retained [--host IP]; retire-artifacts --receipt UUID [--host IP] [--timeout MIN]');
    opts[args[i].slice(2)] = args[i+1];
  }
  if (retire && !/^[0-9a-f-]{36}$/.test(opts.receipt || '') || !retire && opts.receipt) throw Error('--receipt must be a run UUID for retirement');
  if (!Number.isFinite(Number(opts.timeout)) || Number(opts.timeout) <= 0 || Number(opts.timeout) > 120) throw Error('invalid retention timeout');
  const rows = [...readRegistry(sharedDir(),'devbox-cn'),...readRegistry(sharedDir(),'devbox-cn-light')];
  const hosts = [...new Map(rows.filter(row => !opts.host || row.host === opts.host).map(row => [row.target,row])).values()];
  if (!hosts.length) throw Error('no open registered retention host');
  const state = cancellationState(), by = `artifact-retire-${process.pid}-${randomUUID()}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'devbox-artifact-admin-'));
  const placementFile = path.join(temp,'placement.json'), deadline = Date.now()+Number(opts.timeout)*60000;
  const stop = () => state.stop(143);
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
  const parent = process.ppid, watch = setInterval(() => { try { process.kill(parent,0); } catch { stop(); } },1000);
  let found = false, primaryError;
  try {
    for (const row of hosts) {
      const root = await hostRoot(row,state,{deadline});
      const inventory = JSON.parse(checked(await ssh(row,'list-retained',{root},{state,timeout:Math.max(1,deadline-Date.now())}),'retained inventory'));
      if (!retire) { console.log(JSON.stringify({host:row.host,target:row.target,receipts:inventory})); continue; }
      if (!inventory.some(record => record.run === opts.receipt)) continue;
      if (found) throw Error('retained UUID exists on multiple registered hosts');
      found = true;
      const light = rows.filter(candidate => candidate.target === row.target && candidate.slot.includes('light'));
      const candidates = light.length ? light : rows.filter(candidate => candidate.target === row.target);
      const pool = light.length ? 'devbox-cn-light' : 'devbox-cn';
      const slots = Object.fromEntries(candidates.map(candidate => [candidate.slot,{eligible:true,host:row.host,waitSec:0,rebuildSec:0,totalSec:0,hardReasons:[],missing:[],extraDiskGiB:0}]));
      writeJSON(placementFile,{version:1,at:Date.now()/1000,slots});
      const acquired = checked(await executeRes(['wait-pool',pool,'--by',by,'--project','orchestrator','--task','retire-artifacts','--for','retire exact artifact receipt',
        '--pid',String(process.pid),'--timeout',String(Math.max(1,deadline-Date.now())/60000),'--placement-file',placementFile],{state,timeout:Math.max(1,deadline-Date.now())}),'retirement lease');
      const slot = /^slot=(\S+)$/m.exec(acquired)?.[1], leased = candidates.find(candidate => candidate.slot === slot);
      const hold = leased && readHold(leased);
      if (!hold || hold.fields.by !== by || hold.fields.pid !== String(process.pid)) throw Error('retirement lease ownership changed');
      console.log(checked(await ssh(leased,'retire-artifacts',{root,receipt:opts.receipt},{state,timeout:Math.max(1,deadline-Date.now())}),'artifact retirement').trim());
      checked(await executeRes(['return',leased.slot,'--by',by],{state,cancellable:false,timeout:30000}),'retirement lease return');
    }
    if (retire && !found) throw Error('retained artifact receipt not found');
    return 0;
  } catch (error) { primaryError=error; throw error; }
  finally {
    clearInterval(watch); process.removeListener('SIGTERM',stop); process.removeListener('SIGINT',stop);
    const failures=[];
    for (const row of rows) try {
      const hold=readHold(row);
      if (hold?.fields.by === by && hold.fields.pid === String(process.pid)) checked(await executeRes(['return',row.slot,'--by',by],{state,cancellable:false,timeout:30000}),'retirement lease return');
    } catch (error) { failures.push(error.message); }
    try { await closeControlConnections(state); } catch (error) { failures.push(error.message); }
    fs.rmSync(temp,{recursive:true,force:true});
    if (failures.length) { if (primaryError) primaryError.message += '; '+failures.join('; '); else throw Error(failures.join('; ')); }
  }
}

async function main(args) {
  if (args[0] === 'check-cleanup-pending') {
    if (args.length!==3 || args[1]!=='--slot') throw Error('check-cleanup-pending --slot ID');
    return checkCleanupPending(args[2]);
  }
  if (args[0] === 'list-retained' || args[0] === 'retire-artifacts') return retainedArtifacts(args.slice(1),args[0] === 'retire-artifacts');
  if (args[0] === 'fetch-artifact') return fetchArtifact(args.slice(1));
  if (args[0] === 'input-hash') {
    if (args.length !== 2) throw Error('usage: devbox-run.mjs input-hash PATH');
    const file = path.resolve(args[1]);
    if (file.split(path.sep).some(part => /^(?:login|cookies?|sessions?|\.netrc|\.npmrc|\.pypirc|\.ssh|\.aws|\.kube|\.env(?:\..*)?|\.git)$/i.test(part)) || sensitiveFile.test(file))
      throw Error('input path contains private state');
    const kind = fs.lstatSync(file).isDirectory() ? 'directory' : 'file';
    console.log(JSON.stringify({ ...await fingerprint(file), kind })); return 0;
  }
  if (args[0] === 'release-dead') {
    if (args.length !== 3 || args[1] !== '--slot') throw Error('usage: devbox-run.mjs release-dead --slot ID');
    await releaseDeadSlot(args[2]); return 0;
  }
  if (args[0] === 'stop') {
    const [, outFlag, out, idFlag, runId] = args;
    if (args.length !== 5 || outFlag !== '--out' || idFlag !== '--run-id' || !/^[0-9a-f-]{36}$/.test(runId))
      throw Error('usage: devbox-run.mjs stop --out DIR --run-id UUID');
    if (JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).runId !== runId)
      throw Error('run identity mismatch');
    // Even if DIR changes between check and write, a different run ignores this name.
    try { fs.writeFileSync(path.join(out, 'stop-' + runId), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stopId = randomUUID();
    console.log(`stop requested for ${runId} stopId=${stopId}`);
    return await stopRetainedRuns(out, runId, stopId);
  }
  const opts = parseArgs(args);
  if (opts.help) {
    console.log('Artifacts: --artifact-fetch all|manifest (default all); --artifact-timeout MIN (size-scaled connection cap, default 120); --artifact-streams 1..4 (default 1); --retain-hours HOURS (default 24, max 72); --retain-on-fail; fetch-artifact --manifest FILE --name NAME --out FILE [--timeout MIN]; list-retained [--host IP]; retire-artifacts --receipt UUID [--host IP]');
    console.log('Usage: devbox-run.mjs [--project P] --task T --repo PATH [--ref COMMIT|HEAD|worktree] [--pool devbox-cn|devbox-cn-light] [--shards N|auto] [--units-file PATH] [--artifact GLOB]... [--fetch-timeout MIN] [--artifact-timeout MIN] [--out DIR] [--timeout MIN] [--queue-timeout MIN] [--env K=V]... [--rerun-on-fail] [--allow-flaky] [--affinity KEY] [--prefer-host IP] [--prefer-slot ID] [--need CAP]... [--exclude-slot IDS] [--exclude-host IPS] [--exclude-reason TEXT] [--submodules] [--watch-pid PID] [--input MANIFEST]... [--inputs JSON] [--warm-cost DURATION] -- COMMAND\n       devbox-run.mjs prewarm --project P --repo PATH [--ref main] [--command COMMAND] [--need CAP]... [--input MANIFEST]...\n       devbox-run.mjs gc [--host IP] [--days N]\n       devbox-run.mjs stop --out DIR --run-id UUID\nCOMMAND supports {shard}, {shards} and {units}. --timeout bounds the remote command (default 120 min). --queue-timeout bounds cumulative queue/upload/input preparation (default max(timeout, 30) min); cleanup and artifact readback follow. See references/devbox-run.md.');
    return 0;
  }
  if (opts.gc) {
    const state = cancellationState();
    for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })) process.on(signal, () => state.stop(code));
    const parentPid = process.ppid;
    const watch = setInterval(() => { try { process.kill(parentPid, 0); } catch { state.stop(143); } }, 1000);
    try {
      const rows = [...readRegistry(sharedDir(), 'devbox-cn'), ...readRegistry(sharedDir(), 'devbox-cn-light')];
      if (opts.host && !rows.some(row => row.host === opts.host)) throw Error('GC host has no open mapped slots');
      await collectGarbage({ rows, days: opts.days, host: opts.host, state });
      return state.cancel;
    } finally { clearInterval(watch); await closeControlConnections(state); }
  }
  fs.mkdirSync(opts.out, { recursive: true });
  if (fs.existsSync(path.join(opts.out, 'summary.json')) || fs.readdirSync(opts.out).some(n => /^shard-\d/.test(n))) throw Error('--out already contains a devbox run');
  const runId = randomUUID(), stopFile = path.join(opts.out, 'stop-' + runId);
  fs.writeFileSync(path.join(opts.out, 'run.json'), JSON.stringify({ runId }) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('runId=' + runId);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-run-'));
  const state = cancellationState(Object.values(opts.env));
  const workers = new Set();
  const stop = code => { state.stop(code); for (const signalChild of workers) signalChild('SIGTERM'); };
  for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })) process.on(signal, () => stop(code));
  const watchPid = Number(opts.watchPid || process.ppid);
  const watch = setInterval(() => {
    if (fs.existsSync(stopFile)) stop(143);
    else try { process.kill(watchPid, 0); } catch { stop(143); }
  }, 1000);
  try {
    opts.snapshot = await snapshot(opts, temp, state);
    await prepareSeeds(opts,temp,state);
    if (state.cancel) return state.cancel;
    if (opts.unitsFile) opts.units = parseUnits(fs.readFileSync(opts.unitsFile, 'utf8'));
    else if (opts.command.includes('{units}')) opts.units = parseUnits(discoverUnits(opts.snapshot.files).join('\n'));
    if (opts.units?.some(unit => !opts.snapshot.files.includes(unit))) throw Error('unit is absent from the source snapshot');
    delete opts.snapshot.files;
    const commandKey = createHash('sha256').update(JSON.stringify([opts.command, opts.units || null, Boolean(opts.prewarm)])).digest('hex');
    opts.commandKey=commandKey;
    const thermal=readTimings(opts.snapshot.storeKey).commands?.[commandKey]?.placement;
    const cost=warmCost(thermal,opts.warmCost);
    opts.placementInputs=[...opts.inputs,...(cost===undefined?[]:[warmInput(opts.project,opts.snapshot.storeKey,opts.affinity,cost)])];
    const prewarm = opts.prewarm ? await planPrewarm(opts, state) : null;
    let plan;
    if (opts.prewarm) plan = { count: prewarm.length, strategy: 'prewarm', groups: prewarm.map(() => null) };
    else {
      const rows = runRows(opts).filter(row => eligibleSlot(opts, row));
      if (rows.some(row => !row.target)) throw Error('open pool registry row lacks an unambiguous user@ip description');
      const blocked = opts.shards === 'auto' ? quarantinedHosts(sharedDir()) : new Set();
      plan = planShards(opts.shards, rows.filter(row => freeSlot(sharedDir(), row) && !blocked.has(row.host)).length, opts.units, readTimings(opts.snapshot.storeKey), commandKey);
    }
    const requestedShards = opts.shards;
    opts.shards = plan.count;
    if (opts.prewarm || requestedShards === 'auto') console.log(`shards=${opts.shards} strategy=${plan.strategy}${!opts.shards ? ' (no idle eligible hosts)' : ''}`);
    if (state.cancel) return state.cancel;
    // Probe both `res help` (lists wait-pool flags without a prefix) and the legacy `wait-pool --help`.
    const helps = await Promise.all([['help'], ['wait-pool', '--help']].map(args => executeRes(args, { state })));
    // Only successful probes count; a failed probe (for example live res rejecting `wait-pool --help`)
    // must never look like a legacy res and silently drop --need/--exclude-* placement constraints.
    const helpText = helps.filter(help => help.code === 0).map(help => `${help.stdout}${help.stderr}`).join('\n');
    if (!helpText) {
      console.error('devbox-run: could not read res flags (`res help` and `res wait-pool --help` both failed); refusing to place shards without --need/--exclude-* constraints');
      return 2;
    }
    opts.placementSupported=helpText.includes('--placement-file');
    opts.warmFamilySupported=helpText.includes('--warm-family');
    const settings=inputSettings(sharedDir()); opts.inputSettings=settings;
    if (!settings.enabled) {
      if (opts.inputs.some(input=>!input.rebuildable)) throw Error('rebuild placement disabled; non-rebuildable inputs require enabled placement');
      opts.placementInputs=[];
    }
    if (opts.inputs.length && !opts.placementSupported && settings.enabled) throw Error('input placement requires matching res with --placement-file');
    if (!opts.placementSupported) opts.placementInputs=[];
    opts.diskCostsSupported = helpText.includes('--disk-gib-file');
    opts.preferSupported = /--prefer-host\b/.test(helpText);
    opts.excludeSlotSupported = helpText.includes('--exclude-slot');
    opts.excludeHostSupported = helpText.includes('--exclude-host');
    opts.needSupported = /--need\b/.test(helpText);
    opts.preferSlotSupported = /--prefer-slot\b/.test(helpText);
    opts.retainRemoteSupported = helpText.includes('res retain-remote');
    opts.splitExclusions = helpText.includes('--exclude-reason') && helpText.includes('--hard-exclude-host') && helpText.includes('--hard-exclude-slot');
    if (!opts.splitExclusions && !opts.excludeReason && (opts.excludeSlot.length || opts.excludeHost.length))
      console.error('devbox-run: installed res treats exclusions as fixed; update res to enable soft fallback');
    const shards = await Promise.all(Array.from({ length: opts.shards }, (_, index) => new Promise(resolve => {
      const child = fork(script, ['--internal-shard'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const signalChild = ownChild(child); workers.add(signalChild); let result;
      child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
      child.on('message', message => { result = message; });
      child.on('error', () => {});
      child.on('exit', (code, signal) => {
        workers.delete(signalChild);
        resolve(result || { shard: index + 1, slot: null, host: null, exit: code || (signal ? 143 : 1), error: 'shard process exited without cleanup report' });
      });
      child.send({ ...opts, runId, units: plan.groups[index], ...(opts.prewarm ? { prewarmSlots: prewarm[index] } : {}), shard: index + 1, parentPid: process.pid });
      if (state.cancel) signalChild('SIGTERM');
    })));
    let exit = state.cancel || shards.find(item => item.exit)?.exit || 0;
    const summary = { runId, project: opts.project, task: opts.task, commit: opts.snapshot.commit, commandHash: createHash('sha256').update(opts.command).digest('hex'),
      time: new Date().toISOString(), exit, outcome: exit === 0 ? 'success' : shards.find(item => item.exit === exit)?.outcome || commandOutcome(exit).outcome, commandTimeoutMin: opts.timeout, queueTimeoutMin: opts.queueTimeout, mode: opts.prewarm ? 'prewarm' : 'run', requestedShards, shardPlan: plan, shards };
    try { await recordTimings(opts.snapshot.storeKey, commandKey, shards); }
    catch (error) { summary.timingError = error.message; summary.exit = exit ||= 74; console.error(`timing history: ${error.message}`); }
    if (summary.timingError) summary.outcome = 'runner-failed';
    const expiredBudget = shards.find(item => item.exit === exit)?.expiredBudget;
    if (expiredBudget) summary.expiredBudget = expiredBudget;
    writeJSON(path.join(opts.out, 'summary.json'), summary);
    for (const item of shards.filter(item => item.flaky)) {
      fs.appendFileSync(path.join(cacheDir(), 'flaky-log.jsonl'), `${JSON.stringify({ project: opts.project, task: opts.task, commandHash: summary.commandHash, shard: item.shard, hosts: item.attempts.filter(a => !a.diskGuard).map(a => a.host), time: summary.time })}\n`, { mode: 0o600 });
    }
    console.log(`summary=${path.join(opts.out, 'summary.json')} exit=${exit}`);
    return exit;
  } finally { clearInterval(watch); await closeControlConnections(state); fs.rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--internal-shard' && process.send) {
    process.once('message', async opts => {
      try { const result = await shard(opts); process.send(result, () => { process.disconnect(); process.exit(result.exit); }); }
      catch { process.exitCode = 1; process.disconnect(); }
    });
  } else {
    main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(`devbox-run: ${error.message}`); process.exitCode = 1; });
  }
}
