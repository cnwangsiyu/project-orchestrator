#!/usr/bin/env node
// PATH shims exercise the real Git bundle/worktree/overlay code without network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, readRegistry, remoteScripts, storeIdentity, makeBundle, cpuBudget, cpuEnvironment, parseUnits, discoverUnits, assignUnits, planShards } from '../devbox-run.mjs';

import { makeSubmoduleFixture } from './devbox-submodule-fixture.mjs';
import { fingerprint, inputKey, indexFile } from '../lib/devbox-inputs.mjs';
import { transferFindings } from '../lib/devbox-transfer-check.mjs';

const script = fileURLToPath(new URL('../devbox-run.mjs', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-scenarios-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Hosts without a global git identity (devbox 8) must still run every fixture commit.
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
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
  const env = { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, RES_DIR: shared, RULES_SHARED: shared, DEVBOX_CACHE_DIR: shared, RES_COMMAND: 'res', DEVBOX_FIXTURE: path.join(dir, 'config.json') };
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
if(c.noHelp&&(op==='help'||a.includes('--help'))){console.error('res: broken');process.exit(1);}
if(c.liveHelp&&a.includes('--help')){console.error('res: wait-pool needs a resource prefix');process.exit(1);}
if(c.liveHelp&&op==='help'){console.log('res wait-pool <prefix> --by S [--need <cap,cap>] [--prefer-host <ip>] [--prefer-slot <id>] [--exclude-slot <id,...>] [--exclude-host <ip,...>]');return;}
if(a.includes('--help')) {console.log('res wait-pool'+(c.legacy?'':' --prefer-host IP --need CAP --exclude-slot IDS --exclude-host IPS'+(c.preferSlot?' --prefer-slot SLOT':'')+(c.diskCosts?' --disk-gib-file JSON':'')));return;}
const rows=fs.readFileSync(path.join(c.shared,'resources.tsv'),'utf8').trim().split('\n').map(l=>{const [slot,kind,policy,,desc]=l.split('\t');return {slot,kind,policy,host:desc.match(/@(\d+\.\d+\.\d+\.\d+)/)?.[1],caps:desc.match(/caps=([\w,-]+)/)?.[1].split(',')||[]};});
if(op==='return'){
 const lock=path.join(c.shared,'locks',a[1]+'.d');
 if(fs.existsSync(lock)){const info=fs.readFileSync(path.join(lock,'info'),'utf8');if(!info.includes('by\t'+by+'\n'))process.exit(9);fs.rmSync(lock,{recursive:true});}
 event('return',{slot:a[1],by});console.log('return '+a[1]);console.log('ack returned');return;
}
if(!['take','wait','wait-pool'].includes(op))process.exit(9);
event('acquire-call',{args:a,pid:flag(a,'--pid')});
if(c.acquireProgress&&op==='wait-pool'){
 console.log('waiter-start pool='+a[1]);console.error('rollback/return previous attempt');
 console.log('res: pass 1 started');console.error('res: pass 1 waiting');
 console.error("res: syntax error near unexpected token ')'");
 console.error('res: api_key=fixture-res-value');console.log('ack waiting');
 const until=Date.now()+120000;while(!fs.existsSync(path.join(c.dir,'progress-observed'))){if(Date.now()>until)process.exit(9);await sleep(50);}
}
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
  if(c.prewarmBusyOnAcquire&&r.slot.includes('light')){const heavy=rows.find(x=>x.host===r.host&&/^devbox-cn-\d+$/.test(x.slot));const foreign=path.join(c.shared,'locks',heavy.slot+'.d');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'info'),'by\tfixture-foreign\npid\t1\n');}
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
event(op,{host,target,slot:d.slot,workspace:d.workspace,control:d.control,env:op==='run'?d.env:undefined,nice:op==='run'?d.command.startsWith('nice -n 10 bash -c'):undefined,cpus:d.cpus});
if(c.authFailures){
 const file=path.join(c.dir,'auth-count');const count=fs.existsSync(file)?Number(fs.readFileSync(file)):0;
 if(count<c.authFailures){fs.writeFileSync(file,String(count+1));console.error(c.authMessage||'Permission denied (gssapi-with-mic)');process.exit(255);}
}
if(op==='reconnect'){
 if(c.reconnectRetries&&!fs.existsSync(path.join(c.dir,'reconnect-failed'))){fs.writeFileSync(path.join(c.dir,'reconnect-failed'),'1');process.exit(255);}
 console.log(c.remoteRunning?'group-running':'group-gone');return;
}
if(c.postStartFailure&&op==='run'){
 console.error(command.match(/'(DEVBOX_STARTED_[^']+)'/)[1]);console.error('Connection closed by remote host');process.exit(255);
}
if(op==='probe') {
 const root=path.join(c.dir,'remote',host,c.dataDisk===false?'home':'data00',d.user,'devbox-run');fs.mkdirSync(root,{recursive:true});
 console.log(JSON.stringify({root,user:d.user,fs:c.dataDisk===false?'/':'/data00',freeGiB:100,totalGiB:200,cores:8,memGiB:32,probedAt:new Date().toISOString()}));return;
}
if(op==='metrics') {
 if(c.metricsUnavailable)process.exit(1);
 console.log(JSON.stringify({cores:8,load5:2.5,memAvailableGiB:24,freeGiB:100}));return;
}
if(op==='bundle'&&c.uploadRetry&&!fs.existsSync(path.join(c.dir,'retried'))){fs.writeFileSync(path.join(c.dir,'retried'),'1');process.stdin.resume();await new Promise(r=>process.stdin.on('end',r));console.error(c.uploadRetry);process.exit(255);}
if(op==='run') {
 fs.mkdirSync(d.control,{recursive:true});
 if(fs.existsSync(path.join(d.control,'cancel'))){fs.writeFileSync(path.join(d.control,'done.json'),JSON.stringify({gone:true}));process.exit(143);}
 const attemptFile=path.join(c.dir,'run-count-'+host);const n=fs.existsSync(attemptFile)?Number(fs.readFileSync(attemptFile)):0;fs.writeFileSync(attemptFile,String(n+1));
 let cmd=(d.cpus?'export GRADLE_OPTS="'+'$'+'{GRADLE_OPTS:+'+'$'+'GRADLE_OPTS }-Dorg.gradle.workers.max='+d.cpus+'"; ':'')+d.command;
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
  const timeout = process.env.DEVBOX_TEST_TIMEOUT_MIN || '1';
  const watchdogMs = Number(process.env.DEVBOX_TEST_WATCHDOG_MS || 90000);
  assert.ok(Number.isFinite(watchdogMs) && watchdogMs >= 1000 && watchdogMs <= 600000, 'bounded fixture watchdog');
  const args = extra[0] === 'gc' ? extra : extra[0] === 'prewarm'
    ? ['prewarm', '--project', 'fixture', '--repo', f.repo, '--ref', 'HEAD', '--out', out, '--timeout', timeout, ...extra.slice(1), '--command', command]
    : ['--project', 'fixture', '--task', 'scenario', '--repo', f.repo, '--out', out, '--timeout', timeout, ...extra, '--', command];
  const child = spawn(process.execPath, [script, ...args], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  let finished = false;
  const closed = new Promise(resolve => child.on('close', code => { finished = true; resolve(code); }));
  let watchdog = setTimeout(() => child.kill('SIGKILL'), watchdogMs), code;
  try {
    if (signalWhen) {
      const deadline = Date.now() + Math.max(60000, watchdogMs - 1000);
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

function renderCommandShell(data) {
  return execFileSync('python3', ['-c', `import ast,json,shlex,sys
d=json.loads(sys.argv[1]); tree=ast.parse(sys.stdin.read())
nodes=sorted([n for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in ('bootstrap','exports','parallel','shell') for t in n.targets)],key=lambda n:n.lineno)
exec(compile(ast.Module(body=nodes,type_ignores=[]),'bootstrap','exec'))
print(shell)`, JSON.stringify(data)], { input: remoteScripts.run, encoding: 'utf8' });
}

async function packedModuleRecovery() {
  const f = fixture(), pinned = makeSubmoduleFixture(path.join(f.dir, 'packed-module'));
  const engine = path.join(pinned.repo, 'engine');
  const oid = git(engine, 'rev-parse', 'HEAD:version');
  const config = '{"version":"public"}\n';
  fs.writeFileSync(path.join(engine, 'public.json'), config); git(engine, 'add', '.'); git(engine, 'commit', '-qm', 'public module config');
  const configOid = git(engine, 'rev-parse', 'HEAD:public.json'), pin = git(engine, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(pinned.repo, 'donor-blob'), 'local-engine');
  fs.writeFileSync(path.join(pinned.repo, 'donor-json'), config);
  git(pinned.repo, 'add', '.'); git(pinned.repo, 'commit', '-qm', 'retain module blobs');
  git(pinned.repo, 'repack', '-ad'); git(pinned.repo, 'prune-packed');
  const sourceObjects = git(pinned.repo, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  assert.ok(!fs.existsSync(path.join(sourceObjects, oid.slice(0, 2), oid.slice(2))), 'donor blob is packed');
  const moduleObjects = git(engine, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  fs.unlinkSync(path.join(moduleObjects, oid.slice(0, 2), oid.slice(2)));
  fs.unlinkSync(path.join(moduleObjects, configOid.slice(0, 2), configOid.slice(2)));
  assert.throws(() => git(engine, 'cat-file', '-e', oid));
  assert.equal(git(pinned.repo, 'cat-file', '-t', oid), 'blob');
  const exportRepo = path.join(f.dir, 'broken-export.git'); fs.mkdirSync(exportRepo); git(exportRepo, 'init', '--bare');
  fs.writeFileSync(path.join(exportRepo, 'objects/info/alternates'), moduleObjects + '\n');
  git(exportRepo, 'update-ref', 'refs/heads/export', pin);
  await assert.rejects(makeBundle({ exportRepo, temp: f.dir, commit: pin, sourceRepo: engine }, [], { cancel: 0, children: new Set(), values: [] }), error => {
    assert.match(error.message, /full bundle failed.*unable to read/s);
    assert.ok([oid, configOid].some(oid => error.message.includes(oid)));
    assert.equal(error.bundleDiagnostics.sourceRepo, engine);
    assert.ok(error.bundleDiagnostics.command.includes('bundle'));
    assert.equal(error.bundleDiagnostics.alternates[0].entries[0], moduleObjects);
    assert.ok(error.bundleDiagnostics.gitPath); assert.ok(error.bundleDiagnostics.env);
    return true;
  });
  const altFile = path.join(moduleObjects, 'info/alternates');
  const before = fs.existsSync(altFile) ? fs.readFileSync(altFile) : null;
  const list = path.join(f.dir, 'module-units.txt'); fs.writeFileSync(list, 'engine/public.json\n');
  const result = await run(f, ['--repo', pinned.repo, '--submodules', '--units-file', list], 'test "$(cat engine/version)" = local-engine && test -f {units} && test "$(cat engine/nested/payload)" = leaf');
  ok(result); returned(f);
  assert.deepEqual(fs.existsSync(altFile) ? fs.readFileSync(altFile) : null, before, 'source alternates are untouched');
  assert.throws(() => git(engine, 'cat-file', '-e', oid), 'source module remains unrepaired');
  console.log('PASS packed superproject blobs repair staged submodule bundles only; failure command/env/alternates diagnostics');
}

async function cpuScenarios() {
  const f = fixture();
  const registry = path.join(f.shared, 'resources.tsv');
  fs.appendFileSync(registry, Array.from({ length: 5 }, (_, i) => `devbox-cn-${i + 5}\tremote\topen\t-\textra alice@192.0.2.1 caps=node\n`).join(''));
  const hold = slot => { const dir = path.join(f.shared, 'locks', slot + '.d'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'info'), 'by\tfixture-external\npid\t1\n'); return dir; };
  const holds = ['devbox-cn-1', 'devbox-cn-5', 'devbox-cn-6', 'devbox-cn-7', 'devbox-cn-8'].map(hold);
  holds.push(hold('devbox-cn-light'));
  assert.equal(cpuBudget(f.shared, '192.0.2.1', 8).cpus, 2);
  assert.equal(cpuBudget(f.shared, '192.0.2.1', 1).cpus, 1);
  fs.writeFileSync(path.join(holds[0], 'info'), `by\tdead\npid\t536870911\nhost\t${os.hostname()}\n`);
  assert.equal(cpuBudget(f.shared, '192.0.2.1', 8).heavyHolders, 4);
  for (const dir of holds) fs.rmSync(dir, { recursive: true });
  assert.equal(cpuBudget(f.shared, '192.0.2.1', 8).cpus, 8);
  assert.throws(() => cpuBudget(f.shared, '192.0.2.1', undefined), /core count/);
  const foreign = hold('devbox-cn-5');
  const r = await run(f, ['--env', 'GRADLE_OPTS=-Xmx2g', '--env', 'MAKEFLAGS=-j99'], 'test "$DEVBOX_CPUS" = 4 && test "$MAKEFLAGS" = -j4 && test "$GRADLE_OPTS" = "-Xmx2g -Dorg.gradle.workers.max=4"'); ok(r);
  assert.equal(r.summary.shards[0].attempts[0].heavyHolders, 2);
  const event = f.events().find(e => e.op === 'run');
  for (const [key, value] of Object.entries(cpuEnvironment(4))) assert.equal(event.env[key], value);
  fs.rmSync(foreign, { recursive: true }); returned(f);
  const home = path.join(f.dir, 'shell-home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'devbox-env.sh'), 'export GRADLE_OPTS="-Xmx3g -Dexisting=true"\n');
  const shell = renderCommandShell({ env: {}, cpus: 3, command: 'printf "%s" "$GRADLE_OPTS"' }).replaceAll('$HOME', home);
  assert.equal(execFileSync('/bin/bash', ['-c', shell], { encoding: 'utf8' }), '-Xmx3g -Dexisting=true -Dorg.gradle.workers.max=3');
  console.log('PASS launch-time CPU division, floor/cap, live holders, budget exports and preserved Gradle profile/explicit options');
}

async function autoScenarios() {
  assert.equal(planShards('auto', 8).count, 1);
  assert.equal(planShards('auto', 3, null, { commands: { job: { durationSec: 1000 } } }, 'job').count, 3);
  assert.equal(planShards('auto', 8, null, { commands: { job: { durationSec: 359 } } }, 'job').count, 2);
  assert.equal(planShards(4, 0).count, 4);
  assert.throws(() => planShards('auto', 0), /no free eligible slots/);
  const uneven = { units: { a: { durationSec: 560 }, b: { durationSec: 10 }, c: { durationSec: 10 }, d: { durationSec: 20 } } };
  assert.equal(planShards('auto', 4, ['a', 'b', 'c', 'd'], uneven).count, 1);
  const f = fixture(), cold = await run(f, ['--shards', 'auto']); ok(cold); assert.equal(cold.summary.shards.length, 1);
  const id = await storeIdentity(f.repo, 'fixture'), file = path.join(f.shared, 'timings', id + '.json');
  const history = JSON.parse(fs.readFileSync(file)); history.commands[Object.keys(history.commands)[0]].durationSec = 360;
  fs.writeFileSync(file, JSON.stringify(history));
  const warm = await run(f, ['--shards', 'auto']); ok(warm); assert.equal(warm.summary.shards.length, 2);
  history.commands[Object.keys(history.commands)[0]].durationSec = 360; fs.writeFileSync(file, JSON.stringify(history));
  const capable = await run(f, ['--shards', 'auto', '--need', 'vesdk-android']); ok(capable); assert.equal(capable.summary.shards.length, 1);
  for (const slot of ['devbox-cn-1', 'devbox-cn-2']) fs.mkdirSync(path.join(f.shared, 'locks', slot + '.d'));
  const busy = await run(f, ['--shards', 'auto']); assert.equal(busy.code, 1); assert.match(busy.stderr, /no free eligible slots/);
  for (const slot of ['devbox-cn-1', 'devbox-cn-2']) fs.rmdirSync(path.join(f.shared, 'locks', slot + '.d'));
  returned(f);
  const healthFile = path.join(f.shared, 'box-health.json');
  const before = f.events().length;
  fs.writeFileSync(healthFile, JSON.stringify({ '192.0.2.1': { manual: true }, '192.0.2.2': { quarantinedUntil: Date.now() / 1000 + 60 } }));
  const quarantined = await run(f, ['--shards', 'auto']); assert.equal(quarantined.code, 1); assert.match(quarantined.stderr, /no free eligible slots/);
  assert.equal(f.events().length, before, 'automatic planning refuses quarantined capacity before SSH/acquisition');
  fs.writeFileSync(healthFile, JSON.stringify({ '192.0.2.2': { quarantinedUntil: 1 } }));
  fs.writeFileSync(file, JSON.stringify(history));
  const expired = await run(f, ['--shards', 'auto']); ok(expired); assert.equal(expired.summary.shards.length, 2); returned(f);
  fs.writeFileSync(healthFile, 'not-json');
  const malformed = await run(f, ['--shards', 'auto']); assert.equal(malformed.code, 1); assert.match(malformed.stderr, /invalid box-health/);
  fs.rmSync(healthFile); ok(await run(f, ['--shards', '2'])); returned(f);
  console.log('PASS auto cold/history sizing, free/capability limits, two-minute target, skewed units, explicit N and busy refusal');
}

async function unitScenarios() {
  const names = ['a.test.js', 'b.spec.mjs', 'dir/c.test.ts', "odd ' name.spec.js"];
  const durations = Object.fromEntries(names.map((name, i) => [name, { durationSec: 9 - i }]));
  assert.deepEqual(assignUnits(names, 2).groups, [[names[0], names[2]], [names[1], names[3]]]);
  assert.deepEqual(assignUnits(names, 2, durations).groups, [[names[0], names[3]], [names[1], names[2]]]);
  assert.equal(assignUnits(names, 2, { [names[0]]: durations[names[0]] }).strategy, 'round-robin');
  assert.deepEqual(parseUnits('a.test.js\r\n\r\nb.spec.mjs\r\n'), names.slice(0, 2));
  for (const text of ['', '../outside.js', '/absolute.js', 'a\na']) assert.throws(() => parseUnits(text));
  assert.deepEqual(discoverUnits(['test_x.py', 'x_test.go', 'AppTest.kt', 'src/index.js', '__tests__/x.ts']), ['AppTest.kt', '__tests__/x.ts', 'test_x.py', 'x_test.go']);
  assert.throws(() => planShards(5, 4, names), /number of units/);
  const f = fixture();
  for (const name of names) { fs.mkdirSync(path.dirname(path.join(f.repo, name)), { recursive: true }); fs.writeFileSync(path.join(f.repo, name), '// test fixture\n'); }
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'unit paths');
  const list = path.join(f.dir, 'units.txt'); fs.writeFileSync(list, names.join('\n') + '\n');
  const initial = await run(f, ['--shards', '2', '--units-file', list], 'test -f {units}; sleep .02'); ok(initial);
  assert.equal(initial.summary.shardPlan.strategy, 'round-robin');
  const id = await storeIdentity(f.repo, 'fixture'), file = path.join(f.shared, 'timings', id + '.json');
  const history = JSON.parse(fs.readFileSync(file));
  for (const name of names) { assert.ok(history.units[name].durationSec > 0); assert.equal(history.units[name].samples, 1); }
  history.units = durations; fs.writeFileSync(file, JSON.stringify(history));
  const balanced = await run(f, ['--shards', '2', '--units-file', list], 'test -f {units}'); ok(balanced);
  assert.equal(balanced.summary.shardPlan.strategy, 'longest-first');
  assert.deepEqual(balanced.summary.shards.map(shard => shard.units), [[names[0], names[3]], [names[1], names[2]]]);
  const discovered = await run(f, [], 'test -f {units}'); ok(discovered); assert.equal(discovered.summary.shards[0].units.length, 4);
  const appended = await run(f, ['--units-file', list], 'test -f'); ok(appended);
  const failed = await run(f, ['--units-file', list], 'test {units} != a.test.js'); assert.equal(failed.code, 1);
  assert.equal(failed.summary.shards[0].attempts[0].unitTimings.length, 4, 'run remaining units after a failure');
  returned(f);
  console.log('PASS unit lists/discovery, longest-first/round-robin, quoted paths, per-unit receipts/history, append mode and failure exit');
}

async function prewarmScenarios() {
  const f = fixture(), r = await run(f, ['prewarm'], 'mkdir -p build; echo warmed > build/cache'); ok(r);
  assert.equal(r.summary.mode, 'prewarm'); assert.equal(r.summary.shards.length, 2);
  assert.deepEqual(r.summary.shards.map(shard => shard.slot).sort(), ['devbox-cn-light', 'devbox-cn-light-2']);
  assert.ok(f.events().filter(e => e.op === 'run').every(e => e.nice === true));
  assert.ok(f.events().filter(e => e.op === 'acquire-call').every(e => e.args[0] === 'take'));
  returned(f);
  const busy = path.join(f.shared, 'locks/devbox-cn-1.d'); fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, 'info'), 'by\tforeign\npid\t1\n');
  const eligible = await run(f, ['prewarm', '--need', 'vesdk-android']); ok(eligible); assert.equal(eligible.summary.shards.length, 1);
  const otherBusy = path.join(f.shared, 'locks/devbox-cn-2.d'); fs.mkdirSync(otherBusy);
  const none = await run(f, ['prewarm']); ok(none); assert.deepEqual(none.summary.shards, []);
  fs.rmSync(busy, { recursive: true }); fs.rmdirSync(otherBusy); returned(f);
  const registry = path.join(f.shared, 'resources.tsv');
  fs.writeFileSync(registry, fs.readFileSync(registry, 'utf8').split('\n').filter(line => !line.startsWith('devbox-cn-light')).join('\n'));
  fs.appendFileSync(registry, 'devbox-cn-5\tremote\topen\t-\textra alice@192.0.2.1 caps=node\n');
  ok(await run(f, ['--exclude-slot', 'devbox-cn-1', '--exclude-host', '192.0.2.2'], 'mkdir -p build; echo mru > build/cache'));
  const mru = await run(f, ['prewarm', '--exclude-host', '192.0.2.2'], 'test "$(cat build/cache)" = mru'); ok(mru);
  assert.equal(mru.summary.shards[0].slot, 'devbox-cn-5'); returned(f);
  assert.equal(parseArgs(['prewarm', '--project', 'p', '--repo', f.repo, '--command', 'true']).ref, 'main');
  const race = fixture({ prewarmBusyOnAcquire: true }), skipped = await run(race, ['prewarm']); ok(skipped);
  assert.ok(skipped.summary.shards.every(shard => shard.skipped));
  assert.ok(!race.events().some(event => event.op === 'run'));
  for (const slot of ['devbox-cn-1', 'devbox-cn-2']) fs.rmSync(path.join(race.shared, 'locks', slot + '.d'), { recursive: true });
  returned(race);
  const health = fixture(), healthFile = path.join(health.shared, 'box-health.json');
  fs.writeFileSync(healthFile, JSON.stringify({ '192.0.2.1': { manual: true }, '192.0.2.2': { quarantinedUntil: Date.now() / 1000 + 60 } }));
  const blocked = await run(health, ['prewarm']); ok(blocked); assert.deepEqual(blocked.summary.shards, []);
  assert.ok(!health.events().some(event => ['probe', 'run', 'take'].includes(event.op)));
  fs.writeFileSync(healthFile, JSON.stringify({ '192.0.2.1': { manual: true }, '192.0.2.2': { quarantinedUntil: 1 } }));
  const expired = await run(health, ['prewarm']); ok(expired); assert.equal(expired.summary.shards.length, 1); returned(health);
  console.log('PASS prewarm idle/capability filtering, light preference, nice, no queues, busy no-op, heavy MRU fallback and warm cache reuse');
}

async function credentialScenarios() {
  const fake = 'fixtureValue123', fakeAccess = 'AKIA' + '0'.repeat(16);
  for (const key of ['ACCESS_KEY', 'SCRECT_KEY', 'SECRET_VALUE', 'NEXUS_LOGIN', 'MAGIC_WORD', 'MY_PRIVATE', 'MY_PWD', 'AUTH_VALUE', 'CREDENTIAL_VALUE']) {
    assert.ok(transferFindings(`${key}=${fake}`).some(hit => hit.key === key));
    assert.deepEqual(transferFindings(`${key}=\u0024{ENV}`), []);
    assert.deepEqual(transferFindings(`${key}=true`), []);
    assert.deepEqual(transferFindings(`${key}=https://example.invalid/public`), []);
  }
  assert.deepEqual(transferFindings('keyAlias="publicAlias123"'), []);
  assert.deepEqual(transferFindings('signing.keyAlias = "publicAlias123"', { dsl: true }), []);
  assert.deepEqual(transferFindings('ACCESS_KEY = "prefix" + System.getenv("ENV")', { dsl: true }), []);
  assert.deepEqual(transferFindings('SECRET_VALUE = config.value', { dsl: true }), []);
  assert.deepEqual(transferFindings('credentials(PasswordCredentials::class)', { dsl: true }), []);
  assert.ok(transferFindings('ACCESS_KEY = """fixtureValue123"""', { dsl: true }).some(hit => hit.key === 'ACCESS_KEY'));
  assert.ok(transferFindings('mapOf("SCRECT_KEY" to "fixtureValue123")', { dsl: true }).some(hit => hit.key === 'SCRECT_KEY'));
  assert.deepEqual(transferFindings('{"auth": {"TOKEN": "\u0024{ENV}"}, "keyAlias": "publicAlias123"}'), []);
  assert.ok(transferFindings(`SCRECT_KEY.set("${fake}")`, { dsl: true }).some(hit => hit.key === 'SCRECT_KEY'));
  const cases = [
    ['gradle.properties', `ACCESS_KEY=${fake}\nSCRECT_KEY=${fake}\nNEXUS_LOGIN=${fake}\n`, 'ACCESS_KEY'],
    ['settings.yaml', `nested:\n  MAGIC_WORD: ${fake}\n`, 'MAGIC_WORD'],
    ['settings.json', JSON.stringify({ nested: { ACCESS_KEY: fake } }), 'ACCESS_KEY'],
    ['build.gradle.kts', `credentials { password("${fake}") }`, 'password'],
    ['settings.toml', `PRIVATE_VALUE = "${fake}"`, 'PRIVATE_VALUE'],
    ['settings.cfg', `payload=-----BEGIN RSA PRIVATE KEY-----\n${fake}\n-----END RSA PRIVATE KEY-----`, 'PRIVATE_KEY_BLOCK'],
    ['settings.ini', `value=${fakeAccess}`, 'AKIA_ACCESS_KEY'],
    ['settings.plist', `<plist><dict><key>SCRECT_KEY</key><string>${fake}</string></dict></plist>`, 'SCRECT_KEY'],
  ];
  for (const [name, text, key] of cases) {
    const f = fixture(); fs.writeFileSync(path.join(f.repo, name), text);
    const r = await run(f, ['--ref', 'worktree']);
    assert.equal(r.code, 1); assert.ok(r.stderr.includes(name)); assert.match(r.stderr, /count=\d+/);
    assert.ok(r.stderr.toLowerCase().includes(key.toLowerCase()));
    assert.ok(r.stderr.includes('source-only export') && r.stderr.includes('references/devbox-run.md'));
    assert.ok(!r.stderr.includes(fake) && !r.stdout.includes(fake) && !r.stderr.includes(fakeAccess));
    assert.deepEqual(f.events(), [], 'gate precedes every SSH/res operation');
  }
  const historical = fixture();
  const privateSource = fixture(), privatePath = path.join(privateSource.repo, '.aws');
  fs.mkdirSync(privatePath); fs.writeFileSync(path.join(privatePath, 'config.json'), '{}');
  git(privateSource.repo, 'add', '.'); git(privateSource.repo, 'commit', '-qm', 'synthetic private path');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const contentRead = path.join(privateSource.dir, 'content-read');
  fs.writeFileSync(path.join(privateSource.dir, 'bin/git'), `#!/usr/bin/env python3
import os, sys
if 'cat-file' in sys.argv and 'blob' in sys.argv:
    open(${JSON.stringify(contentRead)}, 'w').close()
os.execv(${JSON.stringify(realGit)}, ['git', *sys.argv[1:]])
`, { mode: 0o755 });
  for (const deleted of [false, true]) {
    if (deleted) { git(privateSource.repo, 'rm', '-r', '.aws'); git(privateSource.repo, 'commit', '-qm', 'remove private path'); }
    const result = await run(privateSource);
    assert.equal(result.code, 1); assert.match(result.stderr, /credential-related paths/);
    assert.ok(!fs.existsSync(contentRead), 'private names/history refused before reading any blob');
    assert.deepEqual(privateSource.events(), []);
  }
  fs.writeFileSync(path.join(historical.repo, 'config.yaml'), `ACCESS_KEY: ${fake}`);
  git(historical.repo, 'add', '.'); git(historical.repo, 'commit', '-qm', 'history-only fixture');
  git(historical.repo, 'rm', 'config.yaml'); git(historical.repo, 'commit', '-qm', 'remove config');
  const old = await run(historical), historicalOutput = old.stdout + old.stderr;
  assert.equal(old.code, 1); assert.ok(historicalOutput.includes('config.yaml'), historicalOutput); assert.ok(!historicalOutput.includes(fake));
  assert.ok(historical.events().some(event => event.op === 'take'));
  assert.ok(!historical.events().some(event => ['bundle', 'run'].includes(event.op)), 'history gate still precedes transfer and execution');
  returned(historical);
  const staged = fixture();
  fs.writeFileSync(path.join(staged.repo, 'project.conf'), `SCRECT_KEY=${fake}`); git(staged.repo, 'add', '.');
  fs.writeFileSync(path.join(staged.repo, 'project.conf'), 'SCRECT_KEY=\n');
  assert.equal((await run(staged, ['--ref', 'worktree'])).code, 1); assert.deepEqual(staged.events(), []);
  const binary = fixture();
  const plist = execFileSync('python3', ['-c', 'import plistlib,sys;sys.stdout.buffer.write(plistlib.dumps({"SCRECT_KEY":b"fixtureValue123"},fmt=plistlib.FMT_BINARY))']);
  fs.writeFileSync(path.join(binary.repo, 'settings.plist'), plist); git(binary.repo, 'add', '.'); git(binary.repo, 'commit', '-qm', 'binary plist fixture');
  const binaryRun = await run(binary); assert.equal(binaryRun.code, 1); assert.ok(binaryRun.stderr.includes('settings.plist') && binaryRun.stderr.includes('SCRECT_KEY')); assert.ok(!binaryRun.stderr.includes(fake)); assert.deepEqual(binary.events(), []);
  const overlay = fixture(); fs.writeFileSync(path.join(overlay.repo, 'project.conf'), 'ACCESS_KEY=\n'); git(overlay.repo, 'add', '.'); git(overlay.repo, 'commit', '-qm', 'blank');
  fs.writeFileSync(path.join(overlay.repo, 'project.conf'), `ACCESS_KEY=${fake}`);
  assert.equal((await run(overlay, ['--ref', 'worktree'])).code, 1); assert.deepEqual(overlay.events(), []);
  const negative = fixture();
  fs.writeFileSync(path.join(negative.repo, 'gradle.properties'), 'ACCESS_KEY=\u0024{ENV}\nSCRECT_KEY=\nNEXUS_URL=https://example.invalid/public\nkeyAlias=publicAlias123\nPRIVATE_ENABLED=true\n');
  fs.writeFileSync(path.join(negative.repo, 'build.gradle.kts'), 'val ACCESS_KEY = System.getenv("ENV")\nval SECRET_VALUE = config.value\nkeyAlias("publicAlias123")\n');
  fs.writeFileSync(path.join(negative.repo, 'settings.json'), JSON.stringify({ ACCESS_KEY: '${ENV}', PRIVATE_ENABLED: true, NEXUS_URL: 'https://example.invalid/public', keyAlias: 'publicAlias123' }));
  git(negative.repo, 'add', '.'); git(negative.repo, 'commit', '-qm', 'nonliteral/public fixture');
  ok(await run(negative)); returned(negative);
  const logged = fixture(); const logRun = await run(logged, [], `printf "SCRECT_KEY=${fake}\\nMY_PASS=${fake}\\nAUTH_VALUE=${fake}\\n${fakeAccess}\\n-----BEGIN RSA PRIVATE KEY-----\\n${fake}\\n-----END RSA PRIVATE KEY-----\\n"`); ok(logRun);
  assert.ok(!logRun.stdout.includes(fake) && !logRun.stdout.includes(fakeAccess));
  assert.ok(!fs.readFileSync(logRun.summary.shards[0].log, 'utf8').includes(fake)); returned(logged);
  console.log('PASS hard pre-transfer properties/YAML/JSON/DSL/PEM/AKIA/plist gate, history/staged/overlay checks, references/public exclusions and value-free logs');
}

async function receiptScenarios() {
  const f = fixture();
  const registry = path.join(f.shared, 'resources.tsv');
  fs.writeFileSync(registry, fs.readFileSync(registry, 'utf8').replaceAll('bob@192.0.2.2', 'alice@192.0.2.1'));
  const command = 'test "$DEVBOX_RUN_RECEIPT" -ef "$PWD/.devbox-run.json" && test -f "$DEVBOX_RUN_RECEIPT" && test -z "$(git status --porcelain)"';
  ok(await run(f, [], command));
  const exclude = git(workspace(f), 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  fs.appendFileSync(exclude, '\n# preserve existing slot rules\nexisting-output/\n');
  const before = fs.readFileSync(exclude);
  ok(await run(f, ['--shards', '2', '--env', 'DEVBOX_RUN_RECEIPT=wrong'], command));
  assert.deepEqual(fs.readFileSync(exclude), before, 'idempotent update preserves all existing exclude bytes');
  assert.equal(fs.readFileSync(exclude, 'utf8').split('\n').filter(line => line === '/.devbox-run.json').length, 1);
  assert.equal(git(workspace(f, '192.0.2.1', 'devbox-cn-2'), 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'), exclude);
  returned(f);
  console.log('PASS clean git status with discoverable receipt, worktree-aware shared exclude, idempotence and existing-rule preservation');
}

async function resProgressScenarios() {
  const f = fixture({ acquireProgress: true });
  let observed = false;
  const result = await run(f, ['--env', 'N=1', '--env', 'LABEL=fixture-long-value'],
    'printf "result: %s23 %s\\n" "$N" "$LABEL"; printf "MY_PASS=fixture-remote-value\\n"', () => {
    const out = fs.readdirSync(f.dir).find(name => name.startsWith('out-'));
    if (!out) return false;
    const file = path.join(f.dir, out, 'shard-1-state.json');
    if (!fs.existsSync(file)) return false;
    return JSON.parse(fs.readFileSync(file)).resEvents?.some(event => event.kind === 'ack');
  }, (child, out) => {
    const state = JSON.parse(fs.readFileSync(path.join(out, 'shard-1-state.json')));
    assert.equal(state.status, 'acquiring');
    assert.ok(!f.events().some(event => event.op === 'take'), 'progress visible before acquisition/close');
    for (const kind of ['waiter-start', 'rollback', 'ack']) assert.ok(state.resEvents.some(event => event.kind === kind));
    assert.ok(state.resEvents.some(event => event.stream === 'stderr'));
    assert.ok(state.resEvents.every(event => Number.isFinite(Date.parse(event.time))));
    assert.match(fs.readFileSync(path.join(out, 'shard-1.log'), 'utf8'), /\[\d{4}-[^\]]+\] \[shard 1\] res wait-pool stdout: waiter-start/);
    fs.writeFileSync(path.join(f.dir, 'progress-observed'), 'observed\n');
    observed = true;
  });
  ok(result); returned(f); assert.ok(observed);
  assert.equal(result.summary.shards[0].slot, 'devbox-cn-1', 'final stdout parsing remains unchanged');
  const state = JSON.parse(fs.readFileSync(result.summary.shards[0].stateFile));
  assert.equal(state.status, 'complete'); assert.equal(state.exit, 0);
  assert.ok(state.resEvents.some(event => event.kind === 'slot'));
  assert.ok(state.resEvents.some(event => event.operation === 'return'));
  assert.ok(state.resEvents.some(event => event.stream === 'stdout' && event.message === 'res: pass 1 started'));
  assert.ok(state.resEvents.some(event => event.stream === 'stderr' && event.message === 'res: pass 1 waiting'));
  const log = fs.readFileSync(result.summary.shards[0].log, 'utf8');
  for (const output of [result.stdout, log]) {
    assert.match(output, /syntax error near unexpected token/);
    assert.match(output, /slot=devbox-cn-1/);
    assert.match(output, /result: 123 \[MASKED\]/);
    assert.match(output, /\[MASKED sensitive output\]/);
    assert.doesNotMatch(output, /fixture-(?:long|res|remote)-value/);
  }
  assert.doesNotMatch(JSON.stringify(state), /fixture-res-value/);
  console.log('PASS live res diagnostics, slot parsing, short env values, and local and remote value masking');
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
      const reconnect = control => spawnSync('python3', ['-c', remoteScripts.reconnect,
        Buffer.from(JSON.stringify({ control })).toString('base64')], { encoding: 'utf8' });
      assert.equal(reconnect(active).stdout.trim(), 'group-gone');
      const stat = fs.readFileSync(`/proc/${other.pid}/stat`, 'utf8').split(')').at(-1).trim().split(' ');
      fs.rmSync(path.join(ctl, 'cancel'));
      fs.writeFileSync(path.join(ctl, 'group.json'), JSON.stringify({ ...old, start: stat[19] }));
      assert.equal(reconnect(ctl).stdout.trim(), 'group-running');
      assert.ok(!fs.existsSync(path.join(ctl, 'cancel')), 'read-only reconnect must never cancel a process');
    }
    const alive = await Promise.race([closed.then(() => false), sleep(100).then(() => true)]);
    assert.equal(alive,true,'the foreign process survived both stop and cleanup');
  } finally { other.kill('SIGTERM'); await closed; }
  console.log('PASS UUID stop targets its own run; stale remote ownership records preserve foreign process');
}

async function metricScenarios() {
  const host = '192.0.2.1';
  const load = path.join(temp, 'loadavg'), mem = path.join(temp, 'meminfo');
  fs.writeFileSync(load, '99.00 2.50 1.00 1/1 1\n');
  fs.writeFileSync(mem, 'MemTotal: 33554432 kB\nMemAvailable: 25165824 kB\n');
  const metricsSource = remoteScripts.metrics.replace("'/proc/loadavg'", JSON.stringify(load))
    .replace("'/proc/meminfo'", JSON.stringify(mem));
  const actual = JSON.parse(execFileSync('python3', ['-c', metricsSource, Buffer.from(JSON.stringify({ root: temp })).toString('base64')], { encoding: 'utf8' }));
  assert.ok(actual.cores > 0);
  assert.equal(actual.load5, 2.5);
  assert.equal(actual.memAvailableGiB, 24);
  assert.ok(actual.freeGiB > 0);
  const config = f => path.join(f.shared, 'machine.conf');
  const setGate = (f, enabled) => fs.writeFileSync(config(f), `DEVBOX_DYNAMIC_ADMISSION=${enabled}\nDEVBOX_DYNAMIC_HOSTS=${host}\n`);
  const f = fixture();
  setGate(f, 1);
  const file = path.join(f.shared, 'devbox-metrics', host + '.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() / 1000 - 61, cores: 8, load5: 0, memAvailableGiB: 24 }));
  ok(await run(f));
  const first = f.events().map(event => event.op);
  assert.equal(first.filter(op => op === 'metrics').length, 2);
  assert.ok(first.indexOf('metrics') < first.indexOf('acquire-call'));
  assert.ok(first.lastIndexOf('metrics') > first.indexOf('group-gone'));
  const sample = JSON.parse(fs.readFileSync(file));
  assert.deepEqual({ ...sample, at: 0 }, { at: 0, cores: 8, load5: 2.5, memAvailableGiB: 24, freeGiB: 100 });
  assert.ok(Date.now() / 1000 - sample.at < 60);
  ok(await run(f));
  assert.equal(f.events().filter(event => event.op === 'metrics').length, 3, 'fresh sample only refreshes after the next run');
  setGate(f, 0);
  ok(await run(f));
  assert.equal(f.events().filter(event => event.op === 'metrics').length, 3);
  returned(f);

  const unavailable = fixture({ metricsUnavailable: true, diskFailHost: host });
  setGate(unavailable, 1);
  const result = await run(unavailable); ok(result);
  assert.equal(result.summary.shards[0].attempts[0].exit, 72);
  assert.equal(result.summary.shards[0].host, '192.0.2.2');
  assert.ok(!unavailable.events().some(event => event.op === 'run' && event.host === host && event.slot === 'devbox-cn-1'));
  returned(unavailable);
  const reuse = fixture({ diskCosts: true });
  const cold = await run(reuse); ok(cold);
  assert.deepEqual(cold.summary.shards[0].attempts[0].diskCosts, {});
  const warm = await run(reuse); ok(warm);
  assert.equal(warm.summary.shards[0].attempts[0].diskCosts['devbox-cn-1'], 0);
  assert.ok(reuse.events().some(event => event.op === 'acquire-call' && event.args.includes('--disk-gib-file')));
  returned(reuse);
  console.log('PASS devbox metrics refresh, fresh-cache reuse, kill switch and disk guard on fallback');
}

async function placementScenarios() {
  const f = fixture();
  f.env.RES_COMMAND = fileURLToPath(new URL('../res/res', import.meta.url));
  fs.writeFileSync(path.join(f.shared, 'machine.conf'), 'DEVBOX_SOFT_EXCLUDE_MINUTES=0.001\n');
  const held = path.join(f.shared, 'locks', 'devbox-cn-1.d');
  fs.mkdirSync(held);
  fs.writeFileSync(path.join(held, 'info'), 'by\tforeign-fixture\npid\t1\n');
  const result = await run(f, ['--exclude-host', '192.0.2.2'], 'exit 9');
  assert.equal(result.code, 9, result.stdout + result.stderr);
  const shard = result.summary.shards[0];
  assert.deepEqual(shard.softExclusionsDropped.hosts, ['192.0.2.2']);
  assert.equal(shard.host, '192.0.2.2');
  assert.match(result.stdout, /rerun with --exclude-reason/i);
  assert.match(shard.attempts[0].error, /dropped automatically/);
  const hard = await run(f, ['--timeout', '0.05', '--exclude-host', '192.0.2.2', '--exclude-reason', 'fixture binding']);
  assert.notEqual(hard.code, 0);
  assert.equal(hard.summary.shards[0].softExclusionsDropped, undefined);
  assert.ok(f.events().every(event => event.op !== 'run' || event.host === '192.0.2.2'));
  assert.deepEqual(fs.readdirSync(path.join(f.shared, 'locks')), ['devbox-cn-1.d']);
  console.log('PASS runner soft-exclusion summary and failure guidance, hard filter, and foreign hold preservation');
}

async function sshDropScenarios() {
  const gone = fixture({ postStartFailure: true, reconnectRetries: true });
  const completed = await run(gone);
  assert.equal(completed.code, 255);
  assert.equal(completed.summary.shards[0].attempts[0].sshRecovery, 'group-gone');
  assert.equal(gone.events().filter(e => e.op === 'run').length, 1);
  assert.equal(gone.events().filter(e => e.op === 'reconnect').length, 2);
  assert.ok(!gone.events().some(e => e.op === 'cleanup'));
  returned(gone);

  const live = fixture({ postStartFailure: true, remoteRunning: true });
  const held = await run(live);
  assert.equal(held.code, 255);
  const attempt = held.summary.shards[0].attempts[0];
  assert.equal(attempt.remoteJobStillRunning, true);
  assert.match(held.stdout, /remote job still running/);
  assert.ok(held.stdout.includes(attempt.stopCommand));
  assert.ok(!live.events().some(e => e.op === 'cleanup' || e.op === 'return'));
  const stop = spawnSync('/bin/sh', ['-c', attempt.stopCommand], { env: live.env, encoding: 'utf8' });
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.match(stop.stdout, /confirmed remote cleanup and returned/);
  returned(live);
  console.log('PASS bounded SSH reconnect confirms a gone group or retains a live job until explicit stop');
}

async function inputScenarios() {
  const f=fixture(); f.env.RES_COMMAND=fileURLToPath(new URL('../res/res',import.meta.url));
  const actual=await fingerprint(path.join(f.repo,'source.txt'));
  const input=`name=asset,hash=${actual.hash},rebuildable=yes,cost=2s,size=0.01,seed=source.txt`;
  const command=`node -e 'const fs=require("fs");const paths=JSON.parse(fs.readFileSync(process.env.DEVBOX_INPUTS_FILE));if(fs.readFileSync(paths.asset,"utf8")!=="first\\n")process.exit(9)'`;
  const first=await run(f,['--input',input],command);ok(first);returned(f);
  const receipt=first.summary.shards[0].attempts[0];
  assert.equal(receipt.seeds.length,1);assert.ok(receipt.placementDecisions.length);
  const file=indexFile(f.shared,first.summary.shards[0].host);
  assert.ok(JSON.parse(fs.readFileSync(file)).inputs['asset+'+actual.hash]);
  const legacyIndex=JSON.parse(fs.readFileSync(file));
  for(const key of Object.keys(legacyIndex.inputs))if(key.startsWith('warm.'))delete legacyIndex.inputs[key];
  fs.writeFileSync(file,JSON.stringify(legacyIndex));
  const legacyMetaFile=path.join(workspace(f),'.devbox-run.json');const legacyMeta=JSON.parse(fs.readFileSync(legacyMetaFile));delete legacyMeta.affinity;fs.writeFileSync(legacyMetaFile,JSON.stringify(legacyMeta));
  const migrated=await run(f,['--input',input,'--warm-cost','27m'],command);ok(migrated);returned(f);
  assert.ok(!migrated.summary.shards[0].attempts[0].inputPlan.slots[migrated.summary.shards[0].slot].missing.some(name=>name.startsWith('warm.')),'legacy warm cache is verified before scoring');
  const second=await run(f,['--input',input],command);ok(second);assert.equal(second.summary.shards[0].attempts[0].seeds.length,0);returned(f);
  const pinned=await run(f,['--input',`name=asset,hash=${actual.hash},rebuildable=no,cost=0s,size=0.01`],command);ok(pinned);assert.equal(pinned.summary.shards[0].host,first.summary.shards[0].host);returned(f);
  const aliasIndex=JSON.parse(fs.readFileSync(file));aliasIndex.inputs['alias+'+actual.hash]={...aliasIndex.inputs['asset+'+actual.hash]};fs.writeFileSync(file,JSON.stringify(aliasIndex));
  const alias=await run(f,['--input',`name=alias,hash=${actual.hash},rebuildable=no,cost=0s,size=0.01`],command.replace('paths.asset','paths.alias'));ok(alias);returned(f);
  assert.equal(alias.summary.shards[0].attempts[0].inputPaths.alias,receipt.inputPaths.asset,'registered paths are passed to the command');
  fs.unlinkSync(receipt.inputPaths.asset);
  const index=JSON.parse(fs.readFileSync(file));index.inputs['asset+'+actual.hash].verifiedAt-=301;fs.writeFileSync(file,JSON.stringify(index));
  const absent=await run(f,['--input',`name=asset,hash=${actual.hash},rebuildable=no,cost=0s,size=0.01`],command);
  assert.notEqual(absent.code,0);assert.match(absent.stdout,/missing non-rebuildable input asset/);returned(f);
  const mismatch=fixture();mismatch.env.RES_COMMAND=f.env.RES_COMMAND;
  const wrong=await run(mismatch,['--input',`name=asset,hash=${'b'.repeat(64)},rebuildable=yes,cost=1s,size=0.01,seed=source.txt`]);
  assert.notEqual(wrong.code,0);assert.match(wrong.stderr,/seed hash\/size mismatch/);assert.equal(mismatch.events().length,0);
  const denied=fixture();fs.writeFileSync(path.join(denied.repo,'private.txt'),'password='+['fixture','credential'].join('-'));
  const deniedSeed=await run(denied,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1s,size=0.01,seed=private.txt`]);
  assert.notEqual(deniedSeed.code,0);assert.match(deniedSeed.stderr,/credential gate refused seed/);assert.equal(denied.events().length,0);
  const directory=fixture();directory.env.RES_COMMAND=f.env.RES_COMMAND;
  const seedDir=path.join(directory.dir,'directory-seed');fs.mkdirSync(path.join(seedDir,'assets'),{recursive:true});
  fs.writeFileSync(path.join(seedDir,'assets/item.txt'),'sample');fs.writeFileSync(path.join(seedDir,'assets.json'),JSON.stringify({layout:'sample'}));
  const directoryHash=await fingerprint(seedDir);
  const directoryRun=await run(directory,['--input',`name=directory,hash=${directoryHash.hash},rebuildable=yes,cost=1s,size=0.01,seed=${seedDir}`]);ok(directoryRun);returned(directory);
  assert.equal(directoryRun.summary.shards[0].attempts[0].seeds.length,1,'directory hashes use identical full-path ordering on sender and receiver');
  const routed=fixture();routed.env.RES_COMMAND=f.env.RES_COMMAND;
  const routedRepo=path.join(routed.dir,'.trae/worktrees/source');fs.mkdirSync(path.dirname(routedRepo),{recursive:true});fs.renameSync(routed.repo,routedRepo);routed.repo=routedRepo;
  const routedSeed=await run(routed,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1s,size=0.01,seed=source.txt`]);ok(routedSeed);returned(routed);
  const seedCommand=fixture();seedCommand.env.RES_COMMAND=f.env.RES_COMMAND;
  const badCommand=await run(seedCommand,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1s,size=0.01,seed=cmd:printf wrong > "$DEVBOX_INPUT_PATH"`]);
  assert.notEqual(badCommand.code,0);assert.match(badCommand.stdout,/seed hash\/size mismatch/);returned(seedCommand);
  console.log('PASS input seed/hash/gate, verified index reuse, hard pin, stale verification and supervised hash mismatch');
}
async function hygieneScenarios() {
  const f=fixture(); const mods=makeSubmoduleFixture(path.join(f.dir,'modules'));
  f.repo=mods.repo;
  const first=await run(f,['--submodules'],mods.command);ok(first);
  const ws=workspace(f);
  const oldMeta=JSON.parse(fs.readFileSync(path.join(ws,'.devbox-run.json'))); delete oldMeta.job;
  fs.writeFileSync(path.join(ws,'.devbox-run.json'),JSON.stringify(oldMeta));
  fs.writeFileSync(path.join(f.shared,'log.tsv'),'2026-11-18 00:00\ttake\tdevbox-cn-1\told-holder (legacy/project)\tfixture\n');
  fs.writeFileSync(path.join(ws,'engine/version'),'dirty engine');
  fs.writeFileSync(path.join(ws,'engine/nested/payload'),'dirty nested');
  fs.writeFileSync(path.join(ws,'engine/untracked'),'leftover');
  const second=await run(f,['--submodules'],mods.command);ok(second);returned(f);
  const hygiene=second.summary.shards[0].attempts[0].slotHygiene;
  assert.equal(hygiene.previousJob,'legacy/project');
  assert.ok(hygiene.patches.some(item=>item.tree==='engine'));
  assert.ok(hygiene.patches.some(item=>item.tree==='engine/nested'));
  for(const item of hygiene.patches) assert.ok(fs.statSync(item.patch).size>0);
  assert.equal(fs.existsSync(path.join(ws,'engine/untracked')),false);
  console.log('PASS dirty nested submodules preserve patches, name previous job and clean checkout succeeds');
}

async function scenarios() {
  const only = process.env.DEVBOX_TEST_CASE;
  const perf = { inputs:inputScenarios,hygiene:hygieneScenarios,credentials: credentialScenarios, 'packed-module': packedModuleRecovery, receipt: receiptScenarios, 'res-progress': resProgressScenarios, cpu: cpuScenarios, auto: autoScenarios, units: unitScenarios, prewarm: prewarmScenarios, metrics: metricScenarios, placement: placementScenarios, 'ssh-drop': sshDropScenarios };
  if (only && !['baseline', 'bundle', 'ownership', ...Object.keys(perf)].includes(only)) throw Error('unknown devbox fixture case');
  for (const [name, scenario] of Object.entries(perf)) if (!only || only === name) await scenario();
  if (!only || only === 'baseline' || only === 'bundle') await bundleRecovery();
  if (!only || only === 'baseline' || only === 'ownership') await stopOwnership();
  if (only && only !== 'baseline') return;
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
  const renderShell = env => renderCommandShell({ env, command: 'printf "%s:" "$BOOTSTRAP_VALUE"; node' }).replaceAll('$HOME', bootstrapHome);
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
  assert.match(r.stdout, /^1\/2$/m); assert.match(r.stdout, /^2\/2$/m);
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
    {
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes(name) && result.stderr.toLowerCase().includes('_authtoken') && !result.stderr.includes('synthetic-fixture-value'));
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

  {
    const f = fixture({ liveHelp: true }); const r = await run(f, ['--need', 'node,vesdk-android', '--exclude-host', '192.0.2.9']); ok(r);
    assert.ok(f.events().some(e => e.op === 'acquire-call' && e.args.includes('--need') && e.args.includes('--exclude-host')), 'flags read from `res help` when `wait-pool --help` is rejected');
    const g = fixture({ noHelp: true }); const bad = await run(g, ['--need', 'node']);
    assert.equal(bad.code, 2, 'failed flag probe fails closed');
    assert.ok(!g.events().some(e => e.op === 'acquire-call'), 'no slot acquired when the flag probe fails');
  }
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
  let failedArtifact = fixture({ badArtifact: true }); assert.equal((await run(failedArtifact, ['--artifact', '*.txt'])).code, 66); returned(failedArtifact);
  const left = await run(failedArtifact = fixture({ badArtifact: true }), ['--artifact', '*.txt', '--fetch-timeout', '30']);
  assert.equal(left.code, 66); assert.match(left.stdout + left.stderr, /artifacts remain on devbox-cn-\d+/);
  assert.deepEqual(left.summary.shards[0].attempts[0].artifactsLeft.patterns, ['*.txt']); returned(failedArtifact);
  await assert.rejects(run(fixture(), ['--fetch-timeout', '0']).then(r => { if (r.code) throw Error('rejected'); }), /rejected/);
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
  const redaction = fixture(); const redacted = await run(redaction, [], 'printf api_; sleep .02; printf "token=FAKE_DEVBOX_TOKEN_123\\n"; printf \'storePassword "FAKE_DEVBOX_PASSWORD_456"\\n\''); ok(redacted);
  assert.ok(!redacted.stdout.includes('FAKE_DEVBOX_'));
  assert.ok(!fs.readFileSync(redacted.summary.shards[0].log, 'utf8').includes('FAKE_DEVBOX_'));
  assert.match(redacted.stdout, /log-redaction files=1 masked=0/); returned(redaction);
  console.log('PASS leased stale-worktree GC and source-only snapshot guard');

  for (const authMessage of ['Permission denied (gssapi-with-mic)', 'Connection closed by 192.0.2.1 port 22']) {
    const f = fixture({ authFailures: 1, authMessage }); const r = await run(f); ok(r);
    assert.equal(f.events().filter(e => e.op === 'probe').length, 2); returned(f);
  }
  const exhausted = fixture({ authFailures: 4 }); const exhaustedRun = await run(exhausted, ['--rerun-on-fail']);
  assert.equal(exhaustedRun.code, 255); assert.equal(exhaustedRun.summary.shards[0].attempts[0].infraFailure, true);
  assert.equal(exhausted.events().filter(e => e.op === 'probe').length, 4); returned(exhausted);
  await placementScenarios();
  await sshDropScenarios();
  console.log('PASS jittered SSH establishment retries, bounded infra failure, no replay after remote start, no ControlMaster');
}

try { await scenarios(); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
