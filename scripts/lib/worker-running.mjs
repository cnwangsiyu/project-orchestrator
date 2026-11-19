import { hubRPC } from './hub-state.mjs';
import { MAIN_PROFILE, readProfiles } from './state.mjs';
import { followerAlive, inbox, retiredWorkers, workerKey, workerRunStates } from './worker-events.mjs';

export const workerHub = row => readProfiles()[row.account]?.hub
  ?? (row.account === 'main' ? process.env.CODEX_HUB ?? MAIN_PROFILE.hub : null);
export const terminalWorker = row => !row.mayRun && (row.settled
  || ['finished', 'completed', 'failed', 'cancelled', 'retired'].includes(row.event)
  || ['completed', 'finished', 'failed', 'cancelled', 'interrupted'].includes(row.status));

export const trackedWorkers = (rows, owner) => {
  const own = rows.filter(row => (!owner || row.owner === owner) && !['ambiguous', 'unmatched'].includes(row.ownerResolution));
  const latest = new Map();
  for (const { row } of workerRunStates(own).values()) latest.set(workerKey(row), row);
  // A late exit from an older follower must not hide a still-running turn.
  for (const id of new Set(own.map(row => row.owner))) for (const row of inbox(own, id).running) {
    const key = workerKey(row), prior = latest.get(key);
    latest.set(key, prior?.turn === row.turn && prior.rulesVersion ? { ...row, rulesVersion: prior.rulesVersion } : row);
  }
  for (const [key, row] of retiredWorkers(own)) latest.set(key, row);
  return [...latest.values()];
};

// Probe only a configured hub, with a deadline; never start it or read turn items.
export const runningWorker = async (row, { timeoutMs = 850, claudeWorkers, probe = hubRPC } = {}) => {
  if (row.followerCommand === 'claude') {
    try { return (await claudeWorkers()).has(row.thread)
      ? { running: true, turn: row.turn } : { running: false, reason: 'Claude session finished or idle' }; }
    catch { return { running: null, reason: 'Claude status unavailable' }; }
  }
  if (row.followerCommand === 'exec' || !row.thread) return followerAlive(row)
    ? { running: true, turn: row.turn } : { running: false, reason: 'follower exited' };
  try {
    const hub = workerHub(row);
    if (!hub) throw Error('hub unavailable');
    const result = await probe(hub, 'thread/read', { threadId: row.thread, includeTurns: true }, timeoutMs);
    const thread = result?.thread;
    const turn = [thread?.activeTurn, thread?.currentTurn].find(turn => turn?.status === 'inProgress')
      ?? thread?.turns?.at(-1);
    if (turn?.id && turn.status === 'inProgress') return { running: true, turn: turn.id };
    if (turn?.id && turn.id !== row.turn && followerAlive(row) && !terminalWorker(row))
      return { running: null, reason: 'live follower turn differs from hub history' };
    if (turn?.status && ['completed', 'finished', 'failed', 'cancelled', 'interrupted'].includes(turn.status))
      return { running: false, reason: `hub confirms ${turn.status}` };
    if (Array.isArray(thread?.turns) && !thread.turns.length) return { running: false, reason: 'hub has no running turn' };
    return { running: null, reason: 'hub status unconfirmed' };
  } catch { return { running: null, reason: 'hub status unavailable or timed out' }; }
};
