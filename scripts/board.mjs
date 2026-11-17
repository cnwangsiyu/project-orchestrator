#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseOptions, oneLine } from './lib/task-storage.mjs';
import { resolveProject, setTask, linkTask, archiveTasks, refreshBoard } from './lib/task-board.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { opts, pos } = parseOptions(argv, { values: ['project', 'task', 'title', 'state', 'next', 'blocker', 'deps', 'deadline', 'note',
    'done-older-than', 'thread', 'account'], booleans: ['json'] });
  const [cmd, id, ...extra] = pos;
  if (extra.length || !['set', 'show', 'archive', 'link', 'refresh'].includes(cmd)) throw Error('usage: board.mjs set|show|archive|link|refresh [task] [--project p]');
  const project = resolveProject(opts.project);
  if (cmd === 'set') {
    if (!id) throw Error('set needs a task');
    const fields = Object.fromEntries(['title', 'state', 'next', 'blocker', 'deadline', 'note'].filter(key => opts[key] !== undefined).map(key => [key, opts[key]]));
    if (opts.deps !== undefined) fields.deps = opts.deps ? opts.deps.split(',').map(dep => dep.trim()) : [];
    console.log(JSON.stringify(setTask(project, id, fields))); return;
  }
  if (cmd === 'link') {
    if (!id || !opts.thread) throw Error('link needs a task and --thread');
    linkTask(project, id, opts.thread, opts.account);
    await refreshBoard(project, { thread: opts.thread, account: opts.account }); console.log(`linked ${id} to ${opts.thread}`); return;
  }
  if (id) throw Error(`${cmd} takes no positional task; use --task`);
  if (cmd === 'archive') {
    if (opts['done-older-than'] === undefined || !opts['done-older-than'].trim()) throw Error('archive needs --done-older-than');
    console.log(JSON.stringify(archiveTasks(project, Number(opts['done-older-than'])).map(task => task.id))); return;
  }
  const board = await refreshBoard(project, { thread: opts.thread, account: opts.account });
  if (cmd === 'refresh') return;
  const tasks = opts.task ? board.tasks.filter(task => task.id === opts.task) : board.tasks;
  if (opts.json) console.log(JSON.stringify({ ...board, tasks }, null, 2));
  else {
    console.log(`${project}: ${tasks.length} task(s)`);
    for (const task of tasks) {
      console.log(`${task.id}\t${task.state}\t${oneLine(task.title, 100)}${task.next ? `\tnext: ${oneLine(task.next)}` : ''}${task.blocker ? `\tblocker: ${oneLine(task.blocker)}` : ''}`);
      for (const worker of task.auto.workers) console.log(`  ${worker.name}: ${worker.state} ${worker.account}/${worker.model ?? '?'} ${worker.effort ?? '?'} thread=${worker.thread ?? '-'} ${worker.currentStep}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`board: ${error.message}`); process.exitCode = 1; });
