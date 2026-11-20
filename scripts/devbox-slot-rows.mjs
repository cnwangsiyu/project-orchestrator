#!/usr/bin/env node
// Print proposed TSV only. Never install rows or mutate the live registry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function slotRows(text, host, count, first) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.split('.').some(n => Number(n) > 255) || !Number.isInteger(count) || count < 1 || count > 64 || !Number.isSafeInteger(first + count) || first < 1) throw Error('invalid host/count/first-id');
  const rows = text.trimEnd().split('\n').map(line => line.split('\t'));
  const template = rows.find(row => {
    const addresses = [...row.slice(4).join('\t').matchAll(/\b([A-Za-z_][A-Za-z0-9_.-]*)@((?:\d{1,3}\.){3}\d{1,3})\b/g)];
    return /^devbox-cn-\d+$/.test(row[0]) && row[1] === 'remote' && row[2] === 'open'
      && new Set(addresses.map(match => match[0])).size === 1 && addresses[0]?.[2] === host;
  });
  if (!template) throw Error('no open heavy slot template for host');
  const ids = new Set(rows.map(row => row[0]));
  return Array.from({ length: count }, (_, i) => {
    const id = 'devbox-cn-' + (first + i);
    if (ids.has(id)) throw Error(`slot ID already exists: ${id}; choose another --first-id`);
    const copy = [id, ...template.slice(1)];
    // Generous ceilings must disappear on stale-metrics/static fallback, rather
    // than accidentally multiplying the host's baseline admitted concurrency.
    if (!copy.slice(4).join('\t').split(/\s+/).includes('dynamic-only')) copy[4] += ' dynamic-only';
    return copy.join('\t');
  }).join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), opts = {};
    if (args.length !== 8) throw Error('usage: devbox-slot-rows.mjs --registry FILE --host IP --count NEW_ROWS --first-id N');
    for (let i = 0; i < args.length; i += 2) {
      if (!['--registry', '--host', '--count', '--first-id'].includes(args[i]) || Object.hasOwn(opts, args[i])) throw Error('invalid option');
      opts[args[i]] = args[i + 1];
    }
    process.stdout.write(slotRows(fs.readFileSync(opts['--registry'], 'utf8'), opts['--host'], Number(opts['--count']), Number(opts['--first-id'])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
