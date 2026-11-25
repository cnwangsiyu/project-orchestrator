#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { checkedMaskPath } from './lib/masking-scope.mjs';
import { readLogText } from './lib/log-redaction.mjs';
import { unsafeFile } from './lib/resource-data.mjs';

const marker = '[MASKED';
const sampleLimit = 20;
const privateNames = ['auth', 'auth.*', 'cookie', 'cookie.*', 'cookies', 'cookies.*', 'credential', 'credential.*',
  'credentials', 'credentials.*', '.netrc', '.aws', '.ssh', 'keychain*', 'session.json', 'sessions.json', '.env', '.env.*'];
const unsafe = file => unsafeFile(file) || /(?:^|[/\\])(?:\.env(?:\.[^/]*)?|\.ssh)(?:$|[/\\])/i.test(file);
const privatePathspecs = privateNames.flatMap(name => [name, `${name}/**`].map(glob => `:(exclude,icase,glob)**/${glob}`));
const signature = lines => createHash('sha256').update(lines.join('\n')).digest('hex');
const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--no-renames', '--ignore-submodules=all'];

function gitQueries(repo, remaining, maxBuffer) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter);
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES',
    'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) delete env[name];
  return (label, args) => {
    const left = remaining();
    if (left <= 0) throw Error(`detector git query failed (${label}): timeout before start`);
    const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', maxBuffer,
      timeout: Number.isFinite(left) ? Math.min(2147483647, Math.ceil(left)) : 0, killSignal: 'SIGKILL' });
    const stderr = result.stderr || '';
    const lfs = /git-lfs[^\n]*(?:not found|failed|error)|(?:error|fatal):[^\n]*(?:git-lfs|filter-process)|external filter[^\n]*failed/i.test(stderr);
    if (result.status !== 0 || result.error || lfs || remaining() <= 0) {
      const code = result.error?.code;
      const reason = code === 'ETIMEDOUT' || (!code && !lfs && result.status === 0) ? 'timeout'
        : code === 'ENOBUFS' ? 'output buffer exceeded (ENOBUFS)'
          : lfs ? `Git LFS/filter process ${/not found|no such file or directory/i.test(stderr) ? 'not found' : 'failed'} (exit ${result.status})`
            : code || (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
      // Git stderr can contain content supplied by filters or configuration.
      throw Error(`detector git query failed (${label}): ${reason}`);
    }
    return result.stdout;
  };
}

function hasGitMarker(dir) {
  try { fs.lstatSync(path.join(dir, '.git')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Walk only this snapshot, never an embedded checkout. Keep one open directory
// at a time, and check the budget even before reading a directory full of skips.
function* snapshotFiles(root, excluded, remaining, skip) {
  const pending = [''];
  while (pending.length) {
    const relative = pending.pop();
    const name = relative || '.';
    if (remaining() <= 0) { skip('budget-exhausted', name); return; }
    let dir;
    try {
      const directory = checkedMaskPath(path.join(root, relative));
      if (relative && hasGitMarker(directory)) { skip('nested-git-checkout', name); continue; }
      dir = fs.opendirSync(directory);
      for (let entry; (entry = dir.readSync());) {
        if (entry.name === '.git') continue;
        const file = path.join(relative, entry.name);
        if (excluded(file)) continue;
        if (remaining() <= 0) { skip('budget-exhausted', file); return; }
        if (entry.isSymbolicLink() || unsafe(file)) skip('symlink-or-unsafe-path', file);
        else if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile()) yield file;
        else skip('symlink-or-unsafe-path', file);
      }
    } catch { skip('unreadable-or-changed', name); }
    finally { if (dir) dir.closeSync(); }
  }
}

function inside(root, input, base = root) {
  const relative = path.relative(root, path.resolve(base, input));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw Error('scan paths require named subdirectories inside the scan root');
  return relative;
}

function inspectPatch(diff) {
  const markerLines = [];
  let hunk = false, hunkHasMarker = false, placeholderOnly = true;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@ ')) {
      if (hunk && !hunkHasMarker) placeholderOnly = false;
      hunk = true;
      hunkHasMarker = false;
    } else if (!hunk && /^(?:old mode |new mode |deleted file mode |new file mode |Binary files |GIT binary patch)/.test(line)) {
      placeholderOnly = false;
    } else if (hunk && line.startsWith('+')) {
      if (line.includes(marker)) { markerLines.push(line); hunkHasMarker = true; }
      else placeholderOnly = false;
    }
  }
  // A clean companion view is OK; a deletion-only hunk or metadata change is not.
  return { markerLines, placeholderOnly: !diff || (placeholderOnly && hunkHasMarker) };
}

export function findMaskArtifacts(repo, directories = [], { allUntrackedText = false, snapshot = false, excludes = [], restorePlan = false,
  maxDurationMs = Infinity, maxBytes = Infinity, maxFiles = Infinity, maxFileBytes = 2 * 2 ** 20,
  maxGitBuffer = 256 * 2 ** 20 } = {}) {
  const deadline = performance.now() + maxDurationMs;
  const remaining = () => deadline - performance.now();
  repo = checkedMaskPath(repo);
  if (unsafe(repo)) throw Error('unsafe scan root');
  let root = repo;
  const findings = [], restoration = [], groups = new Map(), skips = new Map();
  let scannedFiles = 0, scannedBytes = 0, bounded = false;
  const skip = (reason, file) => {
    if (reason === 'budget-exhausted') bounded = true;
    const group = skips.get(reason) || { reason, count: 0, names: [] };
    group.count++;
    if (group.names.length < sampleLimit) group.names.push(file);
    skips.set(reason, group);
  };
  if (restorePlan && (snapshot || directories.length || allUntrackedText)) throw Error('--restore-plan requires a tracked-only --repo scan');
  if (snapshot) {
    if (!fs.lstatSync(root).isDirectory()) throw Error('--snapshot-dir requires a safe named directory');
    if (directories.length || allUntrackedText) throw Error('--snapshot-dir cannot be combined with git scan options');
  } else if (remaining() > 0) {
    const query = gitQueries(repo, remaining, maxGitBuffer);
    if (query('rev-parse --is-inside-work-tree', ['rev-parse', '--is-inside-work-tree']).trim() !== 'true')
      throw Error('--repo must be a git worktree');
    root = checkedMaskPath(query('rev-parse --show-toplevel', ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, ''));
  }
  const excludedDirs = excludes.map(input => inside(root, input));
  const excluded = name => excludedDirs.some(dir => name === dir || name.startsWith(dir + path.sep));
  const repoPathspecs = [...privatePathspecs, ...excludedDirs.map(dir => `:(exclude,literal)${dir}`)];
  const query = gitQueries(root, remaining, maxGitBuffer);
  const relativeDirectories = directories.map(input => {
    const relative = inside(root, input, repo), directory = checkedMaskPath(path.join(root, relative));
    if (unsafe(directory) || !fs.lstatSync(directory).isDirectory()) throw Error('untracked scan target is not a safe directory');
    return relative;
  });

  let deletedFromIndex = [];
  if (remaining() <= 0) skip('budget-exhausted', '.');
  else if (!snapshot) {
    // Pickaxe once per index/worktree view. Only marker-bearing paths need
    // their patches inspected for the count and turn-end audit signature.
    const views = [false, true].map(cached => {
      const label = cached ? 'diff --cached' : 'diff';
      const flags = ['diff', ...(cached ? ['--cached'] : []), ...diffFlags];
      const names = query(`${label} -G --name-only`, [...flags, '-G\\[MASKED', '--name-only', '-z', '--', ...repoPathspecs]);
      return { kind: cached ? 'staged' : 'tracked', names: new Set(names.split('\0').filter(Boolean)), patch(name) {
        return inspectPatch(query(`${label} --unified=0`, [...flags, '--unified=0', '--inter-hunk-context=0', '--', `:(literal)${name}`]));
      } };
    });
    for (const name of new Set(views.flatMap(view => [...view.names]))) {
      if (excluded(name)) continue;
      try {
        if (unsafe(name)) { skip('symlink-or-unsafe-path', name); continue; }
        checkedMaskPath(path.join(root, name));
      } catch { skip('symlink-or-unsafe-path', name); continue; }
      const marked = [];
      let placeholderOnly = true;
      for (const view of views) {
        if (!restorePlan && !view.names.has(name)) continue;
        const patch = view.patch(name);
        placeholderOnly &&= patch.placeholderOnly;
        if (!patch.markerLines.length) continue;
        marked.push(view.kind);
        if (!restorePlan) findings.push({ kind: view.kind, file: name, count: patch.markerLines.length, signature: signature(patch.markerLines) });
      }
      if (restorePlan && placeholderOnly && marked.length) restoration.push({ file: name, views: marked });
    }
    // Some snapshot-style worktrees staged every path as deleted without
    // removing the files. These paths are in HEAD but not in the index, so
    // the pickaxe cannot see their on-disk content.
    if (!restorePlan) deletedFromIndex = query('diff --cached --diff-filter=D --name-only',
      ['diff', '--cached', ...diffFlags, '--diff-filter=D', '--name-only', '-z', '--', ...repoPathspecs]).split('\0').filter(Boolean);
  }

  function scanFiles(names, kind, alreadySeen = new Set()) {
    for (const entry of names) {
      const name = entry.replace(/\/$/, '');
      if (excluded(name) || alreadySeen.has(name)) continue;
      if (remaining() <= 0) { skip('budget-exhausted', name); break; }
      if (kind === 'untracked' && entry.endsWith('/')) { skip('nested-git-checkout', name); continue; }
      if (kind === 'untracked' && allUntrackedText && !/\.(?:txt|log)$/i.test(name)) continue;
      if (unsafe(name)) { skip('symlink-or-unsafe-path', name); continue; }
      let file, stat;
      try {
        const candidate = path.join(root, name);
        // Missing paths are expected for ordinary staged deletions; check
        // ancestors for symlinks before reading any surviving file.
        stat = fs.lstatSync(candidate);
        file = checkedMaskPath(candidate);
      } catch (error) {
        if (kind === 'index-deleted' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
        skip(error.message.startsWith('masking scope: symlink') ? 'symlink-or-unsafe-path' : 'unreadable-or-changed', name);
        continue;
      }
      if (!stat.isFile()) { skip('symlink-or-unsafe-path', name); continue; }
      if (stat.size > maxFileBytes) { skip('over-per-file-size', name); continue; }
      if (scannedFiles >= maxFiles || scannedBytes + stat.size > maxBytes) { skip('budget-exhausted', name); break; }
      scannedFiles++; scannedBytes += stat.size;
      let content;
      try { content = readLogText(file, stat); }
      catch { skip('unreadable-or-changed', name); continue; }
      if (content.includes('\0')) skip('binary-or-NUL', name);
      else if (content.includes(marker)) {
        const lines = content.split('\n').filter(line => line.includes(marker));
        findings.push({ kind, file: name, count: lines.length, signature: signature(lines) });
      }
    }
  }
  if (!bounded) scanFiles(deletedFromIndex, 'index-deleted');
  if (!bounded && snapshot) scanFiles(snapshotFiles(root, excluded, remaining, skip), 'snapshot');
  else if (!bounded && (relativeDirectories.length || allUntrackedText)) {
    // --others without --exclude-standard retains ignored dependencies. Git
    // emits embedded repositories as directory entries, not as child files.
    const names = query('ls-files --others', ['ls-files', '--others', '-z', '--', ...relativeDirectories.map(dir => `:(literal)${dir}`),
      ...repoPathspecs]).split('\0').filter(Boolean);
    scanFiles(names, 'untracked', new Set(deletedFromIndex));
  }
  for (const item of findings) {
    const directory = item.file.includes('/') ? item.file.split('/')[0] : '.';
    const group = groups.get(directory) || { directory, files: new Set(), count: 0 };
    group.files.add(item.file); group.count += item.count; groups.set(directory, group);
  }
  const skipReasons = [...skips.values()];
  return { root, findings, restoration, skipReasons, skippedCount: skipReasons.reduce((n, group) => n + group.count, 0), bounded,
    scannedFiles, scannedBytes, groups: [...groups.values()].map(group => ({ directory: group.directory, files: group.files.size, count: group.count })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), directories = [], options = { excludes: [] };
    const limits = { '--max-files': 'maxFiles', '--max-seconds': 'maxDurationMs', '--max-bytes': 'maxBytes' };
    let repo, snapshotDir;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--text-logs') { options.allUntrackedText = true; continue; }
      if (arg === '--restore-plan') { options.restorePlan = true; continue; }
      if (!['--repo', '--snapshot-dir', '--untracked-dir', '--dir', '--exclude', ...Object.keys(limits)].includes(arg))
        throw Error('usage: find-mask-artifacts.mjs (--repo PATH [--restore-plan | --untracked-dir SUBDIR ... --text-logs] | --snapshot-dir PATH) [--max-files N] [--max-seconds N] [--max-bytes N] [--exclude SUBDIR]...');
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`missing value for ${arg}`);
      if (arg === '--repo' && !repo) repo = value;
      else if (arg === '--snapshot-dir' && !snapshotDir) snapshotDir = value;
      else if (arg === '--untracked-dir' || arg === '--dir') directories.push(value);
      else if (arg === '--exclude') options.excludes.push(value);
      else if (limits[arg]) {
        const pattern = arg === '--max-seconds' ? /^\d+(?:\.\d+)?$/ : /^\d+$/;
        const n = Number(value) * (arg === '--max-seconds' ? 1000 : 1);
        if (!pattern.test(value) || !Number.isSafeInteger(Math.ceil(n)) || n <= 0) throw Error(`invalid value for ${arg}`);
        options[limits[arg]] = n;
      } else throw Error(`duplicate ${arg}`);
    }
    if (Boolean(repo) === Boolean(snapshotDir)) throw Error('specify exactly one of --repo or --snapshot-dir');
    const { root, findings, restoration, skipReasons, skippedCount, bounded, groups, scannedFiles, scannedBytes } =
      findMaskArtifacts(snapshotDir || repo, directories, { ...options, snapshot: Boolean(snapshotDir) });
    for (const item of findings) console.log(`${item.kind}\t${JSON.stringify(item.file)}\t${item.count}`);
    for (const { reason, count, names } of skipReasons) {
      console.log(`skipped\t${reason}\t${count}`);
      for (const name of names) {
        const advice = reason === 'nested-git-checkout' ? `\tscan separately with --repo ${JSON.stringify(path.resolve(root, name))}` : '';
        console.log(`skip-name\t${reason}\t${JSON.stringify(name)}${advice}`);
      }
    }
    for (const group of groups) console.log(`directory\t${JSON.stringify(group.directory)}\tfiles=${group.files}\tlines=${group.count}`);
    if (options.restorePlan) {
      console.log(`restore-plan: repo=${JSON.stringify(root)} files=${restoration.length}`);
      for (const item of restoration) console.log(`restore-candidate\t${JSON.stringify(item.file)}\t${item.views.join(',')}`);
    } else console.log(`mask-artifacts: files=${new Set(findings.map(item => item.file)).size} lines=${findings.reduce((n, item) => n + item.count, 0)} skipped=${skippedCount} bounded=${bounded} scanned-files=${scannedFiles} scanned-bytes=${scannedBytes}`);
    process.exitCode = bounded || skipReasons.some(group => group.reason === 'unreadable-or-changed') ? 2
      : findings.length || restoration.length ? 1 : skippedCount ? 2 : 0;
  } catch (error) { console.error(`find-mask-artifacts: ${error.message}`); process.exitCode = 2; }
}
