#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFleet, formatFleet } from './lib/fleet-report.mjs';

export function main(argv = process.argv.slice(2)) {
  const usage = 'usage: fleet-report.mjs [--since <ISO>|--hours N] [--json]';
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage); return; }
  let since, hours, json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json' && !json) json = true;
    else if (argv[i] === '--hours' && hours == null && since == null && argv[i + 1]) hours = Number(argv[++i]);
    else if (argv[i] === '--since' && hours == null && since == null && argv[i + 1]) {
      const value = argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) throw Error('--since must be an ISO timestamp');
      since = Date.parse(value);
    } else throw Error(usage);
  }
  const now = Date.now();
  if (hours != null && (!Number.isFinite(hours) || hours <= 0)) throw Error('--hours must be positive');
  since ??= now - (hours ?? 24) * 3600000;
  const report = readFleet({ now, since });
  console.log(json ? JSON.stringify(report, null, 2) : formatFleet(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`fleet-report: ${error.message}`); process.exitCode = 1; }
}
