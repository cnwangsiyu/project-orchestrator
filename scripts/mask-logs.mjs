#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { checkedLogStat, readLogText, redactLogFile } from './lib/log-redaction.mjs';
import { maskLogText } from './lib/nightly-audit.mjs';
import { assertMaskTarget, scopeForDirectory, checkedMaskPath, worktreeFor, markedFileScope, safeTempRoot } from './lib/masking-scope.mjs';

const script = fileURLToPath(import.meta.url);
const extensions = /\.(?:log|txt|out)$/i;

function textLog(file, stat) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const sample = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    const bytes = sample.length ? fs.readSync(fd, sample, 0, sample.length, 0) : 0;
    const value = sample.subarray(0, bytes);
    if (value.includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(value); }
    catch { return false; }
    return true;
  } finally { fs.closeSync(fd); }
}

export function logFiles(inputs, { scope } = {}) {
  if (!inputs.length) throw Error('masking scope: explicit input path required; no cwd default');
  const files = [], pending = inputs.map(input => ({ file: path.resolve(input), required: true }));
  for (const input of inputs) {
    const stat = fs.lstatSync(path.resolve(input));
    assertMaskTarget(input, { scope, collection: stat.isDirectory() });
    if (!stat.isDirectory() && !stat.isFile()) throw Error(`masking scope: target is not a regular file: ${input}`);
  }
  while (pending.length) {
    const { file, required } = pending.pop();
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error.code === 'ENOENT' && !required) continue;
      if (error.code === 'ENOENT') throw Error(`path does not exist: ${file}`);
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      assertMaskTarget(file, { scope });
      let entries;
      try { entries = fs.readdirSync(file, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const child = path.join(file, entry.name);
        if (entry.isDirectory() || entry.isFile() && extensions.test(entry.name) || !entry.isFile())
          pending.push({ file: child, required: false });
      }
      continue;
    }
    if (!stat.isFile() || !extensions.test(file)) continue;
    assertMaskTarget(file, { scope });
    try {
      const checked = checkedLogStat(file);
      if (textLog(file, checked)) files.push(file);
    } catch (error) {
      if (!/too large|unsafe/.test(error.message)) throw error;
    }
  }
  return files.sort();
}

export function maskLogs(inputs, { dryRun = false, force = false, scope, taskDirectory,
  onRewritten = () => {}, onManifest = () => {} } = {}) {
  const results = [];
  if (!inputs.length) throw Error('masking scope: explicit input path required; no cwd default');
  const targets = new Map();
  for (const input of inputs) {
    const inputScope = scope ?? markedFileScope(input);
    for (const file of logFiles([input], { scope: inputScope })) targets.set(file, inputScope);
  }
  let manifest, fd;
  if (!dryRun) {
    const first = path.resolve(inputs[0]);
    const fallback = fs.lstatSync(first).isDirectory() ? first : path.dirname(first);
    const directory = checkedMaskPath(taskDirectory || process.env.CODEX_WORKER_TASK_DIR
      || (worktreeFor(fallback) ? safeTempRoot() : fallback));
    if (worktreeFor(directory)) throw Error('masking scope: rewrite manifest requires a task directory outside a git worktree');
    fs.mkdirSync(directory, { recursive: true });
    manifest = path.join(directory, `mask-rewrites-${randomUUID()}.txt`);
    assertMaskTarget(manifest);
    fd = fs.openSync(manifest, 'wx', 0o600);
    results.rewriteManifest = manifest;
  }
  try {
    for (const file of [...targets.keys()].sort()) {
      try {
        if (dryRun) {
          const stat = checkedLogStat(file);
          const result = maskLogText(readLogText(file, stat));
          results.push({ file, masked: result.masked, lines: result.lines });
        } else {
          const result = redactLogFile(file, { force, scope: targets.get(file) });
          results.push(result);
          if (result.masked) {
            fs.writeSync(fd, JSON.stringify(file) + '\n');
            fs.fsyncSync(fd);
            onRewritten(file);
          }
        }
      } catch (error) {
        throw Error(`${file}: ${error.message}`);
      }
    }
  } finally {
    if (fd !== undefined) {
      const empty = fs.fstatSync(fd).size === 0;
      fs.closeSync(fd);
      if (empty) {
        fs.unlinkSync(manifest);
        delete results.rewriteManifest;
      } else onManifest(manifest);
    }
  }
  return results;
}

function usage() {
  console.error('usage: node scripts/mask-logs.mjs [--dry-run] [--force] [--task-dir DIR] [--run-dir DIR --run-id ID] <dir-or-file>...; no cwd default; directories require this run ownership marker');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2); let dryRun = false, force = false;
  let runDirectory, runId, taskDirectory;
  while (args[0]?.startsWith('--')) {
    const option = args.shift();
    if (option === '--dry-run') dryRun = true;
    else if (option === '--force') force = true;
    else if (option === '--run-dir') runDirectory = args.shift();
    else if (option === '--run-id') runId = args.shift();
    else if (option === '--task-dir') taskDirectory = args.shift();
    else { process.exitCode = usage(); break; }
  }
  if (process.exitCode === undefined) {
    if (!args.length || dryRun && force || Boolean(runDirectory) !== Boolean(runId)) process.exitCode = usage();
    else {
      try {
        const scope = runDirectory ? scopeForDirectory(runDirectory, runId) : undefined;
        const results = maskLogs(args, { dryRun, force, scope, taskDirectory,
          onRewritten: file => console.log(file), onManifest: file => console.error(`mask-logs: rewrite manifest=${file}`) });
        if (dryRun) for (const result of results.filter(item => item.masked)) console.log(`${result.file}\t${result.masked}`);
      } catch (error) {
        console.error(`mask-logs: ${error.message}`); process.exitCode = 1;
      }
    }
  }
}
