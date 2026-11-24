#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkedMaskPath } from './lib/masking-scope.mjs';
import { readLogText } from './lib/log-redaction.mjs';
import { unsafeFile } from './lib/resource-data.mjs';

function git(repo, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) delete env[name];
  const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 2 ** 20 });
  if (result.error || result.status !== 0) throw Error('detector git query failed');
  return result.stdout;
}

const signature = lines => createHash('sha256').update(lines.join('\n')).digest('hex');

// Snapshot mode enumerates a named directory without consulting Git's index.
function* snapshotFiles(root, exhausted, skipped) {
  const pending = [''];
  while (pending.length && !exhausted()) {
    const relative = pending.pop();
    let dir;
    try {
      dir = fs.opendirSync(checkedMaskPath(path.join(root, relative)));
      let entry;
      while (!exhausted() && (entry = dir.readSync())) {
        if (entry.name === '.git') continue;
        const name = path.join(relative, entry.name);
        if (unsafeFile(path.join(root, name)) || /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.kube|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key|keystore|jks))$/i.test(entry.name)) {
          skipped.push(name);
        } else if (entry.isDirectory()) pending.push(name);
        else if (entry.isFile()) yield name;
        else skipped.push(name);
      }
    } catch { skipped.push(relative || '.'); }
    finally { if (dir) dir.closeSync(); }
  }
}

export function findMaskArtifacts(repo, directories = [], { allUntrackedText = false, snapshot = false, maxDurationMs = 10000,
  maxBytes = 64 * 2 ** 20, maxFiles = 10000, maxFileBytes = 2 * 2 ** 20 } = {}) {
  const started = Date.now();
  repo = checkedMaskPath(repo);
  let root = repo;
  if (snapshot) {
    if (!fs.lstatSync(root).isDirectory() || unsafeFile(root)) throw Error('--snapshot-dir requires a safe named directory');
    if (directories.length || allUntrackedText) throw Error('--snapshot-dir cannot be combined with git scan options');
  } else {
    if (git(repo, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') throw Error('--repo must be a git worktree');
    root = checkedMaskPath(git(repo, ['rev-parse', '--show-toplevel']).trim());
  }
  const findings = [], skipped = [], groups = new Map();
  let scannedFiles = 0, scannedBytes = 0, bounded = false;
  for (const cached of snapshot ? [] : [false, true]) {
    const flags = cached ? ['--cached'] : [];
    const names = git(root, ['diff', ...flags, '--name-only', '-z', '--no-ext-diff', '--no-textconv']).split('\0').filter(Boolean);
    for (const name of names) {
      if (unsafeFile(path.join(root, name))) { skipped.push(name); continue; }
      const diff = git(root, ['diff', ...flags, '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '--', name]);
      const lines = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++') && line.includes('[MASKED'));
      if (lines.length) findings.push({ kind: cached ? 'staged' : 'tracked', file: name, count: lines.length, signature: signature(lines) });
    }
  }
  const relativeDirectories = directories.map(input => {
    const directory = checkedMaskPath(path.resolve(repo, input)), relative = path.relative(root, directory);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
      throw Error('untracked scans require named subdirectories inside --repo');
    if (!fs.lstatSync(directory).isDirectory()) throw Error('untracked scan target is not a directory');
    return relative;
  });
  if (snapshot || relativeDirectories.length || allUntrackedText) {
    // Explicit directories include ignored dependency fixtures; git's inventory
    // keeps tracked files out, without following directory links ourselves.
    const exhausted = () => {
      if (Date.now() - started >= maxDurationMs || scannedFiles >= maxFiles || scannedBytes >= maxBytes) bounded = true;
      return bounded;
    };
    const names = snapshot ? snapshotFiles(root, exhausted, skipped)
      : git(root, ['ls-files', '--others', '-z', '--', ...relativeDirectories]).split('\0').filter(Boolean);
    for (const name of names) {
      if (allUntrackedText && !/\.(?:txt|log)$/i.test(name)) continue;
      if (exhausted()) break;
      const file = path.join(root, name);
      if (unsafeFile(file)) { skipped.push(name); continue; }
      try {
        checkedMaskPath(file);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > maxFileBytes || scannedBytes + stat.size > maxBytes) { skipped.push(name); continue; }
        const content = readLogText(file, stat);
        scannedFiles++; scannedBytes += stat.size;
        if (snapshot && content.includes('\0')) { skipped.push(name); continue; }
        const lines = content.split('\n').filter(line => line.includes('[MASKED'));
        if (lines.length) findings.push({ kind: snapshot ? 'snapshot' : 'untracked', file: name, count: lines.length, signature: signature(lines) });
      } catch { skipped.push(name); }
    }
  }
  for (const item of findings) {
    const directory = item.file.includes('/') ? item.file.split('/')[0] : '.';
    const group = groups.get(directory) || { directory, files: new Set(), count: 0 };
    group.files.add(item.file); group.count += item.count; groups.set(directory, group);
  }
  return { findings, skipped: [...new Set(skipped)], bounded, scannedFiles, scannedBytes,
    groups: [...groups.values()].map(group => ({ directory: group.directory, files: group.files.size, count: group.count })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), directories = []; let repo, snapshotDir, textLogs = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--text-logs') { textLogs = true; continue; }
      if (args[i] === '--repo' && !repo) repo = args[i + 1];
      else if (args[i] === '--snapshot-dir' && !snapshotDir) snapshotDir = args[i + 1];
      else if (['--untracked-dir', '--dir'].includes(args[i])) directories.push(args[i + 1]);
      else throw Error('usage: find-mask-artifacts.mjs (--repo PATH [--untracked-dir SUBDIR]... [--text-logs] | --snapshot-dir PATH)');
      if (!args[i + 1]) throw Error('missing option value');
      i++;
    }
    if (Boolean(repo) === Boolean(snapshotDir)) throw Error('specify exactly one of --repo or --snapshot-dir');
    const { findings, skipped, bounded, groups } = findMaskArtifacts(snapshotDir || repo, directories, { allUntrackedText: textLogs, snapshot: Boolean(snapshotDir) });
    for (const item of findings) console.log(`${item.kind}\t${JSON.stringify(item.file)}\t${item.count}`);
    for (const file of skipped) console.log(`skipped\t${JSON.stringify(file)}\t1`);
    for (const group of groups) console.log(`directory\t${JSON.stringify(group.directory)}\tfiles=${group.files}\tlines=${group.count}`);
    console.log(`mask-artifacts: files=${new Set(findings.map(item => item.file)).size} lines=${findings.reduce((n, item) => n + item.count, 0)} skipped=${skipped.length} bounded=${bounded}`);
    process.exitCode = findings.length ? 1 : skipped.length || bounded ? 2 : 0;
  } catch (error) { console.error(`find-mask-artifacts: ${error.message}`); process.exitCode = 2; }
}
