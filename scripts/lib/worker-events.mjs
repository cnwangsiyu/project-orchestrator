import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { rulesShared } from './global-rules.mjs';
import { withLock, writeJson } from './shared-file.mjs';

export const eventFile = () => path.join(rulesShared(), 'worker-events.jsonl');
export const validOwner = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
export const signalExit = (signal) => ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[signal] ?? 1;
const ownerKey = (owner) => createHash('sha256').update(owner).digest('hex');
export const ackFile = (owner) => path.join(rulesShared(), 'worker-acks', `${ownerKey(owner)}.json`);
const watcherDir = () => path.join(rulesShared(), 'worker-watchers');
const clean = (value) => typeof value === 'string' ? value.replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 2000) : '-';
const live = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const parseRows = (text) => text.split('\n').flatMap((line) => {
  try { const row = JSON.parse(line); return typeof row?.id === 'string' && typeof row.runId === 'string' && Number.isFinite(row.t)
    && (row.owner == null || validOwner(row.owner)) && ['running', 'finished', 'failed', 'stalled', 're-routed', 'needs-user', 'follower-ended'].includes(row.event) ? [row] : []; } catch { return []; }
});
export const readEvents = () => { try { return parseRows(fs.readFileSync(eventFile(), 'utf8')); } catch { return []; } };
const parseAck = (text, owner) => {
  try {
    const ack = JSON.parse(text);
    return ack.owner === owner && ack.delivered && typeof ack.delivered === 'object' && !Array.isArray(ack.delivered)
      ? { owner, delivered: Object.fromEntries(Object.entries(ack.delivered).filter(([, value]) => Number.isFinite(value?.t) && value.t >= 0)) }
      : { owner, delivered: {} };
  }
  catch { return { owner, delivered: {} }; }
};
export const readAck = (owner) => { try { return parseAck(fs.readFileSync(ackFile(owner), 'utf8'), owner); } catch { return { owner, delivered: {} }; } };

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

const withEventLock = (fn) => {
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
      let writer;
      try { writer = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}
      // Serialize reapers and re-read ownership before removing a dead writer's lock.
      if ((Number.isInteger(writer?.pid) && writer.pid > 0 && !live(writer.pid))
        || ((!Number.isInteger(writer?.pid) || writer.pid <= 0) && Date.now() - fs.statSync(lock).mtimeMs > 30000)) {
        try { fs.unlinkSync(marker); } catch {}
        fs.rmdirSync(lock);
      }
    } catch {} finally { if (reaping) try { fs.rmdirSync(reap); } catch {} }
    if (Date.now() >= until) throw Error(`event lock busy: ${lock}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
};

export const appendEvent = (row) => {
  const record = { ...row, id: randomUUID(), t: Date.now() };
  for (const key of ['name', 'model', 'thread', 'finalLine']) if (typeof record[key] === 'string') record[key] = record[key].slice(0, 2000);
  withEventLock(() => {
    const fd = fs.openSync(eventFile(), 'a+', 0o600);
    try {
      const size = fs.fstatSync(fd).size, last = Buffer.alloc(1);
      if (size) fs.readSync(fd, last, 0, 1, size - 1);
      // Recover a torn last record without joining the next valid event onto it.
      const bytes = Buffer.from(`${size && last[0] !== 10 ? '\n' : ''}${JSON.stringify(record)}\n`);
      for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  });
  return record;
};

export const inbox = (rows, owner, ack = { delivered: {} }) => {
  const own = rows.filter((row) => row.owner === owner);
  const latest = new Map();
  for (const row of own) latest.set(row.runId, row);
  const turnKey = (row) => row.thread && row.turn ? JSON.stringify([row.account, row.thread, row.turn]) : null;
  const settled = new Set(own.filter((row) => ['finished', 'failed', 'needs-user', 're-routed'].includes(row.event) && !row.mayRun).map(turnKey).filter(Boolean));
  return {
    pending: own.filter((row) => row.event !== 'running' && !Object.hasOwn(ack.delivered, row.id)),
    running: [...latest.values()].filter((row) => (row.event === 'running' || row.mayRun) && !settled.has(turnKey(row))),
  };
};
const firstLine = (file) => {
  if (typeof file !== 'string') return '';
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return '';
    const buf = Buffer.alloc(4096), n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n').find((line) => line.trim()) ?? '';
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
export const eventLine = (row, message = row.finalLine ?? firstLine(row.outFile)) => `${clean(row.name ?? row.thread)}\t${clean(row.event)}\t${clean(row.outFile)}\t${clean(message)}`;

// Printing and acknowledging are serialized per owner. A failed print never acknowledges.
export const deliver = (owner, print) => withLock(ackFile(owner), () => {
  const ack = readAck(owner), rows = inbox(readEvents(), owner, ack).pending;
  if (!rows.length) return [];
  print(rows);
  for (const row of rows) ack.delivered[row.id] = { t: Date.now(), event: row.event };
  writeJson(ackFile(owner), ack);
  return rows;
});

export const hasWatcher = (owner) => {
  if (!validOwner(owner)) return false;
  try {
    return fs.readdirSync(watcherDir()).filter((file) => file.startsWith(`${ownerKey(owner)}-`)).some((file) => {
      try { const w = JSON.parse(fs.readFileSync(path.join(watcherDir(), file), 'utf8'));
        return w.owner === owner && Date.now() - w.t < 15000 && Number.isInteger(w.pid) && w.pid > 0 && live(w.pid); } catch { return false; }
    });
  } catch { return false; }
};
export const watch = async (owner, print = (rows) => new Promise((resolve, reject) =>
  process.stdout.write(rows.map((row) => eventLine(row)).join('\n') + '\n', (error) => error ? reject(error) : resolve()))) => {
  if (!validOwner(owner)) throw Error('watch needs --owner <session-id> (or ORCHESTRATOR_OWNER)');
  const file = path.join(watcherDir(), `${ownerKey(owner)}-${process.pid}-${randomUUID()}.json`);
  fs.mkdirSync(watcherDir(), { recursive: true });
  const heartbeat = () => writeJson(file, { owner, pid: process.pid, t: Date.now() });
  heartbeat();
  let stopped = false, exit = 143;
  const stop = () => { stopped = true; };
  const interrupt = () => { exit = 130; stop(); };
  const hangup = () => { exit = 129; stop(); };
  process.once('SIGTERM', stop); process.once('SIGINT', interrupt);
  process.once('SIGHUP', hangup);
  const timer = setInterval(heartbeat, 5000);
  try {
    while (!stopped) {
      if ((await deliverAsync(owner, print, Number.MAX_SAFE_INTEGER)).delivered.length) return 0;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return exit;
  } finally {
    clearInterval(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGHUP', hangup);
    try { fs.unlinkSync(file); } catch {}
  }
};

export const lifecycle = (metadata) => {
  const launcher = launcherIdentity(metadata.owner), owner = resolveOwner(metadata.owner);
  const state = { name: null, thread: null, account: 'main', model: null, exit: null, outFile: null, logFile: null, finalLine: '',
    ...metadata, launcher, owner, runId: randomUUID(), pid: process.pid };
  let ended = false, result = null, mayRun = false;
  const emit = (event, extra = {}) => {
    try { return appendEvent({ ...state, event, ...extra }); }
    catch (e) { process.stderr.write(`worker-events: NOT RECORDED: ${e.message}\n`); return null; }
  };
  emit('running');
  const tracker = {
    owner,
    sessionId: launcher.sessionId,
    set: (extra) => Object.assign(state, extra),
    update: (extra) => { Object.assign(state, extra); emit('running'); },
    result: (event, extra = {}) => { result = event; Object.assign(state, extra); },
    end: (code) => {
      if (ended) return;
      ended = true;
      emit(result ?? (code === 0 ? 'finished' : code === 4 ? 'stalled' : code === 8 || code === 9 ? 'needs-user' : 'failed'),
        { exit: code, mayRun: mayRun || !!state.mayRun || code === 4 });
    },
    signal: (signal) => { result = 'follower-ended'; mayRun = !!state.thread; Object.assign(state, { signal }); },
    warning: () => {
      let trackedHint = false;
      try { const s = fs.fstatSync(1); trackedHint = (s.isFIFO() || s.isFile()) && !!process.env.CLAUDECODE && !!owner; } catch {}
      if (!trackedHint && !hasWatcher(owner)) process.stderr.write(`worker-notify: launch as a background task (run_in_background), never detach with &; or arm codex-worker watch --owner ${owner ?? '<session-id>'}\n`);
    },
  };
  process.on('exit', (code) => tracker.end(code));
  return tracker;
};

// Hook operations stay asynchronous, non-waiting and bounded by the hook's deadline.
const readEventsAsync = async (owner) => {
  let fd;
  try {
    fd = await fsp.open(eventFile(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (!stat.isFile()) return [];
    const rows = [], buffer = Buffer.alloc(65536), decoder = new StringDecoder('utf8');
    let rest = '', discard = false;
    for (let offset = 0; offset < stat.size;) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
      rest += decoder.write(buffer.subarray(0, bytesRead));
      let end;
      while ((end = rest.indexOf('\n')) >= 0) {
        if (!discard) rows.push(...parseRows(rest.slice(0, end)).filter((row) => row.owner === owner));
        discard = false; rest = rest.slice(end + 1);
      }
      if (rest.length > 65536) { rest = ''; discard = true; }
    }
    if (!discard) rows.push(...parseRows(rest + decoder.end()).filter((row) => row.owner === owner));
    return rows;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  finally { if (fd) await fd.close().catch(() => {}); }
};
export const readInboxAsync = async (owner, { maxAckBytes = Infinity } = {}) => {
  const rows = await readEventsAsync(owner);
  let ack = '', fd;
  try {
    fd = await fsp.open(ackFile(owner), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > maxAckBytes) throw Error('ack file exceeds hook budget');
    ack = await fd.readFile('utf8');
  } catch (e) { if (e.code !== 'ENOENT') throw e; } finally { if (fd) await fd.close().catch(() => {}); }
  return inbox(rows, owner, parseAck(ack, owner));
};
export const deliverAsync = async (owner, print, limit = 10, options = {}) => {
  const file = ackFile(owner), lock = `${file}.lock`, tmp = `${file}.${process.pid}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try { if (Date.now() - (await fsp.stat(lock)).mtimeMs > 30000) await fsp.rmdir(lock); } catch {}
  try { await fsp.mkdir(lock); } catch { return { delivered: [], running: null }; }
  try {
    const snapshot = await readInboxAsync(owner, options), rows = snapshot.pending.slice(0, limit);
    if (!rows.length) return { delivered: [], running: snapshot.running };
    let raw = ''; try { raw = await fsp.readFile(file, 'utf8'); } catch {}
    const ack = parseAck(raw, owner);
    await print(rows);
    for (const row of rows) ack.delivered[row.id] = { t: Date.now(), event: row.event };
    await fsp.writeFile(tmp, JSON.stringify(ack), { mode: 0o600 });
    await fsp.rename(tmp, file);
    return { delivered: rows, running: snapshot.running };
  } finally { await fsp.unlink(tmp).catch(() => {}); await fsp.rmdir(lock).catch(() => {}); }
};
export const hasWatcherAsync = async (owner) => {
  let files; try { files = await fsp.readdir(watcherDir()); } catch { return false; }
  for (const file of files.filter((file) => file.startsWith(`${ownerKey(owner)}-`))) {
    try { const w = JSON.parse(await fsp.readFile(path.join(watcherDir(), file), 'utf8'));
      if (w.owner === owner && Date.now() - w.t < 15000 && w.pid > 0 && Number.isInteger(w.pid) && live(w.pid)) return true;
    } catch {}
  }
  return false;
};

export const auditWorkerEvents = (rows = readEvents(), since = 0) => {
  const owners = new Map();
  const acknowledgements = new Map();
  for (const row of rows) {
    const key = row.owner ?? '(unknown)', a = owners.get(key) ?? { owner: key, launches: 0, launchesWithoutIdentity: 0,
      unacknowledged: 0, totalUnacknowledged: 0, delays: [], runs: new Set() };
    owners.set(key, a);
    if (row.event === 'running') {
      if (row.t < since) continue;
      if (!a.runs.has(row.runId)) { a.runs.add(row.runId); a.launches++; if (!row.launcher?.sessionId) a.launchesWithoutIdentity++; }
    } else {
      if (!acknowledgements.has(key)) acknowledgements.set(key, validOwner(row.owner) ? readAck(row.owner).delivered : {});
      const ack = acknowledgements.get(key)[row.id];
      if (!ack) a.totalUnacknowledged++;
      if (row.t < since) continue;
      if (!ack) a.unacknowledged++;
      else a.delays.push(Math.max(0, ack.t - row.t));
    }
  }
  return [...owners.values()].map(({ delays, runs, ...a }) => {
    delays.sort((a, b) => a - b);
    const percentile = (p) => delays.length ? delays[Math.max(0, Math.ceil(delays.length * p) - 1)] : null;
    return { ...a, acknowledged: delays.length, finishToAckMs: { p50: percentile(.5), p90: percentile(.9), max: delays.at(-1) ?? null } };
  });
};
