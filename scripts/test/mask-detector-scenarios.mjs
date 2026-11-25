#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findMaskArtifacts } from '../find-mask-artifacts.mjs';

const detector = fileURLToPath(new URL('../find-mask-artifacts.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-detector-'));
const repo = path.join(tmp, 'repo'), snapshot = path.join(tmp, 'snapshot');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const run = (args, extra = {}) => spawnSync(process.execPath, [detector, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const put = (dir, file, data) => {
  const name = path.join(dir, file);
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, data);
};

try {
  fs.mkdirSync(repo);
  git('init', '-q');
  for (const name of ['simple.txt', 'staged.txt', 'mixed.txt', 'index-mixed.txt', 'mode.txt', 'excluded/one.txt', 'literal[1].txt'])
    put(repo, name, 'original\n');
  put(repo, 'removed.txt', '[MASKED] already there\n');
  put(repo, 'deleted-hunk.txt', 'to remove\n1\n2\n3\n4\n5\n6\n7\n8\nto replace\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  for (const name of ['simple.txt', 'staged.txt', 'index-mixed.txt', 'mode.txt', 'excluded/one.txt', 'literal[1].txt'])
    put(repo, name, '++ [MASKED] SYNTHETIC_NEVER_PRINT\n');
  put(repo, 'mixed.txt', '[MASKED] synthetic\nother edit\n');
  put(repo, 'removed.txt', 'ordinary\n');
  put(repo, 'deleted-hunk.txt', '1\n2\n3\n4\n5\n6\n7\n8\n[MASKED]\n');
  put(repo, 'new.txt', '[MASKED]\n');
  git('add', 'staged.txt', 'index-mixed.txt', 'new.txt');
  put(repo, 'index-mixed.txt', '++ [MASKED] SYNTHETIC_NEVER_PRINT\nother edit\n');
  git('update-index', '--chmod=+x', 'mode.txt');
  const before = git('status', '--porcelain=v1', '-z');
  const tracked = run(['--repo', repo, '--exclude', 'excluded']);
  assert.equal(tracked.status, 1, tracked.stderr);
  assert.match(tracked.stdout, /tracked\t"literal\[1\]\.txt"\t1/);
  assert.match(tracked.stdout, /staged\t"staged\.txt"\t1/);
  assert.doesNotMatch(tracked.stdout, /removed\.txt|excluded\/one\.txt|SYNTHETIC_NEVER_PRINT/);
  const plan = run(['--repo', repo, '--restore-plan', '--exclude', 'excluded']);
  assert.equal(plan.status, 1, plan.stderr);
  assert.deepEqual(plan.stdout.split('\n').filter(l => l.startsWith('restore-candidate')).sort(), [
    'restore-candidate\t"literal[1].txt"\ttracked', 'restore-candidate\t"simple.txt"\ttracked', 'restore-candidate\t"staged.txt"\tstaged',
  ]);
  assert.equal(git('status', '--porcelain=v1', '-z'), before);
  assert.equal(fs.readFileSync(path.join(repo, 'simple.txt'), 'utf8'), '++ [MASKED] SYNTHETIC_NEVER_PRINT\n');

  put(snapshot, 'App/main.m', '[MASKED] SYNTHETIC_NEVER_PRINT\n');
  put(snapshot, 'Engine/.git', 'gitdir: pointer-not-opened\n');
  put(snapshot, 'Engine/Buried.m', '[MASKED]\n');
  put(snapshot, 'Vendors/.git/config', 'not-opened\n');
  put(snapshot, 'Vendors/Buried.m', '[MASKED]\n');
  put(snapshot, 'omit-a/one.m', '[MASKED]\n');
  put(snapshot, 'omit-b/two.m', '[MASKED]\n');
  for (let i = 0; i < 23; i++) fs.symlinkSync(repo, path.join(snapshot, `link-${i}`));
  put(snapshot, 'binary', Buffer.from('x\0[MASKED]\n'));
  put(snapshot, 'oversize', Buffer.alloc(2 * 2 ** 20 + 1));
  const scan = run(['--snapshot-dir', snapshot, '--exclude', 'omit-a', '--exclude', 'omit-b']);
  assert.equal(scan.status, 1, scan.stderr);
  assert.match(scan.stdout, /snapshot\t"App\/main\.m"\t1/);
  assert.match(scan.stdout, /skipped\tnested-git-checkout\t2/);
  assert.match(scan.stdout, /scan separately with --repo .*\/Engine"/);
  assert.match(scan.stdout, /skipped\tsymlink-or-unsafe-path\t23/);
  assert.equal(scan.stdout.split('\n').filter(l => l.startsWith('skip-name\tsymlink-or-unsafe-path')).length, 20);
  assert.match(scan.stdout, /skipped\tbinary-or-NUL\t1/);
  assert.match(scan.stdout, /skipped\tover-per-file-size\t1/);
  assert.doesNotMatch(scan.stdout, /SYNTHETIC_NEVER_PRINT|Buried\.m|omit-[ab]/);
  assert.equal(run(['--snapshot-dir', snapshot, '--exclude', '..']).status, 2);
  assert.equal(run(['--snapshot-dir', snapshot, '--restore-plan']).status, 2);
  const fakeLarge = path.join(tmp, 'large');
  for (let i = 0; i < 32; i++) put(fakeLarge, `f${i}.log`, '[MASKED]\n');
  assert.match(run(['--snapshot-dir', fakeLarge]).stdout, /files=32 lines=32 skipped=0 bounded=false/);
  for (const limit of [['--max-files', '2'], ['--max-bytes', '20']]) {
    const bounded = run(['--snapshot-dir', fakeLarge, ...limit]);
    assert.equal(bounded.status, 2);
    assert.match(bounded.stdout, /skipped\tbudget-exhausted\t1/);
    assert.match(bounded.stdout, /files=2 lines=2 skipped=1 bounded=true/);
  }

  for (const name of ['retained.log', 'gone.log']) put(repo, name, 'original\n');
  git('add', 'retained.log', 'gone.log');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'index-deleted fixture');
  git('rm', '--cached', 'retained.log');
  git('rm', 'gone.log');
  put(repo, 'retained.log', '[MASKED] SYNTHETIC_NEVER_PRINT\n');
  for (const options of [[], ['--text-logs']]) {
    const deleted = run(['--repo', repo, ...options]);
    assert.equal(deleted.status, 1, deleted.stderr);
    assert.deepEqual(deleted.stdout.split('\n').filter(line => line.includes('retained.log')),
      ['index-deleted\t"retained.log"\t1']);
    assert.doesNotMatch(deleted.stdout, /gone\.log|SYNTHETIC_NEVER_PRINT/);
  }
  assert.doesNotMatch(run(['--repo', repo, '--restore-plan']).stdout, /retained\.log/);

  // A real optional filter can fail and Git still returns success. A synthetic
  // filter name avoids depending on whether this machine has Git LFS installed.
  put(repo, '.gitattributes', 'filter-probe.txt filter=synthetic-lfs\n');
  put(repo, 'filter-probe.txt', 'before\n');
  git('add', '.gitattributes', 'filter-probe.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'filter fixture');
  git('config', 'filter.synthetic-lfs.process', 'git-lfs-filter-process-detector-missing-fixture');
  put(repo, 'filter-probe.txt', 'changed\n');
  const missing = run(['--repo', repo]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /diff -G --name-only.*Git LFS\/filter process not found \(exit 0\)/);
  assert.doesNotMatch(missing.stderr, /detector-missing-fixture/);

  const bin = path.join(tmp, 'bin'), fakeGit = path.join(bin, 'git');
  fs.mkdirSync(bin);
  fs.writeFileSync(fakeGit, `#!/bin/sh
case "$PATH" in *:/opt/homebrew/bin:/usr/local/bin) ;; *) exit 44 ;; esac
case "$3 $4" in
  'rev-parse --is-inside-work-tree') printf 'true\\n' ;;
  'rev-parse --show-toplevel') printf '%s\\n' "$2" ;;
  *) case "$DETECTOR_TEST" in
       slow) exec /bin/sleep 3 ;;
       large) printf '%01024d' 0 ;;
       *) printf '%s\\n' 'SYNTHETIC_NEVER_PRINT' >&2; exit 17 ;;
     esac ;;
esac
`, { mode: 0o755 });
  const fakeEnv = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const failed = run(['--repo', repo], fakeEnv);
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /diff -G --name-only.*exit 17/);
  assert.doesNotMatch(failed.stderr, /SYNTHETIC_NEVER_PRINT/);
  const timed = run(['--repo', repo, '--max-seconds', '0.5'], { ...fakeEnv, DETECTOR_TEST: 'slow' });
  assert.equal(timed.status, 2);
  assert.match(timed.stderr, /diff -G --name-only.*timeout/);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = fakeEnv.PATH;
    process.env.DETECTOR_TEST = 'large';
    assert.throws(() => findMaskArtifacts(repo, [], { maxGitBuffer: 512 }), /diff -G --name-only.*ENOBUFS/);
  } finally { process.env.PATH = originalPath; delete process.env.DETECTOR_TEST; }
  console.log('PASS mask detector: Git exit/timeout/buffer/LFS errors, bounded scans, skip classes, candidate-only restore plans');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
