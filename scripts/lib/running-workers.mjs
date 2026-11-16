import { readEvents } from './worker-events.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { hubRPC } from './hub-state.mjs';

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
      name: row.name ?? null, startedAt: starts.get(row.runId) ?? row.t,
      lastActivityAt: Math.max(row.lastActivityAt ?? activity.get(JSON.stringify([row.account, row.thread])) ?? row.t, Math.floor(activityOf(row.account, row.thread) ?? 0)), basis } : null;
  }))).filter(Boolean).sort((a, b) => a.account.localeCompare(b.account) || a.startedAt - b.startedAt);
  return { threads, unresolved, byAccount: Object.fromEntries([...new Set(Object.keys(profiles).concat(threads.map(r => r.account)))].map(account =>
    [account, threads.filter(row => row.account === account)])) };
}
