import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { remoteScripts } from '../devbox-run.mjs';
import { fingerprint, duration, manifest, inputKey, readIndex, indexFile, inputSettings, placement, observedCost, warmCost, warmInput } from '../lib/devbox-inputs.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(),'input-scenarios-'));
try {
  const hash = 'a'.repeat(64);
  const [input] = manifest([`name=sdk,hash=${hash},rebuildable=yes,cost=27m,size=20`]);
  assert.throws(()=>manifest([`name=sdk,name=other,hash=${hash},rebuildable=yes,cost=1s,size=1`]));
  assert.equal(input.costSec,1620); assert.equal(duration('43s'),43);
  for (const value of ['bad','-1s','25h']) assert.throws(() => duration(value));
  for (const extra of [',surprise=yes',',path=relative',',seed=cmd:prepare']) {
    const base = extra.includes('seed') ? 'name=state,hash=none,rebuildable=no,cost=0s,size=0' : `name=sdk,hash=${hash},rebuildable=yes,cost=27m,size=20`;
    assert.throws(() => manifest([base+extra]));
  }
  assert.throws(() => manifest([`name=sdk,hash=${hash},rebuildable=yes,cost=1s,size=0`,`name=sdk,hash=${hash},rebuildable=yes,cost=2s,size=0`]));
  const rows = [{slot:'warm',host:'one'},{slot:'cold',host:'two'}];
  const indices = {one:{inputs:{[inputKey(input)]:{verifiedAt:1000}}}};
  const options = {now:1001,holds:{warm:{start:900}},durations:{warm:700}};
  const score = cost => placement(rows,[{...input,costSec:cost}],indices,{},options).toSorted((a,b) => a.totalSec-b.totalSec)[0].slot;
  assert.equal(score(1620),'warm','600s wait beats 27m rebuild');
  assert.equal(score(45),'cold','free cold slot beats 600s wait for cheap rebuild');
  const pinned = placement(rows,[{...input,rebuildable:false}],indices,{},options);
  assert.equal(pinned[0].eligible,true); assert.equal(pinned[1].eligible,false); assert.match(pinned[1].hardReasons[0],/sdk/);
  assert.equal(placement(rows,[input],indices,{}, {...options,now:1300})[0].rebuildSec,1620,'expired verification does not pin');
  assert.equal(placement(rows,[],{}, {}, {now:1001})[0].rebuildSec,0);
  assert.equal(observedCost(input,{inputs:{[inputKey(input)]:[45,50]}}),1620);
  assert.equal(observedCost(input,{inputs:{[inputKey(input)]:[45,500,50]}}),50);
  assert.equal(warmCost({cold:[1620],warm:[43]},undefined),1577);
  assert.equal(warmCost({},1620),1620);
  assert.equal(warmInput('p','repo','branch',100).name,warmInput('p','repo','branch',100).name);
  assert.notEqual(warmInput('p','repo','other',100).name,warmInput('p','repo','branch',100).name);
  assert.deepEqual(readIndex(root,'one'),{version:1,inputs:{}});
  fs.mkdirSync(path.dirname(indexFile(root,'one')),{recursive:true});
  fs.writeFileSync(indexFile(root,'one'),JSON.stringify({version:1,inputs:indices.one.inputs}));
  assert.deepEqual(readIndex(root,'one'),{version:1,inputs:indices.one.inputs});
  assert.equal(inputSettings(root).enabled,true);
  fs.writeFileSync(path.join(root,'machine.conf'),'DEVBOX_REBUILD_PLACEMENT=0\nDEVBOX_INPUT_TTL_SECONDS=60\n');
  assert.deepEqual(inputSettings(root),{enabled:false,ttlSec:60,maxWaitSec:2700,seedMaxSec:300});
  fs.writeFileSync(path.join(root,'machine.conf'),'DEVBOX_INPUT_TTL_SECONDS=0\n');assert.throws(() => inputSettings(root));
  const file=path.join(root,'archive.tar');fs.writeFileSync(file,'named test input\n');
  const directory=path.join(root,'directory');fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'z.txt'),'last');fs.writeFileSync(path.join(directory,'a.txt'),'first');
  const script=fileURLToPath(new URL('../devbox-run.mjs',import.meta.url));
  for (const [target,kind] of [[file,'file'],[directory,'directory']]) {
    const result=spawnSync(process.execPath,[script,'input-hash',target],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const actual=JSON.parse(result.stdout);
    assert.deepEqual(actual,{...await fingerprint(target),kind});
    if(kind==='file') assert.equal(actual.hash,createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    const data={root,inputs:[{path:target,hash:actual.hash,key:'fixture',sizeGiB:0.01}]};
    const remote=spawnSync('python3',['-c',remoteScripts.inputs,Buffer.from(JSON.stringify(data)).toString('base64')],{encoding:'utf8'});
    assert.equal(remote.status,0,remote.stderr);const [verified]=JSON.parse(remote.stdout);
    assert.equal(verified.present,true);assert.equal(verified.bytes,actual.bytes);
  }
  console.log('PASS manifest validation, warm/cold placement, hard pins, TTL, observed medians, index and kill switch');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
