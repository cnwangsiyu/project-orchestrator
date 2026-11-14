#!/usr/bin/env node
// route: pick vendor, model, effort, account and the exact launch command for one task, deterministically.
//
//   route <category> [--stakes low|normal|high] [--auto-check] [--failures N] [--writes | --read-only]
//                    [--against claude|codex] [--no-redeem] [--project SLUG] [--dry]
//                    [--impact release|service|throwaway]   (required for implement, implement-hard, debug, science)
//                    [--env test|prod] [--no-local-build]   (procedural deploys: test env implies the light tier)
//                    [--exclude-account a,b] [--exclude-model m,family] [--origins p,q] [--mode <orchestrator mode for Codex sandbox>] [--cwd DIR] [--task-dir DIR]
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
import { balanceFactors, hasTraeDailyQuota, ttadkExpiringUnused, TTADK_EXPIRY_HINT } from './lib/company-load.mjs';
import { normalizeLadder } from './lib/model-ladder.mjs';
import { loadDigest } from './lib/global-rules.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RR = process.env.ROUTE_RR || path.join(SHARED, 'route-rotation.txt'); // launch counter for account rotation
const C = (model, effort) => ({ vendor: 'claude', model, effort });
const X = (model, effort) => ({ vendor: 'codex', model, effort });
const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra', TERRA = 'gpt-6.1-terra', LUNA = 'gpt-6-luna';
// User-approved difficulty policy, 2026-11-13. Astra's bucket is reserved for hard work.
const COMPANY_TIERS = Object.freeze({
  hard: [SOL, ASTRA],
  normal: [SOL, 'gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-v4.1-flash'],
  light: ['gpt-5.6-terra', 'gpt-5.5', 'deepseek-v4.1-flash'],
});
const TRAE_BUCKETED = new Set([SOL, ASTRA, 'gpt-5.6-sol']);
// TTADK's light list (user, 2026-11-13): the gateway's lightest capable models first, 6.1-Sol only as the
// escalation/fallback step. Hard and normal work on TTADK still starts at 6.1-Sol.
const TTADK_LIGHT = ['gpt-5.6-terra', 'gpt-5.5', SOL];
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
  { model: 'seed-evolving', effort: 'medium', vision: true, visionOnly: true }];
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
const BOOL = new Set(['auto-check', 'writes', 'read-only', 'fresh', 'json', 'table', 'no-redeem', 'dry', 'urgent', 'security', 'adversarial', 'background', 'device-lease', 'shared-lock', 'no-local-build']);
// --urgent: run now even while TTADK is down for a fixable reason (that work would otherwise wait for the fix).
// --exclude-account a,b: route around accounts that just failed (e.g. TTADK after a rate-limited retry or an auth error).
// --exclude-model m,f: route around models (an id, or a family: gpt, deepseek, gemini…) that just failed for
// infrastructure reasons (queue full, restricted, timed out) on the company account — not a --failures step; also how a
// review of a fallback model's code keeps that model's family off the reviewer seat.
// --security: security/attack-flavoured tasks exclude GPT only on TRAE; other accounts route normally.
// --adversarial: attack-style reviews (and --adversarial work) run on company non-GPT models only, with a second
// reviewer from the other non-GPT family; it implies --security. A review/review-high/second-opinion with --security
// is adversarial by default (OpenAI's cyberPolicy blocked a GPT review on 2026-11-13; user decision, option A).
// --background: nobody is waiting; prefer TRAE unless TTADK quota is expiring unused, never personal quota.
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
// --env test: PPE/staging/dev deploys and smoke runs against a test environment (light procedural work).
// Production stays --env prod / the default. The flag is meaningful for build-run; it never downgrades code work.
const env = opts.env === undefined ? 'prod' : opts.env;
if (!['test', 'prod'].includes(env)) die(`--env takes test or prod, not ${opts.env}`);
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
const security = !!opts.security || !!opts.adversarial;
// Adversarial: attack-style material must never reach a GPT account. --adversarial always means it; a review routed
// with --security is adversarial by default (other --security work keeps today's TRAE-only GPT exclusion).
const adversarial = !!opts.adversarial || (security && ['review', 'review-high', 'second-opinion'].includes(cat));
const background = !!opts.background;
// A production release/deploy keeps 6.1-Sol medium and the pinned health/rollback brief: build-run --impact release
// outside --env test, or high stakes. A test-environment build-run (PPE/staging/dev) is procedural and light.
const productionBuild = cat === 'build-run' && ((impact === 'release' && env !== 'test') || stakes === 'high');
const lightRow = ['lookup', 'extract', 'draft'].includes(cat) || stakes === 'low' || background
  || (env === 'test' && cat === 'build-run');
const tierFor = (f) => ['implement-hard', 'debug', 'science', 'review-high', 'design'].includes(cat) || stakes === 'high'
  || (f >= 1 && CODE.includes(cat)) ? 'hard'
  : productionBuild ? 'normal'
  : f >= 1 && lightRow ? 'normal'
  : lightRow ? 'light' : 'normal';
const tier = tierFor(failures);
const laneEligible = T.kind !== 'browser' && T.kind !== 'claudeOnly'
  && !['build-run', 'image-gen', 'image-read'].includes(cat) && !opts['device-lease'] && !opts['shared-lock'];
// Background image reading can wait on a vision model; opportunistic company balancing still excludes images.
const backgroundEligible = laneEligible || (cat === 'image-read' && !opts['device-lease'] && !opts['shared-lock']);
const excluded = new Set((typeof opts['exclude-account'] === 'string' ? opts['exclude-account'] : '').split(',').map((x) => x.trim()).filter(Boolean));
const exModels = new Set((typeof opts['exclude-model'] === 'string' ? opts['exclude-model'] : '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const modelExcluded = (model, account = null) => exModels.has(model) || exModels.has(poolOf(model))
  || (adversarial && poolOf(model) === 'gpt')
  || (security && account?.kind === 'trae' && poolOf(model) === 'gpt');
// Adversarial review rows are the one approved exception to the sensitive-review DeepSeek model-fit rule: they use
// the other non-GPT family as second reviewer. The exception does not apply to adversarial work in other categories;
// in particular, build-run never uses DeepSeek.
const adversarialReview = adversarial && ['review', 'review-high', 'second-opinion'].includes(cat);
const deepseekUnfit = cat === 'build-run' || (!adversarialReview && (cat === 'review-high'
  || (['review', 'second-opinion'].includes(cat) && (impact === 'release' || stakes === 'high' || security))));
const tierModels = (account, taskTier = tier) => {
  const list = account?.kind === 'trae' ? (cat === 'image-read' ? [SOL, ASTRA] : COMPANY_TIERS[taskTier])
    : account?.kind === 'ttadk' && taskTier === 'light' ? (cat === 'image-read' ? [SOL, ASTRA] : TTADK_LIGHT) : null;
  return list ? list.filter((id) => account.models.includes(id) && !modelExcluded(id, account)
    && !(deepseekUnfit && poolOf(id) === 'deepseek')) : [];
};
const bucketFreeModels = (account, taskTier = tier) => account?.kind === 'trae' && hasTraeDailyQuota(account.quota) && cat !== 'image-read'
  ? tierModels(account, taskTier).filter((id) => !TRAE_BUCKETED.has(id) && !Object.hasOwn(account.quota.daily, id)) : [];
// ChatGPT accounts (the quota-managed ones): out when every open account is spent/excluded and no card is due.
const chatgptOpen = (QX.open ?? []).filter((r) => !excluded.has(r.a.name));
const chatgptOut = QX.out || (noRedeem && !QX.pick && !!QX.redeem)
  || (!chatgptOpen.length && !(QX.redeem && !noRedeem && !excluded.has(QX.redeem.a.name)) && (QX.rows ?? []).some((r) => r.known && !excluded.has(r.a.name)))
  || (!chatgptOpen.length && (QX.rows ?? []).length > 0 && (QX.rows ?? []).every((r) => excluded.has(r.a.name)));
// TTADK (company gateway): preferred for Codex work whenever it is healthy and not excluded (user, 2026-11-07). When it
// isn't (its daily quota used up, down, or excluded), TRAE CLI — the second company account — takes the same work under
// the same rules, before personal quota (user, 2026-11-08). TT is whichever company account takes Codex work now.
const taskFits = (a) => T.kind !== 'claudeOnly' && cat !== 'image-gen'
  && !(cat === 'research' && !a.search) && !(T.kind === 'browser' && !a.browser);
// Hard work never falls to a weaker fallback (user rule 2026-11-13, effective 2026-11-14): a depleted hard bucket
// queues on TRAE's low-priority lane; it is not replaced by DeepSeek or 5.6. Hard means Sol/Astra on a company account.
const routingModelFits = (model, account) => model === SOL || tierModels(account).includes(model)
  || (adversarial && model === KIMI && account?.kind === 'ttadk' && cat !== 'image-read')
  || ((tier !== 'hard' || adversarial) && ALTS.some((a) => a.model === model && (cat === 'image-read' ? a.vision : !a.visionOnly)
    && !(deepseekUnfit && poolOf(model) === 'deepseek')));
const expiringUnused = QX.ttadk?.usable && !excluded.has(QX.ttadk.name) && ttadkExpiringUnused(QX.ttadk);
const preferExpiringTtadk = expiringUnused && (background && backgroundEligible || tier === 'light' && laneEligible);
const companyOrder = background && backgroundEligible && !preferExpiringTtadk ? [QX.trae, QX.ttadk] : [QX.ttadk, QX.trae];
const TT = companyOrder.find((a) => a?.usable && !excluded.has(a.name)
  && (!background || taskFits(a)) && a.models.some((x) => !modelExcluded(x, a) && (!background || routingModelFits(x, a)))) ?? null;
const backgroundLane = background && backgroundEligible && TT?.kind === 'trae';
// A TTADK device (a TTADK account is set up here): TTADK always first, and the shared ChatGPT and Claude quota is left
// for the user's other device, which has no TTADK (user, 2026-11-07). So no rule here spends quota for its own sake:
// no underused/front-load/expiring effort raises and no extra quota-spending reviews. Without TTADK nothing changes.
const ttDevice = !!QX.ttadk || !!QX.trae || QX.companyAccounts.length > 0 || !!QX.registryError;
const ttHas = (model) => !!TT && TT.models.includes(model) && !modelExcluded(model, TT);
// Light work may run on TTADK's lightest listed model even when its account-level Sol is absent/excluded.
const ttadkLightModels = () => TT?.kind === 'ttadk' ? TTADK_LIGHT.filter((id) => ttHas(id)) : [];
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
const ttTierModels = tierModels(TT);
// A light row stays company-capable on a retry even when the account lists only light models: the retry tier is normal,
// but the ladder still escalates from the light first rung (TTADK's light list or TRAE's light tier). A light row whose
// account lists no light model may still use a normal-tier model, so company quota is spent before personal quota.
const ttLightTierModels = TT?.kind === 'ttadk' ? ttadkLightModels() : TT?.kind === 'trae' ? tierModels(TT, 'light') : [];
// Hard work needs a hard-tier company model (Sol or Astra); fallback families are not company capacity for it.
const ttModelsOK = tier === 'hard'
  ? ttHas(SOL) || ttHas(ASTRA)
  : ttHas(SOL) || ttAlts.length > 0 || ttTierModels.length > 0
    || (lightRow && (ttLightTierModels.length > 0 || tierModels(TT, 'normal').length > 0));
const companyPick = (id, effort) => X(id, ALTS.find((a) => a.model === id)?.effort ?? effort);
// Light procedural work (test-env build-run, lookup/extract/draft, low stakes, background) starts on the company
// account's light list instead of Sol medium: TTADK's gpt-5.6-terra/gpt-5.5, TRAE's light tier. A failure escalates to
// Sol medium (the ladder below then climbs as usual); it never steps sideways onto another light model.
const ttLightPick = () => {
  if (!TT) return null;
  // Image reading needs a vision model; the light lists don't carry one (the image-read override is Sol/Astra), so keep
  // its existing routing rather than starting on a non-vision light model or on Astra.
  if (cat === 'image-read') return null;
  if (TT.kind === 'trae') { const id = tierModels(TT, 'light')[0]; return id ? companyPick(id, 'medium') : null; }
  const id = ttadkLightModels()[0];
  return id ? X(id, 'medium') : null;
};
const priorityAvailable = (id, account) => {
  if (!hasTraeDailyQuota(account.quota)) return false;
  if (!Object.hasOwn(account.quota.daily, id)) return !TRAE_BUCKETED.has(id);
  const q = account.quota.daily[id];
  return q?.depleted === false && (q.remaining > 0 || (q.used != null && q.limit > q.used));
};
// A fallback of a different family from model x (a reviewer or a retry that doesn't share x's blind spots).
const altOtherThan = (x) => ttAlts.find((a) => poolOf(a.model) !== poolOf(x?.model)) ?? null;
const codexOut = chatgptOut && !ttModelsOK; // An account with only excluded or unsupported models can't take work.
// ---- adversarial (attack-style) routing ----
// User decision 2026-11-13 (option A): a GPT review of attack-style material hit OpenAI's cyberPolicy on TTADK; the
// adversarial lane never uses a GPT model on any account. Order: TTADK Kimi-K3 (high) -> DeepSeek-V4.1-Flash on
// TTADK or TRAE (high; the one approved exception to the DeepSeek model-fit rule, valid only with its second
// reviewer) -> Claude Opus, which always asks for personal quota. The second reviewer comes from the other non-GPT
// family (Kimi <-> DeepSeek); when only one family is available, say so and ask (Claude second, or one reviewer).
const ADV_DEEPSEEK = 'deepseek-v4.1-flash';
const adversarialModelFits = (model, account) => taskFits(account) && cat !== 'image-gen'
  && (cat !== 'image-read' || ALTS.some((a) => a.model === model && a.vision))
  && !(deepseekUnfit && poolOf(model) === 'deepseek');
const advCompany = (model) => [QX.ttadk, QX.trae].find((a) => a?.usable && !excluded.has(a.name)
  && a.models.includes(model) && !modelExcluded(model, a) && adversarialModelFits(model, a)) ?? null;
// The user's order names Kimi-K3 on TTADK only; DeepSeek-V4.1-Flash may run on TTADK or TRAE.
const advKimi = () => {
  const a = QX.ttadk;
  return a?.usable && !excluded.has(a.name) && a.models.includes(KIMI) && !modelExcluded(KIMI, a)
    && adversarialModelFits(KIMI, a) ? X(KIMI, 'high') : null;
};
const advDeepseek = () => (advCompany(ADV_DEEPSEEK) ? X(ADV_DEEPSEEK, 'high') : null);
const advClaude = () => C('opus', ['review', 'review-high'].includes(cat) ? 'xhigh' : 'high');
const adversarialBase = () => {
  const company = [advKimi(), advDeepseek()].filter(Boolean);
  return company.length ? [...company, advClaude()] : [advClaude()];
};
// The other non-GPT family for a company pick, or null when only one family is available.
const advSecondFor = (pick) => poolOf(pick?.model) === 'kimi' ? advDeepseek() : poolOf(pick?.model) === 'deepseek' ? advKimi() : null;
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
const allowed = (x) => background ? x.vendor === 'codex' && !!TT && taskFits(TT) && (ttHas(x.model) || (adversarial && !!advCompany(x.model)))
  : (x.vendor === 'claude' ? claudeAllowed(T.kind) : !modelExcluded(x.model) && (T.kind === 'browser' ? browserViaCodex : (!codexOut || adversarial)));

// ---- 1. vendor locks, quota moves and the escalation ladder ----
// The usable ladder: the first pick (or its same-tier alternative when quota rules it out), then every later step the
// quota allows. --failures N takes step N, so each failure moves up even when some steps are ruled out.
let base;
if (cat === 'second-opinion') {
  base = opts.against === 'claude' ? [T.first, ...T.ladder] : [T.alt, C('opus', 'xhigh'), ...(TT && ttHas(SOL) ? [X(SOL, 'xhigh')] : tier === 'hard' ? [] : ttAlts.slice(0, 1))];
  why.push(`second opinion from the other vendor than ${opts.against}`);
}
else if (T.kind === 'browser' && !browserViaCodex) base = [T.alt, C('opus', 'high')];
else if (authorCodex && !(cat === 'review' && ttModelsOK)) {
  base = [cat === 'review' ? T.alt : T.first, C('opus', 'xhigh'), X(SOL, 'xhigh')];
  if (!ttAlts.length || ttHas(SOL)) why.push('Codex wrote it: Claude reviews first (Codex only when Claude has no room)');
}
else base = [T.first, ...T.ladder];
if (adversarial) {
  base = adversarialBase();
  why.push('adversarial: no GPT model on any account; company non-GPT models first (Kimi-K3, then DeepSeek-V4.1-Flash), Claude only with the user\'s OK');
}
// Every task TTADK's GPT-6.1 Sol can handle goes to it first (user, 2026-11-07): Sol at the row's effort (at least
// medium), one notch higher after a failure, then the row's own ladder. Not TTADK-capable: Claude-only rows, image
// generation, and browser work while TTADK isn't browser-ready. Codex high-stakes reviews and second opinions keep
// Claude first when company Sol is available; when Sol is unavailable, company fallback families go first.
// research needs web search. Codex doesn't send its hosted web_search tool to the gateway, so TTADK searches only through
// its local proxy (ttadk-setup sets it up: TT.search); without it research follows the earlier routing.
const ttTaskOK = T.kind !== 'claudeOnly' && cat !== 'image-gen';
const ttCapable = !adversarial && ttModelsOK && ttTaskOK && !(claudeReviewFirst && ttHas(SOL) && !background)
  && !(cat === 'research' && !TT.search) && !(T.kind === 'browser' && !ttBrowser);
const ei = (e) => EFFORTS.indexOf(e);
const maxE = (a, b) => (ei(a) >= ei(b) ? a : b);
// Keep balancing pins as control-flow state, not route-rung data: selected rungs are serialized in --json output.
const balancePinned = new WeakSet();
const pinBalance = (x) => { balancePinned.add(x); return x; };
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
if (ttCapable) {
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
  // The ladder's first rung uses the first-attempt tier, not the retry tier: after a light failure the ladder still
  // starts light and the next rung (index 1) is the Sol medium escalation.
  const lightPick = tierFor(0) === 'light' ? ttLightPick() : null;
  const e0 = lightPick ?? X(SOL, companyEffort);
  const cheapRow = ['lookup', 'extract', 'draft', 'browser', 'computer-use'].includes(cat); // browser/desktop misses are UI trouble, not depth
  const rungs = [e0];
  // A light first rung that isn't Sol escalates to Sol medium before the usual Sol ladder: the retry costs more, it
  // doesn't try a second light model sideways. Only when the company account can actually run Sol — otherwise the
  // notches below keep the light pick's own model and a higher effort is the next rung, never an unlisted Sol.
  if (lightPick && lightPick.model !== SOL && ttHas(SOL)) rungs.push(pinBalance(X(SOL, 'medium')));
  while (ei(rungs.at(-1).effort) < ei('xhigh')) rungs.push(notch(rungs.at(-1), +1));
  // After Sol xhigh has fallen short, a different model family before Sol max (its misses rarely overlap Sol's: Kimi,
  // 2026-11-07; DeepSeek, 2026-11-10), and the second fallback after Sol max — all before personal quota.
  // A different-family fallback between Sol xhigh and Sol max helps normal work; hard work never uses one (user rule
  // 2026-11-13: no DeepSeek or 5.6 for hard tasks), so its ladder is Sol/Astra only.
  if (tier !== 'hard' && ttAlts[0]) rungs.push(ttAlts[0]);
  if (!cheapRow) rungs.push(X(SOL, 'max'));
  if (tier !== 'hard' && !cheapRow && ttAlts[1]) rungs.push(ttAlts[1]);
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
let m = null;
let balance = null, balancedAccount = null;

// ---- 2. effort ----
// Resolve effort and availability for every rung before selecting a retry; equal/lower actual steps are dropped.
// TTADK takes the Codex pick when the gateway has its model; when the ChatGPT accounts are out, it also takes models it
// lacks as Sol. Image generation never runs there, not even its Sol fallback step: the gateway has no image tool.
// research without the search proxy stays off TTADK on every step, fallbacks included (nightly review 11-07 dry run).
const onTTADK = (x) => x?.vendor === 'codex' && !!TT && taskFits(TT) && (ttHas(x.model)
  || (balancedAccount?.models.includes(x.model) && !modelExcluded(x.model, balancedAccount)) || (chatgptOut && ttModelsOK));
// TRAE sets request priority. Prefer models that avoid daily high-priority spend; missing telemetry is not free quota.
const backgroundChoice = (x, log, taskTier) => {
  const daily = TT.quota?.daily;
  const known = hasTraeDailyQuota(TT.quota);
  const candidates = tierModels(TT, taskTier), freeModels = bucketFreeModels(TT, taskTier);
  if (cat !== 'image-read') {
    // Preserve quality-ladder Astra/fallback rungs; background never downgrades a hard GPT to a cheap one.
    const ids = x.model === ASTRA || (taskTier === 'hard' && x.model !== SOL) ? [x.model]
      : taskTier === 'hard' ? candidates : [...freeModels, ...candidates.filter((id) => daily?.[id]?.depleted)];
    const id = known ? ids[0] : null;
    if (id) {
      const free = !TRAE_BUCKETED.has(id) && !Object.hasOwn(daily, id), depleted = daily[id]?.depleted;
      const step = free ? poolOf(id) === 'gpt' ? 1 : 2 : depleted ? 1 : 3;
      log(`background: ${id} ${free ? 'has no daily bucket → no high-priority quota spent, no low-priority lane' : depleted ? 'bucket depleted → low-priority lane, no high-priority quota spent' : 'normal TRAE pick — spends high-priority quota when available'} (step ${step})`);
      return id === x.model ? x : companyPick(id, x.effort);
    }
    if (known && daily[x.model]?.depleted) {
      log(`background: ${x.model} bucket depleted → low-priority lane, no high-priority quota spent (step 1)`);
      return x;
    }
    log(`background: normal TRAE pick ${label(x)} — ${known ? 'no eligible tier preference; spends high-priority quota when available' : 'no daily quota info; may spend high-priority quota'} (step 3); TRAE decides request priority`);
    return x;
  }
  if (known) {
    // Image-reading retains its independent vision order, never the untested cheap GPTs.
    const depleted = (x.model === ASTRA ? [ASTRA] : [SOL, ASTRA]).find((id) => ttHas(id) && daily[id]?.depleted === true);
    if (depleted) {
      log(`background: ${depleted === SOL ? 'GPT-6.1-Sol' : 'GPT-6-Astra'} bucket depleted → low-priority lane, no high-priority quota spent (step 1)`);
      return depleted === x.model ? x : X(depleted, x.effort);
    }
    const unbucketed = x.model === ASTRA ? null : ['seed-evolving']
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
const quotaChoice = (x, log = (r) => why.push(r), taskTier = tier) => {
  // Adversarial picks are fixed by family and approval; quota substitution must never turn one into a GPT model.
  if (adversarial) return x;
  if (!onTTADK(x) || TT.kind !== 'trae') return x;
  if (backgroundLane) return backgroundChoice(x, log, taskTier);
  const free = bucketFreeModels(TT, taskTier);
  if (taskTier === 'light' && laneEligible && x.model !== ASTRA && free[0]) {
    const id = free[0];
    log(`light TRAE tier: ${id} has no daily bucket → no high-priority quota spent, no low-priority lane`);
    return id === x.model ? x : companyPick(id, x.effort);
  }
  if (!TT.quota?.daily?.[x.model]?.depleted) return x;
  const candidates = x.model === ASTRA ? [] : tierModels(TT, taskTier);
  const id = candidates.find((id) => id !== x.model && priorityAvailable(id, TT));
  const gpt = id && poolOf(id) === 'gpt';
  // Hard work has no weaker fallback: a depleted Sol/Astra stays queued (TRAE low-priority lane) instead of moving to
  // DeepSeek or 5.6 (user rule 2026-11-13, effective 2026-11-14).
  const sub = id ? companyPick(id, x.effort)
    : taskTier === 'hard' ? null
    : ttAlts.find((a) => a.model !== x.model && !TT.quota.daily[a.model]?.depleted);
  log(`TRAE ${x.model}'s daily high-priority bucket is depleted → ${sub ? `${label(sub)} (${gpt ? 'comparable GPT with quota left' : 'eligible company fallback'})` : taskTier === 'hard' ? 'keep the queued hard-tier model: no weaker substitution (TRAE low-priority lane)' : 'keep the queued model: no eligible alternative with quota left'}; parallel task concurrency is unchanged`);
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
const availabilityChoice = (x, taskTier, log) => {
  // A light row whose account lists no light model still uses the company's normal-tier model (a comparable GPT with
  // quota) before personal quota; the light list stays first when it has a candidate. Hard work substitutes only a
  // hard-tier model (Sol/Astra): with neither available it drops to the next rung (Claude), never to DeepSeek or 5.6.
  const lightFallback = taskTier === 'light' ? tierModels(TT, 'normal') : [];
  const hardModels = taskTier === 'hard' ? [SOL, ASTRA].filter((id) => ttHas(id)) : [];
  const alts = taskTier === 'hard' ? [] : ttAlts.map((a) => a.model);
  const ids = [...new Set([...hardModels, ...tierModels(TT, taskTier), ...lightFallback, ...alts])];
  const id = ids.find((id) => !TT.quota?.daily?.[id]?.depleted) ?? ids[0];
  if (!id) return null;
  const skipped = ids.filter((m) => m !== id && TT.quota?.daily?.[m]?.depleted);
  const gone = modelExcluded(SOL) ? 'excluded for this task' : modelExcluded(SOL, TT) ? 'excluded for this security task'
    : TT.poolPauses?.gpt ? `paused: ${TT.poolPauses.gpt.reason}` : TT.modelPauses?.[SOL] ? `unavailable: ${TT.modelPauses[SOL].reason}` : 'not listed';
  const sub = companyPick(id, x.effort);
  log(`GPT-6.1-Sol on ${TT.name} ${gone} → its fallback models: ${label(sub)} (availability substitution, not retry rungs)${skipped.length ? `; skipped depleted priority buckets: ${skipped.join(', ')}` : ''}`);
  return sub;
};
const resolveRung = (raw, index) => {
  const messages = [], log = (s) => messages.push(s), taskTier = tierFor(index);
  let x = raw, transfer = null, factors = null;
  if (ttCapable && x.vendor === 'codex' && x.model === SOL && !ttHas(SOL)) x = availabilityChoice(x, taskTier, log);
  else if (onTTADK(x) && !ttHas(x.model) && (ttHas(SOL) || ttHas(ASTRA) || (taskTier !== 'hard' && ttAlts.length))) {
    if (taskTier === 'hard') x = ttHas(ASTRA) ? notch(X(ASTRA, x.effort), 0) : ttHas(SOL) ? notch(X(SOL, x.effort), 0) : null;
    else x = ttHas(SOL) ? notch(X(SOL, x.effort), 0) : ttAlts[0];
    if (x) log(`${raw.model} isn't on ${TT.name} and the ChatGPT accounts are out → ${label(x)} on ${TT.name}`);
  }
  if (!x) return null;
  x = tune(quotaChoice(x, log, taskTier), index, log);
  // Resolve balancing before normalization too; keep its account and telemetry with this rung only.
  if (preferExpiringTtadk && onTTADK(x) && TT === QX.ttadk) log(TTADK_EXPIRY_HINT);
  if (!adversarial && !background && !preferExpiringTtadk && onTTADK(x) && TT === QX.ttadk && QX.trae) {
    const free = x.model !== ASTRA ? bucketFreeModels(QX.trae, taskTier) : [];
    // Walk the tier in quality order, checking reserve and congestion for each candidate. A later explicit
    // Astra/other-family quality rung retains its model; balancing cannot turn a retry into a weaker rung.
    // A light first rung (TTADK Terra/5.5) walks the light tier too, so a paused/busy TRAE Terra doesn't block the
    // balance transfer while TRAE 5.5 or DeepSeek would pass. Only index 0: an escalation rung is never walked sideways.
    const lightStart = index === 0 && taskTier === 'light' && TTADK_LIGHT.includes(x.model);
    const candidates = !balancePinned.has(raw) && (x.model === SOL || lightStart) ? COMPANY_TIERS[taskTier] : [x.model];
    const checked = [];
    for (const model of candidates) {
      factors = balanceFactors({ ttadk: QX.ttadk, trae: QX.trae, model, category: cat, stakes, impact, tier: taskTier, allowBucketFree: free.includes(model) });
      const fitReasons = [!QX.trae.usable && 'TRAE account unavailable', excluded.has(QX.trae.name) && 'TRAE account excluded',
        !laneEligible && 'task requires TTADK tools or holds a shared resource',
        modelExcluded(model, QX.trae) && 'model excluded for this task',
        QX.trae.poolPauses?.[poolOf(model)] && 'model family paused', QX.trae.modelPauses?.[model] && 'model paused',
        !QX.trae.allModels.includes(model) && 'model not listed',
        deepseekUnfit && poolOf(model) === 'deepseek' && 'model does not fit this task'].filter(Boolean);
      const fits = !fitReasons.length && QX.trae.models.includes(model);
      factors.reasons = [...fitReasons, ...factors.reasons];
      factors.taskEligible = !!fits;
      factors.selected = !!fits && factors.eligible;
      checked.push(factors);
      if (!factors.selected) continue;
      transfer = QX.trae;
      x = { ...x, model };
      const triggers = factors.triggers.map((s) => s === 'TTADK projected to run out'
        ? `${s} at ${new Date(factors.burn.outAt).toISOString().slice(11, 16)} UTC` : s);
      const quota = factors.bucketFree ? 'has no daily bucket, no high-priority quota spent, no low-priority lane' : `${Math.round(factors.remainingShare * 100)}% left`;
      log(`balanced to TRAE: ${triggers.join(', ')}, TRAE ${x.model} ${quota}, `
        + `load ${factors.load ? `${factors.load.percent}%${factors.load.source === 'model' ? '' : ` (${factors.load.source})`}` : 'unknown'}, queue ${factors.queue?.position ?? (factors.queue?.state === 'ready' ? 'ready' : 'unobserved')}`);
      break;
    }
    const reason = transfer ? null : checked.some((c) => c.taskEligible)
      ? checked.some((c) => c.taskEligible && c.reserveOK && c.congestionOK)
        ? 'no balancing trigger' : `no ${taskTier}-tier TRAE candidate passes reserve and congestion`
      : checked[0]?.reasons[0] ?? 'no eligible TRAE candidate';
    factors = { ...factors, tier: taskTier, reason, candidates: checked };
    if (reason) log(`stays on TTADK: ${reason}`);
  }
  return { pick: x, raw, index, messages, transfer, balance: factors };
};
if (!deferred) {
  let firstOk = resolveRung(base[0], 0);
  if (!firstOk || !allowed(firstOk.pick)) firstOk = !adversarial && T.alt && cat !== 'second-opinion' ? resolveRung(T.alt, 0) : null;
  const rows = [firstOk, ...base.slice(1).map((x, i) => resolveRung(x, i + 1))].filter((r) => r && allowed(r.pick));
  const gptOrder = [ASTRA, ...new Set(Object.values(COMPANY_TIERS).flat().filter((m) => m.startsWith('gpt-') && m !== ASTRA)), TERRA, LUNA];
  const { kept: ladder, dropped } = normalizeLadder(rows, base, gptOrder);
  const waits = [...(base.some((x) => x.vendor === 'claude') && QC.throttledUntil ? [(QC.throttledUntil - Date.now()) / 3600000] : []),
    ...(base.some((x) => x.vendor === 'codex') && codexOut && QX.nextFree != null ? [QX.nextFree] : [])];
  const runnable = !ladder.length && !background ? base.map(resolveRung).find((r) => r && (r.pick.vendor === 'claude' ? !QC.throttledUntil : allowed(r.pick))) : null;
  if (runnable) {
    ladder.push(runnable);
    if (!opts.urgent) needsOK.push(`no vendor has room within the quota policy (claude ${QC.status}, codex ${codexOut ? 'out' : 'ok'}): ask the user whether to run it now anyway on ${runnable.pick.vendor} (this pick) or wait${retry(waits.length ? Math.min(...waits) : null)}`);
  }
  if (!ladder.length) deferred = `neither vendor has room for this now (claude ${QC.throttledUntil ? '5h-throttled' : QC.status}, codex ${codexOut ? (QX.throttledOnly ? 'paused' : 'out') : 'ok'})${retry(waits.length ? Math.min(...waits) : null)}`;
  else {
    const selected = ladder[Math.min(failures, ladder.length - 1)];
    m = selected.pick; balance = selected.balance; balancedAccount = selected.transfer;
    why.push(...selected.messages);
    if (dropped.length) why.push(`normalized actual ladder: dropped ${dropped.map((r) => `${label(r.pick)} (${r.reason})`).join('; ')}`);
    if (failures) why.push(`escalated to step ${Math.min(failures, ladder.length - 1)} of ${ladder.length - 1} after ${failures} failure(s)`);
    if (failures >= ladder.length) {
      needsOK.push(`escalation ladder exhausted after ${failures} failure(s): tell the user before trying again`);
      notes.push(`this retry is not stronger than the one that fell short: its only lever is the brief — put the failure's concrete findings (review items, failing test, symptom) in it`);
    }
    if (!adversarial && tier === 'hard' && (balancedAccount ?? TT)?.kind === 'trae' && onTTADK(m)
      && m.vendor === 'codex' && ![SOL, ASTRA].includes(m.model)) {
      deferred = 'no stronger eligible company rung for this hard retry; do not repeat a weaker model (no DeepSeek or 5.6 for hard work)'; m = null;
    }
    if (failures >= 1 && CODE.includes(cat)) notes.push("if the last miss was spec/process, amend the brief's acceptance first and say what changed before dispatching this fix round (outcome --cause); do not repeat the same brief");
    if (failures >= 1 && CODE.includes(cat)) notes.push('rework thread rule (SKILL.md, 2026-11-13): may continue the original author thread only for this same-task fix round with useful context, company account (personal needs user OK), no route escalation or exclusion, and no depleted TRAE bucket with queue >300 while someone waits; otherwise use the route thread. Record outcome.mjs --actual and ledger: "continued original thread because ..."');
    if (failures >= 2 && CODE.includes(cat)) notes.push('before this fix round: if the last fix brought a new defect of the same kind (same invariant, state or race), stop patching — find whether it is a shared contract, the interface layout or a too-wide patch, then simplify or split the work (a `design` route can review the approach); the fix brief still asks for the original failure, the fix and the neighbouring old behaviour to be tested');
    const codexFails = ladder.slice(0, Math.min(failures, ladder.length)).filter((r) => r.pick.vendor === 'codex').length;
    if (codexFails >= 2) tell.push(`Codex has fallen short on this task ${codexFails} times: tell the user what happened (model, effort, symptom)`);
    if (codexOut && !QX.throttledOnly && m?.vendor === 'claude' && T.kind !== 'claudeOnly') why.push('Codex is out: Claude takes this because it matters');
  }
}
if (m) {
  // Check the actual pick, including a balancing substitution, before applying the service-code review guard.
  if (isAlt(m) && CODE.includes(cat) && impact === 'service' && !reviewKind) { reviewKind = 'review'; why.push(`${m.model} is a fallback model: its service code gets a review`); }
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
if (!adversarial && !second && m && m.vendor === 'codex' && !ttDevice && QX.underused && ['implement-hard', 'debug', 'science'].includes(cat) && reviewKind) {
  second = X(SOL, 'xhigh'); extraReview = true;
  notes.push('extra independent Codex review of the result (Codex underused): run it after the worker reports, as a fresh read-only review');
}
// Adversarial: the second reviewer is always the other non-GPT family, never a GPT model. When only one company
// non-GPT family exists, say so and ask (Claude second on personal quota, or accept one reviewer).
if (adversarial && m) {
  const family = poolOf(m.model);
  second = m.vendor === 'claude' ? null : advSecondFor(m);
  if (second) {
    notes.push(`adversarial second reviewer: ${label(second)} from the other non-GPT family — run it as a separate read-only review, merge both reports and keep only P0/P1 items (references/review-rubric.md)`);
  } else if (m.vendor === 'claude') {
    notes.push('adversarial: no company non-GPT model can take this task, so it falls back to Claude Opus on personal quota; no second non-GPT reviewer exists for this pick — report that limitation');
  } else {
    notes.push(`adversarial: only the ${family} family is available among company non-GPT models; no second reviewer from the other family exists. Report the single-reviewer limitation; never add a GPT reviewer`);
    needsOK.push(`adversarial second reviewer: only ${family} is available among company non-GPT models. Ask the user whether to add Claude Opus as the second reviewer (personal quota) or accept one reviewer; never add a GPT reviewer`);
  }
}
if (second) {
  const original = second;
  if (!adversarial) second = quotaChoice(second, (r) => why.push(`second opinion: ${r}`));
  if (second !== original && poolOf(second.model) === poolOf(m.model)) notes.push('quota substitution leaves the second opinion in the same model family; record this limitation and retain the GPT/Claude acceptance gate in references/review-rubric.md');
}

// ---- 4. account and launcher ----
const mode = typeof opts.mode === 'string' ? opts.mode : 'default';
// User, 2026-11-13: Claude workers always use Bypass, independent of settings.defaultMode or --mode.
// --mode still bounds the Codex sandbox; this must not silently widen Codex permissions.
const claudeMode = 'bypassPermissions';
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
// An adversarial company pick runs on whichever company account lists that non-GPT model (TTADK or TRAE), so the
// launcher and the company/personal gate see the real account even when the model is not on TT.
const advAcct = adversarial && m?.vendor === 'codex' ? advCompany(m.model) : null;
const ttadkRun = m && (onTTADK(m) || !!advAcct);
const runCompany = advAcct ?? balancedAccount ?? TT;
if (ttadkRun) acct = { a: { name: runCompany.name, live: runCompany.live } };
else if (QX.rotate && m?.vendor === 'codex' && QX.rotate.every((r) => !excluded.has(r.a.name))) {
  const n = withLock(RR, () => { let c = 0; try { c = Number(fs.readFileSync(RR, 'utf8')) || 0; } catch {} if (!opts.dry) fs.writeFileSync(RR, String(c + 1)); return c; });
  acct = QX.rotate[n % QX.rotate.length];
}
const pickAcct = acct;
// The second opinion's account: the extra underused review on ChatGPT; any other Codex second opinion TTADK-first.
// The second opinion's account: TTADK first for a Codex second opinion it can run; otherwise the ChatGPT account.
const advSecondAcct = adversarial && second?.vendor === 'codex' ? advCompany(second.model) : null;
const secondAcct = !second || second.vendor !== 'codex' ? null
  : advSecondAcct ? { a: { name: advSecondAcct.name, live: advSecondAcct.live } }
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
// The adversarial Claude fallback is never silent, including on a device with no company account (where the generic
// gate above does not fire) and when a standing exception would otherwise skip it.
if (adversarial && m?.vendor === 'claude' && !opts.urgent && !needsOK.some((n) => n.startsWith('personal quota:')))
  needsOK.push('personal quota: no company non-GPT model can take this adversarial task — Claude Opus is the fallback. Ask the user before launching (go on now on personal quota, or wait for a company non-GPT model); never silently use personal quota and never substitute a GPT reviewer');
// One-shot execs get the same worker rules as hub threads; the digest is the single injection source.
const digest = loadDigest();
const credRule = `Global worker rules ${digest.version}\n${digest.worker}`;
const execCred = ` -c 'developer_instructions=${JSON.stringify(credRule).replaceAll("'", "'\\''")}'`;
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const launchAudit = (x, an) => `node ${shellQuote(`${SKILL}/scripts/launch-audit.mjs`)} --name ${shellQuote(name)} --vendor ${x.vendor} --account ${shellQuote(an)} --model ${shellQuote(x.model)}${typeof opts['user-ok'] === 'string' ? ` --user-ok ${shellQuote(opts['user-ok'])}` : ''} && `;
const launch = (x, shape = T.shape, acct = pickAcct) => {
  if (x.vendor === 'claude') {
    return { launcher: 'claude-bg', command: `${launchAudit(x, 'claude')}cd ${cwd} && claude --bg --remote-control --permission-mode ${claudeMode} -n ${name} --model ${x.model} --effort ${x.effort} --append-system-prompt "$(node ${shellQuote(`${SKILL}/scripts/rules-worker-digest.mjs`)})" ${prompt}` };
  }
  const an = acct?.a.name ?? 'main', home = profiles[an]?.home ?? '~/.codex';
  // TRAE CLI: `traecli exec` mirrors `codex exec` (its own home, ~/.trae); models go by TRAE's own ids.
  const traeProf = profiles[an]?.kind === 'trae' ? profiles[an] : QX.trae?.name === an ? QX.trae : null;
  if (traeProf) {
    const id = traeProf.modelIds?.[x.model] ?? x.model;
    // Quota substitution can put Astra on a short row too; keep its queue/status visible through the hub.
    if (shape === 'exec' && x.model !== ASTRA && !backgroundLane) return { launcher: 'traecli-exec', account: an, command: `${launchAudit(x, an)}${traeProf.bin ?? 'traecli'} exec${inRepo === false ? ' --skip-git-repo-check' : ''} -C ${cwd} -s ${sandbox} -m ${id} -c model_reasoning_effort='"${x.effort}"'${execCred} --json -o ${taskDir}/codex-last.md ${prompt} < /dev/null > ${taskDir}/codex.jsonl 2>&1   (background task${inRepo === null ? '; add --skip-git-repo-check outside a repo' : ''})` };
    return { launcher: 'codex-worker', account: an, command: `node ${SKILL}/scripts/codex-worker.mjs --account ${an} start --cwd ${cwd} --model ${id} --effort ${x.effort} --sandbox ${sandbox} --name ${name} --log ${taskDir}/codex.jsonl --out ${taskDir}/codex-last.md ${prompt}   (background task)` };
  }
  // A TTADK codex exec bypasses codex-worker, so it brings the account's proxy up first (exit 6 when it can't).
  const proxyFirst = TT?.search && an === TT.name ? `node ${SKILL}/scripts/codex-worker.mjs --account ${an} proxy >/dev/null && ` : '';
  if (shape === 'exec') return { launcher: 'codex-exec', account: an, command: `${launchAudit(x, an)}${proxyFirst}CODEX_HOME=${home} codex exec${inRepo === false ? ' --skip-git-repo-check' : ''} -C ${cwd} -s ${sandbox} -m ${x.model} -c model_reasoning_effort='"${x.effort}"'${execCred} --json -o ${taskDir}/codex-last.md ${prompt} < /dev/null > ${taskDir}/codex.jsonl 2>&1   (background task${inRepo === null ? '; add --skip-git-repo-check outside a repo' : ''})` };
  // ui-browser also reaches the local dev server (a host pattern matches any port).
  const apps = cat === 'computer-use' && typeof opts.apps === 'string' ? ` --computer-use-apps '${opts.apps.split(',').map((a) => a.trim()).filter(Boolean).join(',')}'` : '';
  const origins = ['browser', 'ui-browser'].includes(cat) ? ` --browser-origins '${[...(cat === 'ui-browser' ? ['localhost', '127.0.0.1'] : []), ...POLICY.browserOrigins, ...(typeof opts.origins === 'string' ? opts.origins.split(',') : [])].map((o) => o.trim()).filter(Boolean).join(',')}'` : '';
  return { launcher: 'codex-worker', account: an, command: `node ${SKILL}/scripts/codex-worker.mjs --account ${an} start --cwd ${cwd} --model ${x.model} --effort ${x.effort} --sandbox ${sandbox} --name ${name}${origins}${apps} --log ${taskDir}/codex.jsonl --out ${taskDir}/codex-last.md ${prompt}   (background task)` };
};
// The same quality gate for both vendors, so outcomes compare: code work gets an independent review before it's accepted.
// Review only where a mistake is costly to undo; reviewers follow references/review-rubric.md (blocking issues only).
if (m && reviewKind) notes.push(`review required (impact ${impact}${stakes === 'high' ? ', high stakes' : ''}${isAlt(m) ? `, written by fallback model ${m.model}` : ''}): after the worker reports, route.mjs ${reviewKind}${background ? ' --background' : ''}${adversarial ? ' --adversarial' : ''} --author ${m.vendor}${isAlt(m) ? ` --exclude-model ${poolOf(m.model)}` : ''} --impact ${impact} --project ${typeof opts.project === 'string' ? opts.project : '<slug>'} --name ${name}-R; brief the reviewer with references/review-rubric.md (blocks only on P0/P1, at most 2 rounds); then record with scripts/outcome.mjs --reviewed`);
else if (m && CODE.includes(cat)) notes.push(`no review (impact ${impact}${impact === 'service' ? ', not high stakes' : ''}): accept on your own check (tests, build, acceptance), then record with scripts/outcome.mjs`);
else if (m && cat !== 'review' && cat !== 'review-high' && cat !== 'second-opinion') notes.push('when the task ends: record it with scripts/outcome.mjs (pass | rework --rounds N | fail)');
// Fixed safety clauses for anything that writes or touches devices (SKILL.md, "Give each worker a self-contained brief").
// Every brief (user-approved 2026-11-11): a TRAE DeepSeek worker copied bytedcli's TikTok SSO session file into its
// automation browser to get past a console login.
if (m) notes.push('brief: include the credential clause — never read, copy or load any login session or credential file (cookies, SSO/session tokens, CLI auth files such as bytedcli\'s, keychain items, .netrc, API keys), and never inject a session into a browser or tool to get past a login; wherever a login or authorization is needed, stop and report BLOCKED with what needs signing in');
if (security) notes.push('brief: describe defensive intent and ask for findings with impact and fix; avoid requesting step-by-step exploit code');
if (m && ['implement', 'implement-hard', 'debug'].includes(cat)) notes.push('DeepSeek: read-only analysis and simple edits only; not full-package builds, auth/storage reviews or acceptance — re-route with --exclude-model deepseek if the brief needs those');
if (m?.model === 'deepseek-v4.1-flash' || second?.model === 'deepseek-v4.1-flash') notes.push("DeepSeek-V4.1-Flash can't emit one very large file in a single turn (output limit) — not for tasks that generate a large file in one go; split the work or exclude deepseek");
// user-approved 2026-11-11 retro: W291-R0 review misses and ppe2a's unnecessary rollback.
if (isAlt(m) && ['review', 'review-high'].includes(cat)) notes.push('release/high-stakes acceptance also requires an independent other-family GPT/Claude reviewer and the failure probes in references/review-rubric.md; if unavailable, report BLOCKED');
if (m && cat === 'build-run' && (productionBuild || (env !== 'test' && stakes !== 'low'))) notes.push('deploy/release brief: pin baseline/control probes, health thresholds, sample intervals and observation window, rollback triggers and exact prior artifact/config restore steps before acting; a fallback model follows these only — unexpected evidence needs stronger-model judgment, stop and report rather than invent a rollback condition');
else if (m && cat === 'build-run') notes.push('test-environment build-run (PPE/staging/dev, procedural, light tier): follow the written steps, report the exact commands and the observed result, and stop on unexpected errors; still pin the health checks and the exact restore steps in the brief, but a failed test deploy is retried once or reported, not treated as an incident — a production release brief (baseline probes, rollback triggers, observation window) is not required; pass --impact release without --env test for that');
if (m && writes) notes.push('brief: include the safety clauses — never overwrite, delete or move files outside the task\'s scope (user files, uncommitted changes, shared headers/configs); restore anything touched by mistake byte-for-byte and report it');
if (m && ['build-run', 'implement', 'implement-hard', 'debug', 'ui-browser', 'computer-use'].includes(cat)) notes.push('brief: on devices and simulators, back up app data before any destructive step (reinstall with --remove-existing-content, wiping app containers or Documents, erasing simulators), or ask first');
if (m && ['build-run', 'ui-browser', 'computer-use'].includes(cat)) notes.push('before builds/device runs: inspect finished-task process trees, but cleanup requires references/resources.md\'s guarded executor, continuous idle evidence, live-session/lease protections and every orchestrator\'s release; PPID=1 or age alone is not permission to kill. Device lease: at most 2 h, then return the device and report; brief preflight: device connected, unlocked, app data backed up');
if (m && (opts['no-local-build'] || (env === 'test' && cat === 'build-run')) && ['build-run', 'implement', 'implement-hard', 'debug', 'ui-browser'].includes(cat)) notes.push(opts['no-local-build']
  ? 'remote/CI build (--no-local-build): no local heavy-build/lane lock and no local verify throttle — do not take res locks or pass --shared-lock for this run; the shared remote entry script stays unthrottled and only local-only wrappers throttle'
  : 'test-environment run (--env test): no heavy-build/lane lock and no local verify throttle — this task does not compile locally; do not take res locks or pass --shared-lock for a PPE/staging/TCE/BITS/SCM deploy or smoke check, and shared remote/CI entry scripts stay unthrottled');
else if (m && ['build-run', 'implement', 'implement-hard', 'debug', 'ui-browser'].includes(cat)) notes.push('build brief: full-package builds must use scripts/heavy-build.sh or equivalent res take/return per references/res-contract.md: heavy-build first, then a lane; reverse return on every exit. Two normal lanes; v1.3 adds lane 3 only after reviewed owner switch, at load1m <=8 AND available memory >=32 GiB at take time (2-3 lanes with load). Wrapper tries lanes 1/2/3, HEAVY_BUILD_LANE pins one. Normal gate remains min(20, 12 + 8 * other lanes), memory >=16 GiB; STALE and caller-owned locks excluded, lane-3 holders counted. Bounded waits and authoritative heavy-check limit/lanes_held, appended lane3=OPEN|CLOSED; OPEN is not FREE. UNKNOWN blocks admission, timeout means report/queue, never bypass. Other heavy tasks take one lane. Heavy-build/lane locks are only for genuine local heavy compute: PPE/staging/TCE/BITS/SCM/remote pipeline deploys and CI runs never take one, never pass --shared-lock, and shared remote/CI entry scripts stay unthrottled — local lock/verify throttling lives only in local-only wrappers (--no-local-build when this run is remote). Compile 6/link 1, Xcode -jobs 6, Gradle 2 workers; fixed per-base incremental builds, one cold acceptance build, affected fix tests and scoped ccache/Gradle caches (first use cold). Not a model-worker concurrency cap; global-rules owns res, telemetry never reclaims locks/restarts hubs.');
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
  if (!runCompany.live && (T.shape !== 'exec' || backgroundLane)) notes.push(`TRAE hub may be unreachable: probe with node ${SKILL}/scripts/codex-worker.mjs --account ${runCompany.name} list --limit 1; start with codex-worker hub only if unreachable, then tell the global-rules owner`);
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
  if (!runCompany.live && (T.shape !== 'exec' || backgroundLane)) notes.push(`TTADK hub may be unreachable: probe with node ${SKILL}/scripts/codex-worker.mjs --account ${runCompany.name} list --limit 1; start with codex-worker hub only if unreachable, then tell the global-rules owner`);
}
if (m && ['browser', 'ui-browser'].includes(cat)) {
  notes.push('Chrome must be running before the worker starts (workers can\'t launch it): pgrep -x "Google Chrome" >/dev/null || open -a "Google Chrome"');
  if (m.vendor === 'codex') notes.push(`"Browser is not available: chrome" (codex-worker prints browser-unavailable:) means the Chrome extension host is briefly disconnected: wait a minute, retry once, then re-route with --exclude-account ${acct?.a?.name ?? TT?.name}`);
  if (m.vendor === 'codex') notes.push(`brief: include the "Codex browser brief" clauses from references/codex-workers.md (plugin bootstrap from ${(ttadkRun ? TT?.chromePlugin : acct?.a?.chromePlugin) ?? TT?.chromePlugin ?? '<chrome plugin>'}/scripts/browser-client.mjs; work in tabs you create; a tab your own click opens may be claimed via user.openTabs()/claimTab and must be closed; never touch the user's other tabs); sites outside --browser-origins are declined — add them with --origins when the task needs them`);
  else notes.push('Claude browser worker (Claude in Chrome): if the extension reports several browsers, select only this Mac\'s Chrome (deviceId in the ledger); never switch to another connected browser');
}
if (m?.vendor === 'codex' && sandbox === 'workspace-write') notes.push('workspace-write can\'t run git writes: brief the worker to edit only and report the files and a commit message; you review and commit');
if (m?.vendor === 'codex' && acct && !acct.a.live) notes.push(T.shape === 'exec' && !backgroundLane ? `account ${acct.a.name}'s reading is stale (its hub may be unreachable); codex exec still works` : `account ${acct.a.name}'s hub may be unreachable: probe with codex-worker.mjs --account ${acct.a.name} list --limit 1; start with codex-worker hub only if unreachable, then tell the global-rules owner`);
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
  category: cat, stakes, failures, security, background, tier, deferred,
  pick: m ? { ...m, ...launch(m), sandbox: m.vendor === 'codex' ? sandbox : null } : null,
  secondOpinion: second ? { ...second, ...launch(second, second === T.second ? T.shape : 'worker', secondAcct) } : null,
  needsUserOK: needsOK, tellUser: tell, why, notes, redeemFirst, balance, quota: leanLines(st, data),
};
out.notes.push('launch audit: every launch must match a same-name/task-prefix route decision in the last 24h; unrouted-launch warns and logs without blocking. Record actual user approval with --user-ok <card/ledger-reference>, never invent it. Claude/one-shot launches run launch-audit; hub start checks directly.');
// Every real routing decision is logged for the nightly review (--dry or ROUTE_LOG=0 to skip, e.g. for experiments).
if (!opts.dry && process.env.ROUTE_LOG !== '0') {
  const rec = { t: Date.now(), project: typeof opts.project === 'string' ? opts.project : null, name: typeof opts.name === 'string' ? opts.name : null, category: cat, stakes, failures, impact, review: reviewKind, excluded: [...excluded], ttadk: !!ttadkRun, company: ttadkRun ? runCompany.name : null, balance,
    autoCheck: !!opts['auto-check'], noRedeem, security, adversarial, background, tier, deferred, env, noLocalBuild: !!opts['no-local-build'], pick: m ? { vendor: m.vendor, model: m.model, effort: m.effort, account: out.pick?.account ?? null } : null,
    second: second ? { vendor: second.vendor, model: second.model, effort: second.effort, account: out.secondOpinion?.account ?? null } : null, why, needsOK, tell,
    personalApproved: !!opts.urgent, approvalRef: typeof opts['user-ok'] === 'string' ? opts['user-ok'] : null,
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
