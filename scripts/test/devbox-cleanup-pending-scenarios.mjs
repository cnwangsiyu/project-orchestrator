import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { remoteScripts } from '../devbox-run.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cleanup-uuid-'));
const root=path.join(temp,'devbox-run'), run=randomUUID(), control=path.join(root,'runs',run);
fs.mkdirSync(control,{recursive:true});
const own=spawn(process.execPath,['-e','setInterval(()=>{},1000)',run],{stdio:'ignore'});
const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)',randomUUID()],{stdio:'ignore'});
const probe=()=>spawnSync('python3',['-c',remoteScripts['cleanup-pending'],Buffer.from(JSON.stringify({root,control})).toString('base64')],{encoding:'utf8',timeout:8000});
const closed=child=>new Promise(resolve=>child.once('close',resolve));
const ownClosed=closed(own), otherClosed=closed(other);
try {
  const live=probe(); assert.equal(live.status,0,live.stderr); assert.equal(JSON.parse(live.stdout).clean,false);
  own.kill('SIGTERM'); await ownClosed;
  const gone=probe(); assert.equal(gone.status,0,gone.stderr); assert.equal(JSON.parse(gone.stdout).clean,true,'unrelated live UUID does not block or get signalled');
  assert.equal(other.exitCode,null);
  const missing=spawnSync('python3',['-c',remoteScripts['cleanup-pending'],Buffer.from(JSON.stringify({root,control:path.join(root,'runs',randomUUID())})).toString('base64')],{encoding:'utf8',timeout:8000});
  assert.notEqual(missing.status,0,'missing run evidence is not confirmed gone');
  console.log('PASS native UUID-specific process evidence, unrelated live process preservation and missing-receipt fail-closed check');
} finally {
  own.kill('SIGTERM'); other.kill('SIGTERM'); await ownClosed; await otherClosed;
  fs.rmSync(temp,{recursive:true,force:true});
}
