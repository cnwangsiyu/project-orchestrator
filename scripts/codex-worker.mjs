#!/usr/bin/env node
// codex-worker: run and steer Codex workers through a shared Codex app-server ("hub") over WebSocket.
//
//   codex-worker [--account NAME] <command> …                             (any command, on that account's home and hub)
//   codex-worker accounts | account-add NAME [--home DIR] [--port N]      (list / add an account profile)
//   codex-worker hub                                                       (start the hub if it isn't up)
//   codex-worker start  --cwd DIR --effort E --sandbox S [--network on|off] [--model M] [--name N] --log FILE [--out FILE]  "<prompt>"
//   codex-worker turn   --thread ID --effort E --log FILE [--out FILE] [--model M] [--sandbox S [--network on|off]]      "<prompt>"
//   codex-worker wait   --thread ID [--log FILE] [--out FILE]
//   codex-worker steer  --thread ID                                                                     "<message>"
//   codex-worker interrupt --thread ID
//   codex-worker status --thread ID
//   codex-worker list   [--cwd DIR] [--search TEXT] [--limit N]
//   codex-worker quota                                                     (the account's rate-limit windows, JSON)
//   codex-worker reset-credits                                             (reset cards: count and expiries, JSON)
//   codex-worker reset-credit-use --key UUID [--credit ID]                 (redeem one reset card; irreversible)
//
// `start` and `turn` follow the turn until it ends: every notification is appended to --log as JSONL, the first stdout
// line is `thread=<id> turn=<id>`, and the process exits 0 on completed, 1 on failed/interrupted. On exit it prints
// `turn <status>`, the token usage and `final: <first line of the final message>`, and writes the whole final message
// to --out. Run them as a harness background task so their exit notifies the orchestrator. `wait` re-attaches to a
// thread's running turn (e.g. after the orchestrator restarted) and exits the same way, at once if the turn already
// ended. `steer` injects a message into the running turn, `interrupt` stops it. `list` shows recent worker threads.
// Sandbox S is read-only | workspace-write | danger-full-access. In workspace-write the network follows Codex's config
// (`[sandbox_workspace_write] network_access`) unless --network on|off, and Codex keeps every git metadata dir
// read-only (so the worker can edit files but not add, commit or fetch).
// Requires a hub on ws://127.0.0.1:47321 (localhost only; `hub` starts one detached so it outlives any one session);
// override the URL with CODEX_HUB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// --account NAME (anywhere on the line) picks a profile from the accounts file: its own CODEX_HOME, so its own login,
// and its own hub. Without it: CODEX_HOME / CODEX_HUB from the environment, else ~/.codex and the default hub.
const ACCOUNTS = process.env.CODEX_ACCOUNTS || path.join(os.homedir(), '.claude', 'orchestrator', '_shared', 'codex-accounts.json');
const readAccounts = () => { try { return JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); } catch { return {}; } };
const writeAccounts = (reg) => {
  fs.mkdirSync(path.dirname(ACCOUNTS), { recursive: true });
  const t = `${ACCOUNTS}.${process.pid}`; fs.writeFileSync(t, JSON.stringify(reg, null, 1)); fs.renameSync(t, ACCOUNTS);
};
const argv = process.argv.slice(2);
const ai = argv.indexOf('--account');
const account = ai >= 0 ? argv.splice(ai, 2)[1] : null;
if (account) {
  const prof = readAccounts()[account] ?? (account === 'main' ? { home: path.join(os.homedir(), '.codex'), hub: 'ws://127.0.0.1:47321' } : null);
  if (!prof) { process.stderr.write(`codex-worker: unknown account ${account} (codex-worker accounts; add one with account-add)\n`); process.exit(2); }
  process.env.CODEX_HOME = prof.home; process.env.CODEX_HUB = prof.hub;
}
const [cmd, ...rest] = argv;
const opts = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else pos.push(rest[i]);
}
const text = pos.join(' ');
const die = (msg, code = 2) => { process.stderr.write(`codex-worker: ${msg}\n`); process.exit(code); };
if (!cmd) die('usage: codex-worker [--account NAME] hub|start|turn|wait|steer|interrupt|status|list|quota|usage|reset-credits|reset-credit-use|accounts|account-add ...');
if ((cmd === 'start' || cmd === 'turn') && typeof opts.effort !== 'string') die(`${cmd} needs --effort (the catalog default may be low)`);
if (cmd === 'start' && typeof opts.sandbox !== 'string') die('start needs --sandbox (read-only | workspace-write | danger-full-access; never wider than the orchestrator)');
const SANDBOX_POLICY = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
if (opts.sandbox !== undefined && !SANDBOX_POLICY[opts.sandbox]) die(`unknown --sandbox ${opts.sandbox}`);
if (opts.network === true) opts.network = 'on';
if (opts.network !== undefined && !['on', 'off'].includes(opts.network)) die('--network takes on or off');
if (opts.network !== undefined && opts.sandbox !== 'workspace-write') die('--network goes with --sandbox workspace-write');
// Codex's own default for workspace-write network, so an explicit turn-level policy doesn't silently change it.
const configNetwork = () => {
  try {
    const toml = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
    const section = toml.split(/^\[/m).find((s) => s.startsWith('sandbox_workspace_write]')) ?? '';
    return /^\s*network_access\s*=\s*true\b/m.test(section);
  } catch { return false; }
};
// The turn-level sandbox policy. Don't add git dirs as writable roots: Codex overrides them read-only on purpose, since
// a sandboxed write to .git/hooks or .git/config would run outside the sandbox at the next git command.
const sandboxPolicy = (mode) => mode === 'workspace-write'
  ? { type: 'workspaceWrite', networkAccess: opts.network === undefined ? configNetwork() : opts.network === 'on' }
  : { type: SANDBOX_POLICY[mode] };

if (cmd === 'accounts') {
  const reg = readAccounts();
  if (!Object.keys(reg).length) console.log('main\t~/.codex\tws://127.0.0.1:47321\t(default; no accounts file yet)');
  for (const [name, a] of Object.entries(reg)) console.log([name, a.home, a.hub, a.email ?? '-', a.plan ?? '-'].join('\t'));
  process.exit(0);
}
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
const hub = process.env.CODEX_HUB || 'ws://127.0.0.1:47321';
const ready = () => fetch(hub.replace(/^ws/, 'http') + '/readyz', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
if (cmd === 'hub') {
  if (await ready()) { console.log(`hub up at ${hub}`); process.exit(0); }
  const logPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hub.log');
  const out = fs.openSync(logPath, 'a');
  spawn('codex', ['app-server', '--listen', hub], { detached: true, stdio: ['ignore', out, out] }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ready()) { console.log(`hub started at ${hub} (log: ${logPath})`); process.exit(0); }
  }
  die(`hub did not become ready; see ${logPath}`, 1);
}

const ws = new WebSocket(hub);
let done = false, nextId = 0;
const pending = new Map();
const handlers = [];
const logFile = opts.log ? path.resolve(opts.log) : null;
const write = (obj) => ws.send(JSON.stringify(obj));
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); write({ jsonrpc: '2.0', id, method, params });
});
const finish = (code) => { done = true; try { ws.close(); } catch {} process.exit(code); };
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
  'mcpServer/elicitation/request': () => ({ action: 'decline' }),
  'item/tool/call': () => ({ contentItems: [{ type: 'inputText', text: 'Not available in this session.' }], success: false }),
  'item/tool/requestUserInput': (p) => ({ answers: Object.fromEntries((p.questions ?? []).map((q) => [q.id, { answers: [NO_USER] }])) }),
};
ws.onclose = () => { if (!done) die(`hub connection closed (${hub}); is it running? (codex-worker hub)`); };
ws.onerror = () => { if (!done) die(`cannot reach the hub at ${hub}; start it with: codex-worker hub`); };
ws.onmessage = (ev) => {
  const line = String(ev.data);
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id) && !m.method) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(`${m.error.code}: ${m.error.message}`)) : p.resolve(m.result); return;
  }
  if (logFile) fs.appendFileSync(logFile, line + '\n');
  if (m.id !== undefined && m.method) {
    const reply = REPLIES[m.method];
    write(reply ? { jsonrpc: '2.0', id: m.id, result: reply(m.params || {}) }
      : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} is not supported by codex-worker` } });
    return;
  }
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
// Prints the outcome and exits: status, usage, the final message's first line (whole message to --out).
const report = async (threadId, turn, final, usage) => {
  console.log(`turn ${turn.status}${turn.error ? ' error=' + JSON.stringify(turn.error) : ''}`);
  if (usage) console.log(`usage (thread total) input=${usage.inputTokens} cached=${usage.cachedInputTokens} output=${usage.outputTokens}`);
  final ??= lastMessage(turn.items);
  if (!final) final = lastMessage((await readTurns(threadId).catch(() => [])).find((t) => t.id === turn.id)?.items);
  if (final) {
    if (opts.out) fs.writeFileSync(path.resolve(opts.out), final + '\n');
    console.log(`final: ${final.split('\n').find((l) => l.trim()) ?? ''}`);
  }
  finish(turn.status === 'completed' ? 0 : 1);
};
const follow = (threadId, turnId) => {
  console.log(`thread=${threadId} turn=${turnId}`);
  let final, usage;
  handlers.push((m) => {
    const p = m.params || {};
    if (p.turnId !== undefined && p.turnId !== turnId) return;
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.text) final = p.item.text;
    else if (m.method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.total;
    else if (m.method === 'turn/completed' && (p.turn?.id ?? p.turnId) === turnId) report(threadId, p.turn ?? { id: turnId, status: 'completed' }, final, usage);
  });
};

try {
  await init();
  if (cmd === 'start') {
    if (!opts.cwd || !text) die('start needs --cwd and a prompt');
    const th = await call('thread/start', {
      cwd: path.resolve(opts.cwd), model: opts.model, sandbox: opts.sandbox, approvalPolicy: 'never',
    });
    const threadId = th.thread?.id ?? th.threadId;
    if (opts.name) await call('thread/name/set', { threadId, name: opts.name }).catch(() => {});
    const ts = await call('turn/start', {
      threadId, input: textInput(text), effort: opts.effort, model: opts.model,
      sandboxPolicy: opts.network !== undefined ? sandboxPolicy(opts.sandbox) : undefined,
    });
    follow(threadId, ts.turn?.id ?? ts.turnId);
  } else if (cmd === 'turn') {
    if (!opts.thread || !text) die('turn needs --thread and a prompt');
    await call('thread/resume', { threadId: opts.thread, model: opts.model }).catch(() => {});
    const ts = await call('turn/start', {
      threadId: opts.thread, input: textInput(text), effort: opts.effort, model: opts.model,
      sandboxPolicy: opts.sandbox && sandboxPolicy(opts.sandbox),
    });
    follow(opts.thread, ts.turn?.id ?? ts.turnId);
  } else if (cmd === 'wait') {
    if (!opts.thread) die('wait needs --thread');
    await call('thread/resume', { threadId: opts.thread }).catch(() => {});
    const t = await currentTurn(opts.thread);
    if (!t) die('thread has no turns', 3);
    if (t.status === 'inProgress') follow(opts.thread, t.id);
    else { console.log(`thread=${opts.thread} turn=${t.id}`); await report(opts.thread, t); }
  } else if (cmd === 'steer') {
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
    console.log(JSON.stringify({ thread: opts.thread, name: r.thread?.name, turns: turns.length, last: turns.at(-1) && { id: turns.at(-1).id, status: turns.at(-1).status, error: turns.at(-1).error } }));
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
} catch (e) { die(e.message, 1); }
