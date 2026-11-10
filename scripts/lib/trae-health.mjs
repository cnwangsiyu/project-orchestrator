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
// - hard (quota used up, banned, 403 Forbidden, model access restricted): one pauses it for 30 minutes, then 60, 120,
//   at most 240 while they keep coming without a success.
//   <trae home>/worker-health.json  {"failures":[{"t","why"}],"pausedUntil","reason","kind","streak"}
import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_MIN = 15, HARD_MIN = 30, BACKOFF_MIN = [5, 10, 20, 30];
// Hard failures back off too (2026-11-10: TRAE's GPT restriction outlasted each 30-minute pause, so every pause end cost
// one more failed task): 30, then 60, 120, 240 minutes while they keep coming without a success.
export const HARD_BACKOFF_MIN = [30, 60, 120, 240];
const AUTH = /not logged in|unauthori[sz]ed|\b401\b|token expired|login (required|expired)|re-?login/i;
// "Model access temporarily restricted" (code 983, seen 2026-11-10 after ~1.3B TRAE tokens in a day): TRAE restricted
// the account's GPT models while Gemini/Seed/DeepSeek still worked — an account restriction, not a passing error.
const HARD = /quota|daily limit|banned|\bban\b|封禁|封号|forbidden|\b403\b|access (temporarily )?restricted|\b983\b/i;
export const failureKind = (why) => (AUTH.test(why ?? '') ? 'auth' : HARD.test(why ?? '') ? 'hard' : 'transient');
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
export const noteFailure = (home, why, now = Date.now()) => {
  const rec = read(home);
  const wasPaused = rec.pausedUntil && rec.pausedUntil > now;
  const failures = [...(rec.failures ?? []), { t: now, why: String(why ?? 'failed').slice(0, 300) }].slice(-20);
  // The backoff starts over when the last pause ended more than an hour ago.
  const streak = rec.pausedUntil && now - rec.pausedUntil > 60 * 60000 ? 0 : rec.streak ?? 0;
  const p = wasPaused ? null : pauseDecision(failures, now, streak);
  // A new pause starts the next backoff step and clears the failures that caused it.
  const out = p ? { failures: [], pausedUntil: p.pausedUntil, reason: p.reason, kind: p.kind, streak: streak + 1 }
    : { ...rec, failures };
  write(home, out);
  return out.pausedUntil && out.pausedUntil > now ? out : null;
};
export const noteSuccess = (home) => write(home, { failures: [], pausedUntil: null, reason: null, kind: null, streak: 0 });
export const readPause = (home, now = Date.now()) => { const r = read(home); return r.pausedUntil && r.pausedUntil > now ? r : null; };
// An auth pause ends once the CLI is logged in again (quota.mjs calls this after a good `login status`).
export const liftAuthPause = (home) => { const r = read(home); if (r.kind === 'auth') write(home, { ...r, pausedUntil: null, reason: null, kind: null }); };
