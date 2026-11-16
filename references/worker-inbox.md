# Worker Inbox: Completion And Mid-Turn Talkback

Edit-only change, updated 2026-11-15. No settings, hooks, hubs, accounts or dependencies were installed.

## Mid-Turn Commands

Workers can notify or ask their launching orchestrator without ending a turn. The commands reuse
`worker-events.jsonl`, the owner inbox, watch, and Stop/SessionStart delivery; there is no new daemon.

| Command | Result / exit |
| --- | --- |
| `codex-worker note [--kind progress\|risk\|scope\|info] [--wake] "<text>"` | Records a `message` and returns 0; info/progress wait for a natural wake, risk/scope wake, `--wake` requests an immediate wake (subject to debounce). |
| `codex-worker ask [--timeout-min N] [--default "<next action>"] "<question>"` | Records a `question` with a short ID and waits; answer on stdout, exit 0. Default timeout: 20 minutes. |
| Ask timeout with default | Default on stdout, exit 3; proceed as stated. |
| Ask timeout without default | `no answer` on stdout, exit 4; worker ends its turn BLOCKED. |
| Restricted ask without timely streamed output | Emits a marker and exits 6, with the exact `ask --await ID` command on stderr; run that command to keep waiting. |
| `codex-worker ask --await ID` | Reads the existing question/reply; answer exits 0, original deadline/default exits 3 or 4. No new question or shared write. |
| `codex-worker reply --thread ID [--account NAME] [--question ID] "<answer>"` | Answers the newest open question, or the specified open ID; exit 0. No open question falls back to steer and prints that fact, with steer's normal exit status. |

Use ask only when a decision is absent from the brief and changes the next action; state a default.
Use note only for risks, scope changes, decisions made, landed commits and findings that change someone else's
work, never routine progress, tool hiccups (probe timeouts, missing metadata) or status. Info/progress notes are
recorded for the next natural wake (worker exit, ask, risk, peer message or user turn); they do not end watch.
Risk/scope notes and asks wake. Use `note --wake` for info/progress only when it changes someone else's work now.
A blocker that requires the user still ends the turn with BLOCKED. Orchestrators answer promptly with reply. A question past its timeout has already taken the worker's default, or the
worker must end BLOCKED if none was provided; a later reply becomes steering if no open question exists.
The current orchestrator owner, when supplied via --owner or the owner bridge, must match the launcher.
If no owner bridge is set, an explicit thread/account uses the public launching context to select its owner.

At start, once the hub assigns a thread ID, the launcher resumes that thread with
`config.shell_environment_policy.set` containing CODEX_WORKER_THREAD, CODEX_WORKER_ACCOUNT,
CODEX_WORKER_OWNER, CODEX_WORKER_NAME and RULES_SHARED. Continuations refresh this config and
developer instructions. These values identify only this worker, not the shared hub's environment.
The launcher always also writes a small public context file at
`<shared>/worker-context/<account>/<thread>.json`, with cwd, startedAt, current turn, run ID and owner.
Start/turn refresh it; follow/wait attach it to the actual running turn. Developer instructions
include ready-to-run explicit commands with the exact script path and RULES_SHARED.
When flags and CODEX_WORKER_THREAD are absent, bare note/ask scan these public context files.
Candidates must have a cwd equal to, above or below the calling directory, and a running turn in
the event records matching their account/thread/run ID. One candidate is selected; several select
the newest startedAt/t; stderr says which thread/account was chosen. Sibling/unrelated directories
and completed contexts are excluded. No candidate exits 2 and names both explicit command forms;
the malformed-ID diagnostic is reserved for malformed supplied IDs. An explicit account limits
discovery to that account. Owner/name always come from the launching context, not the caller's
orchestrator identity. If thread/resume rejects config/instructions, the identity text is also
included in the turn input. Environment propagation is an optimization, not a requirement.

Note/ask first try the normal event append. On EACCES, EPERM or EROFS they emit one
`@@codex-worker-talkback <JSON>` line on stdout. The outside-sandbox start/turn/wait follower accepts
it only from command output on its exact account/thread/turn and supplies the launching owner/name.
It records the same message/question events, with the same note limits and question deadline.
Stable request IDs deduplicate streamed and completed output. The worker never changes sandbox
permissions or needs to write a shared reply file.

The follower consumes `item/commandExecution/outputDelta` chunks, including fragmented marker
lines, and `item/completed` commandExecution aggregatedOutput (or TRAE rawOutput.stdout).
Wait also consumes retained command output in the running turn's items. A restricted ask reads
the events file for up to two seconds to see its relayed question, then keeps reading its reply.
If no streamed record is visible, it exits 6 so the completed command output can deliver the
marker; the worker runs the exact printed `ask --await ID` command. That command only reads the
original question and reply; it preserves the original deadline/default and never asks twice.
The marker line precedes any eventual answer on the initial restricted command's stdout;
the --await command prints only the answer/default (or `no answer`). Reads of public context,
event and reply files must be allowed by the existing sandbox. Other write errors remain errors.

Verified offline on 2026-11-15: the installed Codex and TRAE `app-server generate-json-schema`
commands expose config and developerInstructions on thread/start and thread/resume, but no env
field on thread/start or turn/start. Both CLIs' help names shell_environment_policy. TTADK homes
use the Codex executable in this launcher; ChatGPT homes use the same Codex app-server path.
Both schemas expose `item/commandExecution/outputDelta` with threadId/turnId/itemId/delta, and
completed commandExecution aggregatedOutput. TRAE also exposes rawOutput.stdout/stderr.
The current TRAE worker's public notification log also contains live commandExecution outputDelta
events with exactly those four fields. This verifies the partial-output contract on that worker;
end-to-end marker delivery from an actually restricted TRAE shell still needs the owner's check.
Real /usr/bin/env subprocesses under the fake hub test applied shell_environment_policy.set for
Codex/ChatGPT and TTADK fixtures, and an ignored policy for the TRAE regression fixture. These prove
the fixture's apply/ignore behavior, not any live hub's environment implementation. Real note/ask
subprocesses with injected EACCES/EPERM/EROFS verify streamed relay and the completed-output/await
path without widening read-only/workspace-write policies. The reported live TRAE check lacked
identity variables, while explicit commands worked. Live restricted TRAE and personal Codex
verification belongs to the owner; discovery and output relay handle absent environment variables.

Replies are atomically written to `<shared>/worker-replies/<account>/<thread>/<question-id>.json`
and recorded as `answered` events under the existing event lock. A repeated writer cannot replace
an already written answer. Answer events are bookkeeping, not notifications. A question remains
open after its notification is acknowledged until answer/deadline; compaction preserves these
questions and their answer records. `mine` lists open questions even after inbox delivery.
Ask is a running shell command and uses the existing running-command stall exemption.

Notes allow at most six requested wake-ups per account/thread in a rolling hour, serialized under the event
lock; deferred info/progress notes consume no wake budget. Text is capped at 500 characters. Default deferred
notes and excess/overlength wake requests are recorded with `wake:false` (and truncation metadata when needed).
All recorded notes remain deliverable through the next inbox/hook or waking batch; only eligible waking notes
end watch. Recent notes remain through compaction for hourly accounting. Questions always wake.
Neither notes nor questions settle the running worker's lifecycle. Each hook/watcher notification
is one line, with control characters flattened:

```text
worker W notes [risk]: discovered risk
worker W asks (id …): decision? — default: keep baseline — timeout 20m; answer with codex-worker reply --owner … --thread … --account … --question … "<text>"
```

Keep --out separate from files the worker is asked to write: it is the final-message destination.
BC-44 emits a single metadata-based warning before writing the final message if that destination
was created or changed during the followed turn; it does not read the destination's contents.
BC-45 omits the landing-gate phrase in route notes when the project profile has no landingGate.

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
when present, watcher enforcement checks that registry as well as a live heartbeat/PID. A registry entry for
each running worker's start/turn plus a live follower PID can cover completion wakes without a watcher. Missing
registry data cannot prove tracking and keeps the block; a live PID alone is insufficient.

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
Record the owner alongside account/thread in the ledger. For asks/risk notes or workers without verified live
tracked start/turn followers, run this as another tracked background task:

```bash
node "$HOME/.agents/skills/project-orchestrator/scripts/codex-worker.mjs" watch --owner <session-id>
```

Watch blocks until a completion/failure, ask, eligible risk/scope or explicit `note --wake` arrives, a waking
event is acknowledged elsewhere, or its observed running set settles/becomes stale. Deferred notes and their
acknowledgements do not end watch. The first waking event starts a 45-second collection window;
`--debounce-sec N` changes it and `--debounce-sec 0` disables it. Late events join the same exit printout,
including deferred notes. Each open ask caps the window at its deadline minus 80% of its original timeout,
so a short or already urgent ask flushes promptly. The window never extends on later events.
Watch prints the combined events/receipts/status and exits 0; a background task wakes Claude only on exit. An atomic per-owner
claim allows only one watcher; duplicate invocations exit with an already-armed notice. Polls remember inode/offset,
read only appended bytes, skip unchanged files, and prefilter other owners before parsing; rotation refreshes the cursor.
Delivery is two-phase: persist an intent (timestamp, writer PID, token and at most 64 event IDs/sequences),
write output outside the lock, then commit the acknowledgement only if that token still owns the transaction.
Intent does not advance the committed high-water mark or receipts. A dead writer's intent is retryable immediately;
a live writer's uncommitted intent is retryable after three seconds. A late writer cannot overwrite a newer commit.
Print/commit failures retain pending work, and compaction preserves recoverable intents and their events.
If acknowledgement is unavailable the watcher prints what it knows without acknowledging and exits, not loops.
Hook/watcher redelivery is harmless: receipt sequences and event IDs make acknowledgement idempotent.
On wake read outputs and handle finished workers first. Re-arm watch for asks/risk notes or workers lacking
verified live tracked start/turn followers; completion coverage itself does not deliver mid-turn risks.
`mine --owner <session-id>` prints pending deliveries and hub-confirmed running/unknown statuses without acknowledging.
An acknowledgement means delivered to context, not that the orchestrator read/integrated/accepted the result.

The Stop hook checks `stop_hook_active` before delivery or any block. It blocks at most once per stop cycle,
on up to ten pending events or to arm a missing watcher; a continuation leaves newly arrived/remaining events pending.
With no pending deliveries, Stop permits completion-only coverage when every running worker has a matching
registered background start/turn and live follower PID, and none has an open ask (even if that ask was already
acknowledged). Matching uses owner/account plus start name or turn thread, command kind and task PID when supplied;
completed entries and detached commands do not count. Missing registry data, unmatched launches or dead follower
PIDs keep the watcher block. The reason names each uncovered worker and every worker with an open ask.
Acknowledgement write failure or contention is silent and never falls through to a watcher block.
It shares the digest hook's orchestrator detection and delivers pending global-rule changes in the same block reason; successful output records the seen-version acknowledgement in `_shared/rules-seen.json`.
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
