#!/usr/bin/env node
// Linux work runs under a public res hold; this process never takes a mini lane.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

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
  const opts = { ref: 'HEAD', pool: 'devbox-cn', shards: 1, timeout: 120, artifacts: [], env: {}, days: 7, need: [], excludeSlot: [], excludeHost: [] };
  if (args[0] === 'gc') { opts.gc = true; args = args.slice(1); }
  const names = new Map(['project', 'task', 'repo', 'ref', 'pool', 'shards', 'out', 'timeout', 'prefer-host', 'watch-pid', 'affinity', 'host', 'days'].map(n => [`--${n}`, n.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { opts.command = args.slice(i + 1).join(' '); break; }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--submodules') { opts.submodules = true; continue; }
    if (arg === '--rerun-on-fail') { opts.rerunOnFail = true; continue; }
    if (arg === '--allow-flaky') { opts.allowFlaky = true; continue; }
    if (!names.has(arg) && !['--env', '--artifact', '--need', '--exclude-slot', '--exclude-host'].includes(arg)) throw Error(`unknown option ${arg}`);
    const value = args[++i];
    if (value === undefined || value === '--') throw Error(`missing value for ${arg}`);
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
  opts.days = Number(opts.days);
  if (!Number.isFinite(opts.days) || opts.days < 1) throw Error('--days must be at least 1');
  if (opts.gc) return opts;
  for (const name of (opts.project === undefined ? ['task'] : ['project', 'task'])) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(opts[name] || '')) throw Error(`--${name} needs a simple identifier`);
  if (!opts.repo || !opts.command?.trim()) throw Error('--repo and a command after -- are required');
  if (!['devbox-cn', 'devbox-cn-light'].includes(opts.pool)) throw Error('unsupported pool');
  opts.shards = Number(opts.shards); opts.timeout = Number(opts.timeout);
  if (!Number.isInteger(opts.shards) || opts.shards < 1 || opts.shards > 64) throw Error('--shards must be 1..64');
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0 || opts.timeout > 120) throw Error('--timeout must be >0 and <=120 minutes');
  if (opts.watchPid && (!/^\d+$/.test(opts.watchPid) || Number(opts.watchPid) < 2)) throw Error('invalid --watch-pid');
  opts.repo = fs.realpathSync(opts.repo);
  opts.repoName = path.basename(opts.repo).replace(/[^A-Za-z0-9_.-]/g, '_');
  opts.out = path.resolve(opts.out || path.join(os.tmpdir(), `devbox-run-output-${Date.now()}-${process.pid}`));
  return opts;
}

export function readRegistry(dir, pool) {
  const rows = fs.readFileSync(path.join(dir, 'resources.tsv'), 'utf8').trim().split('\n').map(line => {
    const [slot, kind, policy, , ...description] = line.split('\t');
    const addresses = [...description.join('\t').matchAll(/\b([A-Za-z_][A-Za-z0-9_.-]*)@((?:\d{1,3}\.){3}\d{1,3})\b/g)];
    const unique = [...new Set(addresses.map(m => `${m[1]}@${m[2]}`))];
    const caps = /\bcaps=([A-Za-z0-9_,.-]+)/.exec(description.join(' '))?.[1].split(',') || [];
    return { slot, kind, policy, caps, ...(unique.length === 1 ? { user: addresses[0][1], host: addresses[0][2], target: unique[0] } : {}) };
  });
  const pattern = pool === 'devbox-cn' ? /^devbox-cn-\d+$/ : /^devbox-cn-light(?:-\d+)?$/;
  return rows.filter(row => row.kind === 'remote' && row.policy === 'open' && pattern.test(row.slot));
}

// Output is line-buffered so assignments split across SSH chunks are still masked.
function lineSink(write, values = [], intercept) {
  const decoder = new StringDecoder('utf8'); let pending = '', dropping = false;
  const redact = line => {
    for (const value of values.filter(Boolean).sort((a, b) => b.length - a.length)) line = line.replaceAll(value, '[MASKED]');
    if (sensitive.test(line) && /[=:]|bearer\s/i.test(line)) return '[MASKED sensitive output]';
    return line;
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

function execute(file, args, { input, inputFile, outputFile, onOutput, timeout = 60000, state, cancellable = true, rawCapture = !onOutput && !outputFile, interceptStderr } = {}) {
  return new Promise(resolve => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, spawnError;
    const sink = outputFile ? fs.createWriteStream(outputFile, { mode: 0o600 }) : null;
    const rawDecoder = new StringDecoder('utf8');
    const out = lineSink(text => { stdout = (stdout + text).slice(-2 * 1024 * 1024); onOutput?.(text); }, state?.values);
    const err = lineSink(text => { stderr = (stderr + text).slice(-2 * 1024 * 1024); onOutput?.(text); }, state?.values, interceptStderr);
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

function checked(result, label) {
  if (result.code) { const error = Error(`${label} failed (${result.code})${result.stderr ? `: ${result.stderr.trim()}` : ''}`); error.code = result.code; error.infraFailure = result.infraFailure; throw error; }
  return result.stdout;
}

function remoteCommand(operation, python, data) {
  return `# devbox-run:${operation}\npython3 -c ${quote(python)} ${quote(Buffer.from(JSON.stringify(data)).toString('base64'))}`;
}
const pythonHeader = 'import os, sys, json, base64, pathlib, time, signal\n# Source-only worktrees: never run git-lfs smudge (the bare store has no remote; boxes differ in global git-lfs setup).\nimport shutil as _sh\n_lfs=[("filter.lfs.smudge","git-lfs smudge --skip -- %f"),("filter.lfs.process","git-lfs filter-process --skip")] if _sh.which("git-lfs") else []\n_lfs.append(("filter.lfs.required","false"))\n_lfs.append(("core.hooksPath","/dev/null"))  # runner checkouts never run repo hooks (e.g. git-lfs post-checkout)\nos.environ.update({"GIT_LFS_SKIP_SMUDGE":"1","GIT_CONFIG_COUNT":str(len(_lfs))})\nif not _sh.which("git-lfs"): os.environ.update({"GIT_CONFIG_GLOBAL":"/dev/null","GIT_CONFIG_NOSYSTEM":"1"})  # no git-lfs: drop any global/system lfs driver; undefined filters are no-ops\nfor _i,(_k,_v) in enumerate(_lfs): os.environ["GIT_CONFIG_KEY_%d"%_i]=_k; os.environ["GIT_CONFIG_VALUE_%d"%_i]=_v\nd=json.loads(base64.b64decode(sys.argv[1]))\n';

export const remoteScripts = {
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
    else:
        ws.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['git','--git-dir='+str(repo),'worktree','add','--detach',str(ws),d['commit']],check=True,stdout=subprocess.DEVNULL)
    meta.write_text(json.dumps({'slot':d['slot'],'repository':str(repo),'lastUsed':time.time(),'untracked':d['untracked']}))
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
        shell=bootstrap+'\\n'+exports+'\\n'+d['command']
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
  cleanup: pythonHeader + `ctl=pathlib.Path(d['control']); ctl.mkdir(parents=True, exist_ok=True)
run_id=ctl.name
def read_own(file):
    record=json.loads(file.read_text())
    if record.get('run')!=run_id: sys.exit(70)
    return record
for file in ('owner.json','group.json','done.json'):
    if (ctl/file).exists(): read_own(ctl/file)
(ctl/'cancel').touch()
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
    if (!transient || (opts.state?.cancel && opts.cancellable !== false)) return result;
    if (retry === 3) return { ...result, infraFailure: true, stderr: `SSH establishment failed after 4 attempts: ${result.stderr}` };
    await pause(2000 + Math.floor(Math.random() * 8001));
  }
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

async function snapshot(opts, temp, state, ancestors = new Set()) {
  const git = async args => checked(await execute('git', ['-C', opts.repo, ...args], { state, rawCapture: true }), 'git snapshot');
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
    untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    if (untracked.some(name => name.endsWith('/'))) throw Error('nested untracked repositories cannot be archived');
    files.push(...untracked, ...(await git(['diff', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean));
  }
  files = [...new Set(files)];
  if (files.some(name => sensitiveFile.test(name))) throw Error('snapshot contains credential-related paths; use a source-only ref/worktree');
  if (untracked.some(name => path.basename(name).toLowerCase() === '.npmrc')) throw Error('untracked .npmrc refused');
  const checker = fileURLToPath(new URL('./lib/devbox-source-check.py', import.meta.url));
  const verdict = await execute('python3', [checker, opts.repo, commit, opts.ref], { state, timeout: 300000 });
  if (verdict.code && verdict.stdout.trim()) {
    const [file, key] = JSON.parse(verdict.stdout);
    throw Error('credential setting refused in ' + JSON.stringify(file) + ' (' + key + ')');
  }
  checked(verdict, 'source content check');
  if ((await git(['rev-list', '--full-history', '--max-count=1', commit, '--', ...privateHistoryPaths])).trim())
    throw Error('bundle history contains credential-related paths; use a source-only history');
  if ((await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true')
    throw Error('a complete source history is required to create an incremental bundle');
  if (files.includes('.devbox-run.json')) throw Error('reserved runner manifest path in source');
  const exportRepo = path.join(temp, 'export.git');
  checked(await execute('git', ['init', '--bare', exportRepo], { state }), 'bundle staging repository');
  const objects = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim();
  fs.writeFileSync(path.join(exportRepo, 'objects/info/alternates'), `${objects}\n`);
  checked(await execute('git', ['--git-dir', exportRepo, 'update-ref', 'refs/heads/export', commit], { state }), 'bundle export ref');
  let patchFile, extra;
  if (opts.ref === 'worktree') {
    patchFile = path.join(temp, 'worktree.patch');
    checked(await execute('git', ['-C', opts.repo, 'diff', '--binary', ...(opts.submodules ? ['--ignore-submodules=all'] : []), '--no-ext-diff', '--no-textconv', 'HEAD'], { outputFile: patchFile, state }), 'worktree diff');
    if (untracked.length) {
      const list = path.join(temp, 'untracked.list'); fs.writeFileSync(list, `${untracked.join('\0')}\0`);
      extra = path.join(temp, 'untracked.tar');
      checked(await execute('tar', ['-C', opts.repo, '--null', '-T', list, '-cf', extra], { state, timeout: 300000 }), 'untracked archive');
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
        const child = await snapshot({ repo, ref, submodules: true }, fs.mkdtempSync(path.join(temp, 'mod-')), state, new Set([...ancestors, storeKey + commit]));
        const { modules: nested, ...transfer } = child;
        modules.push({ ...transfer, name, relative, parent: '' }, ...nested.map(m => ({ ...m, parent: path.posix.join(relative, m.parent) })));
      }
    }
  }
  const anchors = (await git(['rev-list', '--first-parent', '--max-count=64', commit])).trim().split('\n');
  return { commit, anchors, storeKey, modules, untracked, exportRepo, patchFile, extra, temp };
}

async function makeBundle(snapshot, known, state) {
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
    const file = path.join(snapshot.temp, 'transfer-' + randomUUID() + '.bundle');
    const result = await git(['bundle', 'create', file, 'refs/heads/export', ...exclusions]);
    if (!result.code) return file;
    fs.rmSync(file, { force: true });
    if (state.cancel || !exclusions.length || result.code === 124) checked(result, exclusions.length ? 'incremental bundle' : 'full bundle');
  }
}

// Local short critical sections merge shared JSON without losing another shard's host/key.
async function withStateLock(file, operation) {
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt === 1500) throw error;
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

async function hostRoot(row, state) {
  const cacheFile = path.join(cacheDir(), 'devbox-hosts.json');
  return withStateLock(path.join(cacheDir(), `devbox-probe-${row.host}`), async () => {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let entry = cache[row.host];
  if (!entry?.root || entry.user !== row.user) {
    entry = JSON.parse(checked(await ssh(row, 'probe', { user: row.user }, { state }), 'root probe').trim());
    await mergeState(cacheFile, row.host, entry);
  }
  if (typeof entry.root !== 'string' || !entry.root.startsWith('/') || !entry.root.endsWith('/devbox-run') || entry.root.includes('\0') || entry.root.split('/').includes('..')) throw Error('invalid remote workspace root');
  return entry.root;
  });
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
      const take = await execute(resCommand(), ['take', member.slot, '--by', by, '--project', 'devbox-run', '--task', 'gc', '--for', 'expired worktree cleanup', '--pid', String(process.pid)], { state });
      if (take.code === 2 || take.code === 3) continue;
      if (take.code) {
        try {
          const info = Object.fromEntries(fs.readFileSync(path.join(sharedDir(), 'locks', `${member.slot}.d/info`), 'utf8').trim().split('\n').map(line => line.split('\t')));
          if (info.by === by && info.pid === String(process.pid)) checked(await execute(resCommand(), ['return', member.slot, '--by', by], { state, cancellable: false, timeout: 30000 }), 'interrupted GC return');
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
        if (clean) checked(await execute(resCommand(), ['return', member.slot, '--by', by], { state, cancellable: false, timeout: 30000 }), 'GC slot return');
      }
    }
  }
  emit(`reclaimedGiB=${(reclaimed / GiB).toFixed(3)}\n`);
  return reclaimed;
}

function cancellationState(values = []) {
  const state = { children: new Set(), cancel: 0, values };
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
  const remaining = () => Math.max(1, deadline - Date.now());
  const runRes = (args, cleanup = false) => execute(resCommand(), args, { state, cancellable: !cleanup, timeout: cleanup ? 30000 : remaining() });
  async function release(slot) { checked(await runRes(['return', slot, '--by', by], true), `return ${slot}`); }
  try {
    while (!state.cancel) {
      const attempt = { slot: null, host: null, exit: 1, durationSec: 0, log, returned: false };
      const attemptStart = Date.now(); let row, data, prepared = false, launched = false, clean = true;
      attempts.push(attempt);
      try {
        let rows = readRegistry(sharedDir(), opts.pool);
        if (!rows.length) throw Error('no open slots in pool');
        const eligible = item => opts.need.every(cap => item.caps.includes(cap))
          && !opts.excludeSlot.includes(item.slot) && !opts.excludeHost.includes(item.host);
        rows = rows.filter(eligible);
        if (!rows.length) throw Error('no open slot provides all required capabilities');
        // Bad descriptions must not cause a lease or an implicit local-user SSH login.
        if (rows.some(item => !item.target)) throw Error('open pool registry row lacks an unambiguous user@ip description');
        const choices = rows.filter(item => item.slot !== avoid?.slot && !failedSlots.has(item.slot) && !diskHosts.has(item.host));
        if (!choices.length) throw Error('no different open slot available for retry');
        let affinities = {}; try { affinities = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'devbox-affinity.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const affinity = affinities[opts.affinity];
        const preferred = avoid ? (choices.find(item => item.host !== avoid.host) || choices[0]).host : opts.preferHost || affinity?.host;
        const common = ['--by', by, '--project', opts.project, '--task', opts.task, '--for', opts.task, '--pid', String(process.pid)];
        const args = ['wait-pool', opts.pool, ...common, '--timeout', String(remaining() / 60000)];
        const skipSlots = new Set([...opts.excludeSlot, ...failedSlots]);
        const skipHosts = new Set([...opts.excludeHost, ...diskHosts]);
        if (avoid && choices.some(item => item.host !== avoid.host)) skipHosts.add(avoid.host);
        if (opts.excludeSlotSupported && skipSlots.size) args.push('--exclude-slot', [...skipSlots].join(','));
        if (opts.excludeHostSupported && skipHosts.size) args.push('--exclude-host', [...skipHosts].join(','));
        if (preferred && opts.preferSupported) args.push('--prefer-host', preferred);
        if (opts.needSupported && opts.need.length) args.push('--need', opts.need.join(','));
        const warm = choices.find(item => item.host === preferred && item.slot === affinity?.slot);
        if (warm && opts.preferSlotSupported) args.push('--prefer-slot', warm.slot);
        let acquire;
        const preferredSlots = opts.preferSlotSupported ? [] : warm ? [warm] : !opts.preferSupported ? choices.filter(item => item.host === preferred) : [];
        if (!avoid) for (const candidate of preferredSlots) {
          const take = await runRes(['take', candidate.slot, ...common]);
          if (!take.code) { acquire = { ...take, stdout: `slot=${candidate.slot}\n` }; break; }
          if (take.code !== 2 && take.code !== 3) checked(take, 'affinity slot acquisition');
        }
        acquire ||= await runRes(args);
        const match = /^slot=(\S+)$/m.exec(acquire.stdout);
        if (match) attempt.slot = match[1];
        checked(acquire, 'slot acquisition');
        if (!attempt.slot) throw Error('res did not return slot=');
        rows = readRegistry(sharedDir(), opts.pool);
        row = rows.find(item => item.slot === attempt.slot);
        if (!row?.target) throw Error('acquired slot is no longer an open mapped pool member');
        if (!eligible(row) || !choices.some(item => item.slot === row.slot) || (avoid && choices.some(item => item.host !== avoid.host) && row.host === avoid.host)) {
          await release(row.slot); attempt.slot = null;
          // Old controllers have no preference/exclusion flag. Keep arbitration in res.
          row = choices.find(item => avoid && item.host !== avoid.host) || choices[0];
          const result = await runRes(['wait', row.slot, ...common, '--timeout', String(remaining() / 60000)]);
          if (!result.code) attempt.slot = row.slot;
          checked(result, 'alternate slot acquisition');
        }
        attempt.host = row.host;
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
        launched = true;
        const caches = { GRADLE_USER_HOME: `${root}/shared/gradle`, npm_config_cache: `${root}/shared/npm`, PNPM_STORE_DIR: `${root}/shared/pnpm`, CCACHE_DIR: `${root}/shared/ccache`, CCACHE_MAXSIZE: '20G', PIP_CACHE_DIR: `${root}/shared/pip`, DEVBOX_TOOLCHAINS: `${root}/shared/toolchains` };
        const result = await ssh(row, 'run', { ...data, command, env: { ...caches, ...opts.env }, seconds: remaining() / 1000 }, { state, timeout: remaining() + 15000, onOutput: emit });
        attempt.exit = state.cancel || result.code;
        if (result.infraFailure) attempt.infraFailure = true;
        else if (/permission denied|gssapi|authentication failed/i.test(result.stderr)) attempt.authenticationBlocked = true;
      } catch (error) {
        attempt.exit = state.cancel || error.code || 1; attempt.error = error.message;
        if (error.infraFailure) attempt.infraFailure = true;
        else if (/permission denied|gssapi|authentication failed/i.test(error.message)) attempt.authenticationBlocked = true;
        emit(`[shard ${opts.shard}] ${error.message}\n`);
      } finally {
        if (data && prepared) {
          const cleanup = await ssh(row, 'cleanup', { ...data, started: launched }, { cancellable: false, state, timeout: 35000 });
          clean = cleanup.code === 0 && cleanup.stdout.includes('group-gone');
          if (!clean) { attempt.cleanupUnconfirmed = true; attempt.exit ||= 70; emit(`[shard ${opts.shard}] BLOCKED: remote cleanup unconfirmed; retaining ${attempt.slot}\n`); }
          if (clean && opts.artifacts.length) {
            const archive = path.join(opts.out, `shard-${opts.shard}-attempt-${attempts.length}.tar`);
            const fetched = await ssh(row, 'artifacts', { ...data, patterns: opts.artifacts }, { outputFile: archive, cancellable: false, state, timeout: 60000 });
            if (fetched.code) { attempt.artifactExit = fetched.code; attempt.exit ||= fetched.code; emit(`[shard ${opts.shard}] artifact fetch failed (${fetched.code})\n`); }
            else attempt.artifact = archive;
          }
        }
        if (attempt.slot && clean) {
          try { await release(attempt.slot); attempt.returned = true; } catch (error) { attempt.exit ||= 70; attempt.returnError = error.message; emit(`[shard ${opts.shard}] BLOCKED: ${error.message}\n`); }
        }
        // Interrupted res can acquire before publishing slot=. Recover only this PID/holder.
        if (!attempt.slot) {
          for (const member of readRegistry(sharedDir(), opts.pool)) {
            const info = path.join(sharedDir(), 'locks', `${member.slot}.d`, 'info');
            try {
              const fields = Object.fromEntries(fs.readFileSync(info, 'utf8').trim().split('\n').map(line => line.split('\t')));
              if (fields.by === by && fields.pid === String(process.pid)) await release(member.slot);
            } catch (error) { if (error.code !== 'ENOENT') { attempt.exit ||= 70; attempt.returnError = error.message; } }
          }
        }
        attempt.durationSec = (Date.now() - attemptStart) / 1000;
      }
      if (state.cancel || attempt.cleanupUnconfirmed || attempt.returnError || attempt.authenticationBlocked || attempt.infraFailure) break;
      if (attempt.diskGuard && diskRetries++ === 0) { diskHosts.add(row.host); avoid = row; continue; }
      if (attempt.exit && !attempt.diskGuard && opts.rerunOnFail && reruns++ === 0 && row) {
        firstFailure = attempt.exit; failedSlots.add(row.slot); avoid = row; continue;
      }
      break;
    }
    const last = attempts.at(-1);
    const flaky = Boolean(firstFailure && last?.exit === 0);
    return { shard: opts.shard, slot: last?.slot || null, host: last?.host || null, exit: state.cancel || (flaky && !opts.allowFlaky ? firstFailure : last?.exit ?? 1), flaky, durationSec: (Date.now() - started) / 1000, log, attempts };
  } finally { clearTimeout(timer); clearInterval(parentWatch); fs.closeSync(fd); }
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
    return 0;
  }
  const opts = parseArgs(args);
  if (opts.help) {
    console.log('Usage: devbox-run.mjs [--project P] --task T --repo PATH [--ref COMMIT|HEAD|worktree] [--pool devbox-cn|devbox-cn-light] [--shards N] [--artifact GLOB]... [--out DIR] [--timeout MIN] [--env K=V]... [--rerun-on-fail] [--allow-flaky] [--affinity KEY] [--prefer-host IP] [--need CAP]... [--exclude-slot IDS] [--exclude-host IPS] [--submodules] [--watch-pid PID] -- COMMAND\n       devbox-run.mjs gc [--host IP] [--days N]\n       devbox-run.mjs stop --out DIR --run-id UUID\nCOMMAND supports {shard} and {shards}. Timeout includes queue/upload/run; cleanup follows. See references/devbox-run.md.');
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
    const help = await execute(resCommand(), ['wait-pool', '--help'], { state });
    opts.preferSupported = /--prefer-host\b/.test(help.stdout + help.stderr);
    opts.excludeSlotSupported = (help.stdout + help.stderr).includes('--exclude-slot');
    opts.excludeHostSupported = (help.stdout + help.stderr).includes('--exclude-host');
    opts.needSupported = /--need\b/.test(help.stdout + help.stderr);
    opts.preferSlotSupported = /--prefer-slot\b/.test(help.stdout + help.stderr);
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
      child.send({ ...opts, shard: index + 1, parentPid: process.pid });
      if (state.cancel) signalChild('SIGTERM');
    })));
    const exit = state.cancel || shards.find(item => item.exit)?.exit || 0;
    const summary = { runId, project: opts.project, task: opts.task, commit: opts.snapshot.commit, commandHash: createHash('sha256').update(opts.command).digest('hex'), time: new Date().toISOString(), exit, shards };
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
