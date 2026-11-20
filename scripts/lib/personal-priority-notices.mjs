import fs from 'node:fs';
import path from 'node:path';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';
import { appendWorkerAlert, validOwner } from './worker-events.mjs';
import { freshPersonalWeekly } from './pipeline/personal-priority.mjs';
import { fingerprint, known } from './pipeline/common.mjs';

// Durable notices use the existing owner inbox. A missing owner never consumes
// the once-per-reset 90% notice, and dry previews have no delivery side effects.
export function checkPersonalPriorityNotices({ snapshot, task, plan, owner, dry = false,
  file = path.join(rulesShared(), 'personal-priority-notices.json'), emit = appendWorkerAlert } = {}) {
  if (dry || snapshot.personalPriority?.mode !== 'exclusive' || !validOwner(owner) || owner === 'UNKNOWN') return [];
  const now = snapshot.decisionAt, weekly = freshPersonalWeekly(snapshot), notices = [];
  const main = snapshot.accounts.find(a => a.id === 'main' && a.kind === 'chatgpt');
  const cards = known(main?.resetCards) ?? main?.resets?.count;
  if (weekly?.used >= 90) notices.push({ kind: 'personal-main-90',
    id: `personal-main-90:${fingerprint(['main', weekly.resetsAt])}`,
    text: `[personal-main-90] main ${weekly.used}% used, resets ${new Date(weekly.resetsAt).toISOString()}, cards ${Number.isInteger(cards) && cards >= 0 ? cards : '?'}` });
  if (plan?.trigger === 'personal-main-capacity') notices.push({ kind: 'personal-main-wait',
    id: `personal-main-wait:${fingerprint([snapshot.personalPriority.userDecisionRef, task.taskId, main?.budget?.value?.weekly?.resetsAt])}`,
    text: plan.reason.text });
  if (!notices.length) return [];
  return withLock(file, () => {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; saved = { notices: {} }; }
    if (!saved || typeof saved.notices !== 'object' || saved.notices === null || Array.isArray(saved.notices)) throw Error('invalid priority notice ledger');
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
    writeJson(file, saved);
    return delivered;
  }, { timeoutMs: 1000, retryMs: 20, ownerPid: true });
}
