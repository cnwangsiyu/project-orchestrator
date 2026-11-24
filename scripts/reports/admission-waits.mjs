#!/usr/bin/env node
// Summarize the canonical dated admission journals once per UTC day. The
// admission.ndjson alias is used only before its dated journal exists.
import fs from 'node:fs';
import path from 'node:path';

const values = process.argv.slice(2);
const option = (name) => values[values.indexOf(name) + 1];
const shared = option('--shared');
const day = option('--day');
if (!shared || !/^\d{4}-\d\d-\d\d$/.test(day ?? '') || values.length !== 4) {
  console.error('usage: admission-waits.mjs --shared <shared-dir> --day YYYY-MM-DD');
  process.exit(2);
}

const directory = path.join(path.resolve(shared), 'host-samples');
let names = [];
try { names = fs.readdirSync(directory).filter(name => /^admission\.\d{4}-\d\d-\d\d\.ndjson$/.test(name)); } catch {}
if (!names.length) names = ['admission.ndjson'];
const waitSeconds = (row) => {
  const value = Number(row.waitSeconds ?? row.wait ?? (Number.isFinite(row.waitMs) ? row.waitMs / 1000 : NaN));
  return Number.isFinite(value) && value > 0 ? value : 0;
};
let waits = 0, memoryRefusals = 0;
const durations = [];
for (const name of names) {
  let lines;
  try {
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile()) continue;
    lines = fs.readFileSync(path.join(directory, name), 'utf8').split('\n');
  } catch { continue; }
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!Number.isFinite(row?.at) || new Date(row.at * 1000).toISOString().slice(0, 10) !== day || row.type === 'placement') continue;
    const seconds = waitSeconds(row);
    const refused = row.open === false && typeof row.gate === 'string' && row.gate.length > 0;
    if (seconds || refused) waits++;
    if (seconds) durations.push(seconds);
    if (refused && /(?:^|[-_])mem(?:ory)?(?:$|[-_])|memory/i.test(row.gate)) memoryRefusals++;
  }
}
const average = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : '-';
const maximum = durations.length ? Math.round(Math.max(...durations)) : '-';
console.log(`${waits}\t${average}\t${maximum}\t${memoryRefusals}`);
