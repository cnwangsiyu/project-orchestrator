#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedLogStat, readLogText, redactLogFile } from './lib/log-redaction.mjs';
import { maskLogText } from './lib/nightly-audit.mjs';

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

export function logFiles(inputs) {
  const files = [], pending = inputs.map(input => ({ file: path.resolve(input), required: true }));
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
    try {
      const checked = checkedLogStat(file);
      if (textLog(file, checked)) files.push(file);
    } catch (error) {
      if (!/too large|unsafe/.test(error.message)) throw error;
    }
  }
  return files.sort();
}

export function maskLogs(inputs, { dryRun = false, force = false } = {}) {
  const results = [];
  for (const file of logFiles(inputs)) {
    try {
      if (dryRun) {
        const stat = checkedLogStat(file);
        const result = maskLogText(readLogText(file, stat));
        results.push({ file, masked: result.masked, lines: result.lines });
      } else {
        results.push(redactLogFile(file, { force }));
      }
    } catch (error) {
      throw Error(`${file}: ${error.message}`);
    }
  }
  return results;
}

function usage() {
  console.error('usage: node scripts/mask-logs.mjs [--dry-run] [--force] <dir-or-file>...');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2); let dryRun = false, force = false;
  while (args[0]?.startsWith('--')) {
    const option = args.shift();
    if (option === '--dry-run') dryRun = true;
    else if (option === '--force') force = true;
    else { process.exitCode = usage(); break; }
  }
  if (process.exitCode === undefined) {
    if (!args.length || dryRun && force) process.exitCode = usage();
    else {
      try {
        for (const result of maskLogs(args, { dryRun, force }).filter(item => item.masked))
          console.log(`${result.file}\t${result.masked}`);
      } catch (error) {
        console.error(`mask-logs: ${error.message}`); process.exitCode = 1;
      }
    }
  }
}
