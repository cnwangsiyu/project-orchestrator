import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workerFacts, refreshBoard, visibleBoard, boardProjects, launchProject } from './task-board.mjs';
import { readQueue, queueOpen } from './user-queue.mjs';
import { sharedDir, iso, timeOf, oneLine } from './task-storage.mjs';
import { workerKey } from './worker-events.mjs';

export const parseResourceHolds = (text, project) => String(text).split('\n').flatMap(line => {
  const identity = line.match(/\(([^()/\s]+)(?:\/[^()\s]+)?\)\s+\d{4}-\d\d-\d\d \d\d:\d\d/);
  return identity && (!project || identity[1] === project)
    ? [{ id: line.trim().split(/\s+/)[0], project: identity[1], detail: oneLine(line, 500) }] : [];
});
export const resourceStatus = project => {
  const dir = process.env.RES_DIR || sharedDir();
  if (!fs.existsSync(path.join(dir, 'resources.tsv'))) return { state: 'UNKNOWN', holds: [], reason: 'res registry unavailable' };
  // `res status` probes devices and can take >10 s; holders are plain lock files, so read them directly (BC-84).
  const locks = path.join(dir, 'locks');
  if (!process.env.RES_BIN && fs.existsSync(locks)) {
    try {
      const holds = fs.readdirSync(locks).filter(name => name.endsWith('.d')).flatMap(name => {
        let info = ''; try { info = fs.readFileSync(path.join(locks, name, 'info'), 'utf8'); } catch { return []; }
        const field = key => info.split('\n').find(line => line.startsWith(`${key}\t`))?.slice(key.length + 1) ?? '';
        const holder = field('project');
        if (project && holder !== project) return [];
        const id = name.slice(0, -2);
        return [{ id, project: holder, detail: oneLine(`${id} ${field('by')} (${holder}${field('task') ? `/${field('task')}` : ''}) ${field('since')} · ${field('for')}`, 500) }];
      });
      return { state: 'KNOWN', holds };
    } catch { /* fall back to res status */ }
  }
  const result = spawnSync(process.env.RES_BIN || fileURLToPath(new URL('../res/res', import.meta.url)), ['status'], {
    env: { ...process.env, RES_DIR: dir }, encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024 });
  return result.status === 0 && !result.error ? { state: 'KNOWN', holds: parseResourceHolds(result.stdout, project) }
    : { state: 'UNKNOWN', holds: [], reason: 'res status unavailable' };
};
export const statusMismatches = ({ board, live, queue, now = Date.now() }) => {
  const mismatches = [], linked = worker => board.tasks.some(task => task.auto.workers.some(row => workerKey(row) === workerKey(worker))
    || task.links?.some(link => link.thread === worker.thread && (!link.account || link.account === worker.account)));
  for (const task of board.tasks.filter(task => !task.aliasOf)) {
    const hasLive = task.auto.workers.some(worker => live.some(row => workerKey(row) === workerKey(worker)));
    const lastActivity = Math.max(timeOf(task.stateUpdatedAt ?? task.updatedAt), ...task.auto.workers.map(worker => timeOf(worker.lastActivityAt)));
    if (task.state === 'running' && !hasLive && now - lastActivity > 30 * 60000)
      mismatches.push({ kind: 'running-without-worker', task: task.id, detail: 'board running but no live worker for >30m' });
    if (task.state === 'review' && now - timeOf(task.stateUpdatedAt ?? task.updatedAt) > 86400000)
      mismatches.push({ kind: 'old-review', task: task.id, detail: 'review older than 24h' });
    if (task.state === 'waiting-user' && !queue.some(item => item.task === task.id && queueOpen(item)))
      mismatches.push({ kind: 'waiting-without-question', task: task.id, detail: 'waiting-user without an open queue item' });
    if (task.deadline && timeOf(task.deadline) < now && !['done', 'cancelled'].includes(task.state))
      mismatches.push({ kind: 'overdue', task: task.id, detail: `deadline ${task.deadline}` });
  }
  for (const worker of live.filter(worker => !linked(worker))) mismatches.push({ kind: 'unlinked-worker', thread: worker.thread,
    detail: `live worker ${worker.name ?? worker.thread} is not linked to a board row` });
  return mismatches;
};
export const projectStatus = async (project, { facts, queue = readQueue(), resources, now = Date.now() } = {}) => {
  facts ??= await workerFacts();
  const board = visibleBoard(await refreshBoard(project, { facts, now }));
  const launches = new Map(facts.launches.map(launch => [workerKey(launch), launch]));
  const belongs = worker => worker.project === project || launchProject(launches.get(workerKey(worker))) === project
    || facts.events.some(event => workerKey(event) === workerKey(worker) && event.project === project)
    || board.tasks.some(task => task.auto.workers.some(row => workerKey(row) === workerKey(worker)));
  const live = facts.live.threads.filter(belongs).map(worker => {
    const auto = board.tasks.flatMap(task => task.auto.workers).find(row => workerKey(row) === workerKey(worker));
    return { ...worker, model: auto?.model ?? worker.model, effort: auto?.effort ?? worker.effort ?? null, currentStep: auto?.currentStep ?? '',
      lastActivityAt: Math.max(worker.lastActivityAt, timeOf(auto?.lastActivityAt)) };
  }), items = queue.filter(item => item.project === project);
  return { schemaVersion: 1, project, at: iso(now), board, liveWorkers: live, unknownWorkers: facts.live.unresolved.filter(belongs),
    userQueue: items.filter(queueOpen), resources: resources ?? resourceStatus(project), mismatches: statusMismatches({ board, live, queue: items, now }) };
};
export const allStatusProjects = (facts, queue) => [...new Set([...boardProjects(), ...facts.launches.map(launchProject),
  ...facts.events.map(event => event.project), ...queue.filter(queueOpen).map(item => item.project)].filter(Boolean))].sort();
export const statusText = pages => pages.map(page => {
  const lines = [`${page.project} | ${page.board.tasks.length} tasks | ${page.liveWorkers.length} live | ${page.userQueue.length} user item(s)`];
  for (const task of page.board.tasks) lines.push(`${task.id.padEnd(22)} ${task.state.padEnd(12)} ${oneLine(task.title, 80)}${task.next ? ` | next: ${oneLine(task.next, 80)}` : ''}${task.blocker ? ` | blocker: ${oneLine(task.blocker, 80)}` : ''}`);
  lines.push('Live Workers:');
  for (const worker of page.liveWorkers) {
    const auto = page.board.tasks.flatMap(task => task.auto.workers).find(row => workerKey(row) === workerKey(worker));
    lines.push(`  ${worker.name ?? '-'} ${worker.account}/${worker.model ?? '?'} ${worker.effort ?? '?'} thread=${worker.followerCommand === 'exec' ? 'exec' : worker.thread ?? '-'} owner=${worker.owner ?? '?'} task=${worker.task ?? '?'} started=${iso(worker.startedAt)} active=${iso(worker.lastActivityAt)} ${auto?.currentStep ?? ''}`);
  }
  for (const worker of page.unknownWorkers) lines.push(`  UNKNOWN ${worker.account}/${worker.thread}: ${worker.reason}`);
  if (!page.liveWorkers.length && !page.unknownWorkers.length) lines.push('  none');
  lines.push('User Queue:');
  for (const item of page.userQueue) lines.push(`  ${item.id} ${item.status}${item.cardedAt ? '/carded' : ''}${item.task ? ` task=${item.task}` : ''}: ${oneLine(item.question, 150)} | default: ${oneLine(item.default, 100)} | deadline=${item.deadline}`);
  if (!page.userQueue.length) lines.push('  none');
  lines.push(`Resource Holds (${page.resources.state}):`);
  for (const hold of page.resources.holds) lines.push(`  ${hold.detail}`);
  if (!page.resources.holds.length) lines.push(`  ${page.resources.reason ?? 'none'}`);
  lines.push('Mismatches:');
  for (const item of page.mismatches) lines.push(`  ${item.task ?? item.thread}: ${oneLine(item.detail, 180)}`);
  if (!page.mismatches.length) lines.push('  none');
  return lines.join('\n');
}).join('\n\n');
