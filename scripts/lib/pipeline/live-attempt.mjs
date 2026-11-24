export const liveAttempts = task => task.previousAttempts.filter(a => a.taskId === task.taskId && (a.role ?? 'primary') === task.role
  && ['starting', 'queued', 'running', 'cancel-pending', 'UNKNOWN'].includes(a.state));

export function liveAttemptText(task, now) {
  const attempts = liveAttempts(task).map(a => {
    const minutes = Number.isFinite(a.queueSince) && a.queueSince <= now ? (now-a.queueSince)/60000 : a.queueWaitMinutes;
    const queued = ['queued','waiting'].includes(a.queueState) || a.state === 'queued';
    const state = queued ? `queued ${Number.isFinite(minutes) && minutes >= 0 ? `${Math.floor(minutes)} min` : '(duration unknown)'}` : a.state;
    return `account=${a.actual?.accountId ?? 'unknown'} model=${a.actual?.modelId ?? 'unknown'} thread=${a.thread ?? 'unknown'} ${state}`;
  });
  return `ATTEMPT_RECONCILIATION_REQUIRED: task ${task.taskId} has a live attempt (${attempts.join('; ')}); use queue-choice on its notice, or interrupt then route.`;
}
