import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDigest, rulesShared, SKILL_ROOT } from './global-rules.mjs';
import { readSmall } from './hook-context.mjs';

const activeCleanups = new Set();
// Deadline handlers get a bounded opportunity to release owned locks asynchronously.
export const cleanupRulesDelivery = () => Promise.allSettled([...activeCleanups].map(cleanup => cleanup()));
export const SEEN_LIMIT = 4 * 1024 * 1024;
export const validRulesSession = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)
  && !['__versions', '__proto__', 'constructor', 'prototype'].includes(id);
export const seenFile = () => path.join(rulesShared(), 'rules-seen.json');
export const parseSeen = (raw) => {
  const seen = JSON.parse(raw);
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) throw Error('invalid rules seen state');
  for (const [id, row] of Object.entries(seen)) {
    if (id === '__versions') {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.values(row).some((lines) => !Array.isArray(lines) || lines.some((line) => typeof line !== 'string')))
        throw Error('invalid rules snapshots');
    } else if (!validRulesSession(id) || !row || typeof row !== 'object' || Array.isArray(row)
      || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(row.version)) throw Error('invalid rules session');
  }
  return seen;
};
export const readSeen = async () => {
  const file = seenFile(), raw = await readSmall(file, SEEN_LIMIT);
  if (raw) return parseSeen(raw);
  // Only a genuinely absent file is a first injection. Corruption/read errors must not reset acknowledgements.
  try { await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  throw Error('unreadable rules seen state');
};
const compareVersion = (a, b) => a.split('.')[0].localeCompare(b.split('.')[0])
  || Number(a.split('.')[1]) - Number(b.split('.')[1]);
export const changesSince = (digest, seen, previous) => {
  const lines = digest.text.split('\n');
  const oldLines = seen.__versions?.[previous.version];
  if (!Array.isArray(oldLines)) throw Error('previous rules snapshot unavailable');
  const additions = lines.filter((line) => line.startsWith('- ') && !oldLines.includes(line));
  const removals = oldLines.filter((line) => !lines.includes(line));
  const delta = [additions.length ? `Added/changed:\n${additions.join('\n')}` : '',
    removals.length ? `Removed/replaced:\n${removals.join('\n')}` : ''].filter(Boolean).join('\n');
  return `Changes since the version you last saw (${previous.version} -> ${digest.version}):\n${delta || 'No rule lines changed.'}`;
};
const label = (value) => typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').slice(0, 200) : null;
const nextSeen = (seen, input, digest) => {
  const previous = seen[input.session_id];
  const title = label(input.session_title ?? input.session_name ?? input.title ?? input.name) ?? previous?.title
    ?? (typeof input.cwd === 'string' ? path.basename(input.cwd) : input.session_id);
  const sessions = Object.entries(seen).filter(([id]) => validRulesSession(id));
  const entry = { version: digest.version, orchestrator: true, host: os.hostname(), title,
    project: label(input.project ?? input.project_name) ?? previous?.project ?? null, at: Date.now() };
  const retained = Object.fromEntries([...sessions.filter(([id]) => id !== input.session_id), [input.session_id, entry]]
    .sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0)).slice(-128));
  const versions = { ...seen.__versions, [digest.version]: digest.text.split('\n').filter((line) => line.startsWith('- ')) };
  const needed = new Set([...Object.values(retained).map((row) => row?.version), ...Object.keys(versions).slice(-8)]);
  retained.__versions = Object.fromEntries(Object.entries(versions).filter(([version]) => needed.has(version)));
  return retained;
};

// Hold the nonblocking lock through output and commit. A competing hook re-reads the merged state;
// only successful output is acknowledged. A crash before commit leaves the version eligible for retry.
export const withRulesDelivery = async (input, seen, { initial = false } = {}, action) => {
  const previous = seen[input.session_id];
  if (!previous && !initial) return action(null);
  const digest = parseDigest(await readSmall(process.env.RULES_DIGEST || path.join(SKILL_ROOT, 'references/global-rules.md')));
  if (previous?.version && compareVersion(previous.version, digest.version) >= 0) return action(null);
  const file = seenFile(), lock = `${file}.lock`, tmp = `${file}.${process.pid}`;
  let locked = false;
  let cleaning;
  const cleanup = () => cleaning ??= (async () => {
    await fs.unlink(tmp).catch(() => {}); if (locked) await fs.rmdir(lock).catch(() => {});
  })();
  activeCleanups.add(cleanup);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 30000) await fs.rmdir(lock); } catch {}
    await fs.mkdir(lock); locked = true;
    seen = await readSeen();
    const current = seen[input.session_id];
    if (current?.version && compareVersion(current.version, digest.version) >= 0) return await action(null);
    const reason = current ? changesSince(digest, seen, current) : `First injection: read all global rules.\n\n${digest.text}`;
    const data = JSON.stringify(nextSeen(seen, input, digest));
    if (Buffer.byteLength(data) > SEEN_LIMIT) throw Error('rules seen state too large');
    // Stage before output so write failures stay silent without advancing the seen version.
    await fs.writeFile(tmp, data, { mode: 0o600 });
    const rules = { reason, delivered: false };
    const result = await action(rules);
    if (rules.delivered) await fs.rename(tmp, file);
    return result;
  } finally {
    await cleanup(); activeCleanups.delete(cleanup);
  }
};

export const hookOutput = (value) => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n',
  (error) => error ? reject(error) : resolve()));
