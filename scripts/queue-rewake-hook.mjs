// Claude runs this Stop hook in the background. Exit 2 asks the originating
// session to take a turn with stderr as its system reminder.
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { rulesShared } from './lib/global-rules.mjs';
import { currentQueueNotice } from './lib/worker-queue.mjs';
import { acquireLock } from './lib/shared-file.mjs';
import { validOwner, createEventTail, inbox, readAck, deliverAsync, hookEventLine } from './lib/worker-events.mjs';

async function listen(input) {
  const owner = input.session_id;
  if (input.hook_event_name !== 'Stop' || !validOwner(owner)) return;
  const tail = createEventTail(owner);
  const snapshot = async () => {
    await tail.read();
    return inbox(tail.rows(), owner, readAck(owner));
  };
  const hasNotice = state => state.pending.some(row => ['queue-stalled','queue-choice-failed'].includes(row.kind) && row.wake && currentQueueNotice(row,tail.rows()));
  let state = await snapshot();
  if (!hasNotice(state) && !state.running.some(row => !row.stale)) return;
  const release = acquireLock(path.join(rulesShared(), 'queue-rewake', owner), { timeoutMs: 0, ownerPid: true });
  if (!release) return;
  try {
    for (;;) {
      if (hasNotice(state)) {
        // Deliver the pending prefix together, preserving the shared inbox cursor.
        let woke = false;
        await deliverAsync(owner, async rows => {
          if (!rows.some(row=>['queue-stalled','queue-choice-failed'].includes(row.kind) && row.wake)) return;
          await new Promise((resolve,reject)=>process.stderr.write(rows.map(hookEventLine).join('\n') + '\n', err => err ? reject(err) : resolve()));
          woke = true;
        }, Infinity, { rows: tail.rows() });
        if (woke) { process.exitCode = 2; return; }
      } else if (!state.running.some(row => !row.stale)) return;
      await delay(2000);
      state = await snapshot();
    }
  } finally { release(); }
}
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
await listen(JSON.parse(raw));
