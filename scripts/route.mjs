#!/usr/bin/env node
// route: pick vendor, model, effort, account and the exact launch command for one task, deterministically.
//
//   route <category> [--stakes low|normal|high] [--auto-check] [--failures N] [--writes | --read-only]
//                    [--against claude|codex] [--no-redeem] [--project SLUG] [--dry] [--mode <orchestrator permission mode>] [--cwd DIR] [--task-dir DIR]
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
import { readState, analyze, leanLines, readProfiles, hours, withLock, SHARED, ROUTE_LOG } from './lib/state.mjs';

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
  lookup: { desc: 'quick lookup, find a file, status check', kind: 'codexFirst', shape: 'exec', writes: false, first: X(LUNA, 'low'), alt: C('haiku', 'low'), ladder: [C('sonnet', 'medium')] },
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
  'computer-use': { desc: 'computer use, browser automation, Artifact/Docs tools, negotiating with peers', kind: 'claudeOnly', shape: 'worker', writes: true, first: C('sonnet', 'medium'), alt: null, ladder: [C('opus', 'high')] },
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
const writes = opts['read-only'] ? false : opts.writes ? true : T.writes;

// ---- state ----
const data = readState({ fresh: !!opts.fresh });
const st = analyze(data);
const { claude: QC, codex: QX } = st;
const noRedeem = !!opts['no-redeem'];
const codexOut = QX.out || (noRedeem && !QX.pick && !!QX.redeem); // a declined redemption leaves Codex out
const why = [], needsOK = [], tell = [], notes = [];
const claudeAllowed = (kind) => {
  if (QC.throttledUntil) return false; // a full 5h window: nothing new on Claude until it resets
  if (kind === 'claudeOnly') return true;
  if (QC.status === 'spare') return true;
  if (QC.status === 'near') return T.keepNear || stakes === 'high';
  return false; // over or unknown
};
const allowed = (x) => (x.vendor === 'claude' ? claudeAllowed(T.kind) : !codexOut);

// ---- 1. vendor locks, quota moves and the escalation ladder ----
// The usable ladder: the first pick (or its same-tier alternative when quota rules it out), then every later step the
// quota allows. --failures N takes step N, so each failure moves up even when some steps are ruled out.
let base;
if (cat === 'second-opinion') { base = opts.against === 'claude' ? [T.first, ...T.ladder] : [T.alt, C('opus', 'xhigh')]; why.push(`second opinion from the other vendor than ${opts.against}`); }
else base = [T.first, ...T.ladder];
let deferred = null;
const retry = (h) => (h != null && Number.isFinite(h) ? ` — retry in ${hours(h)}` : '');
if (st.stop) deferred = "neither vendor's usage is readable — check `claude -p /usage` and the Codex hubs before dispatching";
else if (T.kind === 'claudeOnly' && QC.throttledUntil) deferred = `Claude-only work and Claude's 5h window is full${retry((QC.throttledUntil - Date.now()) / 3600000)}`;
else if (T.kind === 'codexOnly' && codexOut) deferred = `Codex-only work and Codex is ${QX.throttledOnly ? 'paused by its 5h window' : 'out'}${retry(QX.nextFree)}`;
else if (codexOut && !QX.throttledOnly && stakes === 'low' && T.kind !== 'claudeOnly') deferred = `Codex is out and this is low-stakes: it waits for Codex${retry(QX.nextFree)}`;
let m = null;
if (!deferred) {
  const firstOk = allowed(base[0]) ? base[0] : T.alt && allowed(T.alt) && cat !== 'second-opinion' ? T.alt : null;
  const ladder = [firstOk, ...base.slice(1).filter(allowed)].filter(Boolean)
    .filter((x, i, a) => a.findIndex((y) => y.vendor === x.vendor && y.model === x.model && y.effort === x.effort) === i);
  if (!ladder.length) deferred = `neither vendor has room for this now (claude ${QC.throttledUntil ? '5h-throttled' : QC.status}, codex ${codexOut ? (QX.throttledOnly ? 'paused' : 'out') : 'ok'})${retry(QX.nextFree)}`;
  else {
    if (firstOk && firstOk !== base[0]) why.push(`${base[0].vendor} not available for this (${base[0].vendor === 'claude' ? `claude ${QC.throttledUntil ? '5h-throttled' : QC.status}` : QX.throttledOnly ? 'codex paused by its 5h window' : 'codex out'}) → ${firstOk.vendor}`);
    m = ladder[Math.min(failures, ladder.length - 1)];
    if (failures) why.push(`escalated to step ${Math.min(failures, ladder.length - 1)} of ${ladder.length - 1} after ${failures} failure(s)`);
    if (failures >= ladder.length) needsOK.push(`escalation ladder exhausted after ${failures} failure(s): tell the user before trying again`);
    const codexFails = ladder.slice(0, Math.min(failures, ladder.length)).filter((x) => x.vendor === 'codex').length;
    if (codexFails >= 2) tell.push(`Codex has fallen short on this task ${codexFails} times: tell the user what happened (model, effort, symptom)`);
    if (codexOut && !QX.throttledOnly && m.vendor === 'claude' && T.kind !== 'claudeOnly') why.push('Codex is out: Claude takes this because it matters');
  }
}

// ---- 2. effort ----
if (m) {
  const step = (d, reason) => { const n = notch(m, d); if (n.effort !== m.effort) { why.push(reason); m = n; } };
  if (failures === 0 && opts['auto-check'] && stakes !== 'high') step(-1, 'one notch lower: an automatic check catches a miss');
  if (failures === 0 && stakes === 'high') step(+1, 'one notch higher: high stakes');
  if (failures === 0 && stakes === 'low') step(-1, 'one notch lower: low stakes');
  const cheap = ['lookup', 'extract', 'image-gen', 'draft'].includes(cat);
  if (m.vendor === 'codex' && QX.underused && !cheap) step(+1, QX.frontLoad ? 'one notch higher: front-loading Codex while reset cards are in hand' : 'one notch higher: Codex underused');
  else if (m.vendor === 'codex' && QX.overspending && opts['auto-check'] && stakes !== 'high') step(-1, 'one notch lower: Codex overspending');
  if (m.vendor === 'claude' && QC.expiring && !cheap) step(+1, 'one notch higher: Claude headroom expires within a day');
  if (m.vendor === 'claude' && m.model === 'fable' && QC.avoidFable) { m = C('opus', 'xhigh'); why.push('Fable window nearly used → Opus xhigh'); }
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
if (!second && m && m.vendor === 'codex' && QX.underused && ['implement-hard', 'debug', 'science', 'review'].includes(cat)) {
  second = X(SOL, 'xhigh'); notes.push('extra independent Codex review of the result (Codex underused): run it after the worker reports, as a fresh read-only review');
}

// ---- 4. account and launcher ----
const mode = typeof opts.mode === 'string' ? opts.mode : 'default';
const sandbox = !writes ? 'read-only' : mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write';
const cwd = typeof opts.cwd === 'string' ? opts.cwd : '<workspace>', taskDir = typeof opts['task-dir'] === 'string' ? opts['task-dir'] : '<task dir>';
const name = typeof opts.name === 'string' ? opts.name : '<project>-<task>';
const prompt = `"Read ${taskDir}/brief.md and follow it."`;
const inRepo = (() => {
  if (typeof opts.cwd !== 'string') return null;
  for (let d = path.resolve(opts.cwd); ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) return true; if (d === path.dirname(d)) return false; }
})();
// The account: a rotation across accounts that must all be spent soon, else the earliest deadline.
let acct = QX.pick ?? (noRedeem ? null : QX.redeem) ?? null;
if (QX.rotate && m?.vendor === 'codex') {
  const n = withLock(RR, () => { let c = 0; try { c = Number(fs.readFileSync(RR, 'utf8')) || 0; } catch {} fs.writeFileSync(RR, String(c + 1)); return c; });
  acct = QX.rotate[n % QX.rotate.length];
}
const profiles = readProfiles();
const launch = (x, shape = T.shape) => {
  if (x.vendor === 'claude') {
    return { launcher: 'claude-bg', command: `cd ${cwd} && claude --bg --permission-mode ${mode} -n ${name} --model ${x.model} --effort ${x.effort} ${prompt}` };
  }
  const an = acct?.a.name ?? 'main', home = profiles[an]?.home ?? '~/.codex';
  if (shape === 'exec') return { launcher: 'codex-exec', account: an, command: `CODEX_HOME=${home} codex exec${inRepo === false ? ' --skip-git-repo-check' : ''} -C ${cwd} -s ${sandbox} -m ${x.model} -c model_reasoning_effort='"${x.effort}"' --json -o ${taskDir}/codex-last.md ${prompt} < /dev/null > ${taskDir}/codex.jsonl 2>&1   (background task${inRepo === null ? '; add --skip-git-repo-check outside a repo' : ''})` };
  return { launcher: 'codex-worker', account: an, command: `node ${SKILL}/scripts/codex-worker.mjs --account ${an} start --cwd ${cwd} --model ${x.model} --effort ${x.effort} --sandbox ${sandbox} --name ${name} --log ${taskDir}/codex.jsonl --out ${taskDir}/codex-last.md ${prompt}   (background task)` };
};
if (m?.vendor === 'codex' && sandbox === 'workspace-write') notes.push('workspace-write can\'t run git writes: brief the worker to edit only and report the files and a commit message; you review and commit');
if (m?.vendor === 'codex' && acct && !acct.a.live) notes.push(T.shape === 'exec' ? `account ${acct.a.name}'s reading is stale (its hub is down); codex exec still works` : `account ${acct.a.name}'s hub is down — start it first: codex-worker.mjs --account ${acct.a.name} hub`);
if (!QX.readable && m?.vendor === 'codex') notes.push('Codex usage unreadable; routing as if it has room');
const redeemFirst = m?.vendor === 'codex' && !QX.pick && QX.redeem && !noRedeem
  ? `redeem a reset card on ${QX.redeem.a.name} first (with the user's OK; if declined, re-run with --no-redeem): ${QX.redeem.cp.line}` : null;
const out = {
  category: cat, stakes, failures, deferred,
  pick: m ? { ...m, ...launch(m), sandbox: m.vendor === 'codex' ? sandbox : null } : null,
  secondOpinion: second ? { ...second, ...launch(second, second === T.second ? T.shape : 'worker') } : null,
  needsUserOK: needsOK, tellUser: tell, why, notes, redeemFirst, quota: leanLines(st, data),
};
// Every real routing decision is logged for the nightly review (--dry or ROUTE_LOG=0 to skip, e.g. for experiments).
if (!opts.dry && process.env.ROUTE_LOG !== '0') {
  const rec = { t: Date.now(), project: typeof opts.project === 'string' ? opts.project : null, name: typeof opts.name === 'string' ? opts.name : null, category: cat, stakes, failures,
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
