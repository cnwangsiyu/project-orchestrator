import fs from 'node:fs';
import path from 'node:path';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';
import { appendWorkerAlert, validOwner } from './worker-events.mjs';
import { freshPersonalWeekly } from './pipeline/personal-priority.mjs';
import { fingerprint, known } from './pipeline/common.mjs';

const RESET_DRIFT_MS = 6 * 3600000;

function observeMainWindow(saved, weekly, now, sampledAt) {
  const previous = saved.mainWindow;
  if (previous && (!Number.isSafeInteger(previous.generation) || previous.generation < 0
    || typeof previous.id !== 'string' || !Number.isFinite(previous.resetsAt)
    || !Number.isFinite(previous.used) || !Number.isFinite(previous.observedAt)
    || previous.sampledAt !== undefined && !Number.isFinite(previous.sampledAt)))
    throw Error('invalid priority notice window');
  if (previous && (previous.sampledAt !== undefined && sampledAt < previous.sampledAt
    || (previous.sampledAt === undefined || sampledAt === previous.sampledAt) && now < previous.observedAt)) return null;
  // Nearby deadline corrections describe the same quota cycle. Fresh usage
  // falling identifies a reset even when the reported deadline stays the same.
  const reset = !previous || weekly.used < previous.used
    || Math.abs(weekly.resetsAt - previous.resetsAt) > RESET_DRIFT_MS;
  const generation = reset ? (previous ? previous.generation + 1 : 0) : previous.generation;
  const window = reset ? {
    generation, resetsAt: weekly.resetsAt,
    id: fingerprint(generation ? ['main', weekly.resetsAt, generation] : ['main', weekly.resetsAt]),
  } : { ...previous };
  saved.mainWindow = { ...window, used: weekly.used, observedAt: now, sampledAt };
  return saved.mainWindow;
}

// Durable notices use the existing owner inbox. A missing owner never consumes
// the once-per-reset 90% notice, and dry previews have no delivery side effects.
export function checkPersonalPriorityNotices({ snapshot, task, plan, owner, dry = false,
  file = path.join(rulesShared(), 'personal-priority-notices.json'), emit = appendWorkerAlert } = {}) {
  if (dry || snapshot.personalPriority?.mode !== 'exclusive' || !validOwner(owner) || owner === 'UNKNOWN') return [];
  const now = snapshot.decisionAt, weekly = freshPersonalWeekly(snapshot);
  const main = snapshot.accounts.find(a => a.id === 'main' && a.kind === 'chatgpt');
  const cards = known(main?.resetCards) ?? main?.resets?.count;
  const wait = plan?.trigger === 'personal-main-capacity';
  if (!weekly && !wait) return [];
  return withLock(file, () => {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; saved = { notices: {} }; }
    if (!saved || typeof saved.notices !== 'object' || saved.notices === null || Array.isArray(saved.notices)) throw Error('invalid priority notice ledger');
    const sampledAt = Number.isFinite(main?.budget?.sampledAt) ? main.budget.sampledAt : now;
    const window = weekly ? observeMainWindow(saved, weekly, now, sampledAt) : null, notices = [];
    if (window && weekly.used >= 90) notices.push({ kind: 'personal-main-90',
      id: `personal-main-90:${window.id}`,
      text: `[personal-main-90] main ${weekly.used}% used, resets ${new Date(weekly.resetsAt).toISOString()}, cards ${Number.isInteger(cards) && cards >= 0 ? cards : '?'}` });
    if (wait) notices.push({ kind: 'personal-main-wait',
      id: `personal-main-wait:${fingerprint([snapshot.personalPriority.userDecisionRef, task.taskId, main?.budget?.value?.weekly?.resetsAt])}`,
      text: plan.reason.text });
    const delivered = [];
    for (const notice of notices) {
      if (saved.notices[notice.id]) continue;
      const row = { event: 'message', kind: notice.kind, runId: notice.id, owner, account: 'main', name: task?.flags?.name ?? task?.taskId ?? 'quota',
        task: task?.taskId, project: task?.project, wake: true, text: notice.text };
      const result = emit(row, notice.id);
      if (result === null) continue;
      saved.notices[notice.id] = { at: now };
      delivered.push(result ?? row);
    }
    if (window || delivered.length) writeJson(file, saved);
    return delivered;
  }, { timeoutMs: 1000, retryMs: 20, ownerPid: true });
}
