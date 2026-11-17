#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseOptions, redact } from './lib/task-storage.mjs';
import { workerFacts } from './lib/task-board.mjs';
import { readQueue } from './lib/user-queue.mjs';
import { allStatusProjects, projectStatus, statusText, resourceStatus } from './lib/task-status.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { opts, pos } = parseOptions(argv, { values: ['project'], booleans: ['json'] });
  if (pos.length) throw Error('usage: status.mjs [--project p] [--json]');
  const facts = await workerFacts(), queue = readQueue();
  const projects = opts.project ? [opts.project] : allStatusProjects(facts, queue), pages = [];
  const resources = projects.length ? resourceStatus() : null;
  for (const project of projects) pages.push(await projectStatus(project, { facts, queue,
    resources: { ...resources, holds: resources.holds.filter(hold => hold.project === project) } }));
  console.log(opts.json ? JSON.stringify(redact(opts.project ? pages[0] : pages), null, 2) : statusText(pages) || 'No project boards.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`status: ${error.message}`); process.exitCode = 1; });
