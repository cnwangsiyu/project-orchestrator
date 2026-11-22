#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { strict as baseAssert } from 'node:assert';
let assertionCount = 0;
const assert = new Proxy(baseAssert, { get(target, name) {
  const value = Reflect.get(target, name);
  return typeof value === 'function' ? (...args) => { assertionCount++; return value.apply(target, args); } : value;
} });
import { fileURLToPath } from 'node:url';
import { migrate } from '../../devbox-host-migrate.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-devbox-'));
const source = fileURLToPath(new URL('../res', import.meta.url));
const env = { ...process.env, RES_DIR: root, RULES_SHARED: root, RES_TEST_POOL_FAST_POLL: '1' };
const host = '192.0.2.1', lease = n => `devbox-cn-fixture-${n}`;
fs.mkdirSync(path.join(root, 'devbox-metrics'));
fs.writeFileSync(path.join(root, 'resources.tsv'), `devbox-host-fixture\tremote\topen\t-\trunner@${host} caps=node root=/tmp/runner\n`);
fs.writeFileSync(path.join(root, 'machine.conf'), 'DEVBOX_MAX_BYPASS=3\n');
const sample = (changes = {}) => fs.writeFileSync(path.join(root, 'devbox-metrics', host + '.json'), JSON.stringify({ at: Date.now()/1000, cores:64, load5:0, memAvailableGiB:256, freeGiB:2000, io_some_avg60:0, io_full_avg10:0, ...changes }));
const run = (...args) => spawnSync(source, args, { env, encoding:'utf8', timeout:10000 });
const args = by => ['--by', by, '--project', 'fixture', '--task', 'dynamic', '--for', 'test', '--pid', String(process.pid)];
const wait = (by, pool='devbox-cn-light', extra=[]) => run('wait-pool', pool, ...args(by), '--timeout', '0', ...extra);
const slot = r => /^slot=(\S+)$/m.exec(r.stdout)?.[1];
const release = (id, by) => { const r=run('return',id,'--by',by); assert.equal(r.status,0,r.stderr); };
try {
  sample();
  const capacity=run('pool-capacity','devbox-cn-light');assert.equal(capacity.status,0,capacity.stderr);assert.equal(JSON.parse(capacity.stdout)[host].claims,64);
  const children = Array.from({length:12}, (_,i)=>new Promise(resolve=> {
    const child=spawn(source,['wait-pool','devbox-cn-light',...args('small-'+i),'--timeout','1'],{env});
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    child.on('close',status=>resolve({status,stdout,stderr,by:'small-'+i}));
  }));
  const results = await Promise.all(children);
  for (const r of results) assert.equal(r.status,0,r.stderr);
  assert.equal(new Set(results.map(slot)).size,12);
  const snapshot=run('holder',slot(results[0]),'--by',results[0].by);assert.equal(snapshot.status,0,snapshot.stderr);assert.equal(JSON.parse(snapshot.stdout).mine,'yes');
  const status=run('status','devbox-cn-light'); assert.equal(status.status,0,status.stderr);assert.match(status.stdout,/reserved_cores=12/);
  for(const r of results)release(slot(r),r.by);
  // Every real host gate blocks admission for either default category.
  for(const [field,value,reason] of [['load5',64,'load'],['memAvailableGiB',5,'memory'],['freeGiB',54,'disk'],['io_some_avg60',26,'io-pressure']]){
    sample({[field]:value});const r=wait('gate-'+field);assert.equal(r.status,2,r.stderr);
    assert.match(fs.readFileSync(path.join(root,'log.tsv'),'utf8'),new RegExp('reason='+reason));
  }
  sample();const recovered=wait('io-recover');assert.equal(recovered.status,0,recovered.stderr);release(slot(recovered),'io-recover');
  sample({at:Date.now()/1000-301});assert.equal(wait('stale').status,2);
  sample({cores:8});
  const q=path.join(root,'pool-waiters','devbox-cn','waiter.older');fs.mkdirSync(q,{recursive:true});
  const waiter={holder:'large',pid:String(process.pid),host:os.hostname(),order:'00000000000000000001',heartbeat:String(Math.floor(Date.now()/1000)),claim_kind:'HEAVY',claim_cores:'9',claim_mem:'8',claim_disk:'2',need:'node'};
  const publish=()=>fs.writeFileSync(path.join(q,'info'),Object.entries(waiter).map(([k,v])=>k+'\t'+v+'\n').join(''));
  publish();
  const bypass=[];for(let i=0;i<3;i++){const r=wait('bypass-'+i);assert.equal(r.status,0,r.stderr);bypass.push(slot(r));}
  assert.equal(wait('bounded').status,2,'fourth small request must wait for large FIFO head');
  assert.match(fs.readFileSync(path.join(q,'info'),'utf8'),/bypasses\t3/);
  for(let i=0;i<3;i++)release(bypass[i],'bypass-'+i);
  // A fitting older heavy waiter blocks the other category immediately.
  waiter.claim_cores='3';publish();assert.equal(wait('fitting-head').status,2);
  fs.rmSync(q,{recursive:true});
  // Exercise real queue drainage: a large live waiter acquires after bounded
  // small bypasses return their reservations, without surrendering FIFO order.
  sample({cores:8});
  const blockers=[wait('blocker-0'),wait('blocker-1')];for(const r of blockers)assert.equal(r.status,0,r.stderr);
  const large=new Promise(resolve=>{
    const child=spawn(source,['wait-pool','devbox-cn',...args('large-live'),'--cores','7','--disk-gib','2','--timeout','1'],{env});
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('close',status=>resolve({status,stdout,stderr}));
  });
  const queue=path.join(root,'pool-waiters','devbox-cn');
  for(let i=0;i<100;i++){
    const found=fs.readdirSync(queue).filter(n=>n.startsWith('waiter.')).some(n=>fs.readFileSync(path.join(queue,n,'info'),'utf8').includes('holder\tlarge-live\n'));
    if(found)break;
    if(i===99)throw Error('large live waiter did not publish');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const smallLive=[];for(let i=0;i<3;i++){const r=wait('small-live-'+i);assert.equal(r.status,0,r.stderr);smallLive.push(r);}
  // Let the head publish another heartbeat after the three committed bypasses.
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(wait('drain-head').status,2);
  for(let i=0;i<blockers.length;i++)release(slot(blockers[i]),'blocker-'+i);
  for(let i=0;i<smallLive.length;i++)release(slot(smallLive[i]),'small-live-'+i);
  const admittedLarge=await large;assert.equal(admittedLarge.status,0,admittedLarge.stderr);release(slot(admittedLarge),'large-live');
  sample();const weighted=wait('weighted','devbox-cn',['--cores','7','--mem-gib','9','--disk-gib','4']);assert.equal(weighted.status,0,weighted.stderr);
  const infoFile=path.join(root,'locks',slot(weighted)+'.d','info');assert.match(fs.readFileSync(infoFile,'utf8'),/claim_cores\t7/);
  const reserveFile=path.join(root,'devbox-reservations',host+'.json');const records=JSON.parse(fs.readFileSync(reserveFile,'utf8'));records[0][0]-=1000;fs.writeFileSync(reserveFile,JSON.stringify(records));
  sample({cores:8});const persisted=wait('persisted','devbox-cn',['--cores','2']);assert.equal(persisted.status,2,persisted.stderr);release(slot(weighted),'weighted');
  assert.notEqual(wait('invalid','devbox-cn',['--cores','0']).status,0);
  // Pending receipts keep their ordinal unavailable; known IDs remain resolvable.
  fs.mkdirSync(path.join(root,'devbox-cleanup-pending'));fs.writeFileSync(path.join(root,'devbox-cleanup-pending',lease(1)+'.json'),'{}');
  const catalog=run('devbox-registry');assert.equal(catalog.status,0,catalog.stderr);assert.ok(JSON.parse(catalog.stdout).some(r=>r.slot===lease(1)));
  assert.equal(JSON.parse(run('slot-host',lease(22)).stdout).host,host);
  fs.rmSync(path.join(root,'devbox-cleanup-pending'),{recursive:true});
  // Dead local small holders reclaim after 15 minutes; the prior owner weight is removed.
  const d=path.join(root,'locks',lease(1)+'.d');fs.mkdirSync(d);
  fs.writeFileSync(path.join(d,'info'),`by\tdead\npid\t2147483647\nhost\t${os.hostname()}\nstart\t${Math.floor(Date.now()/1000)-1000}\nclaim_kind\tLIGHT\nclaim_cores\t1\nclaim_mem\t2\nclaim_disk\t2\n`);
  fs.appendFileSync(path.join(root,'machine.conf'),'DEVBOX_LIGHT_STALE_RECLAIM=1\n');sample();
  const reclaimed=wait('reclaim','devbox-cn-light',['--prefer-slot',lease(1)]);assert.equal(reclaimed.status,0,reclaimed.stderr);assert.equal(slot(reclaimed),lease(1));release(slot(reclaimed),'reclaim');
  // Explicit safety valve is shared across categories.
  fs.appendFileSync(path.join(root,'machine.conf'),'DEVBOX_MAX_CLAIMS=1\n');const limited=wait('first');assert.equal(limited.status,0,limited.stderr);assert.equal(wait('second','devbox-cn').status,2);release(slot(limited),'first');
  const old=`# fixture\ndevbox-cn-1\tremote\topen\t-\trunner@${host} caps=node prefer=node\ndevbox-cn-light\tremote\topen\t-\trunner@${host} caps=node\nheavy-build\tslot\topen\t-\tlocal\n`;
  const converted=migrate(old).text;assert.equal((converted.match(/^devbox-host-/gm)||[]).length,1);assert.match(converted,/aliases=devbox-cn-1,devbox-cn-light/);assert.match(converted,/heavy-build\tslot/);
  assert.throws(()=>migrate(old.replace('remote\topen','remote\tnever')),/conflicting/);
  fs.writeFileSync(path.join(root,'resources.tsv'),converted);
  const legacy=run('slot-host','devbox-cn-light');assert.equal(legacy.status,0,legacy.stderr);assert.equal(JSON.parse(legacy.stdout).host,host);
  const legacyDir=path.join(root,'locks','devbox-cn-light.d');fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir,'info'),`by\tlegacy-live\npid\t${process.pid}\nhost\t${os.hostname()}\nstart\t${Math.floor(Date.now()/1000)}\n`);
  release('devbox-cn-light','legacy-live');
  assert.equal(run('take','devbox-host-fixture',...args('host-row')).status,1);
  fs.writeFileSync(path.join(root,'resources.tsv'),`devbox-host-fixture\tremote\topen\t-\trunner@${host} caps=node\n`);
  const excluded=wait('exclude-first','devbox-cn-light',['--exclude-slot',lease(1),'--exclude-reason','fixture']);
  assert.equal(excluded.status,0,excluded.stderr);assert.notEqual(slot(excluded),lease(1));release(slot(excluded),'exclude-first');
  // The migration operates only on explicit fixture files, with default dry-run.
  const registry=path.join(root,'migration.tsv');fs.writeFileSync(registry,old);
  const migration=fileURLToPath(new URL('../../devbox-host-migrate.mjs',import.meta.url));
  const cli=(...extra)=>spawnSync(process.execPath,[migration,'--registry',registry,...extra],{encoding:'utf8'});
  assert.equal(cli().status,0);assert.equal(fs.readFileSync(registry,'utf8'),old);
  assert.equal(cli('--apply').status,0);assert.equal(fs.readFileSync(registry+'.pre-dynamic','utf8'),old);
  assert.equal(cli('--rollback').status,0);assert.ok(fs.readFileSync(registry,'utf8').startsWith(old.trimEnd()));assert.match(fs.readFileSync(registry,'utf8'),/leases-only/);
  console.log('PASS dynamic leases: concurrent weights, gates, combined bounded FIFO, persistent reservations, aliases, pending cleanup, stale reclaim, migration/rollback');
  console.log(`ALL ${assertionCount} ASSERTIONS PASSED`);
} finally { fs.rmSync(root,{recursive:true}); }
