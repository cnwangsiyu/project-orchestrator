#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runTmpdirPython } from '../lib/devbox-tmpdir.mjs';
import { remoteScripts } from '../devbox-run.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-tmpdir-test-'));
const owned = [];
const invoke = (body, args = {}) => spawnSync('python3', ['-c', 'import os,json,pathlib,sys\n'+runTmpdirPython+'\nd=json.loads(sys.argv[1])\n'+body, JSON.stringify(args)], { encoding: 'utf8' });
function fixture() {
  const control = fs.mkdtempSync(path.join(scratch, 'run-'));
  const result = invoke('print(create_run_tmpdir(pathlib.Path(d["control"])))', { control });
  assert.equal(result.status, 0, result.stderr);
  const directory = result.stdout.trim(); owned.push(directory);
  return { control, directory };
}
const cleanup = f => invoke('cleanup_run_tmpdir(pathlib.Path(d["control"]))', f);
function readOnlyTree(directory, outside, mode = 0o500) {
  const nested = path.join(directory, 'nested'); fs.mkdirSync(nested);
  const inner = path.join(nested, 'input'); fs.mkdirSync(inner);
  const file = path.join(inner, 'input.mp4'); fs.writeFileSync(file, 'fixture');
  fs.symlinkSync(outside, path.join(inner, 'outside'));
  if (fs.statSync(outside).dev === fs.statSync(directory).dev) {
    fs.linkSync(path.join(outside, 'keep'), path.join(inner, 'linked-file'));
  }
  fs.chmodSync(file, 0o400); fs.chmodSync(inner, mode); fs.chmodSync(nested, mode);
  fs.chmodSync(directory, mode);
}
function restoreFixtureDirectories(directory) {
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory()) return;
  fs.chmodSync(directory, 0o700);
  for (const name of fs.readdirSync(directory)) restoreFixtureDirectories(path.join(directory, name));
}
try {
  const suffix = '/.org.chromium.Chromium.XXXXXX/SingletonSocket';
  const boundary = '/'+'a'.repeat(107-Buffer.byteLength(suffix)-1);
  const pass = invoke('print(chromium_socket_bytes(d["tmpdir"]))', { tmpdir: boundary });
  assert.equal(pass.status, 0, pass.stderr); assert.equal(pass.stdout.trim(), '107');
  const fail = invoke('chromium_socket_bytes(d["tmpdir"])', { tmpdir: boundary+'a' });
  assert.notEqual(fail.status, 0); assert.match(fail.stderr, /108 bytes; maximum is 107 bytes/);
  const unicode = invoke('chromium_socket_bytes(d["tmpdir"])', { tmpdir: boundary.slice(0,-1)+'é' });
  assert.notEqual(unicode.status, 0); assert.match(unicode.stderr, /108 bytes/);
  console.log('PASS Chromium singleton socket boundary is 107 bytes, including encoded Unicode length');

  const f = fixture(), other = fixture();
  assert.match(f.directory, /^\/tmp\/dr-[a-z0-9_]{8}$/);
  assert.notEqual(f.directory, other.directory);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  const outside = path.join(scratch, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  fs.mkdirSync(path.join(f.directory, 'nested')); fs.writeFileSync(path.join(f.directory, 'nested/output'), 'output');
  fs.symlinkSync(outside, path.join(f.directory, 'link'));
  assert.equal(cleanup(f).status, 0);
  assert.ok(!fs.existsSync(f.directory)); assert.ok(fs.existsSync(other.directory));
  assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'), 'keep');
  assert.equal(cleanup(f).status, 0, 'cleanup is idempotent');
  console.log('PASS unique short 0700 TMPDIR, nested cleanup, unrelated directory preservation and no following internal symlinks');

  fs.chmodSync(path.join(outside, 'keep'), 0o400); fs.chmodSync(outside, 0o500);
  for (const mode of [0o500, 0o000]) {
    const readOnly = fixture(); readOnlyTree(readOnly.directory, outside, mode);
    const result = cleanup(readOnly);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(readOnly.directory));
    assert.equal(fs.statSync(outside).mode & 0o777, 0o500);
    assert.equal(fs.statSync(path.join(outside, 'keep')).mode & 0o777, 0o400);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
    assert.equal(cleanup(readOnly).status, 0, 'read-only cleanup is idempotent');
  }
  console.log('PASS read-only and inaccessible owned trees removed without changing outside symlink targets');

  for (const kind of ['root', 'directory', 'file', 'symlink']) {
    const foreign = fixture(); readOnlyTree(foreign.directory, outside);
    const target = kind === 'root' ? path.basename(foreign.directory)
      : kind === 'directory' ? 'input' : kind === 'file' ? 'input.mp4' : 'outside';
    const result = invoke(`from unittest.mock import patch
real_stat=os.stat
def foreign_stat(name,*args,**kwargs):
    info=real_stat(name,*args,**kwargs)
    if os.fspath(name)==d['target']:
        fields=list(info); fields[4]=os.geteuid()+1; return os.stat_result(fields)
    return info
with patch.object(os,'stat',side_effect=foreign_stat):
    cleanup_run_tmpdir(pathlib.Path(d['control']))`, {...foreign, target});
    assert.notEqual(result.status, 0); assert.match(result.stderr, /owner mismatch/);
    const retained = kind === 'root' ? foreign.directory : path.join(foreign.directory, 'nested/input', target === 'input' ? '' : target);
    assert.ok(fs.lstatSync(retained));
    if (kind === 'root' || kind === 'directory') assert.equal(fs.statSync(retained).mode & 0o777, 0o500);
    if (kind === 'file') assert.equal(fs.statSync(retained).mode & 0o777, 0o400);
  }
  console.log('PASS foreign-owned roots, directories, files and symlinks refused before modifying those entries');

  const changed = fixture(); readOnlyTree(changed.directory, outside);
  const changedResult = invoke(`from unittest.mock import patch
real_open=os.open
def replaced_open(name,flags,*args,**kwargs):
    if name=='input':
        parent=kwargs['dir_fd']
        os.rename('input','original',src_dir_fd=parent,dst_dir_fd=parent)
        os.mkdir('input',0o500,dir_fd=parent)
    return real_open(name,flags,*args,**kwargs)
with patch.object(os,'open',side_effect=replaced_open):
    cleanup_run_tmpdir(pathlib.Path(d['control']))`, changed);
  assert.notEqual(changedResult.status, 0); assert.match(changedResult.stderr, /directory identity changed/);
  assert.equal(fs.statSync(path.join(changed.directory, 'nested/input')).mode & 0o777, 0o500);
  console.log('PASS changed nested inode refused before chmod of its replacement');

  const link = fixture(); fs.rmdirSync(link.directory); fs.symlinkSync(outside, link.directory);
  const refused = cleanup(link); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /symlink or non-directory refused/);
  assert.ok(fs.lstatSync(link.directory).isSymbolicLink()); assert.ok(fs.existsSync(path.join(outside,'keep')));
  const replaced = fixture(); fs.renameSync(replaced.directory, path.join(scratch, 'original')); fs.mkdirSync(replaced.directory);
  assert.notEqual(cleanup(replaced).status, 0); assert.ok(fs.existsSync(replaced.directory));
  const mismatch = fixture(), receiptFile = path.join(mismatch.control,'tmpdir.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile)); receipt.run = 'other-run'; fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.notEqual(cleanup(mismatch).status, 0); assert.ok(fs.existsSync(mismatch.directory));
  receipt.run = path.basename(mismatch.control); receipt.path = outside; fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.notEqual(cleanup(mismatch).status, 0); assert.ok(fs.existsSync(path.join(outside,'keep')));
  console.log('PASS top-level symlink, replaced inode, mismatched run and out-of-scope receipt refusal');

  // Execute the actual supervisor's pre-launch assignments and shell exports.
  const control = fs.mkdtempSync(path.join(scratch, 'shell-run-'));
  const rendered = spawnSync('python3', ['-c', `import ast,json,pathlib,sys,os,shlex
d=json.loads(sys.argv[1]); ctl=pathlib.Path(d['control'])
tree=ast.parse(sys.stdin.read())
helper=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef))]
exec(compile(ast.Module(body=helper,type_ignores=[]),'helpers','exec'))
launch=next(n for n in tree.body if isinstance(n,ast.Try) and any(isinstance(x,ast.Expr) and isinstance(x.value,ast.Call) and isinstance(x.value.func,ast.Name) and x.value.func.id=='stop_group' for x in n.finalbody))
assignments=[]
for n in launch.body[0].orelse:
    if isinstance(n,ast.Assign) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Attribute) and n.value.func.attr=='Popen': break
    if isinstance(n,ast.Assign): assignments.append(n)
exec(compile(ast.Module(body=assignments,type_ignores=[]),'launch','exec'))
print(json.dumps({'shell':shell,'tmpdir':d['env']['TMPDIR']}))`, JSON.stringify({control, env:{TMPDIR:'/long/explicit/path'},command:'printf "%s" "$TMPDIR"'})], { input:remoteScripts.run,encoding:'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const shell = JSON.parse(rendered.stdout); owned.push(shell.tmpdir);
  const home = path.join(scratch, 'bootstrap'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'devbox-env.sh'), 'export TMPDIR=/long/bootstrap/path\n');
  const result = spawnSync('/bin/bash', ['-c', shell.shell.replaceAll('$HOME', home)], { encoding:'utf8', env:{...process.env,TMPDIR:'/long/ambient/path'} });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, shell.tmpdir);
  readOnlyTree(shell.tmpdir, outside);
  const independent = spawnSync('python3',['-c',remoteScripts.cleanup,Buffer.from(JSON.stringify({control})).toString('base64')],{encoding:'utf8'});
  assert.equal(independent.status, 0, independent.stderr); assert.match(independent.stdout,/group-gone/);
  assert.ok(!fs.existsSync(shell.tmpdir));
  console.log('PASS actual supervisor exports owned TMPDIR after bootstrap and independent cleanup removes it');

  const normal = fixture(); readOnlyTree(normal.directory, outside);
  const normalExit = spawnSync('python3', ['-B', '-c', `import ast,json,pathlib,sys,os
d=json.loads(sys.argv[1]); ctl=pathlib.Path(d['control']); run_id=ctl.name
tree=ast.parse(sys.stdin.read())
helpers=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef))]
exec(compile(ast.Module(body=helpers,type_ignores=[]),'helpers','exec'))
launch=next(n for n in tree.body if isinstance(n,ast.Try) and any(isinstance(x,ast.Expr) and isinstance(x.value,ast.Call) and isinstance(x.value.func,ast.Name) and x.value.func.id=='stop_group' for x in n.finalbody))
proc=None; result=0; command_start=None
adopted=lambda: []; reap=lambda: None
exec(compile(ast.Module(body=launch.finalbody,type_ignores=[]),'supervisor-finally','exec'))
assert json.loads((ctl/'done.json').read_text())['exit']==0
`, JSON.stringify(normal)], {input:remoteScripts.run,encoding:'utf8'});
  assert.equal(normalExit.status, 0, normalExit.stderr);
  assert.ok(!fs.existsSync(normal.directory));
  console.log('PASS production supervisor final cleanup preserves successful exit for a read-only TMPDIR');

  const recovery = fixture();
  readOnlyTree(recovery.directory, outside);
  fs.writeFileSync(path.join(recovery.control,'done.json'),JSON.stringify({run:path.basename(recovery.control),gone:true,exit:0}));
  const reconnected = spawnSync('python3',['-c',remoteScripts.reconnect,Buffer.from(JSON.stringify(recovery)).toString('base64')],{encoding:'utf8'});
  assert.equal(reconnected.status, 0, reconnected.stderr); assert.match(reconnected.stdout,/group-gone/);
  assert.ok(!fs.existsSync(recovery.directory));
  const interrupted = fixture(); readOnlyTree(interrupted.directory, outside);
  fs.writeFileSync(path.join(interrupted.control,'group.json'),JSON.stringify({run:path.basename(interrupted.control),pid:2147483647,start:'1'}));
  fs.writeFileSync(path.join(interrupted.control,'owner.json'),JSON.stringify({run:path.basename(interrupted.control),pid:2147483647,start:'1'}));
  const recovered = spawnSync('python3',['-B','-c',remoteScripts.reconnect,Buffer.from(JSON.stringify(interrupted)).toString('base64')],{encoding:'utf8'});
  assert.equal(recovered.status, 0, recovered.stderr); assert.match(recovered.stdout,/group-gone/);
  assert.ok(!fs.existsSync(interrupted.directory));
  assert.equal(fs.statSync(outside).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.join(outside, 'keep')).mode & 0o777, 0o400);
  const rejected = spawnSync('python3',['-c',remoteScripts.cleanup,Buffer.from(JSON.stringify(link)).toString('base64')],{encoding:'utf8'});
  assert.notEqual(rejected.status, 0); assert.doesNotMatch(rejected.stdout,/group-gone/);
  assert.ok(fs.existsSync(path.join(outside,'keep')));
  console.log('PASS reconnect recovers the owned TMPDIR and cleanup refuses symlink replacement before confirming completion');
} finally {
  for (const directory of owned) {
    restoreFixtureDirectories(directory);
    fs.rmSync(directory, { recursive:true, force:true });
  }
  restoreFixtureDirectories(scratch);
  fs.rmSync(scratch, { recursive:true, force:true });
}
