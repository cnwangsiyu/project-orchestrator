#!/usr/bin/env node
// codex-worker: run and steer Codex workers through a shared Codex app-server ("hub") over WebSocket.
//
//   codex-worker hub                                                       (start the hub if it isn't up)
//   codex-worker start  --cwd DIR --effort E --sandbox S [--model M] [--name N] --log FILE [--out FILE]  "<prompt>"
//   codex-worker turn   --thread ID --effort E --log FILE [--out FILE] [--model M] [--sandbox S]       "<prompt>"
//   codex-worker wait   --thread ID [--log FILE] [--out FILE]
//   codex-worker steer  --thread ID                                                                     "<message>"
//   codex-worker interrupt --thread ID
//   codex-worker status --thread ID
//   codex-worker list   [--cwd DIR] [--search TEXT] [--limit N]
//
// `start` and `turn` follow the turn until it ends: every notification is appended to --log as JSONL, the first stdout
// line is `thread=<id> turn=<id>`, and the process exits 0 on completed, 1 on failed/interrupted. On exit it prints
// `turn <status>`, the token usage and `final: <first line of the final message>`, and writes the whole final message
// to --out. Run them as a harness background task so their exit notifies the orchestrator. `wait` re-attaches to a
// thread's running turn (e.g. after the orchestrator restarted) and exits the same way, at once if the turn already
// ended. `steer` injects a message into the running turn, `interrupt` stops it. `list` shows recent worker threads.
// Sandbox S is read-only | workspace-write | danger-full-access. Requires a hub on ws://127.0.0.1:47321 (localhost
// only; `hub` starts one detached so it outlives any one session); override the URL with CODEX_HUB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [cmd, ...rest] = process.argv.slice(2);
const opts = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else pos.push(rest[i]);
}
const text = pos.join(' ');
const die = (msg, code = 2) => { process.stderr.write(`codex-worker: ${msg}\n`); process.exit(code); };
if (!cmd) die('usage: codex-worker hub|start|turn|wait|steer|interrupt|status|list ...');
if ((cmd === 'start' || cmd === 'turn') && typeof opts.effort !== 'string') die(`${cmd} needs --effort (the catalog default may be low)`);
if (cmd === 'start' && typeof opts.sandbox !== 'string') die('start needs --sandbox (read-only | workspace-write | danger-full-access; never wider than the orchestrator)');
const SANDBOX_POLICY = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
if (opts.sandbox !== undefined && !SANDBOX_POLICY[opts.sandbox]) die(`unknown --sandbox ${opts.sandbox}`);

const hub = process.env.CODEX_HUB || 'ws://127.0.0.1:47321';
const ready = () => fetch(hub.replace(/^ws/, 'http') + '/readyz', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
if (cmd === 'hub') {
  if (await ready()) { console.log(`hub up at ${hub}`); process.exit(0); }
  const logPath = path.join(os.homedir(), '.codex', 'hub.log');
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
    const ts = await call('turn/start', { threadId, input: textInput(text), effort: opts.effort, model: opts.model });
    follow(threadId, ts.turn?.id ?? ts.turnId);
  } else if (cmd === 'turn') {
    if (!opts.thread || !text) die('turn needs --thread and a prompt');
    await call('thread/resume', { threadId: opts.thread, model: opts.model }).catch(() => {});
    const ts = await call('turn/start', {
      threadId: opts.thread, input: textInput(text), effort: opts.effort, model: opts.model,
      sandboxPolicy: opts.sandbox && { type: SANDBOX_POLICY[opts.sandbox] },
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
  } else die(`unknown command ${cmd}`);
} catch (e) { die(e.message, 1); }
