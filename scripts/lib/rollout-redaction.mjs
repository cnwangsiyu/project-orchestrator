import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedLogStat, sameLog, readLogText } from './log-redaction.mjs';
import { maskLogText } from './nightly-audit.mjs';

const snapshotType = 'worker_redaction_snapshot';
// Neither the rollout prefix nor the JSONL extension is exposed to provider discovery.
export const maskedRolloutFile = file => path.join(path.dirname(file), `.worker-redacted-${path.basename(file)}.out`);
const identity = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(field => [field, stat[field]]));

const snapshotSource = (file, stat) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!sameLog(stat, fs.fstatSync(fd))) throw Error('rollout snapshot changed');
    const buffer = Buffer.alloc(1024), n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, n).toString('utf8').split('\n')[0]);
    if (header.type !== snapshotType || !header.source) throw Error('not a worker rollout snapshot');
    return header.source;
  } finally { fs.closeSync(fd); }
};

// A fresh masked snapshot is for our readers only. The provider's durable file
// must remain byte-identical, even when a completed/retired thread is resumed.
export function rolloutReadPath(file) {
  if (!file?.endsWith('.jsonl')) return file;
  try {
    const source = checkedLogStat(file), copy = maskedRolloutFile(file), stat = checkedLogStat(copy);
    if (sameLog(source, snapshotSource(copy, stat)) && sameLog(source, checkedLogStat(file))) return copy;
  } catch { /* A missing or stale snapshot must not hide newly appended turns. */ }
  return file;
}

export function redactRolloutFile(file, { expected } = {}) {
  if (!file?.endsWith('.jsonl')) throw Error('unsafe rollout path');
  const stat = checkedLogStat(file);
  if (expected && !sameLog(expected, stat)) throw Error('rollout changed after idle check');
  const result = maskLogText(readLogText(file, stat), { jsonl: true });
  const copy = maskedRolloutFile(file);
  const text = JSON.stringify({ type: snapshotType, source: identity(stat) }) + '\n' + result.text;
  let prior;
  try {
    prior = checkedLogStat(copy);
    snapshotSource(copy, prior);
    if (readLogText(copy, prior) === text) return { file: copy, masked: 0, lines: result.lines };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmp = path.join(path.dirname(copy), `.${path.basename(copy)}.${randomUUID()}.tmp`);
  let fd, created = false;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600); created = true;
    fs.writeFileSync(fd, text);
    fs.futimesSync(fd, stat.atime, stat.mtime);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (!sameLog(stat, checkedLogStat(file))) throw Error('rollout changed before snapshot publication');
    if (prior ? !sameLog(prior, checkedLogStat(copy)) : fs.existsSync(copy)) throw Error('rollout snapshot changed before publication');
    fs.renameSync(tmp, copy);
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { if (created) fs.rmSync(tmp, { force: true }); }
  }
  return { file: copy, masked: result.masked, lines: result.lines };
}
