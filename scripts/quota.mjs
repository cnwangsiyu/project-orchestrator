#!/usr/bin/env node
// quota: the Claude and Codex subscription windows side by side, and which way they lean.
//
//   quota [--fresh] [--json]
//
// Claude comes from `claude -p /usage`, Codex from the hub (`codex-worker.mjs quota`). For every window it prints the
// used share, the reset time and the pace: used share ÷ elapsed share of the window, so above 1 means burning faster
// than the window can sustain until it resets. Each vendor is ok | watch | tight | unknown, and the last line leans
// toward a budget: Codex first and spent fully by its reset, Claude kept under its window minus a reserve for the
// orchestrators (QUOTA_CLAUDE_RESERVE, default 20%) so it never runs out before Codex. Notes flag a nearly used
// one-model window and headroom a reset within a day will discard. The result is cached for 10 minutes in ~/.claude/orchestrator/_shared/quota.json,
// shared by every orchestrator; --fresh re-reads both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const CACHE = process.env.QUOTA_CACHE || path.join(os.homedir(), '.claude', 'orchestrator', '_shared', 'quota.json');
const TTL_MS = 10 * 60 * 1000;
const now = Date.now();

// Epoch ms of a wall-clock time in an IANA zone (no library: correct the UTC guess by the zone's offset).
const zoned = (y, mo, d, h, mi, tz) => {
  const guess = Date.UTC(y, mo, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(guess)).map((p) => [p.type, Number(p.value)]));
  return guess - (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - guess);
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "Nov 3 at 9am (America/Los_Angeles)", "4:30pm (America/Los_Angeles)" → epoch ms, or null.
const parseReset = (s) => {
  const m = s.match(/^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,)?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return null;
  const [, mon, day, hh, mm = '0', ampm, tz] = m;
  const h = (Number(hh) % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  try {
    const today = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)]));
    let t;
    if (mon) {
      const mo = MONTHS.indexOf(mon.toLowerCase());
      if (mo < 0) return null;
      t = zoned(today.year, mo, Number(day), h, Number(mm), tz);
      if (t < now - 86400000) t = zoned(today.year + 1, mo, Number(day), h, Number(mm), tz);
    } else {
      t = zoned(today.year, today.month - 1, today.day, h, Number(mm), tz);
      if (t < now) t += 86400000;
    }
    return t;
  } catch { return null; }
};

const readClaude = () => {
  const out = execFileSync('claude', ['-p', '/usage'], { encoding: 'utf8', timeout: 90000, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
  const windows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*Current (.+?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/);
    if (!m) continue;
    const label = m[1].replace(/\s+/g, ' ');
    const windowMins = /session/i.test(label) ? 300 : /week/i.test(label) ? 10080 : null;
    // A window for one model only (e.g. "week (Fable)") doesn't limit other work, so it doesn't decide the status.
    const scoped = /\((?!all models)[^)]*\)/i.test(label);
    windows.push({ label, used: Number(m[2]), resetsAt: m[3] ? parseReset(m[3].trim()) : null, windowMins, scoped });
  }
  if (!windows.length) throw new Error('no usage lines in `claude -p /usage` output');
  return windows;
};

const readCodex = () => {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-worker.mjs');
  const buckets = JSON.parse(execFileSync(process.execPath, [worker, 'quota'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
  // Plans differ in which windows they have (a higher plan may drop the 5-hour one), so take whatever windows come back,
  // label them by their own duration, and treat a plan with none (or unlimited credits) as unconstrained.
  const windows = [];
  for (const [id, b] of Object.entries(buckets)) {
    if (!b) continue;
    windows.plan ??= b.planType;
    if (b.credits?.unlimited) continue;
    for (const w of [b.primary, b.secondary]) {
      if (!w || w.usedPercent == null) continue;
      const mins = w.windowDurationMins;
      const span = mins === 300 ? '5h' : mins === 10080 ? 'week' : mins ? `${mins}m` : '?';
      windows.push({ label: id === 'codex' ? span : `${span} (${b.limitName ?? id})`, used: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null, windowMins: mins ?? null, scoped: id !== 'codex' });
    }
  }
  return { plan: windows.plan ?? null, windows };
};

const pace = (w) => {
  if (!w.resetsAt || !w.windowMins) return null;
  // Floor at a tenth of the window: right after a reset a few percent would otherwise read as a runaway pace.
  const elapsed = Math.min(1, Math.max(0.1, 1 - (w.resetsAt - now) / (w.windowMins * 60000)));
  return (w.used / 100) / elapsed;
};
// tight: nearly out, or well used and burning fast with time still to go; watch: on course to run out early.
const judge = (windows) => {
  if (!windows) return { status: 'unknown', why: 'could not read' };
  if (!windows.some((w) => !w.scoped)) return { status: 'ok', why: 'no limit windows reported' };
  let status = 'ok', why = '', freesAt = 0;
  for (const w of windows.filter((x) => !x.scoped)) {
    const p = pace(w), left = w.resetsAt ? (w.resetsAt - now) / 3600000 : null;
    const desc = `${w.label} ${w.used}%${p != null ? ` pace ${p.toFixed(1)}` : ''}${left !== null ? ` resets in ${hours(left)}` : ''}`;
    const soon = left !== null && left < 0.5;
    if (!soon && (w.used >= 90 || (w.used >= 75 && (p ?? 1) >= 1.3))) {
      if (status !== 'tight') why = '';
      status = 'tight'; why += (why ? '; ' : '') + desc;
      freesAt = Math.max(freesAt, w.resetsAt ?? Infinity); // every tight window has to reset before the vendor is free
    } else if (status !== 'tight' && !soon && w.used >= 60 && (p ?? 1) >= 1) { status = 'watch'; why += (why ? '; ' : '') + desc; }
  }
  return { status, why, freesAt: status === 'tight' ? freesAt : null };
};
// Budget targets (user, 2026-11-03): Codex quota is use-it-or-lose-it, so aim to spend its whole window by the reset;
// Claude also runs the orchestrators, so it must never run out before Codex — keep a reserve of its window for
// orchestration and give Claude workers only what fits under the rest.
const CLAUDE_RESERVE = Number(process.env.QUOTA_CLAUDE_RESERVE ?? 20); // percent of Claude's window kept for orchestration
const CLAUDE_SPARE = 60; // projected % at or below which Claude also takes the work it is clearly better at
// The binding window: the non-scoped one with the highest pace. projected = share used at its reset at the current
// rate; outIn = hours until 100% at that rate.
const budget = (ws) => {
  let best = null;
  for (const w of (ws ?? []).filter((x) => !x.scoped)) {
    const p = pace(w);
    if (p == null) continue;
    const left = (w.resetsAt - now) / 3600000;
    const rate = w.used / Math.max(0.1 * w.windowMins / 60, w.windowMins / 60 - left); // percent per hour so far
    const outIn = rate > 0 ? (100 - w.used) / rate : Infinity;
    const elapsed = 1 - left / (w.windowMins / 60); // share of the window gone
    if (!best || p > best.pace) best = { label: w.label, used: w.used, pace: p, projected: Math.round(p * 100), left, outIn, elapsed };
  }
  return best;
};
// Per-window hints: a one-model window (e.g. Fable) nearly used up, and headroom that a reset within a day will discard.
const notes = (vendor, ws) => {
  const out = [];
  for (const w of ws ?? []) {
    const left = w.resetsAt ? (w.resetsAt - now) / 3600000 : null;
    if (w.scoped && w.used >= 70) out.push(`${vendor} ${w.label} ${w.used}% used: avoid that model until it resets${left != null ? ` in ${hours(left)}` : ''}`);
    const room = 100 - w.used - (vendor === 'claude' ? CLAUDE_RESERVE : 0);
    if (!w.scoped && left != null && left > 0 && left < 24 && (w.windowMins ?? 0) >= 1440 && room >= 25)
      out.push(`expiring: ${vendor} ${w.label} resets in ${hours(left)} with ${room}% spendable${vendor === 'claude' ? ` above the ${CLAUDE_RESERVE}% reserve` : ''}; use stronger settings there and pull queued work forward`);
  }
  return out;
};
const hours = (h) => (!Number.isFinite(h) ? 'never' : h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);
// The lean: Codex first for everything either vendor can do; Claude for Claude-only work, plus its strengths while it
// has spare; then corrections when Codex is under- or over-spending, Claude is over its budget, or Codex is out.
const lean = (c, x) => {
  const bc = budget(data.claude), bx = budget(data.codex);
  const parts = [];
  const claudeCap = 100 - CLAUDE_RESERVE;
  const codexOut = !!bx && (bx.used >= 95 || bx.outIn < 0.5) && bx.left > 0.5;
  // Claude must outlast Codex: over its cap, projected over it, or on course to run out before Codex does.
  const claudeOver = !!bc && (bc.used >= claudeCap || bc.projected > claudeCap
    || (!!bx && bc.outIn < bc.left && bc.outIn < Math.min(bx.outIn, bx.left)));
  if (codexOut) {
    const room = bc ? claudeCap - bc.used : null;
    parts.push(`codex out (${bx.label} ${bx.used}%, resets in ${hours(bx.left)}): tell the user; Claude takes what matters before then, `
      + `within ${room != null ? `${room}% of room` : 'its budget'} under its ${claudeCap}% cap (now ${bc ? `${bc.used}%, projected ${bc.projected}%` : '?'}), `
      + 'and the rest waits for the Codex reset');
  } else {
    const codexHot = !!bx && bx.projected > 115;
    const claudeSpare = !!bc && !claudeOver && bc.projected <= CLAUDE_SPARE;
    parts.push(codexHot && claudeSpare
      ? `split: Codex is overspending and Claude has spare, so Claude also takes work either vendor can do while it stays under ${claudeCap}%`
      : 'codex first: send everything either vendor can do to Codex');
    if (claudeOver) parts.push(`claude over budget (${bc.label} ${bc.used}%, projected ${bc.projected}% vs cap ${claudeCap}%, out in ${hours(bc.outIn)}): `
      + "no new Claude workers except Claude-only work that can't wait; move Claude-strength work (docs, design, research) to Codex Sol; "
      + 'keep the orchestrator lean (Haiku subagents, fewer reads)');
    else if (bc && bc.projected <= CLAUDE_SPARE) parts.push(`claude has spare (projected ${bc.projected}%): it also takes the work it is clearly better at (docs, design, research, open-ended work)`);
    else if (bc) parts.push(`claude near budget (projected ${bc.projected}%): Claude-only work plus design and high-stakes calls; everything else on Codex`);
    // Right after a reset the projection is noise, so only call Codex underused once a tenth of the window has passed.
    if (bx && bx.projected < 85 && bx.elapsed >= 0.1) parts.push(`codex underused (projected ${bx.projected}% by reset in ${hours(bx.left)}): raise effort on Codex work, add second-opinion reviews, pull queued work forward`);
    else if (bx && bx.projected > 115) parts.push(`codex overspending (projected ${bx.projected}%, out in ${hours(bx.outIn)} vs reset in ${hours(bx.left)}): lower effort where a check catches misses; save Sol xhigh and Astra for what matters`);
  }
  if (!bc) parts.push('claude usage unreadable: check it manually before launching Claude workers');
  if (!bx && x.status !== 'ok') parts.push('codex usage unreadable: check it manually');
  return parts.join('; ');
};

let data;
try { data = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
if (args.includes('--fresh') || !data || now - data.checkedAt > TTL_MS) {
  data = { checkedAt: now, claude: null, codex: null, errors: {} };
  try { data.claude = readClaude(); } catch (e) { data.errors.claude = String(e.message).split('\n')[0]; }
  try { const r = readCodex(); data.codex = r.windows; data.codexPlan = r.plan; } catch (e) { data.errors.codex = String(e.stderr || e.message).trim().split('\n')[0]; }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const tmp = `${CACHE}.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, CACHE);
}
const c = judge(data.claude), x = judge(data.codex);
const result = { checkedAt: new Date(data.checkedAt).toISOString(), claude: { ...c, windows: data.claude }, codex: { ...x, plan: data.codexPlan ?? null, windows: data.codex }, errors: data.errors, lean: lean(c, x), notes: [...notes('claude', data.claude), ...notes('codex', data.codex)] };
if (args.includes('--json')) { console.log(JSON.stringify(result)); process.exit(0); }

const fmt = (t) => t ? new Date(t).toLocaleString('sv-SE').slice(5, 16) : '?';
console.log(`quota (read ${fmt(data.checkedAt)}, ${Math.round((now - data.checkedAt) / 60000)}m ago)`);
for (const [vendor, ws] of [['claude', data.claude], ['codex', data.codex]]) {
  for (const w of ws ?? []) {
    const p = pace(w);
    console.log(`  ${vendor.padEnd(7)}${w.label.padEnd(20)}${String(w.used).padStart(3)}% used  resets ${fmt(w.resetsAt)}  pace ${p != null ? p.toFixed(1) : '-'}${w.scoped ? '  (one model only)' : ''}`);
  }
  if (!ws) console.log(`  ${vendor.padEnd(7)}unavailable: ${data.errors[vendor] ?? 'unknown error'}`);
}
console.log(`claude: ${c.status}${c.why ? ` (${c.why})` : ''}`);
console.log(`codex: ${x.status}${x.why ? ` (${x.why})` : ''}${data.codexPlan ? ` [plan ${data.codexPlan}]` : ''}`);
const bc = budget(data.claude), bx = budget(data.codex);
const proj = (b) => (b ? ` [projected ${b.projected}% at reset]` : '');
console.log(`budget: codex target ~100% by reset${proj(bx)}; claude cap ${100 - CLAUDE_RESERVE}%, ${CLAUDE_RESERVE}% reserved for orchestration${proj(bc)}`);
console.log(`lean: ${result.lean}`);
for (const n of result.notes) console.log(`note: ${n}`);
