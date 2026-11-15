import { readEvents } from './worker-events.mjs';
import { hubRPC } from './hub-state.mjs';

const pidAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
export async function runningWorkers({ rows = readEvents(), profiles = {}, alive = pidAlive,
  knownThread = async (account, thread) => {
    if (!profiles[account]?.hub) throw Error('hub registration unavailable');
    const result = await hubRPC(profiles[account].hub, 'thread/read', { threadId: thread, includeTurns: true });
    return result?.thread?.turns?.at(-1)?.status === 'inProgress';
  } } = {}) {
  const latest = new Map(), starts = new Map(), activity = new Map();
  for (const row of [...rows].sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0))) {
    if (row.thread && row.account) activity.set(JSON.stringify([row.account, row.thread]), row.t);
    if (!row.thread || !row.account || ['message', 'question', 'answered', 'observed'].includes(row.event)) continue;
    const key = JSON.stringify([row.account, row.thread]);
    if (row.event === 'running' && !starts.has(row.runId)) starts.set(row.runId, row.t);
    latest.set(key, row);
  }
  const unresolved = [];
  const candidates = [...latest.values()].filter(row => row.event === 'running' && !row.settled);
  const threads = (await Promise.all(candidates.map(async row => {
    let live = alive(row.pid), basis = live ? 'follower-pid' : 'hub-thread';
    if (!live) try { live = await knownThread(row.account, row.thread); }
    catch { unresolved.push({ account: row.account, thread: row.thread, owner: row.owner, reason: 'follower gone; hub status UNKNOWN' }); }
    return live ? { account: row.account, thread: row.thread, owner: row.owner ?? null, model: row.model ?? null,
      name: row.name ?? null, startedAt: starts.get(row.runId) ?? row.t, lastActivityAt: row.lastActivityAt ?? activity.get(JSON.stringify([row.account, row.thread])) ?? row.t, basis } : null;
  }))).filter(Boolean).sort((a, b) => a.account.localeCompare(b.account) || a.startedAt - b.startedAt);
  return { threads, unresolved, byAccount: Object.fromEntries([...new Set(Object.keys(profiles).concat(threads.map(r => r.account)))].map(account =>
    [account, threads.filter(row => row.account === account)])) };
}
