#!/usr/bin/env node
// route: pick vendor, model, effort, account and the exact launch command for one task, deterministically.
//
//   route <category> [--stakes low|normal|high] [--auto-check] [--failures N] [--writes | --read-only]
//                    [--against claude|codex] [--no-redeem] [--project SLUG] [--dry]
//                    [--impact release|service|throwaway]   (required for implement, implement-hard, debug, science)
//                    [--exclude-account a,b] [--origins p,q] [--mode <orchestrator permission mode>] [--cwd DIR] [--task-dir DIR]
//                    [--name NAME] [--fresh] [--json]
//   route --table          (the routing table: categories, first pick, alternative, escalation ladder)
//
// The orchestrator judges only what a script can't: which category the task is, its stakes, whether an automatic check
// (tests, a build, an exact acceptance check) will catch a miss, and how many times it has already fallen short
// (--failures, counted per task across workers). Everything else is computed here from the table below and the quota
// state in lib/state.mjs: escalation, vendor locks, quota moves, effort notches, the account, approval gates and argv.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, analyze, leanLines, readProfiles, hours, withLock, SHARED, ROUTE_LOG, POLICY } from './lib/state.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RR = process.env.ROUTE_RR || path.join(SHARED, 'route-rotation.txt'); // launch counter for account rotation
const C = (model, effort) => ({ vendor: 'claude', model, effort });
const X = (model, effort) => ({ vendor: 'codex', model, effort });
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', TERRA = 'gpt-6.1-terra', LUNA = 'gpt-6-luna';

// The routing table (sources and rationale: references/model-routing.md).
//   kind: claudeOnly (Claude tools: computer use, browser, Artifact/Docs, peer negotiation) | codexOnly (images) |
//         claudeBetter (Claude only while it has spare; design stays on Claude when near budget) | codexFirst
//   shape: exec (one-shot: `codex exec` on Codex, a short background worker on Claude) | worker (steerable / long).
//   Claude work always launches as a background worker, never an Agent subagent (user, 2026-11-03).
const TABLE = {
  lookup: { desc: 'quick lookup, find a file, status check', kind: 'codexFirst', shape: 'exec', writes: false, first: X(LUNA, 'low'), alt: C('haiku', 'low'), ladder: [X(SOL, 'medium'), C('sonnet', 'medium')] }, // a Codex step first, so a lookup can escalate while Claude is over budget
  extract: { desc: 'bulk extraction, classification, summarizing data or logs', kind: 'codexFirst', shape: 'exec', writes: false, first: X(LUNA, 'medium'), alt: C('haiku', 'medium'), ladder: [X(SOL, 'medium')] },
  analysis: { desc: 'log or data analysis that needs reasoning', kind: 'codexFirst', shape: 'worker', writes: false, first: X(SOL, 'medium'), alt: C('sonnet', 'medium'), ladder: [X(SOL, 'high'), C('opus', 'high')] },
  research: { desc: 'web research and synthesis', kind: 'claudeBetter', shape: 'worker', writes: false, first: C('sonnet', 'medium'), alt: X(SOL, 'medium'), ladder: [C('opus', 'high')] },
  implement: { desc: 'well-scoped implementation (clear spec, a test or build checks it)', kind: 'codexFirst', shape: 'worker', writes: true, first: X(SOL, 'high'), alt: C('sonnet', 'medium'), ladder: [X(SOL, 'xhigh'), C('opus', 'high')] },
  'implement-hard': { desc: 'large, cross-module or threading implementation; refactor', kind: 'codexFirst', shape: 'worker', writes: true, first: X(SOL, 'xhigh'), alt: C('opus', 'high'), ladder: [C('opus', 'xhigh'), X(SOL, 'max')] },
  'ui-browser': { desc: 'UI or frontend work that needs a browser or a visual check', kind: 'claudeOnly', shape: 'worker', writes: true, first: C('sonnet', 'high'), alt: null, ladder: [C('opus', 'high')] },
  debug: { desc: 'debugging, root cause across components', kind: 'codexFirst', shape: 'worker', writes: true, first: X(SOL, 'xhigh'), alt: C('opus', 'high'), ladder: [C('opus', 'xhigh'), X(SOL, 'max'), C('fable', 'high'), X(ASTRA, 'xhigh')] },
  review: { desc: 'routine code review', kind: 'codexFirst', shape: 'worker', writes: false, first: X(SOL, 'high'), alt: C('sonnet', 'high'), ladder: [X(SOL, 'xhigh')] },
  'review-high': { desc: 'high-stakes review (concurrency, ABI, crash fix, security)', kind: 'claudeBetter', keepNear: true, shape: 'worker', writes: false, first: C('opus', 'xhigh'), alt: X(SOL, 'xhigh'), second: X(SOL, 'xhigh'), ladder: [X(ASTRA, 'high')] },
  design: { desc: 'design, architecture, plan, trade-off decision', kind: 'claudeBetter', keepNear: true, shape: 'worker', writes: false, first: C('opus', 'high'), alt: X(SOL, 'xhigh'), second: X(SOL, 'xhigh'), ladder: [C('opus', 'xhigh')] },
  docs: { desc: 'docs, reports, user-facing writing, Feishu docs', kind: 'claudeBetter', shape: 'worker', writes: true, first: C('sonnet', 'medium'), alt: X(SOL, 'medium'), ladder: [C('opus', 'medium')] },
  draft: { desc: 'bulk prose drafts or translation, reviewed afterwards', kind: 'codexFirst', shape: 'exec', writes: true, first: X(TERRA, 'medium'), alt: C('sonnet', 'low'), ladder: [X(SOL, 'medium')] },
  'build-run': { desc: 'long procedural build, deploy or device workflow (Codex: you broker device handoffs by steering)', kind: 'codexFirst', shape: 'worker', writes: true, first: X(SOL, 'medium'), alt: C('sonnet', 'medium'), ladder: [X(SOL, 'high'), C('opus', 'high')] },
  // Web pages in the user's signed-in Chrome (user, 2026-11-07): TTADK Codex when it is set up for browser use, else Claude.
  browser: { desc: "operating web pages in the user's signed-in Chrome: internal consoles, Feishu docs, dashboards, forms (not desktop apps)", kind: 'browser', shape: 'worker', writes: false, first: X(SOL, 'medium'), alt: C('sonnet', 'medium'), ladder: [X(SOL, 'high'), C('sonnet', 'medium'), C('opus', 'high')] },
  'computer-use': { desc: 'computer use on desktop apps, Artifact/Docs tools, negotiating with peers (web pages in Chrome: the browser row)', kind: 'claudeOnly', shape: 'worker', writes: true, first: C('sonnet', 'medium'), alt: null, ladder: [C('opus', 'high')] },
  science: { desc: 'scientific or numerical computation', kind: 'codexFirst', shape: 'worker', writes: true, first: X(SOL, 'xhigh'), alt: C('opus', 'xhigh'), ladder: [X(ASTRA, 'high')] },
  // Every task whose output is an image goes to Codex (user, 2026-11-03: Codex is better at it). The image tool makes the
  // picture; the chat model only writes prompts and checks results, so Luna low first, Sol when iterating needs judgment.
  'image-gen': { desc: 'any task whose output is an image: generate, edit, variants, icons, illustrations, mockup or cover images', kind: 'codexOnly', shape: 'exec', writes: true, first: X(LUNA, 'low'), alt: null, ladder: [X(SOL, 'medium')] },
  'image-read': { desc: 'reading screenshots or images (no computer use)', kind: 'claudeBetter', shape: 'worker', writes: false, first: C('sonnet', 'medium'), alt: X(TERRA, 'medium'), ladder: [C('opus', 'high')] },
  'second-opinion': { desc: 'independent second opinion on a conclusion (pass --against <vendor that made it>)', kind: 'codexFirst', shape: 'exec', writes: false, first: X(SOL, 'high'), alt: C('opus', 'high'), ladder: [X(SOL, 'xhigh')] },
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const floorOf = (m) => (m.model === SOL || m.model === ASTRA || m.model === TERRA ? 'medium' : 'low'); // Sol low is weak at code
const notch = (m, d, cap = 'xhigh') => {
  const i = EFFORTS.indexOf(m.effort), lo = EFFORTS.indexOf(floorOf(m)), hi = Math.max(EFFORTS.indexOf(cap), i);
  return { ...m, effort: EFFORTS[Math.min(hi, Math.max(lo, i + d))] };
};
const label = (m) => `${m.vendor === 'claude' ? `Claude ${m.model}` : `Codex ${m.model}`} ${m.effort}`;

// ---- args ----
const BOOL = new Set(['auto-check', 'writes', 'read-only', 'fresh', 'json', 'table', 'no-redeem', 'dry']);
// --exclude-account a,b: route around accounts that just failed (e.g. TTADK after a rate-limited retry or an auth error).
// --origins p,q: extra sites (origins or host globs) a Codex browser worker may reach besides POLICY.browserOrigins.
const argv = process.argv.slice(2), opts = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) { pos.push(argv[i]); continue; }
  const k = argv[i].slice(2);
  opts[k] = BOOL.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
}
const die = (msg) => { console.error(`route: ${msg}`); process.exit(2); };
if (opts.table) {
  for (const [k, t] of Object.entries(TABLE)) console.log(`${k.padEnd(15)} ${t.kind.padEnd(13)} first ${label(t.first).padEnd(26)} alt ${(t.alt ? label(t.alt) : '—').padEnd(26)} then ${t.ladder.map(label).join(' → ') || '—'}${t.second ? `  (+ second opinion ${label(t.second)})` : ''}\n${''.padEnd(16)}${t.desc}`);
  process.exit(0);
}
const cat = pos[0];
const T = TABLE[cat];
if (!T) die(`unknown category ${cat ?? '(none)'}; one of: ${Object.keys(TABLE).join(', ')} (route --table)`);
const stakes = opts.stakes ?? 'normal';
if (!['low', 'normal', 'high'].includes(stakes)) die(`--stakes takes low, normal or high, not ${stakes}`);
const failures = opts.failures === undefined ? 0 : Number(opts.failures);
if (!Number.isInteger(failures) || failures < 0) die(`--failures takes a whole number ≥ 0, not ${opts.failures}`);
if (cat === 'second-opinion' && !['claude', 'codex'].includes(opts.against)) die('second-opinion needs --against claude|codex (the vendor whose conclusion is checked)');
// --author claude|codex on review / review-high: the vendor that wrote the code. A Codex-written change is reviewed by
// Claude first, so the required review is not the same model checking itself.
if (opts.author !== undefined && !['claude', 'codex'].includes(opts.author)) die(`--author takes claude or codex, not ${opts.author}`);
const authorCodex = ['review', 'review-high'].includes(cat) && opts.author === 'codex';
const writes = opts['read-only'] ? false : opts.writes ? true : T.writes;
// Code work declares its impact, which decides the review (user, 2026-11-04): can a mistake be undone within hours by
// redeploying or rolling back, without lasting damage? release = no (app/SDK code that ships in a release, published
// libraries, data migrations or bulk data changes, contracts released clients depend on, auth/privacy/billing);
// service = yes (ordinary live-service changes, internal tools); throwaway = demos, prototypes, experiments, test scripts.
const CODE = ['implement', 'implement-hard', 'debug', 'science'];
const IMPACTS = ['release', 'service', 'throwaway'];
const impact = typeof opts.impact === 'string' ? opts.impact : null;
if (CODE.includes(cat) && !IMPACTS.includes(impact)) die(`${cat} needs --impact release|service|throwaway — can a mistake be undone within hours by redeploy/rollback without lasting damage? no → release; yes → service; demo/prototype/test script → throwaway`);
if (impact && !IMPACTS.includes(impact)) die(`--impact takes release, service or throwaway, not ${impact}`);
const reviewKind = !CODE.includes(cat) ? null : impact === 'throwaway' ? null : impact === 'release' ? (stakes === 'high' ? 'review-high' : 'review') : stakes === 'high' ? 'review-high' : null;

// ---- state ----
const data = readState({ fresh: !!opts.fresh });
const st = analyze(data);
const { claude: QC, codex: QX } = st;
const noRedeem = !!opts['no-redeem'];
const excluded = new Set((typeof opts['exclude-account'] === 'string' ? opts['exclude-account'] : '').split(',').map((x) => x.trim()).filter(Boolean));
// ChatGPT accounts (the quota-managed ones): out when every open account is spent/excluded and no card is due.
const chatgptOpen = (QX.open ?? []).filter((r) => !excluded.has(r.a.name));
const chatgptOut = QX.out || (noRedeem && !QX.pick && !!QX.redeem)
  || (!chatgptOpen.length && !(QX.redeem && !noRedeem && !excluded.has(QX.redeem.a.name)) && (QX.rows ?? []).some((r) => r.known && !excluded.has(r.a.name)))
  || (!chatgptOpen.length && (QX.rows ?? []).length > 0 && (QX.rows ?? []).every((r) => excluded.has(r.a.name)));
// TTADK (company gateway): preferred for Codex work whenever it is healthy and not excluded (user, 2026-11-07).
const TT = QX.ttadk?.usable && !excluded.has(QX.ttadk.name) ? QX.ttadk : null;
// A TTADK device (a TTADK account is set up here): TTADK always first, and the shared ChatGPT and Claude quota is left
// for the user's other device, which has no TTADK (user, 2026-11-07). So no rule here spends quota for its own sake:
// no underused/front-load/expiring effort raises and no extra quota-spending reviews. Without TTADK nothing changes.
const ttDevice = !!QX.ttadk;
const ttHas = (model) => !!TT && TT.models.includes(model);
const browserViaCodex = T.kind === 'browser' && !!TT && TT.browser;
const codexOut = chatgptOut && !TT; // Codex is out only when neither TTADK nor a ChatGPT account can take work
const why = [], needsOK = [], tell = [], notes = [];
const claudeAllowed = (kind) => {
  if (QC.throttledUntil) return false; // a full 5h window: nothing new on Claude until it resets
  if (kind === 'claudeOnly' || (kind === 'browser' && !browserViaCodex)) return true;
  if (QC.status === 'spare') return true;
  if (QC.status === 'near') return T.keepNear || stakes === 'high';
  return false; // over or unknown
};
const allowed = (x) => (x.vendor === 'claude' ? claudeAllowed(T.kind) : T.kind === 'browser' ? browserViaCodex : !codexOut);

// ---- 1. vendor locks, quota moves and the escalation ladder ----
// The usable ladder: the first pick (or its same-tier alternative when quota rules it out), then every later step the
// quota allows. --failures N takes step N, so each failure moves up even when some steps are ruled out.
let base;
if (cat === 'second-opinion') { base = opts.against === 'claude' ? [T.first, ...T.ladder] : [T.alt, C('opus', 'xhigh')]; why.push(`second opinion from the other vendor than ${opts.against}`); }
else if (T.kind === 'browser' && !browserViaCodex) base = [T.alt, C('opus', 'high')];
else if (authorCodex) { base = [cat === 'review' ? T.alt : T.first, C('opus', 'xhigh'), X(SOL, 'xhigh')]; why.push('Codex wrote it: Claude reviews first (Codex only when Claude has no room)'); }
else base = [T.first, ...T.ladder];
// Every task TTADK's GPT-6.1 Sol can handle goes to it first (user, 2026-11-07): Sol at the row's effort (at least
// medium), one notch higher after a failure, then the row's own ladder. Not TTADK-capable: Claude-only rows, image
// generation, a second opinion on Codex's work, and browser work while TTADK isn't browser-ready.
// research needs Codex's hosted web search, which the gateway lacks (tested 2026-11-07: "NO WEB SEARCH TOOL"; image
// input works, so image-read stays).
const ttCapable = !!TT && ttHas(SOL) && T.kind !== 'claudeOnly' && cat !== 'image-gen' && cat !== 'research' && !authorCodex
  && !(cat === 'second-opinion' && opts.against === 'codex') && !(T.kind === 'browser' && !browserViaCodex);
if (ttCapable) {
  // Sol at the row's effort — the higher of its first pick's and its Sol alternative's (design: Opus high / Sol xhigh →
  // Sol xhigh) — then one notch higher when there is one below max (max needs the user's OK). Then the row's own
  // steps, minus Codex steps that are no stronger than Sol already tried (no falling back to Luna or Terra, or to a
  // weaker Sol); models TTADK lacks become Sol when the ChatGPT accounts are out. Rows that start at xhigh therefore go
  // straight on to their own ladder, which alternates vendors (e.g. Sol xhigh → Opus xhigh → Sol max).
  const ei = (e) => EFFORTS.indexOf(e);
  const altSol = cat !== 'second-opinion' && T.alt?.vendor === 'codex' && T.alt.model === SOL ? T.alt.effort : null;
  const eff = altSol && ei(altSol) > ei(base[0].effort) ? altSol : base[0].effort;
  const e0 = notch(X(SOL, eff === 'max' ? 'xhigh' : eff), 0), up = notch(e0, +1);
  const rungs = [e0, ...(up.effort !== e0.effort ? [up] : [])];
  let top = ei(rungs.at(-1).effort);
  for (let x of base) {
    if (x.vendor === 'codex') {
      if (!ttHas(x.model) && chatgptOut) x = X(SOL, x.effort);
      if (x.model === SOL) { if (ei(x.effort) <= top) continue; top = ei(x.effort); }
      else if (x.model !== ASTRA) continue;
    }
    rungs.push(x);
  }
  base = rungs;
}
let deferred = null;
const retry = (h) => (h != null && Number.isFinite(h) ? ` — retry in ${hours(h)}` : '');
if (st.stop) deferred = "neither vendor's usage is readable — check `claude -p /usage` and the Codex hubs before dispatching";
else if (T.kind === 'claudeOnly' && QC.throttledUntil) deferred = `Claude-only work and Claude's 5h window is full${retry((QC.throttledUntil - Date.now()) / 3600000)}`;
else if (T.kind === 'codexOnly' && chatgptOut) deferred = `Codex-only work and Codex is ${QX.throttledOnly ? 'paused by its 5h window' : 'out'}${retry(QX.nextFree)}`;
else if (codexOut && !QX.throttledOnly && stakes === 'low' && T.kind !== 'claudeOnly' && !(T.kind === 'browser' && !browserViaCodex)) deferred = `Codex is out and this is low-stakes: it waits for Codex${retry(QX.nextFree)}`;
let m = null, prevRaw = null;
if (!deferred) {
  const firstOk = allowed(base[0]) ? base[0] : T.alt && allowed(T.alt) && cat !== 'second-opinion' ? T.alt : null;
  const ladder = [firstOk, ...base.slice(1).filter(allowed)].filter(Boolean)
    .filter((x, i, a) => a.findIndex((y) => y.vendor === x.vendor && y.model === x.model && y.effort === x.effort) === i);
  const waits = [...(base.some((x) => x.vendor === 'claude') && QC.throttledUntil ? [(QC.throttledUntil - Date.now()) / 3600000] : []),
    ...(base.some((x) => x.vendor === 'codex') && codexOut && QX.nextFree != null ? [QX.nextFree] : [])];
  if (!ladder.length) deferred = `neither vendor has room for this now (claude ${QC.throttledUntil ? '5h-throttled' : QC.status}, codex ${codexOut ? (QX.throttledOnly ? 'paused' : 'out') : 'ok'})${retry(waits.length ? Math.min(...waits) : null)}`;
  else {
    if (firstOk && firstOk !== base[0]) why.push(`${base[0].vendor} not available for this (${base[0].vendor === 'claude' ? `claude ${QC.throttledUntil ? '5h-throttled' : QC.status}` : QX.throttledOnly ? 'codex paused by its 5h window' : 'codex out'}) → ${firstOk.vendor}`);
    m = ladder[Math.min(failures, ladder.length - 1)];
    if (failures) prevRaw = ladder[Math.min(failures - 1, ladder.length - 1)];
    if (failures) why.push(`escalated to step ${Math.min(failures, ladder.length - 1)} of ${ladder.length - 1} after ${failures} failure(s)`);
    if (failures >= ladder.length) needsOK.push(`escalation ladder exhausted after ${failures} failure(s): tell the user before trying again`);
    const codexFails = ladder.slice(0, Math.min(failures, ladder.length)).filter((x) => x.vendor === 'codex').length;
    if (codexFails >= 2) tell.push(`Codex has fallen short on this task ${codexFails} times: tell the user what happened (model, effort, symptom)`);
    if (codexOut && !QX.throttledOnly && m.vendor === 'claude' && T.kind !== 'claudeOnly') why.push('Codex is out: Claude takes this because it matters');
  }
}

// ---- 2. effort ----
// tune(): the effort notches for a ladder step taken after f failures. Also used to rebuild the previous attempt, so a
// retry that a quota notch has made identical to it is flagged instead of reported as an escalation.
// TTADK takes the Codex pick when the gateway has its model; when the ChatGPT accounts are out, it also takes models it
// lacks as Sol. Image generation never runs there, not even its Sol fallback step: the gateway has no image tool.
const onTTADK = (x) => x?.vendor === 'codex' && !!TT && cat !== 'image-gen' && (ttHas(x.model) || chatgptOut);
const tune = (x, f, log) => {
  const step = (d, reason) => { const n = notch(x, d); if (n.effort !== x.effort) { log(reason); x = n; } };
  if (f === 0 && opts['auto-check'] && stakes !== 'high') step(-1, 'one notch lower: an automatic check catches a miss');
  if (f === 0 && stakes === 'high') step(+1, 'one notch higher: high stakes');
  if (f === 0 && stakes === 'low') step(-1, 'one notch lower: low stakes');
  const cheap = ['lookup', 'extract', 'image-gen', 'draft'].includes(cat);
  if (x.vendor === 'codex' && !onTTADK(x) && !ttDevice && QX.underused && !cheap) step(+1, QX.frontLoad ? 'one notch higher: front-loading Codex while reset cards are in hand' : 'one notch higher: Codex underused');
  else if (x.vendor === 'codex' && !onTTADK(x) && QX.overspending && opts['auto-check'] && stakes !== 'high') step(-1, 'one notch lower: Codex overspending');
  if (x.vendor === 'claude' && QC.expiring && !ttDevice && !cheap) step(+1, 'one notch higher: Claude headroom expires within a day');
  if (x.vendor === 'claude' && x.model === 'fable' && QC.avoidFable) { x = C('opus', 'xhigh'); log('Fable window nearly used → Opus xhigh'); }
  return x;
};
if (m && onTTADK(m) && !ttHas(m.model)) {
  const sub = notch(X(SOL, m.effort), 0);
  why.push(`${m.model} isn't on the TTADK gateway and the ChatGPT accounts are out → ${label(sub)} on TTADK`);
  m = sub;
}
if (m) {
  m = tune(m, failures, (r) => why.push(r));
  const prev = prevRaw && tune(prevRaw, failures - 1, () => {});
  if (prev && prev.vendor === m.vendor && prev.model === m.model && prev.effort === m.effort) {
    why.push(`same ${label(m)} as the previous attempt: a quota notch already raised that one, and the quota rules leave no stronger step`);
    notes.push(`this retry is not stronger than the one that fell short: its only lever is the brief — put the failure's concrete findings (review items, failing test, symptom) in it`);
  }
  // ---- 3. gates ----
  if (m.model === 'fable') needsOK.push('Fable (≈3x Opus cost, own weekly cap)');
  if (m.model === ASTRA) needsOK.push('Astra (5x Sol usage)');
  if (m.effort === 'max') needsOK.push('max effort');
}
// Second opinion: the row's cross-vendor pair, or — while Codex is underused — an extra independent Codex review of
// hard Codex work.
let second = m && T.second ? T.second : null;
if (second && m.vendor === second.vendor) second = second.vendor === 'codex' ? C('opus', 'xhigh') : X(SOL, 'xhigh');
if (second && !allowed(second)) second = null;
// Its point is to spend Codex quota that would otherwise be lost, so: only where the review policy wants a review anyway
// (release code, or service code at high stakes; user, 2026-11-07), and never on a TTADK device, whose quota is left
// for the other device.
let extraReview = false;
if (!second && m && m.vendor === 'codex' && !ttDevice && QX.underused && ['implement-hard', 'debug', 'science'].includes(cat) && reviewKind) {
  second = X(SOL, 'xhigh'); extraReview = true;
  notes.push('extra independent Codex review of the result (Codex underused): run it after the worker reports, as a fresh read-only review');
}

// ---- 4. account and launcher ----
const mode = typeof opts.mode === 'string' ? opts.mode : 'default';
// Claude workers follow the user's own default permission mode (settings.json permissions.defaultMode) unless --mode is given.
// This is only the Claude launch flag: the Codex sandbox below still depends on an explicit --mode, so the local default never silently widens it.
const claudeMode = typeof opts.mode === 'string' ? opts.mode : (() => {
  try {
    const home = process.env.HOME || '';
    const d = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const v = d?.permissions?.defaultMode ?? d?.defaultMode;
    return typeof v === 'string' && /^[A-Za-z]+$/.test(v) ? v : 'default';
  } catch { return 'default'; }
})();
const sandbox = !writes ? 'read-only' : mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write';
const cwd = typeof opts.cwd === 'string' ? opts.cwd : '<workspace>', taskDir = typeof opts['task-dir'] === 'string' ? opts['task-dir'] : '<task dir>';
const name = typeof opts.name === 'string' ? opts.name : '<project>-<task>';
const prompt = `"Read ${taskDir}/brief.md and follow it."`;
const inRepo = (() => {
  if (typeof opts.cwd !== 'string') return null;
  for (let d = path.resolve(opts.cwd); ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) return true; if (d === path.dirname(d)) return false; }
})();
// The account: a rotation across accounts that must all be spent soon, else the earliest deadline.
// After the open accounts comes the reset-card account (route.mjs then asks for the redemption, below), and when no
// account could be read at all, the first registered one (as if it has room, and the note says so).
const redeemAcct = QX.redeem && !noRedeem && !excluded.has(QX.redeem.a.name) ? QX.redeem : null;
let acct = (QX.pick && !excluded.has(QX.pick.a.name) ? QX.pick : chatgptOpen[0]) ?? redeemAcct
  ?? (!QX.readable ? (QX.rows ?? []).find((r) => !excluded.has(r.a.name)) : null) ?? null;
const chatgptAcct = acct;
const ttadkRun = m && onTTADK(m);
if (ttadkRun) acct = { a: { name: TT.name, live: TT.live } };
else if (QX.rotate && m?.vendor === 'codex' && QX.rotate.every((r) => !excluded.has(r.a.name))) {
  const n = withLock(RR, () => { let c = 0; try { c = Number(fs.readFileSync(RR, 'utf8')) || 0; } catch {} if (!opts.dry) fs.writeFileSync(RR, String(c + 1)); return c; });
  acct = QX.rotate[n % QX.rotate.length];
}
const pickAcct = acct;
// The second opinion's account: the extra underused review on ChatGPT; any other Codex second opinion TTADK-first.
// The second opinion's account: TTADK first for a Codex second opinion it can run; otherwise the ChatGPT account.
const secondAcct = !second || second.vendor !== 'codex' ? null
  : !extraReview && onTTADK(second) && ttHas(second.model) ? { a: { name: TT.name, live: TT.live } } : ttadkRun ? chatgptAcct : pickAcct;
const profiles = readProfiles();
const launch = (x, shape = T.shape, acct = pickAcct) => {
  if (x.vendor === 'claude') {
    return { launcher: 'claude-bg', command: `cd ${cwd} && claude --bg --permission-mode ${claudeMode} -n ${name} --model ${x.model} --effort ${x.effort} ${prompt}` };
  }
  const an = acct?.a.name ?? 'main', home = profiles[an]?.home ?? '~/.codex';
  if (shape === 'exec') return { launcher: 'codex-exec', account: an, command: `CODEX_HOME=${home} codex exec${inRepo === false ? ' --skip-git-repo-check' : ''} -C ${cwd} -s ${sandbox} -m ${x.model} -c model_reasoning_effort='"${x.effort}"' --json -o ${taskDir}/codex-last.md ${prompt} < /dev/null > ${taskDir}/codex.jsonl 2>&1   (background task${inRepo === null ? '; add --skip-git-repo-check outside a repo' : ''})` };
  const origins = cat === 'browser' ? ` --browser-origins '${[...POLICY.browserOrigins, ...(typeof opts.origins === 'string' ? opts.origins.split(',') : [])].map((o) => o.trim()).filter(Boolean).join(',')}'` : '';
  return { launcher: 'codex-worker', account: an, command: `node ${SKILL}/scripts/codex-worker.mjs --account ${an} start --cwd ${cwd} --model ${x.model} --effort ${x.effort} --sandbox ${sandbox} --name ${name}${origins} --log ${taskDir}/codex.jsonl --out ${taskDir}/codex-last.md ${prompt}   (background task)` };
};
// The same quality gate for both vendors, so outcomes compare: code work gets an independent review before it's accepted.
// Review only where a mistake is costly to undo; reviewers follow references/review-rubric.md (blocking issues only).
if (m && reviewKind) notes.push(`review required (impact ${impact}${stakes === 'high' ? ', high stakes' : ''}): after the worker reports, route.mjs ${reviewKind} --author ${m.vendor} --project ${typeof opts.project === 'string' ? opts.project : '<slug>'} --name ${name}-R; brief the reviewer with references/review-rubric.md (blocks only on P0/P1, at most 2 rounds); then record with scripts/outcome.mjs --reviewed`);
else if (m && CODE.includes(cat)) notes.push(`no review (impact ${impact}${impact === 'service' ? ', not high stakes' : ''}): accept on your own check (tests, build, acceptance), then record with scripts/outcome.mjs`);
else if (m && cat !== 'review' && cat !== 'review-high' && cat !== 'second-opinion') notes.push('when the task ends: record it with scripts/outcome.mjs (pass | rework --rounds N | fail)');
// Fixed safety clauses for anything that writes or touches devices (SKILL.md, "Give each worker a self-contained brief").
if (m && writes) notes.push('brief: include the safety clauses — never overwrite, delete or move files outside the task\'s scope (user files, uncommitted changes, shared headers/configs); restore anything touched by mistake byte-for-byte and report it');
if (m && ['build-run', 'implement', 'implement-hard', 'debug', 'ui-browser', 'computer-use'].includes(cat)) notes.push('brief: on devices and simulators, back up app data before any destructive step (reinstall with --remove-existing-content, wiping app containers or Documents, erasing simulators), or ask first');
// Claude browser workers can reach the user's signed-in Chrome; a worker that can't find it must not hand the clicking back
// to the orchestrator (nightly review 11-05: W258 blocked on "can't see local browser 1e7c2b37", the user then chose
// "orchestrator does the console", and that orchestrator made 510 browser calls in 24h).
if (m && ['ui-browser', 'computer-use'].includes(cat)) notes.push('brief: name the Chrome to use by its deviceId from the ledger (the user picks it once; mcp__claude-in-chrome__list_connected_browsers lists them) and tell the worker: if a browser tool says several browsers are connected, call select_browser with that deviceId; if the browser still isn\'t reachable, report BLOCKED with the tool\'s exact error, never ask the orchestrator to click for it. Headless Playwright is fine where the user\'s sign-in isn\'t needed');
if (m && cat === 'browser') notes.push('brief: include the browser safety clause — read and navigate freely, but ask the user (AskUserQuestion; a Codex worker reports BLOCKED) before anything irreversible on a page: submitting a form that changes data, approving, deleting, publishing, sending a message, payments');
if (ttadkRun) {
  notes.push(`TTADK Codex has no web search: if the task turns out to need the web, re-route it as research (route.mjs research)`);
  notes.push(`on TTADK (account ${TT.name}): if the run fails rate-limited (QPM / concurrency), retry it once there; if it fails again, or fails for TTADK reasons (SSO, auth, gateway errors), re-route with --exclude-account ${TT.name}`);
  if (!TT.live && T.shape !== 'exec') notes.push(`TTADK hub is down: start it first — node ${SKILL}/scripts/codex-worker.mjs --account ${TT.name} hub`);
}
if (m && cat === 'browser') {
  notes.push('Chrome must be running before the worker starts (workers can\'t launch it): pgrep -x "Google Chrome" >/dev/null || open -a "Google Chrome"');
  if (m.vendor === 'codex') notes.push(`"Browser is not available: chrome" (codex-worker prints browser-unavailable:) means the Chrome extension host is briefly disconnected: wait a minute, retry once, then re-route with --exclude-account ${acct?.a?.name ?? TT?.name}`);
  if (m.vendor === 'codex') notes.push(`brief: include the "Codex browser brief" clauses from references/codex-workers.md (plugin bootstrap from ${TT?.chromePlugin ?? '<chrome plugin>'}/scripts/browser-client.mjs; work in tabs you create; a tab your own click opens may be claimed via user.openTabs()/claimTab and must be closed; never touch the user's other tabs); sites outside --browser-origins are declined — add them with --origins when the task needs them`);
  else notes.push('Claude browser worker (Claude in Chrome): if the extension reports several browsers, select only this Mac\'s Chrome (deviceId in the ledger); never switch to another connected browser');
}
if (m?.vendor === 'codex' && sandbox === 'workspace-write') notes.push('workspace-write can\'t run git writes: brief the worker to edit only and report the files and a commit message; you review and commit');
if (m?.vendor === 'codex' && acct && !acct.a.live) notes.push(T.shape === 'exec' ? `account ${acct.a.name}'s reading is stale (its hub is down); codex exec still works` : `account ${acct.a.name}'s hub is down — start it first: codex-worker.mjs --account ${acct.a.name} hub`);
if (!QX.readable && m?.vendor === 'codex') notes.push('Codex usage unreadable; routing as if it has room');
const lands = (a) => !!a && !!redeemAcct && a.a.name === redeemAcct.a.name && !chatgptOpen.some((r) => r.a.name === a.a.name);
const redeemFirst = ((m?.vendor === 'codex' && !ttadkRun && lands(pickAcct)) || (second?.vendor === 'codex' && lands(secondAcct)))
  ? `redeem a reset card on ${QX.redeem.a.name} first (with the user's OK; if declined, re-run with --no-redeem): ${QX.redeem.cp.line}` : null;
const out = {
  category: cat, stakes, failures, deferred,
  pick: m ? { ...m, ...launch(m), sandbox: m.vendor === 'codex' ? sandbox : null } : null,
  secondOpinion: second ? { ...second, ...launch(second, second === T.second ? T.shape : 'worker', secondAcct) } : null,
  needsUserOK: needsOK, tellUser: tell, why, notes, redeemFirst, quota: leanLines(st, data),
};
// Every real routing decision is logged for the nightly review (--dry or ROUTE_LOG=0 to skip, e.g. for experiments).
if (!opts.dry && process.env.ROUTE_LOG !== '0') {
  const rec = { t: Date.now(), project: typeof opts.project === 'string' ? opts.project : null, name: typeof opts.name === 'string' ? opts.name : null, category: cat, stakes, failures, impact, review: reviewKind, excluded: [...excluded], ttadk: !!ttadkRun,
    autoCheck: !!opts['auto-check'], noRedeem, deferred, pick: m ? { vendor: m.vendor, model: m.model, effort: m.effort, account: out.pick?.account ?? null } : null,
    second: second ? { vendor: second.vendor, model: second.model, effort: second.effort } : null, why, needsOK, tell,
    quota: { claude: QC.status, codexOut: QX.out, underused: QX.underused, frontLoad: QX.frontLoad, overspending: QX.overspending, redeemDue: !!QX.redeem } };
  try { fs.appendFileSync(ROUTE_LOG, JSON.stringify(rec) + '\n'); } catch {}
}
if (opts.json) { console.log(JSON.stringify(out)); process.exit(0); }
if (deferred) console.log(`DEFER ${cat}: ${deferred}`);
else {
  console.log(`${cat} → ${label(m)}${out.pick.account ? ` on account ${out.pick.account}` : ''}${out.pick.sandbox ? `, sandbox ${out.pick.sandbox}` : ''}`);
  if (why.length) console.log(`  why: ${why.join('; ')}`);
  console.log(`  launch: ${out.pick.command}`);
}
if (second) console.log(`  + second opinion: ${label(second)} — ${out.secondOpinion.command}`);
if (redeemFirst) console.log(`  first: ${redeemFirst}`);
for (const n of needsOK) console.log(`  needs the user's OK: ${n}`);
for (const n of tell) console.log(`  tell the user: ${n}`);
for (const n of notes) console.log(`  note: ${n}`);
