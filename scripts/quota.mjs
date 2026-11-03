#!/usr/bin/env node
// quota: the Claude and Codex subscription windows side by side, and how to route work across them.
//
//   quota [--fresh] [--json]
//
// Claude comes from `claude -p /usage`; Codex from each account's hub (`codex-worker.mjs --account <name> usage`), for
// every account in ~/.claude/orchestrator/_shared/codex-accounts.json (just `main` without it), with its reset cards.
// For every window it prints the used share, the reset time and the pace: used share ÷ elapsed share of the window, so
// above 1 means burning faster than the window can sustain until it resets. The `budget` line projects each window's
// share at reset; the `lean` line applies the budget: Codex first and every account spent by its reset (filling the
// account whose quota is lost first, reset cards only at 99% or before they expire), Claude kept under its window minus
// a reserve for the orchestrators (QUOTA_CLAUDE_RESERVE, default 20%) so it never runs out before Codex. Notes flag a
// nearly used one-model window and headroom a reset within a day will discard. The result is cached for 10 minutes in
// ~/.claude/orchestrator/_shared/quota.json, shared by every orchestrator; --fresh re-reads everything.
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

// ---- Codex: one or more accounts ----
// Each account is a profile in ~/.claude/orchestrator/_shared/codex-accounts.json — its own CODEX_HOME (own login) and
// its own hub — so several accounts run side by side with no switching (`codex-worker.mjs account-add` makes one).
// Without the file there is one profile, `main` (~/.codex, the default hub). The file also keeps each account's last
// reading: an account whose hub is down is projected from it (an idle account doesn't spend; windows roll over at reset).
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-worker.mjs');
const ACCOUNTS = process.env.CODEX_ACCOUNTS || path.join(os.homedir(), '.claude', 'orchestrator', '_shared', 'codex-accounts.json');
const readProfiles = () => {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); } catch {}
  if (!Object.keys(reg).length) reg.main = { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' };
  return reg;
};
const parseUsage = (usage) => {
  // Plans differ in which windows they have (a higher plan may drop the 5-hour one), so take whatever windows come back,
  // label them by their own duration, and treat a plan with none (or unlimited credits) as unconstrained.
  const windows = []; let plan = null;
  for (const [id, b] of Object.entries(usage.buckets ?? {})) {
    if (!b) continue;
    plan ??= b.planType;
    if (b.credits?.unlimited) continue;
    for (const w of [b.primary, b.secondary]) {
      if (!w || w.usedPercent == null) continue;
      const mins = w.windowDurationMins;
      const span = mins === 300 ? '5h' : mins === 10080 ? 'week' : mins ? `${mins}m` : '?';
      windows.push({ label: id === 'codex' ? span : `${span} (${b.limitName ?? id})`, used: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null, windowMins: mins ?? null, scoped: id !== 'codex' });
    }
  }
  const rc = usage.resetCredits;
  const resets = rc ? {
    count: rc.availableCount ?? 0,
    credits: (rc.credits ?? []).filter((c) => c.status === 'available')
      .map((c) => ({ id: c.id, expiresAt: c.expiresAt ? c.expiresAt * 1000 : null }))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)),
  } : null;
  return { plan, windows, resets, id: usage.accountId ?? null, allowed: usage.ordinaryUsageAllowed ?? null };
};
// The account a profile's `codex login` points at (its hub may still run an older one until it restarts). Only the
// account id, email and plan are taken from the id token; no token is kept or printed.
const readLogin = (home) => {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    const claims = JSON.parse(Buffer.from(a.tokens.id_token.split('.')[1], 'base64url').toString());
    const auth = claims['https://api.openai.com/auth'] ?? {};
    return { id: a.tokens.account_id ?? auth.chatgpt_account_id ?? null, email: claims.email ?? null, plan: auth.chatgpt_plan_type ?? null };
  } catch { return null; }
};
const project = (acc) => {
  const windows = (acc.windows ?? []).map((w) => {
    let { used, resetsAt } = w;
    while (resetsAt && w.windowMins && resetsAt <= now) { used = 0; resetsAt += w.windowMins * 60000; }
    return { ...w, used, resetsAt };
  });
  const all = acc.resets?.credits ?? [];
  const credits = all.filter((c) => !c.expiresAt || c.expiresAt > now);
  return { ...acc, windows, resets: acc.resets ? { count: Math.max(0, (acc.resets.count ?? 0) - (all.length - credits.length)), credits } : null };
};
const readCodexAll = () => {
  const reg = readProfiles(), accounts = [];
  for (const [name, prof] of Object.entries(reg)) {
    const login = readLogin(prof.home);
    try {
      const u = parseUsage(JSON.parse(execFileSync(process.execPath, [WORKER, '--account', name, 'usage'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })));
      reg[name] = { ...prof, id: u.id, email: login?.id === u.id ? login.email : prof.email ?? null, plan: u.plan, seenAt: now, windows: u.windows, resets: u.resets };
      accounts.push({ name, live: true, ...reg[name], allowed: u.allowed, staleHub: !!(login?.id && u.id && login.id !== u.id) });
    } catch (e) {
      const why = String(e.stderr || e.message).trim().split('\n')[0];
      if (prof.windows) accounts.push({ name, live: false, error: why, ...project(prof) });
      else accounts.push({ name, live: false, error: why, home: prof.home, email: login?.email ?? null, windows: null, resets: null });
    }
  }
  fs.mkdirSync(path.dirname(ACCOUNTS), { recursive: true });
  const t = `${ACCOUNTS}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(reg, null, 1)); fs.renameSync(t, ACCOUNTS);
  return accounts;
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
  let status = 'ok', why = '';
  for (const w of windows.filter((x) => !x.scoped)) {
    const p = pace(w), left = w.resetsAt ? (w.resetsAt - now) / 3600000 : null;
    const desc = `${w.label} ${w.used}%${p != null ? ` pace ${p.toFixed(1)}` : ''}${left !== null ? ` resets in ${hours(left)}` : ''}`;
    const soon = left !== null && left < 0.5;
    if (!soon && (w.used >= 90 || (w.used >= 75 && (p ?? 1) >= 1.3))) {
      if (status !== 'tight') why = '';
      status = 'tight'; why += (why ? '; ' : '') + desc;
    } else if (status !== 'tight' && !soon && w.used >= 60 && (p ?? 1) >= 1) { status = 'watch'; why += (why ? '; ' : '') + desc; }
  }
  return { status, why };
};
// Budget targets (user, 2026-11-03): Codex quota is use-it-or-lose-it, so aim to spend every account's window by its
// reset; Claude also runs the orchestrators, so it must never run out before Codex — keep a reserve of its window for
// orchestration and give Claude workers only what fits under the rest.
const CLAUDE_RESERVE = Number(process.env.QUOTA_CLAUDE_RESERVE ?? 20); // percent of Claude's window kept for orchestration
const CLAUDE_SPARE = 60; // projected % at or below which Claude also takes the work it is clearly better at
const REDEEM_AT = 99; // a reset card is suggested only once an account's window is this spent (user, 2026-11-03)
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
    const elapsed = 1 - left / (w.windowMins / 60);
    if (!best || p > best.pace) best = { label: w.label, used: w.used, pace: p, projected: Math.round(p * 100), left, outIn, elapsed, rate, windowH: w.windowMins / 60, resetsAt: w.resetsAt };
  }
  return best;
};
const hours = (h) => (!Number.isFinite(h) ? 'never' : h < 24 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);
const fmt = (t) => t ? new Date(t).toLocaleString('sv-SE').slice(5, 16) : '?';
const fmtAgo = (t) => { const m = Math.round((now - t) / 60000); return m < 90 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const who = (a) => `${a.name}${a.email ? ` (${a.email})` : ''}`;

// Reset-card plan for one account. Redeeming at usage u with d of the window's length T left gains about u + d/T - 1
// windows: a full new window, minus the unused share forfeited, minus the time the restarted clock pushes the next
// natural reset back. So redeem once the window is spent (gain ≈ d/T): the earlier in a cycle, the more it gains, which
// is why Codex is front-loaded while cards are in hand. A card that expires before the natural reset is a deadline.
const cardPlan = (b, r) => {
  if (!b || !r || !r.count) return null;
  const card = r.credits[0] ?? null; // soonest to expire (no details: only the count is known)
  const gainAt = (usedPct, leftH) => usedPct / 100 + leftH / b.windowH - 1;
  const expH = card?.expiresAt ? (card.expiresAt - now) / 3600000 : null;
  const cardTxt = card ? `${card.id.slice(-8)}${expH != null ? `, expires in ${hours(expH)}` : ''}` : 'next card';
  const plan = { count: r.count, card, cardTxt, expH, redeem: false, urgent: false, gain: 0, deadlineH: null, line: '' };
  const beforeReset = expH != null && expH < b.left;
  if (b.used >= REDEEM_AT) {
    plan.gain = gainAt(100, b.left);
    plan.redeem = plan.gain >= 0.1 || (beforeReset && plan.gain > 0);
    plan.urgent = plan.redeem && expH != null && expH < 24;
    plan.line = plan.redeem
      ? `${b.used}% spent with ${hours(b.left)} to its reset: a reset card (${cardTxt}) gains ~${Math.round(plan.gain * 100)}% of a window`
      : `spent but resets in ${hours(b.left)}: wait for the natural reset and keep the card (it would gain only ~${Math.round(plan.gain * 100)}%)`;
    return plan;
  }
  if (beforeReset) {
    const breakEven = Math.max(0, Math.ceil(100 * (1 - (b.left - expH) / b.windowH)));
    if (expH <= 1) {
      plan.gain = gainAt(b.used, b.left);
      plan.redeem = plan.urgent = plan.gain > 0.05;
      plan.line = plan.redeem ? `reset card ${cardTxt} is about to expire and at ${b.used}% still gains ~${Math.round(plan.gain * 100)}% of a window`
        : `let reset card ${cardTxt} lapse: at ${b.used}% redeeming forfeits more unused quota than it gains (break-even ${breakEven}%)`;
      return plan;
    }
    plan.deadlineH = expH;
    const need = (100 - b.used) / expH * 24;
    plan.line = `reset card ${cardTxt}, before the window resets: spend this account to ${REDEEM_AT}% by then (needs ${need.toFixed(0)}%/day, running ${(b.rate * 24).toFixed(0)}%/day) and redeem; it pays only above ${breakEven}%`;
  } else plan.line = `${r.count} reset card${r.count > 1 ? 's' : ''} (soonest ${cardTxt}): front-load this account — spend it early in the cycle, redeem at ${REDEEM_AT}%`;
  return plan;
};

// Route Codex work across accounts: fill the account whose unused quota is lost first (its reset, or an earlier card
// expiry); use cards only once every account is spent, or for a card that would otherwise expire (user, 2026-11-03:
// spend the quota first, then the cards).
const routeCodex = (accounts) => {
  const rows = (accounts ?? []).filter((a) => a.windows).map((a) => {
    const b = budget(a.windows), cp = cardPlan(b, a.resets);
    return { a, b, cp, spent: !b || b.used >= REDEEM_AT || a.allowed === false, deadline: Math.min(b?.left ?? Infinity, cp?.deadlineH ?? Infinity) };
  });
  const open = rows.filter((r) => !r.spent).sort((x, y) => x.deadline - y.deadline);
  const urgent = rows.filter((r) => r.spent && r.cp?.urgent);
  const redeemable = rows.filter((r) => r.spent && r.cp?.redeem).sort((x, y) => y.cp.gain - x.cp.gain);
  const pick = open[0] ?? null;
  const redeem = urgent[0] ?? (!pick ? redeemable[0] : null) ?? null;
  return { rows, open, pick, redeem, out: !pick && !redeem && rows.length > 0 };
};

// The lean: Codex first for everything either vendor can do; Claude for Claude-only work, plus its strengths while it
// has spare; then corrections when Codex is under- or over-spending, Claude is over its budget, or Codex is out.
const lean = (route) => {
  const bc = budget(data.claude);
  const parts = [];
  const claudeCap = 100 - CLAUDE_RESERVE;
  const multi = route.rows.length > 1;
  const at = (r) => (multi ? ` on account ${who(r.a)}` : '');
  for (const r of route.rows) if (r.a.staleHub) parts.push(`account ${r.a.name}: its login changed but its hub still runs the old account — restart that hub once no thread runs on it`);
  if (route.redeem) parts.push(`redeem a reset card${at(route.redeem)}: ${route.redeem.cp.line} — with the user's OK (or standing approval in memory): \`codex-worker.mjs${multi ? ` --account ${route.redeem.a.name}` : ''} reset-credit-use --key <new uuid>\``);
  const pick = route.pick ?? (route.redeem && !route.redeem.cp.urgent ? route.redeem : null);
  const bx = pick?.b ?? null;
  if (multi && route.pick) parts.push(`new Codex work → account ${who(route.pick.a)} (${route.pick.b.used}% used, its quota is lost first: ${hours(route.pick.deadline)})`);
  // Claude must outlast Codex: over its cap, projected over it, or on course to run out before Codex does.
  const claudeOver = !!bc && (bc.used >= claudeCap || bc.projected > claudeCap
    || (!!bx && bc.outIn < bc.left && bc.outIn < Math.min(bx.outIn, bx.left)));
  if (route.out) {
    const next = route.rows.map((r) => r.b?.left ?? Infinity).sort((x, y) => x - y)[0];
    const room = bc ? claudeCap - bc.used : null;
    parts.push(`codex out on every account (next reset in ${hours(next)}): tell the user; Claude takes what matters before then, `
      + `within ${room != null ? `${room}% of room` : 'its budget'} under its ${claudeCap}% cap (now ${bc ? `${bc.used}%, projected ${bc.projected}%` : '?'}), and the rest waits`);
  } else if (bx) {
    const cards = route.rows.some((r) => r.cp);
    const codexHot = bx.projected > 115 && !cards && route.open.length <= 1;
    const claudeSpare = !!bc && !claudeOver && bc.projected <= CLAUDE_SPARE;
    parts.push(codexHot && claudeSpare
      ? `split: Codex is overspending and Claude has spare, so Claude also takes work either vendor can do while it stays under ${claudeCap}%`
      : 'codex first: send everything either vendor can do to Codex');
    if (claudeOver) parts.push(`claude over budget (${bc.label} ${bc.used}%, projected ${bc.projected}% vs cap ${claudeCap}%, out in ${hours(bc.outIn)}): `
      + "no new Claude workers except Claude-only work that can't wait; move Claude-strength work (docs, design, research) to Codex Sol; "
      + 'keep the orchestrator lean (Haiku subagents, fewer reads)');
    else if (bc && bc.projected <= CLAUDE_SPARE) parts.push(`claude has spare (projected ${bc.projected}%): it also takes the work it is clearly better at (docs, design, research, open-ended work)`);
    else if (bc) parts.push(`claude near budget (projected ${bc.projected}%): Claude-only work plus design and high-stakes calls; everything else on Codex`);
    // Underused: the pool won't be spent by its deadlines. Right after a reset the projection is noise, so with no
    // card deadline wait until a tenth of the window has passed.
    const unspent = route.open.filter((r) => r.b.used + r.b.rate * r.deadline < 100 && (r.cp?.deadlineH || r.b.elapsed >= 0.1));
    if (unspent.length) parts.push(`codex underused (${unspent.map((r) => `${multi ? `${r.a.name} ` : ''}on course for ${Math.round(r.b.used + r.b.rate * r.deadline)}% by ${r.cp?.deadlineH ? 'its card expiry' : 'its reset'}`).join(', ')}): `
      + 'raise effort on Codex work, add second-opinion reviews, pull queued and deferred work forward, move work Codex does well enough off Claude');
    else if (codexHot) parts.push(`codex overspending (projected ${bx.projected}%, out in ${hours(bx.outIn)} vs reset in ${hours(bx.left)}): lower effort where a check catches misses; save Sol xhigh and Astra for what matters`);
    for (const r of route.open) if (r.cp && !r.cp.redeem) parts.push(`${multi ? `${r.a.name}: ` : ''}${r.cp.line}`);
  }
  if (!bc) parts.push('claude usage unreadable: check it manually before launching Claude workers');
  for (const a of data.codexAccounts ?? []) if (!a.live) parts.push(`account ${a.name}: hub unreachable (${a.error ?? '?'})${a.windows ? `, using its reading from ${fmtAgo(a.seenAt)}` : ''}; start it with \`codex-worker.mjs --account ${a.name} hub\``);
  return parts.join('; ');
};
// Per-window hints: a one-model window (e.g. Fable) nearly used up, and Claude headroom that a reset within a day discards.
const notes = () => {
  const out = [];
  for (const w of data.claude ?? []) {
    const left = w.resetsAt ? (w.resetsAt - now) / 3600000 : null;
    if (w.scoped && w.used >= 70) out.push(`claude ${w.label} ${w.used}% used: avoid that model until it resets${left != null ? ` in ${hours(left)}` : ''}`);
    const room = 100 - w.used - CLAUDE_RESERVE;
    if (!w.scoped && left != null && left > 0 && left < 24 && (w.windowMins ?? 0) >= 1440 && room >= 25)
      out.push(`expiring: claude ${w.label} resets in ${hours(left)} with ${room}% spendable above the ${CLAUDE_RESERVE}% reserve; use stronger settings there`);
  }
  for (const a of data.codexAccounts ?? []) for (const w of a.windows ?? []) {
    const left = w.resetsAt ? (w.resetsAt - now) / 3600000 : null;
    if (!w.scoped && left != null && left > 0 && left < 24 && (w.windowMins ?? 0) >= 1440 && 100 - w.used >= 25)
      out.push(`expiring: codex ${a.name} ${w.label} resets in ${hours(left)} with ${100 - w.used}% left; put Codex work there now, at stronger settings`);
  }
  return out;
};

let data;
try { data = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
if (args.includes('--fresh') || !data || now - data.checkedAt > TTL_MS || !data.codexAccounts) {
  data = { checkedAt: now, claude: null, codexAccounts: null, errors: {} };
  try { data.claude = readClaude(); } catch (e) { data.errors.claude = String(e.message).split('\n')[0]; }
  try { data.codexAccounts = readCodexAll(); } catch (e) { data.errors.codex = String(e.stderr || e.message).trim().split('\n')[0]; }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const tmp = `${CACHE}.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, CACHE);
}
const route = routeCodex(data.codexAccounts);
const c = judge(data.claude);
const result = {
  checkedAt: new Date(data.checkedAt).toISOString(), claude: { ...c, windows: data.claude },
  codex: (data.codexAccounts ?? []).map((a) => ({ name: a.name, email: a.email ?? null, live: a.live, plan: a.plan ?? null, ...judge(a.windows), windows: a.windows, resets: a.resets })),
  codexPick: route.pick?.a.name ?? null, redeem: route.redeem ? { account: route.redeem.a.name, card: route.redeem.cp.card?.id ?? null } : null,
  errors: data.errors, lean: lean(route), notes: notes(),
};
if (args.includes('--json')) { console.log(JSON.stringify(result)); process.exit(0); }

console.log(`quota (read ${fmt(data.checkedAt)}, ${Math.round((now - data.checkedAt) / 60000)}m ago)`);
for (const w of data.claude ?? []) {
  const p = pace(w);
  console.log(`  claude ${w.label.padEnd(28)}${String(w.used).padStart(3)}% used  resets ${fmt(w.resetsAt)}  pace ${p != null ? p.toFixed(1) : '-'}${w.scoped ? '  (one model only)' : ''}`);
}
if (!data.claude) console.log(`  claude unavailable: ${data.errors.claude ?? 'unknown error'}`);
for (const a of data.codexAccounts ?? []) {
  const tag = `${a.name}${a.email ? ` ${a.email}` : ''}`;
  if (!a.windows) { console.log(`  codex  ${tag}: unavailable (${a.error ?? '?'})`); continue; }
  for (const w of a.windows) {
    const p = pace(w);
    console.log(`  codex  ${`${tag} ${w.label}`.padEnd(28)}${String(w.used).padStart(3)}% used  resets ${fmt(w.resetsAt)}  pace ${p != null ? p.toFixed(1) : '-'}${a.live ? '' : `  [from ${fmtAgo(a.seenAt)}]`}`);
  }
  if (a.resets) console.log(`  codex  ${tag} reset cards: ${a.resets.count}${a.resets.credits.length ? ` (expire ${a.resets.credits.map((x) => fmt(x.expiresAt)).join(', ')})` : ''}`);
}
if (!data.codexAccounts) console.log(`  codex  unavailable: ${data.errors.codex ?? 'unknown error'}`);
console.log(`claude: ${c.status}${c.why ? ` (${c.why})` : ''}`);
for (const a of result.codex) console.log(`codex ${a.name}: ${a.status}${a.why ? ` (${a.why})` : ''}${a.plan ? ` [plan ${a.plan}]` : ''}`);
const bc = budget(data.claude);
const proj = (b) => (b ? `projected ${b.projected}% at reset` : '?');
console.log(`budget: codex target ~100% of every account by its reset (${route.rows.map((r) => `${r.a.name} ${proj(r.b)}`).join(', ') || '?'}); `
  + `claude cap ${100 - CLAUDE_RESERVE}%, ${CLAUDE_RESERVE}% reserved for orchestration (${proj(bc)})`);
console.log(`lean: ${result.lean}`);
for (const n of result.notes) console.log(`note: ${n}`);
