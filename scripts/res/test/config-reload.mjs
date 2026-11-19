import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
const root=fs.mkdtempSync(path.join(process.env.RES_TEST_ROOT,'config-reload-'));
const state=path.join(root,'state'), mocks=path.join(root,'mocks');
for(const dir of [state,mocks,path.join(state,'locks'),path.join(state,'devbox-metrics')])fs.mkdirSync(dir,{recursive:true});
const source=process.env.RES_SOURCE;
fs.writeFileSync(path.join(state,'resources.tsv'),'heavy-build\tslot\topen\t-\tfixture\nheavy-lane-1\tslot\topen\t-\tfixture\nheavy-lane-2\tslot\topen\t-\tfixture\ndevbox-cn-1\tremote\topen\t-\tfixture runner@192.0.2.1 caps=node\n');
fs.writeFileSync(path.join(mocks,'uname'),'#!/bin/sh\necho Darwin\n',{mode:0o755});
fs.writeFileSync(path.join(mocks,'sleep'),`#!/bin/sh
if [ "$1" = 15 ]; then
  count_file="${root}/sleep-count"
  n=0; [ ! -f "$count_file" ] || n=$(cat "$count_file"); n=$((n+1)); printf '%s' "$n" > "$count_file"
  mark="${root}/sleep.$n"; touch "$mark"
  while [ ! -f "$mark.release" ]; do /bin/sleep 0.02; done
else exec /bin/sleep "$@"; fi
`,{mode:0o755});
const env={...process.env,RES_DIR:state,PATH:`${mocks}:${process.env.PATH}`,RES_TEST_METRICS:'1',RES_TEST_LOAD1M:'8',RES_TEST_PHYSICAL_CORES:'14',RES_TEST_MEMORYSTATUS_LEVEL:'50',RES_TEST_MEMSIZE:'68719476736',RES_TEST_SWAPUSAGE:'used = 0M',RES_TEST_VM_STAT:'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 0.\nPages inactive: 0.\nPages speculative: 0.'};
const args=by=>['--by',by,'--project','fixture','--task','reload','--for','configuration reload','--pid',String(process.pid)];
const config=text=>{const file=path.join(state,'next.conf');fs.writeFileSync(file,text);fs.renameSync(file,path.join(state,'machine.conf'));};
const run=(argv,extra={})=>{const r=spawnSync(source,argv,{env:{...env,...extra},encoding:'utf8',timeout:60000});if(r.error)throw r.error;return r;};
let assertions=0;const eq=(a,b,msg)=>{assert.equal(a,b,msg);assertions++;};const ok=(a,msg)=>{assert.ok(a,msg);assertions++;};
const children=new Set();
function start(argv,extra={}){
 const child=spawn(source,argv,{env:{...env,...extra},stdio:['ignore','pipe','pipe']});children.add(child);
 const record={child,output:'',code:undefined};child.stdout.on('data',b=>record.output+=b);child.stderr.on('data',b=>record.output+=b);
 record.done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{record.code=code;children.delete(child);resolve(code);});});return record;
}
async function until(test,record){const deadline=Date.now()+60000;while(!test()){assert.ok(Date.now()<deadline && record?.code===undefined,record?.output || 'fixture timeout');await pause(20);}}
function waiter(pool,by){const dir=path.join(state,pool);for(const name of fs.existsSync(dir)?fs.readdirSync(dir):[]){const info=path.join(dir,name,'info');if(name.startsWith('waiter.') && fs.existsSync(info)){const text=fs.readFileSync(info,'utf8');if(text.includes('holder\t'+by+'\n'))return Object.fromEntries(text.trim().split('\n').map(line=>line.split('\t')));}}}
try{
 config('FUTURE_GATE.rule_one=alpha=beta\n');const future=run(['heavy-check']);eq(future.status,0,future.stderr);ok(future.stderr.includes('ignoring unknown machine.conf key FUTURE_GATE.rule_one'));
 for(const text of ['bad line\n','lowercase=1\n','LOAD_LIMIT=oops\n','LOAD_LIMIT=12\nLOAD_LIMIT=12\n','FUTURE_GATE=1\nFUTURE_GATE=2\n','LOAD_POLL_SECONDS=31\n']){fs.rmSync(path.join(state,'machine-last-good.json'),{force:true});config(text);eq(run(['heavy-check']).status,1,'invalid configuration without last-good fails closed');}
 config('LOAD_POLL_SECONDS=15\nFUTURE_GATE.rule_one=alpha\n');
 const build=start(['wait-build',...args('build-reload'),'--timeout','2'],{RES_TEST_LOAD1M:'100'});
 await until(()=>fs.existsSync(path.join(root,'sleep.1')),build);
 const original=waiter('build-waiters','build-reload');ok(original);const order=original.order;
 config('LOAD_LIMIT=oops\n');fs.writeFileSync(path.join(root,'sleep.1.release'),'');
 await until(()=>fs.existsSync(path.join(root,'sleep.2')),build);eq(waiter('build-waiters','build-reload').order,order);eq(build.code,undefined);
 fs.writeFileSync(path.join(root,'sleep.2.release'),'');await until(()=>fs.existsSync(path.join(root,'sleep.3')),build);eq(waiter('build-waiters','build-reload').order,order);
 eq((build.output.match(/invalid machine.conf reload/g)||[]).length,1,'one invalid reload warning');
 config('LOAD_LIMIT=110\nLOAD_LIMIT_WITH_LANES=110\nLANE_LOAD_PER_CORE=10\nBUILD_LOAD_PER_CORE=10\nLOAD_POLL_SECONDS=15\nHEAD_OVERRIDE_BASE_LOAD=1\nFUTURE_GATE.rule_one=beta\n');
 fs.writeFileSync(path.join(root,'sleep.3.release'),'');eq(await build.done,0,build.output);
 eq((build.output.match(/ignoring unknown machine.conf key FUTURE_GATE.rule_one/g)||[]).length,1,'one warning per future key');
 ok(build.output.includes('LOAD_LIMIT=110'),'valid later configuration takes effect');eq(run(['return-build','--by','build-reload','--pid',String(process.pid)]).status,0);
 config('LOAD_POLL_SECONDS=15\nFUTURE_GATE.rule_one=alpha\n');
 const legacy=start(['wait','heavy-lane-1',...args('legacy-reload'),'--timeout','2'],{RES_TEST_LOAD1M:'100'});
 await until(()=>fs.existsSync(path.join(root,'sleep.4')),legacy);config('LOAD_LIMIT=bad\n');fs.writeFileSync(path.join(root,'sleep.4.release'),'');
 await until(()=>fs.existsSync(path.join(root,'sleep.5')),legacy);eq(legacy.code,undefined);
 config('LANE_LOAD_PER_CORE=10\nBUILD_LOAD_PER_CORE=10\nFUTURE_GATE.rule_one=alpha\n');fs.writeFileSync(path.join(root,'sleep.5.release'),'');
 eq(await legacy.done,0,legacy.output);ok((legacy.output.match(/invalid machine.conf reload/g)||[]).length<=1,'global invalid-config warning rate limit');
 eq(run(['return','heavy-lane-1','--by','legacy-reload']).status,0);
 const host='192.0.2.1';fs.writeFileSync(path.join(state,'devbox-metrics',host+'.json'),JSON.stringify({at:Date.now()/1000,cores:8,load5:99,memAvailableGiB:100,freeGiB:1000}));
 const poolConfig='DEVBOX_DYNAMIC_ADMISSION=1\nDEVBOX_DYNAMIC_HOSTS='+host+'\nFUTURE_GATE.rule_one=alpha\n';
 config(poolConfig);const first=path.join(root,'pool-first'),second=path.join(root,'pool-second');
 const pool=start(['wait-pool','devbox-cn',...args('pool-reload'),'--timeout','2'],{PAUSE_MARK:first,SECOND_MARK:second,RES_TEST_POOL_FAST_POLL:'1'});
 await until(()=>fs.existsSync(first),pool);const poolOrder=waiter('pool-waiters/devbox-cn','pool-reload').order;
 config('DEVBOX_HEAVY_CORES=bad\n');fs.writeFileSync(first+'.release','');await until(()=>fs.existsSync(second),pool);
 eq(waiter('pool-waiters/devbox-cn','pool-reload').order,poolOrder);eq(pool.code,undefined);ok((pool.output.match(/invalid machine.conf reload/g)||[]).length<=1,'global invalid-config warning rate limit');
 config(poolConfig+'DEVBOX_LOAD_PER_CORE=20\nHEAD_OVERRIDE_BASE_LOAD=1\n');fs.writeFileSync(second+'.release','');eq(await pool.done,0,pool.output);
 eq((pool.output.match(/ignoring unknown machine.conf key FUTURE_GATE.rule_one/g)||[]).length,1);ok(pool.output.includes('slot=devbox-cn-1'));
 config('bad line\n');eq(run(['return','devbox-cn-1','--by','pool-reload']).status,0,'return works during invalid publication');
 eq(run(['wait-pool','devbox-cn',...args('fresh-bad'),'--timeout','0']).status,0,'fresh pool uses durable last-good config');
 eq(run(['return','devbox-cn-1','--by','fresh-bad']).status,0);
 eq(fs.readdirSync(path.join(state,'build-waiters')).filter(name=>name.startsWith('.config.')).length,0,'waiter cache cleaned after exit');
 console.log(`ALL ${assertions} ASSERTIONS PASSED`);
}finally{for(const child of children)child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
