#!/usr/bin/env node
// Linux work runs under a public res hold; this process never takes a mini lane.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { redactLogFile } from './lib/log-redaction.mjs';
import { maskLogText } from './lib/nightly-audit.mjs';

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
  const opts = { ref: 'HEAD', pool: 'devbox-cn', shards: 1, timeout: 120, fetchTimeout: 15, artifacts: [], env: {}, days: 7, need: [], excludeSlot: [], excludeHost: [] };
  if (args[0] === 'gc') { opts.gc = true; args = args.slice(1); }
  if (args[0] === 'prewarm') { opts.prewarm = true; opts.ref = 'main'; opts.task = 'prewarm'; args = args.slice(1); }
  const names = new Map(['project', 'task', 'repo', 'ref', 'pool', 'shards', 'out', 'timeout', 'prefer-host', 'watch-pid', 'affinity', 'host', 'days', 'units-file', 'command', 'fetch-timeout', 'exclude-reason', 'prefer-slot'].map(n => [`--${n}`, n.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { if (opts.command) throw Error('provide only one command'); opts.command = args.slice(i + 1).join(' '); break; }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--submodules') { opts.submodules = true; continue; }
    if (arg === '--rerun-on-fail') { opts.rerunOnFail = true; continue; }
    if (arg === '--allow-flaky') { opts.allowFlaky = true; continue; }
    if (!names.has(arg) && !['--env', '--artifact', '--need', '--exclude-slot', '--exclude-host'].includes(arg)) throw Error(`unknown option ${arg}`);
    const value = args[++i];
    if (value === undefined || value === '--') throw Error(`missing value for ${arg}`);
    if (arg === '--command' && !opts.prewarm) throw Error('--command is for prewarm; use -- COMMAND for runs');
    if (opts.prewarm && ['--shards', '--units-file'].includes(arg)) throw Error('prewarm builds once per idle host, without unit sharding');
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
    } else opts[names.get(arg)] = value;
  }
  if (opts.excludeReason !== undefined && (!opts.excludeReason.trim() || /[\t\r\n]/.test(opts.excludeReason))) throw Error('invalid --exclude-reason');
  opts.days = Number(opts.days);
  if (!Number.isFinite(opts.days) || opts.days < 1) throw Error('--days must be at least 1');
  if (opts.gc) return opts;
  if (opts.prewarm && !opts.project) throw Error('prewarm requires --project');
  for (const name of (opts.project === undefined ? ['task'] : ['project', 'task'])) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(opts[name] || '')) throw Error(`--${name} needs a simple identifier`);
  if (!opts.repo || !opts.command?.trim()) throw Error('--repo and a command after -- are required');
  if (!['devbox-cn', 'devbox-cn-light'].includes(opts.pool)) throw Error('unsupported pool');
  opts.shards = opts.shards === 'auto' ? 'auto' : Number(opts.shards); opts.timeout = Number(opts.timeout);
  if (opts.shards !== 'auto' && (!Number.isInteger(opts.shards) || opts.shards < 1 || opts.shards > 64)) throw Error('--shards must be auto or 1..64');
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0 || opts.timeout > 120) throw Error('--timeout must be >0 and <=120 minutes');
  opts.fetchTimeout = Number(opts.fetchTimeout);
  if (!Number.isFinite(opts.fetchTimeout) || opts.fetchTimeout <= 0 || opts.fetchTimeout > 120) throw Error('--fetch-timeout must be >0 and <=120 minutes');
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
function lineSink(write, values = [], intercept, strictOutput = true) {
  const decoder = new StringDecoder('utf8'); let pending = '', dropping = false, privateBlock = false;
  const redact = line => {
    if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(line)) privateBlock = true;
    if (privateBlock) { if (/-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(line)) privateBlock = false; return '[MASKED private key output]'; }
    for (const value of values) line = line.replaceAll(value, '[MASKED]');
    line = maskLogText(line).text;
    if (strictOutput && (sensitive.test(line) || /ACCESS|SCRECT|KEY(?!ALIAS)|PASS|PWD|AUTH|NEXUS|MAGIC|PRIVATE/i.test(line)) && /[=:]|bearer\s/i.test(line)) return '[MASKED sensitive output]';
    return line.replace(/\bAKIA[A-Z0-9]{16}\b/g, '[MASKED access key]');
  };
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!dropping && !intercept?.(line)) write(`${redact(line)}\n`);
        dropping = false;
      }
      if (pending.length > 1024 * 1024) { if (!dropping) write('[suppressed oversized output line]\n'); pending = ''; dropping = true; }
    },
    end() { pending += decoder.end(); if (pending && !dropping) write(redact(pending)); },
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

function execute(file, args, { input, inputFile, outputFile, onOutput, timeout = 60000, state, cancellable = true, rawCapture = !onOutput && !outputFile, interceptStderr, interceptStdout, env = process.env, strictOutput = true } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '', timedOut = false, spawnError;
    const sink = outputFile ? fs.createWriteStream(outputFile, { mode: 0o600 }) : null;
    const rawDecoder = new StringDecoder('utf8');
    const out = lineSink(text => { if (!rawCapture) stdout = (stdout + text).slice(-2 * 1024 * 1024); onOutput?.(text, 'stdout'); }, state?.values, interceptStdout, strictOutput);
    const err = lineSink(text => { stderr = (stderr + text).slice(-2 * 1024 * 1024); onOutput?.(text, 'stderr'); }, state?.values, interceptStderr, strictOutput);
    const signalChild = ownChild(child);
    if (state && cancellable) state.children.add(signalChild);
    let killTimer;
    const stop = () => { signalChild('SIGTERM'); killTimer ??= setTimeout(() => signalChild('SIGKILL'), 30000); };
    sink?.on('error', error => { spawnError = `output file ${error.code || 'write failure'}`; stop(); });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    let source;
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (sink) sink.write(chunk);
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
      state?.children.delete(signalChild); out.end(); err.end();
      if (rawCapture) stdout += rawDecoder.end();
      if (sink) await new Promise(done => sink.end(done));
      resolve({ code: spawnError ? 1 : timedOut ? 124 : code ?? (signal === 'SIGTERM' ? 143 : 1), stdout, stderr: stderr || spawnError || '', error: spawnError });
    });
    if (inputFile) { source = fs.createReadStream(inputFile); source.on('error', error => { spawnError = `input file ${error.code || 'read failure'}`; stop(); }); source.pipe(child.stdin); }
    else child.stdin.end(input);
    if (state?.cancel && cancellable) stop();
  });
}

function executeRes(args, options) {
  // Local res diagnostics still get value masking, but keep their surrounding text.
  return execute(resCommand(), args, { ...options, strictOutput: false });
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

export const remoteScripts = {
  metrics: pythonHeader + `load5=float(pathlib.Path('/proc/loadavg').read_text().split()[1])
mem=next(int(line.split()[1])/1048576 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
disk=os.statvfs(d['root'])
print(json.dumps({'cores':os.cpu_count(),'load5':load5,'memAvailableGiB':mem,'freeGiB':disk.f_bavail*disk.f_frsize/1073741824}))
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
disk=os.statvfs(root); repo=pathlib.Path(d['repository']); known=[]; present=False
if repo.exists():
    known=subprocess.check_output(['git','--git-dir='+str(repo),'for-each-ref','--format=%(objectname)'],text=True).splitlines()
    present=subprocess.run(['git','--git-dir='+str(repo),'cat-file','-e',d['commit']+'^{commit}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
print(json.dumps({'free':disk.f_bavail*disk.f_frsize,'known':known,'present':present}))
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
        for name in old.get('untracked',[]):
            parts=pathlib.PurePosixPath(name).parts
            if not parts or name.startswith('/') or '..' in parts: raise RuntimeError('invalid overlay path')
            target=ws
            for part in parts:
                target=target/part
                if target.is_symlink(): target.unlink(); break
            else:
                if target.is_file(): target.unlink()
        subprocess.run(['git','-C',str(ws),'reset','--hard',d['commit']],check=True,stdout=subprocess.DEVNULL)
        # BC-117: drop untracked leftovers of earlier runs (not ignored build caches) so each run sees only its own overlay.
        subprocess.run(['git','-C',str(ws),'clean','-ffd','-q'],check=True,stdout=subprocess.DEVNULL)
    else:
        ws.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['git','--git-dir='+str(repo),'worktree','add','--detach',str(ws),d['commit']],check=True,stdout=subprocess.DEVNULL)
    meta.write_text(json.dumps({'slot':d['slot'],'repository':str(repo),'lastUsed':time.time(),'untracked':d['untracked']}))
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
  maintenance: pythonHeader + `import subprocess, fcntl, shutil
root=pathlib.Path(d['root']); before=os.statvfs(root); before=before.f_bavail*before.f_frsize
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
  run: pythonHeader + `import ctypes, subprocess, shlex, shutil
ctl=pathlib.Path(d['control']); cancelled=False
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
proc=None; leader_start=None; result=1; deadline=time.monotonic()+d['seconds']
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
        leader_start=stat(proc.pid)[19]
        save('group.json',{'pid':proc.pid,'start':leader_start})
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
    save('done.json',{'gone':gone,'exit':result if gone else 70})
sys.exit(result if gone else 70)
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
  cleanup: pythonHeader + remoteRunIdentity + `ctl.mkdir(parents=True, exist_ok=True)
for file in ('owner.json','group.json','done.json'):
    if (ctl/file).exists(): read_own(ctl/file)
(ctl/'cancel').touch()
limit=time.monotonic()+20
while time.monotonic()<limit:
    done=ctl/'done.json'; owner=ctl/'owner.json'
    if done.exists():
        record=read_own(done)
        if record['gone'] and group_gone(): print('group-gone'); sys.exit(0)
        sys.exit(70)
    if owner.exists():
        record=read_own(owner)
        if not alive(record):
            # Never signal a possibly reused group without its owning supervisor.
            if group_gone(): print('group-gone'); sys.exit(0)
            sys.exit(70)
    elif not owner.exists():
        # The supervisor publishes owner before checking cancel; a late start cannot launch.
        print('group-gone'); sys.exit(0)
    time.sleep(.1)
sys.exit(70)
`,
  artifacts: pythonHeader + `import glob, tarfile
os.chdir(d['workspace']); names=set()
for pattern in d['patterns']:
    matches=glob.glob(pattern,recursive=True)
    if not matches: print('artifact pattern had no matches',file=sys.stderr); sys.exit(66)
    for name in matches:
        p=pathlib.Path(name)
        if p.is_dir(): names.update(str(x) for x in p.rglob('*') if x.is_file() or x.is_symlink())
        else: names.add(name)
for name in names:
    p=pathlib.Path(name)
    if p.is_symlink() or not p.resolve().is_relative_to(pathlib.Path.cwd()): raise RuntimeError('artifact leaves workspace')
    if any(x in ('.git','.ssh','.aws','.kube','.npmrc','.netrc') or x=='.env' or x.startswith('.env.') for x in p.parts) or p.suffix.lower() in ('.pem','.p12','.pfx','.key','.keystore'): raise RuntimeError('credential-related artifact refused')
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as tar:
    for name in sorted(names): tar.add(name,arcname=name,recursive=False)
`,
};

async function ssh(row, operation, data, opts = {}) {
  if (opts.state?.sshStartDelay && !opts.state.sshStarted) {
    opts.state.sshStarted = true;
    await pause(opts.state.sshStartDelay);
  }
  const base = operation === 'upload'
    ? `# devbox-run:upload\nmkdir -p ${quote(data.workspace)} && tar -xf - -C ${quote(data.workspace)}`
    : remoteCommand(operation, remoteScripts[operation], data);
  for (let retry = 0; ; retry++) {
    let started = false;
    const marker = `DEVBOX_STARTED_${randomUUID()}`;
    const command = base.replace('\n', `\nprintf '%s\\n' ${quote(marker)} >&2\n`);
    const result = await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'ConnectTimeout=15', '-o', 'ForwardAgent=no', '-o', 'GSSAPIDelegateCredentials=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', row.target, command], {
      ...opts, interceptStderr: line => { if (line === marker) { started = true; return true; } return false; },
    });
    const transient = result.code === 255 && !started && /Permission denied \(gssapi-with-mic\)|Connection closed\b/i.test(result.stderr);
    if (opts.noRetry || operation === 'metrics' || !transient || (opts.state?.cancel && opts.cancellable !== false)) return { ...result, sshStarted: started };
    if (retry === 3) return { ...result, infraFailure: true, stderr: `SSH establishment failed after 4 attempts: ${result.stderr}` };
    await pause(2000 + Math.floor(Math.random() * 8001));
  }
}

async function reconnectRun(row, data, state) {
  for (const delay of [0, 1000, 2000]) {
    if (delay) await pause(delay);
    const result = await ssh(row, 'reconnect', { control: data.control }, { state, cancellable: false, timeout: 8000, noRetry: true });
    if (result.code === 0 && ['group-gone', 'group-running'].includes(result.stdout.trim())) return result.stdout.trim();
    if (/permission denied|gssapi|authentication failed/i.test(result.stderr)) break;
  }
  return 'unknown';
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
  opts.affinity ||= `${storeKey}+${branch}`;
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
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt === maxAttempts) throw error;
      await pause(50);
    }
  }
  try { return await operation(); } finally { fs.rmdirSync(lock); }
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
        const { cores, load5, memAvailableGiB, freeGiB } = JSON.parse(result.stdout);
        const sample = { at, cores, load5, memAvailableGiB, freeGiB };
        if (valid(sample)) writeJSON(file, sample);
      }, Math.floor(timeout / 50));
    } catch {
      // Admission handles an unavailable sample using the registered static slots.
    }
  }));
}

async function hostRoot(row, state, { deadline } = {}) {
  const cacheFile = path.join(cacheDir(), 'devbox-hosts.json');
  return withStateLock(path.join(cacheDir(), `devbox-probe-${row.host}`), async () => {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let entry = cache[row.host];
  if (!entry?.root || entry.user !== row.user || !Number.isInteger(entry.cores) || entry.cores < 1) {
    const timeout = deadline === undefined ? 60000 : deadline - Date.now();
    if (timeout <= 0) throw Error('root probe deadline expired');
    entry = JSON.parse(checked(await ssh(row, 'probe', { user: row.user }, { state, timeout, noRetry: deadline !== undefined }), 'root probe').trim());
    await mergeState(cacheFile, row.host, entry);
  }
  if (typeof entry.root !== 'string' || !entry.root.startsWith('/') || !entry.root.endsWith('/devbox-run') || entry.root.includes('\0') || entry.root.split('/').includes('..')) throw Error('invalid remote workspace root');
  return entry.root;
  }, deadline === undefined ? undefined : Math.max(1, Math.floor((deadline - Date.now()) / 50)));
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
    const history = readTimings(repoId); history.units ||= {}; history.commands ||= {}; history.version = 1;
    const update = (map, key, durationSec) => {
      if (!Number.isFinite(durationSec) || durationSec <= 0) return;
      const previous = map[key], samples = previous?.samples || 0;
      map[key] = { durationSec: ((previous?.durationSec || 0) * samples + durationSec) / (samples + 1), samples: samples + 1, updatedAt: new Date().toISOString() };
    };
    for (const shard of shards) {
      const units = new Map();
      for (const attempt of shard.attempts || []) for (const record of attempt.unitTimings || []) {
        if (!record.exit) units.set(record.unit, record.durationSec);
      }
      for (const [unit, duration] of units) update(history.units, unit, duration);
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
      const take = await executeRes(['take', member.slot, '--by', by, '--project', 'devbox-run', '--task', 'gc', '--for', 'expired worktree cleanup', '--pid', String(process.pid)], { state });
      if (take.code === 2 || take.code === 3) continue;
      if (take.code) {
        try {
          const info = Object.fromEntries(fs.readFileSync(path.join(sharedDir(), 'locks', `${member.slot}.d/info`), 'utf8').trim().split('\n').map(line => line.split('\t')));
          if (info.by === by && info.pid === String(process.pid)) checked(await executeRes(['return', member.slot, '--by', by], { state, cancellable: false, timeout: 30000 }), 'interrupted GC return');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      checked(take, 'GC slot acquisition');
      let clean = true;
      const data = { root, ...item, slot: member.slot, days, docker: false };
      const control = `${root}/gc/${randomUUID()}`;
      try {
        // Inventory is rechecked by gc AFTER leasing. GC itself gets the same supervisor.
        checked(await ssh(row, 'inspect', { root, control, repository: item.repository || `${root}/repos/.gc-unused`, commit: '0'.repeat(40) }, { state }), 'GC preparation');
        const op = item.maintenance ? 'maintenance' : 'gc';
        const result = await ssh(row, 'run', { workspace: root, control, command: remoteCommand(op, remoteScripts[op], data), env: {}, seconds: 120 }, { state, timeout: 140000, onOutput: emit });
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

async function shard(opts) {
  const state = cancellationState(Object.values(opts.env));
  state.sshStartDelay = (opts.shard - 1) * (500 + Math.floor(Math.random() * 1001));
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const [signal, code] of Object.entries(signals)) process.on(signal, () => state.stop(code));
  const parentWatch = setInterval(() => { try { process.kill(opts.parentPid, 0); } catch { state.stop(143); } }, 1000);
  const timer = setTimeout(() => state.stop(124), opts.timeout * 60000);
  const started = Date.now(), deadline = started + opts.timeout * 60000;
  const command = opts.command.replaceAll('{shards}', String(opts.shards)).replaceAll('{shard}', String(opts.shard));
  const by = `${opts.task}-s${opts.shard}-${process.pid}`;
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
  const remaining = () => Math.max(1, deadline - Date.now());
  const stateFile = path.join(opts.out, `shard-${opts.shard}-state.json`);
  const resEvents = [];
  const runRes = (args, cleanup = false) => executeRes(args, {
    state, cancellable: !cleanup, timeout: cleanup ? 30000 : remaining(), rawCapture: true,
    interceptStdout: line => {
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
  async function release(slot) { checked(await runRes(['return', slot, '--by', by], true), `return ${slot}`); }
  try {
    while (!state.cancel) {
      const attempt = { slot: null, host: null, exit: 1, durationSec: 0, log, returned: false };
      const attemptStart = Date.now(); let row, data, prepared = false, launched = false, clean = true;
      attempts.push(attempt);
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
        const affinity = affinities[opts.affinity];
        const affinitySlot = opts.preferSlot || affinity?.slot;
        const preferred = avoid ? (possible.find(item => item.host !== avoid.host) || possible[0]).host : opts.preferHost || affinity?.host;
        const common = ['--by', by, '--project', opts.project, '--task', opts.task, '--for', opts.task, '--pid', String(process.pid)];
        const refresh = () => refreshHostMetrics(possible, state, { timeout: Math.min(15000, remaining()) });
        await refresh();
        const diskCosts = {};
        if (opts.diskCostsSupported) for (const [host, candidate] of new Map(possible.map(item => [item.host, item]))) {
          const root = await hostRoot(candidate, state, { deadline });
          const present = JSON.parse(checked(await ssh(candidate, 'workspaces', { root, project: opts.project, key: opts.snapshot.storeKey,
            slots: possible.filter(item => item.host === host).map(item => item.slot) }, { state, timeout: remaining() }), 'workspace disk inventory'));
          for (const slot of present) if (possible.some(item => item.host === host && item.slot === slot)) diskCosts[slot] = 0;
        }
        const diskCostFile = path.join(opts.out, `shard-${opts.shard}-disk-costs.json`);
        if (opts.diskCostsSupported) writeJSON(diskCostFile, diskCosts);
        const diskArgs = opts.diskCostsSupported ? ['--disk-gib-file', diskCostFile] : [];
        attempt.diskCosts = diskCosts;
        const args = ['wait-pool', opts.pool, ...common, '--timeout', String(remaining() / 60000), ...diskArgs];
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
        if (opts.preferSlotSupported && (opts.preferSlot || warm)) args.push('--prefer-slot', opts.preferSlot || warm.slot);
        let acquire;
        const preferredSlots = opts.preferSlotSupported ? [] : warm ? [warm] : !opts.preferSupported ? choices.filter(item => item.host === preferred) : [];
        if (opts.prewarm) {
          const candidates = opts.prewarmSlots.map(slot => choices.find(item => item.slot === slot)).filter(Boolean);
          for (const candidate of candidates) {
            if (quarantinedHosts(sharedDir()).has(candidate.host) || heldSlots(sharedDir(), candidate.host).length) break;
            const take = await runRes(['take', candidate.slot, ...common, ...diskArgs]);
            if (!take.code) { acquire = { ...take, stdout: `slot=${candidate.slot}\n` }; break; }
            if (take.code !== 2 && take.code !== 3) checked(take, 'prewarm slot acquisition');
          }
          if (!acquire) { attempt.skipped = true; attempt.exit = 0; emit(`[shard ${opts.shard}] prewarm skipped: host is busy\n`); break; }
        } else if (!avoid) for (const candidate of preferredSlots) {
          const take = await runRes(['take', candidate.slot, ...common, ...diskArgs]);
          if (!take.code) { acquire = { ...take, stdout: `slot=${candidate.slot}\n` }; break; }
          if (take.code !== 2 && take.code !== 3) checked(take, 'affinity slot acquisition');
        }
        if (!acquire) {
          let refreshing;
          const timer = setInterval(() => {
            if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
          }, 60000);
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
        if (!eligible(row) || !callerAllows(row) || !internalChoices.some(item => item.slot === row.slot)) {
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
        if (opts.prewarm && (quarantinedHosts(sharedDir()).has(row.host) || heldSlots(sharedDir(), row.host).some(member => member.slot !== row.slot))) {
          attempt.skipped = true; attempt.exit = 0; emit(`[shard ${opts.shard}] prewarm skipped: host became busy\n`); break;
        }
        if (state.cancel) throw Object.assign(Error('cancelled'), { code: state.cancel });
        emit(`[shard ${opts.shard}] slot=${row.slot} host=${row.host}\n`);
        const root = await hostRoot(row, state);
        const storeName = checked(await ssh(row, 'store', { root, project: opts.project, key: opts.snapshot.storeKey, legacy: opts.repoName, anchors: opts.snapshot.anchors }, { state }), 'resolve shared store').trim();
        const workspace = `${root}/wt/${opts.project}/${storeName}/${row.slot}`;
        const repository = `${root}/repos/${opts.project}/${storeName}`;
        attempt.repository = repository;
        data = { root, workspace, repository, slot: row.slot, control: `${root}/runs/${randomUUID()}`, commit: opts.snapshot.commit, untracked: opts.snapshot.untracked };
        let inspection = JSON.parse(checked(await ssh(row, 'inspect', data, { state, timeout: Math.min(60000, remaining()) }), 'workspace inspection'));
        if (inspection.free < 73 * GiB) {
          await collectGarbage({ rows: [...readRegistry(sharedDir(), 'devbox-cn'), ...readRegistry(sharedDir(), 'devbox-cn-light')], host: row.host, state, emit, skipSlot: row.slot });
          inspection = JSON.parse(checked(await ssh(row, 'inspect', data, { state }), 'disk recheck'));
        }
        if (inspection.free < 53 * GiB) {
          attempt.diskGuard = true; emit(`[shard ${opts.shard}] disk guard refused ${row.host}: need 53 GiB free\n`);
          throw Object.assign(Error('workspace disk guard'), { code: 72 });
        }
        prepared = true;
        for (let uploadTry = 0; ; uploadTry++) {
          try {
            if (uploadTry) inspection = JSON.parse(checked(await ssh(row, 'inspect', data, { state }), 'retry inspection'));
            const feed = async (source, target, info, counter) => {
              if (info.present) return;
              const bundle = await makeBundle(source, info.known, state);
              attempt[counter] = (attempt[counter] || 0) + fs.statSync(bundle).size;
              try { checked(await ssh(row, 'bundle', target, { inputFile: bundle, state, timeout: remaining() }), 'bundle upload'); }
              finally { fs.unlinkSync(bundle); }
            };
            await feed(opts.snapshot, data, inspection, 'bundleBytes');
            checked(await ssh(row, 'checkout', data, { state, timeout: remaining() }), 'worktree checkout');
            if (opts.snapshot.patchFile && fs.statSync(opts.snapshot.patchFile).size) checked(await ssh(row, 'patch', data, { inputFile: opts.snapshot.patchFile, state, timeout: remaining() }), 'worktree patch');
            if (opts.snapshot.extra) checked(await ssh(row, 'upload', data, { inputFile: opts.snapshot.extra, state, timeout: remaining() }), 'untracked upload');
            for (const mod of opts.snapshot.modules) {
              const target = { ...data, repository: `${root}/repos/submodules/${mod.storeKey}`, commit: mod.commit,
                relative: mod.relative, parent: mod.parent, name: mod.name };
              const info = JSON.parse(checked(await ssh(row, 'inspect', target, { state }), 'submodule store inspection'));
              await feed(mod, target, info, 'submoduleBundleBytes');
              checked(await ssh(row, 'submodule', target, { state, timeout: remaining() }), 'offline submodule update');
            }
            break;
          } catch (error) {
            if (state.cancel || uploadTry || !/broken pipe|message authentication code incorrect|corrupted mac/i.test(error.message)) throw error;
            emit(`[shard ${opts.shard}] retrying interrupted upload on a fresh connection\n`);
          }
        }
        // Transfers can consume substantial space; check again before launching work.
        const ready = JSON.parse(checked(await ssh(row, 'inspect', data, { state, timeout: Math.min(60000, remaining()) }), 'post-upload disk check'));
        if (ready.free < 53 * GiB) {
          attempt.diskGuard = true;
          emit(`[shard ${opts.shard}] disk guard refused ${row.host} after upload: need 53 GiB free\n`);
          throw Object.assign(Error('post-upload workspace disk guard'), { code: 72 });
        }
        await mergeState(path.join(cacheDir(), 'devbox-affinity.json'), opts.affinity, { host: row.host, slot: row.slot, time: new Date().toISOString() });
        if (state.cancel) throw Object.assign(Error('cancelled'), { code: state.cancel });
        const hosts = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'devbox-hosts.json'), 'utf8'));
        Object.assign(attempt, cpuBudget(sharedDir(), row.host, hosts[row.host]?.cores));
        emit(`[shard ${opts.shard}] cpus=${attempt.cpus} cores=${attempt.hostCores} heavyHolders=${attempt.heavyHolders}\n`);
        let job = opts.units ? remoteCommand('units', remoteScripts.units, { control: data.control, command, units: opts.units }) : command;
        if (opts.prewarm) job = `nice -n 10 bash -c ${quote(job)}`;
        launched = true;
        const caches = { GRADLE_USER_HOME: `${root}/shared/gradle`, npm_config_cache: `${root}/shared/npm`, PNPM_STORE_DIR: `${root}/shared/pnpm`, CCACHE_DIR: `${root}/shared/ccache`, CCACHE_MAXSIZE: '20G', PIP_CACHE_DIR: `${root}/shared/pip`, DEVBOX_TOOLCHAINS: `${root}/shared/toolchains` };
        const commandStart = Date.now();
        const result = await ssh(row, 'run', { ...data, command: job, cpus: attempt.cpus, env: { ...caches, ...opts.env, ...cpuEnvironment(attempt.cpus), DEVBOX_RUN_RECEIPT: `${workspace}/.devbox-run.json` }, seconds: remaining() / 1000 }, { state, timeout: remaining() + 15000, onOutput: emit });
        attempt.commandDurationSec = (Date.now() - commandStart) / 1000;
        const loginFailure = result.code === 255 && !result.sshStarted && /permission denied|gssapi|authentication failed/i.test(result.stderr);
        if (result.code === 255 && !loginFailure) attempt.sshDropped = true;
        attempt.exit = state.cancel || result.code;
        if (result.infraFailure) attempt.infraFailure = true;
        else if (loginFailure) attempt.authenticationBlocked = true;
      } catch (error) {
        attempt.exit = state.cancel || error.code || 1; attempt.error = error.message;
        if (error.bundleDiagnostics) attempt.bundleDiagnostics = error.bundleDiagnostics;
        if (error.infraFailure) attempt.infraFailure = true;
        else if (/permission denied|gssapi|authentication failed/i.test(error.message)) attempt.authenticationBlocked = true;
        emit(`[shard ${opts.shard}] ${error.message}\n`);
      } finally {
        if (data && prepared) {
          if (attempt.sshDropped) {
            const recovery = await reconnectRun(row, data, state);
            clean = recovery === 'group-gone';
            attempt.sshRecovery = recovery;
            if (clean) emit(`[shard ${opts.shard}] SSH reconnected and confirmed remote cleanup\n`);
            else {
              attempt.remoteJobStillRunning = recovery === 'group-running';
              attempt.retainedRun = { control: data.control, target: row.target, by, pid: process.pid };
              attempt.stopCommand = `${quote(process.execPath)} ${quote(script)} stop --out ${quote(opts.out)} --run-id ${opts.runId}`;
            }
          } else if (attempt.authenticationBlocked) {
            clean = false;
          } else {
            const cleanup = await ssh(row, 'cleanup', { ...data, started: launched }, { cancellable: false, state, timeout: 35000 });
            clean = cleanup.code === 0 && cleanup.stdout.includes('group-gone');
          }
          if (!clean) {
            attempt.cleanupUnconfirmed = true;
            attempt.exit ||= 70;
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
          if (clean && launched && opts.units) {
            const timings = await ssh(row, 'timings', data, { cancellable: false, state, timeout: 30000 });
            try {
              attempt.unitTimings = JSON.parse(checked(timings, 'unit timing fetch')).units;
              if (!Array.isArray(attempt.unitTimings)) throw Error('invalid unit timing records');
              attempt.unitTimings = attempt.unitTimings.filter(record => opts.units.includes(record.unit));
            } catch (error) { attempt.timingError = error.message; emit(`[shard ${opts.shard}] ${error.message}\n`); }
          }
          if (clean && opts.artifacts.length) {
            const archive = path.join(opts.out, `shard-${opts.shard}-attempt-${attempts.length}.tar`);
            const fetched = await ssh(row, 'artifacts', { ...data, patterns: opts.artifacts }, { outputFile: archive, cancellable: false, state, timeout: opts.fetchTimeout * 60000 });
            if (fetched.code) {
              attempt.artifactExit = fetched.code; attempt.exit ||= fetched.code;
              attempt.artifactsLeft = { slot: row.slot, host: row.host, workspace: data.workspace, patterns: opts.artifacts };
              emit(`[shard ${opts.shard}] artifact fetch failed (${fetched.code}${fetched.code === 124 ? `, timed out after ${opts.fetchTimeout} min; raise --fetch-timeout` : ''}); command succeeded and artifacts remain on ${row.slot} (${row.host}) under ${data.workspace} matching ${opts.artifacts.join(' ')} until the slot is reused\n`);
            }
            else attempt.artifact = archive;
          }
        }
        if (attempt.slot && clean) {
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
        attempt.durationSec = (Date.now() - attemptStart) / 1000;
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
    try { writeJSON(stateFile, { shard: opts.shard, updatedAt: new Date().toISOString(), status: 'complete', slot: last?.slot || null, exit, resEvents }); }
    catch { state.stop(74); exit = state.cancel; }
    return { shard: opts.shard, slot: last?.slot || null, host: last?.host || null, exit, flaky, stateFile, resEvents, ...(last?.skipped ? { skipped: true } : {}),
      ...(opts.units ? { units: opts.units } : {}), ...(softExclusionsDropped ? { softExclusionsDropped } : {}), durationSec: (Date.now() - started) / 1000, log, attempts };
  } finally {
    clearTimeout(timer); clearInterval(parentWatch); fs.closeSync(fd);
    try {
      const result = redactLogFile(log, { force: true });
      if (!process.stdout.destroyed) process.stdout.write(`[shard ${opts.shard}] log-redaction files=1 masked=${result.masked}\n`);
    } catch (error) {
      if (!process.stderr.destroyed) process.stderr.write(`[shard ${opts.shard}] log redaction failed (${error.message})\n`);
    }
  }
}

async function stopRetainedRuns(out, runId) {
  const summaryFile = path.join(out, 'summary.json');
  let retained;
  if (fs.existsSync(summaryFile)) {
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    if (summary.runId !== runId) throw Error('summary identity mismatch');
    retained = summary.shards.flatMap(shard => (shard.attempts || []).filter(attempt => attempt.retainedRun));
  } else {
    retained = fs.readdirSync(out).filter(name => /^retained-\d+\.json$/.test(name)).map(name =>
      JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'))).filter(receipt => receipt.runId === runId);
  }
  if (!retained.length) return 0;
  const rows = [...readRegistry(sharedDir(), 'devbox-cn'), ...readRegistry(sharedDir(), 'devbox-cn-light')];
  const state = cancellationState();
  let exit = 0;
  for (const attempt of retained) {
    const { control, target, by, pid } = attempt.retainedRun;
    const row = rows.find(row => row.slot === attempt.slot && row.target === target);
    if (!row || !/^\/[^\r\n]*\/devbox-run\/runs\/[0-9a-f-]{36}$/.test(control) || control.split('/').includes('..'))
      throw Error('retained run no longer matches its registered slot');
    const info = path.join(lockPath(sharedDir(), row.slot), 'info');
    await withStateLock(path.join(out, `stop-${runId}-${row.slot}`), async () => {
      let hold;
      try {
        hold = Object.fromEntries(fs.readFileSync(info, 'utf8').trim().split('\n').map(line => line.split('\t')));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (hold.by !== by || hold.pid !== String(pid)) return;
      const cleanup = await ssh(row, 'cleanup', { control }, { state, timeout: 35000, noRetry: true });
      if (cleanup.code !== 0 || cleanup.stdout.trim() !== 'group-gone') {
        console.error(`BLOCKED: remote cleanup unconfirmed; retaining ${row.slot}`);
        exit ||= 70;
        return;
      }
      checked(await executeRes(['return', row.slot, '--by', by]), 'retained slot return');
      console.log('confirmed remote cleanup and returned ' + row.slot);
    });
  }
  return exit;
}

async function main(args) {
  if (args[0] === 'stop') {
    const [, outFlag, out, idFlag, runId] = args;
    if (args.length !== 5 || outFlag !== '--out' || idFlag !== '--run-id' || !/^[0-9a-f-]{36}$/.test(runId))
      throw Error('usage: devbox-run.mjs stop --out DIR --run-id UUID');
    if (JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).runId !== runId)
      throw Error('run identity mismatch');
    // Even if DIR changes between check and write, a different run ignores this name.
    try { fs.writeFileSync(path.join(out, 'stop-' + runId), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    console.log('stop requested for ' + runId);
    return await stopRetainedRuns(out, runId);
  }
  const opts = parseArgs(args);
  if (opts.help) {
    console.log('Usage: devbox-run.mjs [--project P] --task T --repo PATH [--ref COMMIT|HEAD|worktree] [--pool devbox-cn|devbox-cn-light] [--shards N|auto] [--units-file PATH] [--artifact GLOB]... [--fetch-timeout MIN] [--out DIR] [--timeout MIN] [--env K=V]... [--rerun-on-fail] [--allow-flaky] [--affinity KEY] [--prefer-host IP] [--prefer-slot ID] [--need CAP]... [--exclude-slot IDS] [--exclude-host IPS] [--exclude-reason TEXT] [--submodules] [--watch-pid PID] -- COMMAND\n       devbox-run.mjs prewarm --project P --repo PATH [--ref main] --command COMMAND [--need CAP]...\n       devbox-run.mjs gc [--host IP] [--days N]\n       devbox-run.mjs stop --out DIR --run-id UUID\nCOMMAND supports {shard}, {shards} and {units}. Timeout includes queue/upload/run; cleanup follows. See references/devbox-run.md.');
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
    } finally { clearInterval(watch); }
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
    if (state.cancel) return state.cancel;
    if (opts.unitsFile) opts.units = parseUnits(fs.readFileSync(opts.unitsFile, 'utf8'));
    else if (opts.command.includes('{units}')) opts.units = parseUnits(discoverUnits(opts.snapshot.files).join('\n'));
    if (opts.units?.some(unit => !opts.snapshot.files.includes(unit))) throw Error('unit is absent from the source snapshot');
    delete opts.snapshot.files;
    const commandKey = createHash('sha256').update(JSON.stringify([opts.command, opts.units || null, Boolean(opts.prewarm)])).digest('hex');
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
      time: new Date().toISOString(), exit, mode: opts.prewarm ? 'prewarm' : 'run', requestedShards, shardPlan: plan, shards };
    try { await recordTimings(opts.snapshot.storeKey, commandKey, shards); }
    catch (error) { summary.timingError = error.message; summary.exit = exit ||= 74; console.error(`timing history: ${error.message}`); }
    writeJSON(path.join(opts.out, 'summary.json'), summary);
    for (const item of shards.filter(item => item.flaky)) {
      fs.appendFileSync(path.join(cacheDir(), 'flaky-log.jsonl'), `${JSON.stringify({ project: opts.project, task: opts.task, commandHash: summary.commandHash, shard: item.shard, hosts: item.attempts.filter(a => !a.diskGuard).map(a => a.host), time: summary.time })}\n`, { mode: 0o600 });
    }
    console.log(`summary=${path.join(opts.out, 'summary.json')} exit=${exit}`);
    return exit;
  } finally { clearInterval(watch); fs.rmSync(temp, { recursive: true, force: true }); }
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
