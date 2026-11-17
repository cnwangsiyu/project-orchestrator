import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rulesShared } from './global-rules.mjs';
import { withLock } from './shared-file.mjs';

export { withLock };
export const orchRoot = () => process.env.ORCH_ROOT || (process.env.RULES_SHARED
  ? path.basename(process.env.RULES_SHARED) === '_shared' ? path.dirname(process.env.RULES_SHARED) : path.join(process.env.RULES_SHARED, 'projects')
  : path.join(os.homedir(), '.claude/orchestrator'));
export const sharedDir = () => rulesShared();
export const publicId = (value, label = 'id') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) throw Error(`invalid ${label}`);
  return value;
};
export const projectDir = project => path.join(orchRoot(), publicId(project, 'project'));
export const iso = time => new Date(time).toISOString();
export const timeOf = value => typeof value === 'number' ? value : Date.parse(value) || 0;
export const maskSecrets = value => String(value ?? '').replace(
  /(["']?[\w.-]*(?:password|passwd|token|secret|key|credential)[\w.-]*["']?\s*(?:=|:|\s)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
  '$1[MASKED]');
export const oneLine = (value, limit = 120) => maskSecrets(value).replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, limit);
export const redact = value => typeof value === 'string' ? maskSecrets(value) : Array.isArray(value) ? value.map(redact)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) : value;
export const readText = file => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
};
export const readJson = (file, fallback) => {
  const text = readText(file);
  return text ? JSON.parse(text) : fallback;
};
export const jsonLines = text => text.split('\n').flatMap(line => {
  if (!line.trim()) return [];
  try { return [JSON.parse(line)]; } catch { return []; }
});
export const atomicText = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} }
};
export const atomicJson = (file, value) => atomicText(file, JSON.stringify(value, null, 2) + '\n');
// Logical append-only logs are replaced atomically so readers never observe a partial last record.
export const appendLogLocked = (file, rows) => {
  const prior = readText(file);
  atomicText(file, prior + (prior && !prior.endsWith('\n') ? '\n' : '') + rows.map(row => JSON.stringify(row)).join('\n') + '\n');
};
export const parseOptions = (argv, { values = [], booleans = [] } = {}) => {
  const opts = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { pos.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(opts, key) && key !== 'option') throw Error(`repeated --${key}`);
    if (booleans.includes(key)) opts[key] = true;
    else if (values.includes(key)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw Error(`--${key} needs a value`);
      const value = argv[++i];
      if (key === 'option') (opts.option ??= []).push(value); else opts[key] = value;
    } else throw Error(`unknown --${key}`);
  }
  return { opts, pos };
};
