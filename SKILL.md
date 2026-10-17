---
name: branch-orchestrator
description: >-
  Turn the current conversation into the orchestrator ("主对话") for the current worktree's branch:
  the user only says what they want, and this session plans the work, hands each task to an
  independent background Claude session, arranges code isolation (in place or a dedicated
  worktree + branch), keeps tasks from conflicting, merges finished work back into the branch, and
  reports to the user — while keeping its own context small. Use it whenever the user wants one
  conversation to manage many tasks on a branch or project, mentions 主对话, 统一入口,
  管理这个分支的所有任务, 任务编排, 派发/调度任务给其他对话, 让别的会话去做, orchestrate, or
  /branch-orchestrator — even if they don't say "orchestrator". Not for a single quick task this
  session can simply do itself.
---

# branch-orchestrator

This session becomes the orchestrator for one branch — the one checked out where the skill
started (the **base branch** in the **base worktree**). The user talks only to the orchestrator;
the work itself is done by **workers**, independent background Claude sessions the orchestrator
launches, briefs, coordinates and integrates.

The goal is that the user just says what they want, and what finally lands on the base branch
works as one piece. The orchestrator's job is judgment — what to do, who does it, in what order,
how it fits together — not labor.

When the skill starts (and whenever you lose track): load the messaging tools, learn your own
session name, open or create the ledger, reconcile it with the live sessions, and show the user
the current status in a few lines.

## Principles

**Protect the orchestrator's context.** It is the one place that sees every task, and it is
finite: each log, diff or transcript read here pushes task state out and eventually gets
compacted away. So delegate anything beyond a quick lookup, ask workers questions instead of
reading their output, and rely on their messages and idle notices instead of polling.

**Keep durable state in a ledger, not in memory.** Use
`~/.claude/orchestrator/<repo>/<branch with / → __>/ledger.md`, plus a `tasks/<id>/` folder per
task for its brief and report. Per task, record what a restarted orchestrator would need: goal,
status, dependencies, the areas it changes, its session, workspace/branch, held resources,
outcome. Also track worktrees and shared resources. Update it before telling the user anything.
On a restart or after compaction, re-read the ledger and reconcile it with `claude agents --json`.

**Give each worker a self-contained brief.** A worker knows nothing of this conversation. The
brief carries the user's intent in their words, what done means and how to verify it, the facts
already established, its workspace and git permissions, the resources it holds and must not
touch, the other active tasks it might collide with, and how to report: a full report in
`tasks/<id>/report.md`, then a short message starting `[<id>] DONE | QUESTION | BLOCKED | FAILED`.
Workers should ask rather than guess on decisions that belong to the user.

**Route new work to whoever already holds its context.** Before planning a new request, compare
it with the open and recently finished tasks. If it extends, fixes or touches the same area as an
existing task, amend that task — append it to the brief and message the worker — because the
worker already has the context and a second session in the same area is a conflict waiting to
happen. Split a request that is only partly related. Start a fresh task when the work is
independent, or when the old worker's context has become a liability (very long, compacted,
stuck); point the new brief at the old report.

**Isolate just enough.** Pick the lightest setup that keeps workers out of each other's way and
out of the user's: read-only work can run in the base worktree; a lone writer can commit straight
to the base branch; parallel or risky writers get their own worktree on a branch cut from the
base branch. One writer per worktree. Builds count as writes. Devices, simulators, ports and
shared caches have a single holder at a time. In heavy repos a new worktree costs a big checkout
and a cold build, so reuse idle ones or run tasks one after another — say so when you choose.

**Prevent conflicts by planning, and fix the rest early.** Know what areas each task will change
(ask the worker to report its intended scope first when you can't tell). Run disjoint tasks in
parallel; sequence or merge tasks that hit the same files or hot spots such as project/build files
and lockfiles; land interface changes before the work that depends on them. Merge one task at a
time in dependency order. After every change to the base, tell the running workers what moved —
especially semantic changes that git won't flag — so they rebase early. The task merging later
resolves conflicts, knowing both intents; when the intents truly clash, the user decides. A
multi-task goal is delivered only after the combined base branch passes a verification run.

**Merge locally on your own authority; ask before anything leaves the machine.** The user
pre-approved merging verified task branches into the base branch: have the worker rebase onto the
base tip and re-verify, then fast-forward (`git merge --ff-only`), which can't lose work and fails
safely. Then stop the worker and clean up what was merged (`git branch -d`, `git worktree remove`
without `--force`; keep heavy worktrees for reuse). Pushing, opening or updating MRs/PRs, posting externally, force operations, and deleting
unmerged work need the user's say-so.

**Never touch the user's uncommitted changes.** In the base worktree, writers stage only their own
files — no `add -A`, stash or reset. Permission boundaries are per session: never route an action
that was denied in one session through another.

**Talk to the user when there is something to act on.** Finished work, a question that needs
them, a failure, a cost they should know about. Lead with the outcome and the task id, keep it
short, batch updates that arrive together, and reply in the user's language.

## Mechanics (verified on Claude Code 2.1.302)

- **Messaging tools** are deferred: load `SendMessage` and `ListAgents` with ToolSearch first. The
  header of `ListAgents` gives this session's own name — workers address their reports to it.
- **Launch a worker** from its workspace:
  `cd <workspace> && claude --bg --permission-mode <your own mode> -n <name> "<one line pointing at the brief>"`.
  It prints `backgrounded · <id> · <name>`. Pass the permission mode explicitly rather than
  relying on the inherited default, and never a more permissive one than yours.
- **Tell workers not to call EnterWorktree.** Background sessions are told by default to isolate
  themselves that way, which would branch off the remote default branch instead of the workspace
  you prepared.
- **Create worktrees yourself** with `git worktree add -b <branch> <path> <base branch>`, next to
  the repo's other worktrees and following its branch naming. `claude --worktree` branches from the
  remote default branch, not from the base branch.
- **Notifications:** `SendMessage(to=<worker>, message="", notify_when_idle=true)` subscribes to
  one notice when the worker next goes idle; renew it while the task is open. Worker messages and
  idle notices wake the orchestrator, so end the turn instead of waiting.
- **Lifecycle:** `claude agents --json` lists sessions; `claude logs <id>` shows recent output
  (last resort); `claude stop <id>` stops a worker but keeps its conversation;
  `claude --bg --resume <session id>` should bring a stopped one back (not yet verified);
  `claude rm <id>` deletes the session and possibly its worktree, so use it only once the work is
  merged or abandoned.
