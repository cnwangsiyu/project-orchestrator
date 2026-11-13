#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseDigest, rulesShared, SKILL_ROOT } from './lib/global-rules.mjs';

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
// Async disk operations cannot block this fail-open deadline (template timeout: 2s).
const deadline = setTimeout(() => process.exit(0), 700);

const readSmall = async (file, limit = 65536) => {
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

const orchestrator = async (input, seen) => {
  if (seen[input.session_id]?.orchestrator) return true;
  const title = input.session_title ?? input.session_name ?? input.title ?? input.name;
  if (typeof title === 'string' && /主对话$/.test(title.trim())) return true;
  if (typeof input.cwd === 'string' && path.resolve(input.cwd) === SKILL_ROOT) return true;
  const roster = (await readSmall(path.join(rulesShared(), 'orchestrators.txt'))).split('\n')
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  return (typeof title === 'string' && roster.includes(title.trim())) || await transcriptHint(input.transcript_path);
};

try {
  let raw = '';
  for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw Error('input too large'); }
  const input = JSON.parse(raw);
  if (!input || input.hook_event_name !== 'SessionStart' || !['startup', 'resume', 'compact'].includes(input.source)
    || typeof input.session_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(input.session_id)
    || ['__versions', '__proto__', 'constructor', 'prototype'].includes(input.session_id)) process.exit(0);
  const file = path.join(rulesShared(), 'rules-seen.json');
  let seen;
  try { seen = JSON.parse(await readSmall(file, 4 * 1024 * 1024)); } catch { seen = {}; }
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) seen = {};
  if (!await orchestrator(input, seen)) process.exit(0);
  const digest = parseDigest(await readSmall(process.env.RULES_DIGEST || path.join(SKILL_ROOT, 'references/global-rules.md')));
  const previous = seen[input.session_id];
  const oldLines = Array.isArray(seen.__versions?.[previous?.version]) ? seen.__versions[previous.version] : null;
  const lines = digest.text.split('\n');
  const additions = oldLines ? lines.filter((line) => line.startsWith('- ') && !oldLines.includes(line)) : [];
  const removals = oldLines ? oldLines.filter((line) => !lines.includes(line)) : [];
  const delta = [additions.length ? `Added/changed:\n${additions.join('\n')}` : '',
    removals.length ? `Removed/replaced:\n${removals.join('\n')}` : ''].filter(Boolean).join('\n');
  const changes = previous?.version === digest.version ? 'No changes since the version you last saw.'
    : previous ? `Changes since the version you last saw (${previous.version} -> ${digest.version}):\n${delta || 'Digest revised; re-read all rules below, including removed/changed rules.'}`
      : 'First injection: read all rules and write rules-ack for this version in your ledger.';
  const lock = `${file}.lock`, tmp = `${file}.${process.pid}`;
  let locked = false;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 30000) await fs.rmdir(lock); } catch {}
    await fs.mkdir(lock); locked = true;
    try {
      const current = JSON.parse(await readSmall(file, 4 * 1024 * 1024));
      if (current && typeof current === 'object' && !Array.isArray(current)) seen = current;
    } catch {}
    seen[input.session_id] = { version: digest.version, orchestrator: true, at: Date.now() };
    const versions = seen.__versions && typeof seen.__versions === 'object' ? seen.__versions : {};
    versions[digest.version] = lines.filter((line) => line.startsWith('- '));
    seen.__versions = Object.fromEntries(Object.entries(versions).slice(-8));
    await fs.writeFile(tmp, JSON.stringify(seen), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch {} finally {
    await fs.unlink(tmp).catch(() => {});
    if (locked) await fs.rmdir(lock).catch(() => {});
  }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart',
    additionalContext: `${changes}\n\n${digest.text}\n\nAcknowledge rules-ack ${digest.version} in your ledger after a version change.` } }));
} catch {} finally { clearTimeout(deadline); }
