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
    const parsed = parseTraeModels(JSON.parse(raw));
    return Object.keys(parsed.modelIds).length ? parsed : { ...parsed, error: 'TRAE models/load listed no models' };
  } catch (e) { return { modelIds: {}, load: {}, error: `TRAE models/load read failed (${e.code === 'ETIMEDOUT' ? 'timeout' : 'query error'})` }; }
};
export const freshLoad = (rows, now = Date.now()) => Object.fromEntries(Object.entries(rows ?? {}).flatMap(([model, r]) => {
  const ageMin = age(r?.t, now), percent = num(r?.percent);
  return idOK(model) && ageMin != null && percent != null && percent >= 0 && percent <= 100
    ? [[model.toLowerCase(), { percent, t: r.t, ageMin }]] : [];
}));
// Some listed models (including Astra) have no direct load. Use the busiest fresh family observation,
// then the busiest account observation, so a quiet sibling cannot hide congestion in the fallback.
export const modelLoad = (rows, model, now = Date.now()) => {
  const fresh = freshLoad(rows, now), direct = fresh[model];
  if (direct) return { ...direct, source: 'model', models: [model] };
  const family = Object.entries(fresh).filter(([id]) => poolOf(id) === poolOf(model));
  const candidates = family.length ? family : Object.entries(fresh);
  if (!candidates.length) return null;
  const busiest = candidates.reduce((a, b) => b[1].percent > a[1].percent ? b : a);
  return { ...busiest[1], source: family.length ? 'family' : 'account', models: candidates.map(([id]) => id) };
};
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

// Per-model lane telemetry (2026-11-13 night): the family queue cannot say whether a depleted model is draining or
// progressing, so record each model separately. `drainPerMin` comes from successive fresh positions; `lastProgressAt`
// is set when a running worker completes items with no queue cycles (the live evidence that a depleted bucket can
// still run at normal speed). Only compact numbers are kept.
export const readLaneState = (home, now = Date.now()) => home ? Object.fromEntries(Object.entries(read(path.join(home, 'lane-state.json')))
  .flatMap(([model, r]) => {
    if (!idOK(model) || !r || typeof r !== 'object') return [];
    const t = num(r.t), ageMin = age(t, now);
    if (ageMin == null) return [];
    return [[model.toLowerCase(), { t, ageMin, position: num(r.position), drainPerMin: num(r.drainPerMin),
      lastProgressAt: num(r.lastProgressAt), itemsPerMin: num(r.itemsPerMin),
      state: ['queued', 'waiting', 'ready'].includes(r.state) ? r.state : 'unknown' }]];
  })) : {};
const writeLaneState = (home, model, sample, now = Date.now()) => {
  const file = path.join(home, 'lane-state.json'), lock = `${file}.lock`;
  let held = false;
  try {
    try { fs.mkdirSync(lock); held = true; } catch {
      try { if (now - fs.statSync(lock).mtimeMs > 30000) fs.rmdirSync(lock); } catch {}
      return BALANCE.queueWriteMs;
    }
    const rows = readLaneState(home, now), prev = rows[model], t = num(sample.t) ?? now;
    let drainPerMin = null;
    if (prev && sample.position != null && prev.position != null && t > prev.t
      && ['queued', 'waiting'].includes(prev.state)) {
      const dt = (t - prev.t) / 60000, drop = prev.position - sample.position;
      if (dt > 0 && drop >= 0) drainPerMin = drop / dt;
    }
    rows[model] = { t, position: num(sample.position), drainPerMin,
      lastProgressAt: sample.progress ? t : sample.state === 'ready' ? prev?.lastProgressAt ?? null : null,
      itemsPerMin: num(sample.itemsPerMin) ?? (sample.state === 'ready' ? prev?.itemsPerMin ?? null : null),
      state: ['queued', 'waiting', 'ready'].includes(sample.state) ? sample.state : 'unknown' };
    const clean = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { t: v.t, position: v.position,
      drainPerMin: v.drainPerMin, lastProgressAt: v.lastProgressAt, itemsPerMin: v.itemsPerMin, state: v.state }]));
    const tmp = `${file}.${process.pid}`;
    try { fs.writeFileSync(tmp, JSON.stringify(clean)); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
    return 0;
  } catch { return BALANCE.queueWriteMs; }
  finally { if (held) try { fs.rmdirSync(lock); } catch {} }
};

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
  const family = poolOf(model), key = String(model ?? '').toLowerCase();
  let pending = null, timer = null, stopped = false;
  const flush = () => {
    timer = null;
    const delay = writeQueueState(home, family, pending);
    if (delay) { timer = setTimeout(flush, delay); timer.unref(); } else pending = null;
  };
  const record = (event, t = Date.now()) => {
    if (stopped || !home || !idOK(family)) return;
    const position = num(event.position);
    const high = position > BALANCE.queuePosition ? { t, position } : pending?.high;
    pending = { t, position, state: event.state ?? 'queued', lowPriority: event.modelQuotaLowPriority ?? event.lowPriority ?? null,
      ...(high ? { high } : {}) };
    if (!timer) flush();
    if (idOK(key)) writeLaneState(home, key, { t, position, state: event.state ?? 'queued',
      progress: !!event.progress, itemsPerMin: event.itemsPerMin }, t);
  };
  record.stop = () => { stopped = true; if (timer) clearTimeout(timer); timer = null; pending = null; };
  return record;
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
const expiryPolicy = JSON.parse(fs.readFileSync(new URL('../resource-policy.json', import.meta.url), 'utf8')).ttadkExpiry;
export const TTADK_EXPIRY_HINT = 'TTADK quota expiring unused: good time for reviews, docs and exploratory work';
export const ttadkExpiringUnused = (account, now = Date.now()) => {
  const q = account?.usage, burn = account?.burn;
  return validUsage(q) && q.used < q.limit && q.resetsAt > now && q.resetsAt - now < expiryPolicy.windowHours * 3600000
    && burn?.resetsAt === q.resetsAt && age(burn.sampledAt, now) !== null
    && Number.isFinite(burn.projectedAtReset) && burn.projectedAtReset / q.limit < expiryPolicy.projectedShareBelow;
};
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
  if (perHour < 0) return null;
  const outAt = perHour > 0 ? last.t + Math.max(0, q.limit - q.used) / perHour * 3600000 : null;
  return { perHour, outAt, resetsAt: q.resetsAt,
    projectedAtReset: q.used + perHour * (q.resetsAt - last.t) / 3600000,
    spanMin: (last.t - first.t) / 60000, sampledAt: last.t, beforeReset: outAt !== null && outAt < q.resetsAt };
};

export const hasTraeDailyQuota = (quota, now = Date.now()) => Object.values(freshTraeQuota(quota, now)?.daily ?? {})
  .some((q) => q && typeof q === 'object' && !Array.isArray(q));

export const balanceFactors = ({ ttadk, trae, model, category, stakes, impact, tier, allowBucketFree = false, now = Date.now() }) => {
  const quota = freshTraeQuota(trae?.quota, now), q = quota?.daily?.[model], family = poolOf(model);
  const bucketFree = allowBucketFree && hasTraeDailyQuota(quota, now) && !Object.hasOwn(quota.daily, model);
  const load = modelLoad(trae?.load, model, now), queue = freshQueue(trae?.queue, now)[family] ?? null;
  const remainingShare = validUsage(q) && q.resetsAt > now ? Math.max(0, (q.limit - q.used) / q.limit) : null;
  const tt = ttadk?.usage;
  const ttShare = validUsage(tt) && tt.resetsAt > now ? Math.max(0, (tt.limit - tt.used) / tt.limit) : null;
  const lowPriority = tier === 'light' || stakes === 'low' || ['lookup', 'extract', 'draft'].includes(category) || impact === 'throwaway';
  const reserveOK = bucketFree || (q?.depleted === false && remainingShare != null && remainingShare >= BALANCE.reserveShare);
  const congested = (load != null && load.percent >= BALANCE.loadPercent)
    || (queue?.position != null && queue.position > BALANCE.queuePosition) || !!queue?.high;
  // Queue observations veto a transfer when present and high; an empty/stale queue is not congestion.
  const known = !!load;
  const congestionOK = !congested && (known || lowPriority);
  const projectedOut = ttadk?.burn?.beforeReset === true;
  const expiresSoon = remainingShare != null && ttShare != null && q.resetsAt - now < BALANCE.expiresH * 3600000
    && remainingShare > ttShare;
  const triggers = [lowPriority && 'low-priority task', projectedOut && 'TTADK projected to run out', expiresSoon && 'TRAE daily quota expires soon'].filter(Boolean);
  const reasons = [!reserveOK && (q?.depleted ? 'daily bucket depleted' : remainingShare == null
    ? 'daily quota unknown (missing, stale or expired)' : 'daily quota below 15% reserve'),
    load?.percent >= BALANCE.loadPercent && `load ${load.percent}% is at least ${BALANCE.loadPercent}%`,
    (queue?.position > BALANCE.queuePosition || queue?.high) && `family queue above ${BALANCE.queuePosition}`,
    !congestionOK && !congested && 'no fresh load reading',
    !triggers.length && 'no balancing trigger (TTADK depletion not projected, task not light/low-priority, no earlier TRAE expiry)'].filter(Boolean);
  return { model, family, bucketFree, reserveOK, remainingShare, ttadkRemainingShare: ttShare, load, queue,
    congestion: congested ? 'high' : known ? 'low' : 'unknown', congestionOK, lowPriority,
    burn: ttadk?.burn ?? null, projectedOut, expiresSoon, triggers, reasons,
    eligible: reserveOK && congestionOK && triggers.length > 0 };
};
