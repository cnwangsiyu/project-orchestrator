import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sshArgs, args } from '../mini2-run.mjs';
import { safeSourcePath, checkAllowlist, checkWorktree } from '../lib/mini2-source.mjs';
assert.throws(() => sshArgs('fe80::1%en0','true'));
const command=sshArgs('fe80::2%en12','true');
assert.ok(command.includes('-oHostname=fe80::2%%en12'));
assert.ok(command.includes('-oStrictHostKeyChecking=yes'));
assert.throws(() => args(['--repo','/tmp']));
for(const name of ['signing/release.txt','Library/login.keychain-db','api_token.txt','id_ed25519','.env','.npmrc',
  'keys/data','private-key.txt','client.mobileprovision','cert.p12','state/session.json','browser/cookies.sqlite']) assert.equal(safeSourcePath(name),false,name);
const allowed=['src/build.cc','CMakeLists.txt'];
checkAllowlist(allowed,[{name:'src/build.cc',mode:'100644'}],['CMakeLists.txt']);
assert.throws(()=>checkAllowlist(allowed,[{name:'src/build.cc',mode:'120000'}],[]));
assert.throws(()=>checkAllowlist(allowed,[{name:'unlisted.cc',mode:'100644'}],[]));
assert.throws(()=>checkAllowlist(allowed,[],['deleted-token.txt']));
assert.throws(()=>checkAllowlist(allowed,[],[],['src/build.cc']));
assert.throws(()=>checkAllowlist(allowed,[{name:'staged.cc',mode:'100644'}],[]));
const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mini2-worktree-')));
try {
  fs.writeFileSync(path.join(scratch,'safe.cc'),'int main() {}');
  checkWorktree(scratch,['safe.cc','deleted.cc']);
  fs.symlinkSync('safe.cc',path.join(scratch,'changed.cc'));
  assert.throws(()=>checkWorktree(scratch,['changed.cc']));
  fs.mkdirSync(path.join(scratch,'directory.cc'));
  assert.throws(()=>checkWorktree(scratch,['directory.cc']));
} finally { fs.rmSync(scratch,{recursive:true,force:true}); }
for(const file of ['test_mini2_link.py','test_mini2_control.py','test_mini2_remote.py']) {
  const result=spawnSync('python3',['-B','scripts/res/test/'+file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
}
console.log('PASS mini2 transport, admission, alarm, identity and cleanup contracts');
