// Local repositories only. Both upstreams deliberately lack the commits the build needs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function makeSubmoduleFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', cwd, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function seed(name, file) {
    const repo = path.join(dir, name);
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, file), name);
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'seed');
    return repo;
  }
  const leaf = seed('leaf', 'payload'), upstream = seed('engine', 'version'), base = seed('app', 'app');
  git(upstream, 'submodule', 'add', leaf, 'nested');
  git(upstream, 'commit', '-qam', 'pin leaf');
  git(base, 'submodule', 'add', upstream, 'engine');
  git(base, 'commit', '-qam', 'pin published engine');
  const repo = path.join(dir, 'worktree-one'), other = path.join(dir, 'worktree-two');
  git(dir, 'clone', base, repo);
  git(repo, 'submodule', 'update', '--init', '--recursive');
  const engine = path.join(repo, 'engine');
  fs.writeFileSync(path.join(engine, 'version'), 'local-engine');
  git(engine, 'commit', '-qam', 'local engine only');
  git(repo, 'commit', '-qam', 'local app only');
  git(repo, 'worktree', 'add', '--detach', other, 'HEAD');
  git(other, '-c', 'submodule.engine.url=' + engine, 'submodule', 'update', '--init', '--recursive');
  // Normalized origin matches despite spelling, and cannot be used to fetch.
  git(engine, 'remote', 'set-url', 'origin', 'ssh://git@unreachable.invalid/fleet/engine.git');
  git(path.join(other, 'engine'), 'remote', 'set-url', 'origin', 'git@UNREACHABLE.invalid:fleet/engine.git');
  const commit = git(repo, 'rev-parse', 'HEAD'), pin = git(engine, 'rev-parse', 'HEAD');
  for (const [origin, id] of [[upstream, pin], [base, commit]]) {
    try { git(origin, 'cat-file', '-e', id); } catch { continue; }
    throw Error('fixture commit unexpectedly published');
  }
  return { repo, other, commit, pin, command: `test "$(git rev-parse HEAD)" = ${commit} && test "$(git -C engine rev-parse HEAD)" = ${pin} && test "$(cat engine/version)" = local-engine && test "$(cat engine/nested/payload)" = leaf && git rev-parse --git-common-dir && cat "$(git -C engine rev-parse --absolute-git-dir)/objects/info/alternates"` };
}
