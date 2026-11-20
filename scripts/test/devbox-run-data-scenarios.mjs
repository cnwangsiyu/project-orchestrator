#!/usr/bin/env node
// Real filesystem fixtures exercise only runner-owned temporary .data trees.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execute, runDataCleanupPython } from '../devbox-run.mjs';
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
function invoke(f, setup = '', overrides = {}, { docker = false, warning } = {}) {
  const proc = path.join(f.root, 'fixture-proc'); fs.mkdirSync(proc, { recursive: true });
  const dockerSetup = docker ? '' : 'docker_workspace_live=lambda workspace: False';
  const code = 'import os,sys,json,pathlib,time\n' + retentionPython + runDataCleanupPython + '\nos.geteuid=lambda: 1000\n' + dockerSetup + '\n' + setup + '\nd=json.loads(sys.stdin.read())\nprint_data_cleanup(cleanup_run_data(d,pathlib.Path(' + JSON.stringify(proc) + ')))\n';
  const result = spawnSync('python3', ['-c', code], { input: JSON.stringify({ ...f.args, ...overrides }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  if (warning) assert.match(result.stdout, warning);
  return JSON.parse(result.stdout.split('\n')[0].slice('DEVBOX_DATA_CLEANUP='.length));
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
  assert.deepEqual(kept.entries, []); assert.equal(kept.bytes, 0); assert.ok(fs.existsSync(path.join(live.data, 'old'))); assert.ok(fs.existsSync(path.join(live.data, 'recent')));
  const gone = invoke(live, 'data_group_live=lambda *args: False');
  assert.deepEqual(gone.entries.map(entry => entry.name), ['old', 'recent']);
  console.log('PASS live ownership protects all workspace data; confirmed idle output can be removed');

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
  fs.mkdirSync(path.join(proc, '1234/fd'));
  fs.writeFileSync(path.join(grouped.control, 'group.json'), JSON.stringify({ run: path.basename(grouped.control), workspace: grouped.workspace, pid: 1234, start: '42' }));
  invoke(grouped, `assert data_group_live(pathlib.Path(${JSON.stringify(grouped.root)}),pathlib.Path(${JSON.stringify(grouped.workspace)}),pathlib.Path(${JSON.stringify(proc)}))`);
  fields[19] = '99'; fs.writeFileSync(path.join(proc, '1234/stat'), '1234 (fixture) ' + fields.join(' '));
  fs.unlinkSync(path.join(proc, '1234/cwd')); fs.symlinkSync(temp, path.join(proc, '1234/cwd'));
  invoke(grouped, `assert not data_group_live(pathlib.Path(${JSON.stringify(grouped.root)}),pathlib.Path(${JSON.stringify(grouped.workspace)}),pathlib.Path(${JSON.stringify(proc)}))`);
  console.log('PASS live group attribution uses recorded start identity, group membership and workspace cwd');

  function groupFixture() {
    const f = fixture(), proc = path.join(f.root, 'fixture-proc'); fs.mkdirSync(proc, { recursive: true });
    f.write('stale/out', 'old');
    const old = new Date(Date.now() - 3600000);
    for (const file of [path.join(f.data, 'stale/out'), path.join(f.data, 'stale')]) fs.utimesSync(file, old, old);
    const receipt = (record, run = randomUUID()) => {
      const ctl = path.join(f.root, 'runs', run); fs.mkdirSync(ctl, { recursive: true });
      const file = path.join(ctl, 'group.json');
      fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record)); return file;
    };
    const process = (pid, pgid, cwd, start = '42', uid = 1000, comm = 'fixture') => {
      const dir = path.join(proc, String(pid)); fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
      const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[2] = String(pgid); fields[19] = start;
      fs.writeFileSync(path.join(dir, 'status'), `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
      fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) ${fields.join(' ')}`);
      if (cwd) fs.symlinkSync(cwd, path.join(dir, 'cwd'));
    };
    const cleanup = () => invoke(f);
    return { ...f, proc, receipt, process, cleanup };
  }
  const deadGroups = groupFixture();
  for (const [run, pid] of [
    ['251bfb79-4db4-4cc9-a026-db051f5a63fc', 185465], ['c216aa52-693f-4968-bd7f-6035b3badecb', 177841],
    ['29b232ff-790a-4797-834d-2a75180b4790', 103781], ['c7679be1-f23b-4b2d-96bf-2adfd7fa26be', 185039],
  ]) deadGroups.receipt({ pid, start: 'dead' }, run);
  assert.equal(deadGroups.cleanup().bytes, 3);
  assert.equal(fs.readdirSync(path.join(deadGroups.root, 'runs')).filter(run => run !== path.basename(deadGroups.control)).length, 4);
  console.log('PASS BC-180 four dead legacy receipts permit cleanup without modifying receipts');

  const legacyLive = groupFixture(); legacyLive.receipt({ pid: 1234, start: '42' });
  legacyLive.process(1234, 1234, legacyLive.workspace);
  const protectedLegacy = legacyLive.cleanup();
  assert.equal(protectedLegacy.bytes, 0); assert.match(protectedLegacy.warnings.join(' '), /protects workspace/);
  fs.unlinkSync(path.join(legacyLive.proc, '1234/cwd')); fs.symlinkSync(temp, path.join(legacyLive.proc, '1234/cwd'));
  assert.equal(legacyLive.cleanup().bytes, 3, 'live legacy group of another workspace does not block');

  const orphan = groupFixture(); orphan.receipt({ pid: 1234, start: '42' });
  orphan.process(5678, 1234, orphan.workspace);
  assert.equal(orphan.cleanup().bytes, 0, 'surviving group members protect data after leader exit');
  const ambiguous = groupFixture(); ambiguous.receipt({ pid: 1234, start: '42' }); ambiguous.process(1234, 1234);
  assert.match(ambiguous.cleanup().warnings.join(' '), /unattributed process evidence unreadable/);
  const malformed = groupFixture(); malformed.receipt('{broken'); malformed.process(1234, 1234, malformed.workspace);
  assert.equal(malformed.cleanup().bytes, 0);
  fs.unlinkSync(path.join(malformed.proc, '1234/cwd')); fs.symlinkSync(temp, path.join(malformed.proc, '1234/cwd'));
  assert.equal(malformed.cleanup().bytes, 3, 'malformed receipt is attributed by cwd rather than aborting the host');
  const malformedStat = groupFixture(); malformedStat.receipt({ pid: 1234, start: '42', workspace: temp }); malformedStat.process(1234, 1234, temp);
  fs.writeFileSync(path.join(malformedStat.proc, '1234/stat'), 'invalid stat');
  assert.equal(malformedStat.cleanup().bytes, 3, 'malformed process identity still checks workspace attribution');
  const malformedStatOwned = groupFixture(); malformedStatOwned.receipt({ pid: 1234, start: '42' }); malformedStatOwned.process(1234, 1234, malformedStatOwned.workspace);
  fs.writeFileSync(path.join(malformedStatOwned.proc, '1234/stat'), 'invalid stat');
  assert.equal(malformedStatOwned.cleanup().bytes, 0, 'ambiguous process identity with this cwd protects workspace');
  const conflicting = groupFixture(); conflicting.receipt({ run: 'invalid', pid: 1234, start: '42', workspace: temp });
  conflicting.process(1234, 1234, conflicting.workspace);
  assert.equal(conflicting.cleanup().bytes, 0, 'invalid receipt cannot exclude this workspace using conflicting metadata');
  const unrelated = groupFixture(); unrelated.receipt({ run: 'invalid', pid: 1234, start: '42', workspace: temp });
  unrelated.process(1234, 1234, temp);
  assert.equal(unrelated.cleanup().bytes, 3, 'invalid receipt with unrelated process cwd does not block');
  const broken = groupFixture(), brokenReceipt = broken.receipt({});
  fs.unlinkSync(brokenReceipt); fs.symlinkSync(path.join(temp, 'missing-receipt'), brokenReceipt);
  broken.process(1234, 1234, broken.workspace);
  assert.equal(broken.cleanup().bytes, 0, 'broken receipt symlink still attributes possible live ownership without following the link');
  console.log('PASS live legacy, surviving members and ambiguous/malformed ownership protect only possibly owned workspace');

  for (const same of [false, true]) {
    const modern = groupFixture(), run = randomUUID();
    modern.receipt({ run, pid: 1234, start: '42', workspace: same ? modern.workspace : temp }, run);
    modern.process(1234, 1234, same ? modern.workspace : temp);
    modern.write('recent/out', 'new');
    const result = modern.cleanup();
    assert.equal(result.bytes, same ? 0 : 6);
    if (same) assert.match(result.warnings.join(' '), /protects workspace/); else assert.deepEqual(result.warnings, []);
    assert.equal(fs.existsSync(path.join(modern.data, 'recent')), same);
  }
  console.log('PASS live modern receipts protect the same workspace without blocking other workspaces');

  // Reviewer reproductions: receipt exclusions can never erase observed users.
  for (const start of ['broken', '41', undefined]) {
    const f = groupFixture(); f.write('recent/out', 'live-output');
    f.receipt({ pid: 1234, ...(start === undefined ? {} : { start }) });
    f.process(1234, 1234, f.workspace, '42');
    const result = f.cleanup();
    assert.equal(result.bytes, 0); assert.deepEqual(result.entries, []); assert.ok(result.warnings.length);
    assert.equal(fs.readFileSync(path.join(f.data, 'recent/out'), 'utf8'), 'live-output');
  }
  for (const corrupt of [{ start: '41' }, { start: 'broken' }, { pid: 9999 }, { workspace: temp }]) {
    const f = groupFixture(), run = randomUUID(); f.write('recent/out', 'live-output');
    f.receipt({ run, pid: 1234, start: '42', workspace: f.workspace, ...corrupt }, run);
    f.process(1234, 1234, f.workspace);
    if (corrupt.pid === 9999) f.process(9999, 9999, temp);
    assert.equal(f.cleanup().bytes, 0);
    assert.ok(fs.existsSync(path.join(f.data, 'recent/out')));
  }
  const unpublished = groupFixture(); unpublished.write('recent/out', 'live-output');
  unpublished.process(1234, 1234, unpublished.workspace);
  assert.equal(unpublished.cleanup().bytes, 0, 'workspace cwd blocks deletion with no group receipt');
  const openFiles = groupFixture(); openFiles.write('recent/out', 'live-output'); openFiles.process(1234, 1234, temp);
  fs.symlinkSync(path.join(openFiles.data, 'recent/out'), path.join(openFiles.proc, '1234/fd/3'));
  assert.equal(openFiles.cleanup().bytes, 0, 'workspace open fd blocks deletion with no group receipt and cwd elsewhere');
  const deletedFd = groupFixture(); deletedFd.process(1234, 1234, temp);
  fs.symlinkSync(path.join(deletedFd.data, 'old-output') + ' (deleted)', path.join(deletedFd.proc, '1234/fd/3'));
  assert.equal(deletedFd.cleanup().bytes, 0, 'deleted but open workspace fd remains protective');
  const reused = groupFixture(); reused.write('recent/out', 'new');
  reused.receipt({ pid: 1234, start: '41' }); reused.process(1234, 1234, temp, '42');
  assert.equal(reused.cleanup().bytes, 6, 'valid differing start with unrelated cwd/fds is not blocking');
  const reusedModern = groupFixture(), reusedRun = randomUUID(); reusedModern.write('recent/out', 'new');
  reusedModern.receipt({ run: reusedRun, pid: 1234, start: '41', workspace: reusedModern.workspace }, reusedRun);
  reusedModern.process(1234, 1234, temp, '42');
  assert.equal(reusedModern.cleanup().bytes, 6, 'stale modern receipt cannot block an unrelated reused PID');
  const recordedRun = groupFixture();
  const runDir = path.join(recordedRun.data, 'active-run'); fs.mkdirSync(runDir);
  recordedRun.receipt({ pid: 1234, start: '42', workspace: runDir }); recordedRun.process(1234, 1234, temp);
  assert.equal(recordedRun.cleanup().bytes, 0, 'live recorded run directory below workspace adds protection');
  for (const start of ['42', 'broken', undefined]) {
    const f = groupFixture(), run = randomUUID(), runDir = path.join(f.data, 'active-run'); fs.mkdirSync(runDir);
    f.receipt({ run, pid: 1234, ...(start === undefined ? {} : { start }), workspace: runDir }, run);
    f.process(1234, 5678, temp, '42');
    assert.equal(f.cleanup().bytes, 0, 'recorded directory adds protection before non-leader/group filtering');
  }
  console.log('PASS reviewer start broken/41/missing, modern corrupt fields, unpublished receipts, cwd/open/deleted fds and reused unrelated PID');

  const deniedInventory = groupFixture(); deniedInventory.process(1234, 1234, deniedInventory.workspace);
  const inventorySetup = `original_iterdir=pathlib.Path.iterdir\ndef inventory_denied(self):\n    if self==pathlib.Path(${JSON.stringify(deniedInventory.proc)}): raise PermissionError('fixture-sensitive-path')\n    return original_iterdir(self)\npathlib.Path.iterdir=inventory_denied`;
  const unreadable = invoke(deniedInventory, inventorySetup);
  assert.equal(unreadable.bytes, 0); assert.equal(unreadable.processProbe.inventoryErrors, 1);
  assert.match(unreadable.warnings.join(' '), /process inventory unreadable \(PermissionError\)/);
  assert.ok(!unreadable.warnings.join(' ').includes('fixture-sensitive-path'));

  const denyFds = (proc, pids) => `original_iterdir=pathlib.Path.iterdir\ndef fd_denied(self):\n    if self.name=='fd' and self.parent.name in ${JSON.stringify(pids.map(String))} and self.parent.parent==pathlib.Path(${JSON.stringify(proc)}): raise PermissionError('fixture-sensitive-path')\n    return original_iterdir(self)\npathlib.Path.iterdir=fd_denied`;
  const unrelatedFd = groupFixture(); unrelatedFd.process(1234, 1234, temp);
  const ignoredFd = invoke(unrelatedFd, denyFds(unrelatedFd.proc, [1234]));
  assert.equal(ignoredFd.bytes, 3); assert.deepEqual(ignoredFd.warnings, []);
  assert.equal(ignoredFd.processProbe.uncertaintyUnrelatedIgnored, 1);
  const unrelatedLink = groupFixture(), unrelatedRun = randomUUID(); unrelatedLink.process(1234, 1234, temp);
  unrelatedLink.receipt({ run: unrelatedRun, pid: 1234, start: '42', workspace: temp }, unrelatedRun);
  fs.symlinkSync(path.join(temp, 'outside-file'), path.join(unrelatedLink.proc, '1234/fd/3'));
  const linkSetup = `original_readlink=os.readlink\ndef link_denied(file,*a,**k):\n    if pathlib.Path(file)==pathlib.Path(${JSON.stringify(path.join(unrelatedLink.proc, '1234/fd/3'))}): raise PermissionError('fixture-sensitive-path')\n    return original_readlink(file,*a,**k)\nos.readlink=link_denied`;
  const ignoredLink = invoke(unrelatedLink, linkSetup);
  assert.equal(ignoredLink.bytes, 3); assert.deepEqual(ignoredLink.warnings, []); assert.equal(ignoredLink.processProbe.uncertaintyUnrelatedIgnored, 1);
  const scopedFd = groupFixture(), otherWorkspace = path.join(scopedFd.root, 'wt/fixture/id-123456/devbox-cn-2');
  fs.mkdirSync(otherWorkspace, { recursive: true }); scopedFd.process(1234, 1234, otherWorkspace);
  const elsewhere = invoke(scopedFd, denyFds(scopedFd.proc, [1234]));
  assert.equal(elsewhere.bytes, 3); assert.deepEqual(elsewhere.warnings, []); assert.equal(elsewhere.processProbe.uncertaintyElsewhere, 1);
  const scopedCwd = groupFixture(), cwdRun = randomUUID(), recordedOther = path.join(scopedCwd.root, 'wt/fixture/id-123456/devbox-cn-2');
  fs.mkdirSync(recordedOther, { recursive: true }); scopedCwd.process(1234, 1234);
  scopedCwd.receipt({ run: cwdRun, pid: 1234, start: '42', workspace: recordedOther }, cwdRun);
  const cwdElsewhere = scopedCwd.cleanup();
  assert.equal(cwdElsewhere.bytes, 3); assert.deepEqual(cwdElsewhere.warnings, []); assert.equal(cwdElsewhere.processProbe.uncertaintyElsewhere, 1);
  const ownedFd = groupFixture(); ownedFd.process(1234, 1234, ownedFd.workspace);
  const owned = invoke(ownedFd, denyFds(ownedFd.proc, [1234]));
  assert.equal(owned.bytes, 0); assert.equal(owned.processProbe.uncertaintyHere, 1);
  assert.match(owned.warnings.join(' '), /workspace process evidence unreadable/);
  const daemons = groupFixture();
  daemons.process(1234, 1234, null, '42', 0, 'systemd');
  daemons.process(1235, 1235, null, '42', 101, 'dbus-daemon');
  daemons.process(1236, 1236, null, '42', 1000, 'sshd');
  daemons.process(1237, 1237, daemons.workspace, '42', 101);
  const ignored = invoke(daemons, denyFds(daemons.proc, [1234, 1235, 1236]));
  assert.equal(ignored.bytes, 3); assert.deepEqual(ignored.warnings, []);
  assert.equal(ignored.processProbe.ignoredOtherUid, 3);
  assert.equal(ignored.processProbe.fdErrors, 1);
  assert.equal(ignored.processProbe.ignoredUnreadableOwn, 1);
  assert.deepEqual(ignored.processProbe.ignoredUnreadableOwnComms, { sshd: 1 });
  assert.equal(ignored.processProbe.uncertaintyUnattributed, 0);

  for (const uid of [0, 1000]) {
    for (const scoped of [true, false]) {
      const f = groupFixture(); f.process(1234, 1234, null, '42', uid);
      f.receipt({ pid: 1234, start: '42', ...(scoped ? { workspace: f.workspace } : {}) });
      const result = invoke(f, denyFds(f.proc, [1234]));
      assert.equal(result.bytes, 0, 'excluded PID still matches an active or ambiguous receipt');
    }
  }
  const unknownUid = groupFixture(); unknownUid.process(1234, 1234);
  fs.unlinkSync(path.join(unknownUid.proc, '1234/status'));
  const unknown = invoke(unknownUid, denyFds(unknownUid.proc, [1234]));
  assert.equal(unknown.bytes, 0); assert.equal(unknown.processProbe.ignoredUnreadableOwn, 0);
  assert.match(unknown.warnings.join(' '), /unattributed process evidence unreadable/);

  const zombie = groupFixture(), zombieRun = randomUUID();
  zombie.receipt({ run: zombieRun, pid: 1234, start: '42', workspace: zombie.workspace }, zombieRun);
  zombie.process(1234, 1234, zombie.workspace);
  const zombieStat = path.join(zombie.proc, '1234/stat'); fs.writeFileSync(zombieStat, fs.readFileSync(zombieStat, 'utf8').replace('(fixture) S ', '(fixture) Z '));
  const deadZombie = zombie.cleanup();
  assert.equal(deadZombie.bytes, 3); assert.deepEqual(deadZombie.warnings, []); assert.equal(deadZombie.processProbe.zombiesIgnored, 1);
  console.log('PASS unreadable inventory, scoped/unrelated/unattributed fd errors, secret-free reasons and confirmed zombie deletion safety');

  const kernel = groupFixture();
  kernel.process(1234, 1234, kernel.workspace);
  kernel.receipt({ pid: 1234, start: '42', workspace: kernel.workspace });
  const kernelStat = path.join(kernel.proc, '1234/stat');
  const statFields = fs.readFileSync(kernelStat, 'utf8').split(') ')[1].split(' ');
  statFields[6] = String(0x00200000);
  fs.writeFileSync(kernelStat, '1234 (fixture) ' + statFields.join(' '));
  const kernelOnly = kernel.cleanup();
  assert.equal(kernelOnly.bytes, 3); assert.equal(kernelOnly.processProbe.eligible, 0);

  const fdOnly = groupFixture(); fdOnly.process(1234, 1234);
  fs.symlinkSync(path.join(fdOnly.data, 'stale/out'), path.join(fdOnly.proc, '1234/fd/4'));
  const liveFd = fdOnly.cleanup();
  assert.equal(liveFd.bytes, 0); assert.equal(liveFd.processProbe.ignoredUnreadableOwn, 0);
  assert.equal(liveFd.processProbe.uncertaintyHere, 1);

  const busy = groupFixture();
  for (let pid = 2000; pid < 2100; pid++) busy.process(pid, pid, temp);
  const busyOther = path.join(busy.root, 'wt/fixture/id-123456/devbox-cn-2'); fs.mkdirSync(busyOther, { recursive: true });
  busy.process(1234, 1234); busy.process(1235, 1235, busyOther); busy.process(1236, 1236, busy.workspace);
  const busyResult = invoke(busy, denyFds(busy.proc, [1234, 1235, 1236, ...Array.from({ length: 100 }, (_, i) => 2000+i)]));
  assert.equal(busyResult.processProbe.eligible, 103);
  assert.equal(busyResult.processProbe.uncertaintyUnrelatedIgnored, 100);
  assert.equal(busyResult.processProbe.uncertaintyElsewhere, 1); assert.equal(busyResult.processProbe.uncertaintyHere, 1);
  assert.equal(busyResult.bytes, 0);
  assert.equal(busyResult.processProbe.ignoredUnreadableOwn, 1);
  assert.equal(busyResult.processProbe.uncertaintyUnattributed, 0);
  console.log('PASS busy fixture: one unreadable own process, 100 unrelated errors ignored, one other-workspace and one current-workspace error');

  // Exercise the CLI protocol using an isolated PATH and a real fixture Unix socket.
  for (const mode of ['mount', 'parent', 'parent-alias', 'root', 'sibling', 'empty', 'ps-fails', 'inspect-fails', 'absent', 'absent-with-socket', 'fails-no-socket']) {
    const f = groupFixture(), bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
    const parentAlias = path.join(bin, 'runner-root');
    fs.symlinkSync(f.root, parentAlias);
    const coveringMounts = { mount: path.join(f.data, 'active\nrun'), parent: f.root, 'parent-alias': parentAlias, root: '/' };
    const coversWorkspace = Object.hasOwn(coveringMounts, mode);
    const mount = coversWorkspace ? coveringMounts[mode] : f.workspace + '-sibling';
    if (!mode.startsWith('absent')) {
      const cli = `#!/bin/sh
if [ "$*" = "ps -q" ]; then
  case "${mode}" in ps-fails|fails-no-socket) exit 1;; empty) exit 0;; esac
  printf '%s\\n' abcd
elif [ "$1" = inspect ] && [ "$2" = --type ] && [ "$3" = container ] && [ "$4" = --format ] && [ "$5" = '{{range .Mounts}}{{json .Source}}{{println}}{{end}}' ] && [ "$6" = abcd ]; then
  [ "${mode}" != inspect-fails ] || exit 1
  printf '%s\\n' '"/other"' '${JSON.stringify(mount)}'
else exit 2
fi
`;
      fs.writeFileSync(path.join(bin, 'docker'), cli, { mode: 0o755 });
    }
    // Bind a short relative address to stay within the Unix socket path limit on macOS.
    const hasSocket = !['absent', 'fails-no-socket'].includes(mode);
    const setup = `import socket
os.chdir(${JSON.stringify(bin)})
os.environ['PATH']=os.getcwd()
os.environ['DOCKER_HOST']='unix://'+os.getcwd()+'/docker.sock'
original_socket=pathlib.Path.is_socket
pathlib.Path.is_socket=lambda p: p==pathlib.Path.cwd()/'docker.sock' and original_socket(p)
${hasSocket ? "sock=socket.socket(socket.AF_UNIX); sock.bind('docker.sock')" : ''}`;
    const failed = ['ps-fails', 'inspect-fails', 'absent-with-socket'].includes(mode);
    const result = invoke(f, setup, {}, { docker: true, warning: failed && /^\[cleanup-ineffective\] \["docker-unqueryable"\]$/m });
    assert.equal(result.bytes, failed || coversWorkspace ? 0 : 3, mode);
    assert.deepEqual(result.warnings, failed ? ['docker-unqueryable'] : coversWorkspace ? ['live container mount protects workspace'] : [], mode);
  }
  console.log('PASS running container mount sources, path boundaries, empty inventory, unavailable CLI and socket-dependent failures');

  const privateValue = 'fixture-sensitive-value'; let output = '';
  const warningOutput = await execute('python3', ['-c', 'import json,sys,pathlib\n' + runDataCleanupPython + '\nprint_data_cleanup(json.loads(sys.stdin.read()))'], {
    input: JSON.stringify({ entries: [], bytes: 0, warnings: ['cleanup failure: ' + privateValue + '\ncontinued'] }),
    state: { values: [privateValue], children: new Set() }, onOutput: text => { output += text; },
  });
  assert.equal(warningOutput.code, 0); assert.ok(!output.includes(privateValue));
  assert.equal(output.split('\n').filter(line => line.startsWith('[cleanup-ineffective]')).length, 1);
  assert.match(output, /\[cleanup-ineffective\].*cleanup failure/); assert.ok(output.includes('[MASKED]'));
  let assignmentOutput = '';
  const assignmentWarning = await execute('python3', ['-c', 'import json,sys,pathlib\n' + runDataCleanupPython + '\nprint_data_cleanup(json.loads(sys.stdin.read()))'], {
    input: JSON.stringify({ entries: [], bytes: 0, warnings: ['fixture cleanup password=FAKE_VALUE_FOR_TEST'] }),
    state: { values: [], children: new Set() }, onOutput: text => { assignmentOutput += text; },
  });
  assert.equal(assignmentWarning.code, 0); assert.ok(!assignmentOutput.includes('FAKE_VALUE_FOR_TEST'));
  assert.equal(assignmentOutput.split('\n').filter(line => line.startsWith('[cleanup-ineffective]')).length, 1);
  console.log('PASS ineffective cleanup warning stays on one line and uses normal runner output redaction');

  const escaped = fixture(), other = path.join(temp, 'other-data'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'keep'), 'outside');
  fs.rmdirSync(escaped.data); fs.symlinkSync(other, escaped.data);
  assert.ok(invoke(escaped).warnings.some(warning => warning.includes('directory symlink')));
  assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'outside');
  const wrong = fixture(); wrong.write('keep');
  assert.ok(invoke(wrong, '', { workspace: path.dirname(wrong.workspace) }).warnings.some(warning => warning.includes('outside slot scope')));
  assert.ok(fs.existsSync(path.join(wrong.data, 'keep')));
  const placed = groupFixture();
  const secondary = path.join(fs.realpathSync(placed.root), '..', 'devbox-run-2');
  const slotPath = path.relative(placed.root, placed.workspace);
  const secondWorkspace = path.join(secondary, slotPath);
  const secondData = path.join(secondWorkspace, '.data');
  fs.mkdirSync(secondData, { recursive: true });
  const stale = path.join(secondData, 'stale');
  fs.writeFileSync(stale, 'old');
  const roots = { extraRoots: [secondary] };
  const collect = (override = {}) => invoke(placed, '', { workspace: secondWorkspace, treeConfig: roots, ...override });

  const receipt = placed.receipt({ pid: 1234, start: '42', workspace: secondWorkspace });
  placed.process(1234, 1234, temp);
  assert.equal(collect().bytes, 0, 'live receipt on primary protects secondary data');
  fs.unlinkSync(receipt);
  assert.equal(collect().bytes, 3, 'registered secondary with primary control is cleaned');
  assert.ok(fs.existsSync(path.join(placed.data, 'stale/out')), 'primary workspace is untouched');

  fs.writeFileSync(stale, 'keep');
  const unregistered = collect({ treeRoot: secondary, treeConfig: { extraRoots: [] } });
  assert.match(unregistered.warnings.join(' '), /outside registered slot scope/);
  assert.equal(unregistered.bytes, 0);
  const secondControl = path.join(secondary, 'runs', path.basename(placed.control));
  fs.mkdirSync(secondControl, { recursive: true });
  assert.match(collect({ control: secondControl }).warnings.join(' '), /control outside runner scope/);
  assert.equal(fs.readFileSync(stale, 'utf8'), 'keep');

  const foreignWorkspace = path.join(path.dirname(secondary), 'unregistered', slotPath);
  fs.mkdirSync(path.dirname(foreignWorkspace), { recursive: true });
  fs.renameSync(secondWorkspace, foreignWorkspace);
  fs.symlinkSync(foreignWorkspace, secondWorkspace);
  const escape = collect();
  assert.match(escape.warnings.join(' '), /workspace outside slot scope/);
  assert.equal(escape.bytes, 0);
  assert.equal(fs.readFileSync(path.join(foreignWorkspace, '.data/stale'), 'utf8'), 'keep');
  console.log('PASS registered secondary cleanup, primary control and receipts, unregistered and symlink-escaping workspaces');

  const legacy = fixture(); legacy.write('keep/result.log'); retain(legacy, 'keep', false, true);
  assert.equal(invoke(legacy).skipped, 'unexpired legacy retained archive');
  assert.ok(fs.existsSync(path.join(legacy.data, 'keep')));
  console.log('PASS data-root symlink and invalid workspace refusal; legacy retained archives stay protected');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
