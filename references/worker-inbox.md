# Worker Completion Inbox

Edit-only change, 2026-11-14. No settings, hooks, hubs, accounts or dependencies were installed.

## Official Contract And Verification

Checked the official [hooks reference](https://code.claude.com/docs/en/hooks),
[Bash tool reference](https://code.claude.com/docs/en/tools-reference#background-commands),
[background Bash guide](https://code.claude.com/docs/en/interactive-mode#background-bash-commands),
[headless background exit](https://code.claude.com/docs/en/headless#background-tasks-at-exit),
and [environment reference](https://code.claude.com/docs/en/env-vars) on 2026-11-14.
Web search/fetch returned no content in this harness; public HTTPS fetches of the official `.md` pages succeeded.
No authenticated browser or login material was used.

The exact hook fields relied on are:

```json
{"hook_event_name":"Stop","session_id":"abc123","stop_hook_active":false}
```

```json
{"decision":"block","reason":"worker X finished: read the output and act"}
```

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"worker inbox"}}
```

The Stop table says: `"block" prevents Claude from stopping`. Stop does not run on user interrupts or API errors;
`stop_hook_active` guards continuation loops. SessionStart covers startup/resume/compact/fork/clear.
The documented environment bridge is `CLAUDE_ENV_FILE`; the inbox hook appends only a public
`ORCHESTRATOR_OWNER` export, never reads that file. Current Stop inputs may expose `background_tasks`;
when present, watcher enforcement checks that registry as well as a live heartbeat/PID.

The Bash reference explicitly exposes `run_in_background: true`. The headless guide confirms:
"Claude then takes one more turn with the outcome."
The docs do not promise the exact `task_notification` message shape for every interactive harness,
nor say that an inner `&` has its own completion notification. Such a detached child is not a separately registered
Bash task, so never rely on it. Generic async hooks do not wake idle sessions; `asyncRewake` is documented but is
not used here. Watch must be a Bash background task, not an `async` hook.

`claude --help` was run: it exposes `--bg`, `--resume`, `--session-id`, and `--settings`, but not a CLI flag
for a Bash tool's `run_in_background`. `--bg` backgrounds a Claude session, not an arbitrary worker shell.
The environment reference documents `CLAUDECODE=1` and inherited `CLAUDE_JOB_DIR` for background sessions.
Here only the allowlisted variables were inspected: `CLAUDECODE=1`, `CLAUDE_JOB_DIR` present,
`CLAUDE_SESSION_ID` and `CLAUDE_CODE_TASK_ID` absent. No documented Bash session-ID/task-ID variable was found.
Therefore use the SessionStart bridge or explicitly pass the hook's `session_id` as `--owner`.

## Operation

`scripts/lib/worker-events.mjs` serializes append/fsync under a lock in
`~/.claude/orchestrator/_shared/worker-events.jsonl`. Each record has the requested
`t,event,name,thread,account,model,exit,outFile,logFile,launcher:{sessionId,jobId,cwd}` fields,
plus unique event/run IDs, a durable monotonic sequence, logical owner, follower PID and optional final-line/turn/signal metadata.
Launcher environment capture is allowlisted, never the whole environment.
`RULES_SHARED` selects an isolated fixture directory for tests.

Compaction runs under the event lock after 1 MiB of growth or one minute on the next append. The hot log keeps
all pending notifications, latest live/uncertain running hints and 64 recent rows. Acknowledged history rotates
to `worker-event-history` with seven-day retention. Per-owner acknowledgement state is a high-water sequence
plus at most 64 recent receipts, not an ever-growing ID list; legacy state is migrated without a 4 MiB cutoff.
Compaction preserves rows for owners with an in-flight acknowledgement transaction. Audit receipts rotate
separately; missing optional telemetry reports unknown latency rather than invalidating a durable acknowledgement.
Undelivered work is never expired to satisfy a size limit, so a large genuinely pending backlog can still grow.

Start/turn/wait register before validation or connection and emit exactly one terminal event per follower.
Automatic handoff records the original turn at the handoff, and replacement/review followers keep the same owner.
Exit 4 is stalled; approval/deferral is needs-user; SIGTERM/SIGINT is follower-ended with conservative
`mayRun` for hub turns. `mine` queries already-known hub threads with bounded status calls, never starts a hub or
launches a replacement. A later completion of the same account/thread/turn clears earlier follower running hints;
a later terminal observation of the same account/thread also settles a lost start reply with no turn ID.
`mine` persists terminal hub observations. Dead/missing followers become stale after 60 seconds, stop demanding
watchers, and remain explicitly unknown until the hub is reconciled; this is not proof the hub turn stopped.
Exec rows printed by route retain the wrapper and use `run-tracked.sh`; the wrapper also covers audit/proxy failures.
Exec child commands have a private, supervised process group (no unref): signals/exit clean only that group,
with bounded TERM/KILL fallback, not a detached daemon or another task's children.

Launch every worker with Bash `run_in_background: true`, never `(command &)` or `nohup` inside a foreground call.
Record the owner alongside account/thread in the ledger. Run this as another tracked background task:

```bash
node "$HOME/.agents/skills/project-orchestrator/scripts/codex-worker.mjs" watch --owner <session-id>
```

Watch blocks until new terminal events exist, pending work is acknowledged by another deliverer, or its observed
running set settles/becomes stale. It prints the events/receipts/status it knows and exits 0. An atomic per-owner
claim allows only one watcher; duplicate invocations exit with an already-armed notice. Polls remember inode/offset,
read only appended bytes, skip unchanged files, and prefilter other owners before parsing; rotation refreshes the cursor.
Delivery is two-phase: persist an intent (timestamp, writer PID, token and at most 64 event IDs/sequences),
write output outside the lock, then commit the acknowledgement only if that token still owns the transaction.
Intent does not advance the committed high-water mark or receipts. A dead writer's intent is retryable immediately;
a live writer's uncommitted intent is retryable after three seconds. A late writer cannot overwrite a newer commit.
Print/commit failures retain pending work, and compaction preserves recoverable intents and their events.
If acknowledgement is unavailable the watcher prints what it knows without acknowledging and exits, not loops.
Hook/watcher redelivery is harmless: receipt sequences and event IDs make acknowledgement idempotent.
On wake read outputs and handle finished workers first, then re-arm watch if workers remain.
`mine --owner <session-id>` prints pending deliveries and hub-confirmed running/unknown statuses without acknowledging.
An acknowledgement means delivered to context, not that the orchestrator read/integrated/accepted the result.

The Stop hook checks `stop_hook_active` before delivery or any block. It blocks at most once per stop cycle,
on up to ten pending events or to arm a missing watcher; a continuation leaves newly arrived/remaining events pending.
Acknowledgement write failure or contention is silent and never falls through to a watcher block.
It shares the digest hook's orchestrator detection.
SessionStart delivers the same inbox as additionalContext and restores the public owner bridge.
Async disk operations have a 220 ms internal fail-open deadline; cold Node startup is outside that budget and
is covered by the two-second settings timeout, not a guaranteed sub-300 ms wall time.
The nightly `workerInbox` section reports per owner p50/p90/max finish-to-delivery milliseconds,
window and total pending counts, unknown latency count, seven-day retention and window launches missing identity.

## Owner Installation And Limits

After review, merge [stop-hook.json](../templates/stop-hook.json) and the updated
[session-start-hook.json](../templates/session-start-hook.json) into existing settings without replacing other hooks.
The Stop fragment is synchronous, not async:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "/Users/bytedance/.nvm/versions/node/v22.17.0/bin/node \"$HOME/.agents/skills/project-orchestrator/scripts/worker-inbox-hook.mjs\"",
        "timeout": 2
      }]
    }]
  }
}
```

Adjust the absolute Node binary if it moves. No installer was run.
A killed/closed session cannot be woken: durable events wait for the same owner's next SessionStart or watcher.
SIGKILL/power loss cannot run follower exit handlers; running records remain for `mine`/`wait` reconciliation.
Missing identity falls back to the public job ID (or unknown); that is not reliably the hook session ID and is counted
as a missing identity. Supply `--owner` or install the SessionStart bridge before trusting delivery.
Forked/cleared sessions receive their own owner bridge; explicitly reconcile the previous owner instead of silently sharing its inbox.
stdout pipe/file + Claude environment is only a warning heuristic, not proof of harness tracking. Without the
documented Stop task registry, live watcher detection is also best-effort (heartbeat/PID).
Hook timeouts, lock contention, disk failures, or missed orchestrator detection fail open. Acknowledged history growth
does not permanently turn delivery off. A crash/timeout after intent persistence but before output/commit leaves
the event pending for at-least-once redelivery. A crash after output but before commit can duplicate delivery;
handling repeated event IDs must remain harmless. A completed stdout write is not proof the session integrated the result.
Event/ack locks with a dead writer PID recover immediately; unmarked locks recover after 30 seconds. No permanent daemon or guaranteed wake after process death
is claimed. The user still must arm the watcher as requested; the loop guard intentionally cannot force it forever.
Unattended background time limits can stop a watcher; re-arm after that notification.
