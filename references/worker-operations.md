# Worker operations

Execution reference for workers and targeted orchestrator lookups. route.mjs, codex-worker.mjs,
outcome.mjs and heavy-build.sh do not implement `--help`; use this reference/targeted source headers,
and `res take-build --help` where supported. Keep planning/acceptance decisions
in [SKILL.md](../SKILL.md); do not load this file merely to repeat launcher output.

- [Identity, launch and follow](#identity-launch-and-follow)
- [Workspaces](#workspaces)
- [Lifecycle and recovery](#lifecycle-and-recovery)
- [Orchestrator models](#orchestrator-models)
- [Outcome corrections](#outcome-corrections)
- [Brief inputs and reports](#brief-inputs-and-reports)

## Identity, launch and follow

For irreversible external work, launch with `--no-auto-continue`; otherwise proven `transport-failed` turns receive one 60-second same-thread continuation, with `[transport-retry]` owner alerts and a manual command after a second failure (transport failures never advance the quality ladder).

Load deferred SendMessage/ListAgents when using Claude messaging; ListAgents names this session.
Prefix worker names with the project slug. `claude agents --json` lists live workers; `--all` includes
finished ones. Treat missing status fields defensively. Codex/TRAE use
`node <skill>/scripts/codex-worker.mjs --account <account> status`; [codex-workers.md](codex-workers.md#launch-resume-follow) documents start/turn/wait.

Run `node <skill>/scripts/route.mjs --table` for categories. The supported option lists are the short
BOOLEANS/VALUES declarations in `scripts/lib/pipeline/taskspec.mjs` (lines 6–11).
Pass project/name/cwd/task-dir/owner and task facts so the command is executable. Dry output is only
a preview; route again without `--dry` before launching. Preserve the printed `run-tracked.sh` wrapper.
Launch through a tracked background tool (`run_in_background`), never detach with inner `&`.

Claude commands use the trusted project root (`--trusted-cwd`, otherwise configured root), explicitly
name the working directory in the prompt, and include `--bg --remote-control --permission-mode
bypassPermissions`, plus the routed model/effort. Remote Control/Bypass are user decisions of
2026-11-13, independent of settings/defaultMode; `--mode` is compatibility-only. Do not construct a
replacement command that omits its audit or digest injection. Codex writers default full access;
reviewers stay read-only, test-generated files may use workspace-write, and explicit narrower sandboxes
remain available. See [Codex workers](codex-workers.md#permissions-and-environment).

The launcher injects fixed Worker Rules extracted from [global-rules.md](global-rules.md) and applicable
operational clauses, including one-shot developer instructions and resume turns. Copy only task-specific
notes into briefs. Lean output retains model/effort/account, why, actionable notes and gates;
`--verbose` exposes fixed diagnostics, and `--json` separates notes/fixedNotes. Follow-up turns inherit
saved launch context. [Rules enforcement](rules-enforcement.md) documents audit limits and provenance.

Subscribe to Claude idle notifications with `SendMessage(to=<worker>, message="", notify_when_idle=true)`;
renew while the task stays open. For Codex/TRAE, attach the printed start/turn/wait follower. Reconcile
after an orchestrator restart because its own background followers were lost. An armed owner-scoped
`codex-worker watch` covers untracked workers and pending asks/risk notes; re-arm after wakes and handle
finished workers first. Info/progress notes do not wake, risk/scope/ask do; default debounce is 45 s.
Use [worker inbox](worker-inbox.md) for identity, `mine`, reply and durable recovery.

A report opens with `## Summary` (<=20 lines); `report-summary.mjs <task dir>` prints <=3 KB. Delegate
full transcripts, multi-file evidence and long reports to a worker. The nightly `orch-usage.mjs`
measures own output, edits, tests/builds, browser/screenshots, polling and compactions. No foreground
sleep loops. A tracked exit watcher is notification, not an excuse to poll from the main session.

## Workspaces

Choose task base and git scope before launch. Create an isolated writer workspace with
`git -C <repo> worktree add -b <branch> <path> <base>`, usually under `.claude/worktrees/`; retain an
existing accepted repo convention. If needed, exclude `.claude/worktrees/` through local
`.git/info/exclude`, not tracked `.gitignore`. `claude --worktree` / EnterWorktree(name=...) branch from
the remote default, which can silently discard the selected task base.

Tell a worker given a prepared workspace: `Your workspace is <path>, already prepared. Never create
a worktree; if asked to isolate, call EnterWorktree(path="<path>"); if that fails, continue in place.`
No-repo workers skip it. Builds count as writers. Do not stash/reset user changes or stage other files.
A verified local project-owned merge uses `git merge --ff-only` in the target branch's checkout, after
the worker rebases and verifies the actual target tip. Safe merged-branch deletion uses `git branch -d`;
worktree removal needs retention authority and never `--force`. Reusable worktrees are kept.

Research uses separate small worker topics with short question lists and known official URLs.
The historical WebSearch budget was 200 calls/session shared with subagents, refilling ~100/hour;
workers never fan out subagents. Current provider limits come from tools, not that historical estimate.

## Lifecycle and recovery

Use `claude stop <id>` to stop a worker while preserving conversation. Resume from its trusted root,
state its workspace and changed facts, and retain the router's model/effort/audit/digest. Public
`claude agents --json --all` has sessionId; task-owned `jobs/<short id>/state.json` can recover an offline
worker's sessionId/cwd without reading credential stores. A changed-flags resume can create a copy:
address the live `name [ref]` from ListAgents and stop the stale duplicate. A message cannot change a
running model/effort. Stop an accidental replacement before resuming the eligible original and have
it reconcile any shared state the replacement touched. `claude rm` may delete its workspace: use only
after merge/abandonment and retention approval.

Same-task rework routes first and checks [thread eligibility](../SKILL.md#rework-thread-rule). Offline
context reuse never overrides actual floors, exclusions, capabilities, quota approvals or site denials.
Codex/TTADK/TRAE lifecycle and queued-turn recovery are in [codex-workers.md](codex-workers.md).
Never duplicate a live/unconfirmed turn or adopt another wrapper's hold. A disconnected device keeps
its holder's ownership while BLOCKED, within the <=2 h lease; replug/unlock/trust is reported precisely.

## Orchestrator models

Current rule (2026-11-16): every 主对话 uses the **`opus` alias** and routes strong reasoning to
Astra/Fable workers. Astra/Fable personal quota gates still apply. The rules owner manages persistent
`jobs/<id>/state.json` `respawnFlags`; a transient `/model` does not change the next respawn.

Historical assignments: VAK/routing used Fable, Webview/Lynx switched to Opus on 2026-11-11, and a
user check on/after 2026-11-17 09:00 PST was scheduled to consider restoring Fable. These assignments
and that proposed restoration are superseded by the 2026-11-16 all-Opus decision; retain the record,
not an automatic restoration. The 2026-11-10 request for the strongest main conversation expressed
whole-project judgment, now fulfilled by lean Opus coordination plus routed strong workers.

Claude settings are documented only (user, 2026-11-13):
`env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` prevents background-shell pressure reaping.
Idle-stop has no switch; pin or keep working. Do not mutate settings as part of that rule.

## Outcome corrections

Launch followers record outcomes, actual model evidence, queue-inclusive elapsed time and reviewer
yield automatically. Exit-0 proven completions give provisional pass; launcher/hub errors give infra
failure. Environment blockers record `result: blocked-environment`, `failureKind: infra`, no accepted
tuple and no added fix round, including exit-0 turns. Workers include exactly one standalone
`WORKER-RESULT: blocked-environment` line when a tool, access or resource precondition stops work;
put it before the final `REVIEW-RESULT` line for a review seat. An explicit `WORKER-RESULT: completed`
suppresses legacy inference. For older reports without a valid marker, inference requires a BLOCKED
or STOPPED status label and a concrete missing-tool/login/access/network/resource precondition in
the same paragraph. Bare BLOCKED, rejected work and narrative mentions do not qualify.
Other BLOCKED/FAILED/needs-user reports remain unresolved. A continued provisional pass adds rework;
reattachment does not duplicate a turn. Missing actual evidence or review marker is UNKNOWN.
Routing joins the terminal signal to its own launch/actual tuple, excludes these turns from the
quality-failure count and keeps their model/effort floor. Company environment retries stay on company
lanes and the same tier; only real quality failures may advance to a personal-only model, with the
quality reason stated in `why`. Explicit `--failure-kind` takes precedence over environment inference;
manual outcome metadata/corrections retain their existing precedence.
The launcher requests a final `REVIEW-RESULT: blocking` or `REVIEW-RESULT: none` line for review seats;
seat yield is separate from author outcome. See `scripts/lib/worker-outcome.mjs` for the state machine.

Use `node <skill>/scripts/outcome.mjs` only when judgment corrects automatic evidence; its source
header (lines 1–17) documents the CLI. Example:
`node <skill>/scripts/outcome.mjs --project <slug> --name <task> --correct --result rework --rounds 1 --cause code`.
Causes code/spec/process/infra/scope distinguish fixes, retries and changed requirements; retries and
scope-change counters remain separate. Use `--reviewed` for verified independent acceptance and
`--review-result blocking|none` only to correct a seat's yield. Repeat `--actual vendor:model:effort@account`
in launch order only when execution evidence is wrong. Manual fields override auto records, including
newer continuations; `--correct` overrides previous manual fields, omitted fields inherit. Keep log
lines intact. Acceptance checks can overturn an automatic pass; execution success is not release proof.

## Brief inputs and reports

Relevant memory inputs are task-selected, not the whole index: quote preferences, pitfalls and
user decisions the worker must not miss, then absolute paths with an explicit required-reading
order. A bare path list may be skipped by light workers. Reports include Durable lessons; retain
only supported facts under the applicable memory policy. Do not edit generated memory files.

A task keeps brief.md/report.md; report starts with <=20-line Summary: outcome, changes/commits,
verification, user decisions and risks. Final starts `[<id>] DONE | QUESTION | BLOCKED | FAILED`,
with concrete model/effort/account. --out is separate from requested deliverables. A QUESTION or
BLOCKED report is not an accepted result; resume eligible context with the resolved answer.

Company-account reminders include the historical TTADK SSO expiry 2026-11-21 19:37 PST and the
72-hour warning by 2026-11-18 19:37 PST unless renewed. Current state comes from authenticated
status tools, never auth files. Nightly owns TRAE login, Codex reset cards and Claude/Fable weekly
projections; no speculative credential reads or settings changes.
