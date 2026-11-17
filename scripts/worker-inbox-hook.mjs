#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrator } from './lib/hook-context.mjs';
import { validRulesSession, readSeen, withRulesDelivery, hookOutput, cleanupRulesDelivery } from './lib/rules-delivery.mjs';
import { validOwner, readInboxAsync, deliverAsync, hasWatcherAsync, eventLine, followerAlive } from './lib/worker-events.mjs';
import { captureStopTasks, stopBackgroundState } from './lib/worker-background.mjs';
import { deliverAnswers, answerLine } from './lib/user-queue.mjs';
import { projectForOwner } from './lib/task-board.mjs';

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
// Bound work inside the process; the settings timeout also covers cold process startup.
const deadlineAt = Date.now() + 220;
const deadline = setTimeout(async () => {
  await Promise.race([cleanupRulesDelivery(), new Promise(resolve => setTimeout(resolve, 40))]);
  process.exit(0);
}, 220);
try {
  let raw = '';
  for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw Error('large input'); }
  const input = JSON.parse(raw);
  if (!input || !validOwner(input.session_id) || !validRulesSession(input.session_id) || !['Stop', 'SessionStart'].includes(input.hook_event_name)
    || (input.hook_event_name === 'SessionStart' && !['startup', 'resume', 'compact', 'fork', 'clear'].includes(input.source))) process.exit(0);
  await captureStopTasks(input).catch(() => {});
  const seen = await readSeen();
  if (!await orchestrator(input, seen)) process.exit(0);
  const owner = input.session_id, start = input.hook_event_name === 'SessionStart';
  // A continuation never blocks or acknowledges again. Remember the registry so the next Stop can recognise a reported exit.
  if (!start && input.stop_hook_active === true) {
    await stopBackgroundState(owner, input.background_tasks, await readInboxAsync(owner), { ancestryDeadline: deadlineAt - 80 });
    process.exit(0);
  }
  if (start && process.env.CLAUDE_ENV_FILE) {
    // Append only the public owner ID; never read or copy the environment file.
    await fs.appendFile(process.env.CLAUDE_ENV_FILE, `\nexport ORCHESTRATOR_OWNER='${owner}'\n`);
  }
  await withRulesDelivery(input, seen, {}, async (rules) => {
    const snapshot = await readInboxAsync(owner);
    const background = start ? { covered: new Set(), suppressed: new Set() }
      : await stopBackgroundState(owner, input.background_tasks, snapshot, { ancestryDeadline: deadlineAt - 80 });
    const output = async (reason) => {
      await hookOutput(start ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reason } }
        : { decision: 'block', reason });
      if (rules) rules.delivered = true;
    };
    const outputWithAnswers = async (reason, onlyAnswers = false) => {
      let printed = false;
      await deliverAnswers({ owner, project: process.env.ORCHESTRATOR_PROJECT, projectOfOwner: () => projectForOwner(owner),
        print: async items => { await output([reason, items.map(answerLine).join('\n'), rules?.reason].filter(Boolean).join('\n\n')); printed = true; } }).catch(() => {});
      if (!printed && !onlyAnswers) { await output([reason, rules?.reason].filter(Boolean).join('\n\n')); printed = true; }
      return printed;
    };
    let visible = false;
    const delivery = await deliverAsync(owner, async (rows) => {
      rows = rows.filter((row) => !background.suppressed.has(row.id));
      if (!rows.length) return;
      visible = true;
      const reason = rows.map((row) => ['message', 'question', 'answered'].includes(row.event) ? eventLine(row)
        : `worker ${eventLine({ ...row, name: String(row.name ?? row.thread ?? '-').slice(0, 120), outFile: '' }, '').replaceAll('\t', ' ').trim()}: read ${JSON.stringify(String(row.outFile ?? row.logFile ?? 'the worker log').slice(0, 500))} and act`).join('\n')
        + '\nAnswer open questions promptly with codex-worker reply; after its timeout the worker proceeds with its stated default (or ends BLOCKED without one). Handle finished workers first; use codex-worker watch as a run_in_background task for asks/risk notes; live tracked start/turn followers cover completion wakes.';
      await outputWithAnswers(reason);
    }, 10);
    if (delivery.failed || visible) return;
    if (await outputWithAnswers('', true)) return;
    if (rules) { await output(rules.reason); return; }
    const running = snapshot.running.filter((row) => !row.stale);
    const questions = snapshot.questions;
    const ownerPattern = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Any registered task whose command runs this owner's watcher counts, whatever the task type label or node path; a watcher
    // armed without --owner takes the owner from ORCHESTRATOR_OWNER, so the live claim (checked below) identifies it.
    const watchTasks = Array.isArray(input.background_tasks) ? input.background_tasks.filter((task) => typeof task?.command === 'string'
      && /codex-worker(?:\.mjs)?["']?\s+(?:--\S+\s+\S+\s+)*watch\b/.test(task.command)) : null;
    const registered = !watchTasks || watchTasks.some((task) => !/--owner\b/.test(task.command)
      || new RegExp(`--owner[\\s=]+(?:'${ownerPattern}'|"${ownerPattern}"|${ownerPattern})(?=[\\s;&|)]|$)`).test(task.command));
    const claimed = await hasWatcherAsync(owner);
    if (!running.length || (registered && claimed)) return;
    const open = questions.filter((ask) => running.some((row) => row.account === ask.account && row.thread === ask.thread));
    const uncovered = running.filter((row) => !background.covered.has(row.runId));
    if (!open.length && !uncovered.length) return;
    const workers = [...new Set([...uncovered.map((row) => `${row.name ?? row.thread ?? row.runId} (account=${row.account}, thread=${row.thread ?? '-'}: ${!Array.isArray(input.background_tasks) ? 'background_tasks missing; tracked launch cannot be verified' : !followerAlive(row) ? 'follower PID not live' : 'no matching tracked start/turn follower'})`),
      ...open.map((ask) => `${ask.name ?? ask.thread} (account=${ask.account}, thread=${ask.thread}: open ask ${ask.questionId})`)])].join('; ');
    const why = `watcher claim ${claimed ? 'live' : 'absent or stale'}; background tasks ${watchTasks ? `${input.background_tasks.length} listed, ${watchTasks.length} run a watcher, owner ${registered ? 'matched' : 'not matched'}` : 'not listed'}`;
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-worker.mjs');
    const reason = `arm the watcher: run ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} watch --owner ${owner} as a background task (run_in_background), never detach with &. Coverage required for ${workers}. ${running.length} worker(s) may still be running; reconcile with codex-worker mine --owner ${owner}. (${why})`;
    await output(reason);
  });
} catch {} finally { clearTimeout(deadline); }
