import { readEvents, processWorker, workerKey, workerRunStates } from './worker-events.mjs';
import { readTurnState, reconcileTurnEvents } from './worker-turn.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { hubRPC } from './hub-state.mjs';
import { queueStatus, queueStallLabel } from './queue-stall-watch.mjs';
import { finishedNotExited, retireCommand } from './finished-not-exited.mjs';

// Worker events are sparse (a long command writes none), so the hub's own session file is the real activity signal.
// Layout: <home>/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl (TRAE: <home>/cli/sessions/...). Newest 10 day folders only.
export function sessionActivity(home, thread) {
  if (!home || !thread) return null;
  let best = null;
  const dirs = dir => { try { return fs.readdirSync(dir).filter(n => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  for (const root of [path.join(home, 'sessions'), path.join(home, 'cli', 'sessions')]) {
    let days = 0;
    scan: for (const y of dirs(root)) for (const m of dirs(path.join(root, y))) for (const d of dirs(path.join(root, y, m))) {
      if (++days > 10) break scan;
      const dir = path.join(root, y, m, d);
      let names = []; try { names = fs.readdirSync(dir); } catch {}
      for (const name of names) if (name.endsWith(`${thread}.jsonl`)) try { best = Math.max(best ?? 0, fs.statSync(path.join(dir, name)).mtimeMs); } catch {}
    }
  }
  return best;
}

const pidAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
export async function runningWorkers({ rows = readEvents(), profiles = {}, alive = pidAlive,
  activityOf = (account, thread) => sessionActivity(profiles[account]?.home, thread),
  knownThread = async (account, thread) => {
    if (!profiles[account]?.hub) throw Error('hub registration unavailable');
    const result = await readTurnState({ account, thread, rows, alive: row => alive(row.pid),
      readThread: threadId => hubRPC(profiles[account].hub, 'thread/read', { threadId, includeTurns: true }) });
    return result.turn?.status === 'inProgress';
  } } = {}) {
  rows = reconcileTurnEvents(rows, { alive: row => alive(row.pid) });
  const ordered = [...rows].sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0));
  const latestRuns = new Map(), latest = new Map(), starts = new Map(), activity = new Map();
  for (const row of ordered) {
    if (!row.account) continue;
    activity.set(workerKey(row), row.t);
    if (['message', 'question', 'answered'].includes(row.event)) continue;
    if (row.event === 'running' && !starts.has(row.runId)) starts.set(row.runId, row.t);
  }
  for (const [key, { row }] of workerRunStates(ordered))
    if (row.account) latestRuns.set(key, row);
  // Resolve provisional run IDs before deduplicating registered hub threads.
  for (const row of [...latestRuns.values()].sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0))) latest.set(workerKey(row), row);
  const unresolved = [];
  const now = Date.now();
  const candidates = [...latest.values()].filter(row => row.event === 'running' && !row.settled);
  const threads = (await Promise.all(candidates.map(async row => {
    let live = alive(row.pid), basis = live ? 'follower-pid' : 'hub-thread';
    if (!live && !processWorker(row)) try { live = await knownThread(row.account, row.thread); }
    catch { unresolved.push({ account: row.account, thread: row.thread, owner: row.owner, reason: 'follower gone; hub status UNKNOWN' }); }
    if (!live) return null;
    const queue = queueStatus(row, profiles);
    const worker = { account: row.account, thread: row.thread, owner: row.owner ?? null, model: row.model ?? null,
      effort: row.effort ?? null, project: row.project ?? null, task: row.task ?? row.name ?? null,
      runId: row.runId, followerCommand: row.followerCommand ?? null, pid: row.pid,
      queue, queueStalled: queueStallLabel(queue, now, row),
      name: row.name ?? null, startedAt: starts.get(row.runId) ?? row.t,
      lastActivityAt: Math.max(row.lastActivityAt ?? activity.get(workerKey(row)) ?? row.t,
        Math.floor(processWorker(row) ? 0 : activityOf(row.account, row.thread) ?? 0)),
      taskDir: row.taskDir ?? null, outFile: row.outFile ?? null, basis };
    const finished = finishedNotExited(worker, { now });
    return finished ? { ...worker, finishedNotExited: { ...finished, retireCommand: retireCommand(worker) } } : worker;
  }))).filter(Boolean).sort((a, b) => a.account.localeCompare(b.account) || a.startedAt - b.startedAt);
  return { threads, unresolved, byAccount: Object.fromEntries([...new Set(Object.keys(profiles).concat(threads.map(r => r.account)))].map(account =>
    [account, threads.filter(row => row.account === account)])) };
}
