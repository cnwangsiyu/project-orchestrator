import { readEvents, workerContext, workerRunStates, followerAlive, processWorker } from './worker-events.mjs';

const ended = status => ['completed', 'uncertain', 'TRUNCATED', 'transport-failed', 'failed', 'interrupted'].includes(status);
const trackedStatus = (row, alive) => {
  if (!row.mayRun && (row.status === 'TRUNCATED' || row.event === 'truncated')) return 'TRUNCATED';
  if (!row.mayRun && row.status === 'uncertain') return 'uncertain';
  if (!row.settled && (row.event === 'running' || row.mayRun)) return alive(row) ? 'inProgress' : 'unknown';
  if (!row.mayRun && ['finished', 'failed', 'owner-interrupted', 'observed', 'needs-user'].includes(row.event))
    return ended(row.status) ? row.status : row.event === 'finished' || row.exit === 0 ? 'completed' : 'failed';
  return 'unknown';
};

export const reconcileTurnEvents = (rows, { contextFor = (account, thread) => workerContext(account, thread, true),
  alive = followerAlive } = {}) => {
  const latest = new Set([...workerRunStates(rows).values()].map(({ row }) => row));
  return rows.map(row => {
    if (!latest.has(row) || row.event !== 'observed' || processWorker(row) || !alive(row)) return row;
    let context;
    try { context = contextFor(row.account, row.thread); } catch { return row; }
    if (context?.account !== row.account || context.thread !== row.thread || context.runId !== row.runId
      || context.owner !== row.owner || typeof context.turn !== 'string' || !context.turn || context.turn === row.turn) return row;
    // Recover an already-poisoned/compacted observation using the same follower's public identity.
    return { ...row, event: 'running', turn: context.turn, mayRun: true, settled: false };
  });
};

export const resolveTurnState = ({ account, thread, result = {}, liveThread, rows = [], context, alive = followerAlive }) => {
  rows = reconcileTurnEvents(rows, { contextFor: (a, t) => a === account && t === thread ? context : null, alive });
  const persisted = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
  const runs = [...workerRunStates(rows).values()].filter(({ row }) => row.account === account && row.thread === thread
    && !processWorker(row) && typeof row.turn === 'string' && row.turn).sort((a, b) => a.i - b.i);
  const starts = new Map();
  rows.forEach((row, i) => {
    if (row.account === account && row.thread === thread && row.event === 'running' && !processWorker(row)
      && row.turn && !starts.has(row.turn)) starts.set(row.turn, i);
  });
  const known = new Map();
  for (const { row } of runs) known.set(row.turn, { id: row.turn, status: trackedStatus(row, alive), row });
  // A follower context can survive hot-log rotation, but only its live PID proves it is still attached.
  if (!runs.length && context?.turn && context.pid && alive(context))
    known.set(context.turn, { id: context.turn, status: 'inProgress', row: context });
  // An older follower may exit after the next turn has already attached.
  const order = new Map(runs.map(({ row, i }) => [row.turn, starts.get(row.turn) ?? i]));
  const tracked = [...known.values()].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)).at(-1);
  const hubLive = [result.thread?.activeTurn, result.thread?.currentTurn, liveThread?.activeTurn,
    liveThread?.currentTurn]
    .find(turn => turn?.id && turn.status === 'inProgress' && !ended(known.get(turn.id)?.status));
  const fallbackLive = [...(liveThread?.turns ?? []), ...persisted]
    .filter(turn => turn.status === 'inProgress' && !ended(known.get(turn.id)?.status)).at(-1);
  const matching = persisted.findLast(turn => turn.id === tracked?.id);
  let turn = hubLive, source = turn ? 'hub-live' : 'persisted';
  // An attached follower wins over older history; an idle/detached one still permits a hub fallback.
  const laterPersisted = matching && persisted.findIndex(turn => turn.id === tracked.id) < persisted.length - 1;
  const localAuthority = tracked?.status === 'inProgress' || !fallbackLive
    || ended(tracked?.status) && known.has(fallbackLive.id);
  if (!turn && tracked && !laterPersisted && localAuthority) {
    turn = tracked.row.reason === 'incoherent-final' ? { ...matching, id: tracked.id, status: tracked.status,
      reason: tracked.row.reason, quarantinePath: tracked.row.outFile }
      : ['TRUNCATED', 'uncertain', 'transport-failed'].includes(tracked.status) ? { ...matching, id: tracked.id, status: tracked.status, reason: tracked.row.reason }
      : matching && ended(matching.status) ? matching : { ...matching, id: tracked.id, status: tracked.status };
    source = turn === matching ? 'persisted' : 'tracker';
  }
  turn ??= fallbackLive ?? persisted.at(-1);
  const turns = new Map(persisted.map(turn => [turn.id, turn]));
  for (const knownTurn of known.values()) if (!turns.has(knownTurn.id)) turns.set(knownTurn.id, { id: knownTurn.id, status: knownTurn.status });
  if (turn) turns.set(turn.id, turn);
  return { thread: { ...result.thread, id: thread, name: result.thread?.name ?? tracked?.row.name },
    turn, turns: [...turns.values()], source };
};

export const readTurnState = async ({ account, thread, readThread, liveThread, rows, alive = followerAlive, readTimeoutMs = 250 }) => {
  let context;
  try { context = workerContext(account, thread, true); } catch {}
  const local = resolveTurnState({ account, thread, liveThread, rows: rows ?? readEvents(), context, alive });
  let result, timer;
  try {
    const reading = readThread(thread);
    // History supplies names/counts, but a slow read must not hide an attached live turn.
    result = local.turn?.status === 'inProgress' ? await Promise.race([reading,
      new Promise(resolve => { timer = setTimeout(() => resolve({}), readTimeoutMs); })]) : await reading;
  }
  catch (error) {
    const current = resolveTurnState({ account, thread, liveThread, rows: rows ?? readEvents(), context, alive });
    if (!current.turn) throw error;
    result = {};
  }
  finally { clearTimeout(timer); }
  return resolveTurnState({ account, thread, result, liveThread, rows: rows ?? readEvents(), context, alive });
};
