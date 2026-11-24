import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const markerName = '.mask-output-owner.json';
const owned = new Map();
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const gitEnv = { ...process.env };
gitEnv.GIT_OPTIONAL_LOCKS = '0';
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete gitEnv[name];

function git(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], { env: gitEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal) throw Error('masking scope: git path check unavailable');
  return result;
}

// Reject aliases before reading or writing. Darwin's fixed system aliases are
// not caller-created links; all links below them still receive this check.
export function checkedMaskPath(input) {
  const file = path.resolve(input);
  let dir = path.parse(file).root;
  for (const part of file.slice(dir.length).split(path.sep).filter(Boolean)) {
    dir = path.join(dir, part);
    let stat;
    try { stat = fs.lstatSync(dir); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() && !(process.platform === 'darwin'
        && ['/var', '/tmp'].includes(dir) && fs.realpathSync(dir) === '/private' + dir))
      throw Error(`masking scope: symlink target or ancestor refused: ${dir}`);
  }
  let existing = file, suffix = [];
  while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
  return path.join(fs.realpathSync(existing), ...suffix);
}

export function worktreeFor(input) {
  const lexical = path.resolve(input), file = checkedMaskPath(lexical);
  let dir = fs.existsSync(file) && fs.lstatSync(file).isDirectory() ? file : path.dirname(file);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  let suspicious = lexical.split(path.sep).includes('.worktrees') || file.split(path.sep).includes('.worktrees');
  for (let parent = dir;; parent = path.dirname(parent)) {
    if (fs.existsSync(path.join(parent, '.git')) || path.basename(parent) === '.git') suspicious = true;
    if (parent === path.dirname(parent)) break;
  }
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status === 0 && inside.stdout.trim() === 'true') {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) throw Error('masking scope: cannot determine worktree root');
    return { root: checkedMaskPath(top.stdout.trim()), file };
  }
  if (inside.status !== 0 && !/not a git repository/i.test(inside.stderr))
    throw Error('masking scope: git worktree status unknown');
  return suspicious ? { root: null, file } : null;
}

function readOwner(directory) {
  const marker = path.join(directory, markerName);
  const stat = fs.lstatSync(directory), markerStat = fs.lstatSync(marker);
  if (!stat.isDirectory() || !markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096)
    throw Error('masking scope: invalid output ownership marker');
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (typeof owner.runId !== 'string' || !owner.runId || owner.dev !== stat.dev || owner.ino !== stat.ino)
    throw Error('masking scope: output directory ownership changed');
  return owner;
}

function verifyScope(scope) {
  if (!scope?.directory || !scope?.runId) throw Error('masking scope: directory is not owned by this run');
  const directory = checkedMaskPath(scope.directory);
  if (readOwner(directory).runId !== scope.runId) throw Error('masking scope: output directory ownership changed');
  return directory;
}

// Only an explicitly named regular file may recover its scope across processes.
export function markedFileScope(input) {
  const tree = worktreeFor(input);
  if (!tree?.root || !fs.lstatSync(tree.file).isFile()) return undefined;
  for (let dir = path.dirname(tree.file); within(tree.root, dir) && dir !== tree.root; dir = path.dirname(dir)) {
    if (!fs.existsSync(path.join(dir, markerName))) continue;
    if (!isIgnored(tree.root, dir, true)) throw Error('masking scope: marked directory is not git-ignored');
    return { directory: dir, runId: readOwner(dir).runId };
  }
}

function ownScope(file, scope) {
  if (scope) {
    const directory = verifyScope(scope);
    if (!within(directory, file)) throw Error('masking scope: target is outside this run output directory');
    return directory;
  }
  for (const candidate of owned.values()) {
    if (within(candidate.directory, file)) return verifyScope(candidate);
  }
  return null;
}

function isIgnored(root, file, directory = false) {
  const relative = './' + path.relative(root, file) + (directory ? '/' : '');
  return git(root, ['check-ignore', '--quiet', '--no-index', '--', relative]).status === 0;
}

export function assertMaskTarget(input, { scope, collection = false } = {}) {
  const file = checkedMaskPath(input), tree = worktreeFor(input);
  const directory = ownScope(file, scope);
  if (tree) {
    if (!tree.root || !directory) throw Error(`masking scope: target is inside a git worktree: ${input}`);
    const relative = path.relative(tree.root, file);
    const tracked = git(tree.root, ['--literal-pathspecs', 'ls-files', '-z', '--', relative]);
    if (tracked.status !== 0 || tracked.stdout.length)
      throw Error(`masking scope: tracked target is never permitted: ${input}`);
    if (!isIgnored(tree.root, file))
      throw Error(`masking scope: run output is not git-ignored: ${input}`);
  }
  if (collection && !directory) {
    if (!fs.lstatSync(file).isDirectory() || fs.readdirSync(file).length)
      throw Error(`masking scope: collection directory must be empty or owned by this run: ${input}`);
  }
  return file;
}

function canClaimWorktreeDirectory(tree, directory) {
  if (!tree.root || directory === tree.root || !within(tree.root, directory)) return false;
  const relative = path.relative(tree.root, directory);
  const tracked = git(tree.root, ['--literal-pathspecs', 'ls-files', '-z', '--', relative]);
  return tracked.status === 0 && !tracked.stdout.length
    && isIgnored(tree.root, directory, true);
}

export function claimOutputDirectory(input, { runId = randomUUID() } = {}) {
  const directory = checkedMaskPath(input), tree = worktreeFor(input);
  if (tree && !canClaimWorktreeDirectory(tree, directory))
    throw Error(`masking scope: output directory is inside a git worktree: ${input}`);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw Error(`masking scope: output directory is not new/empty: ${input}`);
  const stat = fs.lstatSync(directory), scope = { directory, runId };
  fs.writeFileSync(path.join(directory, markerName), JSON.stringify({ runId, dev: stat.dev, ino: stat.ino }) + '\n', { flag: 'wx', mode: 0o600 });
  owned.set(directory, scope);
  assertMaskTarget(directory, { scope, collection: true });
  return scope;
}

export function safeTempRoot() {
  let tempRoot = fs.realpathSync(os.tmpdir());
  if (worktreeFor(tempRoot)) tempRoot = fs.realpathSync('/tmp');
  if (worktreeFor(tempRoot)) throw Error('masking scope: no safe temporary output directory');
  return tempRoot;
}

export function prepareRunOutput(input, { prefix = 'masked-run-', warn = text => console.error(text) } = {}) {
  const requested = input ? path.resolve(input) : null;
  if (requested) {
    const tree = worktreeFor(requested);
    if (!tree || (canClaimWorktreeDirectory(tree, tree.file)
        && (!fs.existsSync(tree.file) || (fs.lstatSync(tree.file).isDirectory() && !fs.readdirSync(tree.file).length))))
      return claimOutputDirectory(requested);
  }
  const directory = fs.mkdtempSync(path.join(safeTempRoot(), prefix));
  const scope = claimOutputDirectory(directory);
  if (requested) warn(`masking scope: worktree output redirected; requested=${requested} output=${scope.directory}`);
  return scope;
}

export function scopeForDirectory(directory, runId) {
  const scope = { directory, runId };
  verifyScope(scope);
  return scope;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== 'check-new-file') throw Error('usage: masking-scope.mjs check-new-file FILE');
    const file = process.argv[3];
    assertMaskTarget(file);
    if (fs.existsSync(file)) throw Error('masking scope: capture output must be a new file');
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
