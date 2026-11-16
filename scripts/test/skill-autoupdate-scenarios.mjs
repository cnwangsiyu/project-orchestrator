#!/usr/bin/env node
// Local bare remotes, synthetic install paths/shared storage, no real user state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Apple's /usr/bin/git shim resolves its toolchain slowly with a synthetic HOME.
// Use the installed Git binary discovered from its own exec path in fixtures.
const gitBin = path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../bin/git');
const realGit = fs.existsSync(gitBin) ? gitBin : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-autoupdate-')));
const env = { ...process.env, HOME: tmp, PATH: `${path.dirname(realGit)}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_ALLOW_PROTOCOL: 'file', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[protocol "file"]\n\tallow = always\n');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const commit = (dir, text) => { fs.writeFileSync(path.join(dir, 'content'), text); git(dir, 'add', '.'); git(dir, 'commit', '-m', text); return head(dir); };
const remote = path.join(tmp, 'remote.git'), seed = path.join(tmp, 'seed');
fs.mkdirSync(seed); git(seed, 'init', '-b', 'main');
fs.mkdirSync(path.join(seed, 'scripts'));
for (const name of ['skill-autoupdate.mjs', 'rules-digest-hook.mjs']) fs.copyFileSync(path.join(scripts, name), path.join(seed, 'scripts', name));
fs.cpSync(path.join(scripts, 'lib'), path.join(seed, 'scripts/lib'), { recursive: true });
fs.mkdirSync(path.join(seed, 'references')); fs.copyFileSync(path.join(scripts, '../references/global-rules.md'), path.join(seed, 'references/global-rules.md'));
const base = commit(seed, 'base');
git(tmp, 'clone', '--bare', seed, remote); git(seed, 'remote', 'add', 'origin', remote);
const clone = (dir, source = remote) => { fs.mkdirSync(path.dirname(dir), { recursive: true }); git(tmp, 'clone', source, dir); return dir; };
const shared = (name) => { const dir = path.join(tmp, name); fs.mkdirSync(dir); return dir; };
const rows = (dir) => fs.existsSync(path.join(dir, 'autoupdate')) ? fs.readdirSync(path.join(dir, 'autoupdate')).filter(f => f.endsWith('.json')).map(f => ({ file: path.join(dir, 'autoupdate', f), ...JSON.parse(fs.readFileSync(path.join(dir, 'autoupdate', f))) })) : [];
const state = (dir, repo) => rows(dir).find(row => row.checkout === fs.realpathSync(repo));
const run = (repo, dir, args = [], extra = {}) => {
  const started = performance.now();
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/skill-autoupdate.mjs'), ...args],
    { env: { ...env, RULES_SHARED: dir, ...extra }, encoding: 'utf8', timeout: 7000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  return { ms: performance.now() - started, rows: result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse) };
};
const until = async (predicate, label) => {
  const end = Date.now() + 40000;
  while (!predicate()) { assert.ok(Date.now() < end, `timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const fetched = async (dir, repos) => until(() => repos.every(repo => state(dir, repo)?.fetch?.status === 'finished'
  && !fs.existsSync(state(dir, repo).file.replace(/\.json$/, '.lock'))), 'fetch complete');
const idle = async (dir) => until(() => !fs.existsSync(path.join(dir, 'autoupdate')) || !fs.readdirSync(path.join(dir, 'autoupdate')).some(f => f.endsWith('.lock')), 'background exits');
let passed = 0, complete = false;
const ok = (label) => { passed++; console.log(`PASS ${label}`); };
try {
  const normal = clone(path.join(tmp, 'normal')), normalShared = shared('normal-shared');
  const tip = commit(seed, 'new upstream'); git(seed, 'push', 'origin', 'main');
  const first = run(normal, normalShared); assert.ok(first.rows.length, `no checkout discovered: ${JSON.stringify(rows(normalShared))}`);
  assert.ok(first.rows[0].fetching, JSON.stringify(first.rows)); assert.equal(head(normal), base, 'launching fetch never applies in background');
  await fetched(normalShared, [normal]); assert.equal(head(normal), base);
  run(normal, normalShared); assert.equal(head(normal), tip);
  const update = fs.readFileSync(path.join(normalShared, 'autoupdate.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(r => r.result === 'updated');
  assert.equal(update.from, base); assert.equal(update.to, tip); assert.ok(update.host); assert.ok(Date.parse(update.time));
  ok('completed fetch fast-forwards on next start and records from/to/time/host');

  const stamp = state(normalShared, normal).lastFetch;
  const next = commit(seed, 'second upstream'); git(seed, 'push', 'origin', 'main');
  run(normal, normalShared); assert.equal(state(normalShared, normal).lastFetch, stamp); assert.equal(head(normal), tip);
  const old = state(normalShared, normal); old.lastFetch -= 600001; fs.writeFileSync(old.file, JSON.stringify(old));
  run(normal, normalShared); await fetched(normalShared, [normal]); run(normal, normalShared); assert.equal(head(normal), next);
  ok('ten-minute throttle persists across invocations and expires');

  fs.writeFileSync(path.join(normal, 'content'), 'local edit');
  run(normal, normalShared); assert.equal(state(normalShared, normal).lastResult.result, 'skipped: dirty checkout');
  assert.equal(fs.readFileSync(path.join(normal, 'content'), 'utf8'), 'local edit');
  // Fixture-only restoration; the updater never restores/stashes/resets files.
  fs.writeFileSync(path.join(normal, 'content'), 'second upstream'); fs.writeFileSync(path.join(normal, 'untracked'), 'keep');
  run(normal, normalShared); assert.equal(state(normalShared, normal).lastResult.result, 'skipped: dirty checkout');
  fs.unlinkSync(path.join(normal, 'untracked')); ok('tracked and untracked dirtiness are skipped without touching files');

  const collision = clone(path.join(tmp, 'collision')), collisionShared = shared('collision-shared'), collisionHead = head(collision);
  fs.appendFileSync(path.join(collision, '.git/info/exclude'), '\n/collision\n'); fs.writeFileSync(path.join(collision, 'collision'), 'local ignored file');
  assert.equal(git(collision, 'status', '--porcelain'), '');
  fs.writeFileSync(path.join(seed, 'collision'), 'upstream tracked file'); commit(seed, 'ignored collision upstream'); git(seed, 'push', 'origin', 'main');
  run(collision, collisionShared); await fetched(collisionShared, [collision]); run(collision, collisionShared);
  assert.equal(head(collision), collisionHead); assert.equal(fs.readFileSync(path.join(collision, 'collision'), 'utf8'), 'local ignored file');
  assert.match(state(collisionShared, collision).lastResult.result, /fast-forward refused/);
  ok('fast-forward never overwrites an ignored local file that becomes tracked upstream');

  const lockFile = state(normalShared, normal).file.replace(/\.json$/, '.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'fixture-lock' }));
  assert.equal(run(normal, normalShared).rows[0].result, 'skipped: locked');
  assert.equal(JSON.parse(fs.readFileSync(lockFile)).token, 'fixture-lock'); fs.unlinkSync(lockFile);
  const indexLock = git(normal, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'); fs.writeFileSync(indexLock, '');
  run(normal, normalShared); assert.equal(state(normalShared, normal).lastResult.result, 'skipped: git index locked'); fs.unlinkSync(indexLock);
  ok('live updater lock and owner Git index lock are respected');

  const diverged = clone(path.join(tmp, 'diverged')), divergedShared = shared('diverged-shared');
  const local = commit(diverged, 'local side'); commit(seed, 'remote side'); git(seed, 'push', 'origin', 'main');
  run(diverged, divergedShared); await fetched(divergedShared, [diverged]); run(diverged, divergedShared);
  assert.equal(head(diverged), local); assert.equal(state(divergedShared, diverged).lastResult.result, 'skipped: diverged checkout');
  ok('diverged branches are skipped without a merge commit');

  const ahead = clone(path.join(tmp, 'ahead')), aheadShared = shared('ahead-shared'); const aheadTip = commit(ahead, 'ahead');
  run(ahead, aheadShared); await fetched(aheadShared, [ahead]); run(ahead, aheadShared); assert.equal(head(ahead), aheadTip);
  assert.match(state(aheadShared, ahead).lastResult.result, /never moves backwards/);
  // Force the fixture remote backwards to prove a fetched rewind cannot reset HEAD.
  git(seed, 'push', '--force', 'origin', `${base}:main`);
  const aged = state(normalShared, normal); aged.lastFetch = 1; fs.writeFileSync(aged.file, JSON.stringify(aged));
  run(normal, normalShared); await fetched(normalShared, [normal]); run(normal, normalShared); assert.equal(head(normal), next);
  assert.match(state(normalShared, normal).lastResult.result, /never moves backwards/);
  git(seed, 'push', '--force', 'origin', 'main'); ok('local-ahead and remote-rewind cases never move HEAD backwards');

  const feature = clone(path.join(tmp, 'feature')), featureShared = shared('feature-shared'); git(feature, 'switch', '-c', 'work');
  run(feature, featureShared); assert.match(state(featureShared, feature).lastResult.result, /branch work/); assert.equal(state(featureShared, feature).lastFetch, undefined);
  git(feature, 'switch', '--detach'); run(feature, featureShared); assert.match(state(featureShared, feature).lastResult.result, /detached non-submodule/);
  ok('feature branches and detached standalone checkouts are skipped');

  const home = path.join(tmp, 'macbook'), one = clone(path.join(home, '.agents/skills/project-orchestrator')),
    two = clone(path.join(home, '.claude/skills/project-orchestrator')), copiesShared = shared('copies-shared');
  const copiesTip = commit(seed, 'copies update'); git(seed, 'push', 'origin', 'main');
  run(one, copiesShared); await fetched(copiesShared, [one, two]); run(one, copiesShared);
  assert.equal(head(one), copiesTip); assert.equal(head(two), copiesTip);
  const third = clone(path.join(tmp, 'configured')), configTip = commit(seed, 'config update'); git(seed, 'push', 'origin', 'main');
  fs.writeFileSync(path.join(copiesShared, 'autoupdate.json'), JSON.stringify({ checkouts: [path.relative(copiesShared, third), third] }));
  run(one, copiesShared); await fetched(copiesShared, [third]); run(one, copiesShared); assert.equal(head(third), configTip);
  assert.equal(rows(copiesShared).filter(row => row.checkout === third).length, 1);
  ok('two-copy layout and optional relative/absolute checkouts discovered and deduplicated');

  const parentSeed = path.join(tmp, 'parent-seed'); fs.mkdirSync(parentSeed); git(parentSeed, 'init', '-b', 'main');
  git(parentSeed, 'submodule', 'add', remote, 'project-orchestrator'); git(parentSeed, 'commit', '-am', 'submodule');
  const parentRemote = path.join(tmp, 'parent.git'); git(tmp, 'clone', '--bare', parentSeed, parentRemote); git(parentSeed, 'remote', 'add', 'origin', parentRemote);
  const parent = clone(path.join(tmp, 'mini/.agents/skills'), parentRemote); git(parent, 'submodule', 'update', '--init');
  const sub = path.join(parent, 'project-orchestrator'), subShared = shared('sub-shared');
  const subTip = commit(seed, 'submodule update'); git(seed, 'push', 'origin', 'main');
  git(path.join(parentSeed, 'project-orchestrator'), 'fetch', 'origin'); git(path.join(parentSeed, 'project-orchestrator'), 'merge', '--ff-only', 'origin/main');
  git(parentSeed, 'add', 'project-orchestrator'); git(parentSeed, 'commit', '-m', 'updated gitlink'); git(parentSeed, 'push', 'origin', 'main');
  const parentTip = head(parentSeed); assert.equal(git(sub, 'branch', '--show-current'), '');
  run(sub, subShared); await fetched(subShared, [parent, sub]); run(sub, subShared);
  assert.equal(head(parent), parentTip); assert.equal(head(sub), subTip); assert.equal(git(sub, 'branch', '--show-current'), '');
  assert.equal(git(parent, 'status', '--porcelain'), ''); ok('submodule parent first, detached submodule fast-forward, no checkout switch');

  const slow = clone(path.join(tmp, 'slow')), slowShared = shared('slow-shared'); commit(seed, 'slow update'); git(seed, 'push', 'origin', 'main');
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" fetch "*|*" merge "*) sleep 1.2;; esac\nexec '${realGit.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const start = performance.now();
  const hook = spawnSync(process.execPath, [path.join(slow, 'scripts/rules-digest-hook.mjs')],
    { env: { ...env, RULES_SHARED: slowShared, PATH: `${bin}:${env.PATH}` },
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'slow-session', session_title: 'Fixture 主对话' }), encoding: 'utf8', timeout: 1800 });
  const hookMs = performance.now() - start;
  assert.equal(hook.status, 0, hook.stderr); assert.equal(hook.stderr, '');
  assert.ok(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext.includes('Worker Rules'));
  assert.ok(hookMs < 600, `slow network must not block hook: ${hookMs}ms`);
  await until(() => ['running', 'finished'].includes(state(slowShared, slow)?.fetch?.status), 'detached coordinator launched fetch');
  await fetched(slowShared, [slow]);
  ok(`SessionStart returns digest promptly during detached slow fetch (${hookMs.toFixed(0)}ms)`);

  const beforeSlowMerge = head(slow), mergeStart = performance.now();
  const mergeHook = spawnSync(process.execPath, [path.join(slow, 'scripts/rules-digest-hook.mjs')],
    { env: { ...env, RULES_SHARED: slowShared, PATH: `${bin}:${env.PATH}` },
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'slow-session', session_title: 'Fixture 主对话' }), encoding: 'utf8', timeout: 1800 });
  assert.equal(mergeHook.status, 0, mergeHook.stderr); assert.ok(JSON.parse(mergeHook.stdout).hookSpecificOutput.additionalContext);
  assert.ok(performance.now() - mergeStart < 600, 'slow local fast-forward must not block SessionStart');
  assert.equal(head(slow), beforeSlowMerge, 'slow mutation is still pending when hook returns');
  const slowTip = head(seed);
  await until(() => head(slow) === slowTip, 'fast-forward completes after hook exit'); await idle(slowShared);
  assert.equal(git(slow, 'status', '--porcelain'), '');
  assert.equal(state(slowShared, slow).lastResult.result, 'updated');
  ok('next SessionStart applies completed fetch; slow fast-forward survives hook exit with its lock');

  const failed = clone(path.join(tmp, 'failed')), failedShared = shared('failed-shared'); git(failed, 'remote', 'set-url', 'origin', path.join(tmp, 'absent.git'));
  run(failed, failedShared); await until(() => state(failedShared, failed)?.fetch?.status === 'failed', 'failed fetch'); await idle(failedShared);
  const beforeFailure = head(failed); run(failed, failedShared); assert.equal(head(failed), beforeFailure);
  assert.match(state(failedShared, failed).lastResult.result, /successful fetch required/);
  ok('fetch errors are logged, throttled and never apply stale refs');

  const status = run(normal, normalShared, ['--status']).rows[0];
  assert.equal(status.current, head(normal)); assert.equal(status['origin/main'], git(normal, 'rev-parse', 'origin/main'));
  assert.ok(Date.parse(status.lastFetch)); assert.ok(status.lastResult); assert.equal(status.fetch.status, 'finished');
  ok('--status reports per-checkout local/tracking SHA, fetch time and last result');
  console.log(`All ${passed} skill-autoupdate scenarios passed`);
  complete = true;
} finally {
  // All detached fixture fetches have a completion/lock handoff contract.
  for (const dir of fs.readdirSync(tmp).map(name => path.join(tmp, name))) {
    if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'autoupdate'))) await idle(dir);
  }
  if (complete) fs.rmSync(tmp, { recursive: true, force: true });
  else console.error(`Fixture evidence retained: ${tmp}`);
}
