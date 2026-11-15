// ETA comparison for company-lane choices (user, 2026-11-13 night). "Depleted" alone says little: a bucket at 80/80
// can still run at normal speed when no queue cycles appear, while a near-empty queue can take hours. Pure functions
// only — no I/O, no provider calls. route.mjs feeds them quota, lane telemetry and the task-size estimate.
export const ETA = Object.freeze({
  // Expected run time by tier when outcome history has no usable median for the category.
  workMin: { light: 5, normal: 30, hard: 90, review: 25 },
  // Requests a worker issues per turn; each re-queues separately in the low-priority lane.
  requests: { light: 10, normal: 40, hard: 120 },
  historyMin: 3, // need this many timed outcomes before trusting a category median
  slowPerRequestMin: 2, // below this a queue wait is noise, not a slowdown
  patienceMaxMin: 30,
  patienceShare: 0.25, // of the time until the faster account resets
});
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
export const median = (xs) => {
  const s = xs.filter(finite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Task-size estimate: the category's median wall-clock time from recorded outcomes when there are enough rows,
// otherwise a small tier table. Review categories use the review row because their run time is bounded by the diff.
export const workMinutes = (category, taskTier, history = [], effort = null) => {
  const rows = history.filter((o) => o && o.category === category && finite(o.minutes) && o.minutes > 0
    && (!effort || (o.actual?.[0] ?? o.first ?? o.pick)?.effort === effort))
    .map((o) => o.minutes);
  if (rows.length >= ETA.historyMin) return median(rows);
  return ['review', 'review-high', 'second-opinion'].includes(category) ? ETA.workMin.review
    : ETA.workMin[taskTier] ?? ETA.workMin.normal;
};
export const requestsFor = (category, taskTier) => (['review', 'review-high', 'second-opinion'].includes(category)
  ? ETA.requests.normal : ETA.requests[taskTier] ?? ETA.requests.normal);
// One candidate's estimate. `bucketDepleted` covers a used-up daily bucket; `congested` covers a queue/load veto.
//   available now          -> start 0, slowdown 1
//   queued with drain r>0  -> start = position / r
//                             slowdown = 1 when that is under the per-request noise floor, else
//                             1 + (position/r * requests) / workMin   (each request waits the same start delay)
//   no usable telemetry    -> optimistic 0/1 with unknown:true; the worker's patience deadline covers a slow lane
export const laneEta = ({ workMin, requests, position = null, drainPerMin = null, bucketDepleted = false,
  congested = false, progressing = false, unknown = false, startDelayMin = 0 }) => {
  const queued = bucketDepleted || congested;
  if (!queued || (progressing && !congested)) {
    return { startDelayMin, slowdown: 1, completionMin: startDelayMin + workMin, unknown, basis: progressing ? 'progressing' : 'available' };
  }
  if (unknown || !finite(position) || position <= 0 || !finite(drainPerMin) || drainPerMin <= 0) {
    return { startDelayMin, slowdown: 1, completionMin: startDelayMin + workMin, unknown: true, basis: 'unknown' };
  }
  const waitPerRequest = position / drainPerMin;
  const slowdown = waitPerRequest < ETA.slowPerRequestMin ? 1 : 1 + (waitPerRequest * requests) / workMin;
  return { startDelayMin: startDelayMin + waitPerRequest, slowdown, completionMin: startDelayMin + waitPerRequest + workMin * slowdown,
    unknown: false, basis: 'queue', waitPerRequest };
};
// TTADK is available now while it has quota; otherwise its start is the reset time (work runs at normal speed after).
export const ttadkEta = ({ account, now, workMin }) => {
  if (!account) return null;
  if (account.usable) return { startDelayMin: 0, slowdown: 1, completionMin: workMin, unknown: false, basis: 'available' };
  // Reset estimates are capacity recovery, never a promise that an unhealthy/login-blocked account will recover.
  if (/login|sso|auth|expired|unreachable/i.test(account.reason ?? '')) return null;
  const quotaOut = account.quotaOut || (account.usage?.used >= account.usage?.limit && account.usage?.limit > 0);
  if (!quotaOut) return null;
  const reset = account.usage?.resetsAt ?? account.quotaOut?.resetsAt;
  if (finite(reset) && reset > now) {
    const startDelayMin = (reset - now) / 60000;
    return { startDelayMin, slowdown: 1, completionMin: startDelayMin + workMin, unknown: false, basis: 'reset' };
  }
  return null;
};
// Optimistic-launch patience: never longer than 30 min, and no longer than a quarter of the wait for the faster account.
export const patienceMinutes = ({ now, ttadk }) => {
  const reset = ttadk?.usage?.resetsAt;
  if (!finite(reset) || reset <= now) return ETA.patienceMaxMin;
  return Math.min(ETA.patienceMaxMin, ETA.patienceShare * (reset - now) / 60000);
};
// Human-readable estimate for `why`: "6.1-Sol@trae now, est. 95 min; TTADK in 9.2h → est. 10.7h".
export const etaText = (row) => {
  const start = row.startDelayMin >= 1 ? `in ${Math.round(row.startDelayMin)} min` : 'now';
  const total = row.completionMin >= 90 ? `${(row.completionMin / 60).toFixed(1)}h` : `${Math.round(row.completionMin)} min`;
  const queue = row.basis === 'queue' ? ` queued ${row.lane.position}, drain ${row.lane.drainPerMin.toFixed(2)}/min` : '';
  return `${row.model}@${row.account}${queue} ${start}, est. ${total}${row.unknown ? ' (telemetry missing; optimistic)' : ''}`;
};
