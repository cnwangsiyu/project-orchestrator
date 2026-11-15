import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rulesShared, SKILL_ROOT } from './global-rules.mjs';

export const readSmall = async (file, limit = 65536) => {
  let fd;
  try {
    fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > limit) return '';
    const buf = Buffer.alloc(stat.size);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { if (fd) await fd.close().catch(() => {}); }
};

const transcriptHint = async (file) => {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return false;
  let fd;
  try {
    const actual = await fs.realpath(file);
    const roots = [path.join(os.homedir(), '.claude/projects'),
      ...(process.env.CLAUDE_CONFIG_DIR ? [path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')] : [])];
    const canonical = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => null)));
    if (!canonical.some((root) => root && actual.startsWith(`${root}${path.sep}`))) return false;
    fd = await fs.open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (!stat.isFile()) return false;
    const n = Math.min(stat.size, 16384), head = Buffer.alloc(n), tail = Buffer.alloc(n);
    const reads = await Promise.all([fd.read(head, 0, n, 0), fd.read(tail, 0, n, Math.max(0, stat.size - n))]);
    return [head, tail].some((part, i) => /project-orchestrator\/SKILL\.md|# project-orchestrator/.test(part.subarray(0, reads[i].bytesRead).toString()));
  } catch { return false; } finally { if (fd) await fd.close().catch(() => {}); }
};

export const orchestrator = async (input, seen) => {
  if (seen[input.session_id]?.orchestrator) return true;
  const title = input.session_title ?? input.session_name ?? input.title ?? input.name;
  if (typeof title === 'string' && /主对话$/.test(title.trim())) return true;
  if (typeof input.cwd === 'string' && path.resolve(input.cwd) === SKILL_ROOT) return true;
  const roster = (await readSmall(path.join(rulesShared(), 'orchestrators.txt'))).split('\n')
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  return (typeof title === 'string' && roster.includes(title.trim())) || await transcriptHint(input.transcript_path);
};
