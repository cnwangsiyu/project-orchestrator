import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rulesShared } from './global-rules.mjs';
import { validOwner, resolveOwner, workerContext, readEvents, inbox, appendTalkback, replyFile } from './worker-events.mjs';

export const TALKBACK_MARKER = '@@codex-worker-talkback ';
export const RELAY_WAIT_MS = 2000;
const fail = (message) => { const error = Error(message); error.exitCode = 2; throw error; };
const directory = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
const contains = (parent, child) => { const rel = path.relative(parent, child); return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
const explicitIdentity = 'use codex-worker.mjs --account NAME note --thread ID "<text>" or codex-worker.mjs --account NAME ask --thread ID "<question>" (use the launcher-supplied identity)';

export const resolveTalkbackIdentity = ({ account, thread, cwd = process.cwd(), env = process.env, report = () => {} }) => {
  if (account != null && !validOwner(account) || thread != null && !validOwner(thread)) fail('invalid public account/thread identifier');
  if (thread && account) return workerContext(account, thread);
  // Runtime shell IDs survive ignored launcher shell_environment_policy.set.
  // Never fall back to another cwd match if a supplied runtime ID cannot resolve.
  const runtimeIds = thread ? [] : ['CODEX_THREAD_ID', 'TRAECLI_THREAD_ID'].filter((name) => env[name]);
  if (runtimeIds.some((name) => !validOwner(env[name]))) fail(`invalid public runtime thread identifier; ${explicitIdentity}`);
  if (new Set(runtimeIds.map((name) => env[name])).size > 1)
    fail(`talkback identity ambiguous: conflicting ${runtimeIds.map((name) => `${name}=${env[name]}`).join(', ')}; ${explicitIdentity}`);
  const runtimeThread = runtimeIds.length ? env[runtimeIds[0]] : null;
  const contexts = [], root = path.join(rulesShared(), 'worker-context'), current = directory(cwd);
  let accounts = []; try { accounts = fs.readdirSync(root); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of accounts.filter((name) => validOwner(name) && (!account || name === account))) {
    let files = []; try { files = fs.readdirSync(path.join(root, name)); } catch { continue; }
    for (const file of files) {
      const id = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!validOwner(id) || thread && thread !== id || runtimeThread && runtimeThread !== id) continue;
      let context; try { context = workerContext(name, id); } catch { continue; }
      if (thread) contexts.push(context);
      else if (typeof context.cwd === 'string') {
        const recorded = directory(context.cwd);
        if (contains(recorded, current) || contains(current, recorded)) contexts.push(context);
      }
    }
  }
  let candidates = contexts;
  if (!thread) {
    const rows = readEvents(), running = new Set();
    for (const owner of new Set(contexts.map((c) => c.owner)))
      for (const row of inbox(rows, owner).running) if (row.turn)
        running.add(JSON.stringify([row.account, row.thread, row.runId]));
    candidates = contexts.filter((c) => running.has(JSON.stringify([c.account, c.thread, c.runId])));
  }
  candidates.sort((a, b) => `${a.account}/${a.thread}`.localeCompare(`${b.account}/${b.thread}`));
  if (!candidates.length) fail(`talkback identity not found for ${runtimeThread ? `${runtimeIds[0]}=${runtimeThread} at ` : ''}${cwd}; ${explicitIdentity}`);
  if (candidates.length > 1)
    fail(`talkback identity ambiguous for ${cwd}; matching contexts: ${candidates.map((c) => `${c.account}/${c.thread}`).join(', ')}; ${explicitIdentity}`);
  const chosen = candidates[0];
  report(`talkback: using thread ${chosen.thread} (account ${chosen.account})${runtimeThread ? ` via ${runtimeIds[0]}` : ''}`);
  return chosen;
};

const questionRecord = (metadata, id) => readEvents().find((row) => row.event === 'question' && row.questionId === id
  && row.thread === metadata.thread && row.account === metadata.account && row.owner === metadata.owner);
const readReply = (metadata, id) => {
  try {
    const value = JSON.parse(fs.readFileSync(replyFile(metadata.account, metadata.thread, id), 'utf8'));
    return value?.account === metadata.account && value.thread === metadata.thread && value.owner === metadata.owner
      && value.questionId === id && typeof value.text === 'string' ? value : null;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForQuestion = async (metadata, id) => {
  const until = Date.now() + RELAY_WAIT_MS;
  for (;;) {
    const question = questionRecord(metadata, id);
    if (question) return question;
    if (Date.now() >= until) return null;
    await sleep(50);
  }
};
const waitForAnswer = async (metadata, question, output) => {
  for (;;) {
    const answer = readReply(metadata, question.questionId);
    if (answer && answer.t <= question.expiresAt) { await output(answer.text); return 0; }
    if (Date.now() >= question.expiresAt) {
      await output(question.default ?? 'no answer'); return question.default !== undefined ? 3 : 4;
    }
    await sleep(Math.min(100, question.expiresAt - Date.now()));
  }
};

export const runWorkerTalkback = async ({ cmd, opts, text, account, cwd, output, report, awaitCommand }) => {
  const metadata = resolveTalkbackIdentity({ account, thread: opts.thread ?? (process.env.CODEX_WORKER_THREAD || null), cwd, report });
  metadata.owner = resolveOwner(metadata.owner);
  if (opts.owner !== undefined && opts.owner !== metadata.owner) fail(`${cmd} belongs to a different launching owner`);
  if (cmd === 'ask' && opts.await !== undefined) {
    if (!validOwner(opts.await)) fail('--await needs a public question ID');
    const question = await waitForQuestion(metadata, opts.await);
    if (!question) fail(`question ${opts.await} is not recorded yet; re-run ${awaitCommand(metadata, opts.await)}`);
    return waitForAnswer(metadata, question, output);
  }
  if (!text.trim()) fail(`${cmd} needs text`);
  const request = { version: 1, account: metadata.account, thread: metadata.thread, id: randomUUID().replaceAll('-', '').slice(0, 16), text };
  if (cmd === 'note') {
    request.type = 'message'; request.kind = opts.kind ?? 'info'; request.wake = opts.wake === true;
    if (opts.wake !== undefined && opts.wake !== true) fail('--wake is a flag');
    if (!['progress', 'risk', 'scope', 'info'].includes(request.kind)) fail('--kind takes progress, risk, scope or info');
  } else {
    request.type = 'question'; request.timeoutMin = Number(opts['timeout-min'] ?? 20);
    request.expiresAt = Date.now() + request.timeoutMin * 60000;
    if (!Number.isFinite(request.timeoutMin) || request.timeoutMin <= 0 || !Number.isFinite(request.expiresAt)) fail('--timeout-min takes a positive finite number');
    if (opts.default !== undefined && typeof opts.default !== 'string') fail('--default needs text');
    if (opts.default !== undefined) request.default = opts.default;
  }
  let row;
  try { row = appendTalkback(metadata, request); }
  catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
    const line = TALKBACK_MARKER + JSON.stringify(request);
    if (Buffer.byteLength(line) > 65536) fail('talkback marker exceeds 64 KiB; shorten the message');
    await output(line);
    if (cmd === 'note') { report('talkback: shared write denied; note handed to the follower'); return 0; }
    row = await waitForQuestion(metadata, request.id);
    if (!row) {
      report(`talkback: partial output not delivered yet; re-run ${awaitCommand(metadata, request.id)} (exit 6; do not repeat the question)`);
      return 6;
    }
  }
  if (cmd === 'note') { await output(`note recorded${row.wake ? '' : ' (delivered on the next natural wake)'}`); return 0; }
  report(`question ${request.id}: waiting up to ${request.timeoutMin}m`);
  return waitForAnswer(metadata, row, output);
};

// Only command output on this exact account/thread/turn can deliver a marker. Payloads
// carry no authority over owner/name/run metadata; the outside-sandbox follower supplies it.
export const createTalkbackRelay = (metadata, report = () => {}) => {
  const buffers = new Map();
  const line = (raw) => {
    if (!raw.startsWith(TALKBACK_MARKER) || Buffer.byteLength(raw) > 65536) return;
    let request; try { request = JSON.parse(raw.slice(TALKBACK_MARKER.length)); } catch { return; }
    if (request.version !== 1 || request.account !== metadata.account || request.thread !== metadata.thread
      || !validOwner(request.id) || typeof request.text !== 'string') return;
    if (request.type === 'message' && (!['progress', 'risk', 'scope', 'info'].includes(request.kind)
      || request.wake !== undefined && typeof request.wake !== 'boolean')) return;
    if (request.type === 'question' && (!Number.isFinite(request.timeoutMin) || request.timeoutMin <= 0
      || !Number.isFinite(request.expiresAt) || request.default !== undefined && typeof request.default !== 'string')) return;
    if (!['message', 'question'].includes(request.type)) return;
    try { appendTalkback(metadata, request); } catch (e) { report(`talkback relay: NOT RECORDED: ${e.message}`); }
  };
  return (message) => {
    const p = message.params ?? {};
    if (p.threadId !== metadata.thread || p.turnId !== metadata.turn) return;
    if (message.method === 'item/commandExecution/outputDelta' && typeof p.itemId === 'string' && typeof p.delta === 'string') {
      let data = (buffers.get(p.itemId) ?? '') + p.delta;
      const lines = data.split('\n'); data = lines.pop();
      for (const part of lines) line(part.replace(/\r$/, ''));
      // Keep line boundaries across chunks. An overlong line is discarded through
      // its newline, so a later chunk cannot masquerade as a fresh marker line.
      buffers.set(p.itemId, data.length <= 65536 ? data : '\x00');
    } else if (message.method === 'item/completed' && p.item?.type === 'commandExecution') {
      const output = p.item.aggregatedOutput ?? p.item.rawOutput?.stdout;
      if (typeof output === 'string') for (const part of output.split('\n')) line(part.replace(/\r$/, ''));
      buffers.delete(p.item.id);
    }
  };
};
