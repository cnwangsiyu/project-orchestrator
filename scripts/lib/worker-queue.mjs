import fs from 'node:fs';
import path from 'node:path';
import { withLock, writeJson } from './shared-file.mjs';
import { createHash } from 'node:crypto';
import { rulesShared } from './global-rules.mjs';

const queueFile = (home) => path.join(home, 'queue-status.json');
export const saveQueue = (home, threadId, q) => {
  try {
    const file = queueFile(home);
    withLock(file, () => {
      let rows = {}; try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      rows[threadId] = q;
      writeJson(file, Object.fromEntries(Object.entries(rows).slice(-200)));
    });
  } catch {}
};
export const readQueue = (home, threadId) => {
  try { return JSON.parse(fs.readFileSync(queueFile(home), 'utf8'))[threadId] ?? null; } catch { return null; }
};

export const queueWaiting = q => ['queued', 'waiting'].includes(q?.state) && !q.reporting && !q.completing;
export const QUEUE_ACTIVITY_GRACE_MS = 60000;
export const queueBusy = (queue, now = Date.now(), lastActivityAt = 0) => !!queue?.runningTools
  || Math.max(queue?.lastActivityAt ?? 0, lastActivityAt ?? 0) > now - QUEUE_ACTIVITY_GRACE_MS;
export const sameQueueEpisode = (queue, row, since) => !!queue && queue.turnId === row.turn && queue.since === since;
export const queueDecisionKey = row => createHash('sha256').update(JSON.stringify([row.account, row.thread, row.turn])).digest('hex');
export const queueDecisionFile = row => path.join(rulesShared(), 'queue-decisions', `${queueDecisionKey(row)}.json`);
export const readQueueDecision = row => readJson(queueDecisionFile(row));
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export const queueHome = row => readJson(process.env.CODEX_ACCOUNTS ?? path.join(rulesShared(), 'codex-accounts.json'))?.[row.account]?.home;
export const lastQueueNoteAt = (row, notes) => notes.reduce((at, note) => {
  if (note.account !== row.account || note.thread !== row.thread || note.owner !== row.owner
      || !(note.turn ? note.turn === row.turn : row.runId && note.runId === row.runId)) return at;
  return (note.event === 'message' && ['info', 'progress', 'risk', 'scope'].includes(note.kind) && !note.alertId
      || note.event === 'question') ? Math.max(at, note.t ?? 0) : at;
}, 0);

// Check commands again just before their delivery, not just when they are written.
// Untagged historical/advisory events do not use this queue-choice protocol.
export function currentQueueNotice(row, notes, now = Date.now()) {
  if (!row.verifyQueueNotice) return true;
  const queue = readQueue(queueHome(row), row.thread);
  if (!sameQueueEpisode(queue, row, row.queueSince) || !queueWaiting(queue) || queueBusy(queue, now, lastQueueNoteAt(row, notes))) return false;
  if (!row.noticeId) return true;
  const state = readQueueDecision(row);
  return state?.noticeId === row.noticeId && state.status === 'waiting' && !state.choice;
}
