# Codex CLI as a worker

Use this whenever `scripts/route.mjs` puts a task on Codex — mostly coding (implementation, build/test/deploy and debugging runs, code review), plus bulk extraction, quick lookups, drafts and image generation. The router also prints the exact launch command, with the account, model, effort and sandbox filled in. Codex runs on the user's ChatGPT plans, not on Claude credit.

**Which launcher:** use `scripts/codex-worker.mjs` through the hub (below) by default, since only it can steer, interrupt and re-attach. Use plain `codex exec` for short one-shot runs that will never need steering (the router's `exec` rows: lookups, extraction, drafts, image generation and the `second-opinion` row; the paired second opinions of `review-high` and `design` run as hub workers). Verified 2026-10-30 on codex-cli 0.166.0. The model catalog changes, so re-check it with `codex debug models` before relying on the ids below.

## Launch, resume, follow

- **Launch** from the worker's workspace as a harness background task (Bash with `run_in_background`):
  `CODEX_HOME=<account home> codex exec -C <workspace> -s <sandbox> -m <model> -c model_reasoning_effort='"<effort>"' --json -o <task dir>/codex-last.md "<one line pointing at the brief>" < /dev/null > <task dir>/codex.jsonl 2>&1`
  - `CODEX_HOME` picks the account (see Several Codex accounts); without it the run spends `main`.
  - Never launch it with a trailing `&` inside a normal Bash call. That run gives no exit notification, so a failure goes unnoticed. In one case a usage-limit stop sat unseen until the user asked.
  - Always redirect stdin from `/dev/null`. Otherwise Codex waits on "Reading additional input from stdin".
  - Outside a git repo, add `--skip-git-repo-check` (to `exec` and `exec resume`).
  - The session id is the `thread_id` in the first JSONL events. Record it in the ledger next to the cwd and brief, because Codex sessions don't appear in `claude agents` or `ListAgents`.
- **Resume** the same worker for its next task, so its context survives:
  `CODEX_HOME=<same account home> codex exec resume [--skip-git-repo-check] <session uuid> [-m <model>] -c model_reasoning_effort='"<effort>"' --json -o <file> "<what changed + new task>" < /dev/null`
  - Run it from the original workspace, also as a background task.
  - A worker can only be resumed after its current run has ended.
  - `-m` switches the model for the resumed run, for example to escalate.
  - Threads live in their account's home: resume with the same `CODEX_HOME`. (A re-login inside one home keeps its threads.)
- **Follow**: the background task's exit is the completion signal. The final answer is in the `-o` file. Check how the run ended in the JSONL: the last `turn.completed`, or a `turn.failed` with its error.
  - On a usage limit, the run ends with `turn.failed` and "You've hit your usage limit".
  - Run `quota.mjs --fresh`: it says whether another account, a reset card or a wait is next. Resume once it's sorted.
  - First verify any write whose result is unknown, before redoing it.
- **Queue a message for a worker:** `codex queue --thread <session uuid> --message "<text>"` (codex-cli 0.166). Tested 2026-10-30 with `codex exec`: a message queued while the run is going is NOT seen by that run. It is delivered at the next `codex exec resume` of the thread. So it works as a mailbox (peers or the orchestrator can leave instructions anytime), not live steering. `--resume` tries to resume the thread on the local app-server daemon. Live mid-run delivery for daemon-hosted sessions is unverified. To change course now, stop the run and resume.
- **A run that was already started without notification:** start a background watcher. It waits on the PID (`while kill -0 <pid>; do sleep 20; done`), then prints the last `turn.completed`/`turn.failed` line.
- **No Codex Claude Code plugin** (removed 2026-10-30 at the user's request): use `codex exec` or `scripts/codex-worker.mjs` (below). Add any missing capability (e.g. a review mode) to codex-worker, not via the plugin. Never use the model alias `spark`, which maps to a retired model.

## Live steering: codex-worker + an app-server hub (verified 2026-10-30, codex-cli 0.166)

`codex exec` can't be steered mid-run, but the app-server protocol can: `turn/steer` injects a message into the running turn (taken
into account in that same turn), and `turn/interrupt` stops it. `scripts/codex-worker.mjs` wraps this. Every command connects to its account's
hub over WebSocket (`--account <name>`, default `main`), so the process that started a worker and the one that steers it can differ.

- **Hub**, one per account, localhost only, reused by every orchestrator. `codex-worker.mjs --account <name> hub` checks it and, if it's down,
  starts it detached (log in `<account home>/hub.log`) so it outlives your session. Running workers die if the hub dies. `CODEX_HUB` overrides the URL. The hub has no
  authentication: any local process can start or steer a thread on it, so keep it on 127.0.0.1 and only on a machine you trust. (The managed daemon's unix socket speaks WebSocket too; Node's
  WebSocket can't dial a unix socket, hence the TCP hub.)
- **After a re-login or plan change, restart that account's hub.** (To use another account, add it as a profile — see Several Codex accounts — rather than re-logging the main home.) It keeps the login it started with, so once `<account home>/auth.json`
  changes, hub calls fail with `401 ... token_expired` (seen 2026-10-30 after the upgrade to Pro). Restart it only while no
  worker runs on it — `codex-worker.mjs --account <name> list` shows every thread `notLoaded` — by stopping that account's
  `codex app-server --listen <its hub>` process and running `codex-worker.mjs --account <name> hub`; `quota.mjs` flags a hub whose login changed; otherwise tell the other orchestrators first. `codex exec` runs read the
  login fresh and aren't affected.
- **Start** a worker as a harness background task (its exit is the completion signal; it exits 0 on completed, 1 on
  failed/interrupted):
  `node ~/.agents/skills/project-orchestrator/scripts/codex-worker.mjs --account <name> start --cwd <workspace> --model <id> --effort <e> --sandbox <s> --name <worker> --log <task dir>/codex.jsonl --out <task dir>/codex-last.md "<one line pointing at the brief>"`
  `--effort` and `--sandbox` are required. Its first stdout line is `thread=<id> turn=<id>`. Record the thread in the ledger.
  On exit it prints `turn <status>`, the thread's token usage and `final: <first line of the final message>` — so the
  completion notice already carries the worker's `[<id>] DONE | QUESTION | …` line — and writes the whole final message to `--out`.
- **Stall alarm** (verified 2026-11-04). `start`, `turn` and `wait` exit with code **4** and print `stalled: …` when the
  turn has had no events of its own for `--stall-min` minutes (default 30; `0` turns it off).
  - The turn keeps running on the hub; the alarm only wakes you.
  - A running shell command still produces events, but a worker waiting on its own sub-agents can be quiet that long.
    So first check `status` and the worker's child threads (`parent_thread_id` under `<account home>/sessions/`).
  - Then re-attach with `wait` as a background task, or steer or interrupt the turn.
  - It exists because a worker once sat silent for 18h with nobody noticing (video-agent W222).
- **Re-attach** after the orchestrator restarted (its background tasks, including the `start`/`turn` follower, are gone, but
  the turn keeps running on the hub): `codex-worker.mjs --account <name> wait --thread <id> --log <file> --out <file>`, again as a background
  task. It exits like `start` when the turn ends, or at once if it already has. Several clients can follow one turn.
- **Find** a thread whose id the ledger lost: `codex-worker.mjs --account <name> list [--cwd <workspace>] [--search <name>]` (hub and `codex exec`
  threads, newest first: id, updated, status, source, name, cwd).
- **Steer** the running turn: `codex-worker.mjs --account <name> steer --thread <id> "<message>"`. This is the messaging channel: relay peer requests,
  device handoffs and plan changes this way.
- **Interrupt**: `codex-worker.mjs --account <name> interrupt --thread <id>`. **New task** on the same thread: `codex-worker.mjs --account <name> turn --thread <id>
  --effort <e> --log <file> --out <file> [--model <id>] [--sandbox <s>] "<what changed + new task>"` (also as a background
  task); `--model`, `--effort` and `--sandbox` change it for this and later turns, e.g. read-only research, then a write task.
  **Status**: `codex-worker.mjs --account <name> status --thread <id>`.
- The log is app-server notifications: agent text is `item/completed` with `item.type == "agentMessage"`; the end is
  `turn/completed` with `turn.status`.
- Workers started this way use `approvalPolicy: never`, so the sandbox is their only bound; choose it by the rule under
  Permissions below. Nobody answers at the hub: codex-worker refuses every server request validly, and if a worker asks
  the user a question it is told to end the turn with a `QUESTION` final message (in tests, hub workers had no
  question tool at all).

## Several Codex accounts and reset cards (user, 2026-11-03)

**Accounts run side by side; nobody switches logins.** Each account is a profile in
`~/.claude/orchestrator/_shared/codex-accounts.json` with its own `CODEX_HOME` (so its own login) and its own hub port.
`main` is `~/.codex` on port 47321.

- **Add an account:** run `codex-worker.mjs account-add <name>`. It creates `~/.codex-<name>`, symlinks the main home's
  `config.toml`, `AGENTS.md`, `skills` and `rules` into it, and assigns the next hub port. The user then logs it in once
  with `! CODEX_HOME=~/.codex-<name> codex login`. After that, start its hub with
  `codex-worker.mjs --account <name> hub`. `codex-worker.mjs accounts` lists the profiles.
- **Name the account on every command.** `--account <name>` works with every codex-worker command (start, turn, wait,
  steer, interrupt, status, list, hub, usage, reset-credit-use). For `codex exec`, prefix `CODEX_HOME=<home>`.
- **Threads belong to their account.** Resume, steer and wait on the same account that started the thread. Record the
  account in the ledger next to the thread id. Memories and session history are per home; the shared `AGENTS.md`
  bridge still applies to every account.
- **Pick the account with `quota.mjs`.** It reads every account live through its hub. If a hub is down, it projects
  that account from its last reading and says so.
  - Its `lean` names the account for new Codex work: the one whose unused quota is lost first (its reset, or an
    earlier expiring card).
  - It flags a login whose hub still runs the old account. Restart that hub once no thread runs on it.

**Reset cards ("rate-limit reset credits").** `codex-worker.mjs [--account <name>] reset-credits` lists an account's
cards with their expiry. Redeeming a card puts the account's windows back to 0% and restarts their clock now. So the
card gains about `used + time-left/window − 1` windows:

- It is worth the most when the window is spent early in its cycle. With cards in hand, Codex is front-loaded.
- The quota comes first, then the cards (user, 2026-11-03). `quota.mjs` suggests a card only when:
  - every account is at ≥99%, or
  - a card would otherwise expire. A card that expires before its window resets sets a deadline to spend that
    account by, with a break-even usage below which the card isn't worth redeeming.
- Redeem with `codex-worker.mjs [--account <name>] reset-credit-use --key <new uuid>`. Reuse the same key if you retry
  the same attempt. Redeeming is irreversible: ask the user every time and redeem only after an explicit yes; there is no
  standing approval (user, 2026-11-03).
- After redeeming, run `quota.mjs --fresh`.

## Permissions and environment

- The user's `~/.codex/config.toml` defaults to yolo (`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`), which is the equivalent of bypass mode. On another machine, check it before assuming. The CLI flags are `-s read-only|workspace-write|danger-full-access` and `--dangerously-bypass-approvals-and-sandbox`.
- **Never give a Codex worker more than the orchestrator has.** That is the same rule as for Claude workers, and it keeps a Codex worker from doing what this session's permissions would block. `danger-full-access` only when the orchestrator runs in bypass mode; otherwise `workspace-write` for writers, and keep anything the orchestrator would need approval for (pushes, external posts, installs) out of the brief and do it yourself, with approval.
- **`workspace-write` can't run git writes** (verified 2026-10-30): Codex keeps every git metadata dir read-only in it — the worktree's `.git`, the main repo's `.git/worktrees/<name>`, even when added as a writable root — so `git add`, `commit`, `fetch` and `rebase` fail with "Operation not permitted". That is deliberate (a sandboxed write to `.git/hooks` or `.git/config` would run outside the sandbox at the next git command), so don't work around it. Brief such workers to edit only, leave the changes uncommitted and report the changed files and a commit message; then review the diff and commit yourself. If the diff touches hook scripts or their config (`.husky/`, `.pre-commit-config.yaml`, `core.hooksPath` targets, package scripts run by hooks), commit with `--no-verify` or ask the user, since your commit would run them unsandboxed. Its network follows `[sandbox_workspace_write] network_access` in `~/.codex/config.toml` (on in the user's config); `--network on|off` overrides it per worker or turn.
- **Quota**: `codex-worker.mjs [--account <name>] usage` prints an account's windows, reset cards and id as JSON (`quota` the windows only); `scripts/quota.mjs` combines every account with Claude's (see SKILL.md, routing).
- **Read-only tasks**: pass `-s read-only`, and say "read-only" in the brief.
- **Skills**: `~/.codex/skills` is symlinked to the same skills directory, so Codex sees most skills. Some can be disabled per skill in config.toml under `[[skills.config]] enabled = false`.
- **Memory**: `~/.codex/AGENTS.md` bridges to Claude: it tells Codex to read `~/.claude/CLAUDE.md`, then the memory files a brief's "Relevant memory" section names, then the `memory/MEMORY.md` of the project its working directory maps to. That is only an instruction (in a 2026-10 sample, about 4 of 7 real worker runs read any Claude memory), so the brief's "Relevant memory" section, as SKILL.md describes, is what makes it reliable. Tested 2026-10-30 on Luna `low`: given only a list of memory paths, it answered without opening any file; told "before anything else, read each of these with a shell command; they are required input", it read them and `~/.claude/CLAUDE.md` and answered both questions correctly. What Codex learns goes to its own `~/.codex/memories/`, which Claude never reads; the report's "Durable lessons" section brings it back.
- Codex has no Artifact or Claude Docs tools. Feishu work goes through `lark-cli`, which the lark skills document.

## Sub-agents inside a Codex worker (verified 2026-11-04, codex-cli 0.166)

A Codex worker can spawn its own sub-agents: the `multi_agent` feature is stable and on (`codex features list`;
`multi_agent = true` in `~/.codex/config.toml`). Tested with `codex exec` and with a hub `codex-worker start`, both on
Luna `low` with a read-only sandbox. In each run the worker spawned 2 sub-agents through `collaboration.spawn_agent`,
and both returned the right file contents.

- **Sandbox:** sub-agents inherit the worker's sandbox. A write in a read-only run failed with "operation not
  permitted".
- **Quota:** sub-agents spend the same account's Codex quota, never Claude's, and add nothing to the orchestrator's
  context.
- **Visibility:** the run's JSONL (`codex exec --json` or the hub log) shows only `collab_tool_call` items with
  `"tool":"wait"`. The spawns themselves don't appear there. Each sub-agent is its own thread under
  `<account home>/sessions/`, with `parent_thread_id` set to the worker's thread.

**Allowed; the worker decides** (user, 2026-11-04). Codex workers may use sub-agents. Whether to use them, how many,
and for what is the worker's own call. Briefs don't ask for them, forbid them or prescribe how to use them.

## Differences from Claude workers

- **Messaging is one-way, from you to the worker.** Codex has no SendMessage or ListAgents, so it can't message you or peers, and
  peers can't find it by name. You (or a peer you give the thread id to) can reach it:
  - workers started through the hub (`codex-worker.mjs start`/`turn`): `codex-worker.mjs --account <name> steer` reaches the running turn
    immediately, and `interrupt` stops it. Relay device handoffs, changed plans and peer requests this way;
  - `codex exec` runs can't be steered: queue a message with `codex queue` (it's read at the next resume), or stop and resume.
  The worker still reports only through its files and its final message, so the brief must be self-contained:
  - the workspace and the files it must not touch;
  - the git and push rules;
  - device holds through `res` (Codex can run the script), taken as `--by codex:<thread id>`;
  - where to write the report, and to start its final message with `[<id>] DONE | QUESTION | BLOCKED | FAILED`. A question
    ends the run; resume it with the answer.
- **Keep on Claude workers**: anything that needs Artifact/Docs tools, browser or computer use, or a worker that must negotiate
  with peers itself. Device runs that share phones mid-run can go to a hub-started Codex worker: steer it with handoffs. It
  can't negotiate with peers, so you broker.
- **Verify before reporting.** Spot-check the cited file:line and commits, as for any worker.

## Image generation (verified 2026-10-30, codex-cli 0.166)

Codex has a built-in image tool (`image_gen.imagegen`; feature flag `image_generation`, stable and on by default; check with
`codex features list`). Claude can't generate images, and the user prefers Codex for every image-producing task (2026-11-03), so they all go to
Codex (`route.mjs image-gen`: Luna `low` first, Sol `medium` when iterating on a result needs judgment).

- **Run** a short `codex exec` as a background task, Luna `low`, `-s workspace-write`, in the folder the image should land in:
  `CODEX_HOME=<account home> codex exec [--skip-git-repo-check] -C <dir> -s workspace-write -m gpt-6-luna -c model_reasoning_effort='"low"' --json -o <dir>/codex-last.md "Generate one image with your image generation tool: <description, style, aspect>. Save it in the current directory as <name>.png and report the saved path." < /dev/null > <dir>/codex.jsonl 2>&1`
  The model only phrases the prompt and copies the file, so Luna `low` is enough; the image quality comes from the image
  tool, not the chat model. A test run (one 1254×1254 PNG, 1.5 MB) took about a minute and ~74K input (mostly cached) /
  ~300 output tokens.
- **Where the image is:** the tool writes to `<account home>/generated_images/<thread id>/exec-<uuid>.png`; the copy into the
  workspace is a plain `cp` the model runs, so ask for the name and folder explicitly. The image call itself does not
  appear in the `--json` events (only the `cp` does): confirm the file exists, then look at it (Read the PNG) before
  reporting.
- **Iterate** by resuming the same thread with what to change, so it keeps the earlier prompt and style.

## Choosing model and effort

`scripts/route.mjs` picks model, effort and account; `references/model-routing.md` explains why. Codex-specific
facts behind it (2026-11-03):

- **Plan:** Pro since 2026-10-30 (the API reports `prolite`): a single weekly window — OpenAI's docs say Pro plans
  currently have no five-hour limit. Plan credits per MTok, relative to Sol 6.1: Astra 5x (10x on cached input),
  Terra 0.5x, Luna 0.05x (0.1x cached). Fast costs 2.5x of included usage, Ultrafast 8x. There is no per-effort
  multiplier: higher effort just spends more tokens. Sol has no long-context surcharge in Codex.
- **Efforts:** `low`, `medium`, `high`, `xhigh`, `max`, `ultra` (Luna stops at `max`); no `none` or `minimal` in the
  CLI. Don't route to `ultra` (the router never does): it makes every turn fan out and multiplies usage. Sub-agents a
  worker chooses to spawn are fine (see Sub-agents inside a Codex worker).
  Set the effort on every launch: the catalog default for Sol is `low` (weak for coding: Terminal-Bench 4 31%); the
  user's config sets `high`.
- **Models:** `gpt-6.1-sol` is the workhorse and Codex's default (near Astra, 500K context); `gpt-6-astra` is the
  frontier model at 5x; `gpt-6.1-terra` is positioned for writing and visual understanding, not coding (its
  computer-use strength doesn't help here: the Codex CLI can't do computer use); `gpt-6-luna` is fast and cheap, for
  extraction, classification, summaries and images, and should not write code. Don't pick `gpt-6-sol` or the
  `gpt-5.6-*` models: they're older at the same or higher cost.

Check every worker's work:
- the cited file:line exist and say what's claimed;
- builds and tests really ran;
- commits contain only the intended files;
- conclusions match the evidence.

If a worker's result fails that check, or it stalls, resume it with a sharper instruction, raise the effort, or follow
re-route with `route.mjs <category> --failures <n+1>`, and note it in the ledger.

**Tell the user promptly when Codex keeps falling short** (user's instruction, 2026-10-30), on any model. Report it right away rather than quietly working around it. Examples:
- repeated failed acceptance or escalations;
- fabricated evidence;
- touching files it was told not to touch;
- stalls or unfinished runs.

Include what happened (task, model, effort, symptom) and what you did about it. The user decides whether to keep using Codex.
