// TRAE CLI health from what its workers hit (user, 2026-11-08): quota.mjs only sees that the CLI is logged in and lists
// its models, not that its gateway keeps failing (rate limits, a ban, long queues, outages). codex-worker records each
// failed or stalled TRAE turn here, and any completed turn clears the record. After two failures within WINDOW_MIN, or one
// that looks like a quota / ban / auth problem, TRAE is paused for PAUSE_MIN from the last failure: quota.mjs reports it
// unavailable, so route.mjs stops sending it work (TTADK if usable, else the personal-quota OK gate) instead of every
// task failing once first.
//   <trae home>/worker-health.json  {"failures": [{"t": ms, "why": "..."}], "pausedUntil": ms|null, "reason": "..."}
import fs from 'node:fs';
import path from 'node:path';

export const PAUSE_MIN = 30, WINDOW_MIN = 15;
const HARD = /quota|limit exceeded|rate.?limit|banned|ban\b|封禁|forbidden|unauthori[sz]ed|\b40[13]\b|not logged in|login|token expired/i;
const file = (home) => path.join(home, 'worker-health.json');
const read = (home) => { try { return JSON.parse(fs.readFileSync(file(home), 'utf8')); } catch { return { failures: [] }; } };
const write = (home, rec) => { try { const t = `${file(home)}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(rec)); fs.renameSync(t, file(home)); } catch {} };

// Pure: the pause these failures call for at time now, or null.
export const pauseDecision = (failures, now = Date.now()) => {
  const recent = (failures ?? []).filter((f) => now - f.t <= WINDOW_MIN * 60000);
  if (!recent.length) return null;
  const hard = recent.find((f) => HARD.test(f.why ?? ''));
  if (!hard && recent.length < 2) return null;
  const last = recent.reduce((a, f) => (f.t > a.t ? f : a));
  return { pausedUntil: last.t + PAUSE_MIN * 60000, reason: hard ? `${hard.why}`.slice(0, 200) : `${recent.length} failed or stalled TRAE turns in ${WINDOW_MIN} min (last: ${String(last.why).slice(0, 160)})` };
};
export const noteFailure = (home, why, now = Date.now()) => {
  const rec = read(home);
  const failures = [...(rec.failures ?? []), { t: now, why: String(why ?? 'failed').slice(0, 300) }].slice(-20);
  const p = pauseDecision(failures, now);
  const out = { failures, pausedUntil: p?.pausedUntil ?? (rec.pausedUntil > now ? rec.pausedUntil : null), reason: p?.reason ?? rec.reason ?? null };
  write(home, out);
  return out.pausedUntil && out.pausedUntil > now ? out : null;
};
export const noteSuccess = (home) => write(home, { failures: [], pausedUntil: null, reason: null });
export const readPause = (home, now = Date.now()) => { const r = read(home); return r.pausedUntil && r.pausedUntil > now ? r : null; };
