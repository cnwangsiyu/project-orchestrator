#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertCompleteObjectDonors, snapshot, makeBundle, remoteScripts } from '../devbox-run.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-donor-fixtures-')));
const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const git = (repo, ...args) => {
  const result = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const init = (name, bare = false) => {
  const repo = path.join(tmp, name); fs.mkdirSync(repo);
  git(repo, 'init', '-q', ...(bare ? ['--bare'] : [])); return repo;
};
const state = () => ({ cancel: 0, children: new Set(), values: [] });
const stage = name => { const dir = path.join(tmp, name); fs.mkdirSync(dir); return dir; };
const inventory = repo => {
  const objects = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  return { config: git(repo, 'config', '--local', '--list'), refs: git(repo, 'show-ref'),
    packs: fs.readdirSync(path.join(objects, 'pack')).sort() };
};
try {
  const seed = init('seed');
  for (let n = 0; n < 5; n++) fs.writeFileSync(path.join(seed, `file-${n}.txt`), `fixture payload ${n}\n`);
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'fixture payloads');
  const pin = git(seed, 'rev-parse', 'HEAD');
  const remote = path.join(tmp, 'remote.git');
  git(tmp, 'clone', '--bare', seed, remote);
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  const donor = path.join(tmp, 'partial');
  git(tmp, 'clone', '--no-checkout', '--filter=blob:none', pathToFileURL(remote).href, donor);
  const missing = git(donor, 'rev-list', '--objects', '--missing=print', pin).split('\n').filter(line => line.startsWith('?'));
  assert.equal(missing.length, 5, 'fixture is an actual blob:none clone missing five blobs');
  const before = inventory(donor);
  const failedStage = stage('failed-stage'), failedState = state();
  await assert.rejects(snapshot({ repo: donor, ref: pin }, failedStage, failedState), /partial clone donor.*5 missing.*refusing to borrow/);
  assert.ok(!fs.existsSync(path.join(failedStage, 'export.git')), 'incomplete donor is rejected before staging alternates');
  assert.equal(failedState.children.size, 0);
  assert.deepEqual(inventory(donor), before, 'checking does not mutate source configuration, refs or packs');
  assert.deepEqual(git(donor, 'rev-list', '--objects', '--missing=print', pin).split('\n').filter(line => line.startsWith('?')), missing);

  const reproScript = new URL('./devbox-bundle-repro.mjs', import.meta.url).pathname;
  const reproOut = stage('repro-out');
  const repro = () => spawnSync(process.execPath, [reproScript, '--repo', donor, '--ref', pin, '--out', reproOut], { env, encoding: 'utf8' });
  let probe = repro();
  assert.notEqual(probe.status, 0); assert.match(probe.stderr, /partial clone donor.*5 missing/);
  const failedRepro = path.join(reproOut, fs.readdirSync(reproOut)[0]);
  assert.ok(!fs.existsSync(path.join(failedRepro, 'export.git')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(failedRepro, 'receipt.json'))).status, 'FAIL');

  const donorObjects = git(donor, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  const middle = init('middle.git', true), borrower = init('borrower');
  const middleObjects = git(middle, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  const borrowerObjects = git(borrower, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  fs.writeFileSync(path.join(middleObjects, 'info/alternates'), path.relative(middleObjects, donorObjects) + '\n');
  fs.writeFileSync(path.join(borrowerObjects, 'info/alternates'), JSON.stringify(middleObjects) + '\n');
  git(borrower, 'update-ref', 'refs/heads/fixture', pin);
  await assert.rejects(assertCompleteObjectDonors(borrower, pin, state(), env), /partial clone donor.*5 missing/);
  const environmentBorrower = init('environment-borrower');
  await assert.rejects(assertCompleteObjectDonors(environmentBorrower, pin, state(), { ...env,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(middleObjects) }), /partial clone donor.*5 missing/);
  console.log('PASS partial donor: five missing blobs, early refusal, unchanged source, recursive relative/quoted and environment alternates');

  const parent = init('parent');
  fs.writeFileSync(path.join(parent, '.gitmodules'), `[submodule "engine"]\npath = engine\nurl = ${pathToFileURL(remote).href}\n`);
  git(parent, 'add', '.gitmodules'); git(parent, 'update-index', '--add', '--cacheinfo', `160000,${pin},engine`);
  const data = { workspace: parent, parent: '', relative: 'engine', name: 'engine', commit: pin, repository: path.dirname(donorObjects) };
  const workspace = path.join(tmp, 'remote-worktree');
  const checkout = spawnSync('python3', ['-c', remoteScripts.checkout, Buffer.from(JSON.stringify({ repository: data.repository,
    workspace, commit: pin })).toString('base64')], { env, encoding: 'utf8' });
  assert.notEqual(checkout.status, 0); assert.match(checkout.stderr, /worktree donor has incomplete pinned objects/);
  assert.ok(!fs.existsSync(workspace), 'incomplete worktree donor is rejected before checkout creation');
  const submodule = () => spawnSync('python3', ['-c', remoteScripts.submodule, Buffer.from(JSON.stringify(data)).toString('base64')], { env, encoding: 'utf8' });
  let result = submodule();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /reference donor has incomplete pinned objects/);
  assert.ok(!fs.existsSync(path.join(parent, 'engine/.git')), 'reference clone is not created from an incomplete store');

  // The marker in the donor's packs is sufficient even without config flags.
  git(donor, 'config', '--unset', 'remote.origin.promisor');
  await assert.rejects(assertCompleteObjectDonors(borrower, pin, state(), env), /partial clone donor.*5 missing/);
  for (const file of fs.readdirSync(path.join(donorObjects, 'pack')).filter(file => file.endsWith('.promisor')))
    fs.unlinkSync(path.join(donorObjects, 'pack', file));
  git(donor, 'config', 'remote.origin.promisor', 'true');
  await assert.rejects(assertCompleteObjectDonors(donor, pin, state(), env), /partial clone donor.*5 missing/);
  await assert.rejects(assertCompleteObjectDonors(borrower, pin, state(), env), /partial clone donor.*5 missing/);
  git(donor, 'config', '--unset', 'remote.origin.promisor');
  git(donor, 'config', 'extensions.partialClone', 'origin');
  await assert.rejects(assertCompleteObjectDonors(borrower, pin, state(), env), /partial clone donor.*5 missing/);
  console.log('PASS partial donor markers: promisor pack, remote promisor and extensions.partialClone through an alternate chain');

  // Repair only this task-created fixture using explicit normal Git transport.
  git(donor, 'fetch', '--refetch', '--no-filter', '--no-tags', '--no-recurse-submodules', 'origin', pin);
  assert.ok(!git(donor, 'rev-list', '--objects', '--missing=print', pin).split('\n').some(line => line.startsWith('?')));
  await assertCompleteObjectDonors(donor, pin, state(), env);
  await assertCompleteObjectDonors(borrower, pin, state(), env);
  const complete = await snapshot({ repo: donor, ref: pin }, stage('complete-stage'), state());
  const bundle = await makeBundle(complete, [], state());
  const imported = init('imported.git', true);
  git(imported, 'fetch', bundle, 'refs/heads/export:refs/heads/imported');
  assert.ok(!git(imported, 'rev-list', '--objects', '--missing=print', pin).split('\n').some(line => line.startsWith('?')));
  for (let n = 0; n < 5; n++) assert.equal(git(imported, 'cat-file', '-t', `${pin}:file-${n}.txt`), 'blob');
  result = submodule();
  assert.equal(result.status, 0, result.stderr); assert.equal(git(path.join(parent, 'engine'), 'rev-parse', 'HEAD'), pin);
  for (let n = 0; n < 5; n++) assert.equal(fs.readFileSync(path.join(parent, 'engine', `file-${n}.txt`), 'utf8'), `fixture payload ${n}\n`);
  probe = repro();
  assert.equal(probe.status, 0, probe.stderr); assert.equal(JSON.parse(probe.stdout).status, 'PASS');
  console.log('PASS hydrated donor: complete graph accepted, self-contained bundle imports all five blobs, reference submodule checkout succeeds');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
