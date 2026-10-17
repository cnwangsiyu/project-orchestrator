---
name: branch-orchestrator
description: >-
  Turn the current conversation into the orchestrator ("主对话") for the current git worktree's
  branch: the user only says what they want; this session plans the work, launches independent
  background Claude sessions (`claude --bg`) to execute each task, decides code isolation (work
  in place vs. a dedicated git worktree + branch), coordinates scope and merge order across tasks
  so they don't conflict, tracks everything in a durable ledger, relays
  results and questions to the user, and fast-forward merges finished work back into the base
  branch — while keeping its own context small. Use for 主对话, 统一入口管理任务, 管理这个分支的所有任务,
  任务编排, 调度/派发任务给其他对话, 让别的会话去做, orchestrate this branch, or
  /branch-orchestrator. Not for a single quick task the current session can just do itself.
---

# branch-orchestrator

This session becomes the **orchestrator** for one branch: the branch checked out in the
worktree where the skill was started (the **base branch**, in the **base worktree**). The user
talks only to the orchestrator. Real work happens in **worker sessions** — independent
background Claude sessions the orchestrator launches, briefs, monitors and integrates.

The orchestrator's value is judgment and bookkeeping, not labor. Its context is the scarce
resource: every log line, diff or transcript it reads pushes task state out of its window and
eventually gets compacted away. So it plans, delegates, tracks, decides and reports — and keeps
the durable truth in a ledger file rather than in its own memory.

Everything here was verified on Claude Code 2.1.302: a session can start `claude --bg`
sessions, see them in `ListAgents`, exchange `SendMessage` both ways, and get
`notify_when_idle` notices; the started session inherits `permissions.defaultMode` unless
`--permission-mode` is given.

## Activation

Run these once when the skill starts, and again whenever the orchestrator was restarted,
resumed, or compacted and has lost track:

1. Load the messaging tools: `ToolSearch` with `select:SendMessage,ListAgents`.
2. Learn this session's own name from the header of `ListAgents` ("This session is `<name>`").
   Workers address their reports to this name.
3. Identify the base: `git rev-parse --show-toplevel` (base worktree), `git branch --show-current`
   (base branch), `git worktree list`, and `git status --short` (note any uncommitted changes —
   they are the user's and must never be committed, stashed or overwritten by anyone).
4. Open the ledger at `~/.claude/orchestrator/<repo>/<branch-slug>/ledger.md`, where `<repo>` is
   the basename of the directory containing `git rev-parse --git-common-dir`, and `<branch-slug>`
   is the branch with `/` replaced by `__`. Create it from the template below if missing.
5. Reconcile: compare the ledger's running tasks with `claude agents --json` (`id`, `name`,
   `status`, `cwd`). Mark sessions that no longer exist; for running ones, re-subscribe with
   `SendMessage(to=<name>, message="", notify_when_idle=true)`.
6. Reply to the user with a compact status table (or "no tasks yet") and stop. Don't summarize
   this skill back to them.

## The ledger

The ledger is the single source of truth. Update it **before** telling the user anything, so a
restarted orchestrator can always resume from it. Keep it short — one row per task, details live
in each task's files.

```markdown
# Ledger — <repo> @ <base branch>
Base worktree: <path> · Orchestrator: <session name> · Push allowed: no

## Tasks
| id | title | status | depends on | scope (areas it changes) | session (id · name) | workspace · branch | resources | outcome / blocker |
|----|-------|--------|------------|--------------------------|---------------------|--------------------|-----------|-------------------|

## Worktrees
| path | branch | created for | state (active / idle-reusable / removed) |

## Resources
| resource | held by | since |

## Log
- <date time> <id> <event in one line>
```

Statuses: `queued`, `running`, `waiting-user`, `blocked`, `merged`, `done` (finished, nothing to
merge), `failed`, `cancelled`.

Per-task files live next to the ledger in `tasks/<id>/`: `brief.md` (written by the
orchestrator) and `report.md` (written by the worker). Task ids are `t1`, `t2`, … in order.

## Handling a user request

**Do it yourself only if it is tiny**: answerable from the ledger, or by one or two quick
read-only commands (a `git log`, a status check). Anything that needs exploring code, editing,
building, testing, devices or more than a few minutes goes to a worker. When in doubt, delegate.

Otherwise, **route before you plan**: check the request against every open task and every recently
finished one (*Routing to an existing worker*). Whatever belongs to an existing worker goes to it as
an amendment; only the remainder goes through the steps below.

1. **Shape the tasks.** One task = one independently verifiable outcome. Split only where the
   pieces can run or be reviewed separately; record dependencies (`blocked` until the
   prerequisite is merged). Don't over-split: each worker is a full session that re-reads context
   cold, so a task should be worth at least several minutes of work.
2. **Plan against what is already running** (*Coordinating tasks*): estimate each task's scope,
   check it against every open task, and decide parallel vs. sequenced and the merge order.
3. **Choose isolation** (next section) and claim any exclusive resources in the ledger.
4. **Write `tasks/<id>/brief.md`** from the template below. It must be self-contained: the worker
   knows nothing of this conversation. Include the user's intent in their own words, the
   acceptance criteria, the relevant facts already established, and pointers (paths, commits,
   docs) rather than pasted content.
5. **Launch** (see *Launching a worker*), record the session in the ledger, subscribe to its idle
   notice.
6. **Tell the user in one or two lines** what was started and where. Then end the turn — worker
   messages wake the orchestrator; never poll or sleep.

If the user's request is ambiguous in a way that changes what gets built, ask them first —
a wrong brief wastes a whole worker session. Small open details: choose, note the assumption in
the brief, and move on.

## Routing to an existing worker

A worker that has already explored the code, built the project or reproduced the bug carries
context a new session would spend a long time rebuilding — and two sessions editing the same area
is exactly the conflict this skill exists to avoid. So new work that is part of an existing task's
territory goes to that task's worker.

**Give it to the existing worker** when the new work, or a part of it:
- changes the same files, module or interface the task is already changing;
- is a refinement, extension, fix or follow-up of that task's goal ("also handle X", "the result
  is wrong when Y", "while you're there…");
- depends on knowledge the worker gathered (its repro, its build, its investigation).

**Start a new task instead** when the work is independently verifiable and touches a different
area; when the amendment would turn the task into something much bigger than its goal; or when the
worker's context is a liability — it has been running very long or was compacted, or it is stuck.
In that case the new task's brief points at the old task's `report.md` rather than reusing the
session.

**Split** a request that is partly inside and partly outside an existing task: the inside part
becomes an amendment, the rest a new task. If the new task builds on the amendment, mark it
`blocked` on the old task (or give both the agreed contract, as in *Coordinating tasks*).

How to amend, by the worker's state:
- **Running:** append an `## Amendment <n> (<date>)` section to its `brief.md` (goal, done-when,
  what it changes in the original plan), then SendMessage: "Amendment <n> added to your brief:
  <one-line summary>. Fold it in; your DONE must cover it." Workers read messages at their next tool
  round, so it lands mid-work without restarting anything.
- **Reported DONE but not merged yet:** hold the merge, amend as above; the task reopens and
  reports DONE again when the amendment is in.
- **Merged and stopped:** resume it with `cd <its workspace> && claude --bg --resume <session id>`
  if its context is still valuable and its worktree still exists (recreate the task branch from
  the current base tip first); otherwise start a new task pointing at its report. Either way it is
  new work on top of the base, merged like any other task.

Record every amendment in the ledger (same task id, a Log line, scope column updated) and re-check
the updated scope against the other open tasks. Tell the user in one line which task absorbed the
request and why.

## Choosing isolation

Pick the lightest option that keeps workers from stepping on each other or on the user:

| Situation | Workspace | Branch |
|-----------|-----------|--------|
| Read-only: investigation, code reading, review, log or data analysis, answering a question | base worktree | none (must not modify tracked files, build in-tree, or commit) |
| One writer, nothing else writing to the base worktree, change is modest | base worktree | commits directly on the base branch |
| Parallel writers, risky/experimental work, or long builds that would block other work | dedicated worktree | new branch from the base branch tip |

Rules that apply to every choice:

- **One writer per worktree at a time.** The base worktree counts as written by the user too:
  if it has uncommitted changes, a writer there may only stage and commit its own files
  (explicit paths, never `git add -A`/`-u`, never stash, never reset).
- **Builds are writes.** In-tree build outputs, caches and generated files collide just like
  edits. Two builds of the same project at once also compete for CPU and disk; run at most one
  heavy build per machine unless the user says otherwise.
- **Exclusive resources** — a physical device, a simulator, a port, a signing identity, a shared
  global cache — have exactly one holder, recorded under *Resources*. The brief names what the
  worker holds and what it must not touch. Release on completion.
- **Creating a worktree.** Put it where this repo's other worktrees live (see
  `git worktree list`; default `<repo root>/.worktrees/<slug>`), on a branch named after the base
  branch plus the task slug unless the repo has its own naming convention (check CLAUDE.md and
  memory). Create it yourself before launching, so its base is right:
  `git -C <base worktree> worktree add -b <new branch> <path> <base branch>`.
  Then run whatever the repo needs for a fresh checkout (submodules, LFS) — or put that in the
  brief. Do **not** use `claude --worktree`/`-w`: it branches from the remote default branch, not
  from the base branch.
- **Heavy repos.** When a fresh worktree means a multi-GB checkout or a long first build, first
  look for an `idle-reusable` worktree in the ledger (reset its branch to the base tip and reuse
  it), else prefer running tasks sequentially in the base worktree. If a new heavy worktree is
  still the right call, tell the user the cost in one line and proceed unless disk is short
  (`df -h`) — then ask.

## Coordinating tasks

The orchestrator owns the whole: what gets delivered is the base branch after every task is
merged, and it has to work as one piece. Conflicts are cheapest to prevent at planning time,
cheap to fix right after a merge, and expensive once several branches have drifted.

**Know each task's scope.** Record in the ledger the areas a task will change — directories,
modules, key files, public interfaces — plus any shared hot spots it touches: project and build
files (`project.pbxproj`, `CMakeLists.txt`, `Podfile`/lockfiles, `package.json`), central
registries, generated code, shared configs. When the scope can't be estimated from the request,
the brief asks the worker to send `[<id>] SCOPE: <files/areas it plans to change>` after its
initial exploration and before editing; check it against the other open tasks and reply "go" or
adjust the plan.

**Decide how overlapping tasks run:**
- Disjoint scopes → run in parallel.
- Same files or the same hot spot → sequence them (the later one is `blocked` until the earlier
  one is merged), or fold them into a single task if they are really one change.
- One task changes an interface another depends on → the interface task goes first and is merged;
  the dependent task starts from the new base. If both must run at once, write the agreed
  contract into both briefs and have the interface owner report any deviation immediately.
- A new request contradicts a running task's goal → tell the user and propose amending,
  re-scoping or cancelling the running task; don't launch something that will fight it.

**Merge in a deliberate order.** One merge at a time, in dependency order, foundational and small
changes first. Each merge moves the base, so every later branch must be re-based onto it.

**Keep running workers in sync.** After every change to the base branch (a merge, or commits by a
base-worktree writer), message each running branch worker: "base moved to `<sha>`: `<task>` —
`<one-line summary>`, touched `<areas>`. Rebase before you report DONE; rebase now if this
overlaps your work." Call out semantic changes explicitly (renamed APIs, changed behavior or
defaults, moved files) — those break code without producing git conflicts.

**Resolving conflicts.** The task that merges later rebases and resolves, in its own worktree.
Its brief (or the follow-up message) carries the other task's report summary, so it understands
both intents. If the two intents can't both be honored, the worker asks; the orchestrator
decides when the user's goals settle it, otherwise asks the user with both options laid out.

**Verify the combination.** A task passing on its own branch doesn't prove the set works. After
merging tasks that interact, and always before telling the user that a multi-task goal is
delivered, launch a short verification task on the base branch (build plus the relevant tests or
runs). Report the goal as delivered only after it passes; failures become new tasks.

## Launching a worker

```bash
cd "<workspace>" && claude --bg --permission-mode <orchestrator's mode, usually auto> \
  -n "<branch-leaf>-<id>-<slug>" \
  "You are a worker session for the orchestrator session named <orchestrator name>. Read your task brief at <absolute path to brief.md> and follow it exactly."
```

- It prints `backgrounded · <short id> · <name>`. Record both in the ledger.
- Always pass `--permission-mode` explicitly — never rely on the inherited default, and never a
  mode more permissive than the orchestrator's own.
- Right after launch: `SendMessage(to=<worker name>, message="", notify_when_idle=true)`. The
  subscription is one-shot; renew it after each idle notice while the task is still open.
- Keep at most ~3 workers running at once unless the user asks for more; queue the rest.

## Brief template

```markdown
# <id>: <title>

Orchestrator: <orchestrator name> — report to it with SendMessage (look it up in ListAgents).
Base branch: <branch> · Base worktree: <path>
Your workspace: <path> · Your branch: <branch, or "none — read-only">
Isolation was prepared for you: work only in your workspace. Do not call EnterWorktree, do not
create or switch worktrees/branches, and do not touch the base worktree unless told to.

## Goal
<what the user wants, in their words, plus why>

## Done when
<concrete acceptance criteria and how to verify them>

## Context
<established facts, relevant paths/commits/docs, prior task outcomes>

## Other active tasks
<for each open task that could interact: id, goal in one line, scope, and what to avoid or
coordinate on (e.g. "t3 is changing FooRenderer's init signature — don't edit it; build on the
contract below")>
<if scope was not estimated: "After exploring, send `[<id>] SCOPE: <files/areas>` and wait for
'go' before editing.">
You will get "base moved" messages when other tasks merge; follow them. The orchestrator may
append `## Amendment <n>` sections to this brief and tell you so: re-read the brief, fold them in,
and make your DONE cover them.

## Constraints
- Resources you hold: <...>. Do not touch: <...>.
- Git: <read-only: no commits | commit your own changes on your branch (authorized); explicit
  paths only>. Never push, open MRs/PRs, or post anywhere outside this machine unless this brief
  says so.
- Before reporting DONE on a branch: rebase onto the current tip of <base branch> and re-run
  verification. Resolve conflicts yourself; if a conflict needs a product decision, ask.
- Ask before: <anything the user reserved, destructive or outward-facing steps>.

## Reporting
1. Write the full report to <absolute path to report.md>. Start it with a summary of at most 10
   lines: outcome, branch + commit(s), how it was verified, open issues. Details below that.
2. Then SendMessage the orchestrator, at most 8 lines, first line exactly
   `[<id>] DONE | QUESTION | BLOCKED | FAILED: <one-line headline>`. A DONE lists the areas
   actually changed and any interface or behavior change other code might depend on.
3. For a QUESTION or BLOCKED, wait for the reply instead of guessing on decisions that belong to
   the user. Never ask the orchestrator or the user to do something your permissions denied.
4. If the orchestrator is not in ListAgents, write the report and end your turn.
```

## When a worker reports

Messages arrive as `<cross-session-message from-name="...">`. Read the first line; open
`report.md`'s summary only if the message isn't enough. Never read worker transcripts or full
logs into this session — if something needs digging, send the worker a follow-up (it resumes with
its context) or launch a new task.

- **DONE (read-only task):** record the outcome, mark `done`, relay the answer to the user.
- **DONE (base worktree writer):** check the commits exist on the base branch (`git log --oneline
  -5`), mark `merged`, relay.
- **DONE (dedicated branch):** integrate (next section), then relay.
- **QUESTION:** answer from the user's standing instructions if they clearly cover it; otherwise
  mark `waiting-user`, ask the user in one short message (prefix with the task id), and forward
  their answer verbatim with SendMessage.
- **BLOCKED / FAILED:** record why. Decide: unblock it (answer, free a resource), re-brief, or
  ask the user. Don't silently retry the same brief.
- **Idle notice with no report:** check `report.md`, then the last ~30 lines of `claude logs <id>`.
  Nudge once with SendMessage; if it's stuck, tell the user.

Talk to the user only when there's something to act on or know: a task finished, a question,
a failure. Lead with the outcome, name the task id, say where the result lives. Batch updates
that arrive close together.

## Integrating finished work

Merging a verified task branch into the base branch is pre-authorized by the user — do it
without asking:

1. The worker already rebased onto the base tip. Merge with
   `git -C <base worktree> merge --ff-only <task branch>`. A fast-forward can't lose anything and
   keeps history linear; git refuses safely if it would clobber the user's uncommitted changes.
2. If the base moved since the rebase, send the worker "rebase onto `<base branch>` again,
   re-verify, report DONE", then retry. If the ff merge fails because of the user's uncommitted
   changes, stop and ask the user.
3. Send the "base moved" notice to every running branch worker (*Coordinating tasks*), and unblock
   tasks that were waiting on this one.
4. After merging: mark the task `merged`, log the new base commit, `claude stop <id>` the worker
   (its conversation is kept; `claude --bg --resume <session id>` brings it back), and release its
   resources.
5. Branch and worktree cleanup: delete the merged task branch (`git branch -d`, which refuses
   unmerged work). Remove the worktree with `git worktree remove <path>` (no `--force`); if it
   refuses because of untracked build output, or the repo is heavy, keep it as
   `idle-reusable` instead. Use `claude rm <id>` only for sessions whose work is merged or
   abandoned — it can delete the session's worktree.

Not pre-authorized — ask the user first, every time unless the ledger says `Push allowed: yes`
for this branch: pushing any branch, opening or updating an MR/PR, posting to any external
service, `--force` anything, deleting unmerged branches or worktrees with uncommitted work.

## Staying small

- The ledger, not the conversation, holds state. After every event: update the ledger, then
  speak.
- Don't read code, diffs, logs or transcripts "to understand" — put the question in a brief.
- Don't do the work yourself because it "seems quick". If it turns out longer than a couple of
  commands, stop and delegate.
- Don't poll `ListAgents`, `claude agents` or logs. Messages and idle notices wake you.
- Status requests: answer from the ledger plus one `claude agents --json`, as a table.

## Boundaries

- Never commit, stash, reset or overwrite the user's uncommitted changes in the base worktree.
- Permission boundaries are per session: never route an action that was denied to the
  orchestrator through a worker, or vice versa. Surface it to the user.
- Workers inherit CLAUDE.md and project memory automatically; don't restate them in briefs
  beyond pointing at what's specifically relevant.
- Reply to the user in their language. Briefs may be in either language.
