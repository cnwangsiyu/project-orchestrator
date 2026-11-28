#!/usr/bin/env node
// Exercise the GC CLI, acquired payload, generated supervisor and lease return.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { remoteScripts } from '../devbox-run.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-gc-supervisor-'));
const bin = path.join(temp, 'bin'), shared = path.join(temp, 'shared'), root = path.join(temp, 'devbox-run');
for (const dir of [bin, shared, root, path.join(shared, 'locks'), path.join(temp, 'home')]) fs.mkdirSync(dir, { recursive: true });
const registry = [['devbox-cn-1', '192.0.2.1'], ['devbox-cn-2', '192.0.2.1'], ['devbox-cn-light-1', '192.0.2.1'],
  ['devbox-cn-3', '192.0.2.2']].map(([slot, host]) => `${slot}\tremote\topen\t-\tfixture nobody@${host} caps=node`).join('\n');
fs.writeFileSync(path.join(shared, 'resources.tsv'), registry + '\n');

// Linux runs the supervisor unchanged. On macOS only Linux kernel interfaces
// are adapted: real child processes, receipt writes and all controller flow stay.
const adapter = String.raw`import ast,base64,json,os,pathlib,subprocess,sys,types
source=base64.b64decode(sys.argv[1]).decode()
if sys.platform!='linux':
    tree=ast.parse(source)
    replacements={
      'stat': '''def stat(pid):
    result=subprocess.run(['ps','-p',str(pid),'-o','stat=,ppid=,pgid=,lstart='],capture_output=True,text=True)
    values=result.stdout.split()
    if len(values)<4: return None
    fields=['0']*20; fields[0]=values[0][0]; fields[1]=values[1]; fields[2]=values[2]; fields[19]=' '.join(values[3:])
    return fields''',
      'adopted': '''def adopted():
    return []''',
      'exited': '''def exited():
    code=proc.poll()
    if code is None: return None
    return types.SimpleNamespace(si_code=1 if code>=0 else 2,si_status=code if code>=0 else -code)''',
    }
    for i,node in enumerate(tree.body):
        if isinstance(node,ast.FunctionDef) and node.name in replacements: tree.body[i]=ast.parse(replacements[node.name]).body[0]
        elif isinstance(node,ast.If) and 'libc.prctl' in ast.unparse(node.test): tree.body[i]=ast.Pass()
    source=ast.unparse(ast.fix_missing_locations(tree))
    os.CLD_EXITED=1
sys.argv=[sys.argv[0],sys.argv[2]]
exec(compile(source,'generated-gc-supervisor','exec'))
`;
fs.writeFileSync(path.join(temp, 'adapter.py'), adapter);
const common = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const temp=${JSON.stringify(temp)},shared=${JSON.stringify(shared)},root=${JSON.stringify(root)};
const event=(op,data={})=>fs.appendFileSync(path.join(temp,'events.jsonl'),JSON.stringify({op,...data})+'\\n');
const flag=(a,n)=>a[a.indexOf(n)+1];\n`;
fs.writeFileSync(path.join(bin, 'res'), `#!${process.execPath}\n` + common + String.raw`
const a=process.argv.slice(2), lock=path.join(shared,'locks',a[1]+'.d');
if(a[0]==='take') {
  if(!a.includes('--maintenance'))throw Error('missing maintenance acquisition');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock,'info'),'by\t'+flag(a,'--by')+'\npid\t'+flag(a,'--pid')+'\n');
  event('take',{slot:a[1]});
} else if(a[0]==='return') {
  if(!fs.readFileSync(path.join(lock,'info'),'utf8').includes('by\t'+flag(a,'--by')+'\n'))throw Error('foreign lease');
  event('return',{slot:a[1]}); fs.rmSync(lock,{recursive:true});
} else throw Error('unexpected res operation');
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}\n` + common + `const supervisor=${JSON.stringify(Buffer.from(remoteScripts.run).toString('base64'))};\n` + String.raw`
const a=process.argv.slice(2); if(a.includes('-O'))process.exit(0);
const wire=a.at(-1), op=wire.match(/^# devbox-run:([a-z-]+)/)?.[1];
const payload=wire.match(/'([A-Za-z0-9+/=]+)'$/)?.[1];
if(!payload)throw Error('missing payload');
const d=JSON.parse(Buffer.from(payload,'base64')); event(op,{slot:d.slot,control:d.control});
if(op==='probe')console.log(JSON.stringify({root,cores:8,fs:root,user:d.user,probedAt:new Date().toISOString()}));
else if(op==='inventory')console.log(JSON.stringify(a.includes('nobody@192.0.2.1')
  ? [{slot:'devbox-cn-1',workspace:root+'/wt/fixture/id-1234567890abcdef/devbox-cn-1'},{slot:'devbox-cn-2'}]
  : [{slot:'devbox-cn-3'}]));
else if(op==='inspect')fs.mkdirSync(d.control,{recursive:true});
else if(op==='run') {
  // Stub the tree command while exercising the real supervisor and slot lifecycle.
  const failed=d.slot==='devbox-cn-1';
  const receipt=failed ? {slot:d.slot,tree:'1234567890ab',failed:'tree check or removal failed'} : {reclaimedBytes:1073741824};
  d.command='sleep .1; printf '+"'"+JSON.stringify(receipt)+'\n'+"'"+(failed?'; exit 1':'');
  const r=cp.spawnSync('python3',[path.join(temp,'adapter.py'),supervisor,Buffer.from(JSON.stringify(d)).toString('base64')],{encoding:'utf8',timeout:15000});
  process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
} else if(op==='cleanup') {
  const group=JSON.parse(fs.readFileSync(path.join(d.control,'group.json'))), done=JSON.parse(fs.readFileSync(path.join(d.control,'done.json')));
  if(!done.gone||done.exit!==(group.slot==='devbox-cn-1'?1:0))throw Error('supervisor did not confirm shutdown');
  try {process.kill(group.pid,0);throw Error('command remains alive');}catch(e){if(e.code!=='ESRCH')throw e;}
  event('group-gone',{slot:group.slot});console.log('group-gone');
} else throw Error('unexpected SSH operation: '+op);
`, { mode: 0o755 });

try {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../devbox-run.mjs', import.meta.url)), 'gc'], {
    env: { ...process.env, HOME: path.join(temp, 'home'), PATH: `${bin}:${process.env.PATH}`, RULES_SHARED: shared, RES_DIR: shared, DEVBOX_CACHE_DIR: shared, RES_COMMAND: 'res' },
    encoding: 'utf8', timeout: 45000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const events = fs.readFileSync(path.join(temp, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const runs = events.filter(event => event.op === 'run');
  assert.deepEqual(runs.map(run => run.slot), ['devbox-cn-1', 'devbox-cn-2', 'devbox-cn-light-1', 'devbox-cn-3', 'devbox-cn-3']);
  for (const run of runs) {
    const group = JSON.parse(fs.readFileSync(path.join(run.control, 'group.json')));
    assert.equal(group.run, path.basename(run.control)); assert.equal(group.slot, run.slot); assert.equal(group.workspace, root);
    assert.ok(Number.isInteger(group.pid) && group.pid > 0); assert.ok(typeof group.start === 'string' && group.start.length);
    const current = events.indexOf(run);
    const gone = events.findIndex((event, index) => index > current && event.op === 'group-gone' && event.slot === run.slot);
    assert.ok(gone > current && events.findIndex((event, index) => index > current && event.op === 'return' && event.slot === run.slot) > gone);
  }
  assert.deepEqual(fs.readdirSync(path.join(shared, 'locks')), []);
  assert.equal(result.stdout.match(/"failed":"tree check or removal failed"/g)?.length, 1);
  assert.match(result.stdout, /reclaimedGiB=4\.000/);
  assert.match(result.stdout, /failedJobs=1/);
  console.log(`PASS GC records a failed tree and continues across slots and hosts, confirming shutdown before each return (${process.platform === 'linux' ? 'native Linux' : 'macOS kernel adapter'})`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
