import { checkedLogStat, sameLog, redactLogFile } from './log-redaction.mjs';
import { redactRolloutFile } from './rollout-redaction.mjs';
import { threadRollouts } from './worker-thread-size.mjs';
import { appendNote } from './worker-events.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function threadIsIdle(result) {
  const thread = result?.thread;
  if (!thread || !Array.isArray(thread.turns)) return false;
  if (thread.status?.type === 'active') return false;
  return thread.turns.every(turn => ['completed', 'failed', 'interrupted'].includes(turn.status));
}

export async function checkThreadIdle(call, threadId, { statusOnly = false } = {}) {
  if (!statusOnly) try {
    const result = await call('thread/read', { threadId, includeTurns: true });
    if (Array.isArray(result?.thread?.turns)) return threadIsIdle(result);
  } catch { /* Exec threads may not be loaded in the hub. Check its live status instead. */ }
  let cursor;
  for (let page = 0; page < 100; page++) {
    const result = await call('thread/list', { limit: 100, cursor });
    if (!Array.isArray(result?.data)) return false;
    const found = result.data.find(row => row.id === threadId);
    if (found) return ['idle', 'notLoaded', 'completed', 'failed', 'interrupted'].includes(found.status?.type);
    if (!result.nextCursor) return true;
    cursor = result.nextCursor;
  }
  return false;
}

// Only contact an existing hub; never start one or alter account/login state.
export function hubThreadIdle(hub, thread) {
  return new Promise((resolve, reject) => {
    let socket, timer, finished = false, id = 0, pending;
    const finish = (error, idle) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        try { socket.close(); } catch {}
      }
      error ? reject(error) : resolve(idle);
    };
    const call = (method, params) => new Promise((resolve, reject) => {
      pending = { resolve, reject };
      socket.send(JSON.stringify({ id: ++id, method, params }));
    });
    timer = setTimeout(() => finish(Error('hub status unavailable')), 750);
    try {
      socket = new WebSocket(hub);
      socket.onopen = async () => {
        try {
          await call('initialize', { clientInfo: { name: 'worker-redaction', version: '1.0' } });
          socket.send(JSON.stringify({ method: 'initialized', params: {} }));
          finish(null, await checkThreadIdle(call, thread));
        } catch { finish(Error('hub status unavailable')); }
      };
      socket.onerror = socket.onclose = () => finish(Error('hub status unavailable'));
      socket.onmessage = event => {
        let row; try { row = JSON.parse(String(event.data)); } catch { return; }
        if (row.id !== id || row.method || !pending) return;
        const response = pending; pending = null;
        row.error ? response.reject(Error('hub status unavailable')) : response.resolve(row.result);
      };
    } catch { finish(Error('hub status unavailable')); }
  });
}

export async function redactWorkerTurn({ home, thread, log, out, checkIdle, tracker,
  warn = message => console.error(message), print = message => console.log(message) }) {
  const masked = { log: 0, rollout: 0, out: 0 };
  const warning = scope => { try { warn(`redaction warning: ${scope}; logs left unchanged where unsafe`); } catch {} };
  const idle = async () => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(checkIdle),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('status timeout')), 750); })]) === true;
    } catch { return false; } finally { clearTimeout(timer); }
  };
  try {
    if (!thread || !checkIdle) return masked;
    if (!await idle()) { warning('turn still running or hub status unconfirmed'); return masked; }
    const files = [];
    if (log) files.push({ kind: 'log', file: log });
    if (out) files.push({ kind: 'out', file: out });
    for (const file of await threadRollouts(home, thread)) files.push({ kind: 'rollout', file });
    for (const target of files) {
      try { target.stat = checkedLogStat(target.file, { markdown: target.kind === 'out' }); }
      catch (error) { if (error.code !== 'ENOENT') warning(`${target.kind} I/O or unsafe path`); }
    }
    // No retry loop: a concurrent writer or a newly started turn makes this attempt fail open.
    await sleep(2000);
    if (!await idle()) { warning('turn restarted or hub status unconfirmed'); return masked; }
    tracker?.set({ settled: true, mayRun: false });
    // Include new rollouts that appeared during the quiescence window.
    const rollouts = await threadRollouts(home, thread);
    const prior = files.filter(target => target.kind === 'rollout');
    if (rollouts.length !== prior.length || rollouts.some(file => !prior.some(target => target.file === file))) {
      warning('rollout changed during idle check'); return masked;
    }
    for (const target of prior) {
      if (!target.stat) continue;
      try {
        if (!sameLog(target.stat, checkedLogStat(target.file))) {
          warning('rollout still growing'); return masked;
        }
      } catch { warning('rollout I/O or unsafe path'); }
    }
    const seen = new Set();
    for (const target of files) {
      if (!target.stat || seen.has(target.file)) continue;
      // A --log/--out alias must not rewrite the durable rollout either.
      if (target.kind !== 'rollout' && prior.some(rollout => rollout.stat
        && rollout.stat.dev === target.stat.dev && rollout.stat.ino === target.stat.ino)) continue;
      seen.add(target.file);
      try {
        const result = target.kind === 'rollout'
          ? redactRolloutFile(target.file, { expected: target.stat })
          : redactLogFile(target.file, { force: true, markdown: target.kind === 'out', expected: target.stat });
        masked[target.kind] += result.masked;
      } catch { warning(`${target.kind} I/O or concurrent writer`); }
    }
    if (Object.values(masked).some(n => n > 0)) {
      const counts = `log=${masked.log} rollout=${masked.rollout} out=${masked.out}`;
      try { print(`redacted: ${counts}`); } catch {}
      try { appendNote({ ...tracker?.metadata(), thread }, 'info',
        `secret-like values were printed and have been masked in the logs (${counts})`, false); }
      catch { warning('info note could not be recorded'); }
    }
  } catch { warning('turn-end redaction could not complete'); }
  finally { try { tracker?.set({ masked }); } catch {} }
  return masked;
}
