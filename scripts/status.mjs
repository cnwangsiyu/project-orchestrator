#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseOptions, redact } from './lib/task-storage.mjs';
import { workerFacts } from './lib/task-board.mjs';
import { readQueue } from './lib/user-queue.mjs';
import { allStatusProjects, projectStatus, statusText, resourceStatus } from './lib/task-status.mjs';
import { readFleet, fleetBoxLines } from './lib/fleet-report.mjs';

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log("usage: status.mjs [--project p] [--json]\nAll boards (refreshed), live workers, open user-queue items, resource holds and mismatches. See references/task-board.md."); return 0; }
  const { opts, pos } = parseOptions(argv, { values: ['project'], booleans: ['json'] });
  if (pos.length) throw Error('usage: status.mjs [--project p] [--json]');
  const facts = await workerFacts(), queue = readQueue();
  const projects = opts.project ? [opts.project] : allStatusProjects(facts, queue), pages = [];
  const resources = projects.length ? resourceStatus() : null;
  for (const project of projects) pages.push(await projectStatus(project, { facts, queue,
    resources: { ...resources, holds: resources.holds.filter(hold => hold.project === project) } }));
  console.log(opts.json ? JSON.stringify(redact(opts.project ? pages[0] : pages), null, 2) : statusText(pages) || 'No project boards.');
  if (!opts.json) {
    try { console.log('\nFleet (24h):\n' + fleetBoxLines(readFleet()).join('\n')); }
    catch { console.log('\nFleet (24h): unavailable (resource history or registry missing/invalid).'); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`status: ${error.message}`); process.exitCode = 1; });
