import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute, snapshot, makeBundle } from '../devbox-run.mjs';
import { sshArgs, args, remoteSource } from '../mini2-run.mjs';
import { safeSourcePath, checkAllowlist, checkWorktree, checkSourceContent, checkUploads } from '../lib/mini2-source.mjs';
assert.throws(() => sshArgs('fe80::1%en0','true','en7'));
const command=sshArgs('fe80::2%en12','true','en12');
assert.ok(command.includes('-oHostname=fe80::2%%en12'));
assert.ok(command.includes('-oStrictHostKeyChecking=yes'));
assert.throws(() => args(['--repo','/tmp']));
const embedded = spawnSync('python3', ['-B', '-c', `import sys
namespace={'__name__':'fixture'}
exec(sys.stdin.read(),namespace)
assert callable(namespace['remove_owned_tree'])
assert callable(namespace['clean'])
`], {input:remoteSource(),encoding:'utf8'});
assert.equal(embedded.status,0,embedded.stdout+embedded.stderr);
const cleanNames = ['session.ts', 'employee-auth.test.ts', 'fixture-token.mjs',
  'snapshot-key.mjs', 'private-key.ts', '.npmrc'];
for (const name of cleanNames) assert.equal(safeSourcePath(name), true, name);
for (const name of ['.env', 'nested/.envrc', '.git/config', 'id_rsa', 'nested/id_ed25519.pub',
  'foo.p12', 'private-key.txt', 'Fixture.keychain-db', 'app.local.plist', 'nested/.docker/config.json',
  '../safe.cc', '/safe.cc', 'C:/safe.cc', 'safe\x7f.cc']) assert.equal(safeSourcePath(name), false, name);
const marker = '-----BEGIN ' + 'OPENSSH PRIVATE' + ' KEY-----';
for (const name of cleanNames) {
  checkSourceContent(name, Buffer.from('// Fixture source\n'));
  assert.throws(() => checkSourceContent(name, Buffer.from(marker)), {
    message: 'mini2 source content refused: ' + JSON.stringify(name) + ' (private-key-block)',
  });
}
for (const [rule, content] of [
  ['npm-credential', '  _auth' + 'Token=fake-credential'],
  ['npm-credential', '//registry.invalid/:_pass' + 'word=fake-credential'],
  ['aws-access-key-id', 'AK' + 'IA' + '0'.repeat(16)],
  ['slack-token', 'xo' + 'xb-fake-fixture'],
  ['github-token', 'gh' + 'p_' + '0'.repeat(30)],
  ['credential-assignment', 'pass' + 'word="' + '0'.repeat(12) + '"'],
]) assert.throws(() => checkSourceContent('source.ts', Buffer.from(content)), {
  message: 'mini2 source content refused: "source.ts" (' + rule + ')',
});
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
  const runnerArgs=['--repo',scratch,'--allowlist',path.join(scratch,'allow.json'),'--project','fixture','--task','fixture','--by','fixture','--out',path.join(scratch,'out')];
  assert.equal(args([...runnerArgs,'--claim-timeout','1','--','true']).claimTimeout,'1');
  assert.throws(()=>args([...runnerArgs,'--claim-timeout','-1','--','true']));
  checkWorktree(scratch,['safe.cc','deleted.cc']);
  fs.symlinkSync('safe.cc',path.join(scratch,'changed.cc'));
  assert.throws(()=>checkWorktree(scratch,['changed.cc']));
  fs.mkdirSync(path.join(scratch,'directory.cc'));
  assert.throws(()=>checkWorktree(scratch,['directory.cc']));
} finally { fs.rmSync(scratch,{recursive:true,force:true}); }
const transfer = fs.mkdtempSync(path.join(os.tmpdir(), 'mini2-transfer-'));
try {
  const repo = fs.realpathSync(fs.mkdirSync(path.join(transfer, 'fixture'), { recursive: true }));
  const env = { ...process.env, DEVBOX_CACHE_DIR: transfer };
  const savedCache = process.env.DEVBOX_CACHE_DIR;
  process.env.DEVBOX_CACHE_DIR = transfer;
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    for (const name of cleanNames) fs.writeFileSync(path.join(repo, name), name === '.npmrc'
      ? 'registry=https://registry.invalid/\n' : '// Fixture source\n');
    git('add', '--all');
    git('commit', '-qm', 'clean source');
    const state = { cancel: 0, children: new Set(), values: [] };
    const temp = fs.mkdtempSync(path.join(transfer, 'snapshot-'));
    const source = await snapshot({ repo, ref: 'HEAD' }, temp, state);
    const bundle = await makeBundle(source, [], state);
    const verify = (commit, file, patchFile) => checkUploads({
      allowed: cleanNames, bundle: file, patchFile, commit,
      temp: fs.mkdtempSync(path.join(transfer, 'verify-')), execute, state,
    });
    await verify(source.commit, bundle);

    // Scan the saved patch, even if the current source was cleaned afterward.
    const target = path.join(repo, 'session.ts');
    fs.writeFileSync(target, '\0' + marker + '\n');
    const patchFile = path.join(transfer, 'worktree.patch');
    fs.writeFileSync(patchFile, git('diff', '--binary', 'HEAD'));
    git('add', '--all');
    git('commit', '-qm', 'fixture with marker');
    git('revert', '--no-edit', 'HEAD');
    await assert.rejects(verify(source.commit, bundle, patchFile), {
      message: 'mini2 source content refused: "session.ts" (private-key-block)',
    });

    // Make the fixture bundle directly so the earlier devbox gate cannot
    // reject it before this scenario exercises the mini2 upload check.
    const historicalBundle = path.join(transfer, 'history.bundle');
    git('branch', 'export');
    git('bundle', 'create', historicalBundle, 'refs/heads/export');
    await assert.rejects(verify(git('rev-parse', 'HEAD').toString().trim(), historicalBundle), {
      message: 'mini2 source content refused: "session.ts" (private-key-block)',
    });
  } finally {
    if (savedCache === undefined) delete process.env.DEVBOX_CACHE_DIR;
    else process.env.DEVBOX_CACHE_DIR = savedCache;
  }
} finally { fs.rmSync(transfer, { recursive: true, force: true }); }

for(const file of ['test_bytecode.py','test_mini2_link.py','test_mini2_control.py','test_mini2_remote.py','test_local_control.py','test_dynamic_fix.py','test_host_samples.py','test_placement.py']) {
  const result=spawnSync('python3',['-B','scripts/res/test/'+file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
}
const shapes=spawnSync('node',['scripts/res/test/output-shapes.mjs'],{encoding:'utf8'});
assert.equal(shapes.status,0,shapes.stdout+shapes.stderr);
console.log('PASS mini2 transport, admission, alarm, identity and cleanup contracts');
