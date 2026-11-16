#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesShared } from './lib/global-rules.mjs';
import { orchestrator, readSmall } from './lib/hook-context.mjs';
import { validOwner, readInboxAsync, deliverAsync, hasWatcherAsync, eventLine } from './lib/worker-events.mjs';

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
// Bound work inside the process; the settings timeout also covers cold process startup.
const deadline = setTimeout(() => process.exit(0), 220);
const output = (value) => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n',
  (error) => error ? reject(error) : resolve()));
try {
  let raw = '';
  for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw Error('large input'); }
  const input = JSON.parse(raw);
  if (!input || !validOwner(input.session_id) || !['Stop', 'SessionStart'].includes(input.hook_event_name)
    || (input.hook_event_name === 'SessionStart' && !['startup', 'resume', 'compact', 'fork', 'clear'].includes(input.source))) process.exit(0);
  // A continuation never blocks again, even if new events arrived or the previous acknowledgement failed.
  if (input.hook_event_name === 'Stop' && input.stop_hook_active === true) process.exit(0);
  let seen = {}; try { seen = JSON.parse(await readSmall(path.join(rulesShared(), 'rules-seen.json'), 4 * 1024 * 1024)); } catch {}
  if (!await orchestrator(input, seen ?? {})) process.exit(0);
  const owner = input.session_id, start = input.hook_event_name === 'SessionStart';
  if (start && process.env.CLAUDE_ENV_FILE) {
    // Append only the public owner ID; never read or copy the environment file.
    await fs.appendFile(process.env.CLAUDE_ENV_FILE, `\nexport ORCHESTRATOR_OWNER='${owner}'\n`);
  }
  const delivery = await deliverAsync(owner, async (rows) => {
    const reason = rows.map((row) => ['message', 'question', 'answered'].includes(row.event) ? eventLine(row)
      : `worker ${eventLine({ ...row, name: String(row.name ?? row.thread ?? '-').slice(0, 120), outFile: '' }, '').replaceAll('\t', ' ').trim()}: read ${JSON.stringify(String(row.outFile ?? row.logFile ?? 'the worker log').slice(0, 500))} and act`).join('\n')
      + '\nAnswer open questions promptly with codex-worker reply; after its timeout the worker proceeds with its stated default (or ends BLOCKED without one). Handle finished workers first; then re-arm codex-worker watch as a run_in_background task if workers remain.';
    await output(start ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reason } }
      : { decision: 'block', reason });
  }, 10);
  if (delivery.failed) process.exit(0);
  if (delivery.delivered.length) process.exit(0);
  const running = (delivery.running ?? (await readInboxAsync(owner)).running).filter((row) => !row.stale);
  const ownerPattern = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Any registered task whose command runs this owner's watcher counts, whatever the task type label or node path; a watcher
  // armed without --owner takes the owner from ORCHESTRATOR_OWNER, so the live claim (checked below) identifies it.
  const watchTasks = Array.isArray(input.background_tasks) ? input.background_tasks.filter((task) => typeof task?.command === 'string'
    && /codex-worker(?:\.mjs)?["']?\s+(?:--\S+\s+\S+\s+)*watch\b/.test(task.command)) : null;
  const registered = !watchTasks || watchTasks.some((task) => !/--owner\b/.test(task.command)
    || new RegExp(`--owner[\\s=]+(?:'${ownerPattern}'|"${ownerPattern}"|${ownerPattern})(?=[\\s;&|)]|$)`).test(task.command));
  const claimed = await hasWatcherAsync(owner);
  if (!running.length || (registered && claimed)) process.exit(0);
  const why = `watcher claim ${claimed ? 'live' : 'absent or stale'}; background tasks ${watchTasks ? `${input.background_tasks.length} listed, ${watchTasks.length} run a watcher, owner ${registered ? 'matched' : 'not matched'}` : 'not listed'}`;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-worker.mjs');
  const reason = `arm the watcher: run ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} watch --owner ${owner} as a background task (run_in_background), never detach with &. ${running.length} worker(s) may still be running; reconcile with codex-worker mine --owner ${owner}. (${why})`;
  if (start) await output({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reason } });
  else if (input.stop_hook_active !== true) await output({ decision: 'block', reason });
} catch {} finally { clearTimeout(deadline); }
