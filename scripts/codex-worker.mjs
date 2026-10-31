#!/usr/bin/env node
// codex-worker: run and steer Codex workers through a shared Codex app-server ("hub") over WebSocket.
//
//   codex-worker start  --cwd DIR [--model M] [--effort E] [--sandbox S] [--name N] --log FILE  "<prompt>"
//   codex-worker turn   --thread ID --log FILE [--effort E] [--model M]                          "<prompt>"
//   codex-worker steer  --thread ID                                                             "<message>"
//   codex-worker interrupt --thread ID
//   codex-worker status --thread ID
//
// `start` and `turn` follow the turn until it ends: every notification is appended to --log as JSONL, the first stdout
// line is `thread=<id> turn=<id>`, and the process exits 0 on completed, 1 on failed/interrupted. Run them as a
// harness background task so their exit notifies the orchestrator. `steer` injects a message into the running turn,
// `interrupt` stops it. Requires a hub: `codex app-server --listen ws://127.0.0.1:47321` (localhost only) running as a
// long-lived background task; override the URL with CODEX_HUB.
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const opts = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else pos.push(rest[i]);
}
const text = pos.join(' ');
const die = (msg, code = 2) => { process.stderr.write(`codex-worker: ${msg}\n`); process.exit(code); };
if (!cmd) die('usage: codex-worker start|turn|steer|interrupt|status ...');

const hub = process.env.CODEX_HUB || 'ws://127.0.0.1:47321';
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
ws.onclose = () => { if (!done) die(`hub connection closed (${hub}); is it running? (codex app-server --listen ${hub})`); };
ws.onerror = () => { if (!done) die(`cannot reach the hub at ${hub}; start it with: codex app-server --listen ${hub}`); };
ws.onmessage = (ev) => {
  const line = String(ev.data);
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id) && !m.method) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(`${m.error.code}: ${m.error.message}`)) : p.resolve(m.result); return;
  }
  if (m.id !== undefined && m.method) { // server→client request (approval etc.): workers run with approvalPolicy never; decline anything else
    write({ jsonrpc: '2.0', id: m.id, result: { decision: 'decline' } }); return;
  }
  if (logFile) fs.appendFileSync(logFile, line + '\n');
  for (const h of handlers) h(m);
};
await new Promise((resolve) => { ws.onopen = resolve; });

const init = async () => { await call('initialize', { clientInfo: { name: 'codex-worker', version: '1.0.0' } }); write({ jsonrpc: '2.0', method: 'initialized', params: {} }); };
const textInput = (t) => [{ type: 'text', text: t }];
const currentTurn = async (threadId) => {
  const r = await call('thread/read', { threadId, includeTurns: true });
  const turns = r.thread?.turns ?? [];
  return turns.filter((t) => t.status === 'inProgress').at(-1) ?? turns.at(-1);
};
const follow = (threadId, turnId) => {
  console.log(`thread=${threadId} turn=${turnId}`);
  handlers.push((m) => {
    const p = m.params || {};
    if (m.method === 'turn/completed' && (p.turn?.id ?? p.turnId) === turnId) {
      const status = p.turn?.status ?? 'completed';
      console.log(`turn ${status}${p.turn?.error ? ' error=' + JSON.stringify(p.turn.error) : ''}`);
      finish(status === 'completed' ? 0 : 1);
    }
  });
};

try {
  await init();
  if (cmd === 'start') {
    if (!opts.cwd || !text) die('start needs --cwd and a prompt');
    const th = await call('thread/start', {
      cwd: path.resolve(opts.cwd), model: opts.model, sandbox: opts.sandbox ?? 'danger-full-access', approvalPolicy: 'never',
    });
    const threadId = th.thread?.id ?? th.threadId;
    if (opts.name) await call('thread/name/set', { threadId, name: opts.name }).catch(() => {});
    const ts = await call('turn/start', { threadId, input: textInput(text), effort: opts.effort, model: opts.model });
    follow(threadId, ts.turn?.id ?? ts.turnId);
  } else if (cmd === 'turn') {
    if (!opts.thread || !text) die('turn needs --thread and a prompt');
    await call('thread/resume', { threadId: opts.thread, model: opts.model }).catch(() => {});
    const ts = await call('turn/start', { threadId: opts.thread, input: textInput(text), effort: opts.effort, model: opts.model });
    follow(opts.thread, ts.turn?.id ?? ts.turnId);
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
  } else die(`unknown command ${cmd}`);
} catch (e) { die(e.message, 1); }
