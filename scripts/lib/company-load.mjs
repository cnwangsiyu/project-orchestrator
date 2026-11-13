// Company quota/load telemetry only: never persist provider messages, prompts or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { poolOf } from './trae-health.mjs';

export const BALANCE = Object.freeze({ reserveShare: 0.15, loadPercent: 60, queuePosition: 300,
  freshMin: 30, expiresH: 6, burnWindowMin: 120, burnMinSpanMin: 10, queueWriteMs: 60000 });
const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v
  : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
const idOK = (s) => typeof s === 'string' && /^[a-z0-9][\w.-]{0,99}$/i.test(s);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const age = (t, now) => typeof t === 'number' && t <= now && now - t <= BALANCE.freshMin * 60000 ? (now - t) / 60000 : null;

export const parseTraeModels = (payload, t = Date.now()) => {
  const rows = Array.isArray(payload) ? payload : payload?.models ?? payload?.data;
  const modelIds = {}, load = {};
  for (const m of Array.isArray(rows) ? rows : []) {
    const id = m?.configName ?? m?.config_name ?? m?.id ?? m?.slug ?? m?.name;
    if (!idOK(id)) continue;
    const key = id.toLowerCase();
    modelIds[key] = id;
    const percent = num(m?._meta?.trae?.load?.percent);
    if (percent != null && percent >= 0 && percent <= 100) load[key] = { percent, t };
  }
  return { modelIds, load };
};
export const readTraeModels = (bin, run = execFileSync) => {
  try {
    const raw = run(bin, ['models', '--json'], { encoding: 'utf8', timeout: 30000,
      maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseTraeModels(JSON.parse(raw));
  } catch { return { modelIds: {}, load: {} }; }
};
export const freshLoad = (rows, now = Date.now()) => Object.fromEntries(Object.entries(rows ?? {}).flatMap(([model, r]) => {
  const ageMin = age(r?.t, now), percent = num(r?.percent);
  return idOK(model) && ageMin != null && percent != null && percent >= 0 && percent <= 100
    ? [[model.toLowerCase(), { percent, t: r.t, ageMin }]] : [];
}));
const queueRow = (r, now) => {
  if (!r || age(r.t, now) == null) return null;
  const position = num(r.position), highPos = num(r.high?.position);
  const high = age(r.high?.t, now) != null && highPos > BALANCE.queuePosition ? { t: r.high.t, position: highPos } : null;
  return { t: r.t, position: position != null && position >= 0 ? position : null,
    state: ['queued', 'waiting', 'ready'].includes(r.state) ? r.state : 'unknown',
    lowPriority: typeof r.lowPriority === 'boolean' ? r.lowPriority : null, ...(high ? { high } : {}) };
};
export const freshQueue = (rows, now = Date.now()) => Object.fromEntries(Object.entries(rows ?? {}).flatMap(([family, r]) => {
  const q = queueRow(r, now);
  return idOK(family) && q ? [[family, { ...q, ageMin: age(q.t, now) }]] : [];
}));
export const readQueueState = (home, now = Date.now()) => home ? freshQueue(read(path.join(home, 'queue-state.json')), now) : {};

// Nonblocking cross-process lock + atomic rename. A timer coalesces pending updates, with at most one shared-file
// write per minute. Telemetry never delays a worker or changes the number of launches. Last sampled observation wins;
// retain any sampled position >300 for 30 min even when a later event clears that queue.
export const writeQueueState = (home, family, pending, now = Date.now()) => {
  const file = path.join(home, 'queue-state.json'), lock = `${file}.lock`;
  let held = false;
  try {
    try { fs.mkdirSync(lock); held = true; } catch {
      try { if (now - fs.statSync(lock).mtimeMs > 30000) fs.rmdirSync(lock); } catch {}
      return BALANCE.queueWriteMs;
    }
    let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch {}
    if (now - mtime < BALANCE.queueWriteMs) return Math.ceil(BALANCE.queueWriteMs - (now - mtime));
    const rows = freshQueue(read(file), now), prev = rows[family], q = queueRow(pending, now);
    if (!q) return 0;
    const high = [prev?.high, q.high, prev?.position > BALANCE.queuePosition ? { t: prev.t, position: prev.position } : null,
      q.position > BALANCE.queuePosition ? { t: q.t, position: q.position } : null]
      .filter((h) => h && age(h.t, now) != null).sort((a, b) => b.t - a.t)[0];
    rows[family] = { ...(prev?.t > q.t ? prev : q), ...(high ? { high } : {}) };
    const clean = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, queueRow(v, now)]));
    const tmp = `${file}.${process.pid}`;
    try { fs.writeFileSync(tmp, JSON.stringify(clean)); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
    return 0;
  } catch { return BALANCE.queueWriteMs; }
  finally { if (held) try { fs.rmdirSync(lock); } catch {} }
};
export const createQueueRecorder = (home, model) => {
  const family = poolOf(model);
  let pending = null, timer = null;
  const flush = () => {
    timer = null;
    const delay = writeQueueState(home, family, pending);
    if (delay) { timer = setTimeout(flush, delay); timer.unref(); } else pending = null;
  };
  return (event, t = Date.now()) => {
    if (!home || !idOK(family)) return;
    const position = num(event.position);
    const high = position > BALANCE.queuePosition ? { t, position } : pending?.high;
    pending = { t, position, state: event.state ?? 'queued', lowPriority: event.modelQuotaLowPriority ?? event.lowPriority ?? null,
      ...(high ? { high } : {}) };
    if (!timer) flush();
  };
};

const compactBucket = (q) => q ? { used: num(q.used), limit: num(q.limit), resetsAt: num(q.resetsAt),
  ...(typeof q.depleted === 'boolean' ? { depleted: q.depleted } : {}) } : null;
// Stale/missing readings and expired buckets are unknown, never evidence of spare or bucket-free capacity.
export const freshTraeQuota = (quota, now = Date.now()) => {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return null;
  const dailyFresh = age(quota.sampledAt, now) != null;
  const current = (q) => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
    const reset = num(q.resetsAt);
    return reset != null && reset <= now ? null : q;
  };
  return { ...quota, daily: Object.fromEntries(Object.entries(quota.daily ?? {}).map(([id, q]) => [id, dailyFresh ? current(q) : null])),
    weekly: current(quota.weekly) };
};
export const companySnapshot = (accounts, now = Date.now()) => {
  const tt = accounts?.find((a) => a.kind === 'ttadk'), tr = accounts?.find((a) => a.kind === 'trae');
  return {
    ttadk: tt ? { name: tt.name, ...compactBucket(tt.usage) } : null,
    trae: tr ? { name: tr.name, sampledAt: tr.quota?.sampledAt ?? null, daily: Object.fromEntries(Object.entries(tr.quota?.daily ?? {}).filter(([id]) => idOK(id))
      .map(([id, q]) => [id, compactBucket(q)])), weekly: compactBucket(tr.quota?.weekly),
      load: freshLoad(tr.load, now), queue: readQueueState(tr.home, now) } : null,
  };
};
// A bounded tail avoids scanning an indefinitely growing quota log on every routing decision.
export const readQuotaHistory = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - (8 << 20));
    const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n'); if (start) lines.shift();
    return lines.flatMap((s) => { try { return [JSON.parse(s)]; } catch { return []; } });
  } catch { return []; } finally { if (fd != null) fs.closeSync(fd); }
};
const validUsage = (q) => q && Number.isFinite(q.used) && q.used >= 0 && Number.isFinite(q.limit) && q.limit > 0
  && Number.isFinite(q.resetsAt);
export const ttadkBurn = (history, account, sampledAt, now = Date.now()) => {
  const q = account?.usage;
  if (!validUsage(q) || q.resetsAt <= now || age(sampledAt, now) == null) return null;
  const samples = [...(history ?? []), { t: sampledAt, ttadk: { name: account.name, ...q } }]
    .filter((r) => r.t <= sampledAt && r.t >= now - BALANCE.burnWindowMin * 60000 && r.ttadk?.name === account.name
      && validUsage(r.ttadk) && r.ttadk.resetsAt === q.resetsAt && r.ttadk.limit === q.limit)
    .sort((a, b) => a.t - b.t);
  // Changed counters/limits/resets are not burn. Start a new segment at any decrease.
  let start = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].ttadk.used < samples[i - 1].ttadk.used) start = i;
  const first = samples[start], last = samples.at(-1);
  if (!first || last.t - first.t < BALANCE.burnMinSpanMin * 60000) return null;
  const perHour = (last.ttadk.used - first.ttadk.used) / ((last.t - first.t) / 3600000);
  if (perHour <= 0) return null;
  const outAt = last.t + Math.max(0, q.limit - q.used) / perHour * 3600000;
  return { perHour, outAt, resetsAt: q.resetsAt, beforeReset: outAt < q.resetsAt,
    spanMin: (last.t - first.t) / 60000, sampledAt: last.t };
};

export const hasTraeDailyQuota = (quota, now = Date.now()) => Object.values(freshTraeQuota(quota, now)?.daily ?? {})
  .some((q) => q && typeof q === 'object' && !Array.isArray(q));

export const balanceFactors = ({ ttadk, trae, model, category, stakes, impact, allowBucketFree = false, now = Date.now() }) => {
  const quota = freshTraeQuota(trae?.quota, now), q = quota?.daily?.[model], family = poolOf(model);
  const bucketFree = allowBucketFree && hasTraeDailyQuota(quota, now) && !Object.hasOwn(quota.daily, model);
  const load = freshLoad(trae?.load, now)[model] ?? null, queue = freshQueue(trae?.queue, now)[family] ?? null;
  const remainingShare = validUsage(q) && q.resetsAt > now ? Math.max(0, (q.limit - q.used) / q.limit) : null;
  const tt = ttadk?.usage;
  const ttShare = validUsage(tt) && tt.resetsAt > now ? Math.max(0, (tt.limit - tt.used) / tt.limit) : null;
  const lowPriority = stakes === 'low' || ['lookup', 'extract', 'draft'].includes(category) || impact === 'throwaway';
  const reserveOK = bucketFree || (q?.depleted === false && remainingShare != null && remainingShare >= BALANCE.reserveShare);
  const congested = (load != null && load.percent >= BALANCE.loadPercent)
    || (queue?.position != null && queue.position > BALANCE.queuePosition) || !!queue?.high;
  const known = !!load && !!queue && (queue.position != null || queue.state === 'ready');
  const congestionOK = !congested && (known || lowPriority);
  const projectedOut = ttadk?.burn?.beforeReset === true;
  const expiresSoon = remainingShare != null && ttShare != null && q.resetsAt - now < BALANCE.expiresH * 3600000
    && remainingShare > ttShare;
  const triggers = [lowPriority && 'low-priority task', projectedOut && 'TTADK projected to run out', expiresSoon && 'TRAE daily quota expires soon'].filter(Boolean);
  return { model, family, bucketFree, reserveOK, remainingShare, ttadkRemainingShare: ttShare, load, queue,
    congestion: congested ? 'high' : known ? 'low' : 'unknown', congestionOK, lowPriority,
    burn: ttadk?.burn ?? null, expiresSoon, triggers, eligible: reserveOK && congestionOK && triggers.length > 0 };
};
