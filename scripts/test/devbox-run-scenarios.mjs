#!/usr/bin/env node
// PATH shims exercise the real Git bundle/worktree/overlay code without network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, readRegistry, remoteScripts, storeIdentity } from '../devbox-run.mjs';

import { makeSubmoduleFixture } from './devbox-submodule-fixture.mjs';

const script = fileURLToPath(new URL('../devbox-run.mjs', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-scenarios-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let count = 0;
function fixture(options = {}) {
  const dir = path.join(temp, `case-${++count}`), bin = path.join(dir, 'bin'), shared = path.join(dir, 'shared'), repo = path.join(dir, 'source');
  for (const p of [bin, shared, repo, path.join(shared, 'locks')]) fs.mkdirSync(p, { recursive: true });
  const config = { dir, shared, hosts: ['192.0.2.1', '192.0.2.2'], ...options };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const rows = [
    'devbox-cn-1\tremote\topen\t-\tfirst alice@192.0.2.1 caps=node',
    'devbox-cn-2\tremote\topen\t-\tsecond bob@192.0.2.2 caps=node,vesdk-android',
    'devbox-cn-light\tremote\topen\t-\tfirst alice@192.0.2.1 caps=node',
    'devbox-cn-light-2\tremote\topen\t-\tsecond bob@192.0.2.2 caps=node,vesdk-android',
    'devbox-cn-3\tremote\tnever\t-\tretired nobody@192.0.2.3 caps=node',
    'devbox-cn-4\tremote\task-user\t-\tpending nobody@192.0.2.4 caps=node',
  ];
  fs.writeFileSync(path.join(shared, 'resources.tsv'), rows.join('\n') + '\n');
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'first\n'); fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\nnode_modules/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(bin, 'res'), `#!${process.execPath}\n${fakeRes}`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}\n${fakeSsh}`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}\n${shimHeader}\nif(process.argv.slice(2).join(' ')!=='image prune --force')process.exit(9);event('docker-prune');`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, RES_DIR: shared, RULES_SHARED: shared, RES_COMMAND: 'res', DEVBOX_FIXTURE: path.join(dir, 'config.json') };
  return { dir, repo, shared, env, config, events: () => fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

const shimHeader = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const c=JSON.parse(fs.readFileSync(process.env.DEVBOX_FIXTURE,'utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const event=(op,extra={})=>fs.appendFileSync(path.join(c.dir,'events.jsonl'),JSON.stringify({op,...extra})+'\n');
const flag=(args,name)=>args[args.indexOf(name)+1];
`;
const fakeRes = shimHeader + String.raw`
(async()=>{
const a=process.argv.slice(2), op=a[0], by=flag(a,'--by');
if(a.includes('--help')) {console.log('res wait-pool'+(c.legacy?'':' --prefer-host IP --need CAP --exclude-slot IDS --exclude-host IPS'+(c.preferSlot?' --prefer-slot SLOT':'')));return;}
const rows=fs.readFileSync(path.join(c.shared,'resources.tsv'),'utf8').trim().split('\n').map(l=>{const [slot,kind,policy,,desc]=l.split('\t');return {slot,kind,policy,host:desc.match(/@(\d+\.\d+\.\d+\.\d+)/)?.[1],caps:desc.match(/caps=([\w,-]+)/)?.[1].split(',')||[]};});
if(op==='return'){
 const lock=path.join(c.shared,'locks',a[1]+'.d');
 if(fs.existsSync(lock)){const info=fs.readFileSync(path.join(lock,'info'),'utf8');if(!info.includes('by\t'+by+'\n'))process.exit(9);fs.rmSync(lock,{recursive:true});}
 event('return',{slot:a[1],by});return;
}
if(!['take','wait','wait-pool'].includes(op))process.exit(9);
event('acquire-call',{args:a,pid:flag(a,'--pid')});
let ids=rows.filter(r=>r.policy==='open'&&(op==='wait-pool'?(a[1].endsWith('light')?/^devbox-cn-light(?:-\d+)?$/.test(r.slot):/^devbox-cn-\d+$/.test(r.slot)):r.slot===a[1]));
for (const [opt,field] of [['--exclude-slot','slot'],['--exclude-host','host']]) if(a.includes(opt))ids=ids.filter(r=>!flag(a,opt).split(',').includes(r[field]));
if(a.includes('--need'))ids=ids.filter(r=>flag(a,'--need').split(',').every(cap=>r.caps.includes(cap)));
if(a.includes('--prefer-host')) ids.sort((x,y)=>Number(y.host===flag(a,'--prefer-host'))-Number(x.host===flag(a,'--prefer-host')));
if(a.includes('--prefer-slot')) ids.sort((x,y)=>Number(y.slot===flag(a,'--prefer-slot'))-Number(x.slot===flag(a,'--prefer-slot')));
let cancelled=false;process.on('SIGTERM',()=>{cancelled=true;});
const deadline=Date.now()+Number(a.includes('--timeout')?flag(a,'--timeout'):0)*60000;
do {
 for(const r of ids){const lock=path.join(c.shared,'locks',r.slot+'.d');try{fs.mkdirSync(lock);}catch(e){if(e.code==='EEXIST')continue;throw e;}
  fs.writeFileSync(path.join(lock,'info'),'by\t'+by+'\npid\t'+flag(a,'--pid')+'\n');event('take',{slot:r.slot,by,pid:Number(flag(a,'--pid'))});
  if(c.cancelAcquire){process.kill(Number(flag(a,'--pid')),'SIGTERM');await sleep(100);process.exit(143);}
  if(op==='wait-pool')console.log('slot='+r.slot);return;
 }
 if(op==='take'||cancelled)break;await sleep(25);
}while(Date.now()<deadline);
process.exit(cancelled?143:2);
})().catch(e=>{console.error(e.message);process.exit(1)});
`;

const fakeSsh = shimHeader + String.raw`
(async()=>{
const args=process.argv.slice(2), command=args.at(-1),target=args.at(-2),host=target.split('@')[1];
const op=command.match(/^# devbox-run:([\w-]+)/)?.[1];
if(!op)throw Error('unmarked SSH');
if(!args.includes('BatchMode=yes')||!args.includes('ServerAliveInterval=15')||!args.includes('ServerAliveCountMax=4'))throw Error('missing SSH guard');
if(!args.includes('ControlMaster=no')||!args.includes('ControlPath=none'))throw Error('SSH multiplexing must be disabled');
let d={};if(op!=='upload')d=JSON.parse(Buffer.from(command.match(/'([A-Za-z0-9+/=]+)'$/)[1],'base64').toString());
event(op,{host,target,slot:d.slot,workspace:d.workspace,control:d.control,env:op==='run'?d.env:undefined});
if(c.authFailures){
 const file=path.join(c.dir,'auth-count');const count=fs.existsSync(file)?Number(fs.readFileSync(file)):0;
 if(count<c.authFailures){fs.writeFileSync(file,String(count+1));console.error(c.authMessage||'Permission denied (gssapi-with-mic)');process.exit(255);}
}
if(c.postStartFailure&&op==='run'){
 console.error(command.match(/'(DEVBOX_STARTED_[^']+)'/)[1]);console.error('Connection closed by remote host');process.exit(255);
}
if(op==='probe') {
 const root=path.join(c.dir,'remote',host,c.dataDisk===false?'home':'data00',d.user,'devbox-run');fs.mkdirSync(root,{recursive:true});
 console.log(JSON.stringify({root,user:d.user,fs:c.dataDisk===false?'/':'/data00',freeGiB:100,totalGiB:200,cores:8,memGiB:32,probedAt:new Date().toISOString()}));return;
}
if(op==='bundle'&&c.uploadRetry&&!fs.existsSync(path.join(c.dir,'retried'))){fs.writeFileSync(path.join(c.dir,'retried'),'1');process.stdin.resume();await new Promise(r=>process.stdin.on('end',r));console.error(c.uploadRetry);process.exit(255);}
if(op==='run') {
 fs.mkdirSync(d.control,{recursive:true});
 if(fs.existsSync(path.join(d.control,'cancel'))){fs.writeFileSync(path.join(d.control,'done.json'),JSON.stringify({gone:true}));process.exit(143);}
 const attemptFile=path.join(c.dir,'run-count-'+host);const n=fs.existsSync(attemptFile)?Number(fs.readFileSync(attemptFile)):0;fs.writeFileSync(attemptFile,String(n+1));
 let cmd=d.command;
 if(c.failHost===host)cmd='exit 7';
 const child=cp.spawn('/bin/bash',['-c',cmd],{cwd:d.workspace,env:{...process.env,...d.env},detached:true,stdio:['ignore','inherit','inherit']});
 fs.writeFileSync(path.join(d.control,'group.json'),JSON.stringify({pid:child.pid}));
 event('group',{pid:child.pid,host});
 let cancelled=false;
 const stop=()=>{cancelled=true;try{process.kill(-child.pid,'SIGTERM')}catch{}};
 process.on('SIGTERM',stop);process.on('SIGHUP',stop);
 const timer=setTimeout(stop,d.seconds*1000);
 let code=await new Promise(r=>child.on('exit',(code,signal)=>r(code??143)));
 clearTimeout(timer);try{process.kill(-child.pid,'SIGKILL')}catch{}
 fs.writeFileSync(path.join(d.control,'done.json'),JSON.stringify({gone:true}));
 process.exit(cancelled?143:code);
}
if(op==='cleanup'){
 if(c.badCleanup)process.exit(70);
 fs.mkdirSync(d.control,{recursive:true});fs.writeFileSync(path.join(d.control,'cancel'),'');
 event('group-gone',{host});console.log('group-gone');return;
}
if(op==='artifacts'&&c.badArtifact)process.exit(66);
if(op==='inspect') {
 const result=cp.spawnSync('/bin/bash',['-c',command],{encoding:'utf8'});
 if(result.status){process.stderr.write(result.stderr);process.exit(result.status);}
 const info=JSON.parse(result.stdout);info.free=((c.diskFailHost===host || (c.diskAfterUpload===host && fs.existsSync(path.join(d.workspace,'.git'))))?40:100)*1024**3;
 console.log(JSON.stringify(info));return;
}
const child=cp.spawn('/bin/bash',['-c',command],{stdio:'inherit'});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
process.exit(await new Promise(r=>child.on('exit',code=>r(code??143))));
})().catch(e=>{console.error(e.stack);process.exit(1)});
`;

async function run(f, extra = [], command = 'echo {shard}/{shards}', signalWhen, onSignal = child => child.kill('SIGTERM')) {
  const out = path.join(f.dir, `out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const args = extra[0] === 'gc' ? extra : ['--project', 'fixture', '--task', 'scenario', '--repo', f.repo, '--out', out, '--timeout', '1', ...extra, '--', command];
  const child = spawn(process.execPath, [script, ...args], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  let finished = false;
  const closed = new Promise(resolve => child.on('close', code => { finished = true; resolve(code); }));
  let watchdog = setTimeout(() => child.kill('SIGKILL'), 90000), code;
  try {
    if (signalWhen) {
      const deadline = Date.now() + 60000;
      while (!signalWhen(f.events())) { assert.ok(!finished && Date.now() < deadline, `fixture did not reach signal point: ${stdout}${stderr}`); await sleep(25); }
      onSignal(child, out);
    }
    code = await closed;
  } finally { if (!finished) { child.kill('SIGTERM'); await closed; } clearTimeout(watchdog); }
  const file = path.join(out, 'summary.json');
  return { code, stdout, stderr, out, summary: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null };
}
function returned(f) {
  assert.deepEqual(fs.readdirSync(path.join(f.shared, 'locks')), [], 'all fixture leases returned');
  const events = f.events();
  for (const take of events.filter(e => e.op === 'take')) assert.ok(events.some(e => e.op === 'return' && e.slot === take.slot && e.by === take.by), 'each take returned by its owner');
}
function ok(result) { assert.equal(result.code, 0, result.stdout + result.stderr); }
function workspace(f, host = '192.0.2.1', slot = 'devbox-cn-1') {
  const cache = JSON.parse(fs.readFileSync(path.join(f.shared, 'devbox-hosts.json')));
  const dir = path.join(cache[host].root, 'wt/fixture');
  return path.join(dir, fs.readdirSync(dir)[0], slot);
}

async function bundleRecovery() {
  const f = fixture(); const initial = await run(f); ok(initial);
  const store = initial.summary.shards[0].attempts[0].repository;
  const sibling = path.join(f.dir, 'sibling');
  git(f.repo, 'clone', f.repo, sibling);
  git(sibling, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'foreign');
  const foreign = git(sibling, 'rev-parse', 'HEAD');
  git(store, 'fetch', sibling, 'HEAD:refs/heads/foreign');
  assert.throws(() => git(f.repo, 'cat-file', '-e', foreign));
  const realGit = execFileSync('which', ['git'], {encoding:'utf8'}).trim();
  const trace = path.join(f.dir, 'bundle-plans');
  fs.writeFileSync(path.join(f.dir, 'bin/git'), `#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]
if 'bundle' in args and 'create' in args:
    bases=[x for x in args if x.startswith('^')]
    with open(${JSON.stringify(trace)}, 'a') as f: print(json.dumps(bases),file=f)
    if bases and os.getenv('FIXTURE_PACK_FAILURE'):
        sys.exit('pack-objects died (fixture)')
os.execv(${JSON.stringify(realGit)}, ['git', *args])
`, {mode:0o755});
  for (const name of ['next', 'last']) {
    fs.writeFileSync(path.join(f.repo,'source.txt'), name); git(f.repo, 'commit', '-am', name);
    if (name === 'last') {
      f.env.FIXTURE_PACK_FAILURE = '1';
      fs.writeFileSync(trace, '');
    }
    const head = git(f.repo,'rev-parse','HEAD');
    ok(await run(f, [], `test "$(git rev-parse HEAD)" = ${head} && test "$(cat source.txt)" = ${name}`));
    const plans = fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(plans.every(bases => !bases.includes('^'+foreign)));
    assert.deepEqual(plans.map(bases => bases.length), name === 'last' ? [2,1,0] : [1]);
  }
  returned(f);
  console.log('PASS foreign store commit skipped, verified bases reduced, full fallback checks out requested HEAD');
}

async function stopOwnership() {
  const f = fixture(), other = spawn('sleep',['120'], {detached:true, stdio:'ignore'});
  const closed = new Promise(resolve => other.once('exit', resolve));
  try {
    const r = await run(f, [], 'sleep 100', events => events.some(e => e.op === 'group'), (_, out) => {
      const receipt = JSON.parse(fs.readFileSync(path.join(out,'run.json')));
      const stale = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const request = id => spawnSync(process.execPath,[script,'stop','--out',out,'--run-id',id]);
      // A stale receipt from another run must not stop either the job or the foreign process.
      assert.equal(request(stale).status, 1);
      assert.ok(!fs.existsSync(path.join(out,'stop-'+receipt.runId)));
      assert.equal(request(receipt.runId).status, 0);
    });
    assert.equal(r.code,143); returned(f);
    const ctl = path.join(f.dir,'stale-control'); fs.mkdirSync(ctl);
    const old = {pid:other.pid, start:'0', run:'previous-run'};
    fs.writeFileSync(path.join(ctl,'owner.json'),JSON.stringify(old));
    fs.writeFileSync(path.join(ctl,'group.json'),JSON.stringify(old));
    const cleanup = () => spawnSync('python3',['-c',remoteScripts.cleanup,Buffer.from(JSON.stringify({control:ctl})).toString('base64')]);
    assert.equal(cleanup().status,70); assert.ok(!fs.existsSync(path.join(ctl,'cancel')));
    // Exercise the production signal gate with a real, live foreign process group.
    // Supply synthetic /proc fields so the start-time/parent mismatch is deterministic on macOS too.
    const verifyGate = `import ast,json,os,signal,sys
tree=ast.parse(sys.stdin.read())
node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='signal_owned')
exec(compile(ast.Module(body=[node],type_ignores=[]),'signal-gate','exec'))
pid=int(sys.argv[1]); fields=['0']*20
fields[1]=str(os.getpid()); fields[2]=str(pid); fields[19]='new-start'
stat=lambda _: fields
for group in (True,False):
    signal_owned(pid,'stale-start',signal.SIGTERM,group)
fields[1]='0'
for group in (True,False):
    signal_owned(pid,'new-start',signal.SIGTERM,group)
os.kill(pid,0)`;
    execFileSync('python3',['-c',verifyGate,String(other.pid)],{input:remoteScripts.run});
    if (process.platform === 'linux') {
      const active = path.join(f.dir,'linux-supervisor'); fs.mkdirSync(active);
      const data = { control:active, workspace:f.dir, seconds:5, env:{},
        command:'sleep 120 & echo $! > owned-background; exit 7' };
      const result = spawnSync('python3',['-c',remoteScripts.run,Buffer.from(JSON.stringify(data)).toString('base64')],{timeout:20000});
      assert.equal(result.status,7,result.stderr?.toString());
      assert.equal(JSON.parse(fs.readFileSync(path.join(active,'done.json'))).gone,true);
      assert.throws(() => process.kill(Number(fs.readFileSync(path.join(f.dir,'owned-background'))),0), /ESRCH/);
      old.run = path.basename(ctl);
      for (const file of ['owner.json','group.json']) fs.writeFileSync(path.join(ctl,file),JSON.stringify(old));
      assert.equal(cleanup().status,0, 'reused group ID with a different start time');
    }
    const alive = await Promise.race([closed.then(() => false), sleep(100).then(() => true)]);
    assert.equal(alive,true,'the foreign process survived both stop and cleanup');
  } finally { other.kill('SIGTERM'); await closed; }
  console.log('PASS UUID stop targets its own run; stale remote ownership records preserve foreign process');
}

async function scenarios() {
  const only = process.env.DEVBOX_TEST_CASE;
  if (only && !['bundle', 'ownership'].includes(only)) throw Error('unknown devbox fixture case');
  if (!only || only === 'bundle') await bundleRecovery();
  if (!only || only === 'ownership') await stopOwnership();
  if (only) return;
  const roots = path.join(temp, 'root-probe'), data = path.join(roots, 'data00'), home = path.join(roots, 'home');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(home); fs.writeFileSync(path.join(roots, 'meminfo'), 'MemTotal: 33554432 kB\n');
  const probeSource = remoteScripts.probe.replace("pathlib.Path('/data00')", `pathlib.Path(${JSON.stringify(data)})`)
    .replace("pathlib.Path(os.path.expanduser('~'))", `pathlib.Path(${JSON.stringify(home)})`)
    .replace("'/proc/meminfo'", JSON.stringify(path.join(roots, 'meminfo')));
  const probe = () => JSON.parse(execFileSync('python3', ['-c', probeSource, Buffer.from(JSON.stringify({ user: 'alice' })).toString('base64')], { encoding: 'utf8' }));
  assert.equal(probe().root, path.join(data, 'home/alice/devbox-run'));
  fs.rmSync(path.join(data, 'home/alice'), { recursive: true }); fs.writeFileSync(path.join(data, 'home/alice'), 'unusable directory');
  assert.equal(probe().root, path.join(data, 'alice/devbox-run'));
  fs.rmSync(path.join(data, 'alice'), { recursive: true }); fs.writeFileSync(path.join(data, 'alice'), 'unusable directory');
  assert.equal(probe().root, path.join(home, 'devbox-run'));
  console.log('PASS actual root probe: data-disk home, data-disk account, writable home fallback');

  const bootstrapHome = path.join(temp, 'bootstrap'); fs.mkdirSync(path.join(bootstrapHome, '.local/node/bin'), { recursive: true });
  fs.writeFileSync(path.join(bootstrapHome, '.local/node/bin/node'), '#!/bin/sh\necho fixture-node\n', { mode: 0o755 });
  const renderShell = env => execFileSync('python3', ['-c', `import ast,json,shlex,sys
d=json.loads(sys.argv[1]); tree=ast.parse(sys.stdin.read())
nodes=sorted([n for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ('bootstrap','exports','shell') for t in n.targets)],key=lambda n:n.lineno)
exec(compile(ast.Module(body=nodes,type_ignores=[]),'bootstrap','exec'))
print(shell)`, JSON.stringify({ env, command: 'printf "%s:" "$BOOTSTRAP_VALUE"; node' })], { input: remoteScripts.run, encoding: 'utf8' }).replaceAll('$HOME', bootstrapHome);
  assert.equal(execFileSync('/bin/bash', ['-c', renderShell({ BOOTSTRAP_VALUE: 'fallback' })], { encoding: 'utf8' }).trim(), 'fallback:fixture-node');
  fs.writeFileSync(path.join(bootstrapHome, 'devbox-env.sh'), `export PATH="${bootstrapHome}/.local/node/bin:$PATH"\nexport BOOTSTRAP_VALUE=profile\n`);
  assert.equal(execFileSync('/bin/bash', ['-c', renderShell({})], { encoding: 'utf8' }).trim(), 'profile:fixture-node');
  assert.equal(execFileSync('/bin/bash', ['-c', renderShell({ BOOTSTRAP_VALUE: 'explicit' })], { encoding: 'utf8' }).trim(), 'explicit:fixture-node');
  console.log('PASS actual command shell: toolchain bootstrap, local Node fallback and explicit env precedence');

  const f = fixture();
  const linked = path.join(f.dir, 'nested', 'second');
  git(f.repo, 'worktree', 'add', '--detach', linked);
  for (const origin of [null, '../upstream.git']) {
    if (origin) git(f.repo, 'remote', 'add', 'origin', origin);
    assert.equal(await storeIdentity(f.repo), await storeIdentity(linked));
  }
  const rows = readRegistry(f.shared, 'devbox-cn'); assert.deepEqual(rows.map(r => r.user), ['alice', 'bob']);
  assert.equal(rows.length, 2); assert.deepEqual(parseArgs(['--project', 'p', '--task', 't', '--repo', f.repo, '--need', 'node,vesdk-android', '--', 'true']).need, ['node', 'vesdk-android']);
  for (const [name, source] of Object.entries(remoteScripts)) execFileSync('python3', ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'], { input: source });
  const r = await run(f, ['--shards', '2', '--env', 'BUILD_FLAG=1']); ok(r);
  assert.match(r.stdout, /\[MASKED\]\/2/); assert.match(r.stdout, /2\/2/);
  assert.equal(new Set(r.summary.shards.map(s => s.slot)).size, 2);
  assert.equal(new Set(f.events().filter(e => e.op === 'take').map(e => e.pid)).size, 2);
  for (const h of Object.values(JSON.parse(fs.readFileSync(path.join(f.shared, 'devbox-hosts.json'))))) { assert.equal(h.fs, '/data00'); assert.ok(h.probedAt); }
  for (const event of f.events().filter(e => e.op === 'run')) { assert.ok(event.env.GRADLE_USER_HOME.endsWith('/shared/gradle')); assert.equal(event.env.CCACHE_MAXSIZE, '20G'); }
  returned(f); console.log('PASS sharding, holder PIDs, registry users/policies, root schema, shared cache exports and Python syntax');

  const sameBox = fixture();
  const registry = path.join(sameBox.shared, 'resources.tsv');
  fs.writeFileSync(registry, fs.readFileSync(registry, 'utf8').replaceAll('bob@192.0.2.2', 'alice@192.0.2.1'));
  ok(await run(sameBox, ['--shards', '2'], 'mkdir -p build && echo {shard} > build/result && sleep .3'));
  const common1 = git(workspace(sameBox), 'rev-parse', '--git-common-dir');
  const common2 = git(workspace(sameBox, '192.0.2.1', 'devbox-cn-2'), 'rev-parse', '--git-common-dir');
  assert.equal(common1, common2); assert.equal(sameBox.events().filter(e => e.op === 'probe').length, 1); returned(sameBox);
  console.log('PASS same-box shards share one object store and one root probe');

  const pinned = makeSubmoduleFixture(path.join(sameBox.dir, 'unpushed'));
  const build = await run(sameBox, ['--project', 'game', '--repo', pinned.repo, '--submodules', '--shards', '2'], pinned.command);
  ok(build);
  assert.equal(new Set(build.summary.shards.map(s => s.slot)).size, 2);
  const repeat = await run(sameBox, ['--project', 'game', '--repo', pinned.other, '--submodules'], pinned.command); ok(repeat);
  const second = repeat.summary.shards[0].attempts[0];
  assert.ok(build.summary.shards.every(s => s.attempts[0].repository === second.repository));
  assert.equal(second.bundleBytes || 0, 0); assert.equal(second.submoduleBundleBytes || 0, 0);
  const moduleDir = path.join(path.dirname(path.dirname(second.repository)), 'submodules');
  assert.equal(fs.readdirSync(moduleDir, { withFileTypes: true }).filter(f => f.isDirectory()).length, 2, 'one engine store and one leaf store');
  returned(sameBox);
  console.log('PASS two worktrees, unpushed app and recursive module pins, two slots, warm bundle reuse');

  const npm = fixture();
  fs.writeFileSync(path.join(npm.repo, '.npmrc'), 'registry=https://registry.example.invalid/\n');
  git(npm.repo, 'add', '.npmrc'); git(npm.repo, 'commit', '-qm', 'registry only');
  ok(await run(npm, ['--exclude-host', '192.0.2.2', '--exclude-slot', 'devbox-cn-2']));
  assert.ok(npm.events().some(e => e.op === 'acquire-call' && e.args.includes('--exclude-slot') && e.args.includes('--exclude-host')));
  for (const name of ['.npmrc', '.yarnrc', 'project.conf']) {
    fs.writeFileSync(path.join(npm.repo, name), '//host/:_authToken=synthetic-fixture-value\n');
    git(npm.repo, 'add', name);
    fs.writeFileSync(path.join(npm.repo, name), '# working copy is clean\n');
    const result = await run(npm, ['--ref', 'worktree']);
    if (name === 'project.conf') ok(result); // npm-specific matching is limited to package manager configuration.
    else {
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes(name) && result.stderr.includes('_authToken') && !result.stderr.includes('synthetic-fixture-value'));
    }
    git(npm.repo, 'reset', '--hard', 'HEAD');
    if (name !== '.npmrc') fs.rmSync(path.join(npm.repo, name), {force:true});
  }
  fs.writeFileSync(path.join(npm.repo, '.npmrc'), '_auth=synthetic-fixture-value\n');
  git(npm.repo, 'commit', '-qam', 'private synthetic config');
  git(npm.repo, 'rm', '.npmrc'); git(npm.repo, 'commit', '-qm', 'remove it');
  const history = await run(npm); assert.equal(history.code, 1); assert.match(history.stderr, /_auth/); returned(npm);
  console.log('PASS registry-only npm config, staged and historical content checks, pool exclusion flags');

  const warm = fixture({ dataDisk: false });
  ok(await run(warm, [], 'mkdir -p build && echo retained > build/cache'));
  const ws = workspace(warm); const initialMtime = fs.statSync(path.join(ws, 'source.txt')).mtimeMs;
  const rootDir = JSON.parse(fs.readFileSync(path.join(warm.shared, 'devbox-hosts.json')))['192.0.2.1'].root;
  const legacyRepo = path.join(rootDir, 'repos', 'old-project', 'source');
  fs.mkdirSync(path.dirname(legacyRepo), { recursive: true });
  git(warm.repo, 'clone', '--bare', warm.repo, legacyRepo);
  const firstBundle = warm.events().filter(e => e.op === 'bundle').length;
  ok(await run(warm, [], 'test -f build/cache'));
  assert.equal(warm.events().filter(e => e.op === 'bundle').length, firstBundle, 'same commit sends no bundle');
  assert.equal(fs.statSync(path.join(ws, 'source.txt')).mtimeMs, initialMtime, 'unchanged tracked file keeps mtime');
  fs.writeFileSync(path.join(warm.repo, 'next.txt'), 'next\n'); git(warm.repo, 'add', '.'); git(warm.repo, 'commit', '-qm', 'next');
  const next = await run(warm, [], 'test -f build/cache && test -f next.txt'); ok(next);
  assert.ok(next.summary.shards[0].attempts[0].bundleBytes > 0);
  assert.equal(fs.readdirSync(path.join(JSON.parse(fs.readFileSync(path.join(warm.shared, 'devbox-hosts.json')))['192.0.2.1'].root, 'repos/fixture')).length, 2, 'one repo plus flock file');
  const migrated = await run(warm, ['--project', 'old-project']); ok(migrated);
  assert.equal(migrated.summary.shards[0].attempts[0].repository, legacyRepo, 'reuse verified legacy store after advancing HEAD');
  fs.writeFileSync(path.join(warm.repo, 'source.txt'), 'overlay\n'); fs.writeFileSync(path.join(warm.repo, 'extra.txt'), 'extra\n');
  ok(await run(warm, ['--ref', 'worktree'], 'test "$(cat source.txt)" = overlay && test -f extra.txt && test -f build/cache'));
  fs.writeFileSync(path.join(warm.repo, 'staged.txt'), 'staged addition\n');
  git(warm.repo, 'add', 'staged.txt');
  for (let i = 0; i < 2; i++) ok(await run(warm, ['--ref', 'worktree'], 'test -f staged.txt && test -f build/cache'));
  fs.unlinkSync(path.join(warm.repo, 'extra.txt'));
  ok(await run(warm, [], 'test "$(cat source.txt)" = first && test ! -e extra.txt && test ! -e staged.txt && test -f build/cache'));
  assert.equal(warm.events().filter(e => e.op === 'probe').length, 1);
  assert.ok(warm.events().filter(e => e.op === 'acquire-call').some(e => e.args[0] === 'take'));
  returned(warm); console.log('PASS incremental bundles, shared object store, warm worktrees/mtime, overlay removal, affinity, home-disk root');

  for (const legacy of [false, true]) {
    const f = fixture({ legacy }); const r = await run(f, ['--need', 'node,vesdk-android']); ok(r);
    assert.equal(r.summary.shards[0].host, '192.0.2.2');
    assert.equal(f.events().some(e => e.op === 'acquire-call' && e.args.includes('--need')), !legacy);
    returned(f);
  }
  const slotPreference = fixture({ preferSlot: true });
  ok(await run(slotPreference)); ok(await run(slotPreference)); returned(slotPreference);
  assert.ok(slotPreference.events().some(e => e.op === 'acquire-call' && e.args.includes('--prefer-slot')));
  assert.ok(!slotPreference.events().some(e => e.op === 'acquire-call' && e.args[0] === 'take'));
  for (const uploadRetry of ['Broken pipe', 'Corrupted MAC', 'message authentication code incorrect']) {
    const f = fixture({ uploadRetry }); const r = await run(f); ok(r);
    assert.equal(f.events().filter(e => e.op === 'bundle').length, 2); returned(f);
  }
  const disk = fixture({ diskFailHost: '192.0.2.1' }); const diskRun = await run(disk); ok(diskRun);
  assert.equal(diskRun.summary.shards[0].attempts[0].exit, 72);
  assert.equal(diskRun.summary.shards[0].host, '192.0.2.2'); returned(disk);
  const filled = fixture({ diskAfterUpload: '192.0.2.1' }); const filledRun = await run(filled); ok(filledRun);
  assert.equal(filledRun.summary.shards[0].attempts[0].exit, 72);
  assert.ok(!filled.events().some(e => e.op === 'run' && e.host === '192.0.2.1')); returned(filled);
  console.log('PASS capability and slot preference passthrough/legacy filtering, fresh upload retry, disk guard alternate-slot retry');

  for (const allow of [false, true]) {
    const f = fixture({ failHost: '192.0.2.1' }); const r = await run(f, ['--rerun-on-fail', ...(allow ? ['--allow-flaky'] : [])]);
    assert.equal(r.code, allow ? 0 : 7); assert.equal(r.summary.shards[0].flaky, true);
    const history = JSON.parse(fs.readFileSync(path.join(f.shared, 'flaky-log.jsonl')));
    assert.deepEqual(history.hosts, ['192.0.2.1', '192.0.2.2']); assert.equal(history.commandHash.length, 64); returned(f);
  }
  const artifact = fixture(); const a = await run(artifact, ['--artifact', 'build/*.txt'], 'mkdir -p build && echo evidence > build/result.txt'); ok(a);
  assert.equal(execFileSync('tar', ['-xOf', a.summary.shards[0].attempts[0].artifact, 'build/result.txt'], { encoding: 'utf8' }).trim(), 'evidence');
  const failedArtifact = fixture({ badArtifact: true }); assert.equal((await run(failedArtifact, ['--artifact', '*.txt'])).code, 66); returned(failedArtifact);
  const failure = fixture(); assert.equal((await run(failure, [], 'exit 9')).code, 9); returned(failure);
  console.log('PASS flaky exit policy/history, artifact contents, artifact and command failure release');

  const signal = fixture(); const s = await run(signal, [], 'sleep 60 & wait', events => events.some(e => e.op === 'group'));
  assert.equal(s.code, 143); returned(signal);
  for (const e of signal.events().filter(e => e.op === 'group')) assert.throws(() => process.kill(-e.pid, 0), /ESRCH/);
  const events = signal.events(); assert.ok(events.findIndex(e => e.op === 'group-gone') < events.findIndex(e => e.op === 'return'));
  const timed = fixture(); assert.equal((await run(timed, ['--timeout', '0.035'], 'sleep 60')).code, 124); returned(timed);
  const acquisition = fixture({ cancelAcquire: true }); assert.equal((await run(acquisition)).code, 143); returned(acquisition);
  const blocked = fixture({ badCleanup: true }); const b = await run(blocked);
  assert.equal(b.code, 70); assert.equal(b.summary.shards[0].attempts[0].cleanupUnconfirmed, true);
  assert.equal(blocked.events().filter(e => e.op === 'return').length, 0);
  console.log('PASS SIGTERM process-group cleanup/order, timeout, interrupted acquisition recovery, unconfirmed cleanup retains hold');

  const gc = fixture(); ok(await run(gc, [], 'mkdir -p build && echo cache > build/output'));
  const oldWs = workspace(gc); const meta = path.join(oldWs, '.devbox-run.json'); const record = JSON.parse(fs.readFileSync(meta)); record.lastUsed -= 8 * 86400; fs.writeFileSync(meta, JSON.stringify(record));
  const foreign = path.join(gc.shared, 'locks/devbox-cn-1.d'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'info'), 'by\tother-fixture\npid\t1\n');
  ok(await run(gc, ['gc', '--host', '192.0.2.1'])); assert.ok(fs.existsSync(oldWs), 'GC preserves a leased old worktree'); fs.rmSync(foreign, { recursive: true });
  const g = await run(gc, ['gc', '--host', '192.0.2.1']); ok(g); assert.ok(!fs.existsSync(oldWs)); assert.match(g.stdout, /reclaimedGiB=/); returned(gc);
  assert.ok(gc.events().some(e => e.op === 'docker-prune'));
  const invalid = fixture(); fs.writeFileSync(path.join(invalid.repo, '.env'), 'fixture');
  const rejected = await run(invalid, ['--ref', 'worktree']); assert.equal(rejected.code, 1); assert.equal(invalid.events().length, 0);
  const historical = fixture(); fs.mkdirSync(path.join(historical.repo, 'config'));
  fs.writeFileSync(path.join(historical.repo, 'config', '.Env.old'), 'fixture');
  git(historical.repo, 'add', '.'); git(historical.repo, 'commit', '-qm', 'archived fixture');
  git(historical.repo, 'rm', 'config/.Env.old'); git(historical.repo, 'commit', '-qm', 'remove fixture');
  assert.match((await run(historical)).stderr, /bundle history contains credential-related paths/);
  assert.equal(historical.events().length, 0, 'reject historical paths before acquiring a slot');
  const redaction = fixture(); const redacted = await run(redaction, [], 'printf api_; sleep .02; printf "token=fixture-value\\n"'); ok(redacted);
  assert.ok(!redacted.stdout.includes('fixture-value')); assert.ok(!fs.readFileSync(redacted.summary.shards[0].log, 'utf8').includes('fixture-value')); returned(redaction);
  console.log('PASS leased stale-worktree GC and source-only snapshot guard');

  for (const authMessage of ['Permission denied (gssapi-with-mic)', 'Connection closed by 192.0.2.1 port 22']) {
    const f = fixture({ authFailures: 1, authMessage }); const r = await run(f); ok(r);
    assert.equal(f.events().filter(e => e.op === 'probe').length, 2); returned(f);
  }
  const exhausted = fixture({ authFailures: 4 }); const exhaustedRun = await run(exhausted, ['--rerun-on-fail']);
  assert.equal(exhaustedRun.code, 255); assert.equal(exhaustedRun.summary.shards[0].attempts[0].infraFailure, true);
  assert.equal(exhausted.events().filter(e => e.op === 'probe').length, 4); returned(exhausted);
  const started = fixture({ postStartFailure: true }); assert.equal((await run(started)).code, 255);
  assert.equal(started.events().filter(e => e.op === 'run').length, 1); returned(started);
  console.log('PASS jittered SSH establishment retries, bounded infra failure, no replay after remote start, no ControlMaster');
}

try { await scenarios(); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
