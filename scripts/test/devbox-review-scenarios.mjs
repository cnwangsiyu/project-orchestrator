import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { execute, parseArgs, remoteScripts } from '../devbox-run.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(),'devbox-review-'));
const root = path.join(temp,'devbox-run'), workspace = path.join(root,'wt','fixture');
fs.mkdirSync(workspace,{recursive:true});
const control = path.join(root,'runs',randomUUID()); fs.mkdirSync(control,{recursive:true});
const data = {root,workspace,control,slot:'devbox-cn-1',host:'192.0.2.1',commit:'a'.repeat(40),fetch:'manifest',patterns:['build/file.bin']};
const invoke = (op,value,source=remoteScripts[op],env=process.env) => spawnSync('python3',['-c',source,Buffer.from(JSON.stringify(value)).toString('base64')],{env,encoding:'utf8',timeout:10000});
try {
  fs.mkdirSync(path.join(workspace,'build')); fs.writeFileSync(path.join(workspace,'build/file.bin'),'public payload');
  const collected=invoke('artifacts',{...data,patterns:['./build/file.bin','build/file.bin']});
  assert.equal(collected.status,0,collected.stderr);
  const receipt=JSON.parse(collected.stdout);
  assert.equal(receipt.artifacts.length,1); assert.equal(receipt.artifacts[0].name,'build/file.bin');
  assert.equal(receipt.retainHours,24); assert.equal(receipt.expiresAt-receipt.createdAt,86400);
  const other = path.join(root,'runs',randomUUID()); fs.mkdirSync(other);
  assert.notEqual(invoke('artifacts',{...data,control:other,patterns:['/tmp/*']}).status,0);
  assert.equal(fs.existsSync(path.join(other,'artifacts')),false);
  fs.mkdirSync(path.join(workspace,'cookie')); fs.writeFileSync(path.join(workspace,'cookie/public.bin'),'public');
  const privateName=invoke('artifacts',{...data,control:other,patterns:['cookie/public.bin']});
  assert.notEqual(privateName.status,0); assert.match(privateName.stderr,/private-state component/);
  assert.equal(fs.existsSync(path.join(other,'artifacts')),false);
  const midCopy=remoteScripts.artifacts.replace("records.append({'name':name", "raise OSError('fixture copy failure')\n        records.append({'name':name");
  assert.notEqual(invoke('artifacts',{...data,control:other},midCopy).status,0);
  assert.equal(fs.existsSync(path.join(other,'artifacts')),false,'mid-copy cleanup removes only its partial payload');
  fs.writeFileSync(path.join(control,'output.log'),'keep evidence');
  const expires=JSON.parse(fs.readFileSync(path.join(control,'artifact-retention.json'))); expires.expiresAt=Date.now()/1000-1;
  fs.writeFileSync(path.join(control,'artifact-retention.json'),JSON.stringify(expires));
  const partial=path.join(root,'runs',randomUUID()); fs.mkdirSync(path.join(partial,'artifacts'),{recursive:true});
  fs.writeFileSync(path.join(partial,'artifacts','partial.bin'),'partial');
  fs.writeFileSync(path.join(partial,'artifact-archive.tar'),'leftover archive');
  fs.writeFileSync(path.join(partial,'artifact-retention.json'),JSON.stringify({...expires,run:path.basename(partial)}));
  const expired=invoke('expire-artifacts',{root}); assert.equal(expired.status,0,expired.stderr);
  assert.equal(fs.existsSync(path.join(control,'artifacts')),false); assert.equal(fs.existsSync(path.join(partial,'artifact-archive.tar')),false);
  assert.equal(fs.readFileSync(path.join(control,'output.log'),'utf8'),'keep evidence');
  const fresh=invoke('artifacts',{...data,control:other,retainHours:72}); assert.equal(fresh.status,0,fresh.stderr);
  const inventory=JSON.parse(invoke('list-retained',{root}).stdout); assert.equal(inventory.length,1);
  assert.equal(JSON.parse(invoke('retained-disk',{root}).stdout)['devbox-cn-1'],14);
  assert.equal(invoke('retire-artifacts',{root,receipt:path.basename(other)}).status,0);
  assert.equal(fs.existsSync(path.join(other,'artifacts')),false);
  const args=['--project','fixture','--task','retention','--repo',temp];
  assert.equal(parseArgs([...args,'--retain-on-fail','--retain-hours','72','--','true']).retainOnFail,true);
  for(const hours of ['0','73','NaN']) assert.throws(()=>parseArgs([...args,'--retain-hours',hours,'--','true']));
  const stale=path.join(root,'missing-alias'), desired=path.join(root,'inputs','asset','a'.repeat(64));
  const map=invoke('inputs-ready',{root,control,inputs:[{key:'asset+'+'a'.repeat(64),path:stale,hash:'a'.repeat(64),sizeGiB:1}],paths:{asset:stale},defaultPaths:{asset:desired}});
  assert.equal(map.status,0,map.stderr); assert.equal(JSON.parse(fs.readFileSync(path.join(control,'inputs.json'))).asset,desired);
  const repository=path.join(root,'repos','fixture'); fs.mkdirSync(repository,{recursive:true});
  fs.mkdirSync(path.join(workspace,'.git'));
  const inspectData={...data,repository,reuseAllowed:true,cleanTimeoutSec:.05};
  const slow=remoteScripts.inspect.replace('root=pathlib.Path',`import types
subprocess.run=lambda *a,**k:types.SimpleNamespace(returncode=0)
def check(args,**options):
    if 'status' in args:
        assert 0<options['timeout']<=.05
        raise subprocess.TimeoutExpired(args,options['timeout'])
    if 'rev-parse' in args: return d['commit']+'\\n'
    return b''
subprocess.check_output=check
root=pathlib.Path`);
  const fallback=invoke('inspect',inspectData,slow); assert.equal(fallback.status,0,fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).sameRefClean,false,'status timeout is a clean=false fallback, not an inspection failure');
  const noReuse=invoke('inspect',{...inspectData,reuseAllowed:false},slow.replace("raise subprocess.TimeoutExpired(args,options['timeout'])","raise RuntimeError('non-reuse inspection ran git status')"));
  assert.equal(noReuse.status,0,noReuse.stderr);
  const saved=fs.createWriteStream;
  fs.createWriteStream=()=>new Writable({highWaterMark:1,write(chunk,encoding,done){setImmediate(()=>done(Object.assign(Error('fixture output sink'),{code:'EIO'})));}});
  const started=performance.now();
  let output;
  try { output=await execute(process.execPath,['-e','for(let i=0;i<256;i++)process.stdout.write(Buffer.alloc(65536))'],{outputFile:path.join(temp,'sink'),timeout:5000}); }
  finally { fs.createWriteStream=saved; }
  assert.notEqual(output.code,0); assert.match(output.error,/output file EIO/);
  assert.ok(performance.now()-started<5000,'paused stdout is drained after sink failure');
  console.log('PASS normalized/filtered manifest names, 24/72h retention, partial/archive TTL, exact retirement, disk accounting, missing-input defaults, bounded reuse fallback and paused output-sink failure');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
