#!/usr/bin/env node
import {modelPreference} from './lib/pipeline/policy.mjs';
// codex-worker: run and steer Codex workers through a shared Codex app-server ("hub") over WebSocket.
//
//   codex-worker [--account NAME] <command> …                             (any command, on that account's home and hub)
//   codex-worker accounts | account-add NAME [--home DIR] [--port N]      (list / add an account profile)
//   codex-worker hub                                                       (start the hub if it isn't up)
//   codex-worker start  --cwd DIR --effort E --sandbox S [--network on|off] [--model M] [--name N] --log FILE [--out FILE]  "<prompt>"
//   codex-worker turn   --thread ID --effort E --log FILE [--out FILE] [--model M] [--sandbox S [--network on|off]]      "<prompt>"
//                       start/turn also take --browser-origins <origins/host globs>, --chrome-profile-dir <name>
//                       and --computer-use-apps <bundle ids>, --task <board task id> (defaults to --name)
//   codex-worker browser-setup [--account NAME]                           (Chrome + Computer Use config for that home)
//   codex-worker ttadk-setup [--name ttadk] [--home DIR] [--port N] [--search-port N]   (the TTADK gateway as an account)
//   codex-worker [--account ttadk] proxy                                   (start/check TTADK's local proxy: web search)
//   codex-worker trae-setup [--name trae] [--port N] [--headless-playwright | --no-headless-playwright]
//   codex-worker --account trae note-failure [--model M] "<error>"        (record a failed traecli exec run; see lib/trae-health.mjs)
//   codex-worker --account trae probe --model M                          (recovery probe of a paused model family; lib/state.mjs starts it)
//   codex-worker wait   --thread ID [--log FILE] [--out FILE]            (start/turn/wait take --stall-min M, default 30)
//   codex-worker steer  --thread ID                                                                     "<message>"
//   codex-worker note [--kind progress|risk|scope|info] [--wake] "<text>"         (worker: notify without ending the turn)
//   codex-worker ask [--timeout-min N] [--default TEXT] "<question>"    (worker: wait for an orchestrator answer)
//   codex-worker reply --thread ID [--question ID] "<text>"            (orchestrator: answer, or fall back to steer)
//   codex-worker interrupt --thread ID
//   codex-worker status --thread ID
//   codex-worker mine | watch [--owner SESSION_ID] [--debounce-sec N]                      (owner-scoped durable inbox; watch is a tracked background task)
//   codex-worker list   [--cwd DIR] [--search TEXT] [--limit N]
//   codex-worker quota                                                     (the account's rate-limit windows, JSON)
//   codex-worker usage                                                     (account id, windows and reset cards, JSON; TRAE: daily buckets + weekly pool)
//   codex-worker reset-credits                                             (reset cards: count and expiries, JSON)
//   codex-worker reset-credit-use --key UUID [--credit ID]                 (redeem one reset card; irreversible)
//
// `start` and `turn` follow the turn until it ends: every notification is appended to --log as JSONL, the first stdout
// line is `thread=<id> turn=<id>`, and the process exits 0 on completed, 1 on failed/interrupted, 4 when the turn has
// been silent for --stall-min minutes (default 30; the turn keeps running — re-attach with `wait`). Routed queue
// patience/unavailable/first-request restriction misses automatically follow a fresh company worker (at most 2 hops).
// Exit 7 means cancellation/handoff could not be confirmed, 8 needs approval, 9 persists a deferral in reroute.json,
// and 10 is the automatic hop limit. Without --route-args, queue patience retains its legacy exit 7 handoff.
// On exit it prints
// `turn <status>`, the token usage and `final: <first line of the final message>`, and writes the whole final message
// to --out. Run them as a harness background task so their exit notifies the orchestrator. `wait` re-attaches to a
// thread's running turn (e.g. after the orchestrator restarted) and exits the same way, at once if the turn already
// ended. `steer` injects a message into the running turn, `interrupt` stops it. `list` shows recent worker threads.
// Sandbox S is read-only | workspace-write | danger-full-access. In workspace-write the network follows Codex's config
// (`[sandbox_workspace_write] network_access`) unless --network on|off, and Codex keeps every git metadata dir
// read-only (so the worker can edit files but not add, commit or fetch).
// Requires the account's hub (localhost only; `hub` starts one detached so it outlives any one session): `main` is
// ws://127.0.0.1:47321 on ~/.codex, other accounts come from ~/.claude/orchestrator/_shared/codex-accounts.json via
// --account; CODEX_HOME / CODEX_HUB override both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './lib/pipeline/presentation.mjs';
import { runWorkerTalkback, createTalkbackRelay } from './lib/worker-talkback.mjs';
import { noteFailure, noteSuccess, notePolicyRestriction, rememberThreadModel, threadModel, probeResult, failureKind } from './lib/trae-health.mjs';
import { createQueueRecorder } from './lib/company-load.mjs';
import { saveQueue, readQueue } from './lib/worker-queue.mjs';
import { loadDigest, workerInstructions, auditLaunch, rulesLog, rulesShared } from './lib/global-rules.mjs';
import { isPolicyBlock, policyBlockRecord, appendPolicyBlock, policyBlockAction } from './lib/policy-block.mjs';
import { runHubForeground, hubListReachable } from './lib/hub-foreground.mjs';
import { parseRouteArgs, routeFlag, rerouteWorker, turnHasWork } from './lib/worker-reroute.mjs';
import { inheritedLaunch, saveLaunch, recordLaunchModel, readRequestBufferExceededAt, markRequestBufferExceeded } from './lib/worker-launch.mjs';
import { recordWorkerOutcome, reviewSeat, reviewInstructions } from './lib/worker-outcome.mjs';
import { sizeLimits, threadSize, freshThreadRoute } from './lib/worker-thread-size.mjs';
import { modelFamily, modelObservation, rolloutTurnModel } from './lib/worker-model.mjs';
import { requestBoardRefresh } from './lib/board-refresh.mjs';
import { lifecycle, resolveOwner, validOwner, inbox, readEvents, readAck, eventLine, watch, signalExit, appendEvent, setEventObserver,
  saveWorkerContext, workerContext, openQuestions, answerQuestion } from './lib/worker-events.mjs';
setEventObserver(requestBoardRefresh);
// What a TRAE pause covers: one model family (route.mjs moves to the next family) or the whole account.
const pausedWhat = (p) => (p.pool ? `TRAE's ${p.pool} models are paused` : 'TRAE is paused');
// A model TRAE no longer resolves (2026-11-13: it dropped Gemini): that model alone is out of routing for 6 h.
const unavailableHint = (p) => `model-unavailable: ${p.model} isn't available on this company account; re-route (route.mjs skips it now)`;

// --account NAME (anywhere on the line) picks a profile from the accounts file: its own CODEX_HOME, so its own login,
// and its own hub. Without it: CODEX_HOME / CODEX_HUB from the environment, else ~/.codex and the default hub.
const ACCOUNTS = process.env.CODEX_ACCOUNTS || path.join(os.homedir(), '.claude', 'orchestrator', '_shared', 'codex-accounts.json');
const readAccounts = () => { try { return JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); } catch { return {}; } };
const writeAccounts = (reg) => {
  fs.mkdirSync(path.dirname(ACCOUNTS), { recursive: true });
  const t = `${ACCOUNTS}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(reg, null, 1)); fs.renameSync(t, ACCOUNTS);
};
const argv = process.argv.slice(2);
const followerStartedAt = Date.now();
const ai = argv.indexOf('--account');
const account = ai >= 0 ? argv.splice(ai, 2)[1] : ['note', 'ask'].includes(argv[0]) ? process.env.CODEX_WORKER_ACCOUNT || null : null;
// Register before validation, hub connection or RPC: every attempted follower gets an exit record.
const earlyOpts = {};
for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) {
  const key = argv[i].slice(2);
  earlyOpts[key] = key === 'force-large' || key === 'background' || key === 'no-browser-preflight' || key === 'headless-playwright' || key === 'no-headless-playwright' || (key === 'require-model' && !['on', 'off'].includes(argv[i + 1]))
    || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
}
if (argv[0] === 'turn' && typeof earlyOpts.thread === 'string') {
  try {
    const inherited = inheritedLaunch(account ?? 'main', earlyOpts);
    if (inherited === null) console.log(`inherited: no saved launch for ${account ?? 'main'}/${earlyOpts.thread}; provide --route-args once to seed it`);
    else { Object.assign(earlyOpts, inherited); console.log(`inherited: ${JSON.stringify(inherited)}`); }
  } catch (e) { process.stderr.write(`codex-worker: launch inheritance failed: ${e.message}\n`); process.exit(2); }
}
// Validate before lifecycle can append an event, including inherited turn owners.
let tracker = null;
try {
  if (earlyOpts.owner !== undefined) earlyOpts.owner = resolveOwner(earlyOpts.owner);
  let routeArgs = []; try { routeArgs = JSON.parse(earlyOpts['route-args'] ?? '[]'); } catch {}
  let seat = {}; try { seat = JSON.parse(earlyOpts['routed-seat'] ?? '{}'); } catch {}
  earlyOpts.project ??= routeFlag(routeArgs, 'project') ?? seat.project ?? process.env.ORCHESTRATOR_PROJECT;
  tracker = ['start', 'turn', 'wait'].includes(argv[0]) ? lifecycle({ owner: earlyOpts.owner, followerCommand: argv[0],
    project: earlyOpts.project ?? null, task: earlyOpts.task ?? earlyOpts.name ?? null,
    name: earlyOpts.name ?? earlyOpts.thread ?? 'unnamed', thread: earlyOpts.thread ?? null,
    account: account ?? 'main', model: earlyOpts.model ?? null, effort: earlyOpts.effort ?? null,
    mayRun: argv[0] === 'wait' && typeof earlyOpts.thread === 'string',
    outFile: typeof earlyOpts.out === 'string' ? path.resolve(earlyOpts.out) : null,
    logFile: typeof earlyOpts.log === 'string' ? path.resolve(earlyOpts.log) : null }) : null;
}
catch (e) { process.stderr.write(`codex-worker: ${e.message}\n`); process.exit(e.exitCode ?? 2); }
if (tracker) {
  const ancestors = [process.ppid];
  try {
    const parents = new Map(execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 300 })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)));
    for (let pid = process.ppid; ancestors.length < 32 && parents.get(pid) > 1;) {
      pid = parents.get(pid); if (ancestors.includes(pid)) break; ancestors.push(pid);
    }
  } catch {}
  tracker.set({ ancestorPids: ancestors });
}
// Exit also covers validation/RPC failures before report(). Never read a stale --out file.
let outcomeTurn = null, outcomeFinal = '', outcomeSkip = false;
if (tracker) process.on('exit', (exit) => {
  try {
    const state = tracker.metadata();
    const saved = state.thread ? inheritedLaunch(account ?? 'main', { thread: state.thread }) ?? {} : {};
    const options = { ...saved, ...earlyOpts };
    const args = parseRouteArgs(options['route-args']);
    const seat = options['routed-seat'] ? JSON.parse(options['routed-seat']) : {};
    recordWorkerOutcome({ project: options.project ?? routeFlag(args ?? [], 'project') ?? seat.project,
      name: options.name ?? seat.name, category: args?.[0] ?? seat.category, role: options.role ?? seat.role,
      account: account ?? 'main', model: state.model, effort: state.effort, actualModel: state.actualModel,
      startedAt: followerStartedAt, command: argv[0], thread: state.thread, turn: outcomeTurn?.id ?? state.turn,
      exit, final: outcomeFinal, terminal: !!outcomeTurn, skip: outcomeSkip || state.signal });
  } catch (e) { process.stderr.write(`auto-outcome: NOT RECORDED: ${e.message}\n`); }
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) if (tracker) process.once(signal, () => {
  tracker.signal(signal);
  if (!process.listenerCount(signal)) process.exit(signalExit(signal));
});
let foregroundAccountMissing = false;
if (account && !['note', 'ask'].includes(argv[0])) {
  const prof = readAccounts()[account] ?? (account === 'main' ? { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' } : null);
  if (!prof) {
    if (argv.includes('hub') && argv.includes('--foreground')) foregroundAccountMissing = true;
    else { process.stderr.write(`codex-worker: unknown account ${account} (codex-worker accounts; add one with account-add)\n`); process.exit(2); }
  } else { process.env.CODEX_HOME = prof.home; process.env.CODEX_HUB = prof.hub; }
}
const PROF = account ? readAccounts()[account] ?? null : null;
// TTADK web search: the account's provider points at a local proxy that adds Codex's hosted web_search tool to the
// requests (ttadk-search-proxy.mjs says why), so every TTADK worker can search, as on ChatGPT accounts (user,
// 2026-11-07). The proxy runs detached, like the hub; hub/start/turn/wait bring it up when it isn't running.
const searchUrl = (prof) => `http://127.0.0.1:${prof.searchPort}`;
const searchUp = (prof) => fetch(`${searchUrl(prof)}/__health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
const ensureSearchProxy = async (prof) => {
  if (!prof?.searchPort) return false;
  if (await searchUp(prof)) return true;
  const logPath = path.join(prof.home, 'search-proxy.log');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ttadk-search-proxy.mjs');
  spawn(process.execPath, [script, '--port', String(prof.searchPort), '--upstream', prof.upstream ?? 'https://llmbox-global.byteintl.net', '--log', logPath],
    { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); if (await searchUp(prof)) return true; }
  return false;
};
const [cmd, ...rest] = argv;
const opts = { ...earlyOpts }; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--no-browser-preflight') opts['no-browser-preflight'] = true;
  else if (rest[i] === '--headless-playwright' || rest[i] === '--no-headless-playwright') opts[rest[i].slice(2)] = true;
  else if (rest[i] === '--wake') opts.wake = true;
  else if (rest[i] === '--force-large') opts['force-large'] = true;
  else if (rest[i] === '--background') opts.background = true;
  else if (rest[i] === '--require-model' && !['on', 'off'].includes(rest[i + 1])) opts['require-model'] = true;
  else if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else pos.push(rest[i]);
}
const REQUESTED_MODEL = typeof opts.model === 'string' ? opts.model : null;
// TRAE names its models in its own case (GPT-6.1-Sol); accept the router's lower-case ids too.
if (PROF?.kind === 'trae' && typeof opts.model === 'string') opts.model = PROF.modelIds?.[opts.model.toLowerCase()] ?? opts.model;
tracker?.set({ model: opts.model ?? null, requestedModel: REQUESTED_MODEL, effectiveModel: opts.model ?? null,
  actualModel: null, actualModelSource: null, delegatedModels: [] });
const text = pos.join(' ');
// A read-only worker cannot create files: its deliverable is the final message (--out). Warn when the prompt asks for another file.
if (cmd === 'start' && opts.sandbox === 'read-only') {
  const named = [...new Set((text.match(/\b(?:write|save|create|put|output)\b[^.\n]{0,60}?\b([\w./-]+\.(?:md|txt|json|csv|html))\b/gi) ?? [])
    .map(m => m.match(/([\w./-]+\.(?:md|txt|json|csv|html))\b$/i)?.[1]).filter(Boolean))].filter(f => !opts.out || path.basename(f) !== path.basename(String(opts.out)));
  if (named.length) process.stderr.write(`read-only-output: the prompt asks for ${named.join(', ')} but a read-only worker cannot write files; its final message goes to --out. Reword the brief or start with a writable sandbox.\n`);
}
const die = (msg, code = 2) => {
  if (tracker && !tracker.metadata().reason) tracker.set({ reason: msg });
  process.stderr.write(`codex-worker: ${msg}\n`); process.exit(code);
};
const largeThreadMessage = (thread, reason) => {
  const args = parseRouteArgs(opts['route-args']);
  const command = freshThreadRoute(args, path.dirname(fileURLToPath(import.meta.url)));
  const line = `large-thread: ${thread ?? '<not created>'}: ${reason}; start a fresh thread with a handoff brief. Route with the same arguments and --failure-kind infra:\n${command}${args ? '' : '\nNo saved --route-args: add the original route arguments to this command.'}\nUse --force-large only to bypass this guard.`;
  tracker?.result('needs-user', { thread: thread ?? null, settled: true, mayRun: false, phase: 'thread-size', reason: 'thread-too-large', finalLine: line });
  return line;
};
if (cmd === 'turn' && opts.thread && !opts['force-large']) {
  let limits;
  try { limits = sizeLimits(opts); } catch (e) { die(e.message, 2); }
  const exceededAt = readRequestBufferExceededAt(account ?? 'main', opts.thread);
  if (exceededAt != null) die(largeThreadMessage(opts.thread, `provider request buffer exceeded on ${new Date(exceededAt).toISOString()}`), 9);
  const size = await threadSize(PROF?.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), opts.thread);
  if (size.bytes > limits.bytes || size.inputTokens > limits.tokens) {
    die(largeThreadMessage(opts.thread, `${(size.bytes / 1024 / 1024).toFixed(2)} MB rollout, ${size.inputTokens} cumulative input tokens`), 9);
  }
}
try { if (opts.owner !== undefined) opts.owner = resolveOwner(opts.owner); }
catch (e) { die(e.message, e.exitCode ?? 2); }
if (!cmd) die('usage: codex-worker [--account NAME] hub|start|turn|wait|steer|interrupt|status|list|quota|usage|reset-credits|reset-credit-use|accounts|account-add ...');
if (cmd === 'note' || cmd === 'ask') {
  try {
    process.exit(await runWorkerTalkback({ cmd, opts, text, account, cwd: process.cwd(),
      output: (line) => new Promise((resolve, reject) => process.stdout.write(line + '\n', (e) => e ? reject(e) : resolve())),
      report: (line) => process.stderr.write(line + '\n'),
      awaitCommand: (metadata, id) => `RULES_SHARED=${shellQuote(path.resolve(rulesShared()))} ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} --account ${metadata.account} ask --thread ${metadata.thread} --await ${id}` }));
  } catch (e) { die(e.message, e.exitCode ?? 1); }
}
if (cmd === 'reply') {
  if (!opts.thread || !text.trim()) die('reply needs --thread and text');
  try {
    if (opts.question !== undefined && !validOwner(opts.question)) die('--question needs a public question ID');
    const metadata = workerContext(account ?? 'main', opts.thread, true);
    const owner = resolveOwner(opts.owner) ?? metadata?.owner;
    if (metadata && owner !== metadata.owner) die('reply belongs to a different launching owner');
    const answer = answerQuestion({ owner, account: account ?? 'main', thread: opts.thread, questionId: opts.question, text });
    if (answer) { console.log(`answered question ${answer.questionId}`); process.exit(0); }
    if (account && !readAccounts()[account] && account !== 'main') die(`unknown account ${account}`);
    console.log('no open question; falling back to steer');
  } catch (e) { die(e.message, 1); }
}
if (cmd === 'watch' || cmd === 'mine') {
  let owner;
  try { owner = resolveOwner(opts.owner); } catch (e) { die(e.message, e.exitCode ?? 2); }
  if (!validOwner(owner)) die(`${cmd} needs --owner <session-id> (or ORCHESTRATOR_OWNER)`);
  if (cmd === 'watch') {
    const debounceSec = opts['debounce-sec'] === undefined ? 45 : typeof opts['debounce-sec'] === 'string' ? Number(opts['debounce-sec']) : NaN;
    try { process.exit(await watch(owner, undefined, { debounceSec })); } catch (e) { die(e.message, 1); }
  }
  const current = inbox(readEvents(), owner, readAck(owner));
  for (const row of current.unresolved) console.log(`unresolved owner ${row.ownerOriginal}: ${row.ownerResolution} (${row.ownerMatches?.join(', ')||'no full owner in events'}) event=${row.id}`);
  for (const row of current.pending) console.log(eventLine(row));
  const pendingIds = new Set(current.pending.map((row) => row.id));
  for (const row of openQuestions(readEvents(), { owner })) if (!pendingIds.has(row.id)) console.log(eventLine(row));
  // Only query already-known threads; never start a hub or a replacement from mine.
  for (const row of current.running) {
    let status = 'unknown', observed = null;
    if (row.thread) {
      try {
        const output = execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--account', row.account,
          'status', '--thread', row.thread], { encoding: 'utf8', timeout: Number(process.env.MINE_STATUS_TIMEOUT_MS ?? 15000), stdio: ['ignore', 'pipe', 'ignore'] });
        observed = JSON.parse(output.trim()); status = observed.last?.status ?? 'unknown';
        if (observed.last && ['completed', 'failed', 'interrupted'].includes(status)) appendEvent({ ...row, event: 'observed', mayRun: false,
          turn: observed.last.id, status, stale: false, finalLine: `hub confirms ${status}; read the result or reattach with wait` });
      } catch {
        // A slow hub read (long threads on a large history) is not "unknown" while this worker's follower is alive.
        try { if (Number.isSafeInteger(row.pid) && row.pid > 0) { process.kill(row.pid, 0); status = 'running (follower alive; hub read slow)'; } } catch {}
      }
    } else {
      try { process.kill(row.pid, 0); status = 'running'; } catch {}
    }
    console.log(`${row.name}\t${status === 'inProgress' ? 'running (hub)' : status}${row.stale && status === 'unknown' ? ' (stale follower; hub status unconfirmed)' : ''}\t${row.outFile ?? '-'}\tthread=${row.thread ?? '-'} account=${row.account}`);
  }
  process.exit(0);
}
if ((cmd === 'start' || cmd === 'turn') && typeof opts.effort !== 'string') die(`${cmd} needs --effort (the catalog default may be low)`);
const STALL_MIN = opts['stall-min'] === undefined ? 30 : Number(opts['stall-min']);
// Connect/initialize/thread and turn start normally take seconds; five minutes covers a loaded host (T89 hung here for 7 h).
const SETUP_MAX_SEC = Number(process.env.CODEX_WORKER_SETUP_MAX_SEC ?? 300);
if (!Number.isFinite(STALL_MIN) || STALL_MIN < 0) die('--stall-min takes a number >= 0');
const CONTROL_SEC = Number(opts['interrupt-timeout-sec'] ?? 30);
if (!Number.isFinite(CONTROL_SEC) || CONTROL_SEC <= 0) die('--interrupt-timeout-sec takes a positive number');
if (cmd === 'start' && typeof opts.sandbox !== 'string') die('start needs --sandbox (read-only | workspace-write | danger-full-access; never wider than the orchestrator)');
const SANDBOX_POLICY = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
if (opts.sandbox !== undefined && !SANDBOX_POLICY[opts.sandbox]) die(`unknown --sandbox ${opts.sandbox}`);
if (opts.network === true) opts.network = 'on';
if (opts.network !== undefined && !['on', 'off'].includes(opts.network)) die('--network takes on or off');
if (opts.network !== undefined && !['workspace-write','read-only','danger-full-access'].includes(opts.sandbox)) die('--network needs an explicit sandbox');
if(opts.network==='off'&&opts.sandbox==='danger-full-access') die('Network off requires a read-only or workspace-write sandbox');
// Optimistic-launch patience (addendum, 2026-11-13 night): route.mjs passes the deadline it computed from the faster
// account's reset and the alternative to take. Positive drain can trigger an early handoff; elapsed patience also
// expires for flat/unknown queues, independently of notifications, after confirming no-progress cancellation.
const PATIENCE_MIN = opts['queue-patience-min'] === undefined ? null : Number(opts['queue-patience-min']);
if (PATIENCE_MIN != null && (!Number.isFinite(PATIENCE_MIN) || PATIENCE_MIN <= 0)) die('--queue-patience-min takes a positive number of minutes');
const QUEUE_ALT = typeof opts.alt === 'string' ? opts.alt : null;
if (opts['queue-alternative'] !== undefined) {
  try {
    const alternative = JSON.parse(opts['queue-alternative']);
    if (!alternative || typeof alternative !== 'object' || Array.isArray(alternative)) throw Error('not an object');
    parseRouteArgs(JSON.stringify(alternative.routeArgs));
    opts.queueAlternative = alternative;
  } catch { die('--queue-alternative needs an object with routing argv in routeArgs'); }
}
const QUEUE_ALT_START_MIN = opts['queue-alt-start-min'] === undefined ? null : Number(opts['queue-alt-start-min']);
if (QUEUE_ALT_START_MIN != null && (!Number.isFinite(QUEUE_ALT_START_MIN) || QUEUE_ALT_START_MIN < 0)) die('--queue-alt-start-min takes a number >= 0');
let ROUTE_ARGS;
try { ROUTE_ARGS = parseRouteArgs(opts['route-args']); } catch (e) { die(e.message); }
const REROUTE_DEPTH = Number(opts['auto-reroute-depth'] ?? (ROUTE_ARGS && routeFlag(ROUTE_ARGS, 'auto-reroute-depth')) ?? 0);
if (!Number.isInteger(REROUTE_DEPTH) || REROUTE_DEPTH < 0) die('--auto-reroute-depth takes a whole number >= 0');
tracker?.set({ routeArgs: ROUTE_ARGS, rerouteDepth: REROUTE_DEPTH });
const BACKGROUND = !!opts.background || !!(ROUTE_ARGS && routeFlag(ROUTE_ARGS, 'background'));
let routedMetadata;try {routedMetadata=opts['routed-seat']?JSON.parse(opts['routed-seat']):undefined;} catch {die('--routed-seat needs JSON');}
const projectWorkerInstructions = (digest) => workerInstructions(digest, {
  project: opts.project ?? (ROUTE_ARGS && routeFlag(ROUTE_ARGS, 'project')) ?? routedMetadata?.project,
});
const auditStart = (model=opts.model,sandbox=opts.sandbox,continued) => {
  try {return auditLaunch({ name: opts.name??continued?.name, continuation:continued?.thread, project:opts.project??(ROUTE_ARGS&&routeFlag(ROUTE_ARGS,'project'))??undefined,
    account:account??'main',model,effort:opts.effort,sandbox,userOK:opts['user-ok'],role:opts.role,seat:routedMetadata});}
  catch(e) {die(e.message,e.exitCode??1);}
};
const talkbackContext = (thread) => {
  const state = tracker.metadata();
  const prior = workerContext(account ?? 'main', thread, true);
  const metadata = { account: account ?? 'main', thread, owner: tracker.owner, name: opts.name ?? prior?.name ?? state.name,
    project: opts.project ?? prior?.project ?? state.project, task: opts.task ?? prior?.task ?? state.task,
    runId: state.runId, model: state.model, effort: state.effort, turn: state.turn ?? null,
    cwd: path.resolve(opts.cwd ?? prior?.cwd ?? process.cwd()), startedAt: followerStartedAt };
  const file = saveWorkerContext(metadata);
  const env = { CODEX_WORKER_THREAD: thread, CODEX_WORKER_ACCOUNT: metadata.account,
    CODEX_WORKER_OWNER: metadata.owner ?? '', CODEX_WORKER_NAME: String(metadata.name), RULES_SHARED: path.dirname(path.dirname(path.dirname(file))) };
  return { metadata, config: { shell_environment_policy: { set: env } }, instructions:
    `Worker talkback identity: thread=${thread} account=${metadata.account} owner=${metadata.owner ?? 'unknown'}. Public context: ${file}.\n`
    // Keep ready-to-run explicit commands; bare commands also resolve the running
    // context by cwd when the hub does not pass per-thread shell environment.
    + `To send the orchestrator a note without stopping (kinds: risk, scope, progress, info):\nRULES_SHARED=${shellQuote(env.RULES_SHARED)} ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} --account ${metadata.account} note --thread ${thread} --kind info "<text>"\n`
    + `To ask the orchestrator and wait for the answer (exit 3 = timeout, proceed with default; exit 4 = timeout without default):\nRULES_SHARED=${shellQuote(env.RULES_SHARED)} ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} --account ${metadata.account} ask --thread ${thread} --timeout-min 20 --default "<what you will do if nobody answers>" "<question>"\n`
    + 'In read-only/workspace-write, denied shared writes are relayed through your command output without widening the sandbox. If ask exits 6, run the exact ask --await <id> command printed on stderr; it only reads, preserves the original question/default/deadline and does not ask again.\n'
    + 'Use ask only for a decision the brief does not settle that changes your next action; state --default. Use note only for a risk, a scope change, a decision you made, a landed commit, or a finding that changes someone else\'s work, never routine progress, tool hiccups (probe timeouts, missing metadata) or status. Info/progress notes are delivered on the next natural wake; risk/scope notes and asks wake. Use note --wake only when it changes someone else\'s work now. A blocker needing the user still ends the turn BLOCKED.' };
};
// Check metadata only: --out is a final-message destination, sometimes also mistakenly
// named as a worker deliverable. Never inspect the contents to decide whether it changed.
let outBaseline;
const outputStat = () => { try { const s = fs.statSync(path.resolve(opts.out)); return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'); } catch { return null; } };
const markOutputStart = () => { if (opts.out) outBaseline = outputStat(); };
const launchDecision = cmd === 'start' ? auditStart() : null;
const reviewHowTo = reviewSeat({ category: ROUTE_ARGS?.[0] ?? routedMetadata?.category ?? launchDecision?.category,
  role: opts.role ?? routedMetadata?.role, name: opts.name }) ? reviewInstructions : null;
if (cmd === 'start') tracker?.warning();
// Codex's own default for workspace-write network, so an explicit turn-level policy doesn't silently change it.
const configNetwork = () => {
  try {
    const toml = fs.readFileSync(PROF?.kind === 'trae' ? path.join(PROF.home, 'traecli.toml') : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
    const section = toml.split(/^\[/m).find((s) => s.startsWith('sandbox_workspace_write]')) ?? '';
    return /^\s*network_access\s*=\s*true\b/m.test(section);
  } catch { return false; }
};
// The turn-level sandbox policy. Don't add git dirs as writable roots: Codex overrides them read-only on purpose, since
// a sandboxed write to .git/hooks or .git/config would run outside the sandbox at the next git command.
const sandboxPolicy = (mode) => mode === 'workspace-write'
  ? { type: 'workspaceWrite', networkAccess: opts.network === undefined ? configNetwork() : opts.network === 'on' }
  : { type: SANDBOX_POLICY[mode], ...(mode==='read-only'&&opts.network!==undefined?{networkAccess:opts.network==='on'}:{}) };

if (cmd === 'accounts') {
  const reg = readAccounts();
  if (!Object.keys(reg).length) console.log('main\t~/.codex\tws://127.0.0.1:47321\t(default; no accounts file yet)');
  for (const [name, a] of Object.entries(reg)) console.log([name, a.home, a.hub, a.email ?? '-', a.plan ?? '-'].join('\t'));
  process.exit(0);
}
// Browser use and Computer Use on a Codex worker (verified 2026-11-07 with the TTADK gateway's gpt-6.1-sol). Both drive the
// local pieces the ChatGPT app uses: its bundled `chrome` and `computer-use` plugins (instructions + browser-client) and
// ChatGPT.app's node_repl MCP server, which loads @oai/browser-desktop (Chrome, via the ChatGPT Chrome extension and its
// native host) and @oai/sky (desktop apps, via the "Codex Computer Use" helper).
// `browser-setup` gives the account the main home's plugins (user, 2026-11-07: align the accounts) and writes what a CLI
// run needs into its config.toml (backed up first):
// - installs (`codex plugin add`, which a config entry alone does not do) the bundled chrome, computer-use and visualize
//   plugins, and documents / pdf / spreadsheets / presentations / template-creator from the primary runtime the app
//   unpacks under ~/.cache/codex-runtimes (their dependencies live there, shared by every home). The name
//   `openai-bundled` is reserved and resolves only on the app's own home, so another home lists the same plugin dirs
//   through a small local marketplace `chatgpt-bundled` (<home>/marketplaces/chatgpt-bundled, plugins symlinked to the
//   app's unpacked copy). App-only plugins stay off: in-app `browser`, `codex-app-tools`, and `unified-computer-use`,
//   whose cua_repl needs the app's browser access host ("The browser access host is unavailable" on a CLI run, tested
//   2026-11-07); so do ChatGPT connectors;
// - node_repl as an MCP server, as the ChatGPT app writes it into the main home's config.toml (the chrome and
//   computer-use plugins are instructions + hooks on that server, not servers themselves);
// - node_repl with tool calls auto-approved (under approvalPolicy never they would be refused outright);
// - NODE_REPL_TRUSTED_SERVICES for sky + browser (the ChatGPT app sets it itself; a CLI launch has to).
// Per-site and per-app access stays per task: `start/turn --browser-origins` / `--computer-use-apps` answer those approvals.
// The official [browser_use.origins] / [computer_use.macos.bundle_ids] config is not consulted on CLI runs (tested).
if (cmd === 'browser-setup' || cmd === 'computer-use-setup') {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cfg = path.join(home, 'config.toml');
  const repl = '/Applications/ChatGPT.app/Contents/Resources/cua_node';
  const market = path.join(os.homedir(), '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled');
  const chromePlugin = path.join(market, 'plugins', 'chrome');
  if (!fs.existsSync(path.join(repl, 'bin', 'node_repl'))) die(`ChatGPT.app's node_repl not found under ${repl}: install the ChatGPT desktop app`, 1);
  if (!fs.existsSync(chromePlugin)) die(`bundled chrome plugin not found under ${market}: open the ChatGPT desktop app once (it unpacks the bundled plugins)`, 1);
  try { if (fs.lstatSync(cfg).isSymbolicLink()) die(`${cfg} is a symlink to another home's config; browser-setup only writes an account's own config (TTADK homes have one)`, 1); } catch {}
  // The ChatGPT Chrome extension must be installed and enabled, with its native host registered.
  try { execFileSync(process.execPath, [path.join(chromePlugin, 'scripts', 'check-extension-installed.js'), '--browser', 'chrome', '--json'], { encoding: 'utf8', timeout: 20000 }); }
  catch (e) { die(`ChatGPT Chrome extension check failed (${String(e.stdout || e.message).split('\n')[0]}): in the ChatGPT app, Settings > Computer use > Google Chrome > install the browser extension`, 1); }
  const MARK = '# --- Browser/Computer Use (codex-worker browser-setup) ---', END = '# --- end browser-setup ---';
  const runtime = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'plugins', 'openai-primary-runtime');
  const docPlugins = ['documents', 'pdf', 'spreadsheets', 'presentations', 'template-creator'];
  const hasRuntime = fs.existsSync(path.join(runtime, 'plugins', 'documents'));
  if (!hasRuntime) console.error(`note: the ChatGPT app's primary runtime is not under ${runtime} (open the ChatGPT app once to unpack it); document plugins skipped`);
  // The bundled plugins through a local marketplace of our own name (see above); rebuilt on every run, so a rerun after
  // a ChatGPT app update picks up the new plugin versions.
  const bundled = ['chrome', 'computer-use', 'visualize'];
  const ownMarket = path.join(home, 'marketplaces', 'chatgpt-bundled');
  fs.mkdirSync(path.join(ownMarket, '.agents', 'plugins'), { recursive: true });
  try { fs.rmSync(path.join(ownMarket, 'plugins'), { force: true }); } catch {}
  fs.symlinkSync(path.join(market, 'plugins'), path.join(ownMarket, 'plugins'));
  const manifest = JSON.parse(fs.readFileSync(path.join(market, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  fs.writeFileSync(path.join(ownMarket, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ ...manifest, name: 'chatgpt-bundled', plugins: manifest.plugins.filter((x) => bundled.includes(x.name)) }, null, 2));
  const runtimeBlock = hasRuntime ? `
[marketplaces.openai-primary-runtime]
source_type = "local"
source = "${runtime}"
${docPlugins.map((p) => `\n[plugins."${p}@openai-primary-runtime"]\nenabled = true\n`).join('')}` : '';
  // The same node_repl environment the ChatGPT app writes for itself, with the app's own version (the Chrome backend
  // checks it: without these, the browser runtime reports "Browser is not available: chrome").
  let appVersion = '';
  try { appVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/ChatGPT.app/Contents/Info.plist'], { encoding: 'utf8' }).trim(); } catch {}
  const block = `${MARK}
[marketplaces.chatgpt-bundled]
source_type = "local"
source = "${ownMarket}"
${bundled.map((p) => `\n[plugins."${p}@chatgpt-bundled"]\nenabled = true\n`).join('')}${runtimeBlock}
[mcp_servers.node_repl]
args = []
command = "${repl}/bin/node_repl"
env_vars = ["BROWSER_USE_ACCESS_EXECUTOR_ID", "BROWSER_USE_ACCESS_PIPE_PATH", "BROWSER_USE_ACCESS_VERIFYING_IDENTITY"]
startup_timeout_sec = 120
default_tools_approval_mode = "approve"

[mcp_servers.node_repl.env]
NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"
NODE_REPL_NODE_MODULE_DIRS = "${repl}/lib/node_modules"
NODE_REPL_NODE_PATH = "${repl}/bin/node"
NODE_REPL_TRUSTED_CODE_PATHS = "${home}:${os.homedir()}/.codex:${repl}/lib/node_modules"
NODE_REPL_TRUSTED_SERVICES = '{"sky":"@oai/sky/service","browser":"@oai/browser-desktop/service"}'
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"
BROWSER_USE_TINYSKY_ENABLED = "1"
BROWSER_USE_CODEX_APP_BUILD_FLAVOR = "prod"
BROWSER_USE_CODEX_APP_VERSION = "${appVersion}"
CODEX_HOME = "${home}"
${END}
`;
  let toml = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
  if (toml.includes(MARK)) {
    // Rewrite our own block in place (rerun after a ChatGPT app update); an older block without END ran to the end.
    const i = toml.indexOf(MARK), j = toml.indexOf(END, i);
    toml = toml.slice(0, i) + block + (j >= 0 ? toml.slice(j + END.length).replace(/^\n/, '') : '');
  } else {
    if (/^\[mcp_servers\.node_repl\]/m.test(toml) || /^\[plugins\."[^"]+@(openai-bundled|openai-primary-runtime|chatgpt-bundled)"\]/m.test(toml) || /^\[marketplaces\.(openai-bundled|openai-primary-runtime|chatgpt-bundled)\]/m.test(toml))
      die(`${cfg} already has node_repl / plugin / openai-bundled sections that differ from what this writes; edit them by hand (references/codex-workers.md, "Browser use on a Codex worker")`, 1);
    toml += `\n${block}`;
  }
  if (fs.existsSync(cfg)) fs.copyFileSync(cfg, `${cfg}.bak-browser-${Date.now()}`);
  fs.writeFileSync(cfg, toml);
  // Install them; `plugin add` keeps the entries above as they are.
  const installed = [], failed = [];
  for (const id of [...bundled.map((p) => `${p}@chatgpt-bundled`), ...(hasRuntime ? docPlugins.map((p) => `${p}@openai-primary-runtime`) : [])]) {
    try { execFileSync('codex', ['plugin', 'add', id], { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 }); installed.push(id); }
    catch (e) { failed.push(`${id} (${String(e.stderr || e.message).trim().split('\n')[0]})`); }
  }
  // Remember on the account profile that this home can take browser work (route.mjs reads it).
  const reg = readAccounts();
  const name = account ?? Object.keys(reg).find((k) => path.resolve(reg[k].home) === path.resolve(home));
  if (name && reg[name]) { reg[name].browser = true; reg[name].chromePlugin = chromePlugin; writeAccounts(reg); }
  console.log(`plugins installed: ${installed.join(', ') || 'none'}${failed.length ? `; FAILED: ${failed.join('; ')}` : ''}`);
  console.log(`browser use configured in ${cfg}${name ? ` (account ${name} marked browser-ready)` : ''}. Launch workers through the hub with --browser-origins <patterns> (and --computer-use-apps <bundle ids> for desktop apps); keep Chrome running.`);
  process.exit(failed.length ? 1 : 0);
}
// The TTADK company gateway as a Codex account (user, 2026-11-07: prefer it whenever it works). Its own CODEX_HOME whose
// config points the model provider at the gateway, authenticated by `ttadk get_params --sso sso` (SSO, no key).
if (cmd === 'ttadk-setup') {
  const name = typeof opts.name === 'string' ? opts.name : 'ttadk';
  let ttadkBin = '';
  try { ttadkBin = execFileSync('/bin/zsh', ['-lc', 'command -v ttadk'], { encoding: 'utf8' }).trim(); } catch {}
  if (!ttadkBin) die('ttadk not found: npm install -g @byted/ttadk@latest --registry=https://bnpm.byted.org', 1);
  let st = null;
  try { st = JSON.parse(execFileSync(ttadkBin, ['auth', 'status', '-f', 'json'], { encoding: 'utf8', timeout: 30000 })); } catch {}
  const sso = (st?.providers ?? []).find((x) => x.provider === 'sso');
  if (sso?.status !== 'active') die('TTADK SSO is not logged in: ask the user to run `! ttadk auth login sso`', 1);
  let models = [];
  try { models = ((j) => (Array.isArray(j) ? j : j.models ?? []))(JSON.parse(execFileSync(ttadkBin, ['models', '-f', 'json'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }))).filter((m) => (m.availableAgents ?? []).includes('codex')).map((m) => m.id); } catch {}
  const qualified=new Set(['light','normal','hard'].flatMap(tier=>modelPreference({category:'analysis',tier,contentLabels:[]},{kind:'ttadk'})).concat(modelPreference({category:'image-read',tier:'normal',contentLabels:[]},{kind:'ttadk'}),['kimi-k3']));
  const usable=models.filter(m=>qualified.has(m.toLowerCase()));if(!usable.length)die('the TTADK gateway lists no usable qualified Codex model',1);
  const gatewayDefault=usable.includes('gpt-6.1-sol')?'gpt-6.1-sol':usable[0];
  const reg = readAccounts();
  reg.main ??= { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' };
  const home = path.resolve(typeof opts.home === 'string' ? opts.home : reg[name]?.home ?? path.join(os.homedir(), `.codex-${name}`));
  const ports = Object.entries(reg).filter(([k]) => k !== name).map(([, a]) => Number(new URL(a.hub).port));
  const port = Number(opts.port ?? (reg[name] ? new URL(reg[name].hub).port : Math.max(...ports) + 1));
  fs.mkdirSync(home, { recursive: true });
  for (const f of ['AGENTS.md', 'skills', 'rules']) {
    const src = path.join(os.homedir(), '.codex', f), dst = path.join(home, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
  }
  const cfg = path.join(home, 'config.toml');
  if (!fs.existsSync(cfg) || !fs.readFileSync(cfg, 'utf8').includes('model_provider = "ttadk_app"')) {
    if (fs.existsSync(cfg)) fs.copyFileSync(cfg, `${cfg}.bak-ttadk-${Date.now()}`);
    const keep = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
    fs.writeFileSync(cfg, `# TTADK company gateway (codex-worker ttadk-setup). Models: ${models.join(', ')}
model = "${gatewayDefault}"
model_provider = "ttadk_app"

[model_providers.ttadk_app]
name = "ttadk_app"
base_url = "https://llmbox-global.byteintl.net/"
wire_api = "responses"

[model_providers.ttadk_app.http_headers]
X-Source = "ttadk"

[model_providers.ttadk_app.auth]
command = "${ttadkBin}"
args = ["get_params", "--sso", "sso"]
timeout_ms = 5000
refresh_interval_ms = 2000000

[sandbox_workspace_write]
network_access = true
${keep ? `\n# --- previous config ---\n${keep}` : ''}`);
  }
  // Web search: the provider's base_url is the local proxy (ttadk-search-proxy.mjs), which forwards to the gateway.
  const searchPort = Number(opts['search-port'] ?? reg[name]?.searchPort ?? port + 100);
  let ctoml = fs.readFileSync(cfg, 'utf8');
  const sec = ctoml.match(/^\[model_providers\.ttadk_app\]\n(?:(?!^\[)[^\n]*\n?)*/m);
  if (!sec) die(`${cfg} has no [model_providers.ttadk_app] section; move it aside and rerun ttadk-setup`, 1);
  ctoml = ctoml.replace(sec[0], sec[0].replace(/^base_url\s*=.*$/m, `base_url = "http://127.0.0.1:${searchPort}/" # local proxy → https://llmbox-global.byteintl.net/ (web search)`));
  // Drop the earlier second provider (research-only search, 2026-11-07), if this home has it.
  const SM = '# --- TTADK web search provider (codex-worker ttadk-setup) ---', SE = '# --- end TTADK web search provider ---';
  if (ctoml.includes(SM)) { const i = ctoml.indexOf(SM), j = ctoml.indexOf(SE, i); ctoml = ctoml.slice(0, i) + (j >= 0 ? ctoml.slice(j + SE.length).replace(/^\n/, '') : ''); }
  fs.writeFileSync(cfg, ctoml);
  const { searchHub: _drop, ...prev } = reg[name] ?? {};
  reg[name] = { ...prev, home, hub: `ws://127.0.0.1:${port}`, kind: 'ttadk', models, ttadkBin, searchPort, upstream: 'https://llmbox-global.byteintl.net' };
  writeAccounts(reg);
  console.log(`TTADK account ${name}: ${home}, hub ws://127.0.0.1:${port}; codex models: ${models.join(', ')}`);
  console.log(`start its hub:   node ${process.argv[1]} --account ${name} hub`);
  console.log(`browser use:     node ${process.argv[1]} --account ${name} browser-setup   (also enables the main home's document plugins)`);
  console.log(`web search:      through the local proxy on 127.0.0.1:${searchPort} (started with the hub, and by start/turn/wait)`);
  process.exit(0);
}
// TRAE CLI as a Codex account (user, 2026-11-08: TTADK first, then TRAE, then personal quota). TRAE CLI is the company's
// official agent CLI, a fork of Codex: `traex app-server` speaks the hub protocol, `traecli exec` mirrors `codex exec`,
// and its GPT-6.1-Sol gets the official Codex prompt and tools (compared 2026-11-08). Its model pool is separate from
// TTADK's. It has no ChatGPT browser/computer-use (the Chrome extension accepts only the OpenAI-signed client) and no
// image generation; the launcher configures Playwright per thread. Setup writes into ~/.trae/traecli.toml: commits
// without TRAE's co-author line, live web search, optional global Playwright, and network in workspace-write (as TTADK);
// then registers the account.
// A traecli exec run bypasses this script: the orchestrator records its failure here (route.mjs says so).
// Recovery probe (lib/trae-health.mjs): one tiny read-only turn on the paused family's model via traecli exec.
if (cmd === 'probe') {
  if (PROF?.kind !== 'trae' || typeof opts.model !== 'string') die('probe is for the TRAE account: --account trae probe --model M');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-probe-'));
  let out = '', ok = false;
  try {
    out = execFileSync(PROF.bin ?? 'traecli', ['exec', '--skip-git-repo-check', '-C', dir, '-s', 'read-only', '-m', opts.model, '-c', 'model_reasoning_effort="low"', '--json', 'Reply with the single word OK.'],
      { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
    ok = /"type":"turn\.completed"/.test(out) && !/"type":"(turn\.failed|error)"/.test(out);
  } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? e.message); }
  fs.rmSync(dir, { recursive: true, force: true });
  const why = ok ? '' : (/"message":"([^"]{1,200})/.exec(out)?.[1] ?? out.trim().split('\n').at(-1) ?? 'failed').slice(0, 200);
  const applied=probeResult(PROF.home, opts.model, ok, why, Date.now(), opts['probe-claim']);
  console.log(!applied ? `probe ignored: ${opts.model}; claim is missing or superseded` : ok ? `probe ok: ${opts.model} answers again; its family is back in routing` : `probe failed: ${opts.model} — ${why}`);
  process.exit(ok ? 0 : 1);
}
if (cmd === 'note-failure') {
  if (PROF?.kind !== 'trae') die('note-failure is for the TRAE account (--account trae)');
  const p = noteFailure(PROF.home, pos.join(' ') || 'traecli exec failed', Date.now(), typeof opts.model === 'string' ? opts.model : null);
  if (p?.modelPause) console.log(unavailableHint(p));
  else console.log(p ? `trae-paused: ${pausedWhat(p)} until ${new Date(p.pausedUntil).toLocaleTimeString()} (${p.reason}); route.mjs sends its work elsewhere meanwhile` : 'recorded');
  process.exit(0);
}
if (cmd === 'trae-setup') {
  if (opts['headless-playwright'] && opts['no-headless-playwright']) die('choose --headless-playwright or --no-headless-playwright');
  const name = typeof opts.name === 'string' ? opts.name : 'trae';
  let bin = '';
  try { bin = execFileSync('/bin/zsh', ['-lc', 'command -v traex || ls ~/.local/bin/traex'], { encoding: 'utf8' }).trim().split('\n')[0]; } catch {}
  if (!bin) die('TRAE CLI not found: sh -c "$(curl -fsSL https://code.byted.org/api/tos-proxy/download/traex_install.sh)"', 1);
  let status = '';
  try { status = execFileSync('/bin/sh', ['-c', '"$0" login status 2>&1', bin], { encoding: 'utf8', timeout: 30000 }); } catch (e) { status = String(e.stdout ?? ''); } // it prints to stderr
  if (!/logged in/i.test(status) || /not logged in/i.test(status)) die('TRAE CLI is not logged in: run `traecli login --git-code` (or ask the user to run `! traecli login --sso`)', 1);
  let ids = [];
  try { ids = execFileSync(bin, ['models'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][\w.-]*$/.test(l)); } catch {}
  if (!ids.some((i) => i.toLowerCase() === 'gpt-6.1-sol')) die(`TRAE CLI lists no GPT-6.1-Sol (models: ${ids.join(', ') || 'none'})`, 1);
  const home = path.join(os.homedir(), '.trae'), cfg = path.join(home, 'traecli.toml');
  let toml = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '';
  const strip = (t, a, b) => { const i = t.indexOf(a); if (i < 0) return t; const j = t.indexOf(b, i); return t.slice(0, i) + (j >= 0 ? t.slice(j + b.length).replace(/^\n/, '') : ''); };
  const TA = '# --- worker settings (codex-worker trae-setup) ---', TB = '# --- end worker settings ---';
  const MA = '# --- playwright MCP (codex-worker trae-setup) ---', MB = '# --- end playwright MCP ---';
  const WA = '# --- worker tools (codex-worker trae-setup) ---', WB = '# --- end worker tools ---';
  toml = strip(strip(strip(toml, TA, TB), MA, MB), WA, WB);
  // Top-level keys must come before every [table].
  toml = `${TA}\ncommit_attribution = ""\nweb_search = "live"\n${TB}\n${toml}`;
  // hatch-pet (a Codex pet toy in the shared skills dir) is off on the main home too.
  const pet = path.join(os.homedir(), '.agents', 'skills', 'hatch-pet', 'SKILL.md');
  const petOff = fs.existsSync(pet) ? `\n[[skills.config]]\npath = "${pet}"\nenabled = false\n` : '';
  toml = `${toml.replace(/\n*$/, '\n')}\n${WA}${petOff}\n[sandbox_workspace_write]\nnetwork_access = true\n${WB}\n`;
  if (opts['headless-playwright']) toml += `\n${MA}\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--headless", "--isolated"]\nstartup_timeout_sec = 120\ndefault_tools_approval_mode = "approve"\n${MB}\n`;
  if (fs.existsSync(cfg)) fs.copyFileSync(cfg, `${cfg}.bak-worker-${Date.now()}`);
  fs.writeFileSync(cfg, toml);
  // The document plugins the other Codex accounts have (browser-setup): skills plus the primary runtime's shared
  // dependencies, so they work on TRAE too. Installed from the directories the ChatGPT app unpacks.
  const runtime = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'plugins', 'openai-primary-runtime', 'plugins');
  const bundled = path.join(os.homedir(), '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled', 'plugins');
  const want = [...['documents', 'pdf', 'spreadsheets', 'presentations', 'template-creator'].map((p) => path.join(runtime, p)), path.join(bundled, 'visualize')];
  let have = '';
  try { have = execFileSync(bin, ['plugin', 'list'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch {}
  const plugins = [], missing = [];
  for (const dir of want) {
    const pn = path.basename(dir);
    if (!fs.existsSync(dir)) { missing.push(`${pn} (not unpacked: open the ChatGPT app once)`); continue; }
    if (new RegExp(`^\\s*id: ${pn}@`, 'm').test(have)) { plugins.push(pn); continue; }
    try { execFileSync(bin, ['plugin', 'install', '--type', 'local', '--yes', dir], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }); plugins.push(pn); }
    catch (e) { missing.push(`${pn} (${String(e.stderr || e.message).trim().split('\n')[0]})`); }
  }
  const reg = readAccounts();
  reg.main ??= { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' };
  const ports = Object.entries(reg).filter(([k]) => k !== name).map(([, a]) => Number(new URL(a.hub).port));
  const port = Number(opts.port ?? (reg[name] ? new URL(reg[name].hub).port : Math.max(...ports) + 1));
  const modelIds = Object.fromEntries(ids.map((i) => [i.toLowerCase(), i]));
  reg[name] = { ...(reg[name] ?? {}), home, hub: `ws://127.0.0.1:${port}`, kind: 'trae', bin, models: Object.keys(modelIds), modelIds, search: true };
  writeAccounts(reg);
  console.log(`TRAE account ${name}: hub ws://127.0.0.1:${port} (traex app-server); models: ${ids.join(', ')}`);
  console.log(`config: ${cfg} (no co-author line, live web search, ${opts['headless-playwright'] ? 'global headless Playwright opted in' : 'Playwright configured per thread'}, network in workspace-write, hatch-pet off)`);
  console.log(`plugins: ${plugins.join(', ') || 'none'}${missing.length ? `; NOT installed: ${missing.join('; ')}` : ''}`);
  console.log(`start its hub:   node ${process.argv[1]} --account ${name} hub`);
  process.exit(0);
}
// The console session is locked: Computer Use sees no windows (cgWindowNotFound). The ChatGPT app's "Locked use" unlock is
// reserved to its own turns by design, so a CLI worker can't use it; fail early instead.
const screenLocked = () => {
  try {
    const out = execFileSync('python3', ['-c', "import ctypes,ctypes.util,re\ncf=ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreFoundation'))\nq=ctypes.cdll.LoadLibrary('/System/Library/Frameworks/Quartz.framework/Quartz')\nq.CGSessionCopyCurrentDictionary.restype=ctypes.c_void_p\ncf.CFCopyDescription.restype=ctypes.c_void_p;cf.CFCopyDescription.argtypes=[ctypes.c_void_p]\ncf.CFStringGetCString.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_long,ctypes.c_uint32]\nb=ctypes.create_string_buffer(8192);cf.CFStringGetCString(cf.CFCopyDescription(q.CGSessionCopyCurrentDictionary()),b,8192,0x08000100)\nprint('locked' if re.search(r'CGSSessionScreenIsLocked\\W+=\\W*1',b.value.decode()) else 'unlocked')"], { encoding: 'utf8', timeout: 10000 });
    return out.trim() === 'locked';
  } catch { return false; }
};
if (cmd === 'account-add') {
  // A second (third, …) account: its own CODEX_HOME sharing the main home's config, instructions, skills and rules (not
  // its sessions, logins or databases), and its own hub port. The user logs it in once; it then runs side by side.
  const name = pos[0];
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) die('usage: codex-worker account-add <name> [--home DIR] [--port N]');
  const reg = readAccounts();
  const main = path.join(os.homedir(), '.codex');
  reg.main ??= { home: main, hub: 'ws://127.0.0.1:47321' };
  if (reg[name]) die(`account ${name} exists: ${reg[name].home} ${reg[name].hub}`);
  const ports = Object.values(reg).map((a) => Number(new URL(a.hub).port));
  const port = Number(opts.port ?? Math.max(...ports) + 1);
  const home = path.resolve(typeof opts.home === 'string' ? opts.home : path.join(os.homedir(), `.codex-${name}`));
  fs.mkdirSync(home, { recursive: true });
  for (const f of ['config.toml', 'AGENTS.md', 'skills', 'rules']) {
    const src = path.join(main, f), dst = path.join(home, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
  }
  reg[name] = { home, hub: `ws://127.0.0.1:${port}` };
  writeAccounts(reg);
  console.log(`account ${name}: ${home}, hub ws://127.0.0.1:${port}`);
  console.log(`log it in once:  CODEX_HOME=${home} codex login`);
  console.log(`then:            node ${process.argv[1]} --account ${name} hub`);
  process.exit(0);
}
const CU_APPS = typeof opts['computer-use-apps'] === 'string' ? opts['computer-use-apps'].split(',').map((x) => x.trim()).filter(Boolean) : [];
// --browser-origins: exact origins (https://x.y) or host globs (*.bytedance.net matches the host and its subdomains).
const BU_ORIGINS = typeof opts['browser-origins'] === 'string' ? opts['browser-origins'].split(',').map((x) => x.trim()).filter(Boolean) : [];
const PLAYWRIGHT_EXTENSION_TOKEN_FILE = process.env.PLAYWRIGHT_EXTENSION_TOKEN_FILE
  || path.join(os.homedir(), '.trae', 'playwright-extension-token');
const ROUTE_CATEGORY = ROUTE_ARGS?.[0] ?? routedMetadata?.category;
const TRAE_HEADLESS_BROWSER = PROF?.kind === 'trae' && ROUTE_CATEGORY === 'ui-browser' && ['start', 'turn'].includes(cmd);
const TRAE_BROWSER_REQUEST = PROF?.kind === 'trae' && !TRAE_HEADLESS_BROWSER && (BU_ORIGINS.length > 0 || ROUTE_CATEGORY === 'browser') && ['start', 'turn'].includes(cmd);
if (TRAE_BROWSER_REQUEST && !BU_ORIGINS.length) die('TRAE browser threads need --browser-origins to scope signed-in Chrome access', 1);
const TRAE_EXTENSION_BROWSER = TRAE_BROWSER_REQUEST && fs.existsSync(PLAYWRIGHT_EXTENSION_TOKEN_FILE);
const CHROME_PROFILE_DIR = typeof opts['chrome-profile-dir'] === 'string' ? opts['chrome-profile-dir'].trim() : 'Profile 1';
if (opts['chrome-profile-dir'] !== undefined && !CHROME_PROFILE_DIR) die('--chrome-profile-dir needs a non-empty Chrome profile directory name');
// Playwright accepts URL-pattern-like origins separated by semicolons. Preserve explicit origins; for host globs add
// both the wildcard and bare host because `*.example.com` does not cover example.com itself. Plain hosts use both
// schemes and any port, which preserves localhost/dev-server routing without widening the host.
const playwrightAllowedOrigins = (origins) => [...new Set(origins.flatMap((entry) => {
  if (entry === '*') return ['*'];
  try { const u = new URL(entry); return [`${u.protocol}//${u.host}`]; } catch {}
  const host = entry.replace(/^\*\./, '');
  if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(host)) return [entry, host].filter(Boolean);
  const port = host.includes(':') ? '' : ':*';
  return entry.startsWith('*.')
    ? [`http://*.${host}${port}`, `https://*.${host}${port}`, `http://${host}${port}`, `https://${host}${port}`]
    : [`http://${host}${port}`, `https://${host}${port}`];
}))];
// The hub starts our small launcher, which reads the token file and passes the token to @playwright/mcp through that
// child's environment only. (An `env_vars` pass-through would need the token in the hub's own environment, which a hub
// started earlier does not have and which every worker shell would inherit — live test 2026-11-14.)
const TRAE_PLAYWRIGHT_ARGS = TRAE_EXTENSION_BROWSER ? [path.join(path.dirname(fileURLToPath(import.meta.url)), 'playwright-extension-mcp.mjs'),
  '--profile-dir-name', CHROME_PROFILE_DIR] : null;
// No --allowed-origins (live test 2026-11-14): @playwright/mcp 0.0.85 accepts only full origins or wildcard ports, not
// host globs like *.larkoffice.com, and the filter applies to every request a page makes, so a signed-in Lark page failed
// with net::ERR_BLOCKED_BY_CLIENT. Scope is stated in the worker's instructions and the brief instead.
// A transport is required even with enabled=false (TRAE CLI 0.214.1), including on fresh homes without a global server.
const TRAE_PLAYWRIGHT_SERVER = PROF?.kind === 'trae' ? { enabled: TRAE_EXTENSION_BROWSER || TRAE_HEADLESS_BROWSER,
  command: TRAE_EXTENSION_BROWSER ? process.execPath : 'npx',
  args: TRAE_EXTENSION_BROWSER ? TRAE_PLAYWRIGHT_ARGS : ['-y', '@playwright/mcp@latest', '--browser', 'chrome', '--headless', '--isolated'],
  startup_timeout_sec: 120, default_tools_approval_mode: 'approve' } : null;
const TRAE_MCP_CONFIG = TRAE_PLAYWRIGHT_SERVER ? { mcp_servers: { playwright: TRAE_PLAYWRIGHT_SERVER } } : null;
if (TRAE_BROWSER_REQUEST && !TRAE_EXTENSION_BROWSER)
  die('BLOCKED browser preflight: Playwright Extension pairing file is missing. Pair the extension in Chrome and configure PLAYWRIGHT_EXTENSION_TOKEN_FILE.', 1);
const originAllowed = (origin) => {
  let host = ''; try { host = new URL(origin).hostname; } catch { return false; }
  return BU_ORIGINS.some((p) => p === '*' || p === origin || (p.startsWith('*.') ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p));
};
// The per-app / per-site approvals only reach this client when the thread asks on request; under never, Codex declines
// them itself. Other requests still get the refusals in REPLIES, so the sandbox stays the only bound.
const APPROVAL_POLICY = CU_APPS.length || BU_ORIGINS.length ? 'on-request' : 'never';
// The ChatGPT app (node_repl, browser service, chrome plugin) must not be older than its Chrome extension, which updates
// itself: app 26.1007 with extension 1.26.1102 (MacBook, 2026-11-10) opened tabs, then failed every page call with
// "Cannot read properties of undefined (reading 'timeoutMs')". Returns a message when the app is older, else null.
const appOlderThanExtension = () => {
  try {
    const app = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/ChatGPT.app/Contents/Info.plist'], { encoding: 'utf8' }).trim();
    const root = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    const exts = [];
    for (const prof of fs.readdirSync(root)) {
      const d = path.join(root, prof, 'Extensions', 'hehggadaopoacecdllhhajmbjkdcmajg');
      try { for (const v of fs.readdirSync(d)) exts.push(v.replace(/_\d+$/, '')); } catch {}
    }
    const key = (v) => v.split('.').map(Number).filter((n) => Number.isFinite(n));
    const a = key(app).slice(0, 2), newest = exts.map((v) => key(v).slice(1, 3)).sort((x, y) => x[0] - y[0] || x[1] - y[1]).pop();
    if (!newest || a.length < 2) return null;
    return newest[0] > a[0] || (newest[0] === a[0] && newest[1] > a[1])
      ? `the ChatGPT app (${app}) is older than its Chrome extension (${exts.sort().pop()}): page calls would fail with "reading 'timeoutMs'". Ask the user to update the ChatGPT app, then restart Chrome`
      : null;
  } catch { return null; }
};
const findChromePlugin = () => {
      const bundledFirst = path.join(os.homedir(), '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled', 'plugins', 'chrome');
      if (fs.existsSync(path.join(bundledFirst, 'scripts', 'browser-client.mjs'))) return bundledFirst;
      if (PROF?.chromePlugin && fs.existsSync(path.join(PROF.chromePlugin, 'scripts', 'browser-client.mjs'))) return PROF.chromePlugin;
      const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      for (const d of [path.join(home, 'plugins', 'cache'), path.join(os.homedir(), '.codex', 'plugins', 'cache')]) {
        try { for (const m of fs.readdirSync(d)) for (const v of ['latest', ...fs.readdirSync(path.join(d, m, 'chrome')).sort().reverse()])
          if (fs.existsSync(path.join(d, m, 'chrome', v, 'scripts', 'browser-client.mjs'))) return path.join(d, m, 'chrome', v); } catch {}
      }
      const bundled = path.join(os.homedir(), '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled', 'plugins', 'chrome');
      return fs.existsSync(path.join(bundled, 'scripts', 'browser-client.mjs')) ? bundled : null;
};
// Preflight uses only the installed runtime's public protocol, never pairing/auth contents.
const extensionConnect = () => new Promise(resolve => {
  const child = spawn(process.execPath, TRAE_PLAYWRIGHT_ARGS, {stdio:['pipe','pipe','ignore'],detached:process.platform!=='win32'});
  let done=false, buffered='';
  const kill = signal => {try {if(process.platform==='win32') child.kill(signal);else process.kill(-child.pid,signal);} catch {}};
  const finish = ok => {
    if(done) return; done=true; clearTimeout(timer); child.stdin.end(); kill('SIGTERM');
    const force=setTimeout(()=>kill('SIGKILL'),300);
    child.once('close',()=>{clearTimeout(force);resolve(ok);});
    if(child.exitCode!==null) {clearTimeout(force);resolve(ok);}
  };
  const timer=setTimeout(()=>finish(false),3500);
  const send = value => {if(!done) child.stdin.write(JSON.stringify(value)+'\n');};
  child.stdin.on('error',()=>finish(false)); child.on('error',()=>finish(false));
  child.on('exit',()=>{if(!done) finish(false);});
  child.stdout.on('data',chunk=>{
    if(done) return; buffered+=chunk;
    if(buffered.length>1024*1024) return finish(false);
    let end;
    while((end=buffered.indexOf('\n'))>=0) {
      const line=buffered.slice(0,end);buffered=buffered.slice(end+1);
      let message;try {message=JSON.parse(line);} catch {continue;}
      if(message.id===1) {
        if(message.error) return finish(false);
        send({jsonrpc:'2.0',method:'notifications/initialized'});
        // Listing tabs proves the extension is connected without reading page contents or opening a tab.
        send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'browser_tabs',arguments:{action:'list'}}});
      } else if(message.id===2) finish(!message.error&&message.result?.isError!==true);
    }
  });
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'browser-preflight',version:'1'}}});
});
const browserPreflight = async () => {
  if(opts['no-browser-preflight'] || TRAE_HEADLESS_BROWSER || !BU_ORIGINS.length || !['start','turn'].includes(cmd)) return;
  // Only checks this client can make truthfully. The launcher runs in the orchestrator's process context, which on this
  // Mac cannot read Chrome's profile (macOS privacy), while the hub that spawns the browser tools can — a client-side
  // extension probe reported a working TRAE Playwright lane as unreachable (live test 2026-11-15). So: is Chrome
  // running at all, and (TRAE) is the pairing token file there (the pairing-file check above). Everything deeper is
  // reported by the worker's own first browser call.
  let chrome = false;
  try { execFileSync('pgrep', ['-x', 'Google Chrome'], { timeout: 1500, stdio: 'ignore' }); chrome = true; } catch {}
  if (!chrome) die('BLOCKED browser preflight: Google Chrome is not running on this machine. Start Chrome (signed-in profile), then retry; for a tool failure re-route with --failure-kind tool --failures 1.', 1);
};
await browserPreflight();
if (!opts['no-browser-preflight'] && PROF?.kind !== 'trae' && BU_ORIGINS.length && (cmd === 'start' || cmd === 'turn')) { const old = appOlderThanExtension(); if (old) die(`BLOCKED browser preflight: browser-version-mismatch: ${old}`, 7); }
if (CU_APPS.length && (cmd === 'start' || cmd === 'turn') && screenLocked()) die("the screen is locked: Computer Use sees no windows while the Mac is locked (the ChatGPT app's Locked use is reserved to its own turns). Unlock it, or keep it unlocked while computer-use workers run.", 5);
const hub = process.env.CODEX_HUB || 'ws://127.0.0.1:47321';
const ready = () => fetch(hub.replace(/^ws/, 'http') + '/readyz', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
const proxied = PROF?.kind === 'ttadk' && !!PROF.searchPort;
if (cmd === 'hub' && opts.foreground) {
  try {
    process.exit(await runHubForeground({ account, profile: PROF, hub, home: os.homedir(),
      script: fileURLToPath(import.meta.url), interval: Number(opts['check-ms'] ?? 10000), configError: foregroundAccountMissing }));
  } catch (error) { die(`foreground hub: ${error.message}`, 1); }
}
if (cmd === 'proxy' || cmd === 'search-proxy') {
  if (PROF?.kind !== 'ttadk') die('proxy is for a TTADK account (--account <name>, set up by ttadk-setup)');
  if (!proxied) die(`account ${account} has no proxy yet: rerun ttadk-setup`, 1);
  if (await ensureSearchProxy(PROF)) { console.log(`TTADK proxy up at ${searchUrl(PROF)}`); process.exit(0); }
  die(`TTADK proxy did not start; see ${PROF.home}/search-proxy.log`, 1);
}
// Every model call of this account goes through the proxy: bring it up before work starts; exit 6 when that fails, so
// the orchestrator re-routes without TTADK.
if (proxied && ['hub', 'start', 'turn', 'wait'].includes(cmd) && !(await ensureSearchProxy(PROF))) {
  console.log(`proxy-unavailable: TTADK's local proxy is not running (codex-worker --account ${account} proxy; log ${PROF.home}/search-proxy.log); re-route with route.mjs ... --exclude-account ${account}`);
  process.exit(6);
}
const searchNote = async () => (proxied ? `; proxy up at ${searchUrl(PROF)} (web search)` : '');
if (cmd === 'hub') {
  if (hubListReachable({ script: fileURLToPath(import.meta.url), account })) {
    console.log(`hub up at ${hub}${await searchNote()}`); process.exit(0);
  }
  const logPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hub.log');
  const out = fs.openSync(logPath, 'a');
  // From $HOME, never the caller's cwd: a hub outlives the session that started it, and once that directory is gone
  // (a removed worktree) the TTADK provider's auth command can't run and every new thread panics ("provider auth cwd
  // must resolve", 2026-11-08).
  // A TRAE account's hub is TRAE CLI's own app-server (`traex`, a Codex fork speaking the same protocol); it keeps its
  // home in ~/.trae, so CODEX_HOME is not passed on.
  const trae = PROF?.kind === 'trae';
  const env = { ...process.env }; if (trae) delete env.CODEX_HOME;
  spawn(trae ? PROF.bin : 'codex', ['app-server', '--listen', hub], { detached: true, stdio: ['ignore', out, out], cwd: os.homedir(), env }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ready()) { console.log(`hub started at ${hub} (log: ${logPath})${await searchNote()}`); process.exit(0); }
  }
  die(`hub did not become ready; see ${logPath}`, 1);
}

const ws = new WebSocket(hub);
if (cmd === 'list') setTimeout(() => die(`hub list probe timed out (${hub}); tell the global-rules owner`, 1), 5000).unref();
let done = false, nextId = 0;
const pending = new Map();
const handlers = [];
const cleanups = new Set();
let exitCode = null;
let activeTurn = null, attemptThreadId = null, workStarted = false, hopProgressRecorded = false;
let sessionPath = null, actualModel = null, actualModelSource = null, actualModelProvider = null, modelMismatch = false;
const delegatedModels = [], earlyNotifications = [];
const strictReviewModel = opts['require-model'] === true || opts['require-model'] === 'on'
  || ['review', 'review-high', 'second-opinion'].includes(ROUTE_ARGS?.[0] ?? launchDecision?.category)
  || /(?:^|[-_.])(?:review|second-opinion)(?:$|[-_.])/i.test(String(opts.name ?? ''));
const modelEvidence = () => ({ requestedModel: REQUESTED_MODEL, effectiveModel: opts.model ?? null,
  actualModel, actualModelSource, actualModelProvider, delegatedModels: [...delegatedModels], modelMismatch });
const recordModelEvidence = (threadId, turnId, state = 'running') => {
  const evidence = modelEvidence();
  tracker?.set(evidence);
  recordLaunchModel(account ?? 'main', threadId, turnId, evidence);
  try {
    fs.mkdirSync(path.dirname(rulesLog()), { recursive: true });
    fs.appendFileSync(rulesLog(), JSON.stringify({ kind: 'launch-model', t: Date.now(),
      name: opts.name, project:ROUTE_ARGS ? routeFlag(ROUTE_ARGS,'project') ?? 'general' : launchDecision?.project,
      category:ROUTE_ARGS?.[0] ?? launchDecision?.category, role:'primary',
      account: account ?? 'main', thread: threadId, turn: turnId, accepted:!!threadId&&!!turnId,state,
      actualStatus:actualModel ? 'KNOWN' : 'UNKNOWN',
      actual:actualModel ? {accountId:account ?? 'main',modelId:actualModel,effort:opts.effort ?? 'medium'} : null,
      ...evidence }) + '\n');
  } catch { console.error('launch-model: evidence not recorded'); }
};
const observeModel = (observation, threadId, turnId) => {
  if (!observation) return;
  if (observation.scope === 'delegation') {
    if (delegatedModels.some((row) => JSON.stringify(row) === JSON.stringify(observation))) return;
    delegatedModels.push(observation);
  } else {
    if (actualModel === observation.model && actualModelSource === observation.source) return;
    actualModel = observation.model; actualModelSource = observation.source;
    actualModelProvider = observation.provider ?? null;
  }
  modelMismatch ||= !!REQUESTED_MODEL && modelFamily(observation.model) !== modelFamily(REQUESTED_MODEL);
  const prefix = observation.scope === 'delegation' ? 'delegated-model' : 'actual-model';
  console.log(`${prefix}: ${observation.model} (requested ${REQUESTED_MODEL ?? 'default'}; source ${observation.source})`);
  recordModelEvidence(threadId, turnId);
};
const markWorkStarted = () => {
  workStarted = true;
  if (!hopProgressRecorded && opts['reroute-hop-at']) {
    hopProgressRecorded = true;
    try { fs.appendFileSync(rulesLog(), JSON.stringify({ kind: 'reroute-progress', t: Date.now(), name: opts.name,
      hopAt: Number(opts['reroute-hop-at']), account: account ?? 'main', model: opts.model }) + '\n'); } catch {}
  }
};
const logFile = opts.log ? path.resolve(opts.log) : null;
let setupPhase = 'websocket/open';
const setupStarted = Date.now();
const controlCommand = ['interrupt', 'steer', 'status'].includes(cmd);
// One total setup deadline, including the wait before follow() can install its idle guard.
// Expiry detaches observation; an accepted request may still be running at the hub.
const setupMs = controlCommand ? CONTROL_SEC * 1000
  : ['start', 'turn', 'wait'].includes(cmd) && STALL_MIN > 0 ? Math.min(STALL_MIN * 60000, SETUP_MAX_SEC * 1000) : 0;
const setupAlarm = setupMs ? setTimeout(() => {
  const thread = attemptThreadId ?? opts.thread ?? null;
  const line = `${controlCommand ? `${cmd}-timeout` : 'stalled'}: setup deadline after ${Math.round((Date.now() - setupStarted) / 1000)}s; waiting for ${setupPhase}; thread=${thread ?? '?'}; hub state/cancellation unconfirmed`;
  fs.writeSync(controlCommand ? 2 : 1, line + '\n');
  tracker?.result('stalled', { phase: setupPhase, thread, mayRun: !!thread, finalLine: line });
  if (logFile) try { fs.appendFileSync(logFile, JSON.stringify({ stalled: true, phase: setupPhase,
    threadId: thread, at: Date.now(), mayRun: !!thread }) + '\n'); } catch {}
  if (tracker && ['start', 'turn'].includes(cmd) && thread) {
    settleSetup(thread).finally(() => finish(controlCommand ? 7 : 4));
  } else finish(controlCommand ? 7 : 4);
}, setupMs) : null;
cleanups.add(() => clearTimeout(setupAlarm));
if (setupMs) {
  // No `thread=` token here: callers grep the first `thread=<id>` line of the output for the new thread id.
  const line = `connecting: ${cmd} (${opts.thread ? 'existing thread' : 'new thread'}); setup deadline ${setupMs / 1000}s`;
  if (controlCommand) console.error(line); else console.log(line);
}
const write = (obj) => ws.send(JSON.stringify(obj));
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId; setupPhase = method;
  if (logFile) try { fs.appendFileSync(logFile, JSON.stringify({ rpc: 'sent', id, method,
    threadId: params?.threadId ?? null, at: Date.now() }) + '\n'); } catch {}
  pending.set(id, { resolve, reject, method }); write({ jsonrpc: '2.0', id, method, params });
});
const settleSetup = async (thread) => {
  const phase = setupPhase;
  let timer;
  try {
    const listed = await Promise.race([ (async () => {
      let cursor;
      for (let page = 0; page < 100; page++) {
        const result = await call('thread/list', { limit: 100, cursor });
        if (!Array.isArray(result.data)) return null;
        const found = result.data.find(row => row.id === thread);
        if (found) return typeof found.status?.type === 'string' ? found.status.type : null;
        if (!result.nextCursor) return 'absent';
        cursor = result.nextCursor;
      }
      return null;
    })(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); }) ]);
    if (listed && ['absent', 'idle', 'notLoaded', 'completed', 'failed', 'interrupted'].includes(listed)) {
      tracker?.set({ settled: true, mayRun: false, phase, setupSettlement: listed });
    }
  } catch { /* No hub confirmation means the original run may still be active. */ }
  finally { clearTimeout(timer); setupPhase = phase; }
};
const stopFollowing = () => {
  handlers.length = 0;
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
};
const finish = (code) => {
  done = true; stopFollowing();
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  pending.clear();
  try { ws.close(); } catch {}
  process.exit(exitCode ?? code);
};
const rejectRequestBuffer = (thread) => {
  const at = thread ? markRequestBufferExceeded(account ?? 'main', thread, opts) : Date.now();
  console.error(`codex-worker: ${largeThreadMessage(thread, `provider request buffer exceeded on ${new Date(at).toISOString()}`)}`);
  finish(9);
};
const resumeFallback = (error) => {
  if (failureKind(error?.message ?? String(error)) === 'thread-too-large') throw error;
  return null;
};
const detachHub = () => {
  done = true; stopFollowing(); activeTurn = null;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  pending.clear(); try { ws.close(); } catch {}
};
const autoReroute = async (reason, queue = {}, policy = false) => {
  outcomeSkip = true; // The successor follower owns the final task outcome.
  tracker?.result('re-routed', { reason, mayRun: false, finalLine: '' });
  const cancelledTurn = activeTurn;
  detachHub(); exitCode = null;
  const from = { vendor: 'codex', model: String(opts.model ?? '').toLowerCase(), effort: opts.effort ?? null,
    account: account ?? 'main', position: queue.position ?? null, waitedMin: queue.waitedMin ?? 0,
    predictedStartMin: queue.predictedStartMin ?? null,
    threadId: cancelledTurn?.threadId ?? attemptThreadId, turnId: cancelledTurn?.turnId ?? null };
  try {
    const code = await rerouteWorker({ args: ROUTE_ARGS, depth: REROUTE_DEPTH, from, reason, prompt: text,
      opts: { ...opts, owner: tracker?.sessionId ?? opts.owner }, policy, onHandoff: () => tracker?.end(0) });
    if (code === 8 || code === 9) tracker?.result('needs-user');
    else if (code !== 0) tracker?.result('failed');
    finish(code);
  } catch (e) { console.error(`reroute-failed: ${e.message}`); finish(7); }
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  if (!activeTurn || done) {
    if (!done || process.listenerCount(signal) === 1) finish(signalExit(signal));
    return;
  }
  const timer = setTimeout(() => finish(signalExit(signal)), 3000);
  call('turn/interrupt', activeTurn).catch(() => {}).finally(() => { clearTimeout(timer); finish(signalExit(signal)); });
});
// Nobody is at the hub to answer a worker, so every server→client request gets a valid refusal. Approvals don't
// arrive under approvalPolicy never; a question tells the worker to report it instead of waiting.
const NO_USER = 'No user is available to answer in this session. Do not wait for one: finish what you can, then end '
  + 'the turn with a final message whose first line starts with QUESTION (after your task id, if you have one) and states the question.';
const REPLIES = {
  'item/commandExecution/requestApproval': () => ({ decision: 'decline' }),
  'item/fileChange/requestApproval': () => ({ decision: 'decline' }),
  'execCommandApproval': () => ({ decision: 'denied' }),
  'applyPatchApproval': () => ({ decision: 'denied' }),
  'item/permissions/requestApproval': () => ({ permissions: {} }),
  // Computer Use asks (an MCP elicitation from node_repl) before it uses each app, and Browser use before each site it
  // reaches. Accept only the apps / sites this worker was launched with (--computer-use-apps / --browser-origins), for
  // this session; decline everything else, as before. Each decision is logged to --log for audit.
  // Both browser runtimes ask: node_repl (browser-setup's config) and cua_repl (the ChatGPT app's unified-computer-use
  // plugin, enabled on the app's own home — 2026-11-10: the MacBook's main account used it, every site was declined
  // because only node_repl was recognised, and Codex reported "The user declined approval").
  'mcpServer/elicitation/request': (p) => {
    const blob = JSON.stringify(p ?? {});
    const fromRepl = ['node_repl', 'cua_repl'].includes(p?.serverName);
    const pick = (k) => (blob.match(new RegExp(`"tool_params":\\{[^}]*?"${k}":"([^"]+)"`)) || blob.match(new RegExp(`"${k}":"([^"]+)"`)) || [])[1] ?? null;
    const app = pick('app') ?? pick('bundle_id') ?? pick('bundleId');
    let origin = pick('origin');
    if (!origin) { const u = pick('url'); try { origin = u ? new URL(u).origin : null; } catch {} }
    const isCU = fromRepl && /"connector_id":"(unified-)?computer-use"|computer.?use/i.test(blob) && !!app;
    const isBU = fromRepl && /"connector_id":"browser-use"|browser.?use|origin/i.test(blob) && !!origin;
    const ok = (isCU && CU_APPS.includes(app)) || (isBU && originAllowed(origin));
    if (opts.log) try {
      fs.appendFileSync(path.resolve(opts.log), JSON.stringify({ accessApproval: { server: p?.serverName ?? null, kind: isBU ? 'origin' : isCU ? 'app' : 'unknown', target: (isBU ? origin : app) ?? null,
        decision: ok ? 'accept' : 'decline', at: Date.now(), ...(isCU || isBU ? {} : { raw: blob.slice(0, 2000) }) } }) + '\n');
    } catch {}
    return ok ? { action: 'accept', content: {}, _meta: { persist: 'session' } } : { action: 'decline' };
  },
  'item/tool/call': () => ({ contentItems: [{ type: 'inputText', text: 'Not available in this session.' }], success: false }),
  'item/tool/requestUserInput': (p) => ({ answers: Object.fromEntries((p.questions ?? []).map((q) => [q.id, { answers: [NO_USER] }])) }),
};
const connectionLost = (message) => {
  if (exitCode != null) {
    console.error('queue-cancel-unconfirmed: hub connection lost before interrupt acknowledgement; check the original turn before dispatching its replacement');
    finish(exitCode);
  } else if (!done) die(message);
};
ws.onclose = () => connectionLost(`hub connection closed (${hub}); is it running? (codex-worker hub)`);
ws.onerror = () => connectionLost(`cannot reach the hub at ${hub}; probe with codex-worker list --limit 1, start with codex-worker hub only if unreachable, and tell the global-rules owner`);
ws.onmessage = (ev) => {
  const line = String(ev.data);
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id) && !m.method) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (logFile) try { fs.appendFileSync(logFile, JSON.stringify({ rpc: 'reply', id: m.id,
      method: p.method, ok: !m.error, at: Date.now() }) + '\n'); } catch {}
    m.error ? p.reject(new Error(`${m.error.code}: ${m.error.message}`)) : p.resolve(m.result); return;
  }
  if (done) return; // During cancellation only the interrupt RPC reply is still relevant.
  if (logFile) fs.appendFileSync(logFile, line + '\n');
  if (m.id !== undefined && m.method) {
    if (activeTurn && m.method.startsWith('item/') && (m.params?.threadId === activeTurn.threadId || m.params?.turnId === activeTurn.turnId)) markWorkStarted();
    const reply = REPLIES[m.method];
    write(reply ? { jsonrpc: '2.0', id: m.id, result: reply(m.params || {}) }
      : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} is not supported by codex-worker` } });
    return;
  }
  if (!activeTurn && attemptThreadId && m.params?.threadId === attemptThreadId && m.method?.startsWith('item/')
    && m.params.item?.type !== 'userMessage') markWorkStarted();
  if (!activeTurn && ['start', 'turn', 'wait'].includes(cmd)
    && m.params?.threadId === (attemptThreadId ?? opts.thread) && earlyNotifications.length < 1000) earlyNotifications.push(m);
  for (const h of handlers) h(m);
};
await new Promise((resolve) => { ws.onopen = resolve; });

const init = async () => { await call('initialize', { clientInfo: { name: 'codex-worker', version: '1.1.0' } }); write({ jsonrpc: '2.0', method: 'initialized', params: {} }); };
const textInput = (t) => [{ type: 'text', text: t }];
const readTurns = async (threadId) => (await call('thread/read', { threadId, includeTurns: true })).thread?.turns ?? [];
const currentTurn = async (threadId) => {
  const turns = await readTurns(threadId);
  return turns.filter((t) => t.status === 'inProgress').at(-1) ?? turns.at(-1);
};
const lastMessage = (items) => (items ?? []).filter((i) => i.type === 'agentMessage' && i.text).at(-1)?.text;
const printFinal = (final) => {
  if (!final) return;
  if (opts.out) {
    if (outBaseline !== undefined && outputStat() !== outBaseline)
      console.error('output-conflict: --out changed during the turn; it may be a worker-written file. Use a separate final-message destination.');
    fs.writeFileSync(path.resolve(opts.out), final + '\n');
  }
  console.log(`final: ${final.split('\n').find((l) => l.trim()) ?? ''}`);
};
// A cyberPolicy block is recorded for the nightly review as kind:'policy-block' on every account. TTADK stops there
// (telemetry only, no pause); TRAE also writes its 983-style family restriction below (until the next 00:00 UTC).
const recordPolicyBlock = (model, error) => {
  try { appendPolicyBlock(rulesLog(), policyBlockRecord({ account, vendor: PROF?.kind === 'trae' ? 'trae' : 'codex', model, error })); } catch {}
};
// Prints the outcome and exits: status, usage, the final message's first line (whole message to --out).
const report = async (threadId, turn, final, usage) => {
  if (!actualModel || PROF?.kind === 'ttadk') observeModel(rolloutTurnModel(PROF?.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
    sessionPath, threadId, turn.id), threadId, turn.id);
  // A family mismatch (or a cross-family sub-agent) fails a review; missing evidence only warns, so a hub that exposes no
  // model for its turns cannot turn every finished review into a failure. An explicit --require-model stays strict.
  const explicitStrict = opts['require-model'] === true || opts['require-model'] === 'on';
  const rejectedModel = strictReviewModel && (modelMismatch || (explicitStrict && (!actualModel || !REQUESTED_MODEL)));
  if (strictReviewModel && !rejectedModel && !actualModel) console.log(`actual-model: unknown (requested ${REQUESTED_MODEL ?? 'default'}; no execution evidence from this hub)`);
  recordModelEvidence(threadId, turn.id, turn.status==='completed'?'completed':'failed');
  if (rejectedModel) console.error(`review-model-rejected: requested ${REQUESTED_MODEL ?? 'default'}, actual ${actualModel ?? 'unknown'}, delegated ${delegatedModels.map((row) => row.model).join(', ') || 'none'}`);
  console.log(`turn ${turn.status}${turn.error ? ' error=' + JSON.stringify(turn.error) : ''}`);
  const errorText = JSON.stringify(turn.error ?? '');
  if (turn.status === 'failed' && failureKind(errorText) === 'thread-too-large') {
    // Do not wait for another hub read while retry/reroute timers are still armed.
    outcomeTurn = turn; outcomeFinal = final ?? lastMessage(turn.items) ?? '';
    printFinal(outcomeFinal);
    rejectRequestBuffer(threadId);
  }
  const policyBlock = isPolicyBlock(turn);
  if (policyBlock) {
    // Without --account there is no profile home: the block is still printed and logged with model=null.
    const model = opts.model ?? (PROF?.home ? threadModel(PROF.home, threadId) : null);
    recordPolicyBlock(model, turn.error);
    const action = policyBlockAction(PROF?.kind);
    console.log(`security-policy-block: ${account ?? 'this account'}${model ? ` / ${model}` : ''} — OpenAI cyberPolicy flagged this turn for possible cybersecurity risk. Do not retry this thread or resend the same content to another GPT account; re-route with route.mjs ... --adversarial (company non-GPT models only, never a GPT reviewer). ${action.restrictFamily ? 'Recorded as a TRAE family restriction (like a 983 restriction) for the nightly review.' : 'Recorded for the nightly review; no model or account pause.'}`);
  }
  // A rate-limited / concurrency failure (e.g. the TTADK gateway's QPM limit): retry once on the same account, then
  // re-route without it (user, 2026-11-07).
  // The TTADK token quota (daily / hourly, shared by all models) is used up: retrying or switching models can't help.
  const quota = /(Daily|Hourly) Limits exceeded\. Resets at (\d{4}-\d\d-\d\dT[\d:.]+Z?)/i.exec(JSON.stringify(turn.error ?? ''));
  if (turn.status === 'failed' && quota) {
    console.log(`quota-exhausted: ${account ?? 'this account'}'s ${quota[1].toLowerCase()} token quota is used up until ${quota[2]} (all models). Don't retry: re-route with route.mjs ... --exclude-account ${account ?? '<account>'} (TRAE takes it next; if it needs personal quota, route.mjs asks the user first)`);
  } else if (turn.status === 'failed' && /rate.?limit|qpm|too many requests|429|concurren/i.test(JSON.stringify(turn.error ?? ''))) {
    console.log(`rate-limited: retry this task once on ${account ?? 'this account'} (codex-worker turn); if it fails again, re-route with route.mjs ... --exclude-account ${account ?? '<account>'}`);
  }
  // The Chrome extension's native host ("ChatGPT for Chrome") comes and goes; while it is down the browser runtime
  // says "Browser is not available: chrome" (seen 2026-11-07; back within a minute on its own).
  if (/Browser is not available: chrome/.test(JSON.stringify(turn.error ?? '') + (final ?? lastMessage(turn.items) ?? ''))) {
    console.log('browser-unavailable: the Chrome extension host is not connected (pgrep -f "ChatGPT for Chrome"). Make sure Chrome is running, wait a minute and retry once; if it fails again, re-route after excluding this failed account/lane (route.mjs browser --exclude-account ' + (account ?? '<account>') + ')');
  }
  // TRAE: every failed turn is recorded and every completed one clears the record; repeated or hard failures pause it.
  // A cyberPolicy block is content policy, not an infrastructure failure. The kind:'policy-block' row above is logged
  // on both accounts; on TRAE it also leaves the same family restriction as a 983 signal (until the next 00:00 UTC,
  // then probed), while TTADK stays telemetry-only and never pauses.
  if (PROF?.kind === 'trae') {
    const model = opts.model ?? threadModel(PROF.home, threadId);
    if (turn.status === 'completed') noteSuccess(PROF.home, model);
    else if (turn.status === 'failed' && policyBlock) {
      const p = notePolicyRestriction(PROF.home,
        `cyberPolicy blocked this turn: ${JSON.stringify(turn.error ?? '').slice(0, 140)}`, Date.now(), model);
      if (p) console.log(`trae-restricted: TRAE's ${p.pool} models are restricted until ${new Date(p.pausedUntil).toLocaleTimeString()} (${p.reason}); re-route this task with route.mjs ... --adversarial (it moves to the next non-GPT family)`);
      else console.log('security-policy-block: no model is known for this thread, so no TRAE family restriction was written (the kind:policy-block row is still logged)');
    } else if (turn.status === 'failed') {
      const p = noteFailure(PROF.home, JSON.stringify(turn.error ?? 'failed'), Date.now(), model);
      if (p?.modelPause) console.log(unavailableHint(p));
      else if (p) console.log(`trae-paused: ${pausedWhat(p)} until ${new Date(p.pausedUntil).toLocaleTimeString()} (${p.reason}); re-route this task with route.mjs ... ${p.pool ? `(it moves to the next model family; --exclude-model ${p.pool} for this task)` : `--exclude-account ${account}`}`);
      else if (model) console.log(`trae-failed: a ${model} turn failed on TRAE (not paused yet); for an infrastructure error re-route this task with route.mjs ... --exclude-model ${model.toLowerCase()} (not a --failures step)`);
    }
  }
  if(PROF?.kind==='ttadk'&&turn.status==='failed'&&!policyBlock&&failureKind(JSON.stringify(turn.error??''))==='unavailable'){const p=noteFailure(PROF.home,JSON.stringify(turn.error),Date.now(),opts.model??actualModel);if(p?.modelPause)console.log(unavailableHint(p));}
  if (usage) console.log(`usage (thread total) input=${usage.inputTokens} cached=${usage.cachedInputTokens} output=${usage.outputTokens}`);
  final ??= lastMessage(turn.items);
  if (!final) final = lastMessage((await readTurns(threadId).catch(() => [])).find((t) => t.id === turn.id)?.items);
  outcomeTurn = turn; outcomeFinal = final ?? '';
  printFinal(final);
  tracker?.result(rejectedModel ? 'failed' : /^(?:\S+\s+)?(?:BLOCKED|QUESTION)\b/.test(final?.trim() ?? '') ? 'needs-user'
    : turn.status === 'completed' ? 'finished' : 'failed', { thread: threadId, turn: turn.id, mayRun: false,
      reason: rejectedModel ? 'review model rejected' : turn.status === 'completed' ? null : JSON.stringify(turn.error ?? turn.status),
      finalLine: final?.split('\n').find((line) => line.trim()) ?? '' });
  const infrastructureMiss = (['trae','ttadk'].includes(PROF?.kind)&&failureKind(errorText)==='unavailable')||(PROF?.kind==='trae'&&/access (temporarily )?restricted|\b983\b/i.test(errorText));
  if (!(strictReviewModel && modelMismatch) && turn.status === 'failed' && ROUTE_ARGS && !BACKGROUND && !workStarted && !turnHasWork(turn) && !final
    && (infrastructureMiss || (policyBlock && (routeFlag(ROUTE_ARGS, 'security') || routeFlag(ROUTE_ARGS, 'adversarial'))))) {
    const observed = (await readTurns(threadId).catch(() => [])).find((t) => t.id === turn.id);
    if (observed?.status === 'failed' && Array.isArray(observed.items) && !turnHasWork(observed) && !workStarted) {
      await autoReroute(policyBlock ? 'policy-block' : failureKind(errorText) === 'unavailable' ? 'model-unavailable' : 'vendor-restriction', {}, policyBlock);
      return;
    }
    console.log('reroute-skipped: failed turn has work or its no-progress terminal state is unconfirmed');
  }
  finish(rejectedModel ? 5 : turn.status === 'completed' ? 0 : 1);
};
// Stall alarm: no event for this turn in --stall-min minutes (default 30, 0 = off) ends the follower with exit 4 so the
// orchestrator wakes up. The turn keeps running on the hub. A worker waiting on its own sub-agents can be quiet that long,
// so check before acting: `status`, child threads (parent_thread_id) under <home>/sessions/, then `wait` again, steer
// or interrupt.
// TRAE's queue signal (2026-11-13): while a turn waits in TRAE's model queue the hub sends `queue/status` notifications
// ({threadId, turnId, state, position, message}); they carry this thread's id, so they already count as progress below —
// a worker printing `queued:` lines is waiting, not stalled. Print on a state change or a ≥10% position move (at most
// one line a minute), and the wait's length once it clears. `status --thread` reads the last state from the file.
const LONG_COMMAND_MAX_MIN = Number(process.env.CODEX_WORKER_LONG_COMMAND_MAX_MIN ?? 240);
const runningCommands = new Set(); let quietNoted = false;
const follow = (threadId, turnId, items = []) => {
  clearTimeout(setupAlarm);
  handlers.push((m) => {
    const p = m.params ?? {}, item = p.item;
    if (p.threadId !== threadId || item?.type !== 'commandExecution' || !item.id) return;
    if (m.method === 'item/started') runningCommands.add(item.id);
    else if (m.method === 'item/completed') { runningCommands.delete(item.id); quietNoted = false; }
  });
  activeTurn = { threadId, turnId };
  tracker?.update({ thread: threadId, turn: turnId, model: opts.model ?? null, mayRun: true });
  const context = talkbackContext(threadId);
  const relay = createTalkbackRelay({ ...context.metadata, turn: turnId }, (line) => console.error(line));
  handlers.push(relay);
  for (const item of items) relay({ method: 'item/completed', params: { threadId, turnId, item } });
  recordModelEvidence(threadId, turnId);
  console.log(`thread=${threadId} turn=${turnId}`);
  const recordQueue = ['trae','ttadk'].includes(PROF?.kind) ? createQueueRecorder(PROF.home, opts.model ?? threadModel(PROF.home, threadId)) : null;
  if (recordQueue) cleanups.add(() => recordQueue.stop());
  let final, usage, last = Date.now();
  let runningSince = Date.now(), completedItems = 0;
  let queueSince = PATIENCE_MIN!=null&&!BACKGROUND?Date.now():null, queuePosition = null, lastPrintedQueue = null, queuePrinted = null;
  let patienceSamples = [];
  let handingOff = false, reporting = false;
  // Use measured drain for an early decision, but never require drain to enforce the elapsed deadline.
  const checkPatience = (t, pos, sample = true) => {
    if (done || handingOff || reporting || workStarted || BACKGROUND || PATIENCE_MIN == null || queueSince == null) return false;
    // Frequent notifications must not evict the two-minute baseline from the bounded sample window.
    if (sample && pos != null && pos > 0 && (!patienceSamples.length || t - patienceSamples.at(-1).t >= 10000)) patienceSamples.push({ t, pos });
    patienceSamples = patienceSamples.filter((s) => t - s.t <= 10 * 60000).slice(-30);
    const first = patienceSamples[0], last = patienceSamples.at(-1);
    const spanMin = first && last ? (last.t - first.t) / 60000 : 0;
    const drain = spanMin >= 2 && last.pos < first.pos ? (first.pos - last.pos) / spanMin : null;
    const predicted = drain > 0 && pos != null && pos > 0 ? pos / drain : null;
    const waitedMin = Math.max(0, (t - queueSince) / 60000);
    const deadlineMin = Math.min(PATIENCE_MIN, QUEUE_ALT_START_MIN ?? Infinity);
    const elapsed = waitedMin >= deadlineMin;
    if (!elapsed && (predicted == null || predicted + waitedMin <= deadlineMin)) return false;
    // Latch before printing or sending the RPC: further queue/completion notifications must not race this handoff.
    handingOff = true; exitCode = 7;
    const alt = QUEUE_ALT ?? `route.mjs with --exclude-lane ${account ?? 'main'}:${opts.model ?? 'this model'} and the same --failures`;
    const limit = deadlineMin < PATIENCE_MIN ? `alternative start ${deadlineMin} (patience ${PATIENCE_MIN})` : `patience ${PATIENCE_MIN}`;
    const line = `queue-too-slow: position ${pos ?? '?'}, drain ${drain == null ? 'unknown' : drain.toFixed(1)}/min, ${elapsed ? `elapsed wait ${waitedMin.toFixed(1)} min >=` : `predicted start in ${Math.round(predicted)} min >`} ${limit} — re-route: ${alt}`;
    try { fs.writeSync(1, `${line}\n`); } catch { console.log(line); }
    if (opts.log) try { fs.appendFileSync(path.resolve(opts.log), JSON.stringify({ queueTooSlow: { position: pos, drainPerMin: drain,
      predictedStartMin: predicted == null ? null : Math.round(predicted), waitedMin, patienceMin: PATIENCE_MIN, alt, at: t } }) + '\n'); } catch {}
    // Stop the queued turn cleanly before exiting so the provider does not keep it pending after the re-route.
    // Keep the deadline referenced: a hub that never acknowledges cancellation must not leave the wrapper hanging.
    const cancel = async () => {
      const deadline = setTimeout(() => {
        console.error('queue-cancel-unconfirmed: cancellation timed out; check the original turn before dispatching its replacement');
        finish(7);
      }, 3000);
      cleanups.add(() => clearTimeout(deadline));
      try {
        if (ROUTE_ARGS) {
          const before = (await readTurns(threadId)).find((turn) => turn.id === turnId);
          if (!before || !Array.isArray(before.items) || before.status !== 'inProgress' || turnHasWork(before) || workStarted) {
            handingOff = false; exitCode = null; workStarted = true; clearTimeout(deadline);
            if (before && ['completed', 'failed', 'interrupted'].includes(before.status)) {
              await report(threadId, before, final, usage); return;
            }
            console.log('reroute-skipped: turn has started or produced work; continue following it'); return;
          }
        }
        await call('turn/interrupt', { threadId, turnId });
        if (!ROUTE_ARGS) { finish(7); return; }
        const after = (await readTurns(threadId)).find((turn) => turn.id === turnId);
        if (!after || !Array.isArray(after.items) || after.status !== 'interrupted' || turnHasWork(after) || workStarted) {
          console.error('queue-cancel-unconfirmed: turn not confirmed interrupted without progress; no replacement launched'); finish(7); return;
        }
        if (PROF?.home) saveQueue(PROF.home, threadId, { state: 'cancelled', position: null, turnId, at: Date.now() });
        clearTimeout(deadline);
        await autoReroute('queue-too-slow', { position: pos, waitedMin, predictedStartMin: predicted });
      } catch {
        console.error('queue-cancel-unconfirmed: interrupt/read failed; check the original turn before dispatching its replacement'); finish(7);
      }
    };
    void cancel();
    return true;
  };
  const queueUpdate = (p) => {
    const t = Date.now(), state = String(p.state ?? 'queued');
    const pos = p.position != null && p.position !== '' && Number.isFinite(Number(p.position)) ? Number(p.position) : null;
    queuePosition = pos;
    if (state !== 'ready') queueSince = Math.min(queueSince ?? t,t);
    const queue = { state, position: pos, since: queueSince, turnId, at: t };
    if (PROF?.home) saveQueue(PROF.home, threadId, queue);
    recordQueue?.(p, t);
    if (state === 'ready') { markWorkStarted(); patienceSamples = []; runningSince = t; completedItems = 0; }
    else { runningSince = null; completedItems = 0; if (checkPatience(t, pos)) return; }
    if (state === 'ready') {
      if (queueSince) console.log(`queue cleared after ${Math.max(1, Math.round((t - queueSince) / 60000))}m`);
      queueSince = null;
      lastPrintedQueue = null;
      return;
    }
    const prev = lastPrintedQueue;
    const moved = !prev || prev.state !== state
      || (pos != null && prev.position != null && Math.abs(pos - prev.position) >= Math.max(1, Math.ceil(prev.position * 0.1)));
    if (!moved || (queuePrinted != null && t - queuePrinted < 60000)) return;
    lastPrintedQueue = queue;
    queuePrinted = t;
    console.log(`queued: position ${pos ?? '?'} (${state})`);
  };
  if (PATIENCE_MIN != null && !BACKGROUND) {
    const patienceAlarm = setInterval(() => checkPatience(Date.now(), queuePosition, false),
      Math.min(60000, Math.max(1000, PATIENCE_MIN * 6000)));
    patienceAlarm.unref(); cleanups.add(() => clearInterval(patienceAlarm));
  }
  if (STALL_MIN > 0) {
    const alarm = setInterval(() => {
    if (done || handingOff) return;
    // Queue patience owns known waiting turns, even when the stall and patience ticks coincide.
    if (queueSince != null && !workStarted && !BACKGROUND && PATIENCE_MIN != null) {
      checkPatience(Date.now(), queuePosition, false); return;
    }
    const idle = (Date.now() - last) / 60000;
    if (idle < STALL_MIN) return;
    // A worker inside one long command (a build, a test run) emits no model events until it returns. That is work, not a
    // stall: keep following (2026-11-15: a 30+ min test run was reported stalled and the final message was never written).
    if (runningCommands.size && idle < LONG_COMMAND_MAX_MIN) {
      if (!quietNoted) { quietNoted = true; console.log(`quiet: no events for ${Math.round(idle)}m while a command is still running on turn ${turnId}; still following (up to ${LONG_COMMAND_MAX_MIN}m)`); }
      return;
    }
    const line = `stalled: no events for ${idle < 1 ? `${Math.round(idle * 60)}s` : `${Math.round(idle)}m`} on turn ${turnId} (thread ${threadId}); the turn is still running on the hub — check the actual turn and progress, then wait again, steer or interrupt; never delegate or request a model switch`;
    console.log(line);
    tracker?.result('stalled', { thread: threadId, turn: turnId, phase: 'follow', mayRun: true, finalLine: line });
    if (opts.log) try { fs.appendFileSync(path.resolve(opts.log), JSON.stringify({ stalled: true, idleMin: Math.round(idle), at: Date.now() }) + '\n'); } catch {}
    recordQueue?.({state:'waiting',position:queuePosition,progress:false},Date.now());
    if (PROF?.kind === 'trae') noteFailure(PROF.home, `stalled ${Math.round(idle)} min (queued for capacity?)`, Date.now(), opts.model ?? threadModel(PROF.home, threadId));
    finish(4);
    }, Math.min(60000, Math.max(20, STALL_MIN * 30000)));
    cleanups.add(() => clearInterval(alarm));
  }
  handlers.push((m) => {
    if (done) return;
    const p = m.params || {};
    if (p.threadId !== undefined && p.threadId !== threadId) return;
    if (p.turnId !== undefined && p.turnId !== turnId) return;
    observeModel(modelObservation(m, threadId, turnId), threadId, turnId);
    if ((p.threadId === threadId || p.turnId === turnId) &&
      ((m.method.startsWith('item/') && p.item?.type !== 'userMessage')
        || (m.method === 'thread/tokenUsage/updated' && p.tokenUsage?.total?.outputTokens > 0))) markWorkStarted();
    // Only this turn's or thread's own events count as progress; account-wide updates (rate limits…) don't.
    if (p.turnId === turnId || p.threadId === threadId || p.turn?.id === turnId) last = Date.now();
    if (m.method === 'item/completed' && runningSince != null) {
      completedItems++;
      recordQueue?.({ state: 'ready', position: null, progress: true,
        itemsPerMin: completedItems / Math.max((Date.now() - runningSince) / 60000, 1 / 60) });
    }
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.text) final = p.item.text;
    else if (m.method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.total;
    else if (m.method === 'queue/status' && (p.threadId === threadId || p.turnId === turnId)) queueUpdate(p);
    else if (!handingOff && !reporting && m.method === 'turn/completed' && (p.turn?.id ?? p.turnId) === turnId) {
      reporting = true;
      report(threadId, p.turn ?? { id: turnId, status: 'completed' }, final, usage)
      // report() is async and this handler cannot await it: an unexpected throw must still end the follower normally
      // (status 1) instead of leaving it to the 30-minute stall alarm with the policy guidance unprinted.
      .catch((e) => { console.error(`codex-worker: report failed: ${e?.stack ?? e}`); finish(1); });
    }
  });
  for (const message of earlyNotifications.splice(0)) for (const handler of handlers) handler(message);
};

try {
  await init();
  if (cmd === 'start') {
    if (!opts.cwd || !text) die('start needs --cwd and a prompt');
    // Browser / desktop threads (2026-11-10, the MacBook's main account): the ChatGPT app's unified-computer-use plugin
    // (cua_repl) needs the app's own runtime — under the CLI hub it accepted the site approval, then failed every call
    // with "Cannot read properties of undefined (reading 'timeoutMs')"; and an account set to auto-review declined the
    // approvals itself. So these threads turn that plugin off (node_repl + the chrome plugin remain, the path verified on
    // TTADK and b) and route approvals to this client, which answers them from --browser-origins / --computer-use-apps.
    // Per thread only: the app keeps using its plugin. (A dotted "plugins.…" key doesn't take effect; the nested form does.)
    const browserThread = CU_APPS.length > 0 || BU_ORIGINS.length > 0 || TRAE_HEADLESS_BROWSER;
    // How to reach Chrome and the desktop, told to the worker directly (2026-11-10: a MacBook worker followed a Claude
    // skill, looked for mcp__claude-in-chrome__* tools that a Codex session doesn't have, and stopped).
    // The chrome plugin must match the installed ChatGPT app, whose node_repl and browser service it talks to: the copy the
    // app unpacks itself (bundled-marketplaces) comes first; a cached "latest" can be newer than an old app (2026-11-10:
    // app 26.1007 on the MacBook — tabs opened, then every page call failed with "reading 'timeoutMs'").
    const chromePlugin = browserThread && !TRAE_EXTENSION_BROWSER && !TRAE_HEADLESS_BROWSER ? findChromePlugin() : null;
    const browserHowTo = !browserThread ? null : TRAE_HEADLESS_BROWSER ? [
      'Use Playwright MCP browser_* tools with headless isolated Chrome for public/local UI checks. This browser has no user sign-ins.',
      `Visit only the public/local sites in the task brief${BU_ORIGINS.length ? ` within these allowed sites: ${BU_ORIGINS.join(', ')}` : ''}. Report BLOCKED if the task requires a signed-in console.`,
    ].join('\n') : TRAE_EXTENSION_BROWSER ? [
      'Browser access in this TRAE thread goes through the Playwright MCP server connected to the user\'s Chrome by the Playwright Extension.',
      'Use the Playwright MCP tools: browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill_form, browser_take_screenshot, and the other browser_* tools exposed by that server.',
      `Navigate only to sites the task brief needs, and only within these allowed sites (host patterns): ${BU_ORIGINS.join(', ')}. Nothing enforces this list technically: if the task seems to need another site, or a page redirects you outside it, stop and report BLOCKED with the URL instead of continuing. Never open the user's other tabs, mail, chats or personal pages.`,
      'Do not look for any other browser runtime, Chrome plugin, or Claude Code browser skill: they do not exist in this TRAE thread. If the extension or browser is unreachable, report BLOCKED with the exact Playwright error. "Extension connection timeout" means the extension/pairing or the TRAE hub\'s Chrome-profile access needs repair; the verified token flow does not show a manual approval dialog.',
    ].join('\n') : [
      'Browser and desktop access in this thread goes through the node_repl MCP server and its `js` tool (look for a tool from the node_repl server; in code mode call it from your exec script).',
      BU_ORIGINS.length ? `For Chrome, start with exactly this in node_repl js: const { setupBrowserRuntime } = await import(${JSON.stringify(path.join(chromePlugin ?? '<chrome plugin root>', 'scripts', 'browser-client.mjs'))}); const agent = await setupBrowserRuntime(); const chrome = await agent.browsers.get("chrome"); nodeRepl.write(await chrome.documentation()); — then follow that documentation. Work only in tabs you create, close them when done, never touch the user's other tabs. Sites you may open: ${BU_ORIGINS.join(', ')}; others are declined.` : null,
      CU_APPS.length ? `For desktop apps, in node_repl js: globalThis.sky = (await import("@oai/sky")).sky; then follow its documentation. Apps you may use: ${CU_APPS.join(', ')}; others are declined.` : null,
      'Do not look for mcp__claude-in-chrome__* tools, ToolSearch, or skills written for Claude Code (chrome-browser, claude-in-chrome): they do not exist in this session. If node_repl or the browser is not reachable, report BLOCKED with the exact error.',
    ].filter(Boolean).join('\n');
    const browserConfig = browserThread && !TRAE_EXTENSION_BROWSER && !TRAE_HEADLESS_BROWSER
      ? { ...TRAE_MCP_CONFIG, plugins: { 'unified-computer-use@openai-bundled': { enabled: false } } } : TRAE_MCP_CONFIG;
    const digest = loadDigest();
    const th = await call('thread/start', {
      cwd: path.resolve(opts.cwd), model: opts.model, sandbox: opts.sandbox, approvalPolicy: APPROVAL_POLICY,
      developerInstructions: [browserHowTo, projectWorkerInstructions(digest), reviewHowTo].filter(Boolean).join('\n'),
      ...(browserThread && !TRAE_EXTENSION_BROWSER && !TRAE_HEADLESS_BROWSER ? { approvalsReviewer: 'user' } : {}),
      ...(browserConfig ? { config: browserConfig } : {}),
    });
    const threadId = th.thread?.id ?? th.threadId;
    attemptThreadId = threadId;
    sessionPath = th.thread?.path ?? null;
    tracker?.set({ thread: threadId, mayRun: true, rolloutFile: sessionPath });
    saveLaunch(account ?? 'main', threadId, { ...opts, 'auto-reroute-depth': REROUTE_DEPTH }, resolveOwner(opts.owner), { ...modelEvidence(), rolloutFile: sessionPath });
    if (PROF?.kind === 'trae') rememberThreadModel(PROF.home, threadId, opts.model);
    if (opts.name) await call('thread/name/set', { threadId, name: opts.name }).catch(() => {});
    const talkback = talkbackContext(threadId);
    const instructions = [browserHowTo, projectWorkerInstructions(digest), talkback.instructions, reviewHowTo].filter(Boolean).join('\n');
    const configured = await call('thread/resume', { threadId, config: { ...browserConfig, ...talkback.config }, developerInstructions: instructions }).catch(resumeFallback);
    markOutputStart();
    const ts = await call('turn/start', {
      threadId, input: textInput(configured ? text : `${talkback.instructions}\n\n${text}`), effort: opts.effort, model: opts.model,
      sandboxPolicy: opts.network !== undefined ? sandboxPolicy(opts.sandbox) : undefined,
    });
    follow(threadId, ts.turn?.id ?? ts.turnId);
  } else if (cmd === 'turn') {
    if (!opts.thread || !text) die('turn needs --thread and a prompt');
    const talkback = talkbackContext(opts.thread);
    const config = { ...talkback.config, ...TRAE_MCP_CONFIG };
    const resumedDigest=loadDigest();
    const resumed = await call('thread/resume', { threadId: opts.thread, model: opts.model, config,
      developerInstructions:[projectWorkerInstructions(resumedDigest), talkback.instructions, reviewHowTo].filter(Boolean).join('\n') }).catch(resumeFallback);
    sessionPath = resumed?.thread?.path ?? null;
    auditStart(opts.model??resumed?.thread?.model,opts.sandbox??resumed?.thread?.sandbox??undefined,{thread:opts.thread,name:resumed?.thread?.name??undefined});
    tracker?.set({ mayRun: true, rolloutFile: sessionPath });
    saveLaunch(account ?? 'main', opts.thread, { ...opts, 'auto-reroute-depth': REROUTE_DEPTH }, resolveOwner(opts.owner), { ...modelEvidence(), rolloutFile: sessionPath });
    markOutputStart();
    const ts = await call('turn/start', {
      threadId: opts.thread, input: textInput(resumed ? text : `${talkback.instructions}\n\n${text}`), effort: opts.effort, model: opts.model,
      sandboxPolicy: opts.sandbox && sandboxPolicy(opts.sandbox), approvalPolicy: CU_APPS.length || BU_ORIGINS.length ? APPROVAL_POLICY : undefined,
    });
    if (PROF?.kind === 'trae' && opts.model) rememberThreadModel(PROF.home, opts.thread, opts.model);
    follow(opts.thread, ts.turn?.id ?? ts.turnId);
  } else if (cmd === 'wait') {
    if (!opts.thread) die('wait needs --thread');
    const resumed = await call('thread/resume', { threadId: opts.thread }).catch(() => null);
    sessionPath = resumed?.thread?.path ?? null;
    const t = await currentTurn(opts.thread);
    if (!t) die('thread has no turns', 3);
    if (t.status === 'inProgress') { markOutputStart(); follow(opts.thread, t.id, t.items); }
    else { console.log(`thread=${opts.thread} turn=${t.id}`); await report(opts.thread, t); }
  } else if (cmd === 'steer' || cmd === 'reply') {
    if (!opts.thread || !text) die('steer needs --thread and a message');
    await call('thread/resume', { threadId: opts.thread }).catch(() => {});
    const t = await currentTurn(opts.thread);
    if (!t || t.status !== 'inProgress') die(`no turn in progress (last: ${t?.status ?? 'none'}); use \`turn\` to start a new one`, 3);
    const r = await call('turn/steer', { threadId: opts.thread, expectedTurnId: t.id, input: textInput(text) });
    console.log(`steered turn ${r.turnId ?? t.id}`); finish(0);
  } else if (cmd === 'interrupt') {
    if (!opts.thread) die('interrupt needs --thread');
    await call('thread/resume', { threadId: opts.thread }).catch(() => {});
    const t = await currentTurn(opts.thread);
    if (!t || t.status !== 'inProgress') die(`no turn in progress (last: ${t?.status ?? 'none'})`, 3);
    await call('turn/interrupt', { threadId: opts.thread, turnId: t.id });
    console.log(`interrupted turn ${t.id}`); finish(0);
  } else if (cmd === 'status') {
    if (!opts.thread) die('status needs --thread');
    const r = await call('thread/read', { threadId: opts.thread, includeTurns: true });
    const turns = r.thread?.turns ?? [];
    const lastTurn = turns.at(-1);
    const q = PROF?.home ? readQueue(PROF.home, opts.thread) : null;
    // Only a turn still running, with a queue signal recorded for it, has queue info; otherwise say so plainly.
    const queue = lastTurn?.status === 'inProgress' && q && q.turnId === lastTurn.id && q.state !== 'ready'
      ? { state: q.state, position: q.position, since: q.since } : 'no queue info';
    console.log(JSON.stringify({ thread: opts.thread, name: r.thread?.name, turns: turns.length, last: lastTurn && { id: lastTurn.id, status: lastTurn.status, error: lastTurn.error }, queue }));
    finish(0);
  } else if (cmd === 'list') {
    const r = await call('thread/list', {
      sourceKinds: ['appServer', 'exec', 'cli'], limit: Number(opts.limit ?? 20),
      cwd: typeof opts.cwd === 'string' ? path.resolve(opts.cwd) : undefined, searchTerm: typeof opts.search === 'string' ? opts.search : undefined,
    });
    for (const t of r.data ?? []) {
      const when = new Date((t.updatedAt ?? t.createdAt) * 1000).toLocaleString('sv-SE').slice(0, 16);
      console.log([t.id, when, t.status?.type ?? '-', t.source ?? '-', t.name ?? '-', t.cwd].join('\t'));
    }
    finish(0);
  } else if (cmd === 'quota') {
    const r = await call('account/rateLimits/read', {});
    console.log(JSON.stringify(r.rateLimitsByLimitId ?? { [r.rateLimits?.limitId ?? 'codex']: r.rateLimits }));
    finish(0);
  } else if (cmd === 'usage') {
    if (PROF?.kind === 'trae') {
      // TRAE has no rate-limit windows: its own per-model daily (high-priority) buckets and the weekly pool
      // (`model/internalUsage/read`, read-only), plus model → quotaKey from `model/list` (null for Seed/DeepSeek).
      const [u, l] = await Promise.all([call('model/internalUsage/read', {}), call('model/list', {}).catch(() => null)]);
      const modelQuotas = {};
      for (const m of l?.models ?? l?.data ?? []) {
        const id = m?.configName ?? m?.config_name ?? m?.id ?? m?.name ?? null;
        const meta = m?.businessMetadata ?? m?.business_metadata ?? null;
        const key = meta?.internal_daily_quota_key ?? meta?.internalDailyQuotaKey ?? m?.quotaKey ?? m?._meta?.trae?.quotaKey ?? null;
        if (id && key) modelQuotas[String(id).toLowerCase()] = key;
      }
      console.log(JSON.stringify({ kind: 'trae', dailyUsage: u?.dailyUsage ?? [], usage: u?.usage ?? null, modelQuotas }));
      finish(0);
    }
    // One read of everything quota.mjs needs: the logged-in account, its windows, its reset cards.
    const r = await call('account/rateLimits/read', {});
    console.log(JSON.stringify({
      accountId: r.accountId ?? null, ordinaryUsageAllowed: r.ordinaryUsageAllowed ?? null,
      buckets: r.rateLimitsByLimitId ?? { [r.rateLimits?.limitId ?? 'codex']: r.rateLimits }, resetCredits: r.rateLimitResetCredits ?? null,
    }));
    finish(0);
  } else if (cmd === 'reset-credits') {
    // Rate-limit reset credits ("reset cards"): available count plus, when the backend lists them, each credit's
    // grant and expiry (unix seconds; expiresAt null = never). credits null = only the count is known.
    const r = await call('account/rateLimits/read', {});
    console.log(JSON.stringify(r.rateLimitResetCredits ?? null));
    finish(0);
  } else if (cmd === 'reset-credit-use') {
    // Redeems one reset credit: the eligible windows go back to 0% and their reset clock restarts now. Irreversible;
    // --key makes a retry of the same attempt safe (the backend answers alreadyRedeemed instead of spending another).
    if (typeof opts.key !== 'string') die('reset-credit-use needs --key <uuid> (reuse it when retrying the same attempt)');
    const r = await call('account/rateLimitResetCredit/consume', { idempotencyKey: opts.key, creditId: typeof opts.credit === 'string' ? opts.credit : null });
    console.log(JSON.stringify(r));
    finish(r.outcome === 'reset' || r.outcome === 'alreadyRedeemed' ? 0 : 1);
  } else die(`unknown command ${cmd}`);
} catch (e) {
  // A TRAE model that no longer resolves fails at thread/start (before any turn), so the turn recorder never sees it:
  // record it here so routing skips just that model (lib/trae-health.mjs, 2026-11-13).
  const msg = String(e?.message ?? e);
  if (['start', 'turn'].includes(cmd) && failureKind(msg) === 'thread-too-large') rejectRequestBuffer(attemptThreadId ?? opts.thread);
  const policy = isPolicyBlock({ status: 'failed', error: msg });
  const infrastructureMiss = (['trae','ttadk'].includes(PROF?.kind)&&failureKind(msg)==='unavailable')||(PROF?.kind==='trae'&&/access (temporarily )?restricted|\b983\b/i.test(msg));
  if (infrastructureMiss && !policy) {
    const p = noteFailure(PROF.home, msg, Date.now(), opts.model ?? null);
    if (p?.modelPause) console.log(unavailableHint(p));
  }
  if (policy) {
    recordPolicyBlock(opts.model, msg);
    if (PROF?.kind === 'trae') notePolicyRestriction(PROF.home, msg, Date.now(), opts.model ?? null);
    console.log('security-policy-block: do not retry or resend to GPT; re-route with --adversarial');
  }
  if (cmd === 'start' && !activeTurn && !workStarted && ROUTE_ARGS && !BACKGROUND
    && (infrastructureMiss || (policy && (routeFlag(ROUTE_ARGS, 'security') || routeFlag(ROUTE_ARGS, 'adversarial'))))) {
    const turns = attemptThreadId ? await readTurns(attemptThreadId).catch(() => null) : [];
    const last = turns?.at(-1);
    if (turns && (!last || (last.status === 'failed' && Array.isArray(last.items) && !turnHasWork(last))) && !workStarted)
      await autoReroute(policy ? 'policy-block' : failureKind(msg) === 'unavailable' ? 'model-unavailable' : 'vendor-restriction', {}, policy);
    else console.log('reroute-skipped: start failure left an active, progressed or unconfirmed turn');
  }
  die(msg, 1);
}
