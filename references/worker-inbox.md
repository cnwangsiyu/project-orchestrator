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
`stop_hook_active` guards continuation loops. SessionStart covers startup/resume/compact.
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
plus unique event/run IDs, logical owner, follower PID and optional final-line/turn/signal metadata.
Launcher environment capture is allowlisted, never the whole environment.
`RULES_SHARED` selects an isolated fixture directory for tests.

Start/turn/wait register before validation or connection and emit exactly one terminal event per follower.
Automatic handoff records the original turn at the handoff, and replacement/review followers keep the same owner.
Exit 4 is stalled; approval/deferral is needs-user; SIGTERM/SIGINT is follower-ended with conservative
`mayRun` for hub turns. `mine` queries already-known hub threads with bounded status calls, never starts a hub or
launches a replacement. A later completion of the same account/thread/turn clears earlier follower running hints.
Exec rows printed by route retain the wrapper and use `run-tracked.sh`; the wrapper also covers audit/proxy failures.
Exec child commands have a private, supervised process group (no unref): signals/exit clean only that group,
with bounded TERM/KILL fallback, not a detached daemon or another task's children.

Launch every worker with Bash `run_in_background: true`, never `(command &)` or `nohup` inside a foreground call.
Record the owner alongside account/thread in the ledger. Run this as another tracked background task:

```bash
node "$HOME/.agents/skills/project-orchestrator/scripts/codex-worker.mjs" watch --owner <session-id>
```

Watch blocks until an unacknowledged terminal event exists, prints name/result/output/final-line and exits 0.
Printing and atomic per-owner acknowledgements are serialized; a print failure retains the event.
On wake read outputs and handle finished workers first, then re-arm watch if workers remain.
`mine --owner <session-id>` prints pending deliveries and hub-confirmed running/unknown statuses without acknowledging.
An acknowledgement means delivered to context, not that the orchestrator read/integrated/accepted the result.

The Stop hook blocks on up to ten pending events, acknowledges only those printed, or asks to arm a missing
watcher once (`stop_hook_active`); otherwise it is silent. It shares the digest hook's orchestrator detection.
SessionStart delivers the same inbox as additionalContext and restores the public owner bridge.
Async disk operations have a 220 ms fail-open deadline, leaving process-start overhead under the 300 ms target.
The nightly `workerInbox` section reports per owner p50/p90/max finish-to-delivery milliseconds,
window and all-time unacknowledged counts, and window launches missing a session identity.

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
Forked sessions have different owners; explicitly reconcile the previous owner instead of silently sharing its inbox.
stdout pipe/file + Claude environment is only a warning heuristic, not proof of harness tracking. Without the
documented Stop task registry, live watcher detection is also best-effort (heartbeat/PID).
Hook timeouts, lock contention, huge history (including owner ack state over 4 MiB), disk failures, or missed orchestrator detection fail open;
they do not acknowledge unseen events. A crash after printing but before ack can redeliver (at least once).
Event locks with a dead writer PID recover immediately; unmarked/ack locks recover after 30 seconds. No permanent daemon or guaranteed wake after process death
is claimed. The user still must arm the watcher as requested; the loop guard intentionally cannot force it forever.
Unattended background time limits can stop a watcher; re-arm after that notification.
