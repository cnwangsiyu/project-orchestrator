import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sharedDir, publicId, iso, readText, jsonLines, appendLogLocked, withLock, oneLine } from './task-storage.mjs';
import { boardFile, readBoard, mutateBoard, setTask } from './task-board.mjs';

export const queueFile = () => path.join(sharedDir(), 'user-queue.jsonl');
export const foldQueue = rows => {
  const items = new Map();
  for (const row of rows) {
    if (row.event === 'add') items.set(row.id, { ...row, status: 'open' });
    else if (items.has(row.id)) {
      const item = items.get(row.id);
      if (row.event === 'card') Object.assign(item, { cardedAt: row.t });
      if (row.event === 'answer') Object.assign(item, { status: 'answered', choice: row.choice, answerNote: row.note ?? '', answeredAt: row.t });
      if (row.event === 'ack') Object.assign(item, { acknowledgedAt: row.t, acknowledgedBy: row.owner });
      if (row.event === 'close') Object.assign(item, { status: 'closed', closedAt: row.t });
      item.updatedAt = row.t;
    }
  }
  return [...items.values()];
};
export const readQueue = () => foldQueue(jsonLines(readText(queueFile())));
export const queueOpen = item => item.status !== 'closed' && !item.acknowledgedAt;
const itemById = (items, id) => {
  const item = items.find(row => row.id === id); if (!item) throw Error('unknown queue item'); return item;
};
const waitTask = (board, item, now) => {
  const task = board.tasks.find(row => row.id === item.task);
  if (!task) throw Error('linked task missing');
  if (!task.queueWait) task.queueWait = { state: task.state === 'waiting-user' ? 'queued' : task.state, blocker: task.blocker, since: iso(now) };
  task.state = 'waiting-user'; task.stateSource = 'queue'; task.stateUpdatedAt = task.updatedAt = iso(now);
};
const resumeTask = (board, item, items, now) => {
  const task = board.tasks.find(row => row.id === item.task);
  if (!task || task.state !== 'waiting-user' || items.some(row => row.id !== item.id && row.project === item.project && row.task === item.task && queueOpen(row))) return;
  const workers = task.auto.workers.filter(worker => worker.state !== 'rerouted');
  task.state = workers.some(worker => worker.state === 'running') ? 'running'
    : workers.some(worker => ['failed', 'stalled', 'blocked'].includes(worker.state)) ? 'blocked'
      : workers.length && workers.every(worker => worker.state === 'finished') ? 'review' : task.queueWait?.state ?? 'queued';
  if (task.state === 'blocked' && !task.blocker) {
    const failed = workers.find(worker => ['failed', 'stalled', 'blocked'].includes(worker.state));
    task.blocker = oneLine(failed ? `worker ${failed.state}: ${failed.result?.summary ?? 'see worker result'}` : task.queueWait?.blocker ?? '', 500);
  }
  task.stateSource = 'queue'; task.stateUpdatedAt = task.updatedAt = iso(now); delete task.queueWait;
};
export const addQuestion = ({ project, question, options, recommended, default: defaultAction, deadline, task, raisedBy }, now = Date.now()) => {
  publicId(project, 'project'); if (task) publicId(task, 'task'); if (raisedBy) publicId(raisedBy, 'owner');
  if (!question?.trim() || !Array.isArray(options) || options.length < 2 || options.some(option => !option.trim()) || !defaultAction?.trim()) throw Error('add needs a question, at least two options, and a default');
  if (recommended !== undefined && !options.includes(recommended)) throw Error('recommended must match an option');
  if (!/^\d{4}-\d\d-\d\dT/.test(deadline ?? '') || !Number.isFinite(Date.parse(deadline))) throw Error('deadline needs an ISO timestamp');
  const item = { schemaVersion: 1, event: 'add', id: randomUUID(), t: iso(now), project, question, options,
    recommended: recommended ?? null, default: defaultAction, deadline, task: task ?? null, raisedBy: raisedBy ?? null };
  return withLock(queueFile(), () => {
    if (task && !readBoard(project).tasks.some(row => row.id === task)) setTask(project, task, {}, now);
    // Persist the question first so a failed board transition cannot lose a user decision.
    appendLogLocked(queueFile(), [item]);
    if (task) mutateBoard(project, board => waitTask(board, item, now));
    return item.id;
  });
};
export const updateQuestion = (id, event, fields = {}, now = Date.now()) => {
  publicId(id, 'queue id');
  if (!['card', 'answer', 'close'].includes(event)) throw Error('invalid queue event');
  return withLock(queueFile(), () => {
    const items = readQueue(), item = itemById(items, id);
    if (event !== 'close' && !queueOpen(item)) throw Error('queue item is already closed or acknowledged');
    if (event === 'answer' && (item.status === 'answered' || !fields.choice?.trim())) throw Error('answer needs a choice and cannot replace an existing answer');
    if (event === 'close' && item.status === 'closed') return item;
    const row = { schemaVersion: 1, id, event, t: iso(now), ...fields };
    appendLogLocked(queueFile(), [row]);
    if (event === 'close' && item.task) mutateBoard(item.project, board => resumeTask(board, item, items, now));
    return readQueue().find(value => value.id === id);
  });
};
export const answerLine = item => `user queue ${item.id} (${item.project}${item.task ? `/${item.task}` : ''}): ${oneLine(item.question, 500)}\nUser answered: ${oneLine(item.choice, 1000)}${item.answerNote ? `\nNote: ${oneLine(item.answerNote, 500)}` : ''}`;

// Hook locks never wait synchronously: contention leaves the answer pending for the next session hook.
const tryAsyncLock = async file => {
  const lock = `${file}.lock`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try { await fsp.mkdir(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - (await fsp.stat(lock)).mtimeMs <= 30000) return null; await fsp.rmdir(lock); await fsp.mkdir(lock); } catch { return null; }
  }
  const identity = await fsp.stat(lock);
  const exit = () => { try { const current = fs.statSync(lock); if (current.ino === identity.ino && current.dev === identity.dev) fs.rmdirSync(lock); } catch {} };
  process.once('exit', exit);
  return async () => { process.removeListener('exit', exit); await fsp.rmdir(lock).catch(() => {}); };
};
const asyncText = async file => { try { return await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const asyncWrite = async (file, text) => {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fsp.writeFile(tmp, text, { mode: 0o600 }); await fsp.rename(tmp, file); }
  finally { await fsp.unlink(tmp).catch(() => {}); }
};
export const deliverAnswers = async ({ owner, project, projectOfOwner, print, now = Date.now() }) => {
  const file = queueFile();
  // Idle hooks do not create queue directories/locks.
  const snapshot = foldQueue(jsonLines(await asyncText(file)));
  if (!project && snapshot.some(item => item.status === 'answered' && queueOpen(item) && !item.raisedBy)) project = projectOfOwner?.();
  const matches = item => item.status === 'answered' && queueOpen(item) && (item.raisedBy ? item.raisedBy === owner : item.project === project);
  if (!snapshot.some(matches)) return [];
  const release = await tryAsyncLock(file); if (!release) return [];
  const delivered = [], boards = new Map(), releases = [];
  try {
    const text = await asyncText(file), items = foldQueue(jsonLines(text));
    for (const item of items.filter(matches)) {
      if (item.task) {
        const target = boardFile(item.project);
        if (!boards.has(target)) {
          const boardRelease = await tryAsyncLock(target); if (!boardRelease) continue;
          releases.push(boardRelease);
          boards.set(target, JSON.parse(await asyncText(target)));
        }
      }
      delivered.push(item);
    }
    if (delivered.length) {
      await print(delivered);
      const remaining = items.filter(item => !delivered.some(done => done.id === item.id));
      for (const item of delivered.filter(item => item.task)) resumeTask(boards.get(boardFile(item.project)), item, remaining, now);
      for (const [target, board] of boards) { board.updatedAt = iso(now); await asyncWrite(target, JSON.stringify(board, null, 2) + '\n'); }
      await asyncWrite(file, text + (text && !text.endsWith('\n') ? '\n' : '')
        + delivered.map(item => JSON.stringify({ schemaVersion: 1, id: item.id, event: 'ack', t: iso(now), owner })).join('\n') + '\n');
    }
    return delivered;
  } finally { for (const boardRelease of releases.reverse()) await boardRelease(); await release(); }
};
