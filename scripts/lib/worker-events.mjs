import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';

export const RETENTION_MS = 7 * 86400000;
export const ROTATE_BYTES = 1024 * 1024;
export const ACK_RECEIPTS = 64;
const DEAD_FOLLOWER_GRACE_MS = 60000;
export const eventFile = () => path.join(rulesShared(), 'worker-events.jsonl');
const sequenceFile = () => path.join(rulesShared(), 'worker-events-state.json');
const historyDir = () => path.join(rulesShared(), 'worker-event-history');
export const validOwner = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
export const signalExit = (signal) => ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[signal] ?? 1;
const ownerKey = (owner) => createHash('sha256').update(owner).digest('hex');
export const ackFile = (owner) => path.join(rulesShared(), 'worker-acks', `${ownerKey(owner)}.json`);
const receiptFile = (owner) => path.join(rulesShared(), 'worker-ack-history', `${ownerKey(owner)}.jsonl`);
const watcherFile = (owner) => path.join(rulesShared(), 'worker-watchers', `${ownerKey(owner)}.claim`);
const clean = (value) => typeof value === 'string' ? value.replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 2000) : '-';
const live = (pid) => { try { return Number.isInteger(pid) && pid > 0 && (process.kill(pid, 0), true); } catch (e) { return e.code === 'EPERM'; } };
const notification = (row) => row.event !== 'running' && row.event !== 'observed';
const parseRows = (text) => text.split('\n').flatMap((line) => {
  try { const row = JSON.parse(line); return typeof row?.id === 'string' && typeof row.runId === 'string' && Number.isFinite(row.t)
    && (row.owner == null || validOwner(row.owner)) && ['running', 'finished', 'failed', 'stalled', 're-routed', 'needs-user', 'follower-ended', 'observed'].includes(row.event) ? [row] : []; } catch { return []; }
});
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
export const readEvents = () => parseRows(readText(eventFile()));
const emptyAck = (owner) => ({ owner, highWater: 0, delivered: {} });
const parseAck = (text, owner) => {
  try {
    const ack = JSON.parse(text);
    if (ack.owner !== owner) return emptyAck(owner);
    return { owner, highWater: Number.isSafeInteger(ack.highWater) ? ack.highWater : 0,
      delivered: ack.delivered && typeof ack.delivered === 'object' && !Array.isArray(ack.delivered) ? ack.delivered : {} };
  } catch { return emptyAck(owner); }
};
export const readAck = (owner) => parseAck(readText(ackFile(owner)), owner);
const acknowledged = (row, ack) => (Number.isSafeInteger(row.seq) && row.seq <= (ack.highWater ?? 0))
  || Number.isFinite(row.ackAt) || Number.isFinite(ack.delivered?.[row.id]?.t);
const nextAck = (ack, rows) => {
  const t = Date.now(), delivered = Object.fromEntries(Object.entries(ack.delivered).filter(([, receipt]) => receipt?.t >= t - RETENTION_MS).slice(-ACK_RECEIPTS));
  for (const row of rows) delivered[row.id] = { t, seq: row.seq, name: row.name, event: row.event, outFile: row.outFile,
    finalLine: row.finalLine ?? '', runId: row.runId };
  return { owner: ack.owner, highWater: rows.reduce((high, row) => Math.max(high, row.seq ?? 0), ack.highWater ?? 0),
    delivered: Object.fromEntries(Object.entries(delivered).slice(-ACK_RECEIPTS)) };
};

export const launcherIdentity = (override, env = process.env, cwd = process.cwd()) => {
  const sessionId = [override, env.ORCHESTRATOR_OWNER, env.CLAUDE_SESSION_ID].find(validOwner) ?? null;
  const jobId = typeof env.CLAUDE_JOB_DIR === 'string' ? path.basename(env.CLAUDE_JOB_DIR) : null;
  return { sessionId, jobId, cwd, env: Object.fromEntries(['CLAUDE_SESSION_ID', 'CLAUDE_JOB_DIR', 'CLAUDECODE', 'CLAUDE_CODE_TASK_ID']
    .filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]])) };
};
export const resolveOwner = (override, env = process.env) => {
  const launcher = launcherIdentity(override, env);
  return launcher.sessionId ?? (validOwner(launcher.jobId) ? launcher.jobId : null);
};

const withEventLock = (fn, wait = true) => {
  const lock = `${eventFile()}.lock`, marker = path.join(lock, 'writer.json'), reap = `${lock}.reap`;
  const until = Date.now() + 10000;
  fs.mkdirSync(path.dirname(eventFile()), { recursive: true });
  for (;;) {
    let acquired = false;
    try { fs.mkdirSync(lock); acquired = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (acquired) {
      try { fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }), { mode: 0o600 }); return fn(); }
      finally { try { fs.unlinkSync(marker); } catch {} try { fs.rmdirSync(lock); } catch {} }
    }
    let reaping = false;
    try {
      try { if (Date.now() - fs.statSync(reap).mtimeMs > 30000) fs.rmdirSync(reap); } catch {}
      fs.mkdirSync(reap); reaping = true;
      let writer; try { writer = JSON.parse(readText(marker)); } catch {}
      if ((Number.isInteger(writer?.pid) && writer.pid > 0 && !live(writer.pid))
        || ((!Number.isInteger(writer?.pid) || writer.pid <= 0) && Date.now() - fs.statSync(lock).mtimeMs > 30000)) {
        try { fs.unlinkSync(marker); } catch {} fs.rmdirSync(lock);
      }
    } catch {} finally { if (reaping) try { fs.rmdirSync(reap); } catch {} }
    if (!wait || Date.now() >= until) throw Error(`event lock busy: ${lock}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
};
const atomicSync = (file, value) => {
  const tmp = `${file}.${process.pid}.${randomUUID()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(tmp, 'w', 0o600); fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(tmp, file); }
  finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} }
};
const historyFiles = () => { try { return fs.readdirSync(historyDir()).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(historyDir(), name)); } catch { return []; } };
const auditRows = () => {
  const unique = new Map();
  for (const file of [...historyFiles(), eventFile()]) for (const row of parseRows(readText(file))) unique.set(row.id, row);
  return [...unique.values()].sort((a, b) => (a.seq ?? a.t) - (b.seq ?? b.t));
};

export const inbox = (rows, owner, ack = emptyAck(owner), now = Date.now()) => {
  const own = rows.filter((row) => row.owner === owner), latest = new Map(), turns = new Map(), threads = new Map();
  own.forEach((row, i) => {
    latest.set(row.runId, { row, i });
    if (row.thread && !row.mayRun && (notification(row) || row.event === 'observed')) {
      threads.set(JSON.stringify([row.account, row.thread]), i);
      if (row.turn) turns.set(JSON.stringify([row.account, row.thread, row.turn]), i);
    }
  });
  const running = [...latest.values()].filter(({ row, i }) => {
    if (row.settled || !(row.event === 'running' || row.mayRun)) return false;
    const settled = row.turn ? turns.get(JSON.stringify([row.account, row.thread, row.turn]))
      : row.thread ? threads.get(JSON.stringify([row.account, row.thread])) : undefined;
    return settled === undefined || settled < i;
  }).map(({ row }) => ({ ...row, stale: !live(row.pid) && now - row.t > DEAD_FOLLOWER_GRACE_MS }));
  return { pending: own.filter((row) => notification(row) && !acknowledged(row, ack)), running };
};

// The hot log retains pending events and latest live/uncertain state. Seven days of audit history live in rotations.
const compactLocked = (state, now = Date.now()) => {
  let rows = readEvents(), seq = state.nextSeq ?? 0;
  const migrating = rows.some((row) => !Number.isSafeInteger(row.seq));
  rows = rows.map((row) => { if (Number.isSafeInteger(row.seq)) seq = Math.max(seq, row.seq);
    return { ...row, seq: Number.isSafeInteger(row.seq) ? row.seq : ++seq }; });
  // Reserve migrated sequences before exposing them to acknowledgement writers. A failed compaction never reuses them.
  atomicSync(sequenceFile(), JSON.stringify({ ...state, nextSeq: seq }));
  if (migrating) atomicSync(eventFile(), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const keep = new Set(rows.slice(-64).map((row) => row.id));
  for (const owner of new Set(rows.map((row) => row.owner))) {
    const file = validOwner(owner) ? ackFile(owner) : null, lock = file ? `${file}.lock` : null;
    let locked = false;
    try {
      // A print transaction may still roll back its ack. Never archive/prune that owner's rows while it holds the lock.
      if (lock) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(lock); locked = true; }
      const ack = file ? readAck(owner) : emptyAck(owner), snapshot = inbox(rows, owner, ack, now);
      const runningIds = new Set(snapshot.running.map((row) => row.id));
      for (const row of rows.filter((row) => row.owner === owner && (row.event === 'running' || row.mayRun) && !runningIds.has(row.id))) {
        row.mayRun = false; row.settled = true;
      }
      const receipts = file ? readReceipts(owner) : [];
      for (const row of rows.filter((row) => row.owner === owner && notification(row) && acknowledged(row, ack)))
        row.ackAt ??= ack.delivered[row.id]?.t ?? receipts.findLast((r) => row.seq >= r.from && row.seq <= r.through)?.t;
      for (const row of [...snapshot.pending, ...snapshot.running.filter((row) => !row.stale || row.t >= now - RETENTION_MS)]) keep.add(row.id);
      if (file) {
        const next = nextAck(ack, []);
        for (const row of rows.filter((row) => row.owner === owner && notification(row))) {
          if (!acknowledged(row, ack)) break;
          next.highWater = Math.max(next.highWater, row.seq);
        }
        atomicSync(file, JSON.stringify(next));
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      for (const row of rows.filter((row) => row.owner === owner)) keep.add(row.id);
    } finally { if (locked) fs.rmdirSync(lock); }
  }
  const removed = rows.filter((row) => !keep.has(row.id));
  if (removed.length) atomicSync(path.join(historyDir(), `${now}-${randomUUID()}.jsonl`), removed.map((row) => JSON.stringify(row)).join('\n') + '\n');
  if (rows.length) {
    atomicSync(eventFile(), rows.filter((row) => keep.has(row.id)).map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  for (const file of historyFiles()) if (Number(path.basename(file).split('-')[0]) < now - RETENTION_MS) fs.unlinkSync(file);
  const next = { version: 2, nextSeq: seq, compactedAt: now, compactedSize: fs.existsSync(eventFile()) ? fs.statSync(eventFile()).size : 0 };
  atomicSync(sequenceFile(), JSON.stringify(next)); return next;
};
export const compactWorkerEvents = (now = Date.now(), { wait = true } = {}) => withEventLock(() => {
  let state = {}; try { state = JSON.parse(readText(sequenceFile())); } catch {}
  return compactLocked(state, now);
}, wait);
export const appendEvent = (row) => withEventLock(() => {
  let state = {}; try { state = JSON.parse(readText(sequenceFile())); } catch {}
  const size = fs.existsSync(eventFile()) ? fs.statSync(eventFile()).size : 0;
  if (state.version !== 2 || size - (state.compactedSize ?? 0) > ROTATE_BYTES || Date.now() - state.compactedAt > 60000)
    state = compactLocked(state);
  const record = { ...row, id: randomUUID(), t: Date.now(), seq: state.nextSeq + 1 };
  for (const key of ['name', 'model', 'thread', 'finalLine']) if (typeof record[key] === 'string') record[key] = record[key].slice(0, 2000);
  // Reserve the sequence durably before appending; a crash can leave a gap, never a reused sequence.
  atomicSync(sequenceFile(), JSON.stringify({ ...state, nextSeq: record.seq }));
  const fd = fs.openSync(eventFile(), 'a+', 0o600);
  try {
    const n = fs.fstatSync(fd).size, last = Buffer.alloc(1);
    if (n) fs.readSync(fd, last, 0, 1, n - 1);
    fs.writeFileSync(fd, `${n && last[0] !== 10 ? '\n' : ''}${JSON.stringify(record)}\n`); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return record;
});

const firstLine = (file) => {
  let fd;
  try {
    if (typeof file !== 'string') return '';
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return '';
    const buf = Buffer.alloc(4096), n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n').find((line) => line.trim()) ?? '';
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
export const eventLine = (row, message = row.finalLine ?? firstLine(row.outFile)) => `${clean(row.name ?? row.thread)}\t${clean(row.event)}\t${clean(row.outFile)}\t${clean(message)}`;
const receipt = (owner, rows, ack) => ({ owner, t: Date.now(), from: rows.reduce((n, row) => Math.min(n, row.seq ?? Infinity), Infinity),
  through: ack.highWater, ids: rows.filter((row) => !row.seq).map((row) => row.id) });
const appendReceiptSync = (entry) => {
  const file = receiptFile(entry.owner); fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, `${file}.${Date.now()}`);
  for (const name of fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.`)))
    if (Number(name.slice(path.basename(file).length + 1)) < Date.now() - RETENTION_MS) fs.unlinkSync(path.join(path.dirname(file), name));
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
};

// Persist before blocking output; ordinary print failures roll back, and duplicate delivery is harmless.
export const deliver = (owner, print) => {
  let own = readEvents().filter((row) => row.owner === owner);
  if (own.some((row) => !Number.isSafeInteger(row.seq))) {
    compactWorkerEvents(Date.now(), { wait: false }); own = readEvents().filter((row) => row.owner === owner);
  }
  return withLock(ackFile(owner), () => {
    const ack = readAck(owner), rows = inbox(own, owner, ack).pending;
    if (!rows.length) return [];
    const next = nextAck(ack, rows); atomicSync(ackFile(owner), JSON.stringify(next));
    try { print(rows); } catch (e) { atomicSync(ackFile(owner), JSON.stringify(ack)); throw e; }
    try { appendReceiptSync(receipt(owner, rows, next)); } catch {}
    return rows;
  });
};

// One cursor per watcher; unchanged polls perform only stat, not open/read/JSON.parse.
export const createEventTail = (owner) => {
  let identity = null, offset = 0, rest = '', decoder = new StringDecoder('utf8');
  const rows = new Map(), needle = `"owner":${JSON.stringify(owner)}`;
  const stats = { reads: 0, bytes: 0, parsed: 0 };
  return { stats, rows: () => [...rows.values()].sort((a, b) => (a.seq ?? a.t) - (b.seq ?? b.t)),
    prune: (ack) => {
      const own = [...rows.values()], snapshot = inbox(own, owner, ack), running = new Set(snapshot.running.map((row) => row.id));
      const keep = new Set([...snapshot.pending, ...snapshot.running].map((row) => row.id));
      for (const [id, row] of rows) {
        if (!keep.has(id)) rows.delete(id);
        else if (row.mayRun && !running.has(id)) rows.set(id, { ...row, mayRun: false, settled: true });
      }
    },
    read: async () => {
      let stat; try { stat = await fsp.stat(eventFile()); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const key = `${stat.dev}:${stat.ino}`;
      if (identity !== key || stat.size < offset) {
        identity = key; offset = 0; rest = ''; decoder = new StringDecoder('utf8'); rows.clear();
      }
      if (stat.size === offset) return [];
      let fd; const added = [];
      try {
        fd = await fsp.open(eventFile(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const actual = await fd.stat();
        if (`${actual.dev}:${actual.ino}` !== key) return [];
        const buffer = Buffer.alloc(65536);
        while (offset < actual.size) {
          const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, actual.size - offset), offset);
          if (!bytesRead) break;
          offset += bytesRead; stats.reads++; stats.bytes += bytesRead;
          rest += decoder.write(buffer.subarray(0, bytesRead));
          let end;
          while ((end = rest.indexOf('\n')) >= 0) {
            const line = rest.slice(0, end); rest = rest.slice(end + 1);
            // Compact-format streams can reject other owners before parsing. Legacy whitespace remains supported.
            if (!line.includes(needle) && !line.includes('"owner" :') && !line.includes('"owner": ')) continue;
            stats.parsed++;
            for (const row of parseRows(line)) if (row.owner === owner && !rows.has(row.id)) { rows.set(row.id, row); added.push(row); }
          }
        }
        return added;
      } finally { if (fd) await fd.close().catch(() => {}); }
    } };
};
const readAckAsync = async (owner) => {
  let raw = ''; try { raw = await fsp.readFile(ackFile(owner), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return parseAck(raw, owner);
};
export const readInboxAsync = async (owner) => {
  const tail = createEventTail(owner); await tail.read();
  return inbox(tail.rows(), owner, await readAckAsync(owner));
};
const atomicAsync = async (file, value) => {
  const tmp = `${file}.${process.pid}.${randomUUID()}`; let fd;
  const cleanupOnExit = () => { try { fs.unlinkSync(tmp); } catch {} };
  process.once('exit', cleanupOnExit);
  try {
    fd = await fsp.open(tmp, 'w', 0o600); await fd.writeFile(value); await fd.sync(); await fd.close(); fd = undefined;
    await fsp.rename(tmp, file);
  } finally {
    if (fd) await fd.close().catch(() => {}); await fsp.unlink(tmp).catch(() => {});
    process.removeListener('exit', cleanupOnExit);
  }
};
export const deliverAsync = async (owner, print, limit = 10, { rows: knownRows } = {}) => {
  let own = knownRows;
  if (!own) { const tail = createEventTail(owner); await tail.read(); own = tail.rows(); }
  if (own.some((row) => !Number.isSafeInteger(row.seq))) {
    // Migrate under the event lock before pruning legacy ID receipts; contention fails open, never waits in a hook.
    compactWorkerEvents(Date.now(), { wait: false });
    const tail = createEventTail(owner); await tail.read(); own = tail.rows();
  }
  const file = ackFile(owner), lock = `${file}.lock`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try { if (Date.now() - (await fsp.stat(lock)).mtimeMs > 30000) await fsp.rmdir(lock); } catch {}
  try { await fsp.mkdir(lock); } catch { return { delivered: [], pending: null, running: null, failed: true }; }
  const identity = fs.statSync(lock);
  // A hook's hard deadline exits the process without unwinding asynchronous finally blocks.
  const releaseOnExit = () => {
    try { const current = fs.statSync(lock);
      if (current.dev === identity.dev && current.ino === identity.ino) fs.rmdirSync(lock); } catch {}
  };
  process.once('exit', releaseOnExit);
  try {
    const ack = await readAckAsync(owner);
    const snapshot = inbox(own, owner, ack), rows = snapshot.pending.slice(0, limit);
    if (!rows.length) {
      if (Object.keys(ack.delivered).length > ACK_RECEIPTS) await atomicAsync(file, JSON.stringify(nextAck(ack, [])));
      return { delivered: [], ...snapshot, ack };
    }
    const next = nextAck(ack, rows); await atomicAsync(file, JSON.stringify(next));
    try { await print(rows); } catch (e) { await atomicAsync(file, JSON.stringify(ack)); throw e; }
    // Audit telemetry cannot invalidate a successfully persisted delivery acknowledgement.
    try { appendReceiptSync(receipt(owner, rows, next)); } catch {}
    return { delivered: rows, ...snapshot, ack: next };
  } finally { releaseOnExit(); process.removeListener('exit', releaseOnExit); }
};

const watcherState = (owner) => { try { return JSON.parse(readText(path.join(watcherFile(owner), 'watcher.json'))); } catch { return null; } };
export const hasWatcher = (owner) => { if (!validOwner(owner)) return false; const w = watcherState(owner); return live(w?.pid) && Date.now() - w.t < 15000; };
export const hasWatcherAsync = async (owner) => {
  try { const w = JSON.parse(await fsp.readFile(path.join(watcherFile(owner), 'watcher.json'), 'utf8'));
    return w.owner === owner && live(w.pid) && Date.now() - w.t < 15000; } catch { return false; }
};
export const watch = async (owner, print = (rows) => new Promise((resolve, reject) =>
  process.stdout.write(rows.map((row) => eventLine(row)).join('\n') + '\n', (error) => error ? reject(error) : resolve()))) => {
  if (!validOwner(owner)) throw Error('watch needs --owner <session-id> (or ORCHESTRATOR_OWNER)');
  // Capture acknowledgement state before publishing the live claim; a hook may deliver immediately after it sees us.
  const baseline = await readAckAsync(owner);
  const claim = watcherFile(owner), file = path.join(claim, 'watcher.json'), token = randomUUID();
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  try { fs.mkdirSync(claim); } catch {
    const reaper = `${claim}.reap`; let locked = false;
    try {
      try { if (Date.now() - fs.statSync(reaper).mtimeMs > 30000) fs.rmdirSync(reaper); } catch {}
      fs.mkdirSync(reaper); locked = true;
      const old = watcherState(owner);
      if (live(old?.pid)) { await print([{ name: owner, event: 'watcher-already-armed', finalLine: `pid=${old.pid}` }]); return 0; }
      // Do not reap a new claim whose writer has not published its PID yet.
      if (!old && Date.now() - fs.statSync(claim).mtimeMs < 30000) { await print([{ name: owner, event: 'watcher-already-arming' }]); return 0; }
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.rmdirSync(claim); fs.mkdirSync(claim);
    } catch { return 0; } finally { if (locked) try { fs.rmdirSync(reaper); } catch {} }
  }
  const heartbeat = () => writeJson(file, { owner, pid: process.pid, token, t: Date.now() });
  const tail = createEventTail(owner), waitingRuns = new Set();
  let stopped = false, exit = 143;
  const stop = () => { stopped = true; }, interrupt = () => { exit = 130; stop(); }, hangup = () => { exit = 129; stop(); };
  process.once('SIGTERM', stop); process.once('SIGINT', interrupt); process.once('SIGHUP', hangup);
  let timer;
  try {
    heartbeat();
    timer = setInterval(() => { try { heartbeat(); } catch { exit = 1; stop(); } }, 5000);
    for (;;) {
      if (stopped) return exit;
      await tail.read();
      const ack = await readAckAsync(owner), own = tail.rows(), snapshot = inbox(own, owner, ack);
      for (const row of snapshot.running.filter((row) => !row.stale)) waitingRuns.add(row.runId);
      const advanced = ack.highWater > baseline.highWater || Object.keys(ack.delivered).some((id) => !baseline.delivered[id]);
      if (snapshot.pending.length) {
        let result;
        try { result = await deliverAsync(owner, print, Number.MAX_SAFE_INTEGER, { rows: own }); }
        catch { result = { delivered: [] }; }
        if (!result.delivered.length) await print(snapshot.pending.map((row) => ({ ...row, finalLine: `${row.finalLine ?? ''} (delivered elsewhere or acknowledgement unavailable)` })));
        return 0;
      }
      if (advanced) {
        const receipts = Object.values(ack.delivered).filter((row) => (row.seq ?? 0) > baseline.highWater);
        await print(receipts.length ? receipts.map((row) => ({ ...row, finalLine: `${row.finalLine ?? ''} (acknowledged elsewhere)` }))
          : [{ name: owner, event: 'acknowledged-elsewhere', finalLine: `through sequence ${ack.highWater}` }]); return 0;
      }
      if (waitingRuns.size && !snapshot.running.some((row) => !row.stale && waitingRuns.has(row.runId))) {
        await print([{ name: owner, event: 'workers-no-longer-running', finalLine: 'observed completion or stale/dead follower; reconcile with mine' }]);
        return 0;
      }
      tail.prune(ack);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    clearInterval(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', interrupt); process.removeListener('SIGHUP', hangup);
    if (!watcherState(owner) || watcherState(owner)?.token === token) {
      try { fs.unlinkSync(file); } catch {}
      try { fs.rmdirSync(claim); } catch {}
    }
  }
};

export const lifecycle = (metadata) => {
  const launcher = launcherIdentity(metadata.owner), owner = resolveOwner(metadata.owner);
  const state = { name: null, thread: null, account: 'main', model: null, exit: null, outFile: null, logFile: null, finalLine: '',
    ...metadata, launcher, owner, runId: randomUUID(), pid: process.pid };
  let ended = false, result = null, mayRun = false;
  const emit = (event, extra = {}) => { try { return appendEvent({ ...state, event, ...extra }); }
    catch (e) { process.stderr.write(`worker-events: NOT RECORDED: ${e.message}\n`); return null; } };
  emit('running');
  const tracker = {
    owner, sessionId: launcher.sessionId,
    set: (extra) => Object.assign(state, extra),
    update: (extra) => { Object.assign(state, extra); emit('running'); },
    result: (event, extra = {}) => { result = event; Object.assign(state, extra); },
    end: (code) => { if (ended) return; ended = true;
      emit(result ?? (code === 0 ? 'finished' : code === 4 ? 'stalled' : code === 8 || code === 9 ? 'needs-user' : 'failed'),
        { exit: code, mayRun: mayRun || !!state.mayRun || code === 4 }); },
    signal: (signal) => { result = 'follower-ended'; mayRun = !!state.thread; Object.assign(state, { signal }); },
    warning: () => {
      let hint = false; try { const s = fs.fstatSync(1); hint = (s.isFIFO() || s.isFile()) && !!process.env.CLAUDECODE && !!owner; } catch {}
      if (!hint && !hasWatcher(owner)) process.stderr.write(`worker-notify: launch as a background task (run_in_background), never detach with &; or arm codex-worker watch --owner ${owner ?? '<session-id>'}\n`);
    },
  };
  process.on('exit', (code) => tracker.end(code)); return tracker;
};

const readReceipts = (owner) => {
  const file = receiptFile(owner), dir = path.dirname(file), prefix = path.basename(file);
  let files = []; try { files = fs.readdirSync(dir).filter((name) => name === prefix || name.startsWith(`${prefix}.`)); } catch {}
  return files.flatMap((name) => readText(path.join(dir, name)).split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }));
};
export const auditWorkerEvents = (rows = auditRows(), since = 0) => {
  const owners = new Map();
  for (const row of rows) {
    const key = row.owner ?? '(unknown)';
    if (!owners.has(key)) owners.set(key, { owner: key, launches: 0, launchesWithoutIdentity: 0, unacknowledged: 0,
      totalUnacknowledged: 0, acknowledgedCount: 0, latencyUnknown: 0, delays: [], runs: new Set(), ack: validOwner(row.owner) ? readAck(row.owner) : emptyAck(key),
      receipts: validOwner(row.owner) ? readReceipts(row.owner) : [] });
    const a = owners.get(key);
    if (row.event === 'running') {
      if (row.t >= since && !a.runs.has(row.runId)) { a.runs.add(row.runId); a.launches++; if (!row.launcher?.sessionId) a.launchesWithoutIdentity++; }
    } else if (notification(row)) {
      const acked = acknowledged(row, a.ack);
      if (!acked) a.totalUnacknowledged++;
      if (row.t < since) continue;
      if (!acked) a.unacknowledged++;
      else {
        a.acknowledgedCount++;
        const at = row.ackAt ?? a.ack.delivered[row.id]?.t ?? a.receipts.findLast((r) => (row.seq >= r.from && row.seq <= r.through) || r.ids?.includes(row.id))?.t;
        if (Number.isFinite(at)) a.delays.push(Math.max(0, at - row.t));
        else a.latencyUnknown++;
      }
    }
  }
  return [...owners.values()].map(({ delays, runs, ack, receipts, acknowledgedCount, ...a }) => {
    delays.sort((a, b) => a - b);
    const p = (n) => delays.length ? delays[Math.max(0, Math.ceil(delays.length * n) - 1)] : null;
    return { ...a, acknowledged: acknowledgedCount, finishToAckMs: { p50: p(.5), p90: p(.9), max: delays.at(-1) ?? null }, retentionDays: 7 };
  });
};
