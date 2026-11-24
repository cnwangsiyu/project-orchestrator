#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskLogs } from '../mask-logs.mjs';
import { redactLogFile } from '../lib/log-redaction.mjs';
import { redactRolloutFile } from '../lib/rollout-redaction.mjs';
import { runWithMaskedLog } from '../lib/run-with-masked-log.mjs';
import { execute } from '../devbox-run.mjs';
import { claimOutputDirectory, prepareRunOutput, assertMaskTarget } from '../lib/masking-scope.mjs';
import { findMaskArtifacts } from '../find-mask-artifacts.mjs';
import { captureMaskAudit, finishMaskAudit } from '../lib/worker-mask-audit.mjs';
import { redactWorkerTurn } from '../lib/worker-redaction.mjs';
import { exportSource } from '../lib/devbox-export.mjs';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(scripts, 'mask-logs.mjs'), detector = path.join(scripts, 'find-mask-artifacts.mjs');
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mask-scope-test-'));
const task = path.join(temp, 'task'); fs.mkdirSync(task);
const git = (repo, ...args) => {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'fixture git command failed'); return result.stdout;
};
const makeRepo = name => {
  const repo = path.join(temp, name); fs.mkdirSync(repo); git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(repo, 'proj/cmake'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'ttvebase/src/thirdparty/ffmpeg/include'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'proj/cmake/CMakeLists.txt'), 'NEXUS_MAGIC_WORD=FAKE_FIXTURE_VALUE\n');
  fs.writeFileSync(path.join(repo, 'ttvebase/src/thirdparty/ffmpeg/include/config.log'), 'NEXUS_MAGIC_WORD=FAKE_FIXTURE_VALUE\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\nlynx-games/node_modules/\n');
  git(repo, 'add', 'proj', 'ttvebase', '.gitignore'); git(repo, 'commit', '-qm', 'fixture'); return repo;
};

try {
  const repo = makeRepo('main-checkout'), file = path.join(repo, 'proj/cmake/CMakeLists.txt');
  const original = fs.readFileSync(file);
  const external = path.join(task, 'one.log'), other = path.join(task, 'other.log');
  fs.writeFileSync(external, 'NEXUS_MAGIC_WORD=FAKE_FIXTURE_VALUE\n'); fs.writeFileSync(other, fs.readFileSync(external));
  const result = maskLogs([external], { force: true, taskDirectory: task });
  assert.equal(result.length, 1); assert.equal(result[0].masked, 1);
  assert.ok(fs.readFileSync(external, 'utf8').includes('[MASKED]'));
  assert.ok(!fs.readFileSync(other, 'utf8').includes('[MASKED]'), 'a single file never walks its parent');
  assert.deepEqual(fs.readFileSync(result.rewriteManifest, 'utf8').trim().split('\n').map(JSON.parse), [external]);
  const aged = path.join(task, 'a-aged.log'), active = path.join(task, 'z-active.log');
  fs.writeFileSync(aged, 'NEXUS_MAGIC_WORD=FAKE_FIXTURE_VALUE\n'); fs.writeFileSync(active, fs.readFileSync(aged));
  fs.utimesSync(aged, new Date(), new Date(Date.now() - 180000));
  const inventory = () => fs.readdirSync(task).filter(file => file.startsWith('mask-rewrites-'));
  const beforeRefusal = inventory();
  const refused = spawnSync(process.execPath, [cli, '--task-dir', task, active]);
  assert.equal(refused.status, 1); assert.match(refused.stderr.toString(), /120 s/);
  assert.deepEqual(inventory(), beforeRefusal);
  fs.writeFileSync(external, original);
  const nightly = spawnSync(process.execPath, [cli, '--force', external], { encoding: 'utf8' });
  assert.equal(nightly.status, 0, nightly.stderr);
  assert.match(fs.readFileSync(external, 'utf8'), /MASKED/);
  const partial = spawnSync(process.execPath, [cli, '--task-dir', task, aged, active], { encoding: 'utf8' });
  assert.equal(partial.status, 1); assert.equal(partial.stdout.trim(), aged);
  const partialManifest = /rewrite manifest=([^\r\n]+)/.exec(partial.stderr)?.[1];
  assert.ok(partialManifest); assert.deepEqual(fs.readFileSync(partialManifest, 'utf8').trim().split('\n').map(JSON.parse), [aged]);
  assert.ok(!fs.readFileSync(active, 'utf8').includes('[MASKED]'));
  fs.writeFileSync(external, 'NEXUS_MAGIC_WORD=FAKE_FIXTURE_VALUE\n');
  assert.throws(() => redactLogFile(external), /120 s/);
  assert.equal(redactLogFile(external, { force: true }).masked, 1, 'force bypasses only the age check');
  for (const args of [[], ['--force'], ['--force', file], ['--force', repo], ['--dry-run', file]]) {
    const child = spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(child.status, 0); assert.ok(!child.stdout.includes('FAKE_FIXTURE_VALUE'));
    assert.deepEqual(fs.readFileSync(file), original);
  }
  assert.throws(() => maskLogs([other, file], { force: true }), /worktree/);
  assert.ok(!fs.readFileSync(other, 'utf8').includes('[MASKED]'), 'all targets are preflighted before rewriting');
  assert.throws(() => redactLogFile(file, { force: true }), /worktree/);
  assert.throws(() => redactLogFile(path.join(repo, 'ttvebase/src/thirdparty/ffmpeg/include/config.log'), { force: true }), /worktree/);
  const linked = path.join(temp, 'linked-checkout'); git(repo, 'worktree', 'add', '--detach', linked, 'HEAD');
  assert.throws(() => redactLogFile(path.join(linked, 'proj/cmake/CMakeLists.txt'), { force: true }), /worktree/);
  await assert.rejects(exportSource({ repo, ref: 'HEAD', out: path.join(linked, 'new-export') }), /any git worktree/);
  assert.ok(!fs.existsSync(path.join(linked, 'new-export')));
  assert.throws(() => maskLogs([task], { force: true }), /empty|owned/);
  assert.throws(() => prepareRunOutput(task), /new\/empty/);

  const alias = path.join(temp, 'alias'); fs.symlinkSync(repo, alias);
  assert.throws(() => redactLogFile(path.join(alias, 'proj/cmake/CMakeLists.txt'), { force: true }), /symlink/);
  const fakeTree = path.join(temp, '.worktrees/fixture'); fs.mkdirSync(fakeTree, { recursive: true });
  const fakeLog = path.join(fakeTree, 'out.log'); fs.writeFileSync(fakeLog, original);
  assert.throws(() => redactLogFile(fakeLog, { force: true }), /worktree/);
  const gitAncestor = path.join(temp, 'broken-git'); fs.mkdirSync(gitAncestor); fs.mkdirSync(path.join(gitAncestor, '.git'));
  const gitLog = path.join(gitAncestor, 'out.log'); fs.writeFileSync(gitLog, original);
  assert.throws(() => redactLogFile(gitLog, { force: true }), /worktree/);
  const ownedDir = path.join(task, 'owned'), scope = claimOutputDirectory(ownedDir);
  fs.writeFileSync(path.join(ownedDir, 'one.log'), original);
  fs.symlinkSync(other, path.join(ownedDir, 'link.log'));
  maskLogs([ownedDir], { force: true, scope, taskDirectory: task });
  assert.ok(!fs.readFileSync(other, 'utf8').includes('[MASKED]'));
  assert.throws(() => maskLogs([ownedDir], { force: true, scope: { ...scope, runId: 'wrong-run' } }), /ownership/);

  const ignoredDir = path.join(repo, 'ignored');
  fs.mkdirSync(ignoredDir);
  const ignored = prepareRunOutput(ignoredDir);
  assert.equal(ignored.directory, ignoredDir, 'an existing empty ignored directory keeps its path');
  const rerun = prepareRunOutput(ignoredDir, { warn: () => {} });
  assert.ok(!rerun.directory.startsWith(repo + path.sep), 'a new run cannot claim a nonempty directory');
  fs.rmSync(rerun.directory, { recursive: true });
  const ignoredLog = path.join(ignored.directory, 'fresh.log'); fs.writeFileSync(ignoredLog, original);
  assert.throws(() => redactLogFile(ignoredLog, { force: true, scope: { ...ignored, runId: 'wrong' } }), /ownership/);
  assert.equal(redactLogFile(ignoredLog, { force: true, scope: ignored }).masked, 1);
  const maskFile = target => spawnSync(process.execPath, [cli, '--force', target], { encoding: 'utf8' });
  fs.writeFileSync(ignoredLog, original);
  const resumed = maskFile(ignoredLog);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(fs.readFileSync(ignoredLog, 'utf8'), /MASKED/);
  const resumedManifest = /rewrite manifest=([^\r\n]+)/.exec(resumed.stderr)?.[1];
  assert.ok(resumedManifest && !resumedManifest.startsWith(repo + path.sep));
  assert.deepEqual(JSON.parse(fs.readFileSync(resumedManifest)), ignoredLog);
  fs.unlinkSync(resumedManifest);
  const copied = path.join(repo, 'ignored/copied-marker'); fs.mkdirSync(copied);
  fs.copyFileSync(path.join(ignored.directory, '.mask-output-owner.json'), path.join(copied, '.mask-output-owner.json'));
  const copiedLog = path.join(copied, 'copy.log'); fs.writeFileSync(copiedLog, original);
  assert.notEqual(maskFile(copiedLog).status, 0);
  assert.notEqual(maskFile(ignored.directory).status, 0);
  const unowned = path.join(repo, 'ignored-unowned.log'); fs.writeFileSync(unowned, original);
  fs.appendFileSync(path.join(repo, '.git/info/exclude'), 'ignored-unowned.log\n');
  assert.notEqual(maskFile(unowned).status, 0);
  git(repo, 'add', '-f', 'ignored/fresh.log');
  assert.notEqual(maskFile(ignoredLog).status, 0);
  const staged = fs.readFileSync(ignoredLog);
  fs.unlinkSync(ignoredLog);
  const rejected = prepareRunOutput(ignoredLog, { warn: () => {} });
  assert.ok(!fs.existsSync(ignoredLog));
  fs.rmSync(rejected.directory, { recursive: true });
  fs.writeFileSync(ignoredLog, staged);
  assert.throws(() => redactLogFile(ignoredLog, { force: true, scope: ignored }), /tracked/);
  const redirected = prepareRunOutput(path.join(repo, 'output'), { warn: () => {} });
  assert.ok(!redirected.directory.startsWith(repo + path.sep)); assert.ok(!fs.existsSync(path.join(repo, 'output')));
  const defaultOutput = prepareRunOutput(undefined);
  assert.ok(!defaultOutput.directory.startsWith(process.cwd() + path.sep));
  fs.rmSync(redirected.directory, { recursive: true }); fs.rmSync(defaultOutput.directory, { recursive: true });
  const oldTmp = process.env.TMPDIR; process.env.TMPDIR = repo;
  try {
    const safeDefault = prepareRunOutput(undefined);
    assert.ok(!safeDefault.directory.startsWith(repo + path.sep)); fs.rmSync(safeDefault.directory, { recursive: true });
  } finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; }

  const rollout = path.join(repo, 'rollout.jsonl'); fs.writeFileSync(rollout, '{}\n');
  assert.throws(() => redactRolloutFile(rollout), /worktree/);
  assert.ok(!fs.existsSync(path.join(repo, '.worker-redacted-rollout.jsonl.out')));
  await assert.rejects(runWithMaskedLog(file, process.execPath, ['-e', 'process.exit(0)']), /worktree/);
  assert.throws(() => execute(process.execPath, ['-e', 'process.exit(0)'], { outputFile: file }), /worktree/);
  const follower = spawnSync(process.execPath, [path.join(scripts, 'run-tracked.mjs'), '--cwd', repo, '--log', file,
    '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.notEqual(follower.status, 0); assert.deepEqual(fs.readFileSync(file), original);
  for (const runner of ['devbox-run.mjs', 'mini2-run.mjs']) {
    const args = ['--repo', repo, '--project', 'fixture', '--task', 'fixture', '--out', path.join(repo, 'runner-output')];
    if (runner === 'mini2-run.mjs') args.push('--by', 'fixture', '--allowlist', path.join(temp, 'missing-allowlist.json'));
    else args.push('--ref', 'missing-fixture-ref');
    const child = spawnSync(process.execPath, [path.join(scripts, runner), ...args, '--', 'true'], { encoding: 'utf8', timeout: 20000 });
    assert.notEqual(child.status, 0); assert.match(child.stderr, /worktree output redirected/);
    assert.ok(!fs.existsSync(path.join(repo, 'runner-output')));
    const out = /output=([^\r\n]+)/.exec(child.stderr)?.[1];
    assert.ok(out && !out.startsWith(repo + path.sep)); fs.rmSync(out, { recursive: true, force: true });
  }

  const snapshot = path.join(task, 'r11/source'), nested = path.join(snapshot, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const sources = new Map([
    ['One.m', 'first [MASKED] and [MASKED] on one line\n'],
    ['nested/Two.mm', '[MASKED LINE: synthetic-private-label]\n[MASKED other form]\n'],
    ['unchanged.txt', 'ordinary source text\n'],
  ]);
  for (const [relative, bytes] of sources) fs.writeFileSync(path.join(snapshot, relative), bytes);
  fs.symlinkSync(other, path.join(snapshot, 'external.m'));
  fs.writeFileSync(path.join(snapshot, 'binary.dat'), Buffer.from('bin\0[MASKED]'));
  const snapshotScan = spawnSync(process.execPath, [detector, '--snapshot-dir', snapshot], { encoding: 'utf8' });
  assert.equal(snapshotScan.status, 1, snapshotScan.stderr);
  assert.deepEqual(snapshotScan.stdout.split('\n').filter(line => line.startsWith('snapshot\t')).sort(),
    ['snapshot\t"One.m"\t1', 'snapshot\t"nested/Two.mm"\t2']);
  assert.match(snapshotScan.stdout, /files=2 lines=3 skipped=2 bounded=false/);
  assert.doesNotMatch(snapshotScan.stdout + snapshotScan.stderr, /synthetic-private-label|other form|first \[MASKED/);
  for (const [relative, bytes] of sources) assert.equal(fs.readFileSync(path.join(snapshot, relative), 'utf8'), bytes);
  assert.equal(findMaskArtifacts(snapshot, [], { snapshot: true, maxFiles: 1 }).bounded, true);
  assert.equal(findMaskArtifacts(snapshot, [], { snapshot: true, maxDurationMs: 0 }).bounded, true);
  assert.equal(spawnSync(process.execPath, [detector, '--repo', repo, '--snapshot-dir', snapshot]).status, 2);
  const cleanSnapshot = path.join(task, 'clean-snapshot'); fs.mkdirSync(cleanSnapshot);
  assert.equal(spawnSync(process.execPath, [detector, '--snapshot-dir', cleanSnapshot]).status, 0);

  const detectRepo = makeRepo('detector'), dep = path.join(detectRepo, 'lynx-games/node_modules');
  fs.mkdirSync(dep, { recursive: true }); fs.mkdirSync(path.join(detectRepo, 'src'));
  for (let i = 0; i < 480; i++) fs.writeFileSync(path.join(dep, `fixture-${i}.txt`), i < 46 ? '[MASKED] fixture\n' : 'clean\n');
  fs.writeFileSync(path.join(detectRepo, 'src/one.log'), '[MASKED] fixture\n');
  const tracked = path.join(detectRepo, 'proj/cmake/CMakeLists.txt'); fs.appendFileSync(tracked, '[MASKED] fixture\n');
  const scan = findMaskArtifacts(detectRepo, ['lynx-games/node_modules', 'src']);
  assert.equal(scan.findings.filter(item => item.kind === 'untracked').length, 47);
  assert.deepEqual(scan.groups.find(group => group.directory === 'lynx-games'), { directory: 'lynx-games', files: 46, count: 46 });
  const detectorRun = spawnSync(process.execPath, [detector, '--repo', detectRepo, '--untracked-dir', 'lynx-games/node_modules', '--text-logs'], { encoding: 'utf8' });
  assert.equal(detectorRun.status, 1); assert.ok(!detectorRun.stdout.includes('FAKE_FIXTURE_VALUE'));
  assert.match(detectorRun.stdout, /files=46\tlines=46/);
  assert.ok(fs.readFileSync(tracked, 'utf8').includes('[MASKED] fixture'), 'detector is read-only');
  assert.throws(() => findMaskArtifacts(detectRepo, ['../task']), /inside/);
  assert.equal(findMaskArtifacts(detectRepo, ['lynx-games/node_modules'], { maxFiles: 1 }).bounded, true);
  assert.equal(findMaskArtifacts(detectRepo, ['lynx-games/node_modules'], { maxDurationMs: 0 }).bounded, true);
  const unchanged = captureMaskAudit({ cwd: detectRepo, taskDirectory: task });
  assert.deepEqual(finishMaskAudit(unchanged), [], 'pre-existing marker signatures do not emit new-damage notes');
  await new Promise(resolve => setTimeout(resolve, 10));
  const originalStart = Date.now();
  await new Promise(resolve => setTimeout(resolve, 10));
  fs.writeFileSync(path.join(dep, 'before-reattach.log'), '[MASKED] earlier-in-current-turn\n');
  const reattached = captureMaskAudit({ cwd: detectRepo, taskDirectory: task, startedAt: originalStart, resumed: true });
  assert.deepEqual(finishMaskAudit(reattached)[0].files, ['lynx-games/node_modules/before-reattach.log'], 'reattachment retains the original turn boundary');

  const baseline = captureMaskAudit({ cwd: detectRepo, taskDirectory: task });
  const fresh = path.join(dep, 'new.log'); fs.writeFileSync(fresh, '[MASKED] newly-created\n');
  const notes = [];
  const added = finishMaskAudit(baseline, { note: message => notes.push(message) });
  assert.equal(added.length, 1); assert.deepEqual(added[0].files, ['lynx-games/node_modules/new.log']);
  assert.equal(notes.length, 1); assert.ok(notes[0].includes('new.log')); assert.ok(notes[0].length <= 500);
  finishMaskAudit(baseline, { note: message => notes.push(message) }); assert.equal(notes.length, 1);
  const turnAudit = captureMaskAudit({ cwd: detectRepo, taskDirectory: task });
  fs.writeFileSync(path.join(dep, 'turn.log'), '[MASKED] turn-created\n');
  fs.writeFileSync(path.join(dep, 'fixture-0.txt'), '[MASKED] changed-marker-same-count\n');
  const tracker = { metadata: () => ({}), set: () => {} };
  const warnings = [];
  // The real turn-end redaction boundary invokes the same detector even when no
  // rollout is available; owner routing errors cannot suppress the saved list.
  await redactWorkerTurn({ home: path.join(temp, 'fixture-home'), tracker, maskAudit: turnAudit,
    warn: value => warnings.push(value) });
  assert.ok(turnAudit.results?.some(item => item.files.includes('lynx-games/node_modules/turn.log')));
  assert.ok(turnAudit.results?.some(item => item.files.includes('lynx-games/node_modules/fixture-0.txt')));
  const pathAudit = captureMaskAudit({ cwd: temp, taskDirectory: task });
  const pathRepo = makeRepo('masked-path-checkout'), pathScope = claimOutputDirectory(path.join(pathRepo, 'ignored'));
  const pathLog = path.join(pathScope.directory, 'new.log'); fs.writeFileSync(pathLog, original);
  maskLogs([pathLog], { force: true, scope: pathScope, taskDirectory: task });
  assert.ok(finishMaskAudit(pathAudit).some(item => item.files.includes('ignored/new.log')), 'rewrite manifest discovers a masked worktree outside cwd');
  const crowdedTask = path.join(temp, 'crowded-task'); fs.mkdirSync(crowdedTask);
  const inventoryAudit = captureMaskAudit({ cwd: temp, taskDirectory: crowdedTask });
  for (let i = 0; i < 201; i++) {
    const old = path.join(crowdedTask, `mask-rewrites-a-${i}.txt`);
    fs.writeFileSync(old, ''); fs.utimesSync(old, new Date(0), new Date(0));
  }
  fs.writeFileSync(path.join(crowdedTask, 'mask-rewrites-z-current.txt'), JSON.stringify(pathLog) + '\n');
  fs.writeFileSync(pathLog, '[MASKED] current-run inventory\n');
  assert.ok(finishMaskAudit(inventoryAudit).some(item => item.files.includes('ignored/new.log')), 'older inventories cannot hide a current-run manifest');
  assert.equal(git(repo, 'diff', '--name-only').trim(), '', 'source bytes stayed unchanged');
  console.log('PASS masking scope: single-file/force contract, owned collections, worktree and symlink refusal, remote redirects, 46/480 ignored fixtures, read-only detector, bounded end-of-turn audit and rewrite inventory');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
