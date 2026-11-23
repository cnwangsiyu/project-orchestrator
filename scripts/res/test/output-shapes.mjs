#!/usr/bin/env node
// VAK W678 consumes these live CLI shapes; fixtures never use live resources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'res-shapes-'));
const source=fileURLToPath(new URL('../res',import.meta.url));
const host='192.0.2.1', mini='Bytedances-Mac-mini.local', now=Date.now()/1000;
const env={...process.env,RES_DIR:root,RULES_SHARED:root};
const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
const run=(...args)=>{
  const result=spawnSync(source,args,{env,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr); return result.stdout;
};
const required=['slot','kind','policy','host','user','target','root','cores','memGiB','factsAt','caps','dynamic','resolverOnly','category'];
const pin=value=>{
  assert.equal(typeof value,'object'); assert.ok(!Array.isArray(value));
  for(const name of required) assert.ok(Object.hasOwn(value,name),name);
  for(const name of ['slot','kind','policy','host','user','target','category']) assert.equal(typeof value[name],'string',name);
  for(const name of ['dynamic','resolverOnly']) assert.equal(typeof value[name],'boolean',name);
  assert.ok(Array.isArray(value.caps));
  assert.ok(value.root===null || typeof value.root==='string');
  assert.ok(value.cores===null || typeof value.cores==='number');
  assert.ok(value.memGiB===null || typeof value.memGiB==='number');
  assert.ok(value.factsAt===null || typeof value.factsAt==='string');
};
try {
  fs.mkdirSync(path.join(root,'devbox-metrics'));
  fs.writeFileSync(path.join(root,'resources.tsv'),`devbox-host-fixture\tremote\topen\t-\trunner@${host} caps=node root=/tmp/runner\nmini2-exec-1\tremote\topen\t-\tSecond Mac mini bytedance@${mini} caps=cmake-native dynamic-host\n`);
  fs.writeFileSync(path.join(root,'machine.conf'),'DEVBOX_MAX_BYPASS=3\n');
  write('devbox-metrics/'+host+'.json',{at:now,cores:64,load5:0,memAvailableGiB:256,freeGiB:2000,io_some_avg60:0,io_full_avg10:0});
  write('mini2-config.json',{enabled:true,maintenance:false,load5Limit:'derived',minAvailableGiB:'derived',minFreeGiB:20,owner:'fixture',generation:0});
  write('mini2-link.json',{at:now,link:'UP',maintenance:false});
  write('mini2-metrics.json',{at:now,host:mini,arch:'arm64',cores:10,totalGiB:32,load5:0,availableGiB:32,freeGiB:200,pressure:1,swapGiB:0,compressorGiB:0});
  write('mini2-facts.json',{at:now,host:mini,caps:['cmake-native']});
  const args=['--by','fixture','--project','fixture','--task','shape','--for','shape','--pid',String(process.pid)];
  const dv=/^slot=(\S+)$/m.exec(run('wait-pool','devbox-cn-light',...args,'--timeout','0'))[1];
  const mk=JSON.parse(run('wait-pool','mini2',...args,'--need','cmake-native'));
  const resolved=JSON.parse(run('slot-host',dv)); pin(resolved); assert.equal(resolved.host,host);
  pin(JSON.parse(run('slot-host',mk.slot)));
  const rows=JSON.parse(run('devbox-registry')); assert.ok(Array.isArray(rows)); rows.forEach(pin);
  assert.ok(rows.filter(row=>row.host===host).length>=2);
  assert.ok(rows.filter(row=>row.host===mini).length>=2);
  for(const pool of ['devbox-cn','devbox-cn-light','mini2']) {
    const map=JSON.parse(run('pool-capacity',pool)); assert.ok(!Array.isArray(map));
    const entry=map[pool==='mini2'?mini:host];
    assert.equal(typeof entry.claims,'number'); assert.ok(Number.isInteger(entry.claims));
    assert.equal(typeof entry.gate,'string'); assert.ok(entry.claims>=0);
  }
  run('return',dv,'--by','fixture');
  write('clean.json',{generation:mk.lease.generation,clean:true});
  run('return',mk.slot,'--by','fixture','--receipt',path.join(root,'clean.json'));
  console.log('PASS pinned slot-host object, devbox-registry slot rows, pool-capacity host map');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
