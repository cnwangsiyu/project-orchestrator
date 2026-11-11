#!/usr/bin/env node
// review-data: the facts the nightly routing review starts from, for the last N hours (default 24).
//
//   review-data [--hours N] [--json] [--save-catalog]
//
// Sections: routing decisions (route-log.jsonl), quota and reset-card waste (quota-log.jsonl), the current lean, and the
// model catalog compared with the last saved snapshot (--save-catalog stores today's as the new baseline).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SHARED, ROUTE_LOG, QUOTA_LOG, readState, analyze, leanLines, fmt, outcomeOwns, isReviewDecision, dedupeOutcomes, codexCatalog, readProfiles, compareHarness, harnessDrift, modelView } from './lib/state.mjs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const H = Number(opt('hours') ?? 24), since = Date.now() - H * 3600000;
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const count = (xs, key) => xs.reduce((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});

// ---- routing ----
const all = lines(ROUTE_LOG);
const routes = all.filter((r) => r.t >= since && r.kind !== 'outcome');
// Outcomes (outcome.mjs): first-pass rate, rework rounds and time per vendor / model / category of the first attempt.
// Older records said `pass` with fix rounds; outcome.mjs now records those as rework, so read them the same way.
// A task recorded more than once counts once (dedupeOutcomes: latest result, most rounds), placed at its latest record.
const outs = dedupeOutcomes(all.filter((r) => r.kind === 'outcome')).filter((r) => r.t >= since).map((o) => (o.result === 'pass' && o.rounds > 0 ? { ...o, result: 'rework' } : o));
const mouts = outs.map(modelView);
const agg = (key, list = outs) => {
  const m = {};
  for (const o of list) {
    const k = key(o); if (!k) continue;
    const a = (m[k] ??= { tasks: 0, pass: 0, rework: 0, fail: 0, reviewed: 0, rounds: [], minutes: [] });
    a.tasks++; a[o.result]++; if (o.reviewed) a.reviewed++;
    if (o.rounds != null) a.rounds.push(o.rounds); if (o.minutes != null) a.minutes.push(o.minutes);
  }
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  return Object.fromEntries(Object.entries(m).map(([k, a]) => [k, { tasks: a.tasks, firstPass: `${a.pass}/${a.tasks}`, rework: a.rework, fail: a.fail,
    reviewed: a.reviewed, meanRounds: mean(a.rounds), meanMinutes: mean(a.minutes) }]));
};
const outcomes = {
  recorded: outs.length,
  // Tasks with more than one outcome record (merged above): remind their orchestrator to record each task once, at close.
  duplicates: outs.filter((o) => o.dupes > 1).map((o) => `${o.project}/${o.name} ×${o.dupes}`),
  // Per vendor/model: code rework only (modelView). Per category/impact/cause: all rework.
  byVendor: agg((o) => o.first?.vendor, mouts), byModel: agg((o) => o.first && `${o.first.vendor}:${o.first.model}:${o.first.effort}`, mouts),
  byCategory: agg((o) => o.category), byVendorCategory: agg((o) => o.first && o.category && `${o.first.vendor}:${o.category}`, mouts),
  byImpact: agg((o) => o.impact),
  byCause: agg((o) => (o.result === 'rework' ? o.cause ?? '(not recorded)' : null)),
  infraRetries: outs.reduce((n, o) => n + (o.retries ?? 0), 0), scopeChanges: outs.reduce((n, o) => n + (o.scopeChanges ?? 0), 0),
  reworkWithoutCause: outs.filter((o) => o.result === 'rework' && !o.cause).map((o) => `${o.project}/${o.name}`).slice(0, 30),
  // TRAE CLI vs native Codex with the same model (user, 2026-11-08); the nightly review reads it with --hours 168 and
  // all-time (--hours 100000) as samples grow.
  traeVsCodex: compareHarness(mouts, readProfiles()),
  // Fallback models on the company account (route.mjs ALTS, user 2026-11-10: "每晚复盘可以看看是否需要调整"): how often
  // they ran and why, how their tasks ended, and the extra reviews of their service code — what those reviews caught
  // (task ended in rework) versus passed clean. Inputs for keeping, reordering or relaxing the fallback rules.
  fallbackModels: (() => {
    const fb = routes.filter((r) => r.pick?.vendor === 'codex' && r.pick.model && !/^gpt-/.test(r.pick.model) && !isReviewDecision(r));
    const reason = (r) => ((r.why ?? []).some((w) => /its fallback models:/.test(w)) ? 'gpt-out' : (r.failures ?? 0) > 0 ? 'after-sol-fell-short' : 'other');
    const count = (xs, k) => xs.reduce((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});
    const ended = (r) => outs.find((o) => outcomeOwns(o.project, o.name, r)) ?? null;
    const extra = fb.filter((r) => (r.why ?? []).some((w) => /is a fallback model: its service code gets a review/.test(w)));
    const ex = extra.map((r) => ({ task: `${r.project}/${r.name}`, model: r.pick.model, outcome: ended(r)?.result ?? '(none yet)', rounds: ended(r)?.rounds ?? null, cause: ended(r)?.cause ?? null }));
    return {
      launches: fb.length, byModel: count(fb, (r) => r.pick.model), byReason: count(fb, reason),
      outcomes: count(fb.map(ended).filter(Boolean), (o) => o.result),
      extraReviews: { count: extra.length, caught: ex.filter((e) => e.outcome === 'rework' || e.outcome === 'fail').length, clean: ex.filter((e) => e.outcome === 'pass').length, tasks: ex.slice(0, 30) },
      reviewSecondOpinions: count(routes.filter((r) => isReviewDecision(r) && r.pick?.model && !/^gpt-/.test(r.pick.model) && r.pick.vendor === 'codex'), (r) => r.pick.model),
    };
  })(),
  // The fair vendor comparison: reviewed release work only (the only work every vendor's output is judged the same way).
  reviewedReleaseByVendor: agg((o) => o.reviewed && o.impact === 'release' && o.first?.vendor, mouts),
  fails: outs.filter((o) => o.result === 'fail').map((o) => ({ project: o.project, name: o.name, category: o.category, first: o.first, note: o.note })),
  // Outcomes recorded under a review's name (NAME-R): the reviewed task's own outcome is what counts.
  reviewOutcomes: outs.filter((o) => !o.first && all.some((r) => r.kind !== 'outcome' && isReviewDecision(r) && outcomeOwns(o.project, o.name, r))).map((o) => `${o.project}/${o.name}`),
  unjoined: outs.filter((o) => !o.first && !all.some((r) => r.kind !== 'outcome' && isReviewDecision(r) && outcomeOwns(o.project, o.name, r))).map((o) => `${o.project}/${o.name}`),
  // Finished-looking tasks with routing decisions but no outcome yet (named, older than a day): remind the orchestrator.
  // Uses outcome.mjs's join; reviews need no outcome, and fix rounds (NAME-fix1, NAME-r2) fold into their task.
  missing: [...new Set(all.filter((r) => r.kind !== 'outcome' && r.name && r.project && !isReviewDecision(r) && r.t < Date.now() - 86400000 && r.t >= since - 6 * 86400000)
    .filter((r) => !all.some((o) => o.kind === 'outcome' && outcomeOwns(o.project, o.name, r)))
    .map((r) => `${r.project}/${r.name.replace(/-(fix|r)\d+$/, '')}`))].slice(0, 30),
};
const routing = {
  decisions: routes.length,
  byProject: count(routes, (r) => r.project ?? '(none)'),
  byCategory: count(routes, (r) => r.category),
  byPick: count(routes.filter((r) => r.pick), (r) => `${r.pick.vendor}:${r.pick.model}:${r.pick.effort}`),
  byAccount: count(routes.filter((r) => r.pick?.account), (r) => r.pick.account),
  deferred: routes.filter((r) => r.deferred).map((r) => ({ t: fmt(r.t), project: r.project, category: r.category, why: r.deferred })),
  escalations: routes.filter((r) => r.failures > 0).map((r) => ({ t: fmt(r.t), project: r.project, name: r.name, category: r.category, failures: r.failures, pick: r.pick })),
  tellUser: routes.filter((r) => r.tell?.length).map((r) => ({ t: fmt(r.t), project: r.project, name: r.name, tell: r.tell })),
  needsOK: routes.filter((r) => r.needsOK?.length).map((r) => ({ t: fmt(r.t), project: r.project, category: r.category, needsOK: r.needsOK })),
  withoutProject: routes.filter((r) => !r.project).length,
};

// ---- quota: what each week reset threw away, and which cards expired unused ----
const snaps = lines(QUOTA_LOG).sort((a, b) => a.t - b.t);
const resets = [], cardsExpired = [], cardsRedeemed = [];
const track = (key, get) => {
  let prev = null;
  for (const s of snaps) {
    const cur = get(s);
    if (!cur || cur.resetsAt == null) continue;
    if (prev && Math.abs(cur.resetsAt - prev.resetsAt) > 3600000 && s.t >= since) {
      // The window rolled over (natural reset) or restarted early (a redeemed card): what was left is gone or reused.
      const natural = prev.resetsAt <= s.t + 600000;
      resets.push({ who: key, at: fmt(natural ? prev.resetsAt : s.t), kind: natural ? 'natural reset' : 'early restart (card)', usedBefore: prev.used, unused: Math.max(0, 100 - prev.used) });
    }
    prev = cur;
  }
};
track('claude', (s) => s.claude);
const names = [...new Set(snaps.flatMap((s) => (s.codex ?? []).map((a) => a.name)))];
for (const n of names) track(`codex:${n}`, (s) => (s.codex ?? []).find((a) => a.name === n));
for (const n of names) {
  const seen = new Map(); // card id → { expiresAt, lastSeen }
  for (const s of snaps) for (const a of (s.codex ?? []).filter((x) => x.name === n)) {
    const ids = new Set(a.cards.map((c) => c.id));
    for (const c of a.cards) seen.set(c.id, { expiresAt: c.expiresAt, lastSeen: s.t });
    for (const [id, v] of seen) if (!ids.has(id) && !v.gone) {
      v.gone = s.t;
      if (s.t < since) continue;
      if (v.expiresAt && v.expiresAt <= s.t) cardsExpired.push({ account: n, card: id.slice(-8), expiredAt: fmt(v.expiresAt) });
      else cardsRedeemed.push({ account: n, card: id.slice(-8), at: fmt(s.t) });
    }
  }
}
const quota = { snapshots: snaps.filter((s) => s.t >= since).length, resets, cardsExpired, cardsRedeemed };

// ---- now ----
const data = readState();
const st = analyze(data);
const now = { lean: leanLines(st, data), claude: st.claude.status, codex: st.codex.rows.map((r) => ({ name: r.a.name, live: r.a.live, week: r.s?.used ?? null, resetsIn: r.s?.left != null ? `${Math.round(r.s.left)}h` : null, cards: r.a.resets?.count ?? null })) };

// ---- model catalog ----
const CATALOG = path.join(SHARED, 'model-catalog.json');
// Always main's catalog, whatever CODEX_HOME the caller runs under (codexCatalog says why).
const { home: _catalogHome, ...codexNow } = codexCatalog();
const catalogNow = { codex: [], claude: [], ...codexNow };
try {
  const help = execFileSync('claude', ['--help'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  const modelHelp = (help.match(/--model <model>[\s\S]*?(?=\n\s+-[-\w])/) ?? [''])[0]; // just the --model option's text
  catalogNow.claude = [...new Set((modelHelp.match(/'([a-z0-9.\[\]-]+)'/g) ?? []).map((x) => x.slice(1, -1)))];
  catalogNow.claudeVersion = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
} catch (e) { catalogNow.claudeError = String(e.message).split('\n')[0]; }
let prevCat = null; try { prevCat = JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch {}
const slugs = (c) => new Set((c?.codex ?? []).map((m) => m.slug));
const catalog = {
  codexAdded: [...slugs(catalogNow)].filter((x) => prevCat && !slugs(prevCat).has(x)),
  codexRemoved: [...slugs(prevCat)].filter((x) => !slugs(catalogNow).has(x)),
  claudeAliases: catalogNow.claude, claudeVersion: catalogNow.claudeVersion ?? null, baseline: prevCat ? fmt(prevCat.savedAt) : 'none (run with --save-catalog)',
};
if (opt('save-catalog')) fs.writeFileSync(CATALOG, JSON.stringify({ ...catalogNow, savedAt: Date.now() }, null, 1));

catalog.harnessDrift = harnessDrift();
const result = { hours: H, routing, outcomes, quota, now, catalog };
if (opt('json')) { console.log(JSON.stringify(result, null, 1)); process.exit(0); }
const show = (title, v) => console.log(`\n## ${title}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`);
console.log(`# routing review data — last ${H}h (to ${fmt(Date.now())})`);
show('routing', routing);
show('outcomes (first attempt\'s vendor/model/category)', outcomes);
show('quota and cards', quota);
show('now', now);
show('model catalog', catalog);
