#!/usr/bin/env node
// Summarize admission refusal *episodes*, not the controller's polling cadence.
import fs from 'node:fs';
import path from 'node:path';

const values = process.argv.slice(2);
const option = name => {
  const index = values.indexOf(name);
  return index < 0 ? undefined : values[index + 1];
};
const shared = option('--shared');
const day = option('--day');
const timezone = option('--tz') ?? 'America/Los_Angeles';
const json = values.includes('--json');
const allowed = new Set(['--shared', '--day', '--tz', '--json']);
const validArgs = values.every((value, index) => allowed.has(value) || ['--shared', '--day', '--tz'].includes(values[index - 1]));
if (!shared || !/^\d{4}-\d\d-\d\d$/.test(day ?? '') || !validArgs) {
  console.error('usage: admission-waits.mjs --shared <shared-dir> --day YYYY-MM-DD [--tz IANA-timezone] [--json]');
  process.exit(2);
}
try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { console.error(`invalid timezone: ${timezone}`); process.exit(2); }

// Node's local-date parser observes TZ at parse time.  The report deliberately
// treats the requested calendar day as local to the stated report timezone.
const previousTimezone = process.env.TZ;
process.env.TZ = timezone;
const start = new Date(`${day}T00:00:00`).getTime() / 1000;
const end = new Date(`${day}T24:00:00`).getTime() / 1000;
if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { console.error(`invalid local day: ${day}`); process.exit(2); }

const directory = path.join(path.resolve(shared), 'host-samples');
let names = [];
try { names = fs.readdirSync(directory).filter(name => /^admission\.\d{4}-\d\d-\d\d\.ndjson$/.test(name)); } catch {}
if (!names.length) names = ['admission.ndjson'];
const rows = [];
for (const name of names.sort()) {
  let lines;
  try {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile()) continue;
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch { continue; }
  for (let order = 0; order < lines.length; order++) {
    try {
      const row = JSON.parse(lines[order]);
      if (row?.type === 'placement' || !Number.isFinite(row?.at) || row.at < start || row.at >= end) continue;
      if (![row.host, row.project, row.task, row.profile].every(value => typeof value === 'string' && value.length)) continue;
      rows.push({ ...row, order, name });
    } catch {}
  }
}
rows.sort((left, right) => left.at - right.at || left.name.localeCompare(right.name) || left.order - right.order);

const memoryGate = gate => /(?:^|[-_])mem(?:ory)?(?:$|[-_])|memory/i.test(gate);
const active = new Map(), completed = [];
for (const row of rows) {
  const key = [row.host, row.project, row.task, row.profile].join('\0');
  const refused = row.open === false && typeof row.gate === 'string' && row.gate.length > 0;
  let episode = active.get(key);
  if (refused) {
    if (!episode) active.set(key, episode = { start: row.at, gates: new Set() });
    episode.gates.add(row.gate);
  } else if (row.open === true && episode) {
    episode.end = row.at;
    episode.unresolved = false;
    completed.push(episode);
    active.delete(key);
  }
}
for (const episode of active.values()) {
  episode.end = end;
  episode.unresolved = true;
  completed.push(episode);
}
const durations = completed.map(episode => Math.max(0, episode.end - episode.start));
const byGate = {};
for (const episode of completed) for (const gate of episode.gates) {
  const entry = byGate[gate] ??= { episodes: 0, unresolved: 0 };
  entry.episodes++;
  if (episode.unresolved) entry.unresolved++;
}
const count = completed.length;
const average = count ? Math.round(durations.reduce((sum, value) => sum + value, 0) / count) : '-';
const maximum = count ? Math.round(Math.max(...durations)) : '-';
const memoryEpisodes = completed.filter(episode => [...episode.gates].some(memoryGate)).length;
const unresolved = completed.filter(episode => episode.unresolved).length;
if (json) {
  console.log(JSON.stringify({ day, tz: timezone, count, averageSeconds: average, maxSeconds: maximum,
    memoryGateRefusalEpisodes: memoryEpisodes, unresolvedEpisodes: unresolved, gates: byGate }));
} else console.log(`${count}\t${average}\t${maximum}\t${memoryEpisodes}`);
