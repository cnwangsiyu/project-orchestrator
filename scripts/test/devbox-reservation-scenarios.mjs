import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readbackReservedDisk, resolveSlot } from '../devbox-run.mjs';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'reservation-lifetime-'));
const previous={RES_DIR:process.env.RES_DIR,RULES_SHARED:process.env.RULES_SHARED};
process.env.RES_DIR=scratch;process.env.RULES_SHARED=scratch;
const host='192.0.2.1', legacy='devbox-cn-1', dynamic='devbox-cn-fixture-2';
const recordFile=path.join(scratch,'devbox-reservations',host+'.json');
fs.mkdirSync(path.dirname(recordFile),{recursive:true});fs.mkdirSync(path.join(scratch,'locks'));
fs.writeFileSync(path.join(scratch,'machine.conf'),'DEVBOX_MAX_BYPASS=3\n');
const registry=dynamicMode=>fs.writeFileSync(path.join(scratch,'resources.tsv'),dynamicMode
  ?`devbox-host-fixture\tremote\topen\t-\trunner@${host} aliases=${legacy}\n`
  :`${legacy}\tremote\topen\t-\trunner@${host}\n`);
const owner=slot=>({slot,by:'fixture-holder',pid:String(process.pid),host:os.hostname(),start:String(Math.floor(Date.now()/1000)-2000)});
const hold=(who,changes={})=>{
  const dir=path.join(scratch,'locks',who.slot+'.d');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'info'),Object.entries({...who,claim_kind:'HEAVY',claim_cores:'1',claim_mem:'1',claim_disk:'20',...changes}).map(([k,v])=>k+'\t'+v+'\n').join(''));
};
const records=values=>fs.writeFileSync(recordFile,JSON.stringify(values));
try {
  registry(true);const who=owner(dynamic);hold(who);
  records([[Date.now()/1000-1000,1,1,20,who]]);
  const row=resolveSlot(scratch,dynamic);assert.equal(row.dynamic,true);
  assert.equal(readbackReservedDisk(row),20,'owned dynamic record persists beyond 900 seconds');
  records([[Date.now()/1000-1000,1,1,20,who],[Date.now()/1000,1,1,20,who]]);
  assert.equal(readbackReservedDisk(row),20,'duplicate ownership is counted once');
  hold(who,{by:'replacement',claim_disk:'7'});
  assert.equal(readbackReservedDisk(row),7,'replaced reservation does not survive; actual new hold is reserved');
  fs.rmSync(path.join(scratch,'locks',dynamic+'.d'),{recursive:true});
  assert.equal(readbackReservedDisk(row),0,'returned ownership no longer reserves disk');
  registry(false);const old=owner(legacy);hold(old);const oldRow=resolveSlot(scratch,legacy);
  records([[Date.now()/1000-1000,1,1,20,old]]);
  assert.equal(readbackReservedDisk(oldRow),0,'legacy owned disk reservation expires');
  records([[Date.now()/1000-1000,1,1,20]]);
  assert.equal(readbackReservedDisk(oldRow),0,'legacy anonymous disk reservation expires');
  records([[Date.now()/1000-898,1,1,20]]);
  assert.equal(readbackReservedDisk(oldRow),20,'legacy disk reservation remains before expiry');
  records([[Date.now()/1000,1,1]]);
  assert.equal(readbackReservedDisk(oldRow),0,'CPU/memory-only legacy record has no disk weight');
  console.log('PASS allocator/readback parity: persistent dynamic ownership, replacements, duplicate records, returns and legacy lifetimes');
} finally {
  for(const [name,value] of Object.entries(previous))if(value===undefined)delete process.env[name];else process.env[name]=value;
  fs.rmSync(scratch,{recursive:true});
}
