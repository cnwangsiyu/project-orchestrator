#!/usr/bin/env node
// route: pick vendor, model, effort, account and the exact launch command for one task, deterministically.
//
//   route <category> [--stakes low|normal|high] [--auto-check] [--failures N] [--writes | --read-only]
//                    [--against claude|codex] [--no-redeem] [--project SLUG] [--dry]
//                    [--impact release|service|throwaway]   (required for implement, implement-hard, debug, science)
//                    [--exclude-account a,b] [--exclude-model m,family] [--origins p,q] [--mode <orchestrator permission mode>] [--cwd DIR] [--task-dir DIR]
//                    [--name NAME] [--fresh] [--json] [--security] [--background]
//   route --table          (the routing table: categories, first pick, alternative, escalation ladder)
//
// The orchestrator judges only what a script can't: which category the task is, its stakes, whether an automatic check
// (tests, a build, an exact acceptance check) will catch a miss, and how many times it has already fallen short
// (--failures, counted per task across workers). Everything else is computed here from the table below and the quota
// state in lib/state.mjs: escalation, vendor locks, quota moves, effort notches, the account, approval gates and argv.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, analyze, leanLines, readProfiles, hours, fmt, withLock, SHARED, ROUTE_LOG, POLICY } from './lib/state.mjs';
import { poolOf } from './lib/trae-health.mjs';
import { balanceFactors, hasTraeDailyQuota } from './lib/company-load.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RR = process.env.ROUTE_RR || path.join(SHARED, 'route-rotation.txt'); // launch counter for account rotation
const C = (model, effort) => ({ vendor: 'claude', model, effort });
const X = (model, effort) => ({ vendor: 'codex', model, effort });
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', TERRA = 'gpt-6.1-terra', LUNA = 'gpt-6-luna';
// User-approved TRAE benchmark 2026-11-13; keep both orders here for the harder benchmark round.
const TRAE_GPT_ORDER = Object.freeze({ depleted: ['gpt-5.6-sol', ASTRA], bucketFree: ['gpt-5.5', 'gpt-5.6-terra'] });
const KIMI = 'kimi-k3'; // TTADK only: a different model family, best planted-bug recall (2026-11-07 tests)
// Fallback models on a company account, in order, for when its GPT-6.1-Sol is unavailable (paused, restricted, excluded)
// and as a different-family step after Sol has fallen short (user, 2026-11-10: "某个模型失败的话还有的备选"; keep
// quality, spend as little personal quota as possible). From the 2026-11-10 benchmark on TRAE (6 hard tasks, 12 runs
// each; Sol 0.95 at 227 s median): DeepSeek-V4.1-Flash 0.97 at 344 s, 0 false positives in review; Gemini-3.1-Pro 0.99
// but 715 s and 3 of 12 runs hit the 40-minute limit; DeepSeek-V4-Pro 0.94 at 659 s. Left out: Seed-Evolving (0.87)
// and Seed-2.1-Pro (0.81), which break output formats, and Cursor's Grok 4.7 (0.50, timeouts and dropped connections).
// All ran at high effort, so they run at high here. Gemini is the only one that reads images (checked 2026-11-10 on
// TRAE: Sol and Gemini transcribed a screenshot's text; both DeepSeek models answered that they can't see images).
// 2026-11-13: TRAE dropped Gemini from its model list, so Seed-Evolving joins as the image reader only — live tests
// transcribed a small-text screenshot exactly and named shapes/colours, but it cannot see audio, video or scanned PDFs
// (convert those pages to images and route them as image-read); its 2026-11-10 general benchmark (0.87, broken output
// formats) keeps it out of every other fallback chain.
const ALTS = [{ model: 'deepseek-v4.1-flash', effort: 'high' }, { model: 'gemini-3.1-pro-preview', effort: 'high', vision: true },
  { model: 'deepseek-v4-pro', effort: 'high' }, { model: 'seed-evolving', effort: 'medium', vision: true, visionOnly: true }];
const isAlt = (x) => x?.vendor === 'codex' && ALTS.some((a) => a.model === x.model);

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
  // UI work with a visual check in Chrome (user, 2026-11-07): TTADK Codex when browser-ready (verified: it found every real
  // defect on a planted page, with CSS causes), else Claude as before.
  'ui-browser': { desc: 'UI or frontend work that needs a browser or a visual check', kind: 'browser', shape: 'worker', writes: true, first: X(SOL, 'high'), alt: C('sonnet', 'high'), ladder: [C('opus', 'high')] },
  debug: { desc: 'debugging, root cause across components', kind: 'codexFirst', shape: 'worker', writes: true, first: X(SOL, 'xhigh'), alt: C('opus', 'high'), ladder: [C('opus', 'xhigh'), X(SOL, 'max'), C('fable', 'high'), X(ASTRA, 'xhigh')] },
  review: { desc: 'routine code review', kind: 'codexFirst', shape: 'worker', writes: false, first: X(SOL, 'high'), alt: C('sonnet', 'high'), ladder: [X(SOL, 'xhigh')] },
  'review-high': { desc: 'high-stakes review (concurrency, ABI, crash fix, security)', kind: 'claudeBetter', keepNear: true, shape: 'worker', writes: false, first: C('opus', 'xhigh'), alt: X(SOL, 'xhigh'), second: X(SOL, 'xhigh'), ladder: [X(ASTRA, 'high')] },
  design: { desc: 'design, architecture, plan, trade-off decision', kind: 'claudeBetter', keepNear: true, shape: 'worker', writes: false, first: C('opus', 'high'), alt: X(SOL, 'xhigh'), second: X(SOL, 'xhigh'), ladder: [C('opus', 'xhigh')] },
  docs: { desc: 'docs, reports, user-facing writing, Feishu docs', kind: 'claudeBetter', shape: 'worker', writes: true, first: C('sonnet', 'medium'), alt: X(SOL, 'medium'), ladder: [C('opus', 'medium')] },
  draft: { desc: 'bulk prose drafts or translation, reviewed afterwards', kind: 'codexFirst', shape: 'exec', writes: true, first: X(TERRA, 'medium'), alt: C('sonnet', 'low'), ladder: [X(SOL, 'medium')] },
  'build-run': { desc: 'long procedural build, deploy or device workflow (Codex: you broker device handoffs by steering)', kind: 'codexFirst', shape: 'worker', writes: true, first: X(SOL, 'medium'), alt: C('sonnet', 'medium'), ladder: [X(SOL, 'high'), C('opus', 'high')] },
  // Web pages in the user's signed-in Chrome (user, 2026-11-07): TTADK Codex when it is set up for browser use, else Claude.
  browser: { desc: "operating web pages in the user's signed-in Chrome: internal consoles, Feishu docs, dashboards, forms (not desktop apps)", kind: 'browser', shape: 'worker', writes: false, first: X(SOL, 'medium'), alt: C('sonnet', 'medium'), ladder: [X(SOL, 'high'), C('sonnet', 'medium'), C('opus', 'high')] },
  // Desktop apps (user, 2026-11-07): TTADK Codex through the ChatGPT app's computer-use plugin when browser-setup is done
  // (it also enables computer use) — a terminal Claude worker has no desktop computer-use tool (only Claude in Chrome).
  'computer-use': { desc: 'operating desktop apps (web pages in Chrome: browser; Artifact/Docs tools or peer negotiation: claude-tools); pass --apps <bundle ids>', kind: 'browser', shape: 'worker', writes: true, first: X(SOL, 'medium'), alt: C('sonnet', 'medium'), ladder: [C('opus', 'high')] },
  'claude-tools': { desc: 'work that needs Claude-only tools: Artifact/Docs tools, negotiating with other sessions', kind: 'claudeOnly', shape: 'worker', writes: true, first: C('sonnet', 'medium'), alt: null, ladder: [C('opus', 'high')] },
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
const label = (m) => `${m.vendor === 'claude' ? `Claude ${m.model}` : isAlt(m) ? m.model : `Codex ${m.model}`} ${m.effort}`;

// ---- args ----
// --apps a,b: the desktop apps (bundle ids) a computer-use worker may operate; others are declined.
const BOOL = new Set(['auto-check', 'writes', 'read-only', 'fresh', 'json', 'table', 'no-redeem', 'dry', 'urgent', 'security', 'background', 'device-lease', 'shared-lock']);
// --urgent: run now even while TTADK is down for a fixable reason (that work would otherwise wait for the fix).
// --exclude-account a,b: route around accounts that just failed (e.g. TTADK after a rate-limited retry or an auth error).
// --exclude-model m,f: route around models (an id, or a family: gpt, deepseek, gemini…) that just failed for
// infrastructure reasons (queue full, restricted, timed out) on the company account — not a --failures step; also how a
// review of a fallback model's code keeps that model's family off the reviewer seat.
// --security: security/attack-flavoured tasks exclude GPT only on TRAE; other accounts route normally.
// --background: nobody is waiting; prefer TRAE even when depleted/congested, and never spend personal quota.
// --device-lease / --shared-lock: the task holds a shared resource and cannot enter the balancing/background lane.
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
const claudeReviewFirst = (authorCodex && cat === 'review-high') || (cat === 'second-opinion' && opts.against === 'codex');
// A routine review of Codex-written code runs on TTADK when it is there: a fresh Sol xhigh reviewer plus a second one
// with a different focus, both free (user, 2026-11-07). High-stakes review keeps Claude first.
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
let reviewKind = !CODE.includes(cat) ? null : impact === 'throwaway' ? null : impact === 'release' ? (stakes === 'high' ? 'review-high' : 'review') : stakes === 'high' ? 'review-high' : null;

// ---- state ----
let profiles, registryError = null;
try { profiles = readProfiles(); } catch (e) { profiles = {}; registryError = e.message; }
const data = readState({ fresh: !!opts.fresh, profiles, registryError });
const st = analyze(data);
const { claude: QC, codex: QX } = st;
const noRedeem = !!opts['no-redeem'];
const security = !!opts.security;
const background = !!opts.background;
const laneEligible = T.kind !== 'browser' && T.kind !== 'claudeOnly'
  && !['build-run', 'image-gen', 'image-read'].includes(cat) && !opts['device-lease'] && !opts['shared-lock'];
// Background image reading can wait on a vision model; opportunistic company balancing still excludes images.
const backgroundEligible = laneEligible || (cat === 'image-read' && !opts['device-lease'] && !opts['shared-lock']);
const excluded = new Set((typeof opts['exclude-account'] === 'string' ? opts['exclude-account'] : '').split(',').map((x) => x.trim()).filter(Boolean));
const exModels = new Set((typeof opts['exclude-model'] === 'string' ? opts['exclude-model'] : '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const modelExcluded = (model, account = null) => exModels.has(model) || exModels.has(poolOf(model))
  || (security && account?.kind === 'trae' && poolOf(model) === 'gpt');
const cheapTraeRow = ['lookup', 'extract', 'draft'].includes(cat) && laneEligible;
const bucketFreeModels = (account) => account?.kind === 'trae' && hasTraeDailyQuota(account.quota) && cat !== 'image-read'
  ? TRAE_GPT_ORDER.bucketFree.filter((id) => account.models.includes(id) && !modelExcluded(id, account) && !Object.hasOwn(account.quota.daily, id)) : [];
// ChatGPT accounts (the quota-managed ones): out when every open account is spent/excluded and no card is due.
const chatgptOpen = (QX.open ?? []).filter((r) => !excluded.has(r.a.name));
const chatgptOut = QX.out || (noRedeem && !QX.pick && !!QX.redeem)
  || (!chatgptOpen.length && !(QX.redeem && !noRedeem && !excluded.has(QX.redeem.a.name)) && (QX.rows ?? []).some((r) => r.known && !excluded.has(r.a.name)))
  || (!chatgptOpen.length && (QX.rows ?? []).length > 0 && (QX.rows ?? []).every((r) => excluded.has(r.a.name)));
// TTADK (company gateway): preferred for Codex work whenever it is healthy and not excluded (user, 2026-11-07). When it
// isn't (its daily quota used up, down, or excluded), TRAE CLI — the second company account — takes the same work under
// the same rules, before personal quota (user, 2026-11-08). TT is whichever company account takes Codex work now.
const deepseekUnfit = cat === 'build-run' || cat === 'review-high'
  || (['review', 'second-opinion'].includes(cat) && (impact === 'release' || stakes === 'high' || security));
const taskFits = (a) => T.kind !== 'claudeOnly' && cat !== 'image-gen'
  && !(cat === 'research' && !a.search) && !(T.kind === 'browser' && !a.browser);
const routingModelFits = (model, account) => model === SOL || (backgroundEligible && account.kind === 'trae' && model === ASTRA)
  || (backgroundEligible && bucketFreeModels(account).includes(model)) || ALTS.some((a) => a.model === model
  && (cat === 'image-read' ? a.vision : !a.visionOnly) && !(deepseekUnfit && poolOf(model) === 'deepseek'));
const companyOrder = background && backgroundEligible ? [QX.trae, QX.ttadk] : [QX.ttadk, QX.trae];
const TT = companyOrder.find((a) => a?.usable && !excluded.has(a.name)
  && (!background || taskFits(a)) && a.models.some((x) => !modelExcluded(x, a) && (!background || routingModelFits(x, a)))) ?? null;
const backgroundLane = background && backgroundEligible && TT?.kind === 'trae';
// A TTADK device (a TTADK account is set up here): TTADK always first, and the shared ChatGPT and Claude quota is left
// for the user's other device, which has no TTADK (user, 2026-11-07). So no rule here spends quota for its own sake:
// no underused/front-load/expiring effort raises and no extra quota-spending reviews. Without TTADK nothing changes.
const ttDevice = !!QX.ttadk || !!QX.trae || QX.companyAccounts.length > 0 || !!QX.registryError;
const ttHas = (model) => !!TT && TT.models.includes(model) && !modelExcluded(model, TT);
// Browser, frontend-visual and desktop-app work runs on a Codex worker when a Codex account can drive Chrome and the
// desktop: the company account first (TTADK with browser-setup), else a browser-ready ChatGPT account (2026-11-10: on a
// device without TTADK, e.g. the MacBook, this used to go to Claude even though its Codex accounts can do it); else Claude.
const ttBrowser = !!TT && !!TT.browser;
const chatgptBrowser = chatgptOpen.filter((r) => r.a.browser);
const browserViaCodex = T.kind === 'browser' && (ttBrowser || chatgptBrowser.length > 0);
// The fallback models the company account can run for this task, best first (ALTS): image-read takes the vision models,
// every other row the general ones (Seed-Evolving is vision-only, 2026-11-13).
const ttAlts = ALTS.filter((a) => ttHas(a.model) && (cat === 'image-read' ? a.vision : !a.visionOnly)
  && !(deepseekUnfit && poolOf(a.model) === 'deepseek')).map((a) => X(a.model, a.effort));
const ttBucketFree = backgroundLane || cheapTraeRow ? bucketFreeModels(TT) : [];
const ttModelsOK = ttHas(SOL) || ttAlts.length > 0 || ttBucketFree.length > 0 || (backgroundLane && ttHas(ASTRA));
// A fallback of a different family from model x (a reviewer or a retry that doesn't share x's blind spots).
const altOtherThan = (x) => ttAlts.find((a) => poolOf(a.model) !== poolOf(x?.model)) ?? null;
const codexOut = chatgptOut && !ttModelsOK; // An account with only excluded or unsupported models can't take work.
const why = [], needsOK = [], tell = [], notes = [];
const unknownCompanyState = QX.companyUnknown.length > 0 || !!QX.registryError;
const unknownCompanyReason = QX.companyUnknown.map((a) => `${a.name}/${a.kind}`).join(', ') || QX.registryError;
if (unknownCompanyState) tell.push(`company account state unknown (${unknownCompanyReason}): check quota.mjs --fresh before launching; a registered company account is not absent`);
const claudeAllowed = (kind) => {
  if (background) return false;
  if (QC.throttledUntil) return false; // a full 5h window: nothing new on Claude until it resets
  if (kind === 'claudeOnly' || (kind === 'browser' && !browserViaCodex)) return true;
  if (QC.status === 'spare') return true;
  if (QC.status === 'near') return T.keepNear || stakes === 'high';
  return false; // over or unknown
};
const allowed = (x) => background ? x.vendor === 'codex' && !!TT && taskFits(TT) && ttHas(x.model)
  : (x.vendor === 'claude' ? claudeAllowed(T.kind) : !modelExcluded(x.model) && (T.kind === 'browser' ? browserViaCodex : !codexOut));

// ---- 1. vendor locks, quota moves and the escalation ladder ----
// The usable ladder: the first pick (or its same-tier alternative when quota rules it out), then every later step the
// quota allows. --failures N takes step N, so each failure moves up even when some steps are ruled out.
let base;
if (cat === 'second-opinion') {
  base = opts.against === 'claude' ? [T.first, ...T.ladder] : [T.alt, C('opus', 'xhigh'), ...(TT && ttHas(SOL) ? [X(SOL, 'xhigh')] : ttAlts.slice(0, 1))];
  why.push(`second opinion from the other vendor than ${opts.against}`);
}
else if (T.kind === 'browser' && !browserViaCodex) base = [T.alt, C('opus', 'high')];
else if (authorCodex && !(cat === 'review' && ttModelsOK)) {
  base = [cat === 'review' ? T.alt : T.first, C('opus', 'xhigh'), X(SOL, 'xhigh')];
  if (!ttAlts.length || ttHas(SOL)) why.push('Codex wrote it: Claude reviews first (Codex only when Claude has no room)');
}
else base = [T.first, ...T.ladder];
// Every task TTADK's GPT-6.1 Sol can handle goes to it first (user, 2026-11-07): Sol at the row's effort (at least
// medium), one notch higher after a failure, then the row's own ladder. Not TTADK-capable: Claude-only rows, image
// generation, and browser work while TTADK isn't browser-ready. Codex high-stakes reviews and second opinions keep
// Claude first when company Sol is available; when Sol is unavailable, company fallback families go first.
// research needs web search. Codex doesn't send its hosted web_search tool to the gateway, so TTADK searches only through
// its local proxy (ttadk-setup sets it up: TT.search); without it research follows the earlier routing.
const ttTaskOK = T.kind !== 'claudeOnly' && cat !== 'image-gen';
const ttCapable = ttModelsOK && ttTaskOK && !(claudeReviewFirst && ttHas(SOL) && !background)
  && !(cat === 'research' && !TT.search) && !(T.kind === 'browser' && !ttBrowser);
const ei = (e) => EFFORTS.indexOf(e);
const maxE = (a, b) => (ei(a) >= ei(b) ? a : b);
const companyFirstEffort = () => {
  const altSol = cat !== 'second-opinion' && T.alt?.vendor === 'codex' && T.alt.model === SOL ? T.alt.effort : null;
  let eff = altSol ? maxE(altSol, base[0].effort) : base[0].effort;
  if (['docs', 'research', 'image-read', 'analysis'].includes(cat)) eff = maxE(eff, 'high');
  if (authorCodex) eff = maxE(eff, 'xhigh');
  if (eff === 'max') eff = 'xhigh';
  if (impact === 'throwaway' && ei(eff) > ei('high')) { eff = 'high'; why.push("throwaway: starts at Sol high on the company account (its daily token quota); a failure climbs to xhigh, then max"); }
  const first = notch(X(SOL, eff), 0);
  return (stakes === 'high' ? notch(first, +1) : first).effort;
};
const companyEffort = ttCapable ? companyFirstEffort() : null;
if (ttCapable && !ttHas(SOL)) {
  // GPT-6.1-Sol unavailable on the company account (its GPT family paused or restricted, or excluded for this task):
  // the fallback models in order, then the row's own Claude steps. Company quota, so no question; personal quota (the
  // Claude steps) only after these have fallen short.
  const gone = modelExcluded(SOL) ? `excluded for this task (--exclude-model ${[...exModels].join(',')})` : modelExcluded(SOL, TT) ? 'excluded for this security task (--security)' : TT.poolPauses?.gpt ? `paused: ${TT.poolPauses.gpt.reason}` : TT.modelPauses?.[SOL] ? `unavailable: ${TT.modelPauses[SOL].reason}` : 'not listed';
  const fallbacks = [...ttBucketFree.map((id) => X(id, companyEffort)), ...ttAlts,
    ...(backgroundLane && ttHas(ASTRA) ? [X(ASTRA, maxE('high', companyEffort))] : [])];
  why.push(`GPT-6.1-Sol on ${TT.name} ${gone} → its fallback models: ${fallbacks.map(label).join(' → ')}`);
  base = [...fallbacks, ...base.filter((x) => x.vendor === 'claude')];
}
else if (ttCapable) {
  // TTADK is the company's quota, so quality may cost TTADK effort but not personal quota (user, 2026-11-07):
  // - start at the higher of the row's first-pick effort and its Sol alternative's (design: Opus high / Sol xhigh →
  //   Sol xhigh); at least high for the rows Claude is better at or that need judgment (docs, research, image-read,
  //   analysis) and xhigh for a review of Codex-written code; one notch higher at high stakes;
  // - throwaway code work starts at most at high (user, 2026-11-09): TTADK's quota is daily (~500M tokens) and ran out
  //   mid-afternoon on 11-08, stopping six running tasks; throwaway work passed first time 15/17 that week, so its
  //   xhigh first attempts spent the day's tokens for little. A failure still climbs to xhigh and max;
  // - then every Sol notch up to xhigh, and on to max (no OK needed on TTADK) except for the cheap rows;
  // - then the row's own steps, minus Codex steps no stronger than what TTADK already tried (no Luna, Terra or a weaker
  //   Sol); Astra (ChatGPT, needs an OK) stays after Sol max, and when the ChatGPT accounts are out it is dropped.
  const e0 = X(SOL, companyEffort);
  const cheapRow = ['lookup', 'extract', 'draft', 'browser', 'computer-use'].includes(cat); // browser/desktop misses are UI trouble, not depth
  const rungs = [e0];
  while (ei(rungs.at(-1).effort) < ei('xhigh')) rungs.push(notch(rungs.at(-1), +1));
  // After Sol xhigh has fallen short, a different model family before Sol max (its misses rarely overlap Sol's: Kimi,
  // 2026-11-07; DeepSeek, 2026-11-10), and the second fallback after Sol max — all before personal quota.
  if (ttAlts[0]) rungs.push(ttAlts[0]);
  if (!cheapRow) rungs.push(X(SOL, 'max'));
  if (!cheapRow && ttAlts[1]) rungs.push(ttAlts[1]);
  // GPT-6-Astra on the company account after Sol max and the fallbacks (live test 2026-11-13: 4 parallel tiny tasks all
  // succeeded after ~13.5 min of TRAE-wide queueing); company quota, so no OK — the gate below covers ChatGPT only.
  if (!cheapRow && ttHas(ASTRA)) rungs.push(X(ASTRA, 'high'));
  let top = ei(rungs.at(-1).effort);
  for (const x of base) {
    if (x.vendor === 'codex') {
      if (x.model === ASTRA && !chatgptOut) { rungs.push(x); continue; }
      if (x.model === SOL && ei(x.effort) > top) { rungs.push(x); top = ei(x.effort); }
      continue;
    }
    rungs.push(x);
  }
  base = rungs;
}
// Never hold work on our own (user, 2026-11-09: "不要擅自决定去暂缓一些工作"). When TTADK is out the work goes to TRAE;
// when both company accounts are out — quota used up, or down for a reason the user can fix — it is routed to personal
// quota behind the user's OK (go on now, or wait); low-stakes work too. Only work that nothing can run right now (Claude's
// 5h window full for Claude-only work, Codex out for Codex-only work) is deferred, and then the user is told.
// Personal quota only after asking (user, 2026-11-09: "如果要用我的个人额度，就提前问我；不用我的个人额度时，不需要提前问我。
// TTADK 和 Trae 都可以直接用"). On a device with a company account, work a company account would take that no company
// account can take now — TTADK and TRAE out, down or excluded — goes to personal quota only after the user's OK; high
// stakes too (it used to skip the question). One answer covers the outage: after "go on" the orchestrator passes
// --urgent until a company account is back; after "wait" it holds that work. Standing exceptions (the user's routing,
// asked 2026-11-09: no question): image generation, Claude-only tools, browser/desktop work Claude takes, reviews whose
// second opinion is Claude while company Sol is available. Company capacity means an eligible routing model, not
// merely a healthy account that still lists an excluded or unsupported family.
const companyOut = !ttModelsOK && ttDevice && ttTaskOK && T.kind !== 'browser';
if (companyOut && !opts.urgent && QX.ttadk && !QX.ttadk.usable && !QX.ttadk.quotaOut && !excluded.has(QX.ttadk.name))
  tell.push(`TTADK is down (${QX.ttadk.reason}): tell the user now so they can fix it`);
let deferred = null;
const retry = (h) => (h != null && Number.isFinite(h) ? ` — retry in ${hours(h)}` : '');
if (background && !TT) deferred = 'background: no eligible company model can take this task; queued for later, no personal quota';
else if (st.stop) deferred = "neither vendor's usage is readable — check `claude -p /usage` and the Codex hubs before dispatching";
else if ((T.kind === 'claudeOnly' || (T.kind === 'browser' && !browserViaCodex)) && QC.throttledUntil) deferred = `Claude-only work and Claude's 5h window is full${retry((QC.throttledUntil - Date.now()) / 3600000)}`;
else if (T.kind === 'codexOnly' && chatgptOut) deferred = `Codex-only work and Codex is ${QX.throttledOnly ? 'paused by its 5h window' : 'out'}${retry(QX.nextFree)}`;
else if (codexOut && !QX.throttledOnly && stakes === 'low' && T.kind !== 'claudeOnly' && !(T.kind === 'browser' && !browserViaCodex) && !opts.urgent)
  needsOK.push(`Codex is out (next free in ${QX.nextFree != null ? hours(QX.nextFree) : '?'}) and this is low-stakes: ask the user whether to run it now on Claude (this pick) or wait for Codex`);
let m = null, prevRaw = null;
let balance = null, balancedAccount = null;
if (!deferred) {
  const firstOk = allowed(base[0]) ? base[0] : T.alt && allowed(T.alt) && cat !== 'second-opinion' ? T.alt : null;
  const ladder = [firstOk, ...base.slice(1).filter(allowed)].filter(Boolean)
    .filter((x, i, a) => a.findIndex((y) => y.vendor === x.vendor && y.model === x.model && y.effort === x.effort) === i);
  const waits = [...(base.some((x) => x.vendor === 'claude') && QC.throttledUntil ? [(QC.throttledUntil - Date.now()) / 3600000] : []),
    ...(base.some((x) => x.vendor === 'codex') && codexOut && QX.nextFree != null ? [QX.nextFree] : [])];
  // Over a budget line but still runnable (Claude past its spare line, not throttled): ask instead of holding.
  const runnable = !ladder.length && !background ? base.find((x) => (x.vendor === 'claude' ? !QC.throttledUntil : allowed(x))) ?? null : null;
  if (!ladder.length && runnable) {
    ladder.push(runnable);
    if (!opts.urgent) needsOK.push(`no vendor has room within the quota policy (claude ${QC.status}, codex ${codexOut ? 'out' : 'ok'}): ask the user whether to run it now anyway on ${runnable.vendor} (this pick) or wait${retry(waits.length ? Math.min(...waits) : null)}`);
  }
  if (!ladder.length) deferred = `neither vendor has room for this now (claude ${QC.throttledUntil ? '5h-throttled' : QC.status}, codex ${codexOut ? (QX.throttledOnly ? 'paused' : 'out') : 'ok'})${retry(waits.length ? Math.min(...waits) : null)}`;
  else {
    if (firstOk && firstOk !== base[0]) why.push(`${base[0].vendor} not available for this (${base[0].vendor === 'claude' ? `claude ${QC.throttledUntil ? '5h-throttled' : QC.status}` : QX.throttledOnly ? 'codex paused by its 5h window' : 'codex out'}) → ${firstOk.vendor}`);
    m = ladder[Math.min(failures, ladder.length - 1)];
    if (failures) prevRaw = ladder[Math.min(failures - 1, ladder.length - 1)];
    if (failures) why.push(`escalated to step ${Math.min(failures, ladder.length - 1)} of ${ladder.length - 1} after ${failures} failure(s)`);
    if (failures >= ladder.length) needsOK.push(`escalation ladder exhausted after ${failures} failure(s): tell the user before trying again`);
    if (failures >= 1 && CODE.includes(cat)) notes.push("if the last miss was spec/process, amend the brief's acceptance first and say what changed before dispatching this fix round (outcome --cause); do not repeat the same brief");
    if (failures >= 1 && CODE.includes(cat)) notes.push('rework thread rule (SKILL.md, 2026-11-13): may continue the original author thread only for this same-task fix round with useful context, company account (personal needs user OK), no route escalation or exclusion, and no depleted TRAE bucket with queue >300 while someone waits; otherwise use the route thread. Record outcome.mjs --actual and ledger: "continued original thread because ..."');
    // Rework retro 2026-11-10 (user-approved): from the second failed attempt of code work, patching again rarely helps
    // when the new defect is of the same kind; re-scope first.
    if (failures >= 2 && CODE.includes(cat)) notes.push('before this fix round: if the last fix brought a new defect of the same kind (same invariant, state or race), stop patching — find whether it is a shared contract, the interface layout or a too-wide patch, then simplify or split the work (a `design` route can review the approach); the fix brief still asks for the original failure, the fix and the neighbouring old behaviour to be tested');
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
// research without the search proxy stays off TTADK on every step, fallbacks included (nightly review 11-07 dry run).
const onTTADK = (x) => x?.vendor === 'codex' && !!TT && taskFits(TT) && (ttHas(x.model)
  || (balancedAccount?.models.includes(x.model) && !modelExcluded(x.model, balancedAccount)) || (chatgptOut && ttModelsOK));
// TRAE sets request priority. Prefer models that avoid daily high-priority spend; missing telemetry is not free quota.
const backgroundChoice = (x, log) => {
  const daily = TT.quota?.daily;
  const known = hasTraeDailyQuota(TT.quota);
  if (known) {
    const freeGPT = x.model === ASTRA ? null : ttBucketFree[0];
    if (freeGPT) {
      log(`background: ${freeGPT} has no daily bucket → no high-priority quota spent, no low-priority lane (step 1)`);
      return freeGPT === x.model ? x : X(freeGPT, x.effort);
    }
    // Sol/Astra serve the row's GPT tier. An Astra escalation must not fall back down to Sol or a cheaper family.
    const depleted = (x.model === ASTRA ? [ASTRA] : [SOL, ASTRA]).find((id) => ttHas(id) && daily[id]?.depleted === true);
    if (depleted) {
      log(`background: ${depleted === SOL ? 'GPT-6.1-Sol' : 'GPT-6-Astra'} bucket depleted → low-priority lane, no high-priority quota spent (step 1)`);
      return depleted === x.model ? x : X(depleted, x.effort);
    }
    const unbucketed = x.model === ASTRA ? null : (cat === 'image-read' ? ['seed-evolving'] : ['deepseek-v4.1-flash', 'deepseek-v4-pro'])
      .map((id) => ttAlts.find((a) => a.model === id)).find((a) => a && !Object.hasOwn(daily, a.model));
    if (unbucketed) {
      log(`background: ${unbucketed.model} has no daily bucket → no high-priority quota spent (step 2)`);
      return unbucketed.model === x.model ? x : unbucketed;
    }
  }
  log(`background: normal TRAE pick ${label(x)} — ${known ? 'no eligible depleted/no-bucket model; spends high-priority quota when available' : 'no daily quota info; may spend high-priority quota'} (step 3); TRAE decides request priority`);
  return x;
};
// Daily depletion affects new model choices, never account health, concurrency or an accepted queued turn.
// Use a comparable GPT with confirmed quota left; an unknown bucket is not evidence of spare priority capacity.
const quotaChoice = (x, log = (r) => why.push(r)) => {
  if (!onTTADK(x) || TT.kind !== 'trae') return x;
  if (backgroundLane) return backgroundChoice(x, log);
  if (cheapTraeRow && x.model !== ASTRA && ttBucketFree[0]) {
    const id = ttBucketFree[0];
    log(`cheap TRAE row: ${id} has no daily bucket → no high-priority quota spent, no low-priority lane`);
    return id === x.model ? x : X(id, x.effort);
  }
  if (!TT.quota?.daily?.[x.model]?.depleted) return x;
  const gpt = TRAE_GPT_ORDER.depleted.find((model) => {
    const q = TT.quota.daily[model];
    return model !== x.model && ttHas(model) && (cat !== 'image-read' || model === ASTRA) && q?.depleted === false
      && (q.remaining > 0 || (q.used != null && q.limit > q.used));
  });
  const sub = gpt ? X(gpt, x.effort) : ttAlts.find((a) => a.model !== x.model && !TT.quota.daily[a.model]?.depleted);
  log(`TRAE ${x.model}'s daily high-priority bucket is depleted → ${sub ? `${label(sub)} (${gpt ? 'comparable GPT with quota left' : 'eligible company fallback'})` : 'keep the queued model: no eligible alternative with quota left'}; parallel task concurrency is unchanged`);
  return sub ?? x;
};
const tune = (x, f, log) => {
  const step = (d, reason) => { const n = notch(x, d); if (n.effort !== x.effort) { log(reason); x = n; } };
  // On TTADK the cost notches save nothing (company quota) and the high-stakes notch is already in its rungs.
  const ttRung = ttCapable && onTTADK(x);
  if (f === 0 && opts['auto-check'] && stakes !== 'high' && !ttRung) step(-1, 'one notch lower: an automatic check catches a miss');
  if (f === 0 && stakes === 'high' && !ttRung) step(+1, 'one notch higher: high stakes');
  if (f === 0 && stakes === 'low' && !ttRung) step(-1, 'one notch lower: low stakes');
  const cheap = ['lookup', 'extract', 'image-gen', 'draft'].includes(cat);
  if (x.vendor === 'codex' && !onTTADK(x) && !ttDevice && QX.underused && !cheap) step(+1, QX.frontLoad ? 'one notch higher: front-loading Codex while reset cards are in hand' : 'one notch higher: Codex underused');
  else if (x.vendor === 'codex' && !onTTADK(x) && QX.overspending && opts['auto-check'] && stakes !== 'high') step(-1, 'one notch lower: Codex overspending');
  if (x.vendor === 'claude' && QC.expiring && !ttDevice && !cheap) step(+1, 'one notch higher: Claude headroom expires within a day');
  if (x.vendor === 'claude' && x.model === 'fable' && QC.avoidFable) { x = C('opus', 'xhigh'); log('Fable window nearly used → Opus xhigh'); }
  return x;
};
if (m && onTTADK(m) && !ttHas(m.model) && (ttHas(SOL) || ttAlts.length)) {
  const sub = ttHas(SOL) ? notch(X(SOL, m.effort), 0) : ttAlts[0];
  why.push(`${m.model} isn't on ${TT.name} and the ChatGPT accounts are out → ${label(sub)} on ${TT.name}`);
  m = sub;
}
if (m) {
  m = quotaChoice(m);
  m = tune(m, failures, (r) => why.push(r));
  const prev = prevRaw && tune(quotaChoice(prevRaw, () => {}), failures - 1, () => {});
  if (prev && prev.vendor === m.vendor && prev.model === m.model && prev.effort === m.effort) {
    why.push(`same ${label(m)} as the previous attempt: a quota notch already raised that one, and the quota rules leave no stronger step`);
    notes.push(`this retry is not stronger than the one that fell short: its only lever is the brief — put the failure's concrete findings (review items, failing test, symptom) in it`);
  }
  // Code a fallback model writes for a live service gets the routine review too (free on the company account): the
  // benchmark behind ALTS is 12 runs per model, too few to trust them unchecked where a mistake reaches users.
  if (isAlt(m) && CODE.includes(cat) && impact === 'service' && !reviewKind) { reviewKind = 'review'; why.push(`${m.model} is a fallback model: its service code gets a review`); }
  // Cheap TRAE work prefers bucket-free GPTs; other transfers preserve the rung. Second opinions stay on their account.
  if (!background && onTTADK(m) && TT === QX.ttadk && QX.trae) {
    const free = cheapTraeRow && m.model !== ASTRA ? bucketFreeModels(QX.trae) : [];
    for (const model of [...free, m.model]) {
      balance = balanceFactors({ ttadk: QX.ttadk, trae: QX.trae, model, category: cat, stakes, impact, allowBucketFree: free.includes(model) });
      const fits = QX.trae.usable && !excluded.has(QX.trae.name) && QX.trae.models.includes(model)
        && !modelExcluded(model, QX.trae) && laneEligible;
      balance.taskEligible = !!fits;
      balance.selected = !!fits && balance.eligible;
      if (!balance.selected) continue;
      balancedAccount = QX.trae;
      m = { ...m, model };
      const factors = balance.triggers.map((s) => s === 'TTADK projected to run out'
        ? `${s} at ${new Date(balance.burn.outAt).toISOString().slice(11, 16)} UTC` : s);
      const quota = balance.bucketFree ? 'has no daily bucket, no high-priority quota spent, no low-priority lane' : `${Math.round(balance.remainingShare * 100)}% left`;
      why.push(`balanced to TRAE: ${factors.join(', ')}, TRAE ${m.model} ${quota}, `
        + `load ${balance.load ? `${balance.load.percent}%` : 'unknown'}, queue ${balance.queue?.position ?? (balance.queue?.state === 'ready' ? 'ready' : 'unknown')}`);
      break;
    }
  }
  // ---- 3. gates ----
  if (m.model === 'fable') needsOK.push('Fable (2x Opus per token, and its own weekly cap, which the orchestrators run on)');
  // Astra on a company account spends company quota: no OK. On a ChatGPT (personal) account it does (5x Sol usage).
  if (m.model === ASTRA && !onTTADK(m)) needsOK.push('Astra (5x Sol usage)');
  // onTTADK also matches the TRAE fallback; only the actual TTADK account has the max-effort exemption.
  if (m.effort === 'max' && !(onTTADK(m) && (balancedAccount ?? TT) === QX.ttadk)) needsOK.push('max effort'); // user, 2026-11-07
}
// Second opinion: the row's cross-vendor pair, or — while Codex is underused — an extra independent Codex review of
// hard Codex work.
let second = m && T.second ? T.second : null;
if (second && m.vendor === second.vendor) second = second.vendor === 'codex' ? C('opus', 'xhigh') : X(SOL, 'xhigh');
// Claude has no room for the cross-vendor second opinion: a fresh TTADK reviewer stands in rather than dropping it.
// A fallback model of another family is preferred over a fresh Sol: a different family has different blind spots.
if (second && !allowed(second) && second.vendor === 'claude' && TT && (altOtherThan(m) || ttHas(SOL))) {
  const alt = altOtherThan(m);
  second = alt ?? X(SOL, 'xhigh');
  notes.push(alt ? `Claude has no room for the second opinion: ${label(alt)} on ${TT.name} stands in (a different model family from the first)` : `Claude has no room for the second opinion: a fresh ${TT.name} Sol reviewer stands in (same model family as the first; say so in the report)`);
}
if (second && !allowed(second)) second = null;
// A Codex-written change reviewed on TTADK gets a second free reviewer from a different model family: Kimi-K3 found
// every planted defect where Sol missed some, and their misses didn't overlap (user, 2026-11-07). Sol when the gateway
// doesn't list Kimi. If Sol and every other family are excluded, a fresh thread on the current company model keeps
// this extra reviewer free; report that it shares the first reviewer's family.
let ttSecondReviewer = false;
if (!second && m && cat === 'review' && authorCodex && onTTADK(m)) {
  second = ttHas(KIMI) && poolOf(m.model) !== 'kimi' ? X(KIMI, 'high') : altOtherThan(m) ?? (ttHas(SOL) ? X(SOL, 'xhigh') : { ...m }); ttSecondReviewer = true;
  const reviewer = second.model === KIMI ? 'Kimi-K3, a different model family,' : poolOf(second.model) !== poolOf(m.model) ? `${second.model}, a different model family,` : `a fresh ${second.model === SOL ? 'Sol' : second.model} thread${isAlt(m) ? ' (same model family; no other eligible company family)' : ''}`;
  notes.push(`second ${TT.kind === 'trae' ? 'TRAE' : 'TTADK'} reviewer (free): ${reviewer} with a different focus — failure paths, concurrency, input edge cases and tests rather than the main logic; merge both reports and keep only P0/P1 items (references/review-rubric.md)`);
}
// Its point is to spend Codex quota that would otherwise be lost, so: only where the review policy wants a review anyway
// (release code, or service code at high stakes; user, 2026-11-07), and never on a TTADK device, whose quota is left
// for the other device.
let extraReview = false;
if (!second && m && m.vendor === 'codex' && !ttDevice && QX.underused && ['implement-hard', 'debug', 'science'].includes(cat) && reviewKind) {
  second = X(SOL, 'xhigh'); extraReview = true;
  notes.push('extra independent Codex review of the result (Codex underused): run it after the worker reports, as a fresh read-only review');
}
if (second) {
  const original = second;
  second = quotaChoice(second, (r) => why.push(`second opinion: ${r}`));
  if (second !== original && poolOf(second.model) === poolOf(m.model)) notes.push('quota substitution leaves the second opinion in the same model family; record this limitation and retain the GPT/Claude acceptance gate in references/review-rubric.md');
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
// Browser work off the company account goes to a browser-ready ChatGPT account.
if (T.kind === 'browser' && !ttBrowser && chatgptBrowser.length && !(acct && acct.a?.browser)) acct = chatgptBrowser[0];
const chatgptAcct = acct;
const ttadkRun = m && onTTADK(m);
const runCompany = balancedAccount ?? TT;
if (ttadkRun) acct = { a: { name: runCompany.name, live: runCompany.live } };
else if (QX.rotate && m?.vendor === 'codex' && QX.rotate.every((r) => !excluded.has(r.a.name))) {
  const n = withLock(RR, () => { let c = 0; try { c = Number(fs.readFileSync(RR, 'utf8')) || 0; } catch {} if (!opts.dry) fs.writeFileSync(RR, String(c + 1)); return c; });
  acct = QX.rotate[n % QX.rotate.length];
}
const pickAcct = acct;
// The second opinion's account: the extra underused review on ChatGPT; any other Codex second opinion TTADK-first.
// The second opinion's account: TTADK first for a Codex second opinion it can run; otherwise the ChatGPT account.
const secondAcct = !second || second.vendor !== 'codex' ? null
  : !extraReview && onTTADK(second) && ttHas(second.model) ? { a: { name: TT.name, live: TT.live } } : ttadkRun ? chatgptAcct : pickAcct;
// Company capacity does not authorize a ladder fall-through or a personal second opinion. Check actual accounts.
const companyAccount = (a) => [QX.ttadk, QX.trae].some((c) => c && c.name === a?.a?.name);
const personalException = (x, secondary) => cat === 'image-gen' || T.kind === 'claudeOnly'
  || (x.vendor === 'claude' && (T.kind === 'browser' || (ttHas(SOL) && (secondary || claudeReviewFirst))));
const personalPicks = [{ x: m, account: pickAcct, secondary: false }, { x: second, account: secondAcct, secondary: true }]
  .filter(({ x, account, secondary }) => x && (x.vendor === 'claude' || !companyAccount(account))
    && (unknownCompanyState || !personalException(x, secondary)));
if (!background && !opts.urgent && ttDevice && personalPicks.length) {
  const selected = personalPicks.map(({ x, account, secondary }) => `${secondary ? 'second opinion' : 'primary'} ${label(x)}${x.vendor === 'codex' ? ` on ${account?.a?.name ?? 'main'}` : ''}`).join('; ');
  needsOK.push(`personal quota: actual selected ${selected}.${unknownCompanyState ? ` company account state unknown (${unknownCompanyReason}).` : ''} Ask the user before launching, even if a company account still has eligible models — go on now on personal quota, or wait for a company account. One answer covers the fall-through/outage: "go on" → pass --urgent for this work; "wait" → hold it until then`);
}
// user-approved 2026-11-11 retro: exec bypasses codex-worker's thread rule; both CLIs accept this string config key.
const credRule = 'Never read, copy or load any login session or credential file (cookies, SSO/session tokens, CLI auth files such as bytedcli\'s, keychain items, .netrc, API keys), and never inject a session into a browser or tool to get past a login. Wherever a login or authorization is needed, stop and report BLOCKED with what needs signing in.';
const execCred = ` -c 'developer_instructions=${JSON.stringify(credRule).replaceAll("'", "'\\''")}'`;
const launch = (x, shape = T.shape, acct = pickAcct) => {
  if (x.vendor === 'claude') {
    return { launcher: 'claude-bg', command: `cd ${cwd} && claude --bg --remote-control --permission-mode ${claudeMode} -n ${name} --model ${x.model} --effort ${x.effort} ${prompt}` };
  }
  const an = acct?.a.name ?? 'main', home = profiles[an]?.home ?? '~/.codex';
  // TRAE CLI: `traecli exec` mirrors `codex exec` (its own home, ~/.trae); models go by TRAE's own ids.
  const traeProf = profiles[an]?.kind === 'trae' ? profiles[an] : QX.trae?.name === an ? QX.trae : null;
  if (traeProf) {
    const id = traeProf.modelIds?.[x.model] ?? x.model;
    // Quota substitution can put Astra on a short row too; keep its queue/status visible through the hub.
    if (shape === 'exec' && x.model !== ASTRA && !backgroundLane) return { launcher: 'traecli-exec', account: an, command: `${traeProf.bin ?? 'traecli'} exec${inRepo === false ? ' --skip-git-repo-check' : ''} -C ${cwd} -s ${sandbox} -m ${id} -c model_reasoning_effort='"${x.effort}"'${execCred} --json -o ${taskDir}/codex-last.md ${prompt} < /dev/null > ${taskDir}/codex.jsonl 2>&1   (background task${inRepo === null ? '; add --skip-git-repo-check outside a repo' : ''})` };
    return { launcher: 'codex-worker', account: an, command: `node ${SKILL}/scripts/codex-worker.mjs --account ${an} start --cwd ${cwd} --model ${id} --effort ${x.effort} --sandbox ${sandbox} --name ${name} --log ${taskDir}/codex.jsonl --out ${taskDir}/codex-last.md ${prompt}   (background task)` };
  }
  // A TTADK codex exec bypasses codex-worker, so it brings the account's proxy up first (exit 6 when it can't).
  const proxyFirst = TT?.search && an === TT.name ? `node ${SKILL}/scripts/codex-worker.mjs --account ${an} proxy >/dev/null && ` : '';
  if (shape === 'exec') return { launcher: 'codex-exec', account: an, command: `${proxyFirst}CODEX_HOME=${home} codex exec${inRepo === false ? ' --skip-git-repo-check' : ''} -C ${cwd} -s ${sandbox} -m ${x.model} -c model_reasoning_effort='"${x.effort}"'${execCred} --json -o ${taskDir}/codex-last.md ${prompt} < /dev/null > ${taskDir}/codex.jsonl 2>&1   (background task${inRepo === null ? '; add --skip-git-repo-check outside a repo' : ''})` };
  // ui-browser also reaches the local dev server (a host pattern matches any port).
  const apps = cat === 'computer-use' && typeof opts.apps === 'string' ? ` --computer-use-apps '${opts.apps.split(',').map((a) => a.trim()).filter(Boolean).join(',')}'` : '';
  const origins = ['browser', 'ui-browser'].includes(cat) ? ` --browser-origins '${[...(cat === 'ui-browser' ? ['localhost', '127.0.0.1'] : []), ...POLICY.browserOrigins, ...(typeof opts.origins === 'string' ? opts.origins.split(',') : [])].map((o) => o.trim()).filter(Boolean).join(',')}'` : '';
  return { launcher: 'codex-worker', account: an, command: `node ${SKILL}/scripts/codex-worker.mjs --account ${an} start --cwd ${cwd} --model ${x.model} --effort ${x.effort} --sandbox ${sandbox} --name ${name}${origins}${apps} --log ${taskDir}/codex.jsonl --out ${taskDir}/codex-last.md ${prompt}   (background task)` };
};
// The same quality gate for both vendors, so outcomes compare: code work gets an independent review before it's accepted.
// Review only where a mistake is costly to undo; reviewers follow references/review-rubric.md (blocking issues only).
if (m && reviewKind) notes.push(`review required (impact ${impact}${stakes === 'high' ? ', high stakes' : ''}${isAlt(m) ? `, written by fallback model ${m.model}` : ''}): after the worker reports, route.mjs ${reviewKind}${background ? ' --background' : ''} --author ${m.vendor}${isAlt(m) ? ` --exclude-model ${poolOf(m.model)}` : ''} --impact ${impact} --project ${typeof opts.project === 'string' ? opts.project : '<slug>'} --name ${name}-R; brief the reviewer with references/review-rubric.md (blocks only on P0/P1, at most 2 rounds); then record with scripts/outcome.mjs --reviewed`);
else if (m && CODE.includes(cat)) notes.push(`no review (impact ${impact}${impact === 'service' ? ', not high stakes' : ''}): accept on your own check (tests, build, acceptance), then record with scripts/outcome.mjs`);
else if (m && cat !== 'review' && cat !== 'review-high' && cat !== 'second-opinion') notes.push('when the task ends: record it with scripts/outcome.mjs (pass | rework --rounds N | fail)');
// Fixed safety clauses for anything that writes or touches devices (SKILL.md, "Give each worker a self-contained brief").
// Every brief (user-approved 2026-11-11): a TRAE DeepSeek worker copied bytedcli's TikTok SSO session file into its
// automation browser to get past a console login.
if (m) notes.push('brief: include the credential clause — never read, copy or load any login session or credential file (cookies, SSO/session tokens, CLI auth files such as bytedcli\'s, keychain items, .netrc, API keys), and never inject a session into a browser or tool to get past a login; wherever a login or authorization is needed, stop and report BLOCKED with what needs signing in');
if (security) notes.push('brief: describe defensive intent and ask for findings with impact and fix; avoid requesting step-by-step exploit code');
if (m && ['implement', 'implement-hard', 'debug'].includes(cat)) notes.push('DeepSeek: read-only analysis and simple edits only; not full-package builds, auth/storage reviews or acceptance — re-route with --exclude-model deepseek if the brief needs those');
// user-approved 2026-11-11 retro: W291-R0 review misses and ppe2a's unnecessary rollback.
if (isAlt(m) && ['review', 'review-high'].includes(cat)) notes.push('release/high-stakes acceptance also requires an independent other-family GPT/Claude reviewer and the failure probes in references/review-rubric.md; if unavailable, report BLOCKED');
if (m && cat === 'build-run') notes.push('deploy/release brief: pin baseline/control probes, health thresholds, sample intervals and observation window, rollback triggers and exact prior artifact/config restore steps before acting; a fallback model follows these only — unexpected evidence needs stronger-model judgment, stop and report rather than invent a rollback condition');
if (m && writes) notes.push('brief: include the safety clauses — never overwrite, delete or move files outside the task\'s scope (user files, uncommitted changes, shared headers/configs); restore anything touched by mistake byte-for-byte and report it');
if (m && ['build-run', 'implement', 'implement-hard', 'debug', 'ui-browser', 'computer-use'].includes(cat)) notes.push('brief: on devices and simulators, back up app data before any destructive step (reinstall with --remove-existing-content, wiping app containers or Documents, erasing simulators), or ask first');
if (m && ['build-run', 'ui-browser', 'computer-use'].includes(cat)) notes.push('before builds/device runs: identify orphaned build/test process trees of finished tasks by task directory and clean only those; never kill other tasks\' processes. Mini: at most 3 concurrent heavy builds unless the ledger sets N otherwise (not a model-worker concurrency cap). Device lease: at most 2 h, then return the device and report; brief preflight: device connected, unlocked, app data backed up');
// Claude browser workers can reach the user's signed-in Chrome; a worker that can't find it must not hand the clicking back
// to the orchestrator (nightly review 11-05: W258 blocked on "can't see local browser 1e7c2b37", the user then chose
// "orchestrator does the console", and that orchestrator made 510 browser calls in 24h).
if (m && ['ui-browser', 'computer-use'].includes(cat)) notes.push('brief: name the Chrome to use by its deviceId from the ledger (the user picks it once; mcp__claude-in-chrome__list_connected_browsers lists them) and tell the worker: if a browser tool says several browsers are connected, call select_browser with that deviceId; if the browser still isn\'t reachable, report BLOCKED with the tool\'s exact error, never ask the orchestrator to click for it. Headless Playwright is fine where the user\'s sign-in isn\'t needed');
if (m && cat === 'computer-use') {
  if (m.vendor === 'codex') {
    notes.push(`brief: use Computer Use via node_repl as the computer-use skill says (bootstrap: globalThis.sky = (await import("@oai/sky")).sky;); operate only the apps given${opts.apps ? '' : ' — pass them to route.mjs with --apps <bundle ids>, e.g. --apps com.apple.Notes; without it every app is declined'}; ask (report BLOCKED) before anything irreversible: sending, deleting, purchases, changing settings`);
    notes.push('the screen must stay unlocked: codex-worker exits 5 on a locked Mac — tell the user and retry after they unlock');
  } else notes.push('a terminal Claude worker has no desktop computer-use tool (only Claude in Chrome for web pages): if this needs a desktop app, set up TTADK browser-setup on this machine or ask the user, rather than launching a worker that will report BLOCKED');
}
if (m && ['browser', 'ui-browser'].includes(cat)) notes.push('brief: include the browser safety clause — read and navigate freely, but ask the user (AskUserQuestion; a Codex worker reports BLOCKED) before anything irreversible on a page: submitting a form that changes data, approving, deleting, publishing, sending a message, payments');
// Every worker can search the web (Codex and Claude Code have it on by default; TTADK through its proxy).
if (m) notes.push('brief: web searches go to the public internet — never put internal code, internal project or product names, people, internal URLs or secrets into a search query; search for the public topic only');
if (ttadkRun && runCompany.kind === 'trae') {
  notes.push(`on TRAE CLI (account ${runCompany.name}; ${backgroundLane ? 'background lane' : balancedAccount ? 'balanced from TTADK' : `TTADK is ${QX.ttadk ? 'out' : 'absent'}`}): a hub worker printing \`queued: position N\` is waiting in TRAE's queue — let it wait; only interrupt a worker with no events at all for 15 minutes, or an exec run, and re-route with --exclude-model ${poolOf(m.model)} (the next model family takes it; an infrastructure miss, so the same --failures); on account failures (login, auth) re-route with --exclude-account ${runCompany.name}. codex-worker records failures per model family (queue full pauses 5→10→20→30 min; vendor restriction waits until next 00:00 UTC / 08:00 China time, then a recovery probe; a failed restriction probe waits until the following 00:00 UTC; other hard failures such as quota pause 30 min, then a probe; auth pauses the account; route.mjs then uses the next family); for a failed or interrupted traecli exec run, record it yourself: node ${SKILL}/scripts/codex-worker.mjs --account ${runCompany.name} note-failure --model ${m.model} "<error>"`);
  if (backgroundLane) notes.push('background: expect hours; each model request queues separately. Launch as a hub worker so queue/status shows; do not interrupt while queued: lines arrive. The orchestrator keeps dispatching other work meanwhile. TRAE assigns request priority from its quota state; this routing flag does not force a provider priority tier while high-priority quota remains.');
  // Astra on TRAE is slow but works (2026-11-13): keep it a hub worker so its queue/status lines are visible.
  if (m.model === ASTRA) notes.push('Astra on TRAE queues TRAE-wide (≈15 min seen 2026-11-13); launch it as a hub worker (codex-worker start), not traecli exec, so queue/status shows; the 30-min stall alarm doesn\'t fire while queue/status keeps arriving');
  if (!backgroundLane) notes.push('hub queue position above ~300: if that model\'s daily bucket is depleted, re-routing is worth it for the next dispatch with --exclude-model <that model> and the same --failures; for non-depleted or unknown buckets let it wait. Accepted queued turns stay pending: do not interrupt or launch a duplicate; keep parallel task concurrency unchanged');
  const q = runCompany.quota?.daily?.[m.model];
  if (q?.depleted && !backgroundLane) notes.push(`TRAE ${m.model}'s daily high-priority quota is used up${q.resetsAt ? ` until ${fmt(q.resetsAt)}` : ''}: requests queue in the low-priority lane. Above ~300, consider --exclude-model ${m.model} for the next dispatch (same --failures); keep any accepted queued turn pending`);
  notes.push('brief (TRAE): no ChatGPT browser here — playwright MCP is for public/local pages only; signed-in consoles require a browser-ready worker with console origins and a signed-in browser/account named in the brief; missing login means BLOCKED, never a Playwright sign-in workaround; git commits must carry no co-author or tool trailer');
  if (!runCompany.live && (T.shape !== 'exec' || backgroundLane)) notes.push(`TRAE hub is down: start it first — node ${SKILL}/scripts/codex-worker.mjs --account ${runCompany.name} hub`);
}
if (ttadkRun && ['build-run', 'review', 'review-high'].includes(cat)) {
  const q = runCompany.kind === 'trae' ? runCompany.quota?.daily?.[m.model] : runCompany.usage;
  const usedPercent = q?.utilization ?? (q?.used != null && q.limit > 0 ? 100 * q.used / q.limit : null);
  if (usedPercent >= 80) notes.push(`long builds/large reviews: ${runCompany.name} ${m.model}'s daily bucket is ${Math.round(usedPercent)}% used; consider starting just after the daily reset ${q.resetsAt ? `at ${new Date(q.resetsAt).toISOString()} (quota resetTime)` : `(normally ${runCompany.kind === 'trae' ? '22:00' : '16:00'} UTC)`}; TRAE normally 22:00 UTC, TTADK 16:00 UTC. Advisory only: do not defer work or reduce parallel task concurrency automatically`);
}
if (ttadkRun && m.model === 'gemini-3.1-pro-preview' && !backgroundLane) notes.push('Gemini-3.1-Pro ran past 40 minutes in 3 of 12 benchmark runs: if it shows no progress for 20 minutes, or runs past twice what the task should take, interrupt it and re-route with --exclude-model gemini (same --failures)');
if (ttadkRun && isAlt(m)) notes.push(`brief (${m.model}): state the exact output format and the done check; it has no ChatGPT browser or image tools`);
if (ttadkRun && isAlt(m) && !ALTS.find((a) => a.model === m.model)?.vision) notes.push(`${m.model} can't see images: if the task depends on screenshots or images, re-route with --exclude-model ${poolOf(m.model)} (Sol, or Seed-Evolving for image-read, reads them), or route the image reading on its own as image-read`);
if (ttadkRun && runCompany.kind !== 'trae') {
  if (runCompany.search) notes.push(`TTADK runs through its local proxy (web search): exit 6 with proxy-unavailable → re-route with --exclude-account ${runCompany.name}`);
  else notes.push(`this TTADK account has no web search (rerun codex-worker.mjs ttadk-setup to add its proxy): if the task turns out to need the web, re-route it as research`);
  notes.push(`on TTADK (account ${runCompany.name}): if the run fails rate-limited (QPM / concurrency), retry it once there; if it fails again, or fails for TTADK reasons (SSO, auth, gateway errors), re-route with --exclude-account ${runCompany.name}`);
  if (!runCompany.live && (T.shape !== 'exec' || backgroundLane)) notes.push(`TTADK hub is down: start it first — node ${SKILL}/scripts/codex-worker.mjs --account ${runCompany.name} hub`);
}
if (m && ['browser', 'ui-browser'].includes(cat)) {
  notes.push('Chrome must be running before the worker starts (workers can\'t launch it): pgrep -x "Google Chrome" >/dev/null || open -a "Google Chrome"');
  if (m.vendor === 'codex') notes.push(`"Browser is not available: chrome" (codex-worker prints browser-unavailable:) means the Chrome extension host is briefly disconnected: wait a minute, retry once, then re-route with --exclude-account ${acct?.a?.name ?? TT?.name}`);
  if (m.vendor === 'codex') notes.push(`brief: include the "Codex browser brief" clauses from references/codex-workers.md (plugin bootstrap from ${(ttadkRun ? TT?.chromePlugin : acct?.a?.chromePlugin) ?? TT?.chromePlugin ?? '<chrome plugin>'}/scripts/browser-client.mjs; work in tabs you create; a tab your own click opens may be claimed via user.openTabs()/claimTab and must be closed; never touch the user's other tabs); sites outside --browser-origins are declined — add them with --origins when the task needs them`);
  else notes.push('Claude browser worker (Claude in Chrome): if the extension reports several browsers, select only this Mac\'s Chrome (deviceId in the ledger); never switch to another connected browser');
}
if (m?.vendor === 'codex' && sandbox === 'workspace-write') notes.push('workspace-write can\'t run git writes: brief the worker to edit only and report the files and a commit message; you review and commit');
if (m?.vendor === 'codex' && acct && !acct.a.live) notes.push(T.shape === 'exec' && !backgroundLane ? `account ${acct.a.name}'s reading is stale (its hub is down); codex exec still works` : `account ${acct.a.name}'s hub is down — start it first: codex-worker.mjs --account ${acct.a.name} hub`);
if (!QX.readable && m?.vendor === 'codex') notes.push('Codex usage unreadable; routing as if it has room');
const lands = (a) => !!a && !!redeemAcct && a.a.name === redeemAcct.a.name && !chatgptOpen.some((r) => r.a.name === a.a.name);
const redeemFirst = ((m?.vendor === 'codex' && !ttadkRun && lands(pickAcct)) || (second?.vendor === 'codex' && lands(secondAcct)))
  ? `redeem a reset card on ${QX.redeem.a.name} first (with the user's OK; if declined, re-run with --no-redeem): ${QX.redeem.cp.line}` : null;
// Deferred only when nothing can run it now; never silently (user, 2026-11-09).
if (deferred && background) tell.push(`background task is queued for later (${deferred.split(' — ')[0]}): tell the user; continue dispatching other ready work, with no personal quota`);
else if (deferred) tell.push(`this can't run right now (${deferred.split(' — ')[0]}): tell the user and ask how to proceed — don't just hold it`);
if (security && m && ((ttCapable && TT.kind === 'trae') || (companyOut && QX.trae?.usable && !excluded.has(QX.trae.name)))
  && QX.trae.models.some((x) => poolOf(x) === 'gpt' && !modelExcluded(x)))
  why.push(`security task: TRAE's GPT excluded (OpenAI policy restricted it after exploit-style reviews, 2026-11-10/11) → ${label(m)}${ttadkRun ? ` on ${TT.name}` : m.vendor === 'codex' && pickAcct ? ` on ${pickAcct.a.name}` : ''}`);
const out = {
  category: cat, stakes, failures, security, background, deferred,
  pick: m ? { ...m, ...launch(m), sandbox: m.vendor === 'codex' ? sandbox : null } : null,
  secondOpinion: second ? { ...second, ...launch(second, second === T.second ? T.shape : 'worker', secondAcct) } : null,
  needsUserOK: needsOK, tellUser: tell, why, notes, redeemFirst, balance, quota: leanLines(st, data),
};
// Every real routing decision is logged for the nightly review (--dry or ROUTE_LOG=0 to skip, e.g. for experiments).
if (!opts.dry && process.env.ROUTE_LOG !== '0') {
  const rec = { t: Date.now(), project: typeof opts.project === 'string' ? opts.project : null, name: typeof opts.name === 'string' ? opts.name : null, category: cat, stakes, failures, impact, review: reviewKind, excluded: [...excluded], ttadk: !!ttadkRun, company: ttadkRun ? runCompany.name : null, balance,
    autoCheck: !!opts['auto-check'], noRedeem, security, background, deferred, pick: m ? { vendor: m.vendor, model: m.model, effort: m.effort, account: out.pick?.account ?? null } : null,
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
