#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesShared } from './lib/global-rules.mjs';
import { orchestrator, readSmall } from './lib/hook-context.mjs';
import { validOwner, readInboxAsync, deliverAsync, hasWatcherAsync, eventLine } from './lib/worker-events.mjs';

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
// Leave startup overhead below the 300 ms budget; stalled I/O cannot hold the session.
const deadline = setTimeout(() => process.exit(0), 220);
const output = (value) => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n',
  (error) => error ? reject(error) : resolve()));
try {
  let raw = '';
  for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw Error('large input'); }
  const input = JSON.parse(raw);
  if (!input || !validOwner(input.session_id) || !['Stop', 'SessionStart'].includes(input.hook_event_name)
    || (input.hook_event_name === 'SessionStart' && !['startup', 'resume', 'compact'].includes(input.source))) process.exit(0);
  let seen = {}; try { seen = JSON.parse(await readSmall(path.join(rulesShared(), 'rules-seen.json'), 4 * 1024 * 1024)); } catch {}
  if (!await orchestrator(input, seen ?? {})) process.exit(0);
  const owner = input.session_id, start = input.hook_event_name === 'SessionStart';
  const budgets = { maxAckBytes: 4 * 1024 * 1024 };
  if (start && process.env.CLAUDE_ENV_FILE) {
    // Append only the public owner ID; never read or copy the environment file.
    await fs.appendFile(process.env.CLAUDE_ENV_FILE, `\nexport ORCHESTRATOR_OWNER='${owner}'\n`);
  }
  const delivery = await deliverAsync(owner, async (rows) => {
    const reason = rows.map((row) => `worker ${eventLine({ ...row, name: String(row.name ?? row.thread ?? '-').slice(0, 120), outFile: '' }, '').replaceAll('\t', ' ').trim()}: read ${JSON.stringify(String(row.outFile ?? row.logFile ?? 'the worker log').slice(0, 500))} and act`).join('\n')
      + '\nHandle finished workers first; then re-arm codex-worker watch as a run_in_background task if workers remain.';
    await output(start ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reason } }
      : { decision: 'block', reason });
  }, 10, budgets);
  if (delivery.delivered.length) process.exit(0);
  const running = delivery.running ?? (await readInboxAsync(owner, budgets)).running;
  const ownerPattern = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const registered = !Array.isArray(input.background_tasks) || input.background_tasks.some((task) => task.type === 'shell'
    && typeof task.command === 'string' && /codex-worker\.mjs["']?\s+watch\b/.test(task.command)
    && new RegExp(`--owner\\s+(?:'${ownerPattern}'|"${ownerPattern}"|${ownerPattern})(?=\\s|$)`).test(task.command));
  if (!running.length || (registered && await hasWatcherAsync(owner))) process.exit(0);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-worker.mjs');
  const reason = `arm the watcher: run ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} watch --owner ${owner} as a background task (run_in_background), never detach with &. ${running.length} worker(s) may still be running; reconcile with codex-worker mine --owner ${owner}.`;
  if (start) await output({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reason } });
  else if (input.stop_hook_active !== true) await output({ decision: 'block', reason });
} catch {} finally { clearTimeout(deadline); }
