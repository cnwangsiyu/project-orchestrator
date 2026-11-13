#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadDigest, rulesShared, SKILL_ROOT } from './lib/global-rules.mjs';
import os from 'node:os';

process.on('uncaughtException', () => process.exit(0));
setTimeout(() => process.exit(0), 250).unref();

// Bounded metadata/transcript reads, no CLI/network calls; never scan login/session credential stores.
const readSmall = (file, limit = 65536) => {
  let fd;
  try { fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
    if (size > limit) throw Error('metadata too large');
    return fs.readFileSync(fd, 'utf8');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
const transcriptHint = (file) => {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return false;
  let fd;
  try {
    const actual = fs.realpathSync(file);
    const roots = [path.join(os.homedir(), '.claude/projects'),
      ...(process.env.CLAUDE_CONFIG_DIR ? [path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')] : [])];
    if (!roots.some((root) => { try { return actual.startsWith(`${fs.realpathSync(root)}${path.sep}`); } catch { return false; } })) return false;
    fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size, n = Math.min(size, 16384);
    const head = Buffer.alloc(n), tail = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0); fs.readSync(fd, tail, 0, n, Math.max(0, size - n));
    return [head, tail].some((part) => /project-orchestrator\/SKILL\.md|# project-orchestrator/.test(part.toString()));
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
const orchestrator = (input, seen) => {
  if (seen[input.session_id]?.orchestrator) return true;
  const title = input.session_title ?? input.session_name ?? input.title ?? input.name;
  const roster = readSmall(path.join(rulesShared(), 'orchestrators.txt')).split('\n')
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  return (typeof title === 'string' && (/主对话$/.test(title.trim()) || roster.includes(title.trim())))
    || (typeof input.cwd === 'string' && path.resolve(input.cwd) === SKILL_ROOT)
    || transcriptHint(input.transcript_path);
};
try {
  let raw = '';
  for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw Error('input too large'); }
  const input = JSON.parse(raw);
  if (!input || input.hook_event_name !== 'SessionStart' || !['startup', 'resume', 'compact'].includes(input.source)
    || typeof input.session_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(input.session_id)
    || ['__versions', '__proto__', 'constructor', 'prototype'].includes(input.session_id)) process.exit(0);
  const file = path.join(rulesShared(), 'rules-seen.json');
  let seen; try { seen = JSON.parse(readSmall(file, 4 * 1024 * 1024)); } catch { seen = {}; }
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) seen = {};
  if (!orchestrator(input, seen)) process.exit(0);
  const digest = loadDigest(), previous = seen[input.session_id];
  const oldLines = Array.isArray(seen.__versions?.[previous?.version]) ? seen.__versions[previous.version] : null;
  const additions = oldLines ? digest.text.split('\n').filter((line) => line.startsWith('- ') && !oldLines.includes(line)) : [];
  const removals = oldLines ? oldLines.filter((line) => !digest.text.split('\n').includes(line)) : [];
  const delta = [additions.length ? `Added/changed:\n${additions.join('\n')}` : '',
    removals.length ? `Removed/replaced:\n${removals.join('\n')}` : ''].filter(Boolean).join('\n');
  const changes = previous?.version === digest.version ? 'No changes since the version you last saw.'
    : previous ? `Changes since the version you last saw (${previous.version} -> ${digest.version}):\n${delta || 'Digest revised; re-read all rules below, including removed/changed rules.'}`
      : 'First injection: read all rules and write rules-ack for this version in your ledger.';
  // A nonblocking lock avoids lost updates without ever waiting behind a slow hook.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`, tmp = `${file}.${process.pid}`;
  let locked = false;
  try {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.rmdirSync(lock); } catch {}
    fs.mkdirSync(lock); locked = true;
    try { const current = JSON.parse(readSmall(file, 4 * 1024 * 1024)); if (current && typeof current === 'object' && !Array.isArray(current)) seen = current; } catch {}
    seen[input.session_id] = { version: digest.version, orchestrator: true, at: Date.now() };
    const versions = seen.__versions && typeof seen.__versions === 'object' ? seen.__versions : {};
    versions[digest.version] = digest.text.split('\n').filter((line) => line.startsWith('- '));
    seen.__versions = Object.fromEntries(Object.entries(versions).slice(-8));
    fs.writeFileSync(tmp, JSON.stringify(seen)); fs.renameSync(tmp, file);
  } catch {} finally {
    try { fs.unlinkSync(tmp); } catch {}
    if (locked) try { fs.rmdirSync(lock); } catch {}
  }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart',
    additionalContext: `${changes}\n\n${digest.text}\n\nAcknowledge rules-ack ${digest.version} in your ledger after a version change.` } }));
} catch {}
