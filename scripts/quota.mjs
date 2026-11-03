#!/usr/bin/env node
// quota: Claude's and every Codex account's usage side by side, and the quota lean that route.mjs applies.
//
//   quota [--fresh] [--json]
//
// Claude comes from `claude -p /usage`; Codex from each account's hub (`codex-worker.mjs --account <name> usage`) for
// every profile in ~/.claude/orchestrator/_shared/codex-accounts.json (`main` without it), with its reset cards. Each
// window shows its used share, reset and projection at reset (from the recent burn rate when there is one). The lean
// lines come from lib/state.mjs, where all quota policy lives. Readings are cached for 10 minutes in
// ~/.claude/orchestrator/_shared/quota.json and shared by every orchestrator; --fresh re-reads everything.
import { readState, analyze, leanLines, winState, weekly, fmt, fmtAgo, POLICY } from './lib/state.mjs';

const args = process.argv.slice(2);
const data = readState({ fresh: args.includes('--fresh') });
const st = analyze(data);
const lean = leanLines(st, data);
if (args.includes('--json')) {
  const { codex, claude } = st;
  console.log(JSON.stringify({
    checkedAt: new Date(data.checkedAt).toISOString(), errors: data.errors, stop: st.stop, policy: POLICY,
    claude: { ...claude, windows: data.claude },
    codex: codex.rows.map((r) => ({ name: r.a.name, email: r.a.email ?? null, live: r.a.live, plan: r.a.plan ?? null, week: r.s, spent: r.spent, throttledUntil: r.throttledUntil, unconstrained: r.unconstrained, resets: r.a.resets, cardPlan: r.cp })),
    codexPick: codex.pick?.a.name ?? null, redeem: codex.redeem ? { account: codex.redeem.a.name, card: codex.redeem.cp.card?.id ?? null } : null,
    codexOut: codex.out, underused: codex.underused, frontLoad: codex.frontLoad, overspending: codex.overspending, lean,
  }));
  process.exit(0);
}

const row = (vendor, tag, w, s, extra = '') => console.log(`  ${vendor.padEnd(7)}${`${tag}${w.label}`.padEnd(34)}${String(w.used).padStart(3)}% used  resets ${fmt(w.resetsAt)}`
  + `${s?.projected != null ? `  → ${s.projected}% at reset (${s.basis})` : ''}${w.scoped ? '  (one model only)' : ''}${extra}`);
console.log(`quota (read ${fmt(data.checkedAt)}, ${Math.round((Date.now() - data.checkedAt) / 60000)}m ago)`);
const cw = weekly(data.claude);
for (const w of data.claude ?? []) row('claude', '', w, w === cw ? st.claude.week : winState(w, null));
if (!data.claude) console.log(`  claude unavailable: ${data.errors.claude ?? 'unknown error'}`);
for (const r of st.codex.rows) {
  const tag = `${r.a.name}${r.a.email ? ` ${r.a.email}` : ''} `;
  if (!r.a.windows) { console.log(`  codex  ${tag}unavailable (${r.a.error ?? '?'})`); continue; }
  if (r.unconstrained) console.log(`  codex  ${tag}no limit windows (unconstrained)`);
  const ww = weekly(r.a.windows);
  for (const w of r.a.windows) row('codex', tag, w, w === ww ? r.s : null, r.a.live ? '' : `  [from ${fmtAgo(r.a.seenAt)}]`);
  if (r.a.resets) console.log(`  codex  ${tag}reset cards: ${r.a.resets.count}${r.a.resets.credits.length ? ` (expire ${r.a.resets.credits.map((c) => fmt(c.expiresAt)).join(', ')})` : ''}`);
}
if (!data.codexAccounts) console.log(`  codex  unavailable: ${data.errors.codex ?? 'unknown error'}`);
console.log(`budget: claude ${st.claude.status} (now: spare ≤${st.claude.spareLine}%, cap ${st.claude.cap}%, ${st.claude.reserve ?? '?'}% kept for orchestration until the reset); `
  + `codex ${st.codex.out ? 'out' : st.codex.rotate ? `→ rotate ${st.codex.rotate.map((r) => r.a.name).join('/')}` : st.codex.pick ? `→ ${st.codex.pick.a.name}` : st.codex.redeem ? `→ redeem a card on ${st.codex.redeem.a.name}` : 'unreadable'}${st.codex.underused ? ', underused' : ''}${st.codex.overspending ? ', overspending' : ''}`
  + `${st.codex.cardsHeld ? `, ${st.codex.cardsHeld} reset card(s)` : ''}`);
for (const l of lean) console.log(`lean: ${l}`);
