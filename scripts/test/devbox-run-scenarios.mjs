#!/usr/bin/env node
// PATH shims exercise the real Git bundle/worktree/overlay code without network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, readRegistry, remoteScripts, storeIdentity, submoduleOrigin, makeBundle, cpuBudget, cpuEnvironment, parseUnits, discoverUnits, assignUnits, planShards, runBudgets, commandOutcome, runDataCleanupPython } from '../devbox-run.mjs';

import { makeSubmoduleFixture } from './devbox-submodule-fixture.mjs';
import { fingerprint, inputKey, indexFile } from '../lib/devbox-inputs.mjs';
import { transferFindings } from '../lib/devbox-transfer-check.mjs';
import { retentionPython } from '../lib/devbox-retention.mjs';
import { runTmpdirPython } from '../lib/devbox-tmpdir.mjs';
import { muxFailure, muxRetrySafe } from '../lib/devbox-ssh.mjs';

const script = fileURLToPath(new URL('../devbox-run.mjs', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-scenarios-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Fixture Git commands must not inherit caller command-scope configuration.
for (const name of Object.keys(process.env))
  if (['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'].includes(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete process.env[name];
// Apple's git shim repeatedly resolves Xcode under a synthetic HOME. Resolve
// the installed binary once, retaining fixture shims ahead of it in each PATH.
const gitBin = path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../bin/git');
if (fs.existsSync(gitBin)) process.env.PATH = `${path.dirname(gitBin)}:${process.env.PATH}`;
// Hosts without a global git identity (devbox 8) must still run every fixture commit.
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let count = 0;
function fixture(options = {}) {
  const dir = path.join(options.canonical ? fs.realpathSync(temp) : temp, `case-${++count}`), bin = path.join(dir, 'bin'), shared = path.join(dir, 'shared'), repo = path.join(dir, 'source');
  for (const p of [bin, shared, repo, path.join(shared, 'locks')]) fs.mkdirSync(p, { recursive: true });
  const cleanupPython = 'import os,sys,json,pathlib,time\n' + retentionPython + runDataCleanupPython + '\nd=json.loads(sys.stdin.read())\nproc_root=pathlib.Path(d["control"])/"fixture-proc"\nproc_root.mkdir(parents=True,exist_ok=True)\ndocker_workspace_live=lambda workspace: False\nprint(json.dumps(cleanup_run_data(d,proc_root)))\n';
  const cleanupOutputPython = 'import json,sys,pathlib\n' + runDataCleanupPython + '\nprint_data_cleanup(json.loads(sys.stdin.read()))\n';
  const tmpdirPython = 'import os,json,pathlib,sys\n' + runTmpdirPython + '\nctl=pathlib.Path(sys.argv[2])\nif sys.argv[1]=="create": print(create_run_tmpdir(ctl))\nelse: cleanup_run_tmpdir(ctl)\n';
  const config = { realRes: fileURLToPath(new URL('../res/res', import.meta.url)), dir, shared, cleanupPython, cleanupOutputPython, tmpdirPython, hosts: ['192.0.2.1', '192.0.2.2'], ...options };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const rows = [
    'devbox-cn-1\tremote\topen\t-\tfirst alice@192.0.2.1 caps=node',
    'devbox-cn-2\tremote\topen\t-\tsecond bob@192.0.2.2 caps=node,vesdk-android',
    'devbox-cn-light\tremote\topen\t-\tfirst alice@192.0.2.1 caps=node',
    'devbox-cn-light-2\tremote\topen\t-\tsecond bob@192.0.2.2 caps=node,vesdk-android',
    'devbox-cn-3\tremote\tnever\t-\tretired nobody@192.0.2.3 caps=node',
    'devbox-cn-4\tremote\task-user\t-\tpending nobody@192.0.2.4 caps=node',
  ];
  fs.writeFileSync(path.join(shared, 'resources.tsv'), options.dynamic ? 'devbox-host-first\tremote\topen\t-\talice@192.0.2.1 caps=node\n' : rows.join('\n') + '\n');
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
if(c.dynamic) {
 if(c.retirementRace&&op==='wait-pool'&&a.includes('retire-artifacts')) {
  const rival=cp.spawnSync(c.realRes,['take','devbox-cn-first-1','--by','fixture-retirement-rival','--project','fixture','--for','race','--pid',String(process.ppid),'--disk-gib','0','--cores','1','--mem-gib','1'],{env:process.env,encoding:'utf8'});
  if(rival.status)throw Error(rival.stderr);event('retirement-race',{slot:'devbox-cn-first-1'});
 }
 const result=cp.spawnSync(c.realRes,a,{env:process.env,encoding:'utf8'});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
 if(result.status===0 && ['take','wait-pool','return'].includes(op)) {
  const slot=/^slot=(\S+)$/m.exec(result.stdout)?.[1] || a[1];event(op==='return'?'return':'take',{slot,by,pid:Number(flag(a,'--pid'))});
 }
 process.exit(c.retirementAcquireFailure&&op==='wait-pool'&&a.includes('retire-artifacts') ? 70 : (result.status??1));
}
if(c.noHelp&&(op==='help'||a.includes('--help'))){console.error('res: broken');process.exit(1);}
if(c.liveHelp&&a.includes('--help')){console.error('res: wait-pool needs a resource prefix');process.exit(1);}
if(c.liveHelp&&op==='help'){console.log('res wait-pool <prefix> --by S [--need <cap,cap>] [--prefer-host <ip>] [--prefer-slot <id>] [--exclude-slot <id,...>] [--exclude-host <ip,...>]');return;}
if(a.includes('--help')) {console.log('res wait-pool'+(c.legacy?'':' --prefer-host IP --need CAP --exclude-slot IDS --exclude-host IPS'+(c.preferSlot?' --prefer-slot SLOT':'')+(c.diskCosts?' --disk-gib-file JSON':'')+(c.warmFamily?' --warm-family REF':'')));return;}
const rows=fs.readFileSync(path.join(c.shared,'resources.tsv'),'utf8').trim().split('\n').map(l=>{const [slot,kind,policy,,desc]=l.split('\t');return {slot,kind,policy,host:desc.match(/@(\d+\.\d+\.\d+\.\d+)/)?.[1],caps:desc.match(/caps=([\w,-]+)/)?.[1].split(',')||[]};});
if(op==='return'||op==='release-dead'){
 if(c.returnFailure){console.error('fixture lease return failure');process.exit(70);}
 const lock=path.join(c.shared,'locks',a[1]+'.d');
 if(fs.existsSync(lock)){const info=fs.readFileSync(path.join(lock,'info'),'utf8');if(!info.includes('by\t'+by+'\n'))process.exit(9);fs.rmSync(lock,{recursive:true});}
 event('return',{slot:a[1],by});console.log('return '+a[1]);console.log('ack returned');return;
}
if(!['take','wait','wait-pool'].includes(op))process.exit(9);
if(op==='take'&&a.includes('--placement-file'))throw Error('--placement-file requires wait-pool');
event('acquire-call',{args:a,pid:flag(a,'--pid'),warmMarkers:fs.existsSync(path.join(c.shared,'devbox-affinity.json'))?Object.values(JSON.parse(fs.readFileSync(path.join(c.shared,'devbox-affinity.json')))).map(value=>value.verifiedWorkspace):[]});
if(c.acquireProgress&&op==='wait-pool'){
 console.log('waiter-start pool='+a[1]);console.log('ack waiting');
 await sleep(c.progressStderrDelay||0);console.error('rollback/return previous attempt');
 console.log('res: pass 1 started');console.error('res: pass 1 waiting');
 console.error("res: syntax error near unexpected token ')'");
 console.error('res: api_key=fixture-res-value');
 const until=Date.now()+120000;while(!fs.existsSync(path.join(c.dir,'progress-observed'))){if(Date.now()>until)process.exit(9);await sleep(50);}
}
let ids=rows.filter(r=>r.policy==='open'&&(op==='wait-pool'?(a[1].endsWith('light')?/^devbox-cn-light(?:-\d+)?$/.test(r.slot):/^devbox-cn-\d+$/.test(r.slot)):r.slot===a[1]));
for (const [opt,field] of [['--exclude-slot','slot'],['--exclude-host','host']]) if(a.includes(opt))ids=ids.filter(r=>!flag(a,opt).split(',').includes(r[field]));
if(a.includes('--need'))ids=ids.filter(r=>flag(a,'--need').split(',').every(cap=>r.caps.includes(cap)));
if(a.includes('--prefer-host')) ids.sort((x,y)=>Number(y.host===flag(a,'--prefer-host'))-Number(x.host===flag(a,'--prefer-host')));
if(a.includes('--prefer-slot')) ids.sort((x,y)=>Number(y.slot===flag(a,'--prefer-slot'))-Number(x.slot===flag(a,'--prefer-slot')));
let cancelled=false;process.on('SIGTERM',()=>{cancelled=true;});
const deadline=Date.now()+Number(a.includes('--timeout')?flag(a,'--timeout'):0)*60000;
if(c.admissionDelay&&op==='wait-pool')await sleep(c.admissionDelay);
do {
 const plan=a.includes('--placement-file')?JSON.parse(fs.readFileSync(flag(a,'--placement-file'),'utf8')):null;
 for(const r of ids){if(plan&&!plan.slots[r.slot]?.eligible)continue;const lock=path.join(c.shared,'locks',r.slot+'.d');try{fs.mkdirSync(lock);}catch(e){if(e.code==='EEXIST')continue;throw e;}
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
if(args.includes('-O'))return;
const op=command.match(/^# devbox-run:([\w-]+)/)?.[1];
if(!op)throw Error('unmarked SSH');
if(!args.includes('BatchMode=yes')||!args.includes('ServerAliveInterval=15')||!args.includes('ServerAliveCountMax=4'))throw Error('missing SSH guard');
if(['artifacts','fetch-artifact','artifact-range'].includes(op)&&(!args.includes('Ciphers=^aes128-gcm@openssh.com')||args.includes('-c')))throw Error('artifact cipher must be preferred, not required');
if(['run','cleanup','reconnect','result','artifact-range','dead-slot','cleanup-pending','checkout','bundle','patch','upload','seed'].includes(op) || (op==='probe'&&args.includes('ControlMaster=no'))) {
 if(!args.includes('ControlMaster=no')||!args.includes('ControlPath=none'))throw Error('supervisor/recovery SSH must remain independent');
} else if(!((c.muxMessage||c.postStartMessage)&&args.includes('ControlMaster=no')&&args.includes('ControlPath=none'))&&(!args.includes('ControlMaster=auto')||!args.includes('ControlPersist=60')))throw Error('control SSH must reuse task connection');
let d={};if(op!=='upload')d=JSON.parse(Buffer.from(command.match(/'([A-Za-z0-9+/=]+)'$/)[1],'base64').toString());
event(op,{host,target,multiplexed:args.includes('ControlMaster=auto'),slot:d.slot,workspace:d.workspace,control:d.control,treeRoot:d.treeRoot,treeState:d.treeState,offset:d.offset,length:d.length,forceStage:d.forceStage,reuseAllowed:d.reuseAllowed,env:op==='run'?d.env:undefined,nice:op==='run'?d.command.startsWith('nice -n 10 bash -c'):undefined,cpus:d.cpus});
if(c.assertLegacyWire&&op!=='upload'){
 if(Object.hasOwn(d,'treeConfig'))throw Error('disabled configuration changed SSH payload');
 const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
 if(!command.includes('python3 -c '+quote(c.legacyScripts[op])+' '))throw Error('disabled configuration changed SSH script: '+op);
}
if(op==='tree-place'&&c.treeFree){
 const setup="original_statvfs=os.statvfs\ndef fixture_statvfs(p):\n    free="+JSON.stringify(c.treeFree)+"\n    name='primary' if str(p)==d['root'] else 'secondary'\n    return __import__('types').SimpleNamespace(f_bavail=free[name]*1073741824,f_frsize=1)\nos.statvfs=fixture_statvfs\ntree_disk_sample=lambda roots:{}\ntree_filesystem=lambda root:str(root)\n";
 const source=command.replace('print(json.dumps(tree_place(d)))',()=>setup.replaceAll("'","'\\''")+'print(json.dumps(tree_place(d)))');
 const result=cp.spawnSync('/bin/bash',['-c',source],{encoding:'utf8'});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status);
}
if(c.muxMessage&&op===(c.muxOperation||'checkout')){
 const file=path.join(c.dir,'mux-count'),count=fs.existsSync(file)?Number(fs.readFileSync(file)):0;
 if(count<(c.muxFailures||1)){fs.writeFileSync(file,String(count+1));process.stderr.write(c.muxMessage);process.exit(255);}
}
if(c.authFailures){
 const file=path.join(c.dir,'auth-count');const count=fs.existsSync(file)?Number(fs.readFileSync(file)):0;
 if(count<c.authFailures){fs.writeFileSync(file,String(count+1));console.error(c.authMessage||'Permission denied (gssapi-with-mic)');process.exit(255);}
}
if(op==='dead-slot'){console.log(JSON.stringify({clean:!c.remoteRunning,count:c.remoteRunning?1:0,worktrees:1}));return;}
if(op==='input-exists'&&c.inputExistenceFailure){console.error('fixture input existence check unavailable');process.exit(70);}
if(op==='cleanup-pending'){
 if(c.pendingUnknown)process.exit(255);
 const running=c.remoteRunning&&!fs.existsSync(path.join(d.control,'fixture-cleaned'));
 console.log(JSON.stringify({run:path.basename(d.control),clean:!running&&!c.pendingUnits,count:running?1:0,units:c.pendingUnits?1:0,pgid:12345}));return;
}
if(op==='reconnect'){
 if(c.reconnectRetries&&!fs.existsSync(path.join(c.dir,'reconnect-failed'))){fs.writeFileSync(path.join(c.dir,'reconnect-failed'),'1');process.exit(255);}
 console.log(c.remoteRunning?'group-running':'group-gone');return;
}
if(op==='result'){
 if(c.unreadableResult)process.exit(255);
 if(c.remoteRunning){console.log(JSON.stringify({exit:null,tail:'',offset:d.offset,more:false}));return;}
 if(c.completeOnReconnect){fs.writeFileSync(path.join(d.control,'done.json'),JSON.stringify({run:path.basename(d.control),gone:true,exit:c.remoteExit??0}));}
}
if(c.postStartFailure&&op==='run'){
 fs.mkdirSync(d.control,{recursive:true});
 if(d.commandMarker)console.log(d.commandMarker);
 if(!c.remoteRunning&&!c.completeOnReconnect)fs.writeFileSync(path.join(d.control,'done.json'),JSON.stringify({run:path.basename(d.control),gone:true,exit:c.remoteExit??0}));
 if(c.recordedUnit)fs.writeFileSync(path.join(d.control,'units.json'),JSON.stringify({run:path.basename(d.control),units:[{unit:c.recordedUnit,exit:0,durationSec:349.366333442}]}));
 const startOutput=d.commandMarker?d.commandMarker+'\n':'';
 fs.writeFileSync(path.join(d.control,'output.log'),startOutput+'remaining output tail\n');
 if(c.privateTail){
  const header='-----'+'BEGIN OPENSSH PRIVATE KEY-----\n';
  fs.writeFileSync(path.join(d.control,'output.log'),startOutput+header+'FAKE_PRIVATE_TAIL_ONLY\n'+'-----'+'END OPENSSH PRIVATE KEY-----\n');
  process.stdout.write(c.privateTail==='split'?header.slice(0,8):header);
 }
 console.error(command.match(/'(DEVBOX_STARTED_[^']+)'/)[1]);console.error(c.postStartMessage||'Connection closed by remote host');process.exit(255);
}
if(op==='probe') {
 const root=path.join(c.dir,'remote',host,c.dataDisk===false?'home':'data00',d.user,'devbox-run');fs.mkdirSync(root,{recursive:true});
 console.log(JSON.stringify({root,user:d.user,fs:c.dataDisk===false?'/':'/data00',freeGiB:100,totalGiB:200,cores:8,memGiB:32,probedAt:new Date().toISOString()}));return;
}
if(op==='retire-artifacts'&&c.retirementFailure){console.error('fixture retirement failure');process.exit(70);}
if(op==='metrics') {
 if(c.metricsUnavailable)process.exit(1);
 console.log(JSON.stringify({cores:8,load5:2.5,memAvailableGiB:24,freeGiB:c.readbackDiskGiB??100,...c.ioMetrics}));return;
}
if(op==='bundle'&&c.uploadRetry&&!fs.existsSync(path.join(c.dir,'retried'))){fs.writeFileSync(path.join(c.dir,'retried'),'1');process.stdin.resume();await new Promise(r=>process.stdin.on('end',r));console.error(c.uploadRetry);process.exit(255);}
if(op==='bundle'&&c.transferDelay)await sleep(c.transferDelay);
if(op==='run') {
 if(d.stream){
  const source=c.dataCleanupFailure?c.cleanupPython.replace('d=json.loads(sys.stdin.read())',"original_unlink=os.unlink\ndef faulty_unlink(name,*a,**kw):\n    if name=='blocked': raise PermissionError('fixture cleanup failure')\n    return original_unlink(name,*a,**kw)\nos.unlink=faulty_unlink\nd=json.loads(sys.stdin.read())"):c.cleanupPython;
  const cleanup=cp.spawnSync('python3',['-c',source],{input:JSON.stringify(d),encoding:'utf8'});
  if(cleanup.status)console.error('fixture data cleanup warning');
  else { const record=JSON.parse(cleanup.stdout);const output=cp.spawnSync('python3',['-c',c.cleanupOutputPython],{input:JSON.stringify(record),encoding:'utf8'});if(output.status)throw Error(output.stderr);process.stdout.write(output.stdout);fs.mkdirSync(d.control,{recursive:true});fs.writeFileSync(path.join(d.control,'data-cleanup.json'),JSON.stringify({...record,run:path.basename(d.control)})); }
 }
 if(c.launchDelay)await sleep(c.launchDelay);
 if(c.launcherDiskHost===host){console.error('DEVBOX_LAUNCH_DISK_GUARD');process.exit(72);}
 fs.mkdirSync(d.control,{recursive:true});
 if(fs.existsSync(path.join(d.control,'cancel'))){fs.writeFileSync(path.join(d.control,'done.json'),JSON.stringify({gone:true}));process.exit(143);}
  const tmpdir=cp.spawnSync('python3',['-c',c.tmpdirPython,'create',d.control],{encoding:'utf8'});
  if(tmpdir.status)throw Error(tmpdir.stderr);
  d.env={...d.env,TMPDIR:tmpdir.stdout.trim()};
 const attemptFile=path.join(c.dir,'run-count-'+host);const n=fs.existsSync(attemptFile)?Number(fs.readFileSync(attemptFile)):0;fs.writeFileSync(attemptFile,String(n+1));
 let cmd=(d.cpus?'export GRADLE_OPTS="'+'$'+'{GRADLE_OPTS:+'+'$'+'GRADLE_OPTS }-Dorg.gradle.workers.max='+d.cpus+'"; ':'')+d.command;
 if(c.failHost===host)cmd='exit 7';
 const child=cp.spawn('/bin/bash',['-c',cmd],{cwd:d.workspace,env:{...process.env,...d.env},detached:true,stdio:['ignore','inherit','inherit']});
 if(d.commandMarker)console.log(d.commandMarker);
 fs.writeFileSync(path.join(d.control,'group.json'),JSON.stringify({pid:child.pid,run:path.basename(d.control),start:'fixture'}));
 event('group',{pid:child.pid,host});
 let cancelled=false,timedOut=false;
 const stop=()=>{cancelled=true;try{process.kill(-child.pid,'SIGTERM')}catch{}};
 process.on('SIGTERM',stop);process.on('SIGHUP',stop);
 const timer=setTimeout(()=>{timedOut=true;stop();},d.seconds*1000);
 let code=await new Promise(r=>child.on('exit',(code,signal)=>r(code??143)));
 clearTimeout(timer);try{process.kill(-child.pid,'SIGKILL')}catch{}
  const tmpCleanup=cp.spawnSync('python3',['-c',c.tmpdirPython,'cleanup',d.control],{encoding:'utf8'});
  if(tmpCleanup.status)throw Error(tmpCleanup.stderr);
 fs.writeFileSync(path.join(d.control,'done.json'),JSON.stringify({gone:true}));
 process.exit(timedOut?124:cancelled?143:code);
}
if(op==='cleanup'){
 if(c.badCleanup||c.stopFailureHost===host){console.error('DEVBOX_CLEANUP='+JSON.stringify({run:path.basename(d.control),pgid:12345,count:3,ownerAlive:false}));process.exit(70);}
 fs.mkdirSync(d.control,{recursive:true});fs.writeFileSync(path.join(d.control,'cancel'),'');
 fs.writeFileSync(path.join(d.control,'fixture-cleaned'),'');
  const tmpCleanup=cp.spawnSync('python3',['-c',c.tmpdirPython,'cleanup',d.control],{encoding:'utf8'});
  if(tmpCleanup.status)throw Error(tmpCleanup.stderr);
 console.error('DEVBOX_CLEANUP='+JSON.stringify({run:path.basename(d.control),pgid:12345,count:0,ownerAlive:false}));
 event('group-gone',{host});console.log('group-gone');return;
}
if(op==='artifacts'&&c.badArtifact)process.exit(66);
if(op==='artifacts'&&(c.lowArtifactDisk||c.artifactDirectFault)){
 const source=c.lowArtifactDisk?command.replaceAll('disk=os.statvfs(root)','disk=__import__("types").SimpleNamespace(f_bavail=53*1073741824,f_frsize=1)'):command;
 const result=cp.spawnSync('/bin/bash',['-c',source],{maxBuffer:128*1024*1024});
 process.stderr.write(result.stderr);
 if(result.status)process.exit(result.status);
 const counter=path.join(c.dir,'direct-read-count'),n=fs.existsSync(counter)?Number(fs.readFileSync(counter)):0;
 fs.writeFileSync(counter,String(n+1));
 const fault=c.artifactDirectFault||'',active=!d.forceStage&&(n===0||fault.endsWith('always'));
 let payload=result.stdout;
 if(active&&fault.startsWith('corrupt')){payload=Buffer.from(payload);payload[0]^=1;}
 if(active&&(fault.startsWith('drop')||fault.startsWith('stall')))payload=payload.subarray(0,12345);
 await new Promise(r=>process.stdout.write(payload,r));
 if(active&&fault.startsWith('stall'))await sleep(60000);
 if(active&&fault.startsWith('drop'))process.exit(255);
 return;
}
if(op==='artifact-range'&&c.artifactFault){
 const counter=path.join(c.dir,'artifact-read-count'), n=fs.existsSync(counter)?Number(fs.readFileSync(counter)):0;
 fs.writeFileSync(counter,String(n+1));
 const result=cp.spawnSync('/bin/bash',['-c',command],{maxBuffer:128*1024*1024});
 if(result.status){process.stderr.write(result.stderr);process.exit(result.status);}
 const fault=c.artifactFault, active=n===0||fault.endsWith('always');
 let payload=result.stdout;
 if(active&&fault.startsWith('corrupt')){payload=Buffer.from(payload);payload[0]^=1;}
 if(active&&(fault.startsWith('drop')||fault.startsWith('stall')))payload=payload.subarray(0,Math.min(12345,payload.length-1));
 await new Promise(r=>process.stdout.write(payload,r));
 if(active&&fault.startsWith('stall'))await sleep(60000);
 if(active&&fault.startsWith('drop'))process.exit(255);
 return;
}
if(op==='fetch-artifact'&&c.badFetch){console.error('fixture primary readback failure');process.exit(65);}
if(op==='fetch-artifact'&&c.readbackBarrier){
 event('readback-start',{pid:process.pid});
 while(!fs.existsSync(path.join(c.dir,'release-readback-'+process.pid)))await sleep(25);
}
if(op==='inspect') {
 const result=cp.spawnSync('/bin/bash',['-c',command],{encoding:'utf8'});
 if(result.status){process.stderr.write(result.stderr);process.exit(result.status);}
 const info=JSON.parse(result.stdout);info.free=((c.diskFailHost===host || (c.diskAfterUpload===host && fs.existsSync(path.join(d.workspace,'.git'))))?40:100)*1024**3;
 if(d.relative&&c.moduleVerifyMissing){
  const marker=path.join(c.dir,'module-verify-missing');
  if(c.moduleVerifyMissing==='always'||!fs.existsSync(marker)){fs.writeFileSync(marker,'observed');info.present=false;}
 }
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
  const selected = fixture(), selectedRun = await run(selected, ['prewarm', '--host', '192.0.2.1']); ok(selectedRun);
  assert.deepEqual(selectedRun.summary.shards.map(shard => shard.host), ['192.0.2.1']);
  assert.equal(selectedRun.summary.shards[0].slot, 'devbox-cn-light');
  assert.ok(selected.events().filter(event => event.host).every(event => event.host === '192.0.2.1'), 'prewarm contacts only the selected host');
  returned(selected);
  const repeated = fixture(), repeatedRun = await run(repeated, ['prewarm', '--host', '192.0.2.1', '--host', '192.0.2.2']); ok(repeatedRun);
  assert.deepEqual(repeatedRun.summary.shards.map(shard => shard.host), ['192.0.2.2']);
  assert.ok(repeated.events().filter(event => event.host).every(event => event.host === '192.0.2.2'));
  returned(repeated);
  for (const [flags, message] of [
    [['--host', ''], /unknown prewarm host/],
    [['--host', '192.0.2.99'], /unknown prewarm host 192\.0\.2\.99/],
    [['--host', '192.0.2.3'], /ineligible prewarm host 192\.0\.2\.3/],
    [['--host', '192.0.2.4'], /ineligible prewarm host 192\.0\.2\.4/],
    [['--host', '192.0.2.1', '--need', 'vesdk-android'], /ineligible prewarm host 192\.0\.2\.1/],
    [['--host', '192.0.2.1', '--exclude-host', '192.0.2.1'], /ineligible prewarm host 192\.0\.2\.1/],
    [['--host', '192.0.2.1', '--exclude-slot', 'devbox-cn-1,devbox-cn-light'], /ineligible prewarm host 192\.0\.2\.1/],
  ]) {
    const rejected = fixture(), failed = await run(rejected, ['prewarm', ...flags]);
    assert.notEqual(failed.code, 0); assert.match(failed.stderr, message);
    assert.deepEqual(rejected.events(), [], 'invalid requested host must not contact or acquire another host');
    returned(rejected);
  }
  const regular = fixture(), regularRun = await run(regular, ['--host', '192.0.2.1', '--host', '192.0.2.2']); ok(regularRun);
  assert.equal(regularRun.summary.shards[0].host, '192.0.2.1', 'regular-run placement keeps ignoring the scalar host option');
  returned(regular);
  console.log('PASS selected prewarm host, last repeated host, unknown/closed/incapable/excluded refusals and unchanged regular-run placement');
  const f = fixture(), r = await run(f, ['prewarm'], 'mkdir -p build; echo warmed > build/cache'); ok(r);
  assert.equal(r.summary.mode, 'prewarm'); assert.equal(r.summary.shards.length, 2);
  assert.deepEqual(r.summary.shards.map(shard => shard.slot).sort(), ['devbox-cn-light', 'devbox-cn-light-2']);
  assert.ok(f.events().filter(e => e.op === 'run').every(e => e.nice === true));
  assert.ok(f.events().filter(e => e.op === 'acquire-call').every(e => e.args[0] === 'take'));
  returned(f);
  const busy = path.join(f.shared, 'locks/devbox-cn-1.d'); fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, 'info'), 'by\tforeign\npid\t1\n');
  const beforeBusy = f.events().length, selectedBusy = await run(f, ['prewarm', '--host', '192.0.2.1']); ok(selectedBusy);
  assert.deepEqual(selectedBusy.summary.shards, []);
  assert.deepEqual(f.events().slice(beforeBusy), [], 'busy selected host must not redirect work to the idle host');
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
  const selectedBlocked = await run(health, ['prewarm', '--host', '192.0.2.1']); ok(selectedBlocked);
  assert.deepEqual(selectedBlocked.summary.shards, []);
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
  // Keep both shards alive until both slots are acquired; tiny commands can
  // otherwise complete before the second shard acquires and legitimately reuse one slot.
  const rendezvous = `touch '${f.dir}/receipt-{shard}'; i=0; while [ ! -f '${f.dir}/receipt-1' ] || [ ! -f '${f.dir}/receipt-2' ]; do i=$((i+1)); [ "$i" -lt 250 ] || exit 9; sleep 0.02; done`;
  ok(await run(f, ['--shards', '2', '--env', 'DEVBOX_RUN_RECEIPT=wrong'], command + '; ' + rendezvous));
  assert.deepEqual(fs.readFileSync(exclude), before, 'idempotent update preserves all existing exclude bytes');
  assert.equal(fs.readFileSync(exclude, 'utf8').split('\n').filter(line => line === '/.devbox-run.json').length, 1);
  assert.equal(git(workspace(f, '192.0.2.1', 'devbox-cn-2'), 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'), exclude);
  returned(f);
  console.log('PASS clean git status with discoverable receipt, worktree-aware shared exclude, idempotence and existing-rule preservation');
}

async function resProgressScenarios() {
  const f = fixture({ acquireProgress: true, progressStderrDelay: 250 });
  let observed = false;
  const result = await run(f, ['--env', 'N=1', '--env', 'LABEL=fixture-long-value'],
    'printf "result: %s23 %s\\n" "$N" "$LABEL"; printf "MY_PASS=fixture-remote-value\\n"', () => {
    const out = fs.readdirSync(f.dir).find(name => name.startsWith('out-'));
    if (!out) return false;
    const file = path.join(f.dir, out, 'shard-1-state.json');
    if (!fs.existsSync(file)) return false;
    const events = JSON.parse(fs.readFileSync(file)).resEvents || [];
    return ['waiter-start', 'rollback', 'ack'].every(kind => events.some(event => event.kind === kind));
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
      const request = id => spawnSync(process.execPath,[script,'stop','--out',out,'--run-id',id], { env: f.env, encoding: 'utf8' });
      // A stale receipt from another run must not stop either the job or the foreign process.
      assert.equal(request(stale).status, 1);
      assert.ok(!fs.existsSync(path.join(out,'stop-'+receipt.runId)));
      const stopped = request(receipt.runId);
      assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
      const stopReceipt = JSON.parse(fs.readFileSync(path.join(out, 'stop-result.json')));
      assert.match(stopReceipt.stopId, /^[0-9a-f-]{36}$/);
      assert.notEqual(stopReceipt.stopId, receipt.runId);
      assert.match(stopped.stdout, new RegExp('stopId=' + stopReceipt.stopId));
      assert.ok(stopped.stdout.split('\n').filter(line => line.startsWith('{')).map(JSON.parse).some(value => value.stopId === stopReceipt.stopId));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, `stop-${stopReceipt.stopId}.json`))), stopReceipt);
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
      const data = { control:active, workspace:f.dir, slot:'devbox-cn-1', seconds:5, env:{},
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
      const streamControl = path.join(f.dir, 'linux-stream-drop'); fs.mkdirSync(streamControl);
      const stream = spawn('python3', ['-c', remoteScripts.run, Buffer.from(JSON.stringify({
        control: streamControl, workspace: f.dir, slot:'devbox-cn-1', seconds: 5, env: {}, stream: true,
        command: 'echo before-drop; sleep 0.5; echo after-drop; exit 3',
      })).toString('base64')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let delivered = Buffer.alloc(0);
      stream.stdout.on('data', chunk => { delivered = Buffer.concat([delivered, chunk]); });
      const streamClosed = new Promise(resolve => stream.once('close', resolve));
      try {
        const deadline = Date.now() + 5000;
        while (!delivered.includes(Buffer.from('before-drop')) && Date.now() < deadline) await sleep(10);
        assert.match(delivered.toString(), /before-drop/);
        stream.kill('SIGHUP'); await streamClosed;
        const recovered = spawnSync('python3', ['-c', remoteScripts.result, Buffer.from(JSON.stringify({
          control: streamControl, offset: delivered.length, seconds: 5,
        })).toString('base64')], { encoding: 'utf8', timeout: 8000 });
        assert.equal(recovered.status, 0, recovered.stderr);
        const record = JSON.parse(recovered.stdout);
        assert.equal(record.exit, 3);
        assert.equal(Buffer.from(record.tail, 'base64').toString(), 'after-drop\n');
        assert.equal(reconnect(streamControl).stdout.trim(), 'group-gone');
      } finally {
        stream.kill('SIGTERM');
        const cleaned = spawnSync('python3', ['-c', remoteScripts.cleanup,
          Buffer.from(JSON.stringify({ control: streamControl })).toString('base64')], { timeout: 25000 });
        assert.equal(cleaned.status, 0);
      }
    }
    const alive = await Promise.race([closed.then(() => false), sleep(100).then(() => true)]);
    assert.equal(alive,true,'the foreign process survived both stop and cleanup');
  } finally { other.kill('SIGTERM'); await closed; }
  console.log('PASS UUID stop targets its own run; stale remote ownership records preserve foreign process');
}

async function metricScenarios() {
  const host = '192.0.2.1';
  const load = path.join(temp, 'loadavg'), mem = path.join(temp, 'meminfo'), io = path.join(temp, 'pressure-io');
  fs.writeFileSync(load, '99.00 2.50 1.00 1/1 1\n');
  fs.writeFileSync(mem, 'MemTotal: 33554432 kB\nMemAvailable: 25165824 kB\n');
  fs.writeFileSync(io, 'some avg10=12.34 avg60=23.45 avg300=1.00 total=1234\nfull avg10=4.56 avg60=2.00 avg300=0.00 total=567\n');
  const metricsSource = remoteScripts.metrics.replace("'/proc/loadavg'", JSON.stringify(load))
    .replace("'/proc/meminfo'", JSON.stringify(mem)).replace("'/proc/pressure/io'", JSON.stringify(io));
  const actual = JSON.parse(execFileSync('python3', ['-c', metricsSource, Buffer.from(JSON.stringify({ root: temp })).toString('base64')], { encoding: 'utf8' }));
  assert.ok(actual.cores > 0);
  assert.equal(actual.load5, 2.5);
  assert.equal(actual.memAvailableGiB, 24);
  assert.ok(actual.freeGiB > 0);
  assert.deepEqual([actual.io_some_avg10, actual.io_some_avg60, actual.io_full_avg10], [12.34, 23.45, 4.56]);
  fs.rmSync(io);
  const missing = JSON.parse(execFileSync('python3', ['-c', metricsSource, Buffer.from(JSON.stringify({ root: temp })).toString('base64')], { encoding: 'utf8' }));
  assert.deepEqual([missing.io_some_avg10, missing.io_some_avg60, missing.io_full_avg10], [null, null, null]);
  const config = f => path.join(f.shared, 'machine.conf');
  const setGate = (f, enabled) => fs.writeFileSync(config(f), `DEVBOX_DYNAMIC_ADMISSION=${enabled}\nDEVBOX_DYNAMIC_HOSTS=${host}\n`);
  const f = fixture({ ioMetrics: { io_some_avg10: 12.34, io_some_avg60: 23.45, io_full_avg10: 4.56 } });
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
  assert.deepEqual({ ...sample, at: 0 }, { at: 0, cores: 8, load5: 2.5, memAvailableGiB: 24, freeGiB: 100,
    io_some_avg10: 12.34, io_some_avg60: 23.45, io_full_avg10: 4.56 });
  const ioState = path.join(f.shared, 'devbox-metrics', host + '.io-state.json');
  fs.writeFileSync(ioState, JSON.stringify({ closed: true }));
  assert.ok(Date.now() / 1000 - sample.at < 60);
  ok(await run(f));
  assert.deepEqual(JSON.parse(fs.readFileSync(ioState)), { closed: true }, 'sample refresh preserves separate hysteresis state');
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
  const hard = await run(f, ['--timeout', '0.05', '--queue-timeout', '0.05', '--exclude-host', '192.0.2.2', '--exclude-reason', 'fixture binding']);
  assert.equal(hard.code, 125);
  assert.equal(hard.summary.shards[0].softExclusionsDropped, undefined);
  assert.ok(f.events().every(event => event.op !== 'run' || event.host === '192.0.2.2'));
  assert.deepEqual(fs.readdirSync(path.join(f.shared, 'locks')), ['devbox-cn-1.d']);
  console.log('PASS runner soft-exclusion summary and failure guidance, hard filter, and foreign hold preservation');
}

async function sshDropScenarios() {
  const unit = 'apps/app-ui/e2e/units/exports-b--en.json';
  const gone = fixture({ postStartFailure: true, reconnectRetries: true, recordedUnit: unit });
  fs.mkdirSync(path.dirname(path.join(gone.repo, unit)), { recursive: true });
  fs.writeFileSync(path.join(gone.repo, unit), '{"fixture":true}\n');
  git(gone.repo, 'add', '.'); git(gone.repo, 'commit', '-qm', 'unit receipt fixture');
  const units = path.join(gone.dir, 'units.txt'); fs.writeFileSync(units, unit + '\n');
  const completed = await run(gone, ['--units-file', units]);
  assert.equal(completed.code, 0);
  assert.equal(completed.summary.shards[0].sshDropRecovered, true);
  assert.equal(completed.summary.shards[0].attempts[0].sshExit, 255);
  assert.deepEqual(completed.summary.shards[0].attempts[0].unitTimings,
    [{ unit, exit: 0, durationSec: 349.366333442 }]);
  assert.match(completed.stdout, /remaining output tail/);
  assert.match(completed.stdout, /SSH drop recovered: recorded remote exit=0/);
  assert.equal(completed.summary.shards[0].attempts[0].sshRecovery, 'group-gone');
  assert.equal(gone.events().filter(e => e.op === 'run').length, 1);
  assert.equal(gone.events().filter(e => e.op === 'reconnect').length, 2);
  assert.ok(!gone.events().some(e => e.op === 'cleanup'));
  returned(gone);

  for (const privateTail of [true, 'split']) {
    const privateDrop = fixture({ postStartFailure: true, privateTail });
    const privateRecovered = await run(privateDrop);
    assert.equal(privateRecovered.code, 0);
    assert.doesNotMatch(privateRecovered.stdout, /FAKE_PRIVATE_TAIL_ONLY/);
    assert.equal((privateRecovered.stdout.match(/\[MASKED PRIVATE KEY BLOCK\]/g) || []).length, 1);
    returned(privateDrop);
  }

  const failed = fixture({ postStartFailure: true, remoteExit: 3 });
  const failure = await run(failed, ['--artifact', 'source.txt']);
  assert.equal(failure.code, 3);
  assert.equal(failure.summary.shards[0].sshDropRecovered, true);
  assert.ok(failed.events().some(e => e.op === 'artifacts'));
  returned(failed);

  const finishing = fixture({ postStartFailure: true, completeOnReconnect: true });
  const reattached = await run(finishing);
  assert.equal(reattached.code, 0);
  assert.equal(reattached.summary.shards[0].sshDropRecovered, true);
  returned(finishing);

  const unreadable = fixture({ postStartFailure: true, unreadableResult: true });
  const unconfirmed = await run(unreadable);
  assert.equal(unconfirmed.code, 255);
  assert.equal(unconfirmed.summary.shards[0].reason, 'ssh-drop-unconfirmed');
  assert.equal(unconfirmed.summary.shards[0].sshDropRecovered, undefined);
  assert.equal(unreadable.events().filter(e => e.op === 'result').length, 3);
  returned(unreadable);

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
  console.log('PASS SSH drop recovers recorded success/failure and output/artifacts, retries unreadable status, and retains live jobs until explicit stop');
}

async function budgetScenarios() {
  const f = fixture();
  const args = ['--project','fixture','--task','budget','--repo',f.repo,'--timeout','30'];
  const opts = parseArgs([...args,'--','true']);
  assert.equal(opts.queueTimeout,30);
  assert.equal(parseArgs([...args,'--timeout','5','--','true']).queueTimeout,30);
  assert.equal(parseArgs([...args,'--timeout','90','--','true']).queueTimeout,90);
  for (const value of ['0','121','NaN']) assert.throws(() => parseArgs([...args,'--queue-timeout',value,'--','true']));
  let clock=0, timer, cancelled;
  const budgets=runBudgets(opts,code=>{cancelled=code;},()=>clock,(fn,ms)=>{timer={fn,ms};return timer;},()=>{timer=undefined;});
  assert.equal(budgets.queue(),1800000);
  // W448 BC-167, run 63612849-b389-4b14-8524-c4d460ccdeca: exact evidence.
  clock += 1565.58203975*1000;
  clock += 142.92348416700005*1000;
  assert.ok(Math.abs(budgets.remaining()/1000-91.494476083)<.001);
  assert.equal(budgets.command(),true);
  assert.equal(timer.ms,1815000,'full 30-minute command plus receipt grace after 26.1-minute admission and 2.4-minute transfer');
  clock += 95.70279241700005*1000;
  assert.equal(cancelled,undefined,'old remaining budget does not cancel the command');
  budgets.finish();
  budgets.queue(); assert.ok(timer.ms<92000,'retry queue/preparation remains cumulative');
  timer.fn(); assert.equal(cancelled,125);
  assert.equal(commandOutcome(125,budgets.expiredBudget).outcome,'queue-transfer-timeout');
  const watchdog=runBudgets(opts,code=>{cancelled=code;},()=>clock,(fn,ms)=>{timer={fn,ms};return timer;},()=>{});
  watchdog.queue(); watchdog.command(); timer.fn(); assert.equal(cancelled,124); watchdog.finish();
  assert.equal(commandOutcome(143,watchdog.expiredBudget).outcome,'command-timeout');
  assert.equal(commandOutcome(0).outcome,'success');
  assert.equal(commandOutcome(7).outcome,'command-failed');
  assert.equal(commandOutcome(125).outcome,'command-failed','a recorded command exit 125 is distinct from preparation expiry');
  assert.equal(commandOutcome(143).outcome,'cancelled');
  const scaled=fixture({admissionDelay:5219,transferDelay:476});
  const completed=await run(scaled,['--timeout','0.1','--queue-timeout','0.5'],'sleep 1.5; echo command-finished');
  ok(completed); returned(scaled);
  const a=completed.summary.shards[0].attempts[0];
  assert.equal(a.commandBudgetSec,6); assert.equal(a.outcome,'success');
  assert.ok(a.phaseTimings.seconds.slotWaitAdmission>=5.219);
  assert.ok(a.phaseTimings.seconds.sourceTransferIn>=.476);
  assert.ok(a.phaseTimings.seconds.remoteCommand>=1.5);
  assert.ok(a.durationSec>6,'work runs after the old combined deadline');
  const recovered=fixture({postStartFailure:true,remoteExit:124,badArtifact:true});
  const expired=await run(recovered,['--artifact','missing.txt']);
  assert.equal(expired.code,124); assert.equal(expired.summary.outcome,'command-timeout');
  assert.equal(expired.summary.shards[0].attempts[0].commandExit,124);
  assert.match(expired.stdout,/recorded remote exit=124/);
  assert.match(expired.stdout,/artifact fetch failed \(66\); command timed out \(--timeout command budget\)/);
  assert.ok(!expired.stdout.includes('command succeeded')); returned(recovered);
  const timed=fixture();
  const deadline=await run(timed,['--timeout','0.035'],'sleep 60');
  assert.equal(deadline.code,124); assert.equal(deadline.summary.outcome,'command-timeout'); returned(timed);
  const queued=fixture();
  for (const slot of ['devbox-cn-1','devbox-cn-2']) {
    const lock=path.join(queued.shared,'locks',slot+'.d'); fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock,'info'),'by\tforeign\npid\t1\n');
  }
  const noAdmission=await run(queued,['--queue-timeout','0.04','--timeout','1']);
  assert.equal(noAdmission.code,125); assert.equal(noAdmission.summary.outcome,'queue-transfer-timeout');
  assert.match(noAdmission.stdout,/queue\/transfer limit reached; command did not get its budget/);
  assert.ok(!queued.events().some(e=>e.op==='run'));
  assert.equal(fs.readdirSync(path.join(queued.shared,'locks')).length,2,'foreign holds preserved');
  const transfer=fixture({transferDelay:10000});
  const noTransfer=await run(transfer,['--queue-timeout','0.1','--timeout','1']);
  assert.equal(noTransfer.code,125); assert.equal(noTransfer.summary.outcome,'queue-transfer-timeout');
  assert.ok(!transfer.events().some(e=>e.op==='run')); returned(transfer);
  console.log('PASS BC-167 exact timing shape, independent command budget, cumulative preparation limit, queue/upload expiry and recovered-124 artifact outcome');
}

async function stopShardScenarios() {
  const rotated=fixture();
  rotated.env.RES_COMMAND=fileURLToPath(new URL('../res/res',import.meta.url));
  const asset=await fingerprint(path.join(rotated.repo,'source.txt'));
  const rebuilt=await run(rotated,['--input',`name=asset,hash=${asset.hash},rebuildable=yes,cost=1s,size=0.01,seed=cmd:printf 'first\\n' > "$DEVBOX_INPUT_PATH"`],
    'sleep 60', events=>events.filter(e=>e.op==='group').length===2, (_,out)=>{
      const active=JSON.parse(fs.readFileSync(path.join(out,'active-1.json')));
      const commands=rotated.events().filter(e=>e.op==='run');
      assert.notEqual(commands[0].control,commands[1].control);
      assert.equal(active.retainedRun.control,commands[1].control,'active receipt follows seed supervisor rotation');
      const held=JSON.parse(fs.readFileSync(path.join(rotated.shared,'devbox-run-holds',active.slot+'.json')));
      assert.equal(held.control,commands[1].control);
      const stopped=spawnSync(process.execPath,[script,'stop','--out',out,'--run-id',active.runId],{env:rotated.env,encoding:'utf8'});
      assert.equal(stopped.status,0,stopped.stdout+stopped.stderr);
    });
  assert.equal(rebuilt.code,143); returned(rotated);

  for (const blocked of [false,true]) {
    const f=fixture({postStartFailure:true,remoteRunning:true});
    const held=await run(f,['--shards','2']); assert.equal(held.code,255);
    const attempts=held.summary.shards.map(s=>s.attempts[0]);
    const dead=attempts[1];
    // Recover an older ordinary cleanup-pending shard with no retained receipt.
    delete held.summary.shards[1].attempts[0].retainedRun;
    fs.writeFileSync(path.join(held.out,'summary.json'),JSON.stringify(held.summary));
    fs.unlinkSync(path.join(held.out,'active-2.json')); fs.unlinkSync(path.join(held.out,'retained-2.json'));
    const lock=path.join(f.shared,'locks',dead.slot+'.d','info');
    fs.writeFileSync(lock,fs.readFileSync(lock,'utf8').replace(/^pid\t.*$/m,'pid\t2147483647'));
    const holdFile=path.join(f.shared,'devbox-run-holds',dead.slot+'.json');
    const hold=JSON.parse(fs.readFileSync(holdFile)); hold.holder.pid='2147483647'; fs.writeFileSync(holdFile,JSON.stringify(hold));
    if (!blocked) fs.unlinkSync(path.join(f.shared,'devbox-run-holds',attempts[0].slot+'.json'));
    if (blocked) fs.writeFileSync(path.join(f.dir,'config.json'),JSON.stringify({...f.config,stopFailureHost:attempts[0].host}));
    const before=f.events().length;
    const stop=spawnSync(process.execPath,[script,'stop','--out',held.out,'--run-id',held.summary.runId],{env:f.env,encoding:'utf8',timeout:60000});
    assert.equal(stop.status,blocked?70:0,stop.stdout+stop.stderr);
    const events=f.events().slice(before);
    assert.equal(events.filter(e=>e.op==='cleanup').length,2,'every shard reached, including dead local holder');
    const receipt=JSON.parse(fs.readFileSync(path.join(held.out,'stop-result.json')));
    assert.match(stop.stdout,new RegExp('stopId='+receipt.stopId));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(held.out,`stop-${receipt.stopId}.json`))),receipt);
    assert.equal(receipt.results.length,2);
    assert.equal(receipt.results.filter(r=>r.returned).length,blocked?1:2);
    if (blocked) {
      assert.match(stop.stderr,new RegExp('host='+attempts[0].host+' pgid=12345 processes=3'));
      assert.ok(fs.existsSync(path.join(f.shared,'devbox-cleanup-pending',attempts[0].slot+'.json')));
      assert.ok(!fs.existsSync(path.join(f.shared,'devbox-cleanup-pending',dead.slot+'.json')));
      fs.writeFileSync(path.join(f.dir,'config.json'),JSON.stringify(f.config));
      const retry=spawnSync(process.execPath,[script,'stop','--out',held.out,'--run-id',held.summary.runId],{env:f.env,encoding:'utf8'});
      assert.equal(retry.status,0,retry.stdout+retry.stderr);
    }
    returned(f);
    assert.deepEqual(fs.readdirSync(path.join(f.shared,'devbox-cleanup-pending')),[]);
  }
  console.log('PASS two-shard stop recovers dead-holder cleanup-pending receipts, continues after one failure, confirms zero before return and preserves unresolved markers');
}

async function affinityScopeScenarios() {
  const f = fixture({ warmFamily: true });
  ok(await run(f, ['--affinity', 'shared-caller-name'])); returned(f);
  const firstAcquire = f.events().find(e => e.op === 'acquire-call');
  assert.ok(firstAcquire.args.includes('--warm-family'));
  fs.unlinkSync(path.join(workspace(f), '.devbox-run.json'));
  let before = f.events().length;
  ok(await run(f, ['--affinity', 'shared-caller-name'])); returned(f);
  const invalidated = f.events().slice(before).find(e => e.op === 'acquire-call');
  assert.ok(!invalidated.args.includes('--prefer-host'), 'missing receipt cannot retain runner affinity');
  assert.deepEqual(invalidated.warmMarkers, [false], 'invalidate before the controller reads its own warm cache');
  before = f.events().length;
  ok(await run(f, ['--affinity', 'shared-caller-name', '--project', 'other-project'])); returned(f);
  assert.ok(f.events().slice(before).filter(e => e.op === 'acquire-call').every(e => !e.args.includes('--prefer-host')),
    'a caller key cannot carry affinity across project identities');
  git(f.repo, 'checkout', '-qb', 'different-ref');
  before = f.events().length;
  ok(await run(f, ['--affinity', 'shared-caller-name'])); returned(f);
  assert.ok(f.events().slice(before).filter(e => e.op === 'acquire-call').every(e => !e.args.includes('--prefer-host')),
    'a caller key cannot carry affinity across ref families');
  const entries = Object.entries(JSON.parse(fs.readFileSync(path.join(f.shared, 'devbox-affinity.json'))));
  assert.equal(entries.length, 3);
  assert.ok(entries.every(([key, value]) => key.startsWith('id-') && value.repository && value.refFamily && value.verifiedWorkspace));
  const finalAcquire = f.events().filter(e => e.op === 'acquire-call').at(-1);
  assert.equal(finalAcquire.args[finalAcquire.args.indexOf('--warm-family') + 1], entries.at(-1)[1].refFamily);
  console.log('PASS affinity keys are project/repository/ref scoped and remembered worktrees are receipt verified');
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
  const beforeReady=f.events().filter(event=>event.op==='inputs-ready').length;
  const beforeMap=f.events().filter(event=>event.op==='input-map').length;
  const second=await run(f,['--input',input],command);ok(second);assert.equal(second.summary.shards[0].attempts[0].seeds.length,0);returned(f);
  assert.equal(f.events().filter(event=>event.op==='inputs-ready').length-beforeReady,1);
  assert.equal(f.events().filter(event=>event.op==='input-map').length,beforeMap,'unchanged inputs need no separate map/disk invocation');
  assert.ok(second.summary.shards[0].attempts[0].phaseTimings.substeps.inputPreparation['ssh.inputs-ready']>0);
  assert.equal(second.summary.shards[0].attempts[0].phaseTimings.substeps.inputPreparation['ssh.inspect'],undefined);
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
  await seedPolicyScenarios();
}

async function seedPolicyScenarios() {
  const res=fileURLToPath(new URL('../res/res',import.meta.url));
  const make=options=>{const f=fixture(options);f.env.RES_COMMAND=res;return f;};
  const readAsset=`node -e 'const fs=require("fs");const paths=JSON.parse(fs.readFileSync(process.env.DEVBOX_INPUTS_FILE));if(fs.readFileSync(paths.asset,"utf8")!=="first\\n")process.exit(9)'`;
  for (const kind of ['file','directory']) {
    const f=make(), seed=path.join(f.dir,kind==='file'?'asset.aar':'assets');
    if(kind==='directory'){fs.mkdirSync(seed);fs.writeFileSync(path.join(seed,'item.txt'),'first\n');}
    else fs.writeFileSync(seed,'first\n');
    const actual=await fingerprint(seed);
    const command=kind==='file'?readAsset:readAsset.replace('paths.asset,"utf8"','require("path").join(paths.asset,"item.txt"),"utf8"');
    const result=await run(f,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1211s,size=0.01,seed=${seed}`],command);ok(result);returned(f);
    const attempt=result.summary.shards[0].attempts[0];
    assert.equal(attempt.seeds.length,1,`${kind} seed transfers despite rebuild cost above the seed command limit`);
    assert.deepEqual(attempt.unseededInputs,[]);assert.doesNotMatch(result.stdout,/seed command skipped|was never created/);
    assert.equal(f.events().filter(event=>event.op==='input-exists').length,0,'seeded inputs need no absence check');
  }
  const commandSeed=`seed=cmd:printf 'first\\n' > "$DEVBOX_INPUT_PATH"`;
  const skipped=make(), actual=await fingerprint(path.join(skipped.repo,'source.txt'));
  const failed=await run(skipped,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1211s,size=0.01,${commandSeed}`,
    '--input','name=other,hash=none,rebuildable=yes,cost=0s,size=0'],'echo MAIN-COMMAND; exit 7');
  assert.equal(failed.code,7);returned(skipped);
  const failedAttempt=failed.summary.shards[0].attempts[0];
  assert.equal(failedAttempt.commandExit,7);assert.equal(failedAttempt.seeds.length,0);
  assert.equal(failedAttempt.unseededInputs.length,2);assert.equal(failedAttempt.uncreatedInputs.length,2);
  for (const input of failedAttempt.unseededInputs) {
    const notice=input.name==='asset'
      ? `input asset: seed command skipped (cost 1211s > limit 300s); the remote command must create ${input.path}; use --prewarm to seed first`
      : `input other: no seed; the remote command must create ${input.path}`;
    assert.equal(input.message,notice);assert.equal(failedAttempt.inputPaths[input.name],input.path);
    assert.ok(failed.stdout.includes(notice));assert.ok(failed.stdout.indexOf(notice)<failed.stdout.indexOf('MAIN-COMMAND'));
    const missing=failedAttempt.uncreatedInputs.find(record=>record.name===input.name);
    assert.equal(missing.message,`input ${input.name} was never created at ${input.path}`);
    assert.ok(failed.stdout.includes(missing.message));assert.ok(failed.stdout.indexOf(missing.message)>failed.stdout.indexOf('MAIN-COMMAND'));
    assert.ok(fs.readFileSync(failed.summary.shards[0].log,'utf8').includes(missing.message));
    assert.equal(failedAttempt.phaseTimings.inputs[input.name].rebuildInRemoteCommand,true);
  }
  assert.equal(skipped.events().filter(event=>event.op==='run').length,1,'over-limit command seed never runs');
  assert.equal(skipped.events().filter(event=>event.op==='input-exists').length,1,'missing inputs share one stat-only check');

  const empty=make();
  const emptyResult=await run(empty,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1211s,size=0.01,seed=cmd:`],'echo MAIN-COMMAND');ok(emptyResult);returned(empty);
  assert.match(emptyResult.stdout,/seed command skipped \(cost 1211s > limit 300s\)/,'an empty command is still a command seed');
  assert.equal(empty.events().filter(event=>event.op==='run').length,1);

  const absent=make();
  const absentResult=await run(absent,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1s,size=0.01`],'echo MAIN-COMMAND');ok(absentResult);returned(absent);
  const absentAttempt=absentResult.summary.shards[0].attempts[0];
  assert.equal(absentAttempt.uncreatedInputs.length,1,'absence after a successful command is diagnostic, not an exit override');
  assert.ok(absentResult.stdout.includes(absentAttempt.unseededInputs[0].message));
  assert.ok(absentResult.stdout.includes(absentAttempt.uncreatedInputs[0].message));

  for (const [content,exit] of [['first\n',0],['wrong\n',7]]) {
    const f=make();
    const command=`node -e 'const fs=require("fs");const paths=JSON.parse(fs.readFileSync(process.env.DEVBOX_INPUTS_FILE));fs.mkdirSync(require("path").dirname(paths.asset),{recursive:true});fs.writeFileSync(paths.asset,${JSON.stringify(content)});console.log("MAIN-COMMAND");process.exit(${exit})'`;
    const result=await run(f,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1s,size=0.01`],command);assert.equal(result.code,exit);returned(f);
    const attempt=result.summary.shards[0].attempts[0];
    assert.equal(attempt.unseededInputs.length,1);assert.deepEqual(attempt.uncreatedInputs,[]);
    assert.doesNotMatch(result.stdout,/was never created/,'existence must not be inferred from hash validity');
    if(!exit)assert.ok(JSON.parse(fs.readFileSync(indexFile(f.shared,result.summary.shards[0].host))).inputs['asset+'+actual.hash]);
  }

  const observed=make(), command='echo MAIN-COMMAND';
  ok(await run(observed,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1s,size=0.01`],command));returned(observed);
  const dir=path.join(observed.shared,'timings'), file=path.join(dir,fs.readdirSync(dir)[0]);
  const setSamples=samples=>{const history=JSON.parse(fs.readFileSync(file));for(const entry of Object.values(history.commands))entry.placement.inputs['asset+'+actual.hash]=samples;fs.writeFileSync(file,JSON.stringify(history));};
  setSamples([1210,1211,1212]);
  const expensive=await run(observed,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1s,size=0.01,${commandSeed}`],command);ok(expensive);returned(observed);
  assert.match(expensive.stdout,/seed command skipped \(cost 1211s > limit 300s\)/,'observed command cost overrides a small declaration');
  setSamples([1,2,3]);
  const cheap=await run(observed,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1211s,size=0.01,${commandSeed}`],command);ok(cheap);returned(observed);
  assert.equal(cheap.summary.shards[0].attempts[0].seeds.length,1,'observed cheap command runs despite a high declaration');

  const prewarm=make();
  const warmed=await run(prewarm,['prewarm','--host','192.0.2.1','--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1211s,size=0.01,${commandSeed}`],readAsset);ok(warmed);returned(prewarm);
  assert.equal(warmed.summary.shards[0].attempts[0].seeds.length,1,'prewarm overrides the command cost limit');
  assert.doesNotMatch(warmed.stdout,/seed command skipped|was never created/);

  for (const exit of [0,7]) {
    const f=make({inputExistenceFailure:true});
    const result=await run(f,['--input',`name=asset,hash=${actual.hash},rebuildable=yes,cost=1s,size=0.01`],`exit ${exit}`);assert.equal(result.code,exit);returned(f);
    const attempt=result.summary.shards[0].attempts[0];
    assert.ok(attempt.inputExistenceError);assert.equal(attempt.uncreatedInputs,undefined);
    assert.doesNotMatch(result.stdout,/was never created/,'an unavailable existence check must not invent absence');
  }
  console.log('PASS local file/directory seeds above limit, declared/observed command limits, per-input notices, failed/successful command absence receipts, existence-only checks and prewarm override');
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

async function cleanupPendingScenarios() {
  const f=fixture({badCleanup:true});
  const old=await run(f); assert.equal(old.code,70);
  const attempt=old.summary.shards[0].attempts[0];
  const markerFile=path.join(f.shared,'devbox-cleanup-pending',attempt.slot+'.json');
  const marker=JSON.parse(fs.readFileSync(markerFile));
  assert.equal(marker.runs[0].runId,old.summary.runId); assert.equal(marker.runs[0].host,attempt.host);
  const oldTake=f.events().find(event=>event.op==='take');
  assert.equal(spawnSync('res',['return',attempt.slot,'--by',oldTake.by],{env:f.env}).status,0);
  assert.equal(fs.existsSync(markerFile),true,'ordinary return never clears a cleanup-pending marker');
  marker.runs[0].at=1; fs.writeFileSync(markerFile,JSON.stringify(marker));
  const actual=fileURLToPath(new URL('../res/res',import.meta.url));
  const env={...f.env,RES_COMMAND:actual,RES_DEVBOX_RUNNER:script};
  const config=fields=>fs.writeFileSync(path.join(f.dir,'config.json'),JSON.stringify({...f.config,...fields}));
  const res=(args)=>spawnSync(actual,args,{env,encoding:'utf8',timeout:30000});
  const common=['--by','pending-next','--project','fixture','--task','pending-next','--for','fixture pending check','--pid',String(process.pid)];
  const start=f.events().length;
  config({remoteRunning:true});
  const status=res(['status',attempt.slot]); assert.equal(status.status,0,status.stderr); assert.match(status.stdout,/cleanup pending/);
  assert.equal(f.events().length,start,'res status does not SSH or expire a marker');
  const withDeviceEnv={...env};
  fs.appendFileSync(path.join(f.shared,'resources.tsv'),'fixture-phone\tphone\tnever\tnot-a-real-device\tfixture device\n');
  const deviceStatus=spawnSync(actual,['status'],{env:withDeviceEnv,encoding:'utf8',timeout:30000});
  assert.equal(deviceStatus.status,0,deviceStatus.stderr); assert.match(deviceStatus.stdout,/cleanup pending slot=devbox-cn-1/);
  assert.equal(f.events().length,start,'device-present status also leaves the marker and remote processes untouched');
  const refused=res(['take',attempt.slot,...common]); assert.notEqual(refused.status,0); assert.match(refused.stderr,/cleanup pending/);
  assert.equal(fs.existsSync(markerFile),true,'age alone never expires the marker');
  const alternate=res(['wait-pool','devbox-cn',...common,'--timeout','0.2']);
  assert.equal(alternate.status,0,alternate.stdout+alternate.stderr); assert.match(alternate.stdout,/slot=devbox-cn-2/);
  assert.equal(res(['return','devbox-cn-2','--by','pending-next']).status,0);
  config({pendingUnknown:true}); assert.notEqual(res(['take',attempt.slot,...common]).status,0); assert.equal(fs.existsSync(markerFile),true);
  config({pendingUnits:true}); assert.notEqual(res(['take',attempt.slot,...common]).status,0); assert.equal(fs.existsSync(markerFile),true);
  config({remoteRunning:false});
  const confirmed=res(['take',attempt.slot,...common]); assert.equal(confirmed.status,0,confirmed.stdout+confirmed.stderr);
  assert.equal(fs.existsSync(markerFile),false,'only the UUID-specific confirmed check clears the marker');
  assert.equal(res(['return',attempt.slot,'--by','pending-next']).status,0);
  assert.ok(f.events().slice(start).some(event=>event.op==='cleanup-pending'));
  assert.ok(!f.events().slice(start).some(event=>event.op==='cleanup'||event.op==='run'||event.op==='dead-slot'),'acquirers only probe the UUID and never signal another run');
  console.log('PASS durable cleanup pending after return, read-only status, old/live/unknown/unit markers block, alternate slot admission and confirmed UUID-only clearance');
}

async function deadSlotScenarios() {
  for (const running of [true,false]) {
    const f=fixture({remoteRunning:running});
    const slot='devbox-cn-1', lock=path.join(f.shared,'locks',slot+'.d');fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock,'info'),`by\tdead-fixture\npid\t2147483647\nhost\t${os.hostname()}\nstart\t${Math.floor(Date.now()/1000)-1000}\n`);
    const r=spawnSync(process.execPath,[script,'release-dead','--slot',slot],{env:f.env,encoding:'utf8',timeout:30000});
    assert.equal(r.status,running?1:0, r.stdout+r.stderr);
    assert.equal(fs.existsSync(lock),running);
    assert.equal(f.events().filter(e=>e.op==='dead-slot').length,1,JSON.stringify({stdout:r.stdout,stderr:r.stderr,ops:f.events().map(e=>e.op)}));
    assert.equal(f.events().filter(e=>e.op==='return').length,running?0:1);
  }
  const f=fixture(), slot='devbox-cn-1', lock=path.join(f.shared,'locks',slot+'.d');fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock,'info'),`by\tlive-fixture\npid\t${process.pid}\nhost\t${os.hostname()}\nstart\t${Math.floor(Date.now()/1000)-1000}\n`);
  const r=spawnSync(process.execPath,[script,'release-dead','--slot',slot],{env:f.env,encoding:'utf8',timeout:30000});
  assert.equal(r.status,1);assert.equal(f.events().length,0,'live owner never triggers SSH');
  const root=path.join(f.dir,'native-devbox-run'), workspace=path.join(root,'wt','fixture','store',slot);
  const otherWorkspace=path.join(root,'wt','fixture','store','devbox-cn-2');fs.mkdirSync(otherWorkspace,{recursive:true});
  const sameTaskOtherRun=spawn('/bin/sleep',['60'],{cwd:otherWorkspace,detached:true,stdio:'ignore'});
  const otherExit=new Promise(resolve=>sameTaskOtherRun.once('exit',resolve));
  fs.mkdirSync(workspace,{recursive:true});
  const child=spawn('/bin/sleep',['60'],{cwd:workspace,detached:true,stdio:'ignore'});
  const exit=new Promise(resolve=>child.once('exit',resolve));
  // The remote probe is Linux-only. macOS supplies the same /proc inputs while
  // retaining real live processes and the identical product matching logic.
  const procRoot=path.join(f.dir,'proc');fs.mkdirSync(procRoot);
  let source=remoteScripts['dead-slot'];
  if(process.platform!=='linux')source=source.replace("pathlib.Path('/proc')",`pathlib.Path(${JSON.stringify(procRoot)})`);
  const probe=()=>{
    if(process.platform!=='linux')for(const [pid,cwd] of [[child.pid,workspace],[sameTaskOtherRun.pid,otherWorkspace]]){
      const dir=path.join(procRoot,String(pid));fs.rmSync(dir,{recursive:true,force:true});
      try{process.kill(pid,0);}catch{continue;}
      fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'stat'),`${pid} (sleep) S 1 1 1`);fs.symlinkSync(fs.realpathSync(cwd),path.join(dir,'cwd'));
    }
    return spawnSync('python3',['-c',source,Buffer.from(JSON.stringify({root,slot})).toString('base64')],{encoding:'utf8'});
  };
  try { const evidence=probe();assert.equal(evidence.status,0,evidence.stderr);assert.equal(JSON.parse(evidence.stdout).clean,false); }
  finally {child.kill('SIGTERM');await exit;}
  try {
    const clean=probe();assert.equal(clean.status,0,clean.stderr);assert.equal(JSON.parse(clean.stdout).clean,true,'different live same-task slot must not block dead slot');
  } finally {sameTaskOtherRun.kill('SIGTERM');await otherExit;}
  console.log('PASS release-dead confirms old local holders and remote worktree cleanup; live work/owners retain slots');
}

async function overheadScenarios() {
  const f = fixture();
  const first = await run(f, [], 'mkdir -p build && printf cache > build/cache'); ok(first); returned(f);
  const inspected = f.events().filter(event => event.op === 'inspect').length;
  const second = await run(f, [], 'test -f build/cache'); ok(second); returned(f);
  assert.equal(second.summary.shards[0].attempts[0].checkoutSkipped, true);
  assert.equal(f.events().filter(event => event.op === 'checkout').length, 1);
  assert.equal(f.events().filter(event => event.op === 'inspect').length - inspected, 1, 'warm clean source uses one batched inspection');
  fs.writeFileSync(path.join(workspace(f), 'source.txt'), 'dirty');
  fs.writeFileSync(path.join(workspace(f), 'leftover.txt'), 'untracked');
  const dirty = await run(f, [], 'test ! -e leftover.txt && test -f build/cache'); ok(dirty); returned(f);
  assert.equal(dirty.summary.shards[0].attempts[0].checkoutSkipped, false);
  assert.ok(dirty.summary.shards[0].attempts[0].slotHygiene.patches.length);
  fs.mkdirSync(path.join(workspace(f),'empty-untracked'));
  const empty=await run(f,[],'test ! -d empty-untracked && test -f build/cache'); ok(empty); returned(f);
  assert.equal(empty.summary.shards[0].attempts[0].checkoutSkipped,false,'empty untracked directory falls back to git clean');
  assert.ok(f.events().filter(event=>event.op==='inspect').some(event=>event.reuseAllowed===false),'post-upload checks never run reuse inspection');
  const modules = fixture(); const pins = makeSubmoduleFixture(path.join(modules.dir, 'modules')); modules.repo = pins.repo;
  ok(await run(modules, ['--submodules'], pins.command)); returned(modules);
  const updates = modules.events().filter(event => event.op === 'submodule').length;
  const before = modules.events().filter(event => event.op === 'inspect').length;
  const repeated = await run(modules, ['--submodules'], pins.command); ok(repeated); returned(modules);
  assert.equal(repeated.summary.shards[0].attempts[0].checkoutSkipped, true);
  assert.equal(modules.events().filter(event => event.op === 'submodule').length, updates);
  assert.equal(modules.events().filter(event => event.op === 'inspect').length - before, 1);
  fs.writeFileSync(path.join(workspace(modules), 'engine/version'), 'dirty module');
  const repaired = await run(modules, ['--submodules'], pins.command); ok(repaired); returned(modules);
  assert.equal(repaired.summary.shards[0].attempts[0].checkoutSkipped, false);
  console.log('PASS clean-ref shortcut, one batched inspection for recursive pins, dirty-tree repair and ignored-cache preservation');
}

async function artifactDirectScenarios() {
  const smallArtifact = 'mkdir -p build && node -e "require(\'node:fs\').writeFileSync(\'build/random.bin\',require(\'node:crypto\').randomBytes(1048576))"';
  for (const lowArtifactDisk of [false, true]) {
    const f = fixture({ lowArtifactDisk });
    const r = await run(f, ['--artifact', 'build/random.bin'], lowArtifactDisk ? smallArtifact.replace('randomBytes(1048576)', 'randomBytes(32*1048576)') : smallArtifact);
    ok(r); returned(f);
    const attempt = r.summary.shards[0].attempts[0];
    assert.equal(attempt.artifactTransport.method, 'direct-ssh');
    assert.equal(attempt.phaseTimings.transferOut.resumable, false);
    assert.equal(attempt.phaseTimings.transferOut.reason, lowArtifactDisk ? 'low disk' : 'small set');
    assert.equal(attempt.phaseTimings.transferOut.timeoutSec, 900);
    assert.equal(f.events().filter(e => e.op === 'artifacts').length, 1, 'small/low-disk success adds no staging round trip');
    assert.equal(f.events().filter(e => ['artifact-range', 'artifact-release'].includes(e.op)).length, 0);
    const control = f.events().find(e => e.op === 'artifacts').control;
    for (const name of ['artifact-archive.tar', 'artifact-retention.json']) assert.equal(fs.existsSync(path.join(control, name)), false);
    if (lowArtifactDisk) assert.match(r.stdout, /not resumable \(low disk\)/);
    assert.deepEqual(execFileSync('tar', ['-xOf', attempt.artifact, 'build/random.bin'], { maxBuffer: 64 * 1048576 }), fs.readFileSync(path.join(workspace(f), 'build/random.bin')));
  }
  for (const artifactDirectFault of ['drop-once', 'corrupt-once']) {
    const f = fixture({ artifactDirectFault });
    const r = await run(f, ['--artifact', 'build/random.bin'], smallArtifact); ok(r); returned(f);
    const attempt = r.summary.shards[0].attempts[0];
    assert.equal(attempt.artifactDirectRecovered, true);
    assert.equal(attempt.phaseTimings.transferOut.resumeCount, 1);
    assert.equal(attempt.phaseTimings.transferOut.restartCount, artifactDirectFault === 'corrupt-once' ? 1 : 0);
    assert.equal(f.events().filter(e => e.op === 'artifacts' && e.forceStage).length, 1);
    const ranges = f.events().filter(e => e.op === 'artifact-range');
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].offset, artifactDirectFault === 'drop-once' ? 12345 : 0);
    assert.deepEqual(execFileSync('tar', ['-xOf', attempt.artifact, 'build/random.bin']), fs.readFileSync(path.join(workspace(f), 'build/random.bin')));
  }
  for (const artifactDirectFault of ['drop-always', 'stall-always']) {
    const f = fixture({ lowArtifactDisk: true, artifactDirectFault });
    const r = await run(f, ['--artifact', 'build/random.bin', '--artifact-timeout', '0.1'], smallArtifact); ok(r); returned(f);
    const attempt = r.summary.shards[0].attempts[0];
    assert.equal(attempt.artifactExit, artifactDirectFault === 'drop-always' ? 255 : 124);
    assert.equal(attempt.retainedRemotely, false); assert.equal(attempt.fetchArtifactCommand, undefined);
    assert.equal(attempt.phaseTimings.transferOut.reason, 'low disk');
    assert.equal(attempt.phaseTimings.transferOut.timeoutSec, 6);
    assert.equal(attempt.phaseTimings.transferOut.resumeCount, 0);
    assert.equal(f.events().filter(e => e.op === 'artifacts').length, 1);
    assert.match(r.stdout, /artifacts not retained; files remain/);
    assert.ok(r.stdout.includes(attempt.artifactsLeft.workspace));
  }
  for (const artifactDirectFault of ['corrupt-once', 'corrupt-always']) {
    const f = fixture({ lowArtifactDisk: true, artifactDirectFault });
    const r = await run(f, ['--artifact', 'build/random.bin'], smallArtifact); ok(r); returned(f);
    const attempt = r.summary.shards[0].attempts[0];
    assert.equal(attempt.phaseTimings.transferOut.restartCount, 1);
    assert.equal(f.events().filter(e => e.op === 'artifacts').length, 2);
    assert.equal(f.events().filter(e => e.op === 'artifact-range').length, 0);
    if (artifactDirectFault === 'corrupt-always') {
      assert.equal(attempt.artifactExit, 74); assert.equal(attempt.retainedRemotely, false);
      assert.equal(attempt.phaseTimings.transferOut.receivedBytes, 0);
    } else assert.ok(attempt.artifactSha256);
  }
  console.log('PASS cheap small readbacks, stage-on-break offset recovery, low-disk direct SHA-256 and timeout, explicit non-retention');
}

async function artifactResumeScenarios() {
  const randomArtifact = 'mkdir -p build && node -e "require(\'node:fs\').writeFileSync(\'build/random.bin\',require(\'node:crypto\').randomBytes(32*1048576))"';
  for (const artifactFault of ['drop-once', 'stall-once', 'corrupt-once']) {
    const f = fixture({ artifactFault });
    const r = await run(f, ['--artifact', 'build/random.bin', '--artifact-timeout', artifactFault === 'stall-once' ? '0.1' : '2'], randomArtifact);
    ok(r); returned(f);
    const attempt = r.summary.shards[0].attempts[0], ranges = f.events().filter(e => e.op === 'artifact-range');
    assert.equal(ranges.length, 2, artifactFault);
    assert.equal(ranges[1].offset, artifactFault === 'corrupt-once' ? 0 : 12345);
    assert.equal(attempt.phaseTimings.transferOut.resumeCount, artifactFault === 'corrupt-once' ? 0 : 1);
    assert.equal(attempt.phaseTimings.transferOut.restartCount, artifactFault === 'corrupt-once' ? 1 : 0);
    assert.ok(attempt.phaseTimings.transferOut.averageMBps > 0);
    assert.equal(attempt.phaseTimings.transferOut.receivedBytes, fs.statSync(attempt.artifact).size);
    assert.deepEqual(execFileSync('tar', ['-xOf', attempt.artifact, 'build/random.bin'], { maxBuffer: 64 * 1048576 }), fs.readFileSync(path.join(workspace(f), 'build/random.bin')));
    assert.equal(f.events().filter(e => e.op === 'artifact-release').length, 1);
  }
  for (const artifactFault of ['drop-always', 'stall-always', 'corrupt-always']) {
    const f = fixture({ artifactFault, diskCosts: true });
    const commandExit = artifactFault === 'corrupt-always' ? 7 : 0;
    const r = await run(f, ['--artifact', 'build/random.bin', '--artifact-timeout', artifactFault === 'stall-always' ? '0.1' : '2'], randomArtifact + '; exit ' + commandExit);
    assert.equal(r.code, commandExit); returned(f);
    const attempt = r.summary.shards[0].attempts[0];
    assert.equal(attempt.retainedRemotely, true);
    assert.equal(attempt.phaseTimings.transferOut.resumeCount, artifactFault === 'corrupt-always' ? 0 : 3);
    assert.equal(attempt.artifactExit, artifactFault === 'stall-always' ? 124 : artifactFault === 'drop-always' ? 255 : 74);
    assert.equal(attempt.phaseTimings.transferOut.restartCount, artifactFault === 'corrupt-always' ? 1 : 0);
    const receipt = JSON.parse(fs.readFileSync(attempt.artifactManifest));
    assert.ok(fs.existsSync(path.join(receipt.control, 'artifact-archive.tar')));
    assert.equal(f.events().filter(e => e.op === 'artifact-release').length, 0);
    assert.ok(r.stdout.includes(attempt.fetchArtifactCommand));
    if (artifactFault === 'drop-always') assert.equal(fs.statSync(attempt.artifactManifest.replace(/\.manifest\.json$/, '.tar')).size, 4 * 12345);
    // Run the exact recovery command after the link returns, then retire only this receipt.
    const boundedResume = artifactFault === 'drop-always', busyLight = path.join(f.shared, 'locks', 'devbox-cn-light.d');
    if (boundedResume) {
      fs.mkdirSync(busyLight); fs.writeFileSync(path.join(busyLight, 'info'), 'by\tfixture-foreign\npid\t1\n');
      fs.unlinkSync(path.join(f.dir, 'artifact-read-count'));
    }
    fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ ...f.config, artifactFault: boundedResume ? 'drop-once' : undefined }));
    const recovered = spawnSync('/bin/bash', ['-c', attempt.fetchArtifactCommand], { env: f.env, encoding: 'utf8' });
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    if (boundedResume) {
      const readback = JSON.parse(recovered.stdout.trim().split('\n').at(-1));
      assert.equal(readback.readbackAdmission, 'bounded-no-slot'); assert.equal(readback.transferOut.resumeCount, 1);
      assert.equal(f.events().filter(event => event.op === 'artifact-range').at(-1).offset, 12345);
      assert.ok(fs.existsSync(busyLight), 'archive resume preserves the foreign light hold');
      fs.rmSync(busyLight, { recursive: true });
    }
    returned(f);
    const retired = spawnSync(process.execPath, [script, 'retire-artifacts', '--receipt', receipt.run, '--host', receipt.host], { env: f.env, encoding: 'utf8' });
    assert.equal(retired.status, 0, retired.stdout + retired.stderr); returned(f);
    assert.equal(fs.existsSync(path.join(receipt.control, 'artifact-archive.tar')), false);
  }
  const cancelled = fixture({ artifactFault: 'stall-always' });
  const interrupted = await run(cancelled, ['--artifact', 'build/random.bin'], randomArtifact,
    events => events.some(e => e.op === 'artifact-range'));
  assert.equal(interrupted.code, 143); returned(cancelled);
  assert.equal(interrupted.summary.shards[0].attempts[0].retainedRemotely, true);
  assert.equal(interrupted.summary.shards[0].attempts[0].phaseTimings.transferOut.resumeCount, 0);
  console.log('PASS stalled/dropped range resumes, offset append, digest restart, bounded final failure, retained recovery command and retirement');

}

async function dataCleanupScenarios() {
  const f = fixture();
  fs.appendFileSync(path.join(f.repo, '.gitignore'), '.data/\n'); git(f.repo, 'add', '.gitignore'); git(f.repo, 'commit', '-qm', 'ignore run data');
  const first = await run(f, [], 'mkdir -p .data/stale && printf old > .data/stale/out'); ok(first); returned(f);
  const next = await run(f, [], 'test ! -e .data/stale && mkdir -p .data/latest && printf latest > .data/latest/out'); ok(next); returned(f);
  const receipt = next.summary.shards[0].attempts[0].dataCleanup;
  assert.deepEqual(receipt.entries.map(entry => entry.name), ['stale']); assert.equal(receipt.bytes, 3);
  assert.ok(fs.existsSync(path.join(workspace(f), '.data/latest/out')), 'latest data stays after the command');
  assert.match(next.stdout, /DEVBOX_DATA_CLEANUP=/);
  const opted = await run(f, ['--env', 'DEVBOX_KEEP_RUN_DATA=1'], 'test -f .data/latest/out'); ok(opted); returned(f);
  assert.equal(opted.summary.shards[0].attempts[0].dataCleanup.skipped, 'DEVBOX_KEEP_RUN_DATA=1');
  fs.writeFileSync(path.join(workspace(f), '.data/blocked'), 'blocked');
  fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ ...f.config, dataCleanupFailure: true }));
  const failed = await run(f, [], 'test -f .data/blocked && printf command-still-runs'); ok(failed); returned(f);
  assert.ok(failed.summary.shards[0].attempts[0].dataCleanup.warnings.some(warning => warning.includes('fixture cleanup failure')));
  assert.doesNotMatch(failed.stdout, /^\[cleanup-ineffective\]/m, 'partial cleanup is not a zero-byte warning');
  assert.match(failed.stdout, /command-still-runs/);
  for (let repeat = 0; repeat < 2; repeat++) {
    const ineffective = await run(f, [], 'test -f .data/blocked && printf still-runs'); ok(ineffective); returned(f);
    assert.equal(ineffective.summary.shards[0].attempts[0].dataCleanup.bytes, 0);
    assert.equal(ineffective.stdout.split('\n').filter(line => line.startsWith('[cleanup-ineffective]')).length, 1);
    assert.match(ineffective.stdout, /^\[cleanup-ineffective\].*fixture cleanup failure/m);
    const cleanupRun = f.events().filter(event => event.op === 'run').at(-1);
    const warningReceipt = JSON.parse(fs.readFileSync(path.join(cleanupRun.control, 'data-cleanup.json')));
    assert.deepEqual(warningReceipt.warnings, ineffective.summary.shards[0].attempts[0].dataCleanup.warnings);
  }
  assert.doesNotMatch(next.stdout, /^\[cleanup-ineffective\]/m);
  assert.doesNotMatch(opted.stdout, /^\[cleanup-ineffective\]/m);
  const retained = fixture();
  fs.appendFileSync(path.join(retained.repo, '.gitignore'), '.data/\n'); git(retained.repo, 'add', '.gitignore'); git(retained.repo, 'commit', '-qm', 'ignore retained run data');
  const saved = await run(retained, ['--artifact', '.data/retained/result.log', '--artifact-fetch', 'manifest'], 'mkdir -p .data/retained .data/stale; printf saved > .data/retained/result.log; printf old > .data/stale/out'); ok(saved); returned(retained);
  const reuse = await run(retained, [], 'test -f .data/retained/result.log && test ! -e .data/stale'); ok(reuse); returned(retained);
  assert.deepEqual(reuse.summary.shards[0].attempts[0].dataCleanup.entries.map(entry => entry.name), ['stale']);
  const outer = path.join(retained.dir, 'outside.txt'); fs.writeFileSync(outer, 'outside');
  fs.symlinkSync(outer, path.join(workspace(retained), '.data/escape'));
  const escape = await run(retained, [], 'echo escape-refused'); ok(escape); returned(retained);
  assert.ok(escape.summary.shards[0].attempts[0].dataCleanup.warnings.some(warning => warning.includes('symlink escape')));
  assert.equal(fs.readFileSync(outer, 'utf8'), 'outside'); assert.ok(fs.lstatSync(path.join(workspace(retained), '.data/escape')).isSymbolicLink());
  console.log('PASS pre-command data cleanup receipts, latest data lifetime, opt-out, retained data, symlink refusal and non-fatal failure');
}

async function muxScenarios() {
  const baseline = fixture();
  fs.writeFileSync(path.join(baseline.repo, 'source.txt'), 'local tracked change\n');
  fs.writeFileSync(path.join(baseline.repo, 'extra.txt'), 'overlay payload\n');
  const ordinary = await run(baseline); ok(ordinary); returned(baseline);
  for (const operation of ['checkout', 'bundle']) {
    const events = baseline.events().filter(event => event.op === operation);
    assert.ok(events.length, operation + ' exercised');
    assert.ok(events.every(event => !event.multiplexed), operation + ' independent without a mux error');
  }
  assert.ok(baseline.events().filter(event => ['store', 'inspect'].includes(event.op)).every(event => event.multiplexed), 'small metadata operations reuse their connection before degradation');
  // Verbatim SSH stderr from the owner's masked BC-168 extracts (both hosts).
  const bc168 = 'mm_send_fd: sendmsg(0): Message too long\r\nmux_client_request_session: send fds failed\n';
  const diagnostics = [bc168, 'mux send fds failed\n', 'mux_client_request_session: session request failed\n',
    'Control socket connect(/tmp/devbox-ssh/control): Connection refused\n', 'muxclient: master hello exchange failed\n'];
  for (const message of diagnostics) {
    assert.equal(muxFailure({ code: 255, stderr: message }), true);
    assert.equal(muxFailure({ code: 7, stderr: message }), false);
    const f = fixture({ muxMessage: message, muxOperation: 'store' });
    const result = await run(f); ok(result); returned(f);
    const events = f.events(), stores = events.filter(event => event.op === 'store');
    assert.deepEqual(stores.map(event => event.multiplexed), [true, false]);
    assert.ok(events.slice(events.indexOf(stores[1])).every(event => !event.multiplexed), 'all remaining operations use independent connections');
    assert.equal(events.filter(event => event.op === 'run').length, 1);
    const attempt = result.summary.shards[0].attempts[0];
    assert.equal(attempt.sshMuxFallback, true); assert.equal(attempt.sshMuxFallbackCount, 1);
    assert.equal(attempt.phaseTimings.sshMuxFallback, true); assert.equal(attempt.phaseTimings.sshMuxFallbackCount, 1);
    assert.match(result.stderr, /SSH mux transport failed during store; retrying once independently/);
  }
  assert.equal(muxFailure({ code: 255, stderr: 'Connection closed by remote host' }), false);
  assert.equal(muxRetrySafe('run', false), false); assert.equal(muxRetrySafe('run', true), false);
  assert.equal(muxRetrySafe('patch', true), false);
  const exhausted = fixture({ muxMessage: bc168, muxOperation: 'store', muxFailures: 2 });
  const failure = await run(exhausted, ['--rerun-on-fail']); assert.notEqual(failure.code, 0); returned(exhausted);
  assert.equal(failure.summary.shards[0].attempts[0].infraFailure, true);
  assert.equal(exhausted.events().filter(event => event.op === 'store').length, 2, 'only one fallback');
  assert.equal(exhausted.events().filter(event => event.op === 'run').length, 0);
  const started = fixture({ postStartFailure: true, postStartMessage: bc168, remoteExit: 0 });
  const recovered = await run(started); ok(recovered); returned(started);
  assert.equal(started.events().filter(event => event.op === 'run').length, 1, 'finished command recovered from receipt without replay');
  assert.equal(recovered.summary.shards[0].attempts[0].sshDropRecovered, true);
  assert.ok(started.events().some(event => event.op === 'result'));
  console.log('PASS BC-168 verbatim mux diagnostics, one independent fallback, degraded-run receipts and no command replay');
}

async function readbackAdmissionScenarios() {
  const f = fixture();
  const saved = await run(f, ['--artifact', 'build/result.txt', '--artifact-fetch', 'manifest'], 'mkdir -p build && printf retained > build/result.txt');
  ok(saved); returned(f);
  const manifestFile = saved.summary.shards[0].attempts[0].artifactManifest;
  const foreignLock = path.join(f.shared, 'locks', 'devbox-cn-light.d'), foreignInfo = 'by\tfixture-foreign\npid\t1\n';
  fs.mkdirSync(foreignLock); fs.writeFileSync(path.join(foreignLock, 'info'), foreignInfo);
  fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ ...f.config, readbackBarrier: true }));
  const children = [];
  const start = name => {
    const out = path.join(f.dir, name + '.txt');
    const child = spawn(process.execPath, [script, 'fetch-artifact', '--manifest', manifestFile, '--name', 'build/result.txt', '--out', out], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const record = { child, out, stdout: '', stderr: '', done: false };
    child.stdout.on('data', bytes => { record.stdout += bytes; }); child.stderr.on('data', bytes => { record.stderr += bytes; });
    record.closed = new Promise(resolve => child.once('close', code => { record.done = true; resolve(code); }));
    children.push(record); return record;
  };
  const wait = async predicate => {
    const deadline = Date.now() + 60000;
    while (!predicate()) { assert.ok(Date.now() < deadline, children.map(child => child.stdout + child.stderr).join('\n')); await sleep(25); }
  };
  const starts = () => f.events().filter(event => event.op === 'readback-start');
  const release = pid => fs.writeFileSync(path.join(f.dir, 'release-readback-' + pid), '');
  const readbackDir = path.join(f.shared, 'devbox-readbacks', '192.0.2.1');
  fs.mkdirSync(readbackDir, { recursive: true });
  fs.writeFileSync(path.join(readbackDir, 'dead.json'), JSON.stringify({ id: 'dead', pid: 2147483647, hostname: os.hostname() }));
  try {
    const first = start('first'); await wait(() => starts().length === 1 || first.done);
    assert.equal(starts().length, 1, first.stdout + first.stderr);
    assert.equal(fs.existsSync(path.join(readbackDir, 'dead.json')), false, 'dead local readback holder is reclaimed');
    const second = start('second'); await wait(() => starts().length === 2 || second.done);
    assert.equal(starts().length, 2, second.stdout + second.stderr);
    const permits = () => fs.readdirSync(readbackDir).filter(name => name.endsWith('.json'));
    assert.equal(permits().length, 2);
    const third = start('third'); await wait(() => third.stderr.includes('readback waiting') || third.done);
    assert.match(third.stderr, /readback waiting.*limit=2/);
    assert.equal(starts().length, 2, 'third readback waits while both fallback permits are held');
    assert.equal(permits().length, 2);
    const waiting = start('cancelled-waiter'); await wait(() => waiting.stderr.includes('readback waiting') || waiting.done);
    assert.match(waiting.stderr, /readback waiting/); waiting.child.kill('SIGTERM');
    assert.notEqual(await waiting.closed, 0); assert.equal(fs.existsSync(waiting.out), false); assert.equal(permits().length, 2);
    release(starts()[0].pid); assert.equal(await first.closed, 0, first.stdout + first.stderr);
    await wait(() => starts().length === 3 || third.done);
    assert.equal(starts().length, 3, third.stdout + third.stderr);
    for (const event of starts()) release(event.pid);
    for (const child of [second, third]) assert.equal(await child.closed, 0, child.stdout + child.stderr);
    for (const child of [first, second, third]) {
      assert.equal(fs.readFileSync(child.out, 'utf8'), 'retained');
      const receipt = JSON.parse(child.stdout.trim().split('\n').at(-1));
      assert.deepEqual(JSON.parse(fs.readFileSync(receipt.receiptFile)), receipt);
      assert.equal(receipt.readbackAdmission, 'bounded-no-slot'); assert.equal(receipt.readbackLimit, 2);
      assert.equal(receipt.exit, 0); assert.equal(receipt.host, '192.0.2.1');
    }
    assert.deepEqual(permits(), []);
    assert.equal(f.events().filter(event => event.op === 'take' && event.slot.includes('light')).length, 0, 'readbacks never take another host slot');
    assert.equal(fs.readFileSync(path.join(foreignLock, 'info'), 'utf8'), foreignInfo);
    const before = starts().length;
    fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ ...f.config, readbackDiskGiB: 52 }));
    const denied = start('disk-denied');
    assert.notEqual(await denied.closed, 0); assert.match(denied.stderr, /disk floor/);
    assert.equal(starts().length, before); assert.equal(fs.existsSync(denied.out), false); assert.deepEqual(permits(), []);
    fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify(f.config));
    const reservations = path.join(f.shared, 'devbox-reservations', '192.0.2.1.json');
    fs.mkdirSync(path.dirname(reservations), { recursive: true });
    fs.writeFileSync(reservations, JSON.stringify([[Date.now() / 1000, 1, 1, 48]]));
    const reserved = start('reserved-disk'); assert.notEqual(await reserved.closed, 0);
    assert.match(reserved.stderr, /disk floor/); assert.equal(fs.existsSync(reserved.out), false); assert.deepEqual(permits(), []);
    fs.unlinkSync(reservations);
    fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ ...f.config, readbackBarrier: true }));
    const cancellable = start('cancellable'); await wait(() => starts().length === before + 1 || cancellable.done);
    assert.equal(starts().length, before + 1); cancellable.child.kill('SIGTERM');
    assert.notEqual(await cancellable.closed, 0); assert.equal(fs.existsSync(cancellable.out), false); assert.deepEqual(permits(), []);
  } finally {
    for (const event of starts()) release(event.pid);
    for (const record of children) if (!record.done) record.child.kill('SIGTERM');
    await Promise.all(children.map(record => record.closed)); fs.rmSync(foreignLock, { recursive: true });
  }
  returned(f);
  fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify(f.config));
  // Exercise the repository's actual controller; take must not receive the
  // placement-file flag that is supported only by wait-pool.
  f.env.RES_COMMAND = fileURLToPath(new URL('../res/res', import.meta.url));
  const actualOut = path.join(f.dir, 'actual-controller.txt');
  const actual = spawnSync(process.execPath, [script, 'fetch-artifact', '--manifest', manifestFile, '--name', 'build/result.txt', '--out', actualOut], { env: f.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(actual.status, 0, actual.stdout + actual.stderr);
  assert.equal(JSON.parse(actual.stdout.trim().split('\n').at(-1)).readbackAdmission, 'light-slot');
  assert.deepEqual(fs.readdirSync(path.join(f.shared, 'locks')), []);
  console.log('PASS busy host light slot uses two bounded readbacks; third waits; disk floor and cancellation release permits');
}

async function treePlacementScenarios() {
  const f = fixture({ canonical: true, preferSlot: true, diskCosts: true, treeFree: { primary: 80, secondary: 160 } });
  fs.appendFileSync(path.join(f.shared, 'resources.tsv'), 'devbox-cn-5\tremote\topen\t-\tfirst alice@192.0.2.1 caps=node\n');
  const secondary = path.join(f.dir, 'secondary');
  fs.writeFileSync(path.join(f.shared, 'machine.conf'), `DEVBOX_TREE_PLACEMENT.192.0.2.1=1\nDEVBOX_EXTRA_ROOTS.192.0.2.1=${secondary}\n`);
  const first = await run(f, ['--prefer-host', '192.0.2.1']); ok(first); returned(f);
  const cold = first.summary.shards[0].attempts[0];
  assert.equal(cold.treeRoot, secondary); assert.equal(cold.treeState, 'cold-new');
  assert.equal(cold.placementScores.length, 2);
  assert.equal(cold.phaseTimings.treeRoot, secondary);
  assert.ok(cold.phaseTimings.substeps.sourceTransferIn.treePlacement >= 0);
  fs.mkdirSync(path.join(cold.workspace, 'build'), { recursive: true });
  fs.writeFileSync(path.join(cold.workspace, 'build', 'warm-cache'), 'keep');
  f.config.treeFree = { primary: 400, secondary: 60 }; fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify(f.config));
  const reused = await run(f, ['--prefer-host', '192.0.2.1']); ok(reused); returned(f);
  const warm = reused.summary.shards[0].attempts[0];
  assert.equal(warm.treeRoot, secondary); assert.equal(warm.treeState, 'warm'); assert.deepEqual(warm.placementScores, []);
  assert.equal(warm.diskCosts[cold.slot], 0); assert.equal(warm.treeAffinity.slot, cold.slot);
  assert.equal(fs.readFileSync(path.join(warm.workspace, 'build/warm-cache'), 'utf8'), 'keep');
  const explicit = await run(f, ['--prefer-slot', 'devbox-cn-5', '--prefer-host', '192.0.2.1']); ok(explicit); returned(f);
  assert.equal(explicit.summary.shards[0].slot, 'devbox-cn-5');
  const newest = await run(f, ['--prefer-host', '192.0.2.1']); ok(newest); returned(f);
  assert.equal(newest.summary.shards[0].slot, 'devbox-cn-5');
  const wait = f.events().filter(event => event.op === 'acquire-call').at(-1);
  assert.ok(wait.args.includes('--prefer-slot')); assert.equal(wait.args[wait.args.indexOf('--prefer-slot') + 1], 'devbox-cn-5');
  assert.equal(wait.args[0], 'wait-pool');
  const occupied = path.join(f.shared, 'locks/devbox-cn-5.d'); fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'info'), 'by\tfixture-foreign\npid\t1\n');
  const fallback = await run(f, ['--prefer-host', '192.0.2.1']); ok(fallback);
  assert.equal(fallback.summary.shards[0].slot, 'devbox-cn-1');
  fs.rmSync(occupied, { recursive: true }); returned(f);
  const primary = JSON.parse(fs.readFileSync(path.join(f.shared, 'devbox-hosts.json')))['192.0.2.1'].root;
  const map = JSON.parse(fs.readFileSync(path.join(primary, 'wt-map.json')));
  assert.equal(Object.values(map.slots[cold.slot])[0].treeRoot, secondary);
  assert.ok(fs.existsSync(path.join(primary, 'repos/fixture')) && fs.existsSync(path.join(primary, 'shared')) && fs.existsSync(path.join(primary, 'runs')));
  assert.deepEqual(fs.readdirSync(secondary), ['wt']);
  console.log('PASS fake SSH placement, score receipts, existing-tree reuse, warm cache, newest warm slot hint and primary-only shared state');

  const legacy = fixture({ preferSlot: true, diskCosts: true, assertLegacyWire: true, legacyScripts: remoteScripts });
  ok(await run(legacy)); returned(legacy);
  fs.writeFileSync(path.join(legacy.shared, 'machine.conf'), 'DEVBOX_TREE_PLACEMENT.192.0.2.1=0\nDEVBOX_EXTRA_ROOTS.192.0.2.1=/unused/root\n');
  ok(await run(legacy)); returned(legacy);
  assert.ok(!legacy.events().some(event => ['tree-list', 'tree-place'].includes(event.op)));
  console.log('PASS absent/disabled config sends identical legacy Python SSH commands and no treeConfig payload');
}

async function submodulePinScenarios() {
  const f = fixture(), pins = makeSubmoduleFixture(path.join(f.dir, 'pin-refresh'));
  f.repo = pins.repo;
  git(pins.repo, 'config', '--file', '.gitmodules', 'submodule.engine.url', 'git@unreachable.invalid:fleet/engine.git');
  git(path.join(pins.repo, 'engine'), 'config', '--file', '.gitmodules', 'submodule.nested.url', '../leaf.git');
  git(path.join(pins.repo, 'engine'), 'commit', '-qam', 'canonical nested origin');
  git(pins.repo, 'commit', '-qam', 'canonical engine origin');
  const initialCommand = 'test "$(cat engine/version)" = local-engine && test "$(cat engine/nested/payload)" = leaf';
  const registry = path.join(f.shared, 'resources.tsv');
  fs.writeFileSync(registry, fs.readFileSync(registry, 'utf8').replaceAll('bob@192.0.2.2', 'alice@192.0.2.1'));
  const args = ['--submodules', '--shards', '2'];
  const initial = await run(f, args, initialCommand); ok(initial); returned(f);
  const roots = f.events().filter(event => event.op === 'checkout').map(event => event.workspace);
  assert.equal(new Set(roots).size, 2);
  const sources = [path.join(pins.repo, 'engine'), path.join(pins.repo, 'engine/nested')];
  const stores = new Map();
  for (const [index, root] of roots.entries()) {
    for (const relative of ['engine', 'engine/nested']) {
      const repo = path.join(root, relative);
      const alt = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'objects/info/alternates');
      const store = path.dirname(fs.readFileSync(alt, 'utf8').trim());
      stores.set(relative, store);
      // Keep the old pin usable while replaying both generations of legacy clones.
      git(repo, 'repack', '-a', '-d');
      if (!index) fs.unlinkSync(alt);
      else {
        const stale = path.join(f.dir, 'stale-' + relative.replaceAll('/', '-'));
        git(f.dir, 'clone', '--mirror', store, stale);
        fs.writeFileSync(alt, path.join(stale, 'objects') + '\n');
      }
    }
  }
  function advance(value) {
    fs.writeFileSync(path.join(sources[1], 'payload'), value);
    git(sources[1], 'commit', '-qam', value);
    fs.writeFileSync(path.join(sources[0], 'version'), value);
    git(sources[0], 'commit', '-qam', value);
    git(pins.repo, 'commit', '-qam', value);
    return `test "$(git rev-parse HEAD)" = ${git(pins.repo, 'rev-parse', 'HEAD')} && test "$(git -C engine rev-parse HEAD)" = ${git(sources[0], 'rev-parse', 'HEAD')} && test "$(git -C engine/nested rev-parse HEAD)" = ${git(sources[1], 'rev-parse', 'HEAD')} && test "$(cat engine/version)" = ${value} && test "$(cat engine/nested/payload)" = ${value}`;
  }
  const command = advance('cached-pin');
  for (const [index, relative] of ['engine', 'engine/nested'].entries()) {
    const pin = git(sources[index], 'rev-parse', 'HEAD');
    git(f.dir, '--git-dir=' + stores.get(relative), 'fetch', '--no-write-fetch-head', sources[index], pin + ':refs/devbox-run/' + pin);
    for (const root of roots) assert.throws(() => git(path.join(root, relative), 'cat-file', '-e', pin + '^{commit}'));
  }
  const cached = await run(f, args, command); ok(cached); returned(f);
  assert.ok(cached.summary.shards.every(shard => !(shard.attempts[0].submoduleBundleBytes || 0)), 'cached store pins need no bundle upload');
  for (const root of roots) for (const [index, relative] of ['engine', 'engine/nested'].entries()) {
    assert.equal(git(path.join(root, relative), 'rev-parse', 'HEAD'), git(sources[index], 'rev-parse', 'HEAD'));
  }
  const updates = f.events().filter(event => event.op === 'submodule').length;
  ok(await run(f, args, command)); returned(f);
  assert.equal(f.events().filter(event => event.op === 'submodule').length, updates, 'clean same-pin reuse stays upload/checkout-free');
  // The caller origin can change from SSH to a local mirror without splitting stores.
  git(sources[0], 'remote', 'set-url', 'origin', path.join(f.dir, 'local-mirror'));
  const mirrored = await run(f, args, command); ok(mirrored); returned(f);
  assert.ok(mirrored.summary.shards.every(shard => !(shard.attempts[0].submoduleBundleBytes || 0)));
  assert.equal(f.events().filter(event => event.op === 'submodule').length, updates);
  const moduleRoot = path.dirname([...stores.values()][0]);
  const primary = JSON.parse(fs.readFileSync(path.join(f.shared, 'devbox-hosts.json')))['192.0.2.1'].root;
  assert.equal(fs.realpathSync(moduleRoot), fs.realpathSync(path.join(primary, 'repos/submodules')), 'both real cases feed the primary-root store, not a slot-local cache');
  assert.equal(fs.readdirSync(moduleRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).length, 2);
  const canonical = await storeIdentity(sources[0], undefined, undefined, 'git@unreachable.invalid:fleet/engine.git');
  assert.equal(path.basename(stores.get('engine')), canonical);
  assert.equal(await storeIdentity(sources[0], undefined, undefined, 'ssh://git@UNREACHABLE.invalid/fleet/engine.git'), canonical);
  assert.equal(submoduleOrigin('../leaf.git', 'git@unreachable.invalid:fleet/engine.git', pins.repo), 'git@unreachable.invalid:fleet/leaf.git');
  assert.equal(submoduleOrigin('../leaf.git', 'ssh://git@unreachable.invalid/fleet/engine.git', pins.repo), 'ssh://git@unreachable.invalid/fleet/leaf.git');
  assert.equal(submoduleOrigin('../leaf.git', '/fixtures/engine.git', pins.repo), '/fixtures/leaf.git');
  assert.equal(submoduleOrigin('../leaf.git', undefined, '/fixtures/engine'), '/fixtures/leaf.git');
  assert.equal(path.basename(stores.get('engine/nested')), await storeIdentity(sources[1], undefined, undefined, 'git@unreachable.invalid:fleet/leaf.git'));
  const uploaded = await run(f, args, advance('uploaded-pin')); ok(uploaded); returned(f);
  assert.ok(uploaded.summary.shards.some(shard => shard.attempts[0].submoduleBundleBytes > 0), 'new pins still use the bundle path');
  const data = { workspace: roots[0], parent: '', relative: 'engine', name: 'engine', repository: stores.get('engine'), commit: 'f'.repeat(40) };
  const invoke = () => spawnSync('python3', ['-c', remoteScripts.submodule, Buffer.from(JSON.stringify(data)).toString('base64')], { env: f.env, encoding: 'utf8' });
  const before = git(path.join(roots[0], 'engine'), 'rev-parse', 'HEAD');
  const absent = invoke();
  assert.notEqual(absent.status, 0); assert.match(absent.stderr, /submodule store missing pin/);
  assert.equal(git(path.join(roots[0], 'engine'), 'rev-parse', 'HEAD'), before);
  advance('retry-pin');
  data.commit = git(sources[0], 'rev-parse', 'HEAD');
  git(f.dir, '--git-dir=' + data.repository, 'fetch', '--no-write-fetch-head', sources[0], data.commit + ':refs/devbox-run/' + data.commit);
  git(roots[0], 'fetch', '--no-recurse-submodules', '--no-write-fetch-head', pins.repo, 'HEAD');
  git(roots[0], 'reset', '--hard', git(pins.repo, 'rev-parse', 'HEAD'));
  const clone = path.join(roots[0], 'engine');
  const refLock = git(clone, 'rev-parse', '--path-format=absolute', '--git-path', 'refs/devbox-run/' + data.commit + '.lock');
  fs.mkdirSync(path.dirname(refLock), { recursive: true }); fs.writeFileSync(refLock, 'fixture contention');
  const failed = invoke();
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /submodule slot pin import failed/);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before);
  fs.unlinkSync(refLock);
  assert.equal(invoke().status, 0, 'retry after ref contention imports/checks out the pin');
  assert.equal(invoke().status, 0, 'repeated import is idempotent');
  f.config.moduleVerifyMissing = 'once';
  fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify(f.config));
  const recovered = await run(f, ['--submodules'], advance('refeed-pin')); ok(recovered); returned(f);
  assert.equal(recovered.summary.shards[0].attempts[0].submoduleFullRefeeds, 1);
  const blocked = fixture({ moduleVerifyMissing: 'always' });
  const blockedPins = makeSubmoduleFixture(path.join(blocked.dir, 'modules')); blocked.repo = blockedPins.repo;
  const missing = await run(blocked, ['--submodules'], blockedPins.command);
  assert.notEqual(missing.code, 0); returned(blocked);
  assert.match(missing.stdout + missing.stderr, /submodule store missing pin after full refeed/);
  assert.equal(missing.summary.shards[0].attempts[0].submoduleFullRefeeds, 1);
  assert.equal(blocked.events().filter(event => event.op === 'bundle').length, 3, 'parent, module, then one full module refeed');
  assert.ok(!blocked.events().some(event => ['submodule', 'run'].includes(event.op)), 'unverified store never reaches checkout or command');
  console.log('PASS cached and newly bundled nested pins refresh two legacy slot clones offline; canonical declarations survive mirror origins and relative nested URLs');
  console.log('PASS missing store and failed slot import diagnostics preserve HEAD; retry and duplicate succeed');
  console.log('PASS post-feed missing pin replays one full bundle; persistent failure never starts checkout or command');
}

async function dynamicScenarios() {
  const f = fixture({ dynamic: true });
  const r = await run(f, ['--cores', '2', '--mem-gib', '4']); ok(r); returned(f);
  assert.match(r.summary.shards[0].slot, /^devbox-cn-first-[1-9]\d*$/);
  assert.equal(r.summary.shards[0].attempts[0].cpus, 2);
  assert.equal(readRegistry(f.shared, 'devbox-cn-light').some(row => row.slot === r.summary.shards[0].slot), true);
  const auto = fixture({ dynamic:true });
  ok(await run(auto,['--shards','auto'])); returned(auto);
  const prewarm = fixture({ dynamic:true });
  ok(await run(prewarm, ['prewarm','--host','192.0.2.1'])); returned(prewarm);
  const gc = fixture({ dynamic:true }); const initial=await run(gc); ok(initial); returned(gc);
  const ws=workspace(gc,'192.0.2.1',initial.summary.shards[0].slot), meta=path.join(ws,'.devbox-run.json');
  const record=JSON.parse(fs.readFileSync(meta)); record.lastUsed-=8*86400;fs.writeFileSync(meta,JSON.stringify(record));
  ok(await run(gc,['gc','--host','192.0.2.1'])); assert.ok(!fs.existsSync(ws)); returned(gc);
  const pending=fixture({dynamic:true,badCleanup:true}); const interrupted=await run(pending);assert.equal(interrupted.code,70);
  const lease=interrupted.summary.shards[0].slot;
  assert.match(lease,/^devbox-cn-first-/);assert.ok(fs.existsSync(path.join(pending.shared,'locks',lease+'.d')));
  assert.equal(readRegistry(pending.shared,'devbox-cn').some(row=>row.slot===lease),true);
  const source=fs.readFileSync(path.join(pending.shared,'locks',lease+'.d','info'),'utf8');assert.match(source,/remote_cleanup_required/);
  const backup=path.join(pending.shared,'resources.tsv.pre-dynamic');
  fs.writeFileSync(backup,'devbox-cn-1\tremote\topen\t-\talice@192.0.2.1 caps=node\n');
  execFileSync(process.execPath,[fileURLToPath(new URL('../devbox-host-migrate.mjs',import.meta.url)),'--registry',path.join(pending.shared,'resources.tsv'),'--rollback'],{encoding:'utf8'});
  assert.equal(readRegistry(pending.shared,'devbox-cn').find(row=>row.slot===lease)?.resolverOnly,true);
  const reject=spawnSync(pending.config.realRes,['take',lease,'--by','rollback-test','--project','fixture','--for','test','--pid',String(process.pid)],{env:pending.env,encoding:'utf8'});
  assert.equal(reject.status,3);
  console.log('PASS dynamic runner: actual allocator, opaque IDs, reservation CPU budget, prewarm, GC and retained cleanup');
}

async function reviewRegressions() {
  for(const mode of ['success','retirement-failure','acquisition-failure']) {
    const retirementFailure=mode==='retirement-failure', retirementAcquireFailure=mode==='acquisition-failure';
    const f=fixture({dynamic:true});
    const saved=await run(f,['--artifact','build/result.txt','--artifact-fetch','manifest'],'mkdir -p build && printf retained > build/result.txt');ok(saved);returned(f);
    const receipt=JSON.parse(fs.readFileSync(saved.summary.shards[0].attempts[0].artifactManifest));
    fs.writeFileSync(path.join(f.dir,'config.json'),JSON.stringify({...f.config,retirementRace:true,retirementFailure,retirementAcquireFailure}));
    const retired=spawnSync(process.execPath,[script,'retire-artifacts','--receipt',receipt.run,'--host',receipt.host],{env:f.env,encoding:'utf8',timeout:30000});
    assert.equal(retired.status,mode==='success'?0:1,retired.stdout+retired.stderr);
    if(retirementFailure)assert.match(retired.stderr,/fixture retirement failure/);
    const returnedLease=f.events().filter(e=>e.op==='return'&&e.by?.startsWith('artifact-retire-')).at(-1);
    assert.equal(returnedLease?.slot,'devbox-cn-first-2','new ordinal returned on success and failure');
    assert.ok(fs.existsSync(path.join(f.shared,'locks','devbox-cn-first-1.d')),'rival hold preserved');
    assert.ok(!fs.existsSync(path.join(f.shared,'locks','devbox-cn-first-2.d')),'retirement hold released');
    const release=spawnSync(f.config.realRes,['return','devbox-cn-first-1','--by','fixture-retirement-rival'],{env:f.env,encoding:'utf8'});
    assert.equal(release.status,0,release.stderr);returned(f);
  }
  const f=fixture({dynamic:true});
  const saved=await run(f,['--artifact','build/result.txt','--artifact-fetch','manifest'],'mkdir -p build && printf retained > build/result.txt');ok(saved);returned(f);
  const manifest=saved.summary.shards[0].attempts[0].artifactManifest, lease='devbox-cn-first-22';
  const owner={slot:lease,by:'fixture-readback-holder',pid:String(process.pid),host:os.hostname(),start:String(Math.floor(Date.now()/1000)-1000)};
  const dir=path.join(f.shared,'locks',lease+'.d');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'info'),Object.entries({...owner,claim_kind:'HEAVY',claim_cores:'1',claim_mem:'1',claim_disk:'20'}).map(([k,v])=>k+'\t'+v+'\n').join(''));
  fs.mkdirSync(path.join(f.shared,'devbox-reservations'),{recursive:true});
  fs.writeFileSync(path.join(f.shared,'devbox-reservations','192.0.2.1.json'),JSON.stringify([[Date.now()/1000-1000,1,1,20,owner]]));
  fs.writeFileSync(path.join(f.shared,'machine.conf'),'DEVBOX_MAX_CLAIMS=1\n');
  fs.writeFileSync(path.join(f.dir,'config.json'),JSON.stringify({...f.config,readbackDiskGiB:60}));
  const out=path.join(f.dir,'readback.txt');
  const refused=spawnSync(process.execPath,[script,'fetch-artifact','--manifest',manifest,'--name','build/result.txt','--out',out],{env:f.env,encoding:'utf8',timeout:30000});
  assert.equal(refused.status,1,refused.stdout+refused.stderr);assert.match(refused.stderr,/disk floor/);
  assert.ok(!fs.existsSync(out),'persistent reservations prevent artifact publication below disk floor');
  assert.ok(fs.existsSync(dir),'active foreign dynamic holder preserved');fs.rmSync(dir,{recursive:true});
  console.log('PASS review regressions: newly allocated retirement IDs returned on success/failure; old active dynamic reservations enforce readback disk floor');
}

async function scenarios() {
  const only = process.env.DEVBOX_TEST_CASE;
  if (!only || only === 'dynamic-review') { await reviewRegressions(); if (only) return; }
  if (!only || only === 'dynamic') { await dynamicScenarios(); if (only) return; }
  if (!only || only === 'tmpdir') {
    const f = fixture();
    const command = 'node -e '+JSON.stringify("const fs=require('fs'); const p=process.env.TMPDIR; if(!/^\\/tmp\\/dr-[a-z0-9_]{8}$/.test(p))process.exit(5); if((fs.statSync(p).mode&511)!==448)process.exit(6); fs.mkdirSync(p+'/nested'); fs.writeFileSync(p+'/nested/output','temp'); fs.symlinkSync(process.cwd(),p+'/workspace-link');");
    ok(await run(f, ['--env','TMPDIR=/a/very/long/ambient/tmpdir'], command)); returned(f);
    const controls=f.events().filter(event=>event.op==='run').map(event=>event.control);
    for (const control of controls) {
      const record=JSON.parse(fs.readFileSync(path.join(control,'tmpdir.json')));
      assert.equal(record.run,path.basename(control));
      assert.ok(!fs.existsSync(record.path),'owned TMPDIR removed after command');
    }
    assert.ok(fs.existsSync(workspace(f)),'workspace symlink target preserved');
    console.log('PASS short 0700 TMPDIR overrides ambient/explicit values and guarded cleanup preserves symlink targets');
    if (only === 'tmpdir') return;
  }
  if (only === 'submodule-pin') { await submodulePinScenarios(); return; }
  if (!only) await submodulePinScenarios();
  if (only === 'trees') { await treePlacementScenarios(); return; }
  if (only === 'readback') { await artifactDirectScenarios(); await artifactResumeScenarios(); return; }
  if (only === 'artifact-direct') { await artifactDirectScenarios(); return; }
  if (only === 'overhead') { await overheadScenarios(); return; }
  if (only === 'budget') { await budgetScenarios(); return; }
  if (only === 'stop-shards') { await stopShardScenarios(); return; }
  if (only === 'cleanup-pending') { await cleanupPendingScenarios(); return; }
  if (!only) { await budgetScenarios(); await stopShardScenarios(); await cleanupPendingScenarios(); }
  if (!only) await overheadScenarios();
  const perf = { 'run-data': dataCleanupScenarios, mux: muxScenarios, 'readback-admission': readbackAdmissionScenarios, affinity:affinityScopeScenarios, 'dead-slot':deadSlotScenarios, inputs:inputScenarios,hygiene:hygieneScenarios,credentials: credentialScenarios, 'packed-module': packedModuleRecovery, receipt: receiptScenarios, 'res-progress': resProgressScenarios, cpu: cpuScenarios, auto: autoScenarios, units: unitScenarios, prewarm: prewarmScenarios, metrics: metricScenarios, placement: placementScenarios, 'ssh-drop': sshDropScenarios };
  const baseline = ['baseline-core', 'baseline-config', 'baseline-warm', 'baseline-placement', 'baseline-artifacts', 'baseline-cleanup', 'baseline-gc', 'baseline-ssh'];
  if (only && !['baseline', 'bundle', 'ownership', ...baseline, ...Object.keys(perf)].includes(only)) throw Error('unknown devbox fixture case');
  for (const [name, scenario] of Object.entries(perf)) if (!only || only === name) await scenario();
  if (!only || only === 'baseline' || only === 'bundle') await bundleRecovery();
  if (!only || only === 'baseline' || only === 'ownership') await stopOwnership();
  if (only && only !== 'baseline' && !baseline.includes(only)) return;
  const group = name => !only || only === 'baseline' || only === name;
  if (group('baseline-core')) {
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

  }
  if (group('baseline-config')) {
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

  }
  if (group('baseline-warm')) {
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

  }
  if (group('baseline-placement')) {
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
  const launcher=fixture({launcherDiskHost:'192.0.2.1'});
  const launchRetry=await run(launcher,['--rerun-on-fail']); ok(launchRetry); returned(launcher);
  assert.equal(launchRetry.summary.shards[0].attempts[0].diskGuard,true);
  assert.equal(launchRetry.summary.shards[0].host,'192.0.2.2'); assert.equal(launchRetry.summary.shards[0].flaky,false);
  const command72=fixture(); const commandExit=await run(command72,[],'exit 72');
  assert.equal(commandExit.code,72); assert.equal(commandExit.summary.shards[0].attempts[0].diskGuard,undefined); returned(command72);
  console.log('PASS capability and slot preference passthrough/legacy filtering, fresh upload retry, disk guard alternate-slot retry');

  }
  if (group('baseline-artifacts')) {
  for (const allow of [false, true]) {
    const f = fixture({ failHost: '192.0.2.1' }); const r = await run(f, ['--rerun-on-fail', ...(allow ? ['--allow-flaky'] : [])]);
    assert.equal(r.code, allow ? 0 : 7); assert.equal(r.summary.shards[0].flaky, true);
    const history = JSON.parse(fs.readFileSync(path.join(f.shared, 'flaky-log.jsonl')));
    assert.deepEqual(history.hosts, ['192.0.2.1', '192.0.2.2']); assert.equal(history.commandHash.length, 64); returned(f);
  }
  const artifact = fixture(); const a = await run(artifact, ['--artifact', 'build/*.txt'], 'mkdir -p build && echo evidence > build/result.txt'); ok(a);
  assert.equal(execFileSync('tar', ['-xOf', a.summary.shards[0].attempts[0].artifact, 'build/result.txt'], { encoding: 'utf8' }).trim(), 'evidence');
  const measured = a.summary.shards[0].attempts[0].phaseTimings;
  assert.equal(Object.values(measured.seconds).reduce((sum, seconds) => sum + seconds, 0), measured.totalSec);
  assert.ok(Object.values(measured.seconds).every(seconds => Number.isFinite(seconds) && seconds >= 0));
  assert.ok(measured.seconds.sourceTransferIn > 0 && measured.seconds.remoteCommand > 0 && measured.seconds.cleanup > 0);
  assert.ok(measured.seconds.artifactCollection > 0, 'remote artifact collection receipt');
  assert.ok(measured.bytesIn > 0 && measured.bytesOut >= fs.statSync(a.summary.shards[0].attempts[0].artifact).size);
  assert.match(a.stdout, /attempt phases .*artifactCollection=.*bytesIn=\d+ bytesOut=\d+/);
  const large = fixture();
  const ranged = await run(large, ['--artifact', 'build/large.bin', '--artifact-streams', '4'], 'mkdir -p build && dd if=/dev/zero of=build/large.bin bs=1048576 count=64 2>/dev/null'); ok(ranged); returned(large);
  const largeAttempt = ranged.summary.shards[0].attempts[0];
  assert.equal(largeAttempt.artifactTransport.streams, 4);
  assert.ok(fs.statSync(largeAttempt.artifact).size >= 64 * 1048576);
  assert.equal(large.events().filter(event => event.op === 'artifact-range').length, 4);
  assert.equal(large.events().filter(event => event.op === 'artifact-release').length, 1);
  const retained = fixture({diskCosts:true});
  const saved = await run(retained, ['--artifact', 'build/result.txt', '--artifact-fetch', 'manifest'], 'mkdir -p build && printf retained > build/result.txt'); ok(saved); returned(retained);
  const savedAttempt = saved.summary.shards[0].attempts[0];
  assert.equal(savedAttempt.artifact, undefined);
  const manifest = JSON.parse(fs.readFileSync(savedAttempt.artifactManifest));
  assert.equal(manifest.artifacts[0].name, 'build/result.txt');
  assert.equal(manifest.artifacts[0].size, 8);
  const reuseRetained=await run(retained, [], 'printf reused > build/result.txt'); ok(reuseRetained); returned(retained);
  assert.equal(reuseRetained.summary.shards[0].attempts[0].diskCosts[manifest.slot],8/1024**3,'retained bytes remain in the warm slot disk reservation');
  const foreignLock = path.join(retained.shared, 'locks', manifest.slot + '.d');
  fs.mkdirSync(foreignLock);
  const foreignInfo = 'by\tfixture-foreign\npid\t1\n';
  fs.writeFileSync(path.join(foreignLock, 'info'), foreignInfo);
  // Put the other host first to ensure input placement, not pool order, binds the fetch.
  const registryFile = path.join(retained.shared, 'resources.tsv');
  const registryLines = fs.readFileSync(registryFile, 'utf8').trim().split('\n');
  registryLines.sort((x, y) => Number(y.startsWith('devbox-cn-light-2\t')) - Number(x.startsWith('devbox-cn-light-2\t')));
  fs.writeFileSync(registryFile, registryLines.join('\n') + '\n');
  const pulled = path.join(retained.dir, 'pulled.txt');
  const fetched = spawnSync(process.execPath, [script, 'fetch-artifact', '--manifest', savedAttempt.artifactManifest, '--name', 'build/result.txt', '--out', pulled], { env: retained.env, encoding: 'utf8' });
  assert.equal(fetched.status, 0, fetched.stdout + fetched.stderr);
  assert.equal(fs.readFileSync(pulled, 'utf8'), 'retained');
  assert.equal(fs.readFileSync(path.join(foreignLock, 'info'), 'utf8'), foreignInfo);
  const fetchLease = retained.events().filter(event => event.op === 'acquire-call').at(-1);
  assert.equal(fetchLease.args[0], 'take'); assert.equal(fetchLease.args[1], 'devbox-cn-light');
  const readbackReceipt = JSON.parse(fetched.stdout.trim().split('\n').at(-1));
  assert.equal(readbackReceipt.readbackAdmission, 'light-slot');
  assert.deepEqual(JSON.parse(fs.readFileSync(readbackReceipt.receiptFile)), readbackReceipt);
  assert.ok(!fetchLease.args.includes('--placement-file'), 'exact slot take uses controller-supported flags');
  assert.ok(!fetchLease.args.some(arg => arg.startsWith('--exclude')));
  assert.equal(retained.events().filter(event => event.op === 'take').at(-1).slot, 'devbox-cn-light');
  assert.equal(retained.events().filter(event => event.op === 'fetch-artifact').at(-1).target, 'alice@192.0.2.1');
  const refused = spawnSync(process.execPath, [script, 'fetch-artifact', '--manifest', savedAttempt.artifactManifest, '--name', 'build/result.txt', '--out', pulled], { env: retained.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.equal(fs.readFileSync(pulled, 'utf8'), 'retained');
  fs.writeFileSync(path.join(retained.dir, 'config.json'), JSON.stringify({ ...retained.config, cancelAcquire: true }));
  const cancelledOut = path.join(retained.dir, 'cancelled.txt');
  const cancelledFetch = spawnSync(process.execPath, [script, 'fetch-artifact', '--manifest', savedAttempt.artifactManifest, '--name', 'build/result.txt', '--out', cancelledOut], { env: retained.env, encoding: 'utf8' });
  assert.notEqual(cancelledFetch.status, 0);
  assert.equal(fs.existsSync(cancelledOut), false);
  assert.equal(fs.readFileSync(path.join(foreignLock, 'info'), 'utf8'), foreignInfo);
  assert.deepEqual(fs.readdirSync(path.join(retained.shared, 'locks')), [manifest.slot + '.d']);
  fs.rmSync(foreignLock, { recursive: true }); returned(retained);
  fs.writeFileSync(path.join(retained.dir,'config.json'),JSON.stringify({...retained.config,badFetch:true,returnFailure:true}));
  const tempBefore=fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith('devbox-artifact-fetch-')).sort();
  const failedFetch=spawnSync(process.execPath,[script,'fetch-artifact','--manifest',savedAttempt.artifactManifest,'--name','build/result.txt','--out',path.join(retained.dir,'failed.txt')],{env:retained.env,encoding:'utf8'});
  assert.notEqual(failedFetch.status,0); assert.match(failedFetch.stderr,/fixture primary readback failure/);
  assert.match(failedFetch.stderr,/artifact cleanup:.*lease return failure/);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith('devbox-artifact-fetch-')).sort(),tempBefore);
  fs.writeFileSync(path.join(retained.dir,'config.json'),JSON.stringify(retained.config));
  for(const lock of fs.readdirSync(path.join(retained.shared,'locks'))){
    const info=fs.readFileSync(path.join(retained.shared,'locks',lock,'info'),'utf8');
    const by=/^by\t([^\n]+)/m.exec(info)[1];
    const returnedLease=spawnSync('res',['return',lock.slice(0,-2),'--by',by],{env:retained.env,encoding:'utf8'});
    assert.equal(returnedLease.status,0,returnedLease.stdout+returnedLease.stderr);
  }
  const retired=spawnSync(process.execPath,[script,'retire-artifacts','--receipt',manifest.run,'--host',manifest.host],{env:retained.env,encoding:'utf8'});
  assert.equal(retired.status,0,retired.stdout+retired.stderr); assert.match(retired.stdout,/"remainingBytes": 0/); returned(retained);
  const failedCommand=fixture();
  const noRetention=await run(failedCommand,['--artifact','build/result.txt','--artifact-fetch','manifest'],'mkdir -p build && printf failed > build/result.txt; exit 7');
  assert.equal(noRetention.code,7); assert.equal(failedCommand.events().filter(event=>event.op==='artifacts').length,1);
  const failedAttempt=noRetention.summary.shards[0].attempts[0];
  assert.equal(failedAttempt.artifactFetchFallback,'all');
  assert.equal(failedAttempt.artifactManifest,undefined); assert.equal(failedAttempt.artifactsRetained,undefined);
  assert.ok(failedAttempt.artifact,'failed manifest-mode attempts fall back to normal readback instead of losing artifacts');
  assert.equal(execFileSync('tar',['-xOf',failedAttempt.artifact,'build/result.txt'],{encoding:'utf8'}),'failed');
  const failedRoot=JSON.parse(fs.readFileSync(path.join(failedCommand.shared,'devbox-hosts.json')))['192.0.2.1'].root;
  assert.ok(fs.readdirSync(path.join(failedRoot,'runs')).every(run=>!fs.existsSync(path.join(failedRoot,'runs',run,'artifacts'))),'failed manifest mode leaves no retained payload directory');
  returned(failedCommand);
  const withRetention=await run(failedCommand,['--artifact','build/result.txt','--artifact-fetch','manifest','--retain-on-fail'],'mkdir -p build && printf failed > build/result.txt; exit 7');
  assert.equal(withRetention.code,7); assert.ok(withRetention.summary.shards[0].attempts[0].artifactManifest);
  const failedManifest=JSON.parse(fs.readFileSync(withRetention.summary.shards[0].attempts[0].artifactManifest));
  assert.equal(fs.readFileSync(path.join(failedManifest.control,'artifacts/build/result.txt'),'utf8'),'failed','explicit manifest-mode failure retention preserves the copied payload');
  returned(failedCommand);

  await artifactDirectScenarios();
  await artifactResumeScenarios();

  let failedArtifact = fixture({ badArtifact: true }); assert.equal((await run(failedArtifact, ['--artifact', '*.txt'])).code, 0); returned(failedArtifact);
  const left = await run(failedArtifact = fixture({ badArtifact: true }), ['--artifact', '*.txt', '--fetch-timeout', '30']);
  assert.equal(left.code, 0); assert.match(left.stdout + left.stderr, /artifacts not retained; files remain on devbox-cn-\d+/);
  assert.equal(left.summary.shards[0].attempts[0].artifactExit, 66);
  assert.deepEqual(left.summary.shards[0].attempts[0].artifactsLeft.patterns, ['*.txt']); returned(failedArtifact);
  await assert.rejects(run(fixture(), ['--fetch-timeout', '0']).then(r => { if (r.code) throw Error('rejected'); }), /rejected/);
  const failure = fixture(); assert.equal((await run(failure, [], 'exit 9')).code, 9); returned(failure);
  console.log('PASS flaky exit policy/history, artifact contents, artifact and command failure release');

  }
  if (group('baseline-cleanup')) {
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

  }
  if (group('baseline-gc')) {
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

  }
  if (group('baseline-ssh')) {
  for (const authMessage of ['Permission denied (gssapi-with-mic)', 'Connection closed by 192.0.2.1 port 22']) {
    const f = fixture({ authFailures: 1, authMessage }); const r = await run(f); ok(r);
    assert.equal(f.events().filter(e => e.op === 'probe').length, 2); returned(f);
  }
  const exhausted = fixture({ authFailures: 4 }); const exhaustedRun = await run(exhausted, ['--rerun-on-fail']);
  assert.equal(exhaustedRun.code, 255); assert.equal(exhaustedRun.summary.shards[0].attempts[0].infraFailure, true);
  assert.equal(exhausted.events().filter(e => e.op === 'probe').length, 4); returned(exhausted);
  await placementScenarios();
  console.log('PASS jittered SSH establishment retries, bounded infra failure, no replay after remote start, no ControlMaster');
  }
}

try { await scenarios(); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
