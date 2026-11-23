#!/usr/bin/env node
// VAK W678 consumes these live CLI shapes; fixtures never use live resources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'res-shapes-'));
const source=process.env.RES_FIX_SOURCE?path.join(process.env.RES_FIX_SOURCE,'res','res'):fileURLToPath(new URL('../res',import.meta.url));
const host='192.0.2.1', mini='Bytedances-Mac-mini.local', now=Date.now()/1000;
const env={...process.env,RES_DIR:root,RULES_SHARED:root,RES_TEST_LOCAL_SAMPLE:path.join(root,"local-sample.json")};
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
  assert.ok(value.cores===null || Number.isFinite(value.cores));
  assert.ok(value.memGiB===null || Number.isFinite(value.memGiB));
  assert.ok(value.factsAt===null || typeof value.factsAt==='string');
};
try {
  fs.mkdirSync(path.join(root,'devbox-metrics'));
  fs.writeFileSync(path.join(root,'resources.tsv'),`devbox-host-fixture\tremote\topen\t-\trunner@${host} caps=node root=/tmp/runner\nmini2-exec-1\tremote\topen\t-\tSecond Mac mini bytedance@${mini} caps=cmake-native dynamic-host\nheavy-build\tslot\topen\t-\tFull build dynamic-local\nheavy-lane-1\tslot\topen\t-\tLocal lane\n`);
  fs.writeFileSync(path.join(root,'machine.conf'),'DEVBOX_MAX_BYPASS=3\n');
  write('devbox-metrics/'+host+'.json',{at:now,cores:64,load5:0,memAvailableGiB:256,freeGiB:2000,io_some_avg60:0,io_full_avg10:0});
  write('mini2-config.json',{enabled:true,maintenance:false,load5Limit:'derived',minAvailableGiB:'derived',minFreeGiB:20,owner:'fixture',generation:0});
  write('mini2-link.json',{at:now,link:'UP',maintenance:false});
  write('mini2-metrics.json',{at:now,host:mini,arch:'arm64',cores:10,totalGiB:32,load5:0,availableGiB:32,freeGiB:200,pressure:1,swapGiB:0,compressorGiB:0});
  write('local-sample.json',{at:now,host:os.hostname(),cores:14,totalGiB:64,load5:0,availableGiB:64,freeGiB:1000,pressure:1,swapGiB:0,compressorGiB:0});
  write('mini2-facts.json',{at:now,host:mini,caps:['cmake-native']});
  const args=['--by','fixture','--project','fixture','--task','shape','--for','shape','--pid',String(process.pid)];
  const dv=/^slot=(\S+)$/m.exec(run('wait-pool','devbox-cn-light',...args,'--timeout','0'))[1];
  const mk=JSON.parse(run('wait-pool','mini2',...args,'--need','cmake-native'));
  const resolved=JSON.parse(run('slot-host',dv)); pin(resolved); assert.equal(resolved.host,host);
  pin(JSON.parse(run('slot-host',mk.slot)));
  pin(JSON.parse(run('slot-host','heavy-lane-1')));
  const rows=JSON.parse(run('devbox-registry')); assert.ok(Array.isArray(rows)); rows.forEach(pin);
  assert.ok(rows.filter(row=>row.host===host).length>=2);
  assert.ok(rows.filter(row=>row.host===mini).length>=2);
  for(const pool of ['devbox-cn','devbox-cn-light','mini2','local','local-light']) {
    const map=JSON.parse(run('pool-capacity',pool)); assert.ok(!Array.isArray(map));
    const entry=map[pool==='mini2'?mini:pool.startsWith('local')?os.hostname():host];
    assert.equal(typeof entry.claims,'number'); assert.ok(Number.isInteger(entry.claims));
    assert.equal(typeof entry.gate,'string'); assert.ok(entry.claims>=0);
  }
  const cached=path.join(root,'mini2-metrics.json');
  fs.writeFileSync(cached,fs.readFileSync(cached,'utf8').replace('"freeGiB":200','"freeGiB":NaN'));
  const invalid=JSON.parse(run('pool-capacity','mini2'))[mini];
  assert.equal(invalid.claims,0); assert.equal(invalid.gate,'invalid-metrics');
  const localCached=path.join(root,'local-sample.json');
  fs.writeFileSync(localCached,fs.readFileSync(localCached,'utf8').replace('"load5":0','"load5":NaN'));
  const invalidLocal=JSON.parse(run('pool-capacity','local'))[os.hostname()];
  assert.equal(invalidLocal.claims,0); assert.equal(invalidLocal.gate,'invalid-metrics');
  const corrupt=(name,value,fields)=>{
    let content=JSON.stringify({...value,...Object.fromEntries(fields.map(field=>[field,'INVALID_METRIC']))});
    content=content.replaceAll('"INVALID_METRIC"',currentInvalid);
    fs.writeFileSync(path.join(root,name),content);
  };
  let currentInvalid;
  for(currentInvalid of ['NaN','Infinity','-Infinity','-1','null','"invalid"','true']) {
    corrupt('mini2-metrics.json',{at:Date.now()/1000,host:mini,arch:'arm64',load5:0,availableGiB:32,freeGiB:200,pressure:1,swapGiB:0,compressorGiB:0},['cores','totalGiB']);
    corrupt('mini2-facts.json',{host:mini,caps:['cmake-native']},['at']);
    corrupt('local-metrics.json',{},['at','cores','totalGiB']);
    corrupt('local-sample.json',{at:Date.now()/1000,host:os.hostname(),load5:0,availableGiB:64,freeGiB:1000,pressure:1,swapGiB:0,compressorGiB:0},['cores','totalGiB']);
    corrupt('devbox-metrics/'+host+'.json',{at:Date.now()/1000,cores:64,memAvailableGiB:256,freeGiB:2000,io_some_avg60:0,io_full_avg10:0},['load5']);
    let facts=JSON.stringify({[host]:{user:'runner',cores:'INVALID_METRIC',memGiB:'INVALID_METRIC',probedAt:'INVALID_METRIC'}});
    fs.writeFileSync(path.join(root,'devbox-hosts.json'),facts.replaceAll('"INVALID_METRIC"',currentInvalid));
    for(const id of [dv,mk.slot,'heavy-lane-1']) {
      const value=JSON.parse(run('slot-host',id)); pin(value);
      assert.equal(value.cores,null); assert.equal(value.memGiB,null); assert.equal(value.factsAt,null);
    }
    JSON.parse(run('devbox-registry')).forEach(pin);
    for(const pool of ['devbox-cn','mini2','local']) {
      const map=JSON.parse(run('pool-capacity',pool));
      const entry=map[pool==='mini2'?mini:pool==='local'?os.hostname():host];
      assert.equal(entry.claims,0); assert.equal(typeof entry.gate,'string');
    }
  }
  for(currentInvalid of ['1e100','{}','[]']) {
    corrupt('mini2-facts.json',{host:mini,caps:['cmake-native']},['at']);
    corrupt('local-metrics.json',{cores:14,totalGiB:64},['at']);
    for(const id of [mk.slot,'heavy-lane-1']) assert.equal(JSON.parse(run('slot-host',id)).factsAt,null);
    JSON.parse(run('devbox-registry')).forEach(pin);
  }
  for(currentInvalid of ['0','1','1e100','{}','[]']) {
    corrupt('devbox-hosts.json',{[host]:{user:'runner',cores:64,memGiB:256,probedAt:'INVALID_METRIC'}},[]);
    assert.equal(JSON.parse(run('slot-host',dv)).factsAt,null);
    JSON.parse(run('devbox-registry')).forEach(pin);
  }
  run('return',dv,'--by','fixture');
  write('clean.json',{generation:mk.lease.generation,clean:true});
  run('return',mk.slot,'--by','fixture','--receipt',path.join(root,'clean.json'));
  console.log('PASS pinned slot-host object, devbox-registry slot rows, pool-capacity host map');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
