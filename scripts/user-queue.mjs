#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseOptions, redact, oneLine } from './lib/task-storage.mjs';
import { addQuestion, updateQuestion, readQueue, queueOpen } from './lib/user-queue.mjs';

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log("usage: user-queue.mjs add --project p --question \"...\" --option A --option B [--recommended A] --default \"<if unanswered>\" --deadline ISO [--task t] [--raised-by <session id>]\n       user-queue.mjs list [--open|--all] [--project p] [--json]\n       user-queue.mjs card <id> | answer <id> --choice \"<user's words>\" [--note] | close <id>\nOrchestrators add; the secretary cards and records answers; answers reach the raiser at its next stop. See references/task-board.md."); return 0; }
  const { opts, pos } = parseOptions(argv, { values: ['project', 'question', 'option', 'recommended', 'default', 'deadline', 'task', 'raised-by', 'choice', 'note'],
    booleans: ['open', 'all', 'json'] });
  const [cmd, id, ...extra] = pos;
  if (extra.length || !['add', 'list', 'card', 'answer', 'close'].includes(cmd)) throw Error('usage: user-queue.mjs add|list|card|answer|close [id]');
  if (cmd === 'add') {
    if (id) throw Error('add takes no id');
    console.log(addQuestion({ project: opts.project, question: opts.question, options: opts.option, recommended: opts.recommended,
      default: opts.default, deadline: opts.deadline, task: opts.task, raisedBy: opts['raised-by'] })); return;
  }
  if (cmd === 'list') {
    if (id || opts.open && opts.all) throw Error('list takes --open or --all, not both');
    const items = readQueue().filter(item => (!opts.project || item.project === opts.project) && (opts.all || queueOpen(item)));
    if (opts.json) console.log(JSON.stringify(redact(items), null, 2));
    else for (const item of items) console.log(`${item.id}\t${item.project}${item.task ? `/${item.task}` : ''}\t${item.status}${item.cardedAt ? ' carded' : ''}\t${oneLine(item.question, 300)}\tdeadline=${item.deadline}`);
    return;
  }
  if (!id) throw Error(`${cmd} needs an id`);
  updateQuestion(id, cmd === 'answer' ? 'answer' : cmd, cmd === 'answer' ? { choice: opts.choice, note: opts.note ?? '' } : {});
  console.log(`${cmd}: ${id}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`user-queue: ${error.message}`); process.exitCode = 1; }
}
