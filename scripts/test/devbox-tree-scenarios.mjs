#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { treeSettings, treePreference, treePython, treeScript } from '../lib/devbox-trees.mjs';
import { slotRows } from '../devbox-slot-rows.mjs';
import { remoteScripts, runDataCleanupPython } from '../devbox-run.mjs';
import { retentionPython } from '../lib/devbox-retention.mjs';

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-trees-')));
const root = path.join(temp, 'primary'), secondary = path.join(temp, 'secondary');
fs.mkdirSync(root); fs.mkdirSync(secondary);
const config = { extraRoots: [secondary], primaryFloorGiB: 53, secondaryFloorGiB: 20, reserveGiB: 20, coldDays: 3 };
const base = { root, treeConfig: config, project: 'fixture', store: 'id-fixture', slot: 'devbox-cn-1' };
function python(code, data = base) {
  const result = spawnSync('python3', ['-c', 'import os,sys,json,pathlib,time\nd=json.loads(sys.stdin.read())\n' + treePython + 'fixture_filesystem=tree_filesystem\ntree_filesystem=lambda root:str(root)\n' + code], { input: JSON.stringify(data), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function refused(data) {
  const result = spawnSync('python3', ['-c', 'import os,sys,json,pathlib,time\nd=json.loads(sys.stdin.read())\n' + treePython + 'print(json.dumps(tree_evict(d)))'], { input: JSON.stringify(data), encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'unsafe eviction refused');
}
function score(free, busy) {
  return python(`free=${JSON.stringify(free)}\nio=${JSON.stringify(busy)}\noriginal_statvfs=os.statvfs\ndef disk(p):\n    return __import__('types').SimpleNamespace(f_bavail=free[str(p)]*TREE_GIB,f_frsize=1)\nos.statvfs=disk\ntree_disk_sample=lambda roots:io\nprint(json.dumps(tree_scores(d)))\n`);
}
function coldTree(slot, treeRoot = secondary) {
  const repo = path.join(root, 'repos/fixture/id-fixture'), ws = path.join(treeRoot, 'wt/fixture/id-fixture', slot);
  if (!fs.existsSync(repo)) execFileSync('git', ['init', '--bare', '-q', repo]);
  if (!fs.existsSync(path.join(temp, 'source'))) {
    const source = path.join(temp, 'source'); fs.mkdirSync(source);
    for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) execFileSync('git', ['-C', source, ...args]);
    fs.writeFileSync(path.join(source, 'source.txt'), 'public\n'); fs.writeFileSync(path.join(source, '.gitignore'), '/.devbox-run.json\n/build/\n');
    execFileSync('git', ['-C', source, 'add', '.']); execFileSync('git', ['-C', source, 'commit', '-qm', 'fixture']);
    execFileSync('git', ['--git-dir=' + repo, 'fetch', '-q', source, 'HEAD:refs/heads/main']);
  }
  fs.mkdirSync(path.dirname(ws), { recursive: true });
  execFileSync('git', ['--git-dir=' + repo, 'worktree', 'add', '-q', '--detach', ws, 'main']);
  fs.mkdirSync(path.join(ws, 'build')); fs.writeFileSync(path.join(ws, 'build/cache'), 'warm');
  const receipt = { slot, repository: repo, lastUsed: Date.now() / 1000 - 4 * 86400 };
  fs.writeFileSync(path.join(ws, '.devbox-run.json'), JSON.stringify(receipt));
  return { ...base, slot, workspace: ws, treeRoot, repository: repo, heldSlots: [] };
}

try {
  assert.deepEqual(treeSettings(temp), {});
  fs.writeFileSync(path.join(temp, 'machine.conf'), `DEVBOX_TREE_PLACEMENT.192.0.2.1=1\nDEVBOX_EXTRA_ROOTS.192.0.2.1=${secondary}\n`);
  assert.deepEqual(treeSettings(temp)['192.0.2.1'], config);
  fs.appendFileSync(path.join(temp, 'machine.conf'), 'DEVBOX_TREE_PLACEMENT.192.0.2.1=1\n');
  assert.throws(() => treeSettings(temp), /duplicate/);
  fs.writeFileSync(path.join(temp, 'machine.conf'), 'DEVBOX_TREE_PLACEMENT.192.0.2.1=1\nDEVBOX_EXTRA_ROOTS.192.0.2.1=/foreign/../path\n');
  assert.throws(() => treeSettings(temp), /EXTRA_ROOTS/);
  const scores = score({ [root]: 80, [secondary]: 120 }, {});
  assert.equal(scores[1].score, 100); assert.ok(scores[1].score > scores[0].score);
  const pressured = score({ [root]: 200, [secondary]: 120 }, { [root]: { busyFraction: 0.99 }, [secondary]: { busyFraction: 0.1 } });
  assert.ok(pressured[1].score > pressured[0].score); assert.equal(pressured[0].scoreMode, 'space-io');
  const partial = score({ [root]: 200, [secondary]: 120 }, { [root]: { busyFraction: 0.99 } });
  assert.equal(partial[0].score, 147); assert.equal(partial[1].scoreMode, 'space');
  const floors = score({ [root]: 72, [secondary]: 39 }, {});
  assert.ok(floors.every(row => !row.eligible));
  const sharedDisk = python("tree_filesystem=fixture_filesystem\ntree_disk_sample=lambda roots:{}\nos.statvfs=lambda p:__import__('types').SimpleNamespace(f_bavail=110*TREE_GIB,f_frsize=1)\nprint(json.dumps(tree_scores(d)))", { ...base, treeReservations: { [root]: 20, [secondary]: 20 } });
  assert.ok(sharedDisk.every(row => row.floorGiB === 53 && row.reservedGiB === 40 && !row.eligible), 'shared filesystem uses strongest floor and combined reservations');
  const denied = spawnSync('python3', ['-c', 'import os,sys,json,pathlib,time\nd=json.loads(sys.stdin.read())\n' + treePython + `tree_scores=lambda d:${JSON.stringify(floors).replaceAll('false', 'False').replaceAll('null', 'None')}\nprint(json.dumps(tree_place(d)))`], { input: JSON.stringify(base), encoding: 'utf8' });
  assert.equal(denied.status, 72); assert.ok(!fs.existsSync(path.join(root, 'wt-map.json')));
  const devices = path.join(temp, 'devices'); fs.mkdirSync(devices);
  for (const name of ['sda', 'sdb']) { fs.mkdirSync(path.join(devices, name)); fs.writeFileSync(path.join(devices, name, 'stat'), Array(11).fill('0').join(' ')); }
  const sampled = python(`devices=pathlib.Path(${JSON.stringify(devices)})\ntree_backing_device=lambda p:devices/('sda' if str(p)==d['root'] else 'sdb')\nclock=[0]\ntime.monotonic=lambda:clock[0]\ndef tick(seconds):\n    assert seconds==1\n    clock[0]=1\n    for name,delta in [('sda',500),('sdb',1000)]:\n        fields=['0']*11; fields[9]=str(delta); (devices/name/'stat').write_text(' '.join(fields))\ntime.sleep=tick\nprint(json.dumps(tree_disk_sample(tree_roots(d))))`);
  assert.equal(sampled[root].busyFraction, 0.5); assert.equal(sampled[secondary].busyFraction, 1);
  assert.equal(sampled[root].sampleSec, 1);
  console.log('PASS config validation, space/I/O scores, missing-I/O fallback, reserve floors and no publication on refusal');

  const rows = [1, 2, 3, 4].map(i => ({ slot: 'devbox-cn-' + i, host: '192.0.2.1' }));
  const inventory = { '192.0.2.1': [{ slot: rows[0].slot, project: 'fixture', store: 'id-fixture', lastUsed: 10 },
    { slot: rows[1].slot, project: 'fixture', store: 'id-fixture', lastUsed: 20 },
    { slot: rows[3].slot, project: 'other', store: 'id-other', lastUsed: 1 }] };
  assert.equal(treePreference(rows, inventory, 'fixture', 'id-fixture').slot, rows[1].slot);
  assert.equal(treePreference(rows.slice(2), inventory, 'fixture', 'id-fixture').slot, rows[2].slot);
  assert.equal(treePreference([rows[0], rows[3]], inventory, 'absent', 'id-absent').slot, rows[3].slot);
  assert.equal(treePreference(rows, inventory, 'fixture', 'id-fixture', '192.0.2.2'), undefined);
  const registry = 'devbox-cn-1\tremote\topen\t-\tbox alice@192.0.2.1 caps=node prefer=sdk cores=32\n';
  const proposed = slotRows(registry, '192.0.2.1', 32, 100).trim().split('\n');
  assert.equal(proposed.length, 32); assert.ok(proposed.every(line => line.includes('dynamic-only') && line.replace(' dynamic-only', '').split('\t').slice(1).join('\t') === registry.trim().split('\t').slice(1).join('\t')));
  assert.throws(() => slotRows(registry, '192.0.2.1', 2, 1), /already exists/);
  const embeddedTag = slotRows(registry.replace('caps=node', 'caps=node,dynamic-only'), '192.0.2.1', 1, 100);
  assert.ok(embeddedTag.trim().split('\t').slice(4).join('\t').split(/\s+/).includes('dynamic-only'), 'capability substrings cannot replace the standalone controller flag');
  const bomTag = slotRows(registry.replace('caps=node', 'caps=node\uFEFFdynamic-only'), '192.0.2.1', 1, 100);
  assert.ok(bomTag.trim().split('\t').slice(4).join('\t').split(/[ \t\r\n\v\f]+/).includes('dynamic-only'), 'JS-only whitespace cannot hide a missing controller flag');
  const prefixHost = 'devbox-cn-2\tremote\topen\t-\tbox bob@192.0.2.10 caps=foreign\n' + registry;
  assert.ok(slotRows(prefixHost, '192.0.2.1', 1, 100).includes('alice@192.0.2.1'));
  console.log('PASS warm-newest, empty, foreign-tree LRU, chosen-host preferences and print-only ceiling row generation');

  const kept = coldTree('devbox-cn-1');
  const guard = spawnSync('python3', ['-c', 'import os,sys,json,pathlib,time\nd=json.loads(sys.stdin.read())\n' + treePython + "os.statvfs=lambda p:__import__('types').SimpleNamespace(f_bavail=(100 if str(p)==d['root'] else 19)*TREE_GIB,f_frsize=1)\ntree_guard(d)"], { input: JSON.stringify(kept), encoding: 'utf8' });
  assert.equal(guard.status, 72); assert.ok(fs.existsSync(kept.workspace));
  const control = path.join(root, 'runs', randomUUID()); fs.mkdirSync(control, { recursive: true });
  const dataDir = path.join(kept.workspace, '.data'); fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, 'stale-output'), 'old');
  const h = 'import os,sys,json,pathlib,time\nd=json.loads(sys.stdin.read())\n';
  const cleanup = treeScript('run', h + retentionPython + runDataCleanupPython + '\nproc_root=pathlib.Path(d["control"])/"fixture-proc"\nproc_root.mkdir(parents=True,exist_ok=True)\ndocker_workspace_live=lambda workspace: False\nprint(json.dumps(cleanup_run_data(d,proc_root)))', h, kept);
  const cleaned = spawnSync('python3', ['-c', cleanup], { input: JSON.stringify({ ...kept, control, runId: randomUUID(), env: {} }), encoding: 'utf8' });
  assert.equal(cleaned.status, 0, cleaned.stderr); assert.deepEqual(JSON.parse(cleaned.stdout).entries.map(row => row.name), ['stale-output']);
  fs.rmdirSync(dataDir);
  refused({ ...kept, heldSlots: [kept.slot] });
  refused({ ...kept, workspace: path.dirname(kept.workspace) });
  refused({ ...kept, treeRoot: temp });
  refused({ ...kept, repository: path.join(temp, 'foreign-repo') });
  assert.ok(fs.existsSync(kept.workspace));
  assert.equal(python("tree_process_live=lambda ws:True\nprint(json.dumps(tree_evict(d)))", kept).skipped, 'live or unknown process');
  fs.appendFileSync(path.join(kept.workspace, 'source.txt'), 'local edit');
  assert.equal(python("print(json.dumps(tree_evict(d)))", kept).skipped, 'uncommitted edits');
  const privateTree = coldTree('devbox-cn-2'); fs.writeFileSync(path.join(privateTree.workspace, '.env'), '');
  assert.equal(python("print(json.dumps(tree_evict(d)))", privateTree).skipped, 'private or symlink state');
  const linked = coldTree('devbox-cn-3'); fs.symlinkSync(kept.workspace, path.join(linked.workspace, 'build/link'));
  assert.equal(python("print(json.dumps(tree_evict(d)))", linked).skipped, 'private or symlink state');
  const foreign = path.join(temp, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'outside');
  const linkRoot = path.join(temp, 'linked-root'); fs.symlinkSync(foreign, linkRoot);
  refused({ ...kept, treeConfig: { ...config, extraRoots: [linkRoot] }, treeRoot: linkRoot });
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'outside');
  const removed = coldTree('devbox-cn-4');
  const deletion = python("print(json.dumps(tree_evict(d)))", removed);
  assert.equal(deletion.path, removed.workspace); assert.ok(deletion.bytes > 0); assert.equal(deletion.reason, 'cold');
  assert.ok(!fs.existsSync(removed.workspace)); assert.ok(fs.existsSync(kept.workspace));
  const fresh = coldTree('devbox-cn-5');
  const meta = JSON.parse(fs.readFileSync(path.join(fresh.workspace, '.devbox-run.json'))); meta.lastUsed = Date.now() / 1000;
  fs.writeFileSync(path.join(fresh.workspace, '.devbox-run.json'), JSON.stringify(meta));
  assert.equal(python("print(json.dumps(tree_evict(d)))", fresh).skipped, 'warm and above floor');
  const ageOnly = python("d['coldOnly']=True\nos.statvfs=lambda p:__import__('types').SimpleNamespace(f_bavail=19*TREE_GIB,f_frsize=1)\nprint(json.dumps(tree_evict(d)))", fresh);
  assert.equal(ageOnly.skipped, 'warm and above floor'); assert.ok(fs.existsSync(fresh.workspace), 'gc age recheck preserves a tree reused since inventory');
  const underFloor = python("os.statvfs=lambda p:__import__('types').SimpleNamespace(f_bavail=19*TREE_GIB,f_frsize=1)\nprint(json.dumps(tree_evict(d)))", fresh);
  assert.equal(underFloor.reason, 'below-floor-lru'); assert.ok(!fs.existsSync(fresh.workspace));
  const sharedPressure = coldTree('devbox-cn-21');
  const sharedMeta = JSON.parse(fs.readFileSync(path.join(sharedPressure.workspace, '.devbox-run.json'))); sharedMeta.lastUsed = Date.now() / 1000;
  fs.writeFileSync(path.join(sharedPressure.workspace, '.devbox-run.json'), JSON.stringify(sharedMeta));
  const sharedEvicted = python("tree_filesystem=fixture_filesystem\nos.statvfs=lambda p:__import__('types').SimpleNamespace(f_bavail=40*TREE_GIB,f_frsize=1)\nprint(json.dumps(tree_evict(d)))", { ...sharedPressure, targetFreeGiB: 20 });
  assert.equal(sharedEvicted.reason, 'below-floor-lru', 'owner eviction protects the primary floor on a shared filesystem');
  assert.ok(fs.existsSync(path.join(root, 'repos/fixture/id-fixture')));
  console.log('PASS held slots, dirty/private trees, live/unknown processes, unregistered roots, symlinks and foreign paths preserved; cold and below-floor trees logged');

  fs.writeFileSync(path.join(root, 'wt-map.json'), JSON.stringify({ version: 1, slots: { 'devbox-cn-1': { 'fixture/id-fixture': { treeRoot: secondary, reserveGiB: 100, owner: 'live-digest' } } } }));
  const placementCode = "tree_disk_sample=lambda roots:{}\nos.statvfs=lambda p:__import__('types').SimpleNamespace(f_bavail=(100 if str(p)==d['root'] else 120)*TREE_GIB,f_frsize=1)\nprint(json.dumps(tree_place(d)))";
  const reserved = python(placementCode, { ...base, slot: 'devbox-cn-9', heldTreeOwners: { 'devbox-cn-1': 'live-digest', 'devbox-cn-9': 'mine' } });
  assert.equal(reserved.treeRoot, root); assert.equal(reserved.placementScores[1].reservedGiB, 100);
  const released = python(placementCode, { ...base, slot: 'devbox-cn-10', heldTreeOwners: { 'devbox-cn-1': 'different-holder', 'devbox-cn-10': 'mine' } });
  assert.equal(released.treeRoot, secondary); assert.equal(released.placementScores[1].reservedGiB, 0);
  const delayed = python(placementCode, { ...base, slot: 'devbox-cn-11', heldTreeOwners: { 'devbox-cn-11': 'mine' } });
  assert.equal(delayed.placementScores[1].reservedGiB, 20, 'reserve published after a stale inventory still counts');
  assert.equal(python('print(json.dumps(tree_release(d)))', { ...base, slot: 'devbox-cn-10', owner: 'wrong-owner' }).released, 0);
  assert.equal(python('print(json.dumps(tree_release(d)))', { ...base, slot: 'devbox-cn-10', owner: 'mine' }).released, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'wt-map.json'))).slots['devbox-cn-10']['fixture/id-fixture'].reserveGiB, 0);
  const receipt = JSON.parse(fs.readFileSync(path.join(kept.workspace, '.devbox-run.json'))); receipt.repository = foreign;
  fs.writeFileSync(path.join(kept.workspace, '.devbox-run.json'), JSON.stringify(receipt));
  const foreignPlace = spawnSync('python3', ['-c', 'import os,sys,json,pathlib,time\nd=json.loads(sys.stdin.read())\n' + treePython + 'print(json.dumps(tree_place(d)))'], { input: JSON.stringify(base), encoding: 'utf8' });
  assert.notEqual(foreignPlace.status, 0); assert.ok(fs.existsSync(kept.workspace));
  console.log('PASS live-lease disk reservations, returned/replaced-owner release and foreign existing-tree rejection');
  const concurrentRoot = path.join(temp, 'concurrent'); fs.mkdirSync(concurrentRoot);
  const concurrentBase = { ...base, root: concurrentRoot, treeConfig: { ...config, extraRoots: [] } };
  const concurrentCode = 'import os,sys,json,pathlib,time\nd=json.loads(sys.stdin.read())\n' + treePython + "tree_disk_sample=lambda roots:{}\nos.statvfs=lambda p:__import__('types').SimpleNamespace(f_bavail=94*TREE_GIB,f_frsize=1)\nprint(json.dumps(tree_place(d)))";
  const placements = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const slot = 'devbox-cn-' + (100 + i), child = spawn('python3', ['-c', concurrentCode], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr, slot }));
    child.stdin.end(JSON.stringify({ ...concurrentBase, slot, store: 'id-concurrent-' + i, heldTreeOwners: { [slot]: 'owner-' + i } }));
  })));
  assert.equal(placements.filter(row => row.status === 0).length, 2, 'concurrent stale inventories cannot overcommit 41 GiB of surplus');
  assert.ok(placements.every(row => row.status === 0 || row.status === 72), JSON.stringify(placements));
  const concurrentMap = JSON.parse(fs.readFileSync(path.join(concurrentRoot, 'wt-map.json')));
  assert.equal(Object.keys(concurrentMap.slots).length, 2, 'different repository locks preserve every admitted map update');
  assert.equal(Object.values(concurrentMap.slots).flatMap(entries => Object.values(entries)).reduce((sum, entry) => sum + entry.reserveGiB, 0), 40);
  console.log('PASS concurrent cross-repository placement, stale hold snapshots, atomic map updates and filesystem budgets');
  const mappedTree = coldTree('devbox-cn-20', root), duplicate = coldTree('devbox-cn-20', secondary);
  const mapped = JSON.parse(fs.readFileSync(path.join(root, 'wt-map.json'))); mapped.slots['devbox-cn-20'] = { 'fixture/id-fixture': { treeRoot: root } };
  fs.writeFileSync(path.join(root, 'wt-map.json'), JSON.stringify(mapped));
  assert.equal(python('print(json.dumps(tree_evict(d)))', duplicate).path, duplicate.workspace);
  assert.ok(fs.existsSync(mappedTree.workspace));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'wt-map.json'))).slots['devbox-cn-20']['fixture/id-fixture'].treeRoot, root);

  // Preserve unrelated land-7 scripts; pin intentional supervisor/cleanup,
  // donor-completeness and additive input diagnostics separately.
  const legacyWire = value => value.replaceAll('|[A-Za-z0-9][A-Za-z0-9_.-]*-[1-9][0-9]*', '');
  const hash = value => createHash('sha256').update(legacyWire(value)).digest('hex');
  const nonRun = Object.fromEntries(Object.entries(remoteScripts).filter(([operation]) => !['run', 'submodule', 'checkout', 'cleanup', 'reconnect', 'input-exists'].includes(operation)));
  assert.equal(hash(JSON.stringify(nonRun)), '7326580d1b9581f3bb5c800ff55758adf12caefe6eb48a4841968ff81cd03655', 'unrelated remote scripts retain land-7 bytes except dynamic lease syntax');
  assert.equal(hash(remoteScripts['input-exists']), 'c7833da1018f3e20a66668d29ee5566123efc51e3fec9a3419a1fc8951bdfccf', 'input creation diagnostic uses validated paths and stat-only existence checks');
  assert.equal(hash(remoteScripts.checkout), '162239ccf56fc01ed8ccb1239f1821525146932fa4f2744e800779c2aba9130e', 'checkout snapshot includes pinned donor completeness check');
  assert.equal(hash(remoteScripts.submodule), 'c6143ab3755aeb71b0f56d09d3e465d2e291b9f55491809330c53941b3c3d6a0', 'submodule snapshot includes pinned donor completeness and offline legacy-clone pin import');
  assert.equal(hash(remoteScripts.run), 'b5315491f55620e5388bb32f5d2cc1d734c90c45488f6b996558e0c4819d20ef', 'run wire snapshot includes short owned TMPDIR creation and cleanup');
  assert.equal(hash(remoteScripts.cleanup), '8d9a439a1c6427608902c39313c3f0434c6c67e35c33a64ddd647e7968c68388', 'cleanup wire snapshot includes guarded TMPDIR removal');
  assert.equal(hash(remoteScripts.reconnect), '70225c93d52ce7997b3e69deaf0f0e337d18a054c5a585f9ad9eb729f266cf0e', 'reconnect wire snapshot includes guarded TMPDIR recovery');
  for (const [operation, source] of Object.entries(remoteScripts)) assert.equal(treeScript(operation, source, '', {}), source, 'legacy script unchanged: ' + operation);
  const scripts = fileURLToPath(new URL('../', import.meta.url));
  for (const operation of ['inspect', 'checkout', 'run', 'input-map', 'inputs-ready', 'dead-slot']) {
    const source = remoteScripts[operation], end = source.indexOf("d=json.loads(base64.b64decode(sys.argv[1]))\n") + "d=json.loads(base64.b64decode(sys.argv[1]))\n".length;
    const code = treeScript(operation, source, source.slice(0, end), { ...base, workspace: kept.workspace, treeRoot: secondary });
    const parsed = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf8' });
    assert.equal(parsed.status, 0, operation + ': ' + parsed.stderr);
  }
  const stale = remoteScripts['dead-slot'], headerEnd = stale.indexOf("d=json.loads(base64.b64decode(sys.argv[1]))\n") + "d=json.loads(base64.b64decode(sys.argv[1]))\n".length;
  const staleCode = treeScript('dead-slot', stale, stale.slice(0, headerEnd), kept);
  const otherPath = path.join(root, 'wt/other/id-other/devbox-cn-1'); fs.mkdirSync(otherPath, { recursive: true });
  const scan = spawnSync('python3', ['-c', "import ast,sys,json,pathlib\nd=json.loads(sys.argv[1]); body=ast.parse(sys.stdin.read()).body\nend=next(node.lineno for node in body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='limit' for t in node.targets))\n# Execute only path discovery, never the real /proc/argv inspection.\nnodes=[node for node in body if node.lineno<end and not (isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='d' for t in node.targets))]\nexec(compile(ast.Module(body=nodes,type_ignores=[]),'paths','exec'))\nprint(json.dumps(paths))", JSON.stringify(kept)], { input: staleCode, encoding: 'utf8' });
  assert.equal(scan.status, 0, scan.stderr); assert.ok(JSON.parse(scan.stdout).includes(otherPath) && JSON.parse(scan.stdout).includes(kept.workspace));
  console.log('PASS unchanged legacy script identities and syntax of every augmented Python operation');

  const shared = path.join(temp, 'shared'), bin = path.join(temp, 'bin'); fs.mkdirSync(shared); fs.mkdirSync(bin); fs.mkdirSync(path.join(shared, 'locks'));
  const cold = coldTree('devbox-cn-6'), held = coldTree('devbox-cn-7', root), unregistered = coldTree('devbox-cn-8');
  const heldDir = path.join(shared, 'locks/devbox-cn-7.d'); fs.mkdirSync(heldDir); fs.writeFileSync(path.join(heldDir, 'info'), 'by\tforeign-holder\npid\t1\n');
  fs.writeFileSync(path.join(shared, 'resources.tsv'), [6, 7].map(i => `devbox-cn-${i}\tremote\topen\t-\tfixture alice@192.0.2.1 caps=node`).join('\n') + '\n');
  fs.writeFileSync(path.join(shared, 'machine.conf'), `DEVBOX_TREE_PLACEMENT.192.0.2.1=1\nDEVBOX_EXTRA_ROOTS.192.0.2.1=${secondary}\n`);
  fs.writeFileSync(path.join(shared, 'devbox-hosts.json'), JSON.stringify({ '192.0.2.1': { user: 'alice', root } }));
  fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}\nconst cp=require('node:child_process');\nconst a=process.argv.slice(2); if(!a.includes('BatchMode=yes'))process.exit(9); if(process.env.FIXTURE_EVICT_DROP&&a.at(-1).startsWith('# devbox-evict:evict'))process.exit(255);\nconst r=cp.spawnSync('/bin/bash',['-c',a.at(-1)],{encoding:'utf8'}); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'res'), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'); const a=process.argv.slice(2),flag=n=>a[a.indexOf(n)+1],dir=path.join(process.env.RES_DIR,'locks',a[1]+'.d');\nif(a[0]==='take'){if(!a.includes('--maintenance'))process.exit(9);try{fs.mkdirSync(dir)}catch{process.exit(2)};if(process.env.FIXTURE_EVICT_RACE===a[1]){fs.writeFileSync(path.join(dir,'info'),'by\\tconcurrent-runner\\npid\\t1\\n');process.exit(2);};fs.writeFileSync(path.join(dir,'info'),'by\\t'+flag('--by')+'\\npid\\t'+flag('--pid')+'\\n');}\nelse if(a[0]==='retain-remote'){fs.appendFileSync(path.join(dir,'info'),'remote_cleanup_required\\t1\\n');}\nelse if(a[0]==='return'){if(!fs.readFileSync(path.join(dir,'info'),'utf8').includes('by\\t'+flag('--by')+'\\n'))process.exit(9);fs.rmSync(dir,{recursive:true});} else process.exit(9);\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(scripts, 'devbox-evict.mjs'), 'alice@192.0.2.1', root], { env: { ...process.env, RES_DIR: shared, DEVBOX_CACHE_DIR: shared, RES_COMMAND: path.join(bin, 'res'), PATH: bin + ':' + process.env.PATH }, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(cold.workspace)); assert.ok(fs.existsSync(held.workspace)); assert.ok(fs.existsSync(unregistered.workspace));
  assert.deepEqual(fs.readdirSync(path.join(shared, 'locks')), ['devbox-cn-7.d']);
  const log = fs.readFileSync(path.join(shared, 'reports/devbox-evictions/evictions.tsv'), 'utf8');
  assert.ok(log.includes(cold.workspace) && !log.includes(held.workspace));
  const raced = coldTree('devbox-cn-13'); fs.appendFileSync(path.join(shared, 'resources.tsv'), 'devbox-cn-13\tremote\topen\t-\tfixture alice@192.0.2.1 caps=node\n');
  const collision = spawnSync(process.execPath, [path.join(scripts, 'devbox-evict.mjs'), 'alice@192.0.2.1', root], { env: { ...process.env, FIXTURE_EVICT_RACE: raced.slot, RES_DIR: shared, DEVBOX_CACHE_DIR: shared, RES_COMMAND: path.join(bin, 'res'), PATH: bin + ':' + process.env.PATH }, encoding: 'utf8', timeout: 120000 });
  assert.equal(collision.status, 0, collision.stderr); assert.ok(fs.existsSync(raced.workspace), 'runner acquiring after inventory wins over eviction');
  assert.ok(fs.readFileSync(path.join(shared, 'locks/devbox-cn-13.d/info'), 'utf8').includes('concurrent-runner'), 'eviction cannot return another runner hold');
  const dropped = coldTree('devbox-cn-12'); fs.appendFileSync(path.join(shared, 'resources.tsv'), 'devbox-cn-12\tremote\topen\t-\tfixture alice@192.0.2.1 caps=node\n');
  const unknown = spawnSync(process.execPath, [path.join(scripts, 'devbox-evict.mjs'), 'alice@192.0.2.1', root], { env: { ...process.env, FIXTURE_EVICT_DROP: '1', RES_DIR: shared, DEVBOX_CACHE_DIR: shared, RES_COMMAND: path.join(bin, 'res'), PATH: bin + ':' + process.env.PATH }, encoding: 'utf8', timeout: 120000 });
  assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /BLOCKED.*retaining protected/);
  assert.ok(fs.existsSync(dropped.workspace)); assert.ok(fs.readFileSync(path.join(shared, 'locks/devbox-cn-12.d/info'), 'utf8').includes('remote_cleanup_required'));
  const candidateEvict = fs.readFileSync(path.join(scripts, 'devbox-evict.sh'), 'utf8');
  assert.equal(hash(candidateEvict.slice(candidateEvict.indexOf('host=${target#*@}'))), 'c611b9feb159ffc2e30be14d1665cc8f60f2d124cb6b224edc4f288dc9e3cb0e', 'legacy eviction command unchanged');
  console.log('PASS fake SSH owner eviction leases/returns, secondary roots, named size/path logs, held/unregistered trees and exact legacy eviction command');

  const integrated = spawnSync(process.execPath, [path.join(scripts, 'test/devbox-run-scenarios.mjs')], { env: { ...process.env, DEVBOX_TEST_CASE: 'trees' }, encoding: 'utf8', timeout: 240000 });
  assert.equal(integrated.status, 0, integrated.stdout + integrated.stderr);
  process.stdout.write(integrated.stdout);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
