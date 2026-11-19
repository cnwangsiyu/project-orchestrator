#!/usr/bin/env node
// Real filesystem fixtures exercise only runner-owned temporary .data trees.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runDataCleanupPython } from '../devbox-run.mjs';
import { retentionPython } from '../lib/devbox-retention.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-run-data-'));
let count = 0;
function fixture() {
  const root = path.join(temp, 'case-' + ++count, 'devbox-run');
  const workspace = path.join(root, 'wt', 'fixture', 'id-123456', 'devbox-cn-1');
  const control = path.join(root, 'runs', randomUUID()), data = path.join(workspace, '.data');
  for (const dir of [control, data, path.join(workspace, 'build'), path.join(workspace, 'node_modules'), path.join(root, 'shared')]) fs.mkdirSync(dir, { recursive: true });
  const write = (name, text = 'data') => { const file = path.join(data, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  return { root, workspace, control, data, write, args: { root, workspace, control, slot: 'devbox-cn-1', runId: randomUUID(), env: {} } };
}
function invoke(f, setup = '', overrides = {}) {
  const code = 'import os,sys,json,pathlib,time\n' + retentionPython + runDataCleanupPython + '\n' + setup + '\nd=json.loads(sys.stdin.read())\nprint(json.dumps(cleanup_run_data(d)))\n';
  const result = spawnSync('python3', ['-c', code], { input: JSON.stringify({ ...f.args, ...overrides }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function retain(f, name, expired = false, archive = false) {
  const run = randomUUID(), control = path.join(f.root, 'runs', run);
  fs.mkdirSync(control);
  const receipt = { run, slot: f.args.slot, workspace: f.workspace, createdAt: Date.now() / 1000 - 100, expiresAt: Date.now() / 1000 + (expired ? -1 : 3600), artifacts: [{ name: '.data/' + name + '/result.log', size: 4, sha256: 'a'.repeat(64) }] };
  if (archive) { fs.writeFileSync(path.join(control, 'artifact-retention.json'), JSON.stringify(receipt)); fs.writeFileSync(path.join(control, 'artifact-archive.tar'), 'data'); }
  else fs.writeFileSync(path.join(control, 'artifact-manifest.json'), JSON.stringify(receipt));
  return control;
}

try {
  const f = fixture();
  f.write('stale/a', '123'); f.write('stale/nested/b', '4567');
  f.write('run-' + f.args.runId + '/current', 'current');
  f.write('wrapper/' + path.basename(f.control) + '/current', 'current');
  f.write('retained/result.log'); retain(f, 'retained');
  f.write('expired/result.log', '12'); retain(f, 'expired', true);
  f.write('input/result.log'); f.args.dataInputPaths = [path.join(f.data, 'input/result.log')];
  f.write('overlay/result.log'); f.args.untracked = ['.data/overlay/result.log'];
  const outside = path.join(f.workspace, 'build', 'outside'); fs.writeFileSync(outside, 'outside');
  fs.writeFileSync(path.join(f.workspace, 'node_modules', 'keep'), 'cache');
  fs.writeFileSync(path.join(f.root, 'shared', 'keep'), 'shared');
  fs.symlinkSync(outside, path.join(f.data, 'escape'));
  f.write('nested-escape/a'); fs.symlinkSync(outside, path.join(f.data, 'nested-escape/link'));
  f.write('private/.env', '');
  fs.symlinkSync(path.join(f.data, 'run-' + f.args.runId + '/current'), path.join(f.data, 'inside-link'));
  const result = invoke(f);
  assert.deepEqual(result.entries.map(entry => entry.name).sort(), ['expired', 'inside-link', 'stale']);
  assert.equal(result.bytes, 9);
  for (const name of ['retained', 'input', 'overlay', 'private', 'escape', 'nested-escape', 'run-' + f.args.runId, 'wrapper']) assert.ok(fs.existsSync(path.join(f.data, name)), name + ' preserved');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'node_modules', 'keep'), 'utf8'), 'cache');
  assert.equal(fs.readFileSync(path.join(f.root, 'shared', 'keep'), 'utf8'), 'shared');
  assert.ok(result.warnings.some(warning => warning.includes('symlink escape')));
  assert.ok(result.warnings.some(warning => warning.includes('private/cache')));
  console.log('PASS stale entries/bytes, current runs, retained/expired records, inputs, internal links, escaping links and scope boundaries');

  const live = fixture(); live.write('recent/out'); const old = live.write('old/out');
  const ancient = new Date(Date.now() - 3600000); fs.utimesSync(old, ancient, ancient); fs.utimesSync(path.dirname(old), ancient, ancient);
  const kept = invoke(live, 'data_group_live=lambda *args: True');
  assert.deepEqual(kept.entries.map(entry => entry.name), ['old']); assert.ok(fs.existsSync(path.join(live.data, 'recent')));
  const gone = invoke(live, 'data_group_live=lambda *args: False');
  assert.deepEqual(gone.entries.map(entry => entry.name), ['recent']);
  console.log('PASS recent data protection requires a live group; old data is removed');

  const fault = fixture(); fault.write('blocked'); fault.write('removed/out', '123');
  const failed = invoke(fault, "original=os.unlink\ndef fail(name,*args,**kwargs):\n    if name=='blocked' and kwargs.get('dir_fd') is not None: raise PermissionError('fixture cleanup failure')\n    return original(name,*args,**kwargs)\nos.unlink=fail");
  assert.ok(failed.warnings.some(warning => warning.includes('fixture cleanup failure')));
  assert.deepEqual(failed.entries.map(entry => entry.name), ['removed']); assert.equal(failed.bytes, 3);
  assert.ok(fs.existsSync(path.join(fault.data, 'blocked')));
  assert.equal(invoke(fault, '', { env: { DEVBOX_KEEP_RUN_DATA: '1' } }).skipped, 'DEVBOX_KEEP_RUN_DATA=1');
  assert.ok(fs.existsSync(path.join(fault.data, 'blocked')));
  console.log('PASS cleanup failures warn without throwing and project opt-out preserves data');

  const tracked = fixture(); tracked.write('source/file.txt'); tracked.write('output/out');
  for (const args of [['init', '-q'], ['add', '.data/source/file.txt']]) {
    const git = spawnSync('git', ['-C', tracked.workspace, ...args], { encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr);
  }
  assert.deepEqual(invoke(tracked).entries.map(entry => entry.name), ['output']);
  assert.ok(fs.existsSync(path.join(tracked.data, 'source/file.txt')));
  console.log('PASS tracked source files are protected while rebuildable output is removed');

  const grouped = fixture(), proc = path.join(temp, 'fake-proc'); fs.mkdirSync(path.join(proc, '1234'), { recursive: true });
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[2] = '1234'; fields[19] = '42';
  fs.writeFileSync(path.join(proc, '1234/stat'), '1234 (fixture) ' + fields.join(' '));
  fs.symlinkSync(grouped.workspace, path.join(proc, '1234/cwd'));
  fs.writeFileSync(path.join(grouped.control, 'group.json'), JSON.stringify({ run: path.basename(grouped.control), pid: 1234, start: '42' }));
  invoke(grouped, `assert data_group_live(pathlib.Path(${JSON.stringify(grouped.root)}),pathlib.Path(${JSON.stringify(grouped.workspace)}),pathlib.Path(${JSON.stringify(proc)}))`);
  fields[19] = '99'; fs.writeFileSync(path.join(proc, '1234/stat'), '1234 (fixture) ' + fields.join(' '));
  invoke(grouped, `assert not data_group_live(pathlib.Path(${JSON.stringify(grouped.root)}),pathlib.Path(${JSON.stringify(grouped.workspace)}),pathlib.Path(${JSON.stringify(proc)}))`);
  console.log('PASS live group attribution uses recorded start identity, group membership and workspace cwd');

  const escaped = fixture(), other = path.join(temp, 'other-data'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'keep'), 'outside');
  fs.rmdirSync(escaped.data); fs.symlinkSync(other, escaped.data);
  assert.ok(invoke(escaped).warnings.some(warning => warning.includes('directory symlink')));
  assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'outside');
  const wrong = fixture(); wrong.write('keep');
  assert.ok(invoke(wrong, '', { workspace: path.dirname(wrong.workspace) }).warnings.some(warning => warning.includes('outside slot scope')));
  assert.ok(fs.existsSync(path.join(wrong.data, 'keep')));
  const legacy = fixture(); legacy.write('keep/result.log'); retain(legacy, 'keep', false, true);
  assert.equal(invoke(legacy).skipped, 'unexpired legacy retained archive');
  assert.ok(fs.existsSync(path.join(legacy.data, 'keep')));
  console.log('PASS data-root symlink and invalid workspace refusal; legacy retained archives stay protected');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
