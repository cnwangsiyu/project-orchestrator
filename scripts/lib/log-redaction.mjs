import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { maskLogText } from './nightly-audit.mjs';
import { unsafeFile } from './resource-data.mjs';
import { assertMaskTarget } from './masking-scope.mjs';

export const sameLog = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function checkedLogStat(file, { markdown = false } = {}) {
  const extension = markdown ? /\.(?:log|out|txt|jsonl|md)$/ : /\.(?:log|out|txt|jsonl)$/;
  if (!file || !path.isAbsolute(file) || !extension.test(file) || unsafeFile(file)) throw Error('unsafe worker log path');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 2 ** 20 || unsafeFile(fs.realpathSync(file)))
    throw Error('worker log is unsafe or too large (limit 256 MiB)');
  return stat;
}

export function readLogText(file, stat) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!sameLog(stat, fs.fstatSync(fd))) throw Error('worker log changed before reading');
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    if (bytes !== stat.size || !sameLog(stat, fs.fstatSync(fd))) throw Error('worker log changed while reading');
    return buffer.subarray(0, bytes).toString('utf8');
  } finally { fs.closeSync(fd); }
}

export function redactLogFile(file, { force = false, markdown = false, expected, scope } = {}) {
  assertMaskTarget(file, { scope });
  const stat = checkedLogStat(file, { markdown });
  if (expected && !sameLog(expected, stat)) throw Error('worker log changed after idle check');
  if (!force && Date.now() - stat.mtimeMs < 120000)
    throw Error('worker log was modified in the last 120 s; wait for the turn to end or use --force');
  const result = maskLogText(readLogText(file, stat), { jsonl: file.endsWith('.jsonl') });
  if (result.masked) {
    assertMaskTarget(file, { scope });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    let output, created = false;
    try {
      output = fs.openSync(tmp, 'wx', 0o600); created = true;
      fs.writeFileSync(output, result.text);
      fs.fchmodSync(output, stat.mode & 0o777);
      fs.futimesSync(output, stat.atime, stat.mtime);
      fs.fsyncSync(output); fs.closeSync(output); output = undefined;
      if (!sameLog(stat, checkedLogStat(file, { markdown }))) throw Error('worker log changed before replacement');
      assertMaskTarget(file, { scope });
      fs.renameSync(tmp, file);
    } finally {
      try { if (output !== undefined) fs.closeSync(output); }
      finally { if (created) fs.rmSync(tmp, { force: true }); }
    }
  }
  return { file, masked: result.masked, lines: result.lines };
}
