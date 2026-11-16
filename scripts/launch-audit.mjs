#!/usr/bin/env node
// Mismatches are observational except an unapproved company-to-personal replacement.
import fs from 'node:fs';
import path from 'node:path';
import { auditLaunch, readRecords, rulesLog } from './lib/global-rules.mjs';
import { validOwner } from './lib/worker-events.mjs';
try {
  const argv = process.argv.slice(2), opts = {};
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (opts.attribute !== undefined) {
    if (!opts.attribute || !validOwner(opts.owner) || !opts.note?.trim()) throw Error('--attribute needs a name, --owner and --note');
    const file = rulesLog(), records = readRecords(file);
    const launches = records.filter(row => row.kind === 'unrouted' && row.name === opts.attribute);
    if (!launches.length) throw Error('no unrouted launch matches that exact name');
    const rows = launches.filter(row => !records.some(a => a.kind === 'launch-attribution' && a.owner === opts.owner &&
      (row.auditId ? a.auditId === row.auditId : a.name === row.name && a.launchAt === row.t)))
      .map(row => ({ kind: 'launch-attribution', t: Date.now(), name: row.name, owner: opts.owner, note: opts.note,
        auditId: row.auditId ?? null, launchAt: row.t, project: row.project ?? null }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (rows.length) fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    console.log(JSON.stringify({ attributed: rows.length, name: opts.attribute, owner: opts.owner }));
  } else {
  if (!opts.name) throw Error('needs --name (nothing recorded); usage: --name <worker> --account <a> --model <m> [--project --effort --vendor --sandbox --role --routed-seat], or --attribute <name> --owner <id> --note <text>');
  let seat;try {seat=opts['routed-seat']?JSON.parse(opts['routed-seat']):undefined;} catch {console.error('launch-audit: routed seat metadata invalid');}
  auditLaunch({ name: opts.name, project:opts.project, account: opts.account, model: opts.model, effort:opts.effort,vendor: opts.vendor,
    sandbox: opts.sandbox, userOK: opts['user-ok'],role:opts.role,seat });
  }
} catch(e) { console.error(`launch-audit: ${e.message}`); process.exitCode=1; }
