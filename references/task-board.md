# Task Board And Shared User Queue

Current task status has one source of truth: `~/.claude/orchestrator/<project>/board.json`.
The secretary reads `scripts/status.mjs` rather than polling orchestrators or copying their tasks.
`ledger.md` retains the resource map, history and decisions, not current status. The secretary's
own ledger contains only its unique items, never copies of project tasks or the shared user queue.

## Ownership And Storage

- Tools write `auto`: worker identity, activity, progress and results. No model turn is needed.
- The orchestrator writes title, next action, blocker, dependencies, deadline, note and state judgement.
- The secretary writes queue card/answer/close events; answers preserve the user's words verbatim.
- The board is passive. Existing worker watchers/inboxes and wake rules are unchanged.

Set `ORCH_ROOT` to replace `~/.claude/orchestrator`; shared storage defaults to `<root>/_shared`.
Existing `RULES_SHARED` overrides are honored. With a standalone scratch `RULES_SHARED` directory,
boards are isolated in its `projects/` child; when it ends in `_shared`, boards use its parent.
Tests must set scratch paths and never use real hubs or live orchestrator/secretary data.

Board writes use a directory lock plus a same-directory temporary file, fsync and rename.
Queue and archive logs are logically append-only JSONL: locked atomic replacement preserves the
entire prior log plus new events, so concurrent readers cannot see a partial append. Unknown
board schema versions and malformed boards fail without overwriting data.

## Board Schema (Version 1)

```json
{
  "schemaVersion": 1,
  "project": "example",
  "updatedAt": "2026-11-16T20:00:00.000Z",
  "tasks": [{
    "id": "T1", "title": "Build feature", "state": "running",
    "next": "Inspect result", "blocker": "", "deps": [], "deadline": null, "note": "",
    "orchestratorUpdatedAt": null, "stateUpdatedAt": "2026-11-16T20:00:00.000Z",
    "stateSource": "worker", "updatedAt": "2026-11-16T20:00:00.000Z",
    "auto": { "updatedAt": "2026-11-16T20:00:00.000Z", "workers": [{
      "name": "feature-worker", "thread": "thread-id", "account": "ttadk",
      "model": "gpt-6.1-sol", "effort": "high", "state": "running",
      "startedAt": "2026-11-16T20:00:00.000Z", "lastActivityAt": "2026-11-16T20:00:00.000Z",
      "currentStep": "running: npm test", "lastProgress": "", "eta": null,
      "tokens": null, "result": null, "finishedAt": null
    }] }
  }]
}
```

States: `queued|running|blocked|waiting-user|review|done|parked|cancelled`. Worker state is its
last lifecycle fact, not the orchestrator's judgement. Internal `runId`, `eventAt`, `updatedAt`
and `_rollout`/`_session`/`_result` cache fields retain merge identity, event precedence and mtime/size caches.
Manual `links` hold `{thread, account?}`. All times except internal event milliseconds are ISO.

Project defaults: explicit `--project`, then `ORCHESTRATOR_PROJECT`, then the project of the
owner's latest saved worker launch (`ORCHESTRATOR_OWNER`/`CODEX_WORKER_OWNER`). If none resolves,
pass a project; the CLI does not guess another owner's project.

```sh
node scripts/board.mjs set T1 --project example --title "Build feature" --state queued --next "Dispatch" --deps T0 --deadline 2026-11-18T20:00:00Z
node scripts/board.mjs show --project example --task T1 --json
node scripts/board.mjs link T1 --project example --thread thread-id
node scripts/board.mjs refresh --project example --thread thread-id
node scripts/board.mjs set T1 --project example --state done
node scripts/board.mjs archive --project example --done-older-than 7
```

`set` never replaces auto fields. Omitting a field preserves it; `--deps ""` clears dependencies.
`archive` moves sufficiently old done rows into `board-archive.jsonl`; old worker events cannot
resurrect them. A new launch/event after archival, or an explicit `set`, can reopen the task.

## Automatic Worker Facts

Use `codex-worker start/turn --task T1`; the task is saved in public launch metadata and inherited
on continuation. `route.mjs --task T1` passes it to the worker. Without `--task`, the exact launch
name is the task id. A worker start creates an unknown row with title=name and state=running.
Manual links override inferred names.

Every event written by `codex-worker` requests a bounded, non-blocking refresh child, including
start/turn, notes, asks and terminal events. Refresh failure never fails the worker. `show` and
`status` see all latest facts even when refresh requests are coalesced for 500 ms off the setup
critical path; terminal events and command exit flush pending requests immediately. Rerouted
workers are inactive; a detached follower is UNKNOWN until new evidence arrives. `show` and
`status` refresh first; rollout parsing reads at most 128 KiB and skips unchanged mtime/size.
`currentStep` is a single line of at most 120 characters; password/token/secret/key/credential
values are masked. Progress is the latest info/progress note. Final results use the worker's
separate `--out`/`codex-last.md` summary, commit hash and pass/fail counts, when present.

A newer running event moves the row to running, finished to review, failed/stalled to blocked
with a worker blocker. A newer orchestrator state wins, including blocked/waiting-user; editing
only `next` or `note` does not suppress later lifecycle transitions. Done is an orchestrator
acceptance decision, never inferred from a completed worker. Local PID/activity observations
use `running-workers.mjs`; passive reads never contact hubs, and missing evidence is UNKNOWN.

## Shared User Queue

```sh
node scripts/user-queue.mjs add --project example --task T1 --raised-by OWNER_SESSION_ID --question "Which target?" --option A --option B --recommended A --default "Stay queued" --deadline 2026-11-18T20:00:00Z
node scripts/user-queue.mjs list --open --project example --json
node scripts/user-queue.mjs card QUESTION_ID
node scripts/user-queue.mjs answer QUESTION_ID --choice "The user's exact answer" --note "Optional context"
node scripts/user-queue.mjs close QUESTION_ID
```

`_shared/user-queue.jsonl` folds add/card/answer/ack/close events by id. Open means neither closed
nor acknowledged; an answered item remains visible until its owner receives it. `--all` includes
history. Answers cannot replace an existing answer; choices may be free text, not just an option.
Add with `--task` moves that task to waiting-user and remembers its prior state. Multiple open
items keep the task waiting until all are resolved. Close also releases a linked wait.
Queue-owned waits remain waiting-user while tools update auto fields; later worker events cannot
silently release an unanswered decision. An explicit orchestrator state judgement still wins.

The existing `worker-inbox-hook.mjs` Stop/SessionStart path delivers answered, unacknowledged
items to `raisedBy`, or to the project owner if no owner was supplied. Only recognized
orchestrator sessions receive them; the Stop-cycle guard still applies. Successful output is
followed by acknowledgement and restoration of linked task state using the latest worker facts
or its prior state. Lock contention leaves delivery pending; no extra daemon is installed.

## Status And Migration

`node scripts/status.mjs [--project example] [--json]` renders one page per project: refreshed
tasks, local live/UNKNOWN workers, open queue items, project resource holds from bounded
`res status`, and mismatches. It flags running without a live worker for >30 minutes, unlinked
live workers, review older than 24 hours, waiting-user without an open item and overdue deadlines.
Unavailable resource observations are UNKNOWN, not free.

Once after installation, each orchestrator imports its current tasks with `board set`, links
existing worker threads, and moves outstanding user decisions into the queue. Remove those
current-status sections from the ledger, retaining historical decisions and resource maps.
The secretary removes copied project tasks and user-wait lists from its ledger, records existing
cards in the shared queue, and reads `status`/`user-queue list` thereafter. Do not auto-import old
prose or duplicate cards: the owners reconcile each outstanding decision once.
