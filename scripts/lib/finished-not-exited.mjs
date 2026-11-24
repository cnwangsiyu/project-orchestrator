import fs from 'node:fs';
import path from 'node:path';

export const FINISHED_NOT_EXITED_MINUTES = 15;

export const finishedNotExitedMinutes = (env = process.env) => {
  const value = env.CODEX_WORKER_FINISHED_NOT_EXITED_MIN;
  if (value === undefined || value === '') return FINISHED_NOT_EXITED_MINUTES;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : FINISHED_NOT_EXITED_MINUTES;
};

const regularFile = (file) => {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat : null;
  } catch { return null; }
};

const finalMessage = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return false;
    const bytes = Buffer.alloc(512), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return /^(?:\s*(?:\[[^\]]+\]\s*)?)(?:DONE|BLOCKED)\b/i.test(bytes.subarray(0, count).toString('utf8'));
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
};

const evidenceFiles = (row) => {
  const taskDir = typeof row.taskDir === 'string' ? path.resolve(row.taskDir) : null;
  const files = [];
  if (typeof row.outFile === 'string') files.push(path.resolve(row.outFile));
  if (taskDir) files.push(path.join(taskDir, 'codex-last.md'), path.join(taskDir, 'report.md'));
  return [...new Set(files)];
};

// A final artifact is authoritative only when it is the latest worker activity.
// This keeps a report retained from an earlier continuation from retiring a live run.
export const finishedNotExited = (row, { now = Date.now(), minutes = finishedNotExitedMinutes() } = {}) => {
  const lastActivityAt = Number(row.lastActivityAt ?? row.t);
  if (!Number.isFinite(lastActivityAt) || !Number.isFinite(now) || !Number.isFinite(minutes) || minutes < 0) return null;
  for (const file of evidenceFiles(row)) {
    const stat = regularFile(file);
    if (!stat || !Number.isFinite(stat.mtimeMs) || stat.mtimeMs < lastActivityAt) continue;
    const textFinal = finalMessage(file);
    const newerThanActivity = stat.mtimeMs > lastActivityAt;
    if (!newerThanActivity && !textFinal) continue;
    const inactiveMs = Math.max(0, now - stat.mtimeMs);
    if (inactiveMs < minutes * 60_000) continue;
    return { file, completedAt: stat.mtimeMs, lastActivityAt, inactiveMs, minutes, textFinal };
  }
  return null;
};

export const retireCommand = (row, script = 'scripts/codex-worker.mjs') =>
  `node ${script} --account ${row.account ?? 'main'} retire --run ${row.runId} --owner ${row.owner}`;
