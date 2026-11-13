// Read-only observations of the shared res contract, never a second semaphore.
import fs from 'node:fs';
import path from 'node:path';
import { GIB, SHARED, safeHolder, safeId, unsafeFile, category, commandName } from './resource-data.mjs';

export const HEAVY_IDS = ['heavy-build', 'heavy-lane-1', 'heavy-lane-2'];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const minuteTime = (s) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s ?? '') && finite(Date.parse(s.replace(' ', 'T'))) ? Date.parse(s.replace(' ', 'T')) : null;
const identity = (s) => {
  const m = s.match(/^(.*?) \(([a-zA-Z0-9._-]+)(?:\/([a-zA-Z0-9._-]+))?\)$/);
  return { holder: safeHolder(m?.[1] ?? s), project: safeId(m?.[2]), task: safeId(m?.[3]) };
};

export function parseHeavyStatus(text, expected = HEAVY_IDS) {
  const locks = [], errors = [], seen = new Set();
  for (const line of String(text).split('\n')) {
    if (!/^heavy-(?:build|lane-[12])\s/.test(line)) continue;
    const m = line.match(/^(heavy-(?:build|lane-[12]))\s+slot\s+\S+\s+\S+\s+(.*)$/);
    if (!m || seen.has(m[1])) { errors.push('invalid/duplicate heavy status row (content omitted)'); continue; }
    const [, id, rest] = m, freeRow = /^FREE(?:\s|$)/.test(rest), heldRow = rest.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:\s|$)/);
    if (!freeRow && !heldRow) { errors.push('unparseable heavy holder/start (content omitted)'); continue; }
    const who = freeRow ? 'FREE' : heldRow[1]; seen.add(id);
    const stale = who.startsWith('STALE '), free = who === 'FREE';
    const since = heldRow?.[2] ?? null;
    locks.push({ id, state: free ? 'FREE' : stale ? 'STALE' : 'HELD', stale: free ? false : stale ? true : null,
      ...(free ? { holder: null, project: null, task: null } : identity(who.replace(/^STALE /, ''))), since, startMs: null, pid: null, host: null });
  }
  for (const id of expected) if (!seen.has(id)) errors.push(`${id}: status unavailable, not FREE`);
  return { locks, complete: !errors.length, errors, source: 'captured res status; no live invocation' };
}

export function parseHeavyCheck(text, exitCode = 0) {
  const unknown = (reason) => ({ state: 'UNKNOWN', authoritative: false, exitCode, error: reason, loadGate: 12, memoryGateGiB: 16 });
  if (![0, 5].includes(exitCode)) return unknown('heavy-check metrics unavailable (output omitted)');
  const number = '(\\d+(?:\\.\\d+)?)';
  const darwin = String(text).trim().match(new RegExp(`^load1m=${number} avail=${number}GiB \\((memorystatus \\d+%|memorystatus unavailable; pages fallback)\\) pages_headroom=${number}GiB swap_used=${number}GiB gate=(OK|OVERLOADED)$`));
  const linux = String(text).trim().match(new RegExp(`^load1m=${number} headroom=${number} GiB gate=(OK|OVERLOADED)$`));
  if (!darwin && !linux) return unknown('unparseable heavy-check reading (output omitted)');
  const m = darwin ?? linux, state = darwin ? m[6] : m[3];
  if (!(darwin ? [m[1], m[2], m[4], m[5]] : [m[1], m[2]]).every((v) => finite(+v))) return unknown('non-finite heavy-check metrics');
  if ((state === 'OK' ? 0 : 5) !== exitCode) return unknown('heavy-check exit/state mismatch');
  const level = darwin?.[3].match(/memorystatus (\d+)%/)?.[1];
  if (level !== undefined && +level > 100) return unknown('invalid memorystatus percentage');
  return { state, authoritative: true, exitCode, load1m: +m[1], availableBytes: +m[2] * GIB,
    availableBasis: darwin ? level !== undefined ? 'memorystatus-level' : 'pages-fallback (sysctl explicitly missing)' : 'Linux MemAvailable',
    memorystatusPct: level === undefined ? null : +level, pageHeadroomBytes: darwin ? +m[4] * GIB : null,
    swapUsedBytes: darwin ? +m[5] * GIB : null, loadGate: 12, memoryGateGiB: 16,
    note: 'Controller state is authoritative; printed readings are rounded to 0.01, so do not recompute boundary verdicts.' };
}

export function lockSnapshot(leases, rows, { host, psStartedAt, now, processComplete }) {
  const pids = new Map(rows.map((p) => [p.pid, p]));
  const complete = leases.complete === true && HEAVY_IDS.every((id) => leases.registered?.includes(id));
  const locks = HEAVY_IDS.map((id) => {
    const held = leases.held.find((l) => l.id === id);
    if (!held) return { id, state: complete ? 'FREE' : 'UNKNOWN', stale: complete ? false : null };
    const local = held.host === host && held.pid > 0;
    const fresh = finite(held.startMs) && held.startMs <= psStartedAt;
    const alive = pids.has(held.pid), pidStart = Date.parse(pids.get(held.pid)?.started);
    const reused = alive && finite(pidStart) && finite(held.startMs) && pidStart > held.startMs + 1000;
    const stale = local && processComplete && !reused && (alive || fresh) ? !alive : null;
    return { ...held, state: stale === true ? 'STALE' : 'HELD', stale, local, pidIdentity: reused ? 'reused/unknown' : alive && local && fresh ? 'observed' : 'unknown',
      ageSeconds: finite(held.startMs) && held.startMs <= now ? (now - held.startMs) / 1000 : null,
      reclaimEligibleObserved: stale === true && now - held.startMs > 600000 };
  });
  return { complete, source: 'read-only registry + lock info + PID snapshot; equivalent to status, no res status writes', locks,
    errors: [...leases.errors, ...(!complete ? ['heavy lock registry/metadata incomplete; missing holds are UNKNOWN'] : [])] };
}

export function readLockJournal(shared = SHARED, maxBytes = 128 * 1024) {
  let fd;
  try {
    const file = path.join(shared, 'log.tsv');
    if (unsafeFile(file) || fs.lstatSync(file).isSymbolicLink() || unsafeFile(fs.realpathSync(file))) throw Error('unsafe lock journal refused');
    fd = fs.openSync(file, 'r'); const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Error('nonregular lock journal refused');
    const offset = Math.max(0, stat.size - maxBytes), buf = Buffer.alloc(Math.min(maxBytes, stat.size));
    const bytes = fs.readSync(fd, buf, 0, buf.length, offset);
    const events = [], errors = []; let cursor = 0;
    if (offset > 0) { const newline = buf.subarray(0, bytes).indexOf(10); cursor = newline < 0 ? bytes : newline + 1; }
    while (cursor < bytes) {
      const end = buf.indexOf(10, cursor); if (end < 0 || end >= bytes) break; // An append may still be writing its final row.
      const line = buf.subarray(cursor, end).toString('utf8'), fields = line.split('\t'), t = minuteTime(fields[0]);
      if (HEAVY_IDS.includes(fields[2]) && ['take', 'return', 'reclaim', 'extend'].includes(fields[1])) {
        if (t === null || fields.length < 5) errors.push('invalid heavy journal row (content omitted)');
        else events.push({ eventId: `${stat.dev}:${stat.ino}:${offset + cursor}`, t, precisionMs: 60000,
          action: fields[1], resource: fields[2], ...identity(fields[3]) });
      }
      cursor = end + 1;
    }
    return { events, complete: !errors.length, historyComplete: offset === 0, trailingPartial: cursor < bytes, errors,
      source: 'bounded read-only log.tsv tail; minute precision; wait starts/timeouts are not journaled' };
  } catch (e) { return { events: [], complete: false, historyComplete: false, errors: [`lock journal: ${e.code ?? e.message}; timing UNKNOWN`] }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Tokenize transient ps commands only, discarding all options except approved lock identity fields.
function waitCommand(cmd) {
  const tokens = [...cmd.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const i = tokens.findIndex((v) => path.basename(v) === 'res');
  if (i < 0 || i > 1 || tokens[i + 1] !== 'wait' || !HEAVY_IDS.includes(tokens[i + 2])) return null;
  if (i === 1 && !/^(?:bash|sh|zsh)$/.test(path.basename(tokens[0]))) return null;
  const get = (key) => { const j = tokens.indexOf(key, i + 3); return j < 0 ? null : tokens[j + 1]; };
  const pid = Number(get('--pid')), timeout = get('--timeout');
  return { resource: tokens[i + 2], holder: safeHolder(get('--by')), project: safeId(get('--project')), task: safeId(get('--task')),
    holderPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    timeoutMinutes: /^\d+(?:\.\d+)?$/.test(timeout ?? '') && finite(+timeout) ? +timeout : null };
}

export function observeWaiters(rows, processes, now) {
  const out = [], seen = new Set(), byPid = new Map(rows.map((p) => [p.pid, p])), safe = new Map(processes.map((p) => [p.pid, p]));
  for (const p of rows) {
    const wait = waitCommand(p._command ?? ''); if (!wait) continue;
    let q = p; const ancestors = new Set([p.pid]); let nested = false;
    while (byPid.has(q.ppid) && !ancestors.has(q.ppid)) {
      q = byPid.get(q.ppid); ancestors.add(q.pid);
      if (waitCommand(q._command ?? '')?.resource === wait.resource) { nested = true; break; }
    }
    if (nested) continue;
    const id = safe.get(p.pid)?.id; if (!id || seen.has(id)) continue; seen.add(id);
    out.push({ ...wait, holderPid: wait.holderPid ?? p.ppid, id, pid: p.pid,
      startMs: finite(p.elapsedSeconds) && p.elapsedSeconds >= 0 ? now - p.elapsedSeconds * 1000 : null,
      source: 'observed res wait process elapsed time (~1s); waits wholly between samples are unknown' });
  }
  return out;
}

export function workload(p, rows) {
  const cmd = p._command ?? '', kind = category(cmd), exe = commandName(cmd);
  if (kind === 'xcodebuild') {
    if (/(?:^|\s)(?:-list|-showBuildSettings|-version|-showsdks|test-without-building)(?:\s|$)/.test(cmd)) return { class: 'exempt', reason: 'diagnostic/device-only xcode invocation' };
    return { class: /(?:^|\s)-exportArchive(?:\s|$)/.test(cmd) ? 'lane' : 'package', reason: 'xcode package/native build candidate; owner verifies full-package scope' };
  }
  if (kind === 'gradle' && /(?:^|\s)(?:[\w:-]*:)?(?:assemble|bundle)[\w-]*(?:\s|$)/i.test(cmd)) return { class: 'package', reason: 'Gradle assemble/bundle package candidate; verify native scope' };
  if (exe === 'ninja' || exe === 'cmake' && /(?:^|\s)--build(?:\s|$)/.test(cmd)) return { class: 'lane', reason: 'native build driver candidate; verify not a single-TU target' };
  if (kind === 'node-test' && p.elapsedSeconds >= 60 && rows.filter((q) => q.ppid === p.pid && ['node-test', 'native'].includes(category(q._command))).length >= 2) return { class: 'lane', reason: 'long multiprocess test candidate; verify sustained heavy scope' };
  return { class: 'unclassified', reason: 'single-TU/host unit tests are exempt; heaviness not established from executable alone' };
}

export function matchBuildLock(p, rows, snapshot, required) {
  if (!snapshot.complete) return { state: 'UNKNOWN', required, reason: 'lock metadata incomplete' };
  const byPid = new Map(rows.map((q) => [q.pid, q])), ancestors = new Set([p.pid]); let q = p;
  while (q.ppid > 1 && byPid.has(q.ppid) && !ancestors.has(q.ppid)) { q = byPid.get(q.ppid); ancestors.add(q.pid); }
  const candidates = snapshot.locks.filter((l) => required === 'build' ? l.id === 'heavy-build' : l.id.startsWith('heavy-lane-'));
  const match = candidates.find((l) => l.local && l.stale === false && l.pidIdentity === 'observed' && ancestors.has(l.pid));
  if (match) return { state: 'MATCHED', required, resource: match.id, holder: match.holder, holderPid: match.pid, project: match.project, task: match.task };
  if (q.ppid > 1 || candidates.some((l) => l.state === 'UNKNOWN' || l.state === 'HELD' && (!l.local || l.stale === null || !l.pid || l.pidIdentity !== 'observed'))) return { state: 'UNKNOWN', required, reason: 'PID ancestry or legacy/remote holder unverified' };
  return { state: 'UNMATCHED', required, reason: 'no live local lock holder in build PID ancestry (not just same project/name)' };
}
