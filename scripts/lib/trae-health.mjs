// TRAE CLI health from what its workers hit (user, 2026-11-08): quota.mjs only sees that the CLI is logged in and lists
// its models, not that its gateway keeps failing. codex-worker records each failed or stalled TRAE turn here, and any
// completed turn clears the record (and the pause). While paused, quota.mjs reports TRAE unavailable, so route.mjs stops
// sending it work (TTADK if usable, else the personal-quota OK gate) instead of every task failing once first.
//
// Pauses by kind (user, 2026-11-08: 30 minutes for a passing queue overflow was too long):
// - transient (queue full — "request queue size is exceed", rate limits, gateway errors, timeouts, stalls): two within
//   WINDOW_MIN pause it for 5 minutes, then 10, 20, at most 30 while pauses keep following each other without a success;
// - auth (not logged in, 401, expired token): one pauses it for 30 minutes; lifted as soon as `login status` is fine again
//   (quota.mjs checks);
// - hard (quota used up, banned, 403 Forbidden): a family pauses for 30 minutes, then awaits a probe; whole-account
//   pauses back off 30, 60, 120, at most 240 minutes while they keep coming without a success;
// - vendor restriction ("Model access temporarily restricted", code 983): a family pauses until the next 00:00 UTC
//   strictly after the failure (08:00 China time), then awaits a probe (user, 2026-11-12; TRAE FAQ, 11-10..12 retro).
//
// Per model family (2026-11-10: TRAE restricted only its GPT models while DeepSeek and Gemini kept working, and a queue
// overflow is per model): a failure recorded with its model pauses only that family (gpt, deepseek, gemini, seed…);
// route.mjs then takes the next family on its fallback list. Auth failures, and failures recorded without a model
// (a traecli exec run noted by hand without --model), pause the whole account.
//   <trae home>/worker-health.json  {"failures":[{"t","why"}],"pausedUntil","reason","kind","streak",
//                                    "pools":{"gpt":{"failures","pausedUntil","reason","kind","streak"}}}
//
// Recovery by probe (user, 2026-11-10: find out soon when GPT is back, without spending real tasks on it): a family's
// vendor restriction lasts until the next 00:00 UTC; other hard pauses last 30 minutes. When it ends, the family stays out of
// routing until a probe — a tiny one-line turn on that family's model (`codex-worker --account trae probe`, started in
// the background by lib/state.mjs when it reads the state) — succeeds. A failed restriction probe waits until the following
// 00:00 UTC; other hard failures wait another 30 minutes. The 11-10..12 retro found every restriction lifted after
// 00:00 UTC and every earlier 30-minute probe failed, so restriction probes wait for the vendor's recovery time.
// Transient pauses (queue full) still just end: the next real task is the test.
//   <trae home>/thread-models.json  {"<thread id>":"<model>"}  (so a later turn or wait on a thread knows its model)
import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_MIN = 15, HARD_MIN = 30, BACKOFF_MIN = [5, 10, 20, 30];
// Whole-account hard failures back off 30, 60, 120, 240 minutes; family pauses use the recovery schedule below.
export const HARD_BACKOFF_MIN = [30, 60, 120, 240];
const AUTH = /not logged in|unauthori[sz]ed|\b401\b|token expired|login (required|expired)|re-?login/i;
const RESTRICTED = /access (temporarily )?restricted|\b983\b/i;
const HARD = /quota|daily limit|banned|\bban\b|封禁|封号|forbidden|\b403\b/i;
const RESTRICTED_REASON = "restricted by the model vendor's policy until 08:00 China time (00:00 UTC); probed then";
const nextUtcMidnight = (now) => (Math.floor(now / 86400000) + 1) * 86400000;
export const failureKind = (why) => (AUTH.test(why ?? '') ? 'auth' : HARD.test(why ?? '') || RESTRICTED.test(why ?? '') ? 'hard' : 'transient');
const file = (home) => path.join(home, 'worker-health.json');
const read = (home) => { try { return JSON.parse(fs.readFileSync(file(home), 'utf8')); } catch { return { failures: [] }; } };
const write = (home, rec) => { try { const t = `${file(home)}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(rec)); fs.renameSync(t, file(home)); } catch {} };

// Pure: the pause these failures call for at time now, or null. streak = pauses already in a row without a success.
export const pauseDecision = (failures, now = Date.now(), streak = 0) => {
  const recent = (failures ?? []).filter((f) => now - f.t <= WINDOW_MIN * 60000);
  if (!recent.length) return null;
  const last = recent.reduce((a, f) => (f.t > a.t ? f : a));
  const serious = recent.filter((f) => failureKind(f.why) !== 'transient').reduce((a, f) => (!a || f.t > a.t ? f : a), null);
  if (serious) {
    const kind = failureKind(serious.why);
    const mins = kind === 'hard' ? HARD_BACKOFF_MIN[Math.min(streak, HARD_BACKOFF_MIN.length - 1)] : HARD_MIN;
    return { kind, pausedUntil: serious.t + mins * 60000, reason: `${String(serious.why).slice(0, 180)} (paused ${mins} min)` };
  }
  if (recent.length < 2) return null;
  const mins = BACKOFF_MIN[Math.min(streak, BACKOFF_MIN.length - 1)];
  return { kind: 'transient', pausedUntil: last.t + mins * 60000, reason: `${recent.length} failed or stalled TRAE turns in ${WINDOW_MIN} min, paused ${mins} min (last: ${String(last.why).slice(0, 140)})` };
};
// The model family a TRAE model id belongs to: the unit that fails together (one provider pool).
export const poolOf = (model) => {
  const m = String(model ?? '').toLowerCase();
  const f = /^(gpt|deepseek|gemini|seed|kimi|glm|claude|doubao|qwen)/.exec(m);
  return f ? f[1] : m || null;
};
// One record (the account's, or one family's) after a failure at time now.
const step = (rec, why, now) => {
  const wasPaused = rec.pausedUntil && rec.pausedUntil > now;
  const failures = [...(rec.failures ?? []), { t: now, why: String(why ?? 'failed').slice(0, 300) }].slice(-20);
  // The backoff starts over when the last pause ended more than an hour ago.
  const streak = rec.pausedUntil && now - rec.pausedUntil > 60 * 60000 ? 0 : rec.streak ?? 0;
  const p = wasPaused ? null : pauseDecision(failures, now, streak);
  // A new pause starts the next backoff step and clears the failures that caused it.
  return p ? { failures: [], pausedUntil: p.pausedUntil, reason: p.reason, kind: p.kind, streak: streak + 1 } : { ...rec, failures };
};
export const PROBE_EVERY_MIN = 30, PROBE_STALE_MIN = 10;
// Returns the pause now in force for what failed (the account, or the model's family, with .pool set), or null.
export const noteFailure = (home, why, now = Date.now(), model = null) => {
  const rec = read(home);
  const pool = failureKind(why) === 'auth' ? null : poolOf(model);
  if (!pool) {
    const { pools } = rec;
    const out = { ...step(rec, why, now), ...(pools ? { pools } : {}) };
    write(home, out);
    return out.pausedUntil && out.pausedUntil > now ? out : null;
  }
  const prev = rec.pools?.[pool] ?? { failures: [] };
  let pr = step(prev, why, now);
  // Vendor restrictions have a known daily reset; retain the type when a later probe fails for another reason.
  // A restriction also replaces an already-active short pause from a different failure.
  if (RESTRICTED.test(why ?? '')) pr = { ...pr, failures: [], kind: 'hard', restricted: true, pausedUntil: nextUtcMidnight(now),
    reason: `${String(why).slice(0, 180)}; ${RESTRICTED_REASON}` };
  else if (pr.kind === 'hard' && pr.pausedUntil > now && pr !== prev && pr.failures.length === 0)
    pr = { ...pr, restricted: false, pausedUntil: now + PROBE_EVERY_MIN * 60000, reason: String(pr.reason).replace(/\(paused \d+ min\)$/, `(paused ${PROBE_EVERY_MIN} min, then probed)`) };
  pr = { ...pr, model: model ?? prev.model ?? null, probingAt: null };
  write(home, { ...rec, failures: rec.failures ?? [], pools: { ...(rec.pools ?? {}), [pool]: pr } });
  return pr.pausedUntil && pr.pausedUntil > now ? { ...pr, pool } : null;
};
// A completed turn clears its family's record and the account's; without a model, everything.
export const noteSuccess = (home, model = null) => {
  const rec = read(home), pool = poolOf(model);
  const pools = pool ? Object.fromEntries(Object.entries(rec.pools ?? {}).filter(([k]) => k !== pool)) : {};
  write(home, { failures: [], pausedUntil: null, reason: null, kind: null, streak: 0, ...(Object.keys(pools).length ? { pools } : {}) });
};
export const readPause = (home, now = Date.now()) => { const r = read(home); return r.pausedUntil && r.pausedUntil > now ? r : null; };
// The families out of routing now: {pool: record} — paused, or a hard pause that ended and awaits its probe.
const awaitingProbe = (r, now) => r?.kind === 'hard' && r.pausedUntil && r.pausedUntil <= now;
export const readPoolPauses = (home, now = Date.now()) =>
  Object.fromEntries(Object.entries(read(home).pools ?? {}).filter(([, r]) => (r?.pausedUntil && r.pausedUntil > now) || awaitingProbe(r, now))
    .map(([k, r]) => [k, awaitingProbe(r, now) ? { ...r, reason: `${r.reason}; awaiting a recovery probe` } : r]));
// Families whose hard pause has ended and that no probe is checking now: [{pool, model}]. Marks them as being probed.
export const claimProbes = (home, now = Date.now()) => {
  const rec = read(home), due = [];
  for (const [pool, r] of Object.entries(rec.pools ?? {}))
    if (awaitingProbe(r, now) && r.model && !(r.probingAt && now - r.probingAt < PROBE_STALE_MIN * 60000)) { due.push({ pool, model: r.model }); rec.pools[pool] = { ...r, probingAt: now }; }
  if (due.length) write(home, rec);
  return due;
};
// A probe's result: success clears the family; a failed restriction probe waits for the next UTC midnight,
// other hard failures another PROBE_EVERY_MIN minutes. Recognize restrictions in older records' reason text too.
export const probeResult = (home, model, ok, why = '', now = Date.now()) => {
  const rec = read(home), pool = poolOf(model);
  if (!pool || !rec.pools?.[pool]) return;
  if (ok) delete rec.pools[pool];
  else {
    const restricted = !!rec.pools[pool].restricted || RESTRICTED.test(rec.pools[pool].reason ?? '') || RESTRICTED.test(why);
    rec.pools[pool] = { ...rec.pools[pool], failures: [], restricted, pausedUntil: restricted ? nextUtcMidnight(now) : now + PROBE_EVERY_MIN * 60000, probingAt: null, kind: 'hard',
      reason: `recovery probe failed (${String(why).slice(0, 160)}); ${restricted ? RESTRICTED_REASON : `next probe in ${PROBE_EVERY_MIN} min`}` };
  }
  write(home, rec);
};
// An auth pause ends once the CLI is logged in again (quota.mjs calls this after a good `login status`).
export const liftAuthPause = (home) => { const r = read(home); if (r.kind === 'auth') write(home, { ...r, pausedUntil: null, reason: null, kind: null }); };
// Thread → model, so a `turn` or `wait` on an existing thread records failures against the right family.
const tmFile = (home) => path.join(home, 'thread-models.json');
export const rememberThreadModel = (home, threadId, model) => {
  if (!threadId || !model) return;
  let m = {}; try { m = JSON.parse(fs.readFileSync(tmFile(home), 'utf8')); } catch {}
  m[threadId] = model;
  const keep = Object.fromEntries(Object.entries(m).slice(-500));
  try { const t = `${tmFile(home)}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(keep)); fs.renameSync(t, tmFile(home)); } catch {}
};
export const threadModel = (home, threadId) => { try { return JSON.parse(fs.readFileSync(tmFile(home), 'utf8'))[threadId] ?? null; } catch { return null; } };
