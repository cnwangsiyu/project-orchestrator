import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { rulesShared } from './global-rules.mjs';
import { writeJson } from './shared-file.mjs';

export const RETENTION_MS = 7 * 86400000;
export const ROTATE_BYTES = 1024 * 1024;
export const ACK_RECEIPTS = 64;
export const TRANSACTION_RETRY_MS = 3000;
const DEAD_FOLLOWER_GRACE_MS = 60000;
export const eventFile = () => path.join(rulesShared(), 'worker-events.jsonl');
let eventObserver = null;
export const setEventObserver = observer => { eventObserver = observer; };
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
const talkback = (row) => ['message', 'question', 'answered'].includes(row.event);
const terminal = (row) => !talkback(row) && row.event !== 'running';
const notification = (row) => row.event !== 'running' && row.event !== 'observed' && row.event !== 'answered';
const waking = (row) => notification(row) && (row.event !== 'message' || row.wake !== false);
export const followerAlive = (row) => live(row.pid);
const parseRows = (text) => text.split('\n').flatMap((line) => {
  try { const row = JSON.parse(line); return typeof row?.id === 'string' && typeof row.runId === 'string' && Number.isFinite(row.t)
    && (row.owner == null || validOwner(row.owner)) && ['running', 'finished', 'failed', 'stalled', 're-routed', 'needs-user', 'follower-ended', 'observed', 'message', 'question', 'answered'].includes(row.event) ? [row] : []; } catch { return []; }
});
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const fullOwner = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const shortOwner = value => typeof value === 'string' && !fullOwner(value) && /^[0-9a-f][0-9a-f-]{0,34}$/i.test(value);
export const normalizeOwners = (rows, fullIds = rows.flatMap(row=>[row.owner,...(row.ownerMatches??[])]).filter(fullOwner)) => {
  const ids=[...new Set(fullIds.filter(fullOwner))];
  return rows.map(row=>{
    const raw=row.ownerOriginal??row.owner;
    if(!shortOwner(raw)) return row;
    const matches=ids.filter(id=>id.toLowerCase().startsWith(raw.toLowerCase()));
    return matches.length===1 ? {...row,owner:matches[0],ownerOriginal:raw,ownerResolution:'resolved'}
      : {...row,owner:raw,ownerOriginal:raw,ownerResolution:matches.length?'ambiguous':'unmatched',ownerMatches:matches};
  });
};
export const readEvents = () => normalizeOwners(parseRows(readText(eventFile())));
const eventOwner = (owner, rows) => {
  if(!shortOwner(owner)) return owner;
  const ids=[...new Set(rows.flatMap(row=>[row.owner,...(row.ownerMatches??[])]).filter(fullOwner))];
  const matches=ids.filter(id=>id.toLowerCase().startsWith(owner.toLowerCase()));
  return matches.length===1?matches[0]:owner;
};
const emptyAck = (owner) => ({ owner, highWater: 0, delivered: {}, transaction: null });
const parseAck = (text, owner) => {
  try {
    const ack = JSON.parse(text);
    if (ack.owner !== owner) return emptyAck(owner);
    const tx = ack.transaction;
    const transaction = typeof tx?.token === 'string' && Number.isFinite(tx.t) && Array.isArray(tx.events)
      ? { token: tx.token, t: tx.t, pid: tx.pid, events: tx.events.filter((row) => typeof row?.id === 'string').slice(0, ACK_RECEIPTS) } : null;
    return { owner, highWater: Number.isSafeInteger(ack.highWater) ? ack.highWater : 0, transaction,
      delivered: ack.delivered && typeof ack.delivered === 'object' && !Array.isArray(ack.delivered) ? ack.delivered : {} };
  } catch { return emptyAck(owner); }
};
export const readAck = (owner) => {if(shortOwner(owner)) owner=eventOwner(owner,readEvents());return parseAck(readText(ackFile(owner)),owner);};
const acknowledged = (row, ack) => (Number.isSafeInteger(row.seq) && row.seq <= (ack.highWater ?? 0))
  || Number.isFinite(row.ackAt) || Number.isFinite(ack.delivered?.[row.id]?.t);
const nextAck = (ack, rows, transaction = ack.transaction) => {
  const t = Date.now(), delivered = Object.fromEntries(Object.entries(ack.delivered).filter(([, receipt]) => receipt?.t >= t - RETENTION_MS).slice(-ACK_RECEIPTS));
  for (const row of rows) delivered[row.id] = { t, seq: row.seq, name: row.name, event: row.event, outFile: row.outFile,
    finalLine: row.finalLine ?? '', runId: row.runId, owner: row.owner, account: row.account, thread: row.thread,
    kind: row.kind, text: row.text, wake: row.wake, questionId: row.questionId, timeoutMin: row.timeoutMin, expiresAt: row.expiresAt, questionText: row.questionText, default: row.default };
  return { owner: ack.owner, transaction: transaction ?? null,
    highWater: rows.reduce((high, row) => Math.max(high, row.seq ?? 0), ack.highWater ?? 0),
    delivered: Object.fromEntries(Object.entries(delivered).slice(-ACK_RECEIPTS)) };
};
const transactionActive = (ack) => ack.transaction && Date.now() - ack.transaction.t < TRANSACTION_RETRY_MS && live(ack.transaction.pid);
const prepareTransaction = (ack, rows) => ({ ...nextAck(ack, []), transaction: { token: randomUUID(), t: Date.now(), pid: process.pid,
  events: rows.map(({ id, seq }) => ({ id, seq })) } });

export const launcherIdentity = (override, env = process.env, cwd = process.cwd()) => {
  const sessionId = resolveOwner(override, env);
  const jobId = typeof env.CLAUDE_JOB_DIR === 'string' ? path.basename(env.CLAUDE_JOB_DIR) : null;
  return { sessionId, jobId, cwd, env: Object.fromEntries(['CLAUDE_SESSION_ID', 'CLAUDE_JOB_DIR', 'CLAUDECODE', 'CLAUDE_CODE_TASK_ID']
    .filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]])) };
};
export const resolveOwner = (override, env = process.env) => {
  // No reliable Claude Bash session-ID variable is documented; SessionStart
  // exports the hook's full session_id through ORCHESTRATOR_OWNER instead.
  const raw = override ?? (env.ORCHESTRATOR_OWNER || null);
  if (raw === null || fullOwner(raw)) return raw;
  if (typeof raw === 'string' && raw.length && fullOwner(env.ORCHESTRATOR_OWNER)
    && env.ORCHESTRATOR_OWNER.toLowerCase().startsWith(raw.toLowerCase())) return env.ORCHESTRATOR_OWNER;
  const error = Error('pass the full session id (or omit --owner to use ORCHESTRATOR_OWNER)');
  error.exitCode = 2; throw error;
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
const acquireAckLock = (owner) => {
  const file = ackFile(owner), lock = `${file}.lock`, marker = path.join(lock, 'writer.json'), reaper = `${lock}.reap`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let reaping = false;
    try {
      try { if (Date.now() - fs.statSync(reaper).mtimeMs > 30000) fs.rmdirSync(reaper); } catch {}
      fs.mkdirSync(reaper); reaping = true;
      let writer; try { writer = JSON.parse(readText(marker)); } catch {}
      if ((Number.isInteger(writer?.pid) && !live(writer.pid))
        || (!writer && Date.now() - fs.statSync(lock).mtimeMs > 30000)) {
        try { fs.unlinkSync(marker); } catch {} fs.rmdirSync(lock);
      }
    } catch {} finally { if (reaping) try { fs.rmdirSync(reaper); } catch {} }
    try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  }
  const identity = fs.statSync(lock), token = randomUUID();
  const release = () => {
    try { const current = fs.statSync(lock);
      if (current.dev === identity.dev && current.ino === identity.ino) {
        fs.unlinkSync(marker); fs.rmdirSync(lock);
      } } catch {}
    process.removeListener('exit', release);
  };
  try { fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 }); }
  catch (e) { try { fs.unlinkSync(marker); } catch {} try { fs.rmdirSync(lock); } catch {} throw e; }
  process.once('exit', release);
  return release;
};
const historyFiles = () => { try { return fs.readdirSync(historyDir()).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(historyDir(), name)); } catch { return []; } };
const auditRows = () => {
  const unique = new Map();
  for (const file of [...historyFiles(), eventFile()]) for (const row of parseRows(readText(file))) unique.set(row.id, row);
  return normalizeOwners([...unique.values()]).sort((a, b) => (a.seq ?? a.t) - (b.seq ?? b.t));
};

export const inbox = (rows, owner, ack = emptyAck(owner), now = Date.now()) => {
  // The asking session's own full id also resolves short owners: a session that always launches with its 8-character id
  // never writes the full id into the events, and its rows would stay unmatched for ever.
  rows = normalizeOwners(rows, [...rows.flatMap(row=>[row.owner,...(row.ownerMatches??[])]), owner]);
  const matches = [...new Set(rows.map(row=>row.owner).filter(fullOwner))].filter(id=>shortOwner(owner)&&id.toLowerCase().startsWith(owner.toLowerCase()));
  if(matches.length===1) owner=matches[0];
  const unresolved = rows.filter(row=>['ambiguous','unmatched'].includes(row.ownerResolution));
  const own = rows.filter((row) => row.owner === owner && !['ambiguous','unmatched'].includes(row.ownerResolution)), latest = new Map(), turns = new Map(), threads = new Map();
  own.forEach((row, i) => {
    if (talkback(row)) return;
    latest.set(row.runId, { row, i });
    if (row.thread && !row.mayRun && terminal(row)) {
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
  const questionKey = row => JSON.stringify([row.account,row.thread,row.questionId]);
  const answers = new Map(own.filter(row => row.event === 'answered').map(row => [questionKey(row),row]));
  const pending = own.filter(row => notification(row) && !acknowledged(row,ack)).map(row => {
    const answer = row.event === 'question' && answers.get(questionKey(row));
    // Keep the question's delivery identity so the existing cursor delivers it once.
    return answer ? {...row,event:'answered',questionText:row.text,text:answer.text,answeredAt:answer.answeredAt} : row;
  });
  return {pending,running,unresolved,questions: openQuestions(own, { owner, now })};
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
  // Unresolved owners remain visible until they can be resolved; retain one
  // full UUID anchor per owner so later short-key completions have evidence.
  const anchors=new Map();
  for(const row of rows) {
    if(['ambiguous','unmatched'].includes(row.ownerResolution)) keep.add(row.id);
    if(fullOwner(row.owner)&&!row.ownerOriginal) anchors.set(row.owner,row.id);
  }
  for(const id of anchors.values()) keep.add(id);
  // Delivery acknowledgement does not close a question. Preserve it until reply/deadline;
  // hourly note accounting must survive compaction, including suppressed notes.
  for (const row of rows) if ((row.event === 'message' && row.t > now - 3600000)
    || (row.event === 'question' && row.expiresAt > now)) keep.add(row.id);
  for (const owner of new Set(rows.map((row) => row.owner))) {
    const file = validOwner(owner) ? ackFile(owner) : null;
    let release;
    try {
      if (file) {
        release = acquireAckLock(owner);
        if (!release) { for (const row of rows.filter((row) => row.owner === owner)) keep.add(row.id); continue; }
      }
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
    } finally { release?.(); }
  }
  const retainedQuestions = new Set(rows.filter((row) => row.event === 'question' && keep.has(row.id)).map((row) => row.questionId));
  for (const row of rows) if (row.event === 'answered' && retainedQuestions.has(row.questionId)) keep.add(row.id);
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
const appendLocked = (row) => {
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
  try { eventObserver?.(record); } catch {}
  return record;
};
export const appendEvent = (row) => withEventLock(() => appendLocked(row));

const publicPair = (account, thread) => {
  if (![account, thread].every(validOwner)) throw Error('invalid public account/thread identifier');
};
export const contextFile = (account, thread) => {
  publicPair(account, thread);
  return path.join(rulesShared(), 'worker-context', account, `${thread}.json`);
};
export const saveWorkerContext = (metadata) => {
  const file = contextFile(metadata.account, metadata.thread);
  atomicSync(file, JSON.stringify({ ...metadata, t: Date.now() }));
  return file;
};
export const workerContext = (account, thread, optional = false) => {
  const record = JSON.parse(readText(contextFile(account, thread)) || 'null');
  if (!record && optional) return null;
  if (!record || record.account !== account || record.thread !== thread || !optional && !validOwner(record.owner))
    throw Error('no launching owner in worker context; use the account/thread supplied by the launcher');
  return record;
};
export const replyFile = (account, thread, question) => {
  publicPair(account, thread);
  if (!validOwner(question)) throw Error('invalid question identifier');
  return path.join(rulesShared(), 'worker-replies', account, thread, `${question}.json`);
};
export const openQuestions = (rows, { owner, account, thread, now = Date.now() } = {}) => {
  const answered = new Set(rows.filter((row) => row.event === 'answered').map((row) => JSON.stringify([row.account, row.thread, row.questionId])));
  return rows.filter((row) => row.event === 'question' && row.expiresAt > now
    && (owner === undefined || row.owner === owner) && (account === undefined || row.account === account)
    && (thread === undefined || row.thread === thread) && !answered.has(JSON.stringify([row.account, row.thread, row.questionId])))
    .sort((a, b) => a.seq - b.seq);
};
const noteLocked = (metadata, kind, text, wake = false) => {
  const count = readEvents().filter((row) => row.event === 'message' && row.account === metadata.account
    && row.thread === metadata.thread && row.t > Date.now() - 3600000 && row.wake !== false).length;
  return appendLocked({ ...metadata, event: 'message', kind, text: text.slice(0, 500),
    truncated: text.length > 500, wake: (wake || ['risk', 'scope'].includes(kind)) && count < 6 && text.length <= 500 });
};
export const appendNote = (metadata, kind, text, wake = false) => withEventLock(() => noteLocked(metadata, kind, text, wake));
export const appendTalkback = (metadata, request) => withEventLock(() => {
  const prior = readEvents().find((row) => row.account === metadata.account && row.thread === metadata.thread
    && row.talkbackId === request.id && ['message', 'question'].includes(row.event));
  if (prior) return prior;
  const fields = { ...metadata, talkbackId: request.id };
  return request.type === 'message' ? noteLocked(fields, request.kind, request.text, request.wake === true)
    : appendLocked({ ...fields, event: 'question', questionId: request.id, text: request.text,
      timeoutMin: request.timeoutMin, expiresAt: request.expiresAt,
      ...(request.default !== undefined ? { default: request.default } : {}) });
});
export const answerQuestion = ({ owner, account, thread, questionId, text }) => withEventLock(() => {
  publicPair(account, thread);
  const question = openQuestions(readEvents(), { owner, account, thread }).filter((row) => !questionId || row.questionId === questionId).at(-1);
  if (!question) return null;
  const file = replyFile(account, thread, question.questionId);
  // Never replace an answer if a writer died between the file and event commits.
  let answer; try { answer = JSON.parse(readText(file)); } catch {}
  if (!answer) {
    answer = { account, thread, questionId: question.questionId, owner: question.owner, text, t: Date.now() };
    atomicSync(file, JSON.stringify(answer));
  }
  appendLocked({ ...question, event: 'answered', text: answer.text, answeredAt: answer.t });
  return answer;
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
export const eventLine = (row, message = row.finalLine ?? firstLine(row.outFile)) => {
  if (row.event === 'answered') return `worker ${clean(row.name ?? row.thread)} answered: ${clean(row.questionText)} → ${clean(row.text)}`;
  if (row.event === 'message') return `worker ${clean(row.name ?? row.thread)} notes [${clean(row.kind)}]: ${clean(row.text)}`;
  if (row.event === 'question') return `worker ${clean(row.name ?? row.thread)} asks (id ${clean(row.questionId)}): ${clean(row.text)}`
    + `${row.default !== undefined ? ` — default: ${clean(row.default)}` : ''} — timeout ${row.timeoutMin}m; answer with codex-worker reply${row.owner ? ` --owner ${clean(row.owner)}` : ''} --thread ${clean(row.thread)} --account ${clean(row.account)} --question ${clean(row.questionId)} "<text>"`;
  return `${clean(row.name ?? row.thread)}\t${clean(row.event)}\t${clean(row.outFile)}\t${clean(message)}`;
};
const receipt = (owner, rows, ack) => ({ owner, t: Date.now(), from: rows.reduce((n, row) => Math.min(n, row.seq ?? Infinity), Infinity),
  through: ack.highWater, ids: rows.filter((row) => !row.seq).map((row) => row.id) });
const appendReceiptSync = (entry) => {
  const file = receiptFile(entry.owner); fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, `${file}.${Date.now()}`);
  for (const name of fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.`)))
    if (Number(name.slice(path.basename(file).length + 1)) < Date.now() - RETENTION_MS) fs.unlinkSync(path.join(path.dirname(file), name));
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
};

// Intent never advances the acknowledgement. Output runs outside the lock; stale intents can be retried.
export const deliver = (owner, print) => {
  if(shortOwner(owner)) owner=eventOwner(owner,readEvents());
  let own = readEvents().filter((row) => row.owner === owner);
  if (own.some((row) => !Number.isSafeInteger(row.seq))) {
    compactWorkerEvents(Date.now(), { wait: false }); own = readEvents().filter((row) => row.owner === owner);
  }
  const delivered = [], file = ackFile(owner);
  for (;;) {
    let prepared, rows;
    const release = acquireAckLock(owner); if (!release) return delivered;
    try {
      const ack = readAck(owner);
      if (transactionActive(ack)) return delivered;
      rows = inbox(own, owner, ack).pending.slice(0, ACK_RECEIPTS);
      if (!rows.length) return delivered;
      prepared = prepareTransaction(ack, rows); atomicSync(file, JSON.stringify(prepared));
    } finally { release(); }
    try { print(rows); } catch (e) {
      const abort = acquireAckLock(owner);
      if (abort) try {
        const ack = readAck(owner);
        if (ack.transaction?.token === prepared.transaction.token) atomicSync(file, JSON.stringify({ ...ack, transaction: null }));
      } finally { abort(); }
      throw e;
    }
    delivered.push(...rows);
    const commit = acquireAckLock(owner); if (!commit) return delivered;
    try {
      const ack = readAck(owner); if (ack.transaction?.token !== prepared.transaction.token) return delivered;
      const next = nextAck(ack, rows, null); atomicSync(file, JSON.stringify(next));
      try { appendReceiptSync(receipt(owner, rows, next)); } catch {}
    } finally { commit(); }
  }
};

// One cursor per watcher; unchanged polls perform only stat, not open/read/JSON.parse.
export const createEventTail = (owner) => {
  if(shortOwner(owner)) owner=eventOwner(owner,readEvents());
  let identity = null, offset = 0, rest = '', decoder = new StringDecoder('utf8');
  const fullIds = new Set();
  const rows = new Map(), needle = `"owner":${JSON.stringify(owner)}`;
  const stats = { reads: 0, bytes: 0, parsed: 0 };
  return { stats, rows: () => normalizeOwners([...rows.values()], [...fullIds]).sort((a, b) => (a.seq ?? a.t) - (b.seq ?? b.t)),
    prune: (ack) => {
      const own = normalizeOwners([...rows.values()],[...fullIds]), snapshot = inbox(own, owner, ack), running = new Set(snapshot.running.map((row) => row.id));
      const keep = new Set([...snapshot.pending, ...snapshot.running, ...snapshot.questions].map((row) => row.id));
      const unresolvedIds = new Set(snapshot.unresolved.map(row=>row.id));
      for (const [id, row] of rows) {
        if (!keep.has(id) && !unresolvedIds.has(id)) rows.delete(id);
        else if (row.mayRun && !running.has(id)) rows.set(id, { ...row, mayRun: false, settled: true });
      }
    },
    read: async () => {
      let stat; try { stat = await fsp.stat(eventFile()); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const key = `${stat.dev}:${stat.ino}`;
      if (identity !== key || stat.size < offset) {
        identity = key; offset = 0; rest = ''; decoder = new StringDecoder('utf8'); rows.clear(); fullIds.clear();
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
            const rawOwner=line.match(/"owner"\s*:\s*"([^"]+)"/)?.[1];
            if(fullOwner(rawOwner)) fullIds.add(rawOwner);
            if (!line.includes(needle) && !shortOwner(rawOwner) && !line.includes('"owner" :') && !line.includes('"owner": ')) continue;
            stats.parsed++;
            for (const row of parseRows(line)) if ((row.owner === owner || shortOwner(row.owner)) && !rows.has(row.id)) { rows.set(row.id, row); added.push(row); }
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
  if(shortOwner(owner)) owner=eventOwner(owner,readEvents());
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
  if(shortOwner(owner)) owner=eventOwner(owner,readEvents());
  let own = knownRows;
  if (!own) { const tail = createEventTail(owner); await tail.read(); own = tail.rows(); }
  if (own.some((row) => !Number.isSafeInteger(row.seq))) {
    // Migrate under the event lock before pruning legacy ID receipts; contention fails open, never waits in a hook.
    compactWorkerEvents(Date.now(), { wait: false });
    const tail = createEventTail(owner); await tail.read(); own = tail.rows();
  }
  const file = ackFile(owner), delivered = [];
  let snapshot;
  while (delivered.length < limit) {
    let prepared, rows;
    const release = acquireAckLock(owner);
    if (!release) return { delivered, pending: snapshot?.pending ?? null, running: snapshot?.running ?? null, failed: true };
    try {
      const ack = await readAckAsync(owner), current = inbox(own, owner, ack); snapshot ??= current;
      if (transactionActive(ack)) return { delivered, ...snapshot, ack, failed: true };
      rows = current.pending.slice(0, Math.min(ACK_RECEIPTS, limit - delivered.length));
      if (!rows.length) {
        if (ack.transaction || Object.keys(ack.delivered).length > ACK_RECEIPTS) await atomicAsync(file, JSON.stringify(nextAck(ack, [], null)));
        return { delivered, ...snapshot, ack };
      }
      prepared = prepareTransaction(ack, rows); await atomicAsync(file, JSON.stringify(prepared));
    } finally { release(); }
    try { await print(rows); } catch (e) {
      const abort = acquireAckLock(owner);
      if (abort) try {
        const ack = await readAckAsync(owner);
        if (ack.transaction?.token === prepared.transaction.token) await atomicAsync(file, JSON.stringify({ ...ack, transaction: null }));
      } finally { abort(); }
      throw e;
    }
    delivered.push(...rows);
    const commit = acquireAckLock(owner);
    if (!commit) return { delivered, ...snapshot, failed: true };
    try {
      const ack = await readAckAsync(owner);
      if (ack.transaction?.token !== prepared.transaction.token) return { delivered, ...snapshot, ack };
      const next = nextAck(ack, rows, null); await atomicAsync(file, JSON.stringify(next));
      try { appendReceiptSync(receipt(owner, rows, next)); } catch {}
      if (delivered.length >= limit) return { delivered, ...snapshot, ack: next };
    } finally { commit(); }
  }
  return { delivered, ...snapshot };
};

const watcherState = (owner) => { try { return JSON.parse(readText(path.join(watcherFile(owner), 'watcher.json'))); } catch { return null; } };
export const hasWatcher = (owner) => { if (!validOwner(owner)) return false; const w = watcherState(owner); return live(w?.pid) && Date.now() - w.t < 15000; };
export const hasWatcherAsync = async (owner) => {
  try { const w = JSON.parse(await fsp.readFile(path.join(watcherFile(owner), 'watcher.json'), 'utf8'));
    return w.owner === owner && live(w.pid) && Date.now() - w.t < 45000; } catch { return false; }
};
export const watchDeadline = (flushAt, questions, now = Date.now()) => questions.reduce((deadline, row) => {
  const reserveAt = row.expiresAt - row.timeoutMin * 60000 * 0.8;
  return Math.min(deadline, Number.isFinite(reserveAt) ? reserveAt : now);
}, flushAt);
export const watch = async (owner, print = (rows) => new Promise((resolve, reject) =>
  process.stdout.write(rows.map((row) => eventLine(row)).join('\n') + '\n', (error) => error ? reject(error) : resolve())), { debounceSec = 45 } = {}) => {
  if (!Number.isFinite(debounceSec) || debounceSec < 0) throw Error('--debounce-sec takes a nonnegative finite number');
  if(shortOwner(owner)) owner=eventOwner(owner,readEvents());
  if (!validOwner(owner)) throw Error('watch needs --owner <session-id> (or ORCHESTRATOR_OWNER)');
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
  let timer, flushAt;
  try {
    heartbeat();
    timer = setInterval(() => { try { heartbeat(); } catch { exit = 1; stop(); } }, 5000);
    for (;;) {
      if (stopped) return exit;
      await tail.read();
      const ack = await readAckAsync(owner), own = tail.rows(), snapshot = inbox(own, owner, ack);
      for (const row of snapshot.running.filter((row) => !row.stale)) waitingRuns.add(row.runId);
      // A hook's successful delivery owns the wake. Forget its settled runs silently.
      for (const row of own) if (terminal(row) && acknowledged(row, ack)) waitingRuns.delete(row.runId);
      const triggers = snapshot.pending.filter(waking);
      if (triggers.length && flushAt === undefined) flushAt = Date.now() + debounceSec * 1000;
      if (flushAt !== undefined) {
        // Reserve 80% of each ask's original timeout, including asks arriving late in this batch.
        flushAt = watchDeadline(flushAt, [...snapshot.questions, ...snapshot.pending.filter((row) => row.event === 'question')]);
        if (Date.now() >= flushAt) {
          let delivered = false, printError;
          try { await deliverAsync(owner, async (rows) => {
            try { await print(rows); delivered = true; } catch (e) { printError = e; throw e; }
          }, Number.MAX_SAFE_INTEGER, { rows: own }); }
          catch { if (printError) throw printError; /* Retry an unavailable acknowledgement transaction. */ }
          if (delivered) return 0;
          flushAt = undefined;
        }
      } else if (waitingRuns.size && !snapshot.running.some((row) => !row.stale && waitingRuns.has(row.runId))) {
        await print([{ name: owner, event: 'workers-no-longer-running', finalLine: 'observed completion or stale/dead follower; reconcile with mine' }]);
        return 0;
      }
      tail.prune(ack);
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(150, flushAt === undefined ? 150 : flushAt - Date.now()))));
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
    ...metadata, launcher, owner, runId: randomUUID(), pid: process.pid, parentPid: process.ppid };
  let ended = false, result = null, mayRun = false;
  const emit = (event, extra = {}) => { try { return appendEvent({ ...state, event, ...extra }); }
    catch (e) { process.stderr.write(`worker-events: NOT RECORDED: ${e.message}\n`); return null; } };
  emit('running');
  const tracker = {
    owner, sessionId: launcher.sessionId,
    metadata: () => ({ ...state }),
    set: (extra) => Object.assign(state, extra),
    update: (extra) => { Object.assign(state, extra); emit('running'); },
    result: (event, extra = {}) => { result = event; Object.assign(state, extra); },
    end: (code) => { if (ended) return; ended = true;
      emit(result ?? (code === 0 ? 'finished' : code === 4 ? 'stalled' : code === 8 || code === 9 ? 'needs-user' : 'failed'),
        { exit: code, mayRun: !state.settled && (mayRun || !!state.mayRun || code === 4) }); },
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
  rows = normalizeOwners(rows);
  const owners = new Map();
  for (const row of rows) {
    const key = row.owner ?? '(unknown)';
    if (!owners.has(key)) owners.set(key, { owner: key, ...(row.ownerResolution&&row.ownerResolution!=='resolved'?{ownerStatus:'UNKNOWN',unresolved:row.ownerResolution,ownerMatches:row.ownerMatches}:{}), launches: 0, launchesWithoutIdentity: 0, unacknowledged: 0,
      totalUnacknowledged: 0, acknowledgedCount: 0, latencyUnknown: 0, delays: [], runs: new Set(), ack: validOwner(row.owner) ? readAck(row.owner) : emptyAck(key),
      receipts: validOwner(row.owner) ? readReceipts(row.owner) : [] });
    const a = owners.get(key);
    if (row.event === 'running') {
      if (row.t >= since && !a.runs.has(row.runId)) { a.runs.add(row.runId); a.launches++; if (!row.launcher?.sessionId) a.launchesWithoutIdentity++; }
    } else if (notification(row)) {
      const acked = !['ambiguous','unmatched'].includes(row.ownerResolution) && acknowledged(row, a.ack);
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
