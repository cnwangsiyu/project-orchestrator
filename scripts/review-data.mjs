#!/usr/bin/env node
import {mandatoryReview,projectReviewPolicy,reviewYield} from './lib/review-policy-data.mjs';
// review-data: the facts the nightly routing review starts from, for the last N hours (default 24).
//
//   review-data [--hours N] [--json] [--save-catalog]
//
// Sections: routing decisions (route-log.jsonl), quota and reset-card waste (quota-log.jsonl), the current lean, and the
// model catalog compared with the last saved snapshot (--save-catalog stores today's as the new baseline).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { SHARED, ROUTE_LOG, QUOTA_LOG, readState, analyze, leanLines, fmt, outcomeOwns, isReviewDecision, dedupeOutcomes, codexCatalog, readProfiles, compareHarness, harnessDrift, modelView, effectiveFirst, OUTCOME_OVERRIDES } from './lib/state.mjs';
import { loadDigest, isRouteDecision, rulesShared } from './lib/global-rules.mjs';
import { auditGlobalRules } from './lib/global-rules-audit.mjs';
import { LOG as RESOURCE_LOG, readJsonl } from './lib/resource-data.mjs';
import { review as resourceReview } from './resource-review.mjs';
import { utilisationLines } from './lib/resource-utilisation.mjs';
import { ETA, median } from './lib/eta.mjs';
import { checkResidents } from './resident-check.mjs';
import { auditWorkerEvents, readEvents } from './lib/worker-events.mjs';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const H = Number(opt('hours') ?? 24), since = Date.now() - H * 3600000;
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const count = (xs, key) => xs.reduce((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const pct = (n, d) => d ? Math.round(n / d * 1000) / 10 : null;
const bareName = (project, name = '') => name.startsWith(`${project}-`) ? name.slice(project.length + 1) : name;
const reviewBase = (r) => bareName(r.project ?? '', r.name ?? '')
  .replace(/-(?:re-?review|rereview)(?:-?\d+)?$/i, '')
  .replace(/-(?:review|r)(?:-?\d+)?$/i, '');
const namedReReview = (name = '') => /-(?:re-?review|rereview)(?:-?\d+)?$|-(?:review|r)-?([2-9]\d*)$/i.test(name);
const requiredReview=mandatoryReview;
const yieldFrom=reviewYield;
const reviewProfiles=JSON.parse(fs.readFileSync(new URL('../references/project-risk-profiles.json',import.meta.url),'utf8'));

// ---- routing ----
const all = lines(ROUTE_LOG);
const routes = all.filter((r) => r.t >= since && isRouteDecision(r));
// Outcomes (outcome.mjs): first-pass rate, rework rounds and time per vendor / model / category of the first attempt.
// Older records said `pass` with fix rounds; outcome.mjs now records those as rework, so read them the same way.
// A task counts once: normal records merge, then explicit corrections override supplied fields.
const allOuts = dedupeOutcomes(all.filter((r) => r.kind === 'outcome'))
  .map((o) => (o.result === 'pass' && o.rounds > 0 ? { ...o, result: 'rework' } : o));
const outs = allOuts.filter((r) => (r.completedAt ?? r.t) >= since);
const mouts = outs.map(modelView);
const correctedValues = (o) => Object.fromEntries(OUTCOME_OVERRIDES.filter((f) => Object.hasOwn(o, f)).map((f) => [f, o[f]]));
const samePick = (a, b) => ['vendor', 'model', 'effort', 'account'].every((f) => (a?.[f] ?? null) === (b?.[f] ?? null));
const agg = (key, list = outs) => {
  const m = {};
  for (const o of list) {
    const k = key(o); if (!k) continue;
    const a = (m[k] ??= { tasks: 0, pass: 0, rework: 0, nonCodeRework: 0, fail: 0, reviewed: 0, rounds: [], minutes: [] });
    a.tasks++; a[o.nonCodeRework ? 'nonCodeRework' : o.result]++; if (o.reviewed) a.reviewed++;
    if (o.rounds != null) a.rounds.push(o.rounds); if (o.minutes != null) a.minutes.push(o.minutes);
  }
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  return Object.fromEntries(Object.entries(m).map(([k, a]) => [k, { tasks: a.tasks, firstPass: `${a.pass}/${a.tasks}`, rework: a.rework, nonCodeRework: a.nonCodeRework, fail: a.fail,
    reviewed: a.reviewed, meanRounds: mean(a.rounds), meanMinutes: mean(a.minutes) }]));
};
const outcomes = {
  recorded: outs.length,
  // Tasks with more than one outcome record (merged above): remind their orchestrator to record each task once, at close.
  duplicates: outs.filter((o) => o.dupes > 1).map((o) => `${o.project}/${o.name} ×${o.dupes}`),
  corrected: allOuts.filter(o => o.correctedAt >= since).map((o) => ({ task: `${o.project}/${o.name}`, completedAt: o.completedAt, correctedAt: o.correctedAt, from: o.correctionFrom, to: correctedValues(o) })),
  corrections: all.filter(o => o.kind === 'outcome' && o.correction && o.t >= since).length,
  actualMismatches: outs.filter((o) => o.actual?.length && !samePick(o.first, effectiveFirst(o)))
    .map((o) => ({ task: `${o.project}/${o.name}`, joined: o.first ?? null, actual: effectiveFirst(o) })),
  // Per vendor/model: code rework only (modelView). Per category/impact/cause: all rework.
  byVendor: agg((o) => effectiveFirst(o)?.vendor, mouts), byModel: agg((o) => { const p = effectiveFirst(o); return p && `${p.vendor}:${p.model}:${p.effort}`; }, mouts),
  byModelAccount: agg((o) => { const p = effectiveFirst(o); return p && `${p.vendor}:${p.model}:${p.effort}@${p.account ?? '?'}`; }, mouts),
  byCategory: agg((o) => o.category), byVendorCategory: agg((o) => effectiveFirst(o) && o.category && `${effectiveFirst(o).vendor}:${o.category}`, mouts),
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
    const ex = extra.map((r) => ({ task: `${r.project}/${r.name}`, model: r.pick.model, outcome: ended(r)?.result ?? '(none yet)', rounds: ended(r)?.rounds ?? null, cause: ended(r)?.cause ?? null, actual: ended(r)?.actual ?? null }));
    return {
      decisions: fb.length, byModel: count(fb, (r) => r.pick.model), byReason: count(fb, reason),
      outcomes: count(fb.map(ended).filter(Boolean), (o) => o.result),
      extraReviews: { count: extra.length, caught: ex.filter((e) => e.outcome === 'rework' || e.outcome === 'fail').length, clean: ex.filter((e) => e.outcome === 'pass').length, tasks: ex.slice(0, 30) },
      reviewSecondOpinions: count(routes.filter((r) => isReviewDecision(r) && r.pick?.model && !/^gpt-/.test(r.pick.model) && r.pick.vendor === 'codex'), (r) => r.pick.model),
    };
  })(),
  // The fair vendor comparison: reviewed release work only (the only work every vendor's output is judged the same way).
  reviewedReleaseByVendor: agg((o) => o.reviewed && o.impact === 'release' && effectiveFirst(o)?.vendor, mouts),
  fails: outs.filter((o) => o.result === 'fail').map((o) => ({ project: o.project, name: o.name, category: o.category, first: o.first, actual: o.actual ?? null, note: o.note })),
  // Outcomes recorded under a review's name (NAME-R): the reviewed task's own outcome is what counts.
  reviewOutcomes: outs.filter((o) => !effectiveFirst(o) && all.some((r) => r.kind !== 'outcome' && isReviewDecision(r) && outcomeOwns(o.project, o.name, r))).map((o) => `${o.project}/${o.name}`),
  unjoined: outs.filter((o) => !effectiveFirst(o) && !all.some((r) => r.kind !== 'outcome' && isReviewDecision(r) && outcomeOwns(o.project, o.name, r))).map((o) => `${o.project}/${o.name}`),
  // Finished-looking tasks with routing decisions but no outcome yet (named, older than a day): remind the orchestrator.
  // Uses outcome.mjs's join; reviews need no outcome, and fix rounds (NAME-fix1, NAME-r2) fold into their task.
  missing: [...new Set(all.filter((r) => isRouteDecision(r) && r.name && r.project && !isReviewDecision(r) && r.t < Date.now() - 86400000 && r.t >= since - 6 * 86400000)
    .filter((r) => !all.some((o) => o.kind === 'outcome' && outcomeOwns(o.project, o.name, r)))
    .map((r) => `${r.project}/${r.name.replace(/-(fix|r)\d+$/, '')}`))].slice(0, 30),
};
// Count tasks once across dispatches; use recorded end-to-end minutes (queue time included), never infer missing time.
const background = (() => {
  const tasks = new Map();
  for (const r of routes.filter((r) => r.background && r.project && r.name && !isReviewDecision(r))) {
    const ended = outs.find((o) => outcomeOwns(o.project, o.name, r));
    const name = ended?.name ?? r.name;
    const bareName = name.startsWith(`${r.project}-`) ? name.slice(r.project.length + 1) : name;
    const key = `${r.project}/${bareName.replace(/-(fix|r)\d+$/, '')}`;
    tasks.set(key, { task: key, minutes: ended?.minutes ?? null, result: ended?.result ?? null });
  }
  // Include recently completed background work even when its dispatch is outside this report's window.
  for (const o of outs) if (all.some((r) => r.kind !== 'outcome' && r.background && !isReviewDecision(r) && outcomeOwns(o.project, o.name, r))) {
    const name = o.name.startsWith(`${o.project}-`) ? o.name.slice(o.project.length + 1) : o.name;
    tasks.set(`${o.project}/${name}`, { task: `${o.project}/${name}`, minutes: o.minutes ?? null, result: o.result });
  }
  const rows = [...tasks.values()], minutes = rows.map((r) => r.minutes).filter((m) => m != null);
  const totalMinutes = minutes.reduce((n, m) => n + m, 0);
  return { tasks: rows.length, completed: rows.filter((r) => r.result).length, timed: minutes.length,
    totalMinutes, meanMinutes: minutes.length ? Math.round(totalMinutes / minutes.length * 10) / 10 : null };
})();
// Review launches are dispatches, including an embedded second reviewer. A route with a primary plus `second` is two
// dispatches and two review launches when the primary itself is a review. Re-review is a round property, so both
// reviewers in that later round carry it; a second reviewer does not manufacture an extra round.
const reviewLaunches = (() => {
  const rows = all.filter(isRouteDecision).filter((r) => r.pick).sort((a, b) => a.t - b.t);
  const seen = new Map(), launches = [];
  const outcomeEvidence = (r, base) => {
    const own=allOuts.filter(o=>o.project===r.project);
    const exact=own.filter(o=>bareName(o.project??'',o.name??'')===bareName(r.project??'',r.name??''));
    return exact.length?exact:own.filter(o=>!isReviewDecision(o)&&bareName(o.project??'',o.name??'')===base);
  };
  for (const r of rows) {
    const base = reviewBase(r), key = `${r.project ?? '(none)'}/${base || r.name || '(unnamed)'}`;
    const primaryReview = isReviewDecision(r);
    const reReview = primaryReview && (namedReReview(r.name) || (seen.get(key) ?? 0) > 0);
    const evidence = [...outcomeEvidence(r,base).map(o=>o.reviewResult),r.reviewResult, r.reviewOutcome, r.findings, r.note, r.outcomeNote,
      ...outcomeEvidence(r, base).flatMap((o) => [o.note, o.notes, o.findings, o.reviewResult])];
    if (primaryReview) launches.push({ t: r.t, project: r.project ?? '(none)', task: key, category: r.category,
      secondReviewer: false, reReview, required: requiredReview(r), yield: yieldFrom(evidence) });
    if (r.second) launches.push({ t: r.t, project: r.project ?? '(none)', task: key, category: r.category,
      secondReviewer: true, reReview, required: requiredReview(r), yield: yieldFrom([r.secondReviewResult, r.secondFindings]) });
    if (primaryReview) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return launches;
})();
const reviewWindow = (windowSince) => {
  const decisions = all.filter((r) => r.t >= windowSince && isRouteDecision(r) && r.pick);
  const launches = reviewLaunches.filter((r) => r.t >= windowSince);
  const dispatches = decisions.length + decisions.filter((r) => r.second).length;
  const summarize = (rs, ds, targetPct=null) => {
    const byTask = count(rs, (r) => r.task);
    const found = rs.filter((r) => r.yield === 'found-p0-p1').length, none = rs.filter((r) => r.yield === 'none').length;
    return { dispatches: ds, reviews: rs.length, reviewSharePct: pct(rs.length, ds), targetPct,targetExcluded:targetPct===null,overBudget:targetPct===null?null:ds>0&&rs.length/ds>targetPct/100,
      requiredReviews: rs.filter((r) => r.required).length, requiredReviewSharePct: pct(rs.filter((r) => r.required).length, ds),
      secondReviewers: rs.filter((r) => r.secondReviewer).length, secondReviewerSharePct: pct(rs.filter((r) => r.secondReviewer).length, rs.length),
      reReviews: rs.filter((r) => r.reReview).length, reReviewSharePct: pct(rs.filter((r) => r.reReview).length, rs.length),
      reviewsPerTask: byTask, tasksAtLeast3: Object.entries(byTask).filter(([, n]) => n >= 3).map(([task, reviews]) => ({ task, reviews })),
      yield: { foundP0P1:found,blocking:found,none,unknown:rs.length-found-none,known:found+none,blockingRatePct:pct(found,found+none) } };
  };
  const projects = [...new Set(decisions.map((r) => r.project ?? '(none)').concat(launches.map((r) => r.project)))];
  const byProject = Object.fromEntries(projects.map((project) => {
    const pd = decisions.filter((r) => (r.project ?? '(none)') === project);
    return [project, summarize(launches.filter((r) => r.project === project), pd.length + pd.filter((r) => r.second).length,projectReviewPolicy(project,reviewProfiles).reviewTargetPct)];
  }));
  const dayKeys = [...new Set(decisions.map((r) => `${new Date(r.t).toISOString().slice(0, 10)}\0${r.project ?? '(none)'}`))];
  const byProjectDay = Object.fromEntries(dayKeys.map((key) => {
    const [day, project] = key.split('\0');
    const pd = decisions.filter((r) => new Date(r.t).toISOString().startsWith(day) && (r.project ?? '(none)') === project);
    const pr = launches.filter((r) => new Date(r.t).toISOString().startsWith(day) && r.project === project);
    return [`${day}/${project}`, summarize(pr, pd.length + pd.filter((r) => r.second).length,projectReviewPolicy(project,reviewProfiles).reviewTargetPct)];
  }));
  const noReviewProjects=Object.fromEntries(projects.filter(project=>projectReviewPolicy(project,reviewProfiles).profile==='no-review').map(project=>[project,{dispatches:byProject[project].dispatches,reviews:byProject[project].reviews}]));
  return { ...summarize(launches, dispatches), byProject, byProjectDay,noReviewProjects };
};
const reviewBudget = {
  policyLimitPct:null,projectTargets:Object.fromEntries(Object.entries(reviewProfiles).filter(([p])=>!['default','profiles'].includes(p)).map(([p])=>[p,projectReviewPolicy(p,reviewProfiles).reviewTargetPct])),
  window: { hours: H, ...reviewWindow(since) },
  rolling24h: reviewWindow(Date.now() - 24 * 3600000),
  rolling7d: reviewWindow(Date.now() - 7 * 86400000),
  evidenceBasis: 'routing decisions (planned dispatches), not proven worker launches',
  note: 'Each primary, second reviewer and re-review decision is one planned dispatch. UTC project-days; UNKNOWN review yield means no explicit P0/P1 result was recorded.',
};
const routing = {
  automaticReroutes: (() => {
    const hops = all.filter((r) => r.kind === 'reroute' && r.automatic && r.t >= since);
    const rows = hops.map((r) => {
      const launch = all.find((l) => l.kind === 'launch' && l.t >= r.t && l.name === r.name
        && l.account === r.to?.account && String(l.model).toLowerCase() === String(r.to?.model).toLowerCase());
      const firstEvent = launch && all.find((l) => l.kind === 'reroute-progress' && l.hopAt === r.t);
      const startMin = firstEvent ? Math.max(0, (firstEvent.t - r.t) / 60000) : null;
      return { t: r.t, project: r.project, name: r.name, reason: r.reason, from: r.from, to: r.to,
        waitedMin: r.from?.waitedMin ?? null, startMin, estimateMin: r.toStartEstimateMin ?? null,
        faster: startMin != null && r.from?.predictedStartMin != null ? startMin < r.from.predictedStartMin : null };
    });
    return { count: rows.length, totalWaitedMin: rows.reduce((n, r) => n + (r.waitedMin ?? 0), 0),
      faster: rows.filter((r) => r.faster === true).length, slower: rows.filter((r) => r.faster === false).length,
      unknown: rows.filter((r) => r.faster == null).length, recent: rows.slice(-30) };
  })(),
  eta: {
    constants: ETA,
    byCategoryEffort: Object.fromEntries([...new Set(outs.map((o) => `${o.category}:${effectiveFirst(o)?.effort ?? '?'}`))]
      .map((key) => {
        const timed = outs.filter((o) => `${o.category}:${effectiveFirst(o)?.effort ?? '?'}` === key
          && Number.isFinite(o.minutes) && o.minutes > 0);
        return [key, { samples: timed.length, medianMinutes: median(timed.map((o) => o.minutes)),
          usable: timed.length >= ETA.historyMin }];
      })),
  },
  decisions: routes.length,
  companyPolicies: { balanced: routes.filter((r) => r.balance?.selected).length, background: routes.filter((r) => r.background).length,
    decisions: routes.filter((r) => r.company || r.balance || r.background).map((r) => ({ t: r.t, project: r.project, name: r.name,
      category: r.category, pick: r.pick, background: !!r.background, why: r.why ?? [], balance: r.balance ?? null })) },
  byProject: count(routes, (r) => r.project ?? '(none)'),
  byCategory: count(routes, (r) => r.category),
  byPick: count(routes.filter((r) => r.pick), (r) => `${r.pick.vendor}:${r.pick.model}:${r.pick.effort}`),
  byAccount: count(routes.filter((r) => r.pick?.account), (r) => r.pick.account),
  signing: routes.filter((r) => r.signing).map((r) => ({ t: fmt(r.t), project: r.project, name: r.name,
    category: r.category, pick: r.pick })),
  // OpenAI cyberPolicy blocks (codex-worker kind:'policy-block', 2026-11-13): how often, and on which account/model.
  // Repeated hits mean that model/account should not be used for attack-style reviews; route those with --adversarial.
  policyBlocks: (() => {
    const rows = all.filter((r) => r.kind === 'policy-block' && r.t >= since);
    return { count: rows.length, byAccountModel: count(rows, (r) => `${r.account ?? '?'}:${r.model ?? '?'}`),
      recent: rows.slice(-30).map((r) => ({ t: fmt(r.t), account: r.account, vendor: r.vendor, model: r.model })) };
  })(),
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
    if (prev && cur.resetsAt - prev.resetsAt > 3600000 && s.t >= since) {
      // An idle window's deadline can move with the snapshot time (b, 2026-11-10, 0% with the same two cards).
      // A future deadline moving is not a card restart: require an unexpired card to disappear. Backward corrections
      // are not resets either. Keep natural rollovers, and prefer actual card evidence near the old deadline.
      const natural = prev.resetsAt <= s.t + 600000;
      const redeemed = Array.isArray(prev.cards) && Array.isArray(cur.cards)
        && prev.cards.some((c) => (!c.expiresAt || c.expiresAt > s.t) && !cur.cards.some((d) => d.id === c.id));
      if (redeemed || natural) resets.push({ who: key, at: fmt(redeemed ? s.t : prev.resetsAt), kind: redeemed ? 'early restart (card)' : 'natural reset', usedBefore: prev.used, unused: Math.max(0, 100 - prev.used) });
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
const quota = { snapshots: snaps.filter((s) => s.t >= since).length, resets, cardsExpired, cardsRedeemed,
  // Preserve observations within each UTC hour: averages would hide congestion peaks and quota resets.
  companyByHour: snaps.filter((s) => s.t >= since && (s.ttadk || s.trae)).reduce((by, s) => {
    const hour = new Date(s.t).toISOString().slice(0, 13) + ':00:00Z';
    (by[hour] ??= []).push({ t: s.t, ttadk: s.ttadk ?? null, trae: s.trae ?? null }); return by;
  }, {}) };

// Standard public API prices per 1M tokens, captured from developers.openai.com/api/docs/pricing on 2026-11-14.
// TRAE units are not dollars; pricing the observed session tokens merely lets the nightly review reconcile whether a
// reset window looks dollar-like and how much of it the retained session telemetry can explain.
const TRAE_PUBLIC_PRICES = {
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cachedInput: .1, output: 10 },
  'gpt-5.6-sol': { input: 4, cachedInput: .4, output: 20 },
};
const canonicalModel = (model) => String(model ?? '').trim().toLowerCase();
const tokenNumbers = (u) => u && ({ input: Number(u.input_tokens ?? u.inputTokens ?? 0),
  cached: Number(u.cached_input_tokens ?? u.cachedInputTokens ?? 0), output: Number(u.output_tokens ?? u.outputTokens ?? 0) });
const validTokens = (u) => u && [u.input, u.cached, u.output].every((n) => Number.isFinite(n) && n >= 0);
const traeSessionFiles = (root, cutoff) => {
  const out = [], stack = [root];
  while (stack.length && out.length < 20000) {
    const dir = stack.pop(); let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).mtimeMs >= cutoff) out.push(p); } catch {}
      }
    }
  }
  return out;
};
const readTraeTokenEvents = async (root, cutoff) => {
  const events = [], errors = [];
  const files = traeSessionFiles(root, cutoff);
  for (const file of files) {
    let model = null, prev = { input: 0, cached: 0, output: 0 };
    try {
      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!/token|turn_context|contextUsage/.test(line)) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        const p = row.payload ?? {}, params = row.params ?? {};
        model = canonicalModel(p.model ?? p.context?.model ?? params.context?.contextUsage?.model ?? model);
        const raw = p.type === 'token_count' ? p.info?.total_token_usage : params.tokenUsage?.total;
        const total = tokenNumbers(raw);
        if (!validTokens(total) || !model) continue;
        const sampled = params.context?.contextUsage?.sampledAt;
        const t = Number.isFinite(Number(sampled)) ? Number(sampled) * 1000 : Date.parse(row.timestamp ?? '');
        const reset = total.input < prev.input || total.cached < prev.cached || total.output < prev.output;
        const from = reset ? { input: 0, cached: 0, output: 0 } : prev;
        const delta = { input: total.input - from.input, cached: total.cached - from.cached, output: total.output - from.output };
        prev = total;
        if (Number.isFinite(t) && t >= cutoff && delta.input + delta.output > 0) events.push({ t, model, ...delta });
      }
    } catch (e) { errors.push(`${path.basename(file)}: ${String(e.message).split('\n')[0]}`); }
  }
  return { events, files: files.length, errors: errors.slice(0, 20) };
};
const traeReconciliation = async () => {
  const readings = [];
  for (const s of snaps) {
    const daily = s.trae?.daily ?? s.trae?.quota?.daily;
    if (!daily || typeof daily !== 'object') continue;
    for (const [rawModel, q] of Object.entries(daily)) {
      let reset = Number(q?.resetsAt ?? q?.resetTime); if (reset > 0 && reset < 1e12) reset *= 1000;
      const used = Number(q?.used ?? q?.quotaUsed), sampledAt = Number(s.trae?.sampledAt ?? s.t);
      if (!Number.isFinite(reset) || !Number.isFinite(used) || !Number.isFinite(sampledAt)) continue;
      readings.push({ model: canonicalModel(rawModel), reset, used, t: sampledAt });
    }
  }
  if (!readings.length) return { windows: [], status: 'UNKNOWN', reason: 'no TRAE per-model quota readings', prices: TRAE_PUBLIC_PRICES };
  const earliest = Math.min(...readings.map((r) => r.reset - 86400000), since) - 3600000;
  const profiles = readProfiles(), traeHome = profiles.trae?.home ?? path.join(os.homedir(), '.trae', 'cli');
  const sessionRoot = process.env.TRAE_SESSIONS_DIR || path.join(traeHome, 'sessions');
  const telemetry = await readTraeTokenEvents(sessionRoot, earliest);
  const groups = new Map();
  for (const r of readings) (groups.get(`${r.model}\0${r.reset}`) ?? (groups.set(`${r.model}\0${r.reset}`, []), groups.get(`${r.model}\0${r.reset}`))).push(r);
  const windows = [];
  for (const rs of groups.values()) {
    rs.sort((a, b) => a.t - b.t);
    const model = rs[0].model, resetAt = rs[0].reset, startAt = resetAt - 86400000;
    if (resetAt < since || startAt > Date.now()) continue;
    const endAt = Math.min(resetAt, Date.now()), duration = Math.max(1, endAt - startAt);
    const units = Math.max(...rs.map((r) => r.used));
    const tokenRows = telemetry.events.filter((e) => e.model === model && e.t >= startAt && e.t <= endAt);
    const tokens = tokenRows.reduce((a, e) => ({ input: a.input + e.input, cached: a.cached + e.cached, output: a.output + e.output }), { input: 0, cached: 0, output: 0 });
    const price = TRAE_PUBLIC_PRICES[model];
    const uncached = Math.max(0, tokens.input - tokens.cached);
    const dollars = price && tokenRows.length ? (uncached * price.input + tokens.cached * price.cachedInput + tokens.output * price.output) / 1e6 : null;
    const ratio = dollars != null && units > 0 ? dollars / units : null;
    const quotaSpan = Math.max(0, Math.min(endAt, rs.at(-1).t) - Math.max(startAt, rs[0].t));
    const allWindowEvents = telemetry.events.filter((e) => e.t >= startAt && e.t <= endAt);
    const sessionSpan = allWindowEvents.length > 1 ? Math.max(...allWindowEvents.map((e) => e.t)) - Math.min(...allWindowEvents.map((e) => e.t)) : 0;
    windows.push({ model, startAt, resetAt, complete: resetAt <= Date.now(), unitsUsed: units,
      tokens, publicListCostUsd: dollars == null ? null : Math.round(dollars * 100) / 100,
      dollarsPerUnit: ratio == null ? null : Math.round(ratio * 1000) / 1000,
      coveragePct: ratio == null ? null : Math.round(Math.min(1, ratio) * 1000) / 10,
      quotaLogSpanPct: Math.round(Math.min(1, quotaSpan / duration) * 1000) / 10,
      sessionTelemetrySpanPct: Math.round(Math.min(1, sessionSpan / duration) * 1000) / 10,
      status: units > 0 && price && tokenRows.length ? 'MEASURED' : 'UNKNOWN',
      reason: units <= 0 ? 'no bucket units used' : !price ? 'no public list price for this model' : !tokenRows.length ? 'no matching TRAE token telemetry' : null });
  }
  return { windows: windows.sort((a, b) => a.resetAt - b.resetAt || a.model.localeCompare(b.model)),
    status: windows.some((w) => w.status === 'MEASURED') ? 'MEASURED' : 'UNKNOWN', sessionFiles: telemetry.files,
    readErrors: telemetry.errors, prices: TRAE_PUBLIC_PRICES,
    note: 'Coverage is public-list dollars explained per bucket unit, capped at 100%; it is not proof that a TRAE unit equals $1. Span percentages show retained telemetry coverage. Missing quota, price or tokens is UNKNOWN.' };
};
quota.traeReconciliation = await traeReconciliation();

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
const globalRules = auditGlobalRules({ records: all, version: loadDigest().version, since, profiles: readProfiles(),
  ledgerRoot: process.env.RULES_LEDGER_ROOT || path.dirname(SHARED) });
const resourceFiles = [RESOURCE_LOG, ...Array.from({ length: 6 }, (_, i) => `${RESOURCE_LOG}.${i + 1}`)].filter((f) => fs.existsSync(f));
const resourceRows = await readJsonl(resourceFiles, since - 600000);
const resources = resourceReview(resourceRows.rows, { hours: H, quotaRecords: snaps });
const utilisation = { ...resources.utilisation, coverage: resources.coverage, readErrors: resourceRows.errors };
const workerInbox = auditWorkerEvents(undefined, since);
const eventHistory = path.join(rulesShared(), 'worker-event-history');
let retained = [];
try { retained = fs.readdirSync(eventHistory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
  .flatMap(entry => lines(path.join(eventHistory, entry.name))); } catch {}
const events = [...new Map([...retained, ...readEvents()].map(row => [row.id, row])).values()];
const answered = new Set(events.filter(row => row.event === 'answered').map(row => `${row.account}/${row.thread}/${row.questionId}`));
const overdueQuestions = events.filter(row => row.event === 'question' && row.expiresAt <= Date.now()
  && !answered.has(`${row.account}/${row.thread}/${row.questionId}`)).map(row => ({ owner: row.owner, account: row.account,
    thread: row.thread, name: row.name ?? null, questionId: row.questionId, askedAt: row.t, expiresAt: row.expiresAt, default: row.default ?? null }));
const residents = checkResidents();
const result = { overdueQuestions, residents, hours: H, routing, reviews: reviewBudget, outcomes, background, quota, utilisation, now, catalog, globalRules, workerInbox };
// Exit only after the pipe has drained; process.exit right after console.log truncates piped output at ~64 KB.
if (opt('json')) { await new Promise((done) => process.stdout.write(JSON.stringify(result, null, 1) + '\n', done)); process.exit(0); }
const show = (title, v) => console.log(`\n## ${title}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`);
console.log(`# routing review data — last ${H}h (to ${fmt(Date.now())})`);
show('routing', routing);
show('review budget', reviewBudget);
show('outcomes (first attempt\'s vendor/model/category)', outcomes);
show('background tasks (wall-clock minutes, including queues)', background);
show('quota and cards', quota);
show('utilisation', utilisationLines(utilisation).join('\n'));
show('now', now);
show('model catalog', catalog);
show('global rules', globalRules);
show('worker inbox (delivery acknowledgement, not task acceptance)', workerInbox);

show('questions older than their timeout (no recorded answer)', overdueQuestions);
show('resident worker liveness', residents);
