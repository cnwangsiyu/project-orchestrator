#!/usr/bin/env node
// Owner-operated atomic migration. Default is a read-only unified diff.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const oldId = /^devbox-cn-(?:\d+|light(?:-\d+)?)$/;
const tag = (text, name) => new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(text)?.[1];
export function migrate(text, facts = {}) {
  const groups = new Map(), seen = new Set();
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length !== 5 || seen.has(parts[0])) throw Error('invalid or duplicate registry row');
    seen.add(parts[0]);
    if (!oldId.test(parts[0]) || parts[1] !== 'remote') continue;
    const targets = [...new Set(parts[4].match(/[A-Za-z_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*/g) || [])];
    if (targets.length !== 1) throw Error('legacy row requires exactly one target: ' + parts[0]);
    const target = targets[0], host = target.split('@')[1], root = tag(parts[4], 'root')?.replace(/[),;]+$/, '');
    let group = groups.get(host);
    if (!group) groups.set(host, group = { rows: [], target, root, policy: parts[2], device: parts[3] });
    // Mixed caps/preferences are retained as the host union. Per-row policy
    // differences cannot safely be guessed, so require owner reconciliation.
    if (group.target !== target || group.root !== root || group.policy !== parts[2] || group.device !== '-' || parts[3] !== '-')
      throw Error('conflicting target/root/policy for host ' + host);
    group.rows.push(parts);
  }
  if (!groups.size) throw Error('no legacy devbox rows to migrate');
  const result = [], notes = {};
  const done = new Set();
  for (const line of lines) {
    const parts = line.split('\t');
    const group = [...groups.values()].find(g => g.rows.some(row => row[0] === parts[0]));
    if (!group) { result.push(line); continue; }
    if (done.has(group)) continue;
    done.add(group);
    const host = group.target.split('@')[1], label = host.replace(/[^A-Za-z0-9_.-]/g, '_');
    const id = 'devbox-host-' + label;
    if (seen.has(id)) throw Error('host row already exists: ' + id);
    const union = name => [...new Set(group.rows.flatMap(row => (tag(row[4], name) || '').split(',').filter(Boolean)))].sort().join(',');
    const descriptions = group.rows.map(row => row[4].replace(/(?:^|\s)(?:caps|prefer|root|aliases)=[^\s]+/g, '').trim());
    const tags = [`aliases=${group.rows.map(row => row[0]).join(',')}`, ...['caps', 'prefer'].map(name => union(name) ? `${name}=${union(name)}` : '').filter(Boolean)];
    const fact = facts[host], user = group.target.split('@')[0];
    const runnerRoot = group.root || (fact?.user === user ? fact.root : undefined);
    if (runnerRoot) {
      if (!/^\/[A-Za-z0-9_./-]+$/.test(runnerRoot) || path.posix.normalize(runnerRoot) !== runnerRoot || runnerRoot === '/') throw Error('invalid runner root for host ' + host);
      tags.push('root=' + runnerRoot);
    }
    result.push([id, 'remote', group.policy, '-', [...new Set(descriptions)].join(' | ') + ' ' + tags.join(' ')].join('\t'));
    notes[id] = group.rows.map(row => row[0]);
  }
  return { text: result.join('\n'), notes };
}
function atomic(file, text, mode) {
  const tmp = file + `.dynamic-${process.pid}`;
  try { fs.writeFileSync(tmp, text, { flag: 'wx', mode }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function main(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (['--apply', '--rollback'].includes(name)) opts[name] = true;
    else if (['--registry', '--backup'].includes(name) && args[i + 1]) opts[name] = args[++i];
    else throw Error('usage: devbox-host-migrate.mjs --registry FILE [--apply|--rollback] [--backup FILE]');
  }
  if (!opts['--registry'] || opts['--apply'] && opts['--rollback']) throw Error('choose a registry and one action');
  const file = path.resolve(opts['--registry']), backup = path.resolve(opts['--backup'] || file + '.pre-dynamic');
  const current = fs.readFileSync(file, 'utf8'), mode = fs.statSync(file).mode & 0o777;
  if (opts['--rollback']) {
    const original = fs.readFileSync(backup, 'utf8');
    // Keep only non-admitting resolver rows. Old wrappers regain their original
    // capacity while newly issued IDs/receipts stay resolvable until retirement.
    const resolverRows = current.split('\n').filter(line => /^devbox-host-/.test(line)).map(line => {
      const parts = line.split('\t'); parts[4] = parts[4].replace(/\sleases-only(?=\s|$)/g, '') + ' leases-only'; return parts.join('\t');
    });
    atomic(file, original.trimEnd() + '\n' + resolverRows.join('\n') + (resolverRows.length ? '\n' : ''), mode);
    console.log('Rolled back numbered rows; resolver-only host rows retain dynamic lease compatibility. Backup: ' + backup);
    return;
  }
  let facts = {};
  const factsFile = path.join(path.dirname(file), 'devbox-hosts.json');
  if (fs.existsSync(factsFile)) facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  const proposal = migrate(current, facts);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-registry-diff-'));
  try {
    const before = path.join(tmp, 'before'), after = path.join(tmp, 'after'); fs.writeFileSync(before, current); fs.writeFileSync(after, proposal.text);
    const diff = spawnSync('diff', ['-u', '--label', file, '--label', file + ' (dynamic)', before, after], { encoding: 'utf8' });
    if (![0, 1].includes(diff.status)) throw Error('diff failed');
    process.stdout.write(diff.stdout);
  } finally { fs.rmSync(tmp, { recursive: true }); }
  if (!opts['--apply']) return;
  if (fs.existsSync(backup)) throw Error('backup exists; refusing to overwrite: ' + backup);
  // Preserve each named notes file without changing the originals. Refuse any
  // pre-existing host notes destination rather than overwrite another task.
  const notesDir = path.join(path.dirname(file), 'notes');
  const noteWrites = [];
  for (const [id, aliases] of Object.entries(proposal.notes)) {
    const values = aliases.filter(alias => fs.existsSync(path.join(notesDir, alias + '.md')))
      .map(alias => `# Legacy notes: ${alias}\n\n${fs.readFileSync(path.join(notesDir, alias + '.md'), 'utf8')}`);
    if (values.length) {
      const dest = path.join(notesDir, id + '.md'); if (fs.existsSync(dest)) throw Error('host notes already exist: ' + id);
      noteWrites.push([dest, values.join('\n\n')]);
    }
  }
  fs.writeFileSync(backup, current, { flag: 'wx', mode: 0o600 });
  for (const [dest, text] of noteWrites) fs.writeFileSync(dest, text, { flag: 'wx', mode: 0o600 });
  if (fs.readFileSync(file, 'utf8') !== current) throw Error('registry changed while preparing migration');
  atomic(file, proposal.text, mode);
  console.log('Applied. Rollback: node scripts/devbox-host-migrate.mjs --registry ' + file + ' --backup ' + backup + ' --rollback');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
