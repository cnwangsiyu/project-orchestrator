# Codex CLI as a worker

Use this whenever the routing mode in SKILL.md puts a task on Codex — by default (**auto**) that is long implementation, build/test and debugging runs, docs and quick lookups — or the user asks for Codex workers, for example because Claude Code credit is low. Codex runs on the user's ChatGPT plan, not on Claude credit.

**Which launcher:** use `scripts/codex-worker.mjs` through the hub (below) by default, since only it can steer, interrupt and re-attach. Use plain `codex exec` for short one-shot runs that will never need steering (read-only lookups, second opinions, gpt-first subagent replacements). Verified 2026-10-30 on codex-cli 0.166.0. The model catalog changes, so re-check it with `codex debug models` before relying on the ids below.

## Launch, resume, follow

- **Launch** from the worker's workspace as a harness background task (Bash with `run_in_background`):
  `codex exec -C <workspace> -s <sandbox> -m <model> -c model_reasoning_effort='"<effort>"' --json -o <task dir>/codex-last.md "<one line pointing at the brief>" < /dev/null > <task dir>/codex.jsonl 2>&1`
  - Never launch it with a trailing `&` inside a normal Bash call. That run gives no exit notification, so a failure goes unnoticed. In one case a usage-limit stop sat unseen until the user asked.
  - Always redirect stdin from `/dev/null`. Otherwise Codex waits on "Reading additional input from stdin".
  - Outside a git repo, add `--skip-git-repo-check` (to `exec` and `exec resume`).
  - The session id is the `thread_id` in the first JSONL events. Record it in the ledger next to the cwd and brief, because Codex sessions don't appear in `claude agents` or `ListAgents`.
- **Resume** the same worker for its next task, so its context survives:
  `codex exec resume [--skip-git-repo-check] <session uuid> [-m <model>] -c model_reasoning_effort='"<effort>"' --json -o <file> "<what changed + new task>" < /dev/null`
  - Run it from the original workspace, also as a background task.
  - A worker can only be resumed after its current run has ended.
  - `-m` switches the model for the resumed run, for example to escalate.
  - Sessions are not tied to the ChatGPT account: after an account switch, resume still continues with the full context.
- **Follow**: the background task's exit is the completion signal. The final answer is in the `-o` file. Check how the run ended in the JSONL: the last `turn.completed`, or a `turn.failed` with its error.
  - On a usage limit, the run ends with `turn.failed` and "You've hit your usage limit".
  - Report that to the user; a fresh account or a later retry are the options. Resume once it's sorted.
  - First verify any write whose result is unknown, before redoing it.
- **Queue a message for a worker:** `codex queue --thread <session uuid> --message "<text>"` (codex-cli 0.166). Tested 2026-10-30 with `codex exec`: a message queued while the run is going is NOT seen by that run. It is delivered at the next `codex exec resume` of the thread. So it works as a mailbox (peers or the orchestrator can leave instructions anytime), not live steering. `--resume` tries to resume the thread on the local app-server daemon. Live mid-run delivery for daemon-hosted sessions is unverified. To change course now, stop the run and resume.
- **A run that was already started without notification:** start a background watcher. It waits on the PID (`while kill -0 <pid>; do sleep 20; done`), then prints the last `turn.completed`/`turn.failed` line.
- **No Codex Claude Code plugin** (removed 2026-10-30 at the user's request): use `codex exec` or `scripts/codex-worker.mjs` (below). Add any missing capability (e.g. a review mode) to codex-worker, not via the plugin. Never use the model alias `spark`, which maps to a retired model.

## Live steering: codex-worker + an app-server hub (verified 2026-10-30, codex-cli 0.166)

`codex exec` can't be steered mid-run, but the app-server protocol can: `turn/steer` injects a message into the running turn (taken
into account in that same turn), and `turn/interrupt` stops it. `scripts/codex-worker.mjs` wraps this. Every command connects to one
shared hub over WebSocket, so the process that started a worker and the one that steers it can differ.

- **Hub**, one per machine, localhost only, reused by every orchestrator. `codex-worker.mjs hub` checks it and, if it's down,
  starts it detached (log in `~/.codex/hub.log`) so it outlives your session. Running workers die if the hub dies. `CODEX_HUB` overrides the URL. The hub has no
  authentication: any local process can start or steer a thread on it, so keep it on 127.0.0.1 and only on a machine you trust. (The managed daemon's unix socket speaks WebSocket too; Node's
  WebSocket can't dial a unix socket, hence the TCP hub.)
- **Start** a worker as a harness background task (its exit is the completion signal; it exits 0 on completed, 1 on
  failed/interrupted):
  `node ~/.agents/skills/project-orchestrator/scripts/codex-worker.mjs start --cwd <workspace> --model <id> --effort <e> --sandbox <s> --name <worker> --log <task dir>/codex.jsonl --out <task dir>/codex-last.md "<one line pointing at the brief>"`
  `--effort` and `--sandbox` are required. Its first stdout line is `thread=<id> turn=<id>`. Record the thread in the ledger.
  On exit it prints `turn <status>`, the thread's token usage and `final: <first line of the final message>` — so the
  completion notice already carries the worker's `[<id>] DONE | QUESTION | …` line — and writes the whole final message to `--out`.
- **Re-attach** after the orchestrator restarted (its background tasks, including the `start`/`turn` follower, are gone, but
  the turn keeps running on the hub): `codex-worker.mjs wait --thread <id> --log <file> --out <file>`, again as a background
  task. It exits like `start` when the turn ends, or at once if it already has. Several clients can follow one turn.
- **Find** a thread whose id the ledger lost: `codex-worker.mjs list [--cwd <workspace>] [--search <name>]` (hub and `codex exec`
  threads, newest first: id, updated, status, source, name, cwd).
- **Steer** the running turn: `codex-worker.mjs steer --thread <id> "<message>"`. This is the messaging channel: relay peer requests,
  device handoffs and plan changes this way.
- **Interrupt**: `codex-worker.mjs interrupt --thread <id>`. **New task** on the same thread: `codex-worker.mjs turn --thread <id>
  --effort <e> --log <file> --out <file> [--model <id>] [--sandbox <s>] "<what changed + new task>"` (also as a background
  task); `--model`, `--effort` and `--sandbox` change it for this and later turns, e.g. read-only research, then a write task.
  **Status**: `codex-worker.mjs status --thread <id>`.
- The log is app-server notifications: agent text is `item/completed` with `item.type == "agentMessage"`; the end is
  `turn/completed` with `turn.status`.
- Workers started this way use `approvalPolicy: never`, so the sandbox is their only bound; choose it by the rule under
  Permissions below. Nobody answers at the hub: codex-worker refuses every server request validly, and if a worker asks
  the user a question it is told to end the turn with a `QUESTION` final message (in tests, hub workers had no
  question tool at all).

## Permissions and environment

- The user's `~/.codex/config.toml` defaults to yolo (`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`), which is the equivalent of bypass mode. On another machine, check it before assuming. The CLI flags are `-s read-only|workspace-write|danger-full-access` and `--dangerously-bypass-approvals-and-sandbox`.
- **Never give a Codex worker more than the orchestrator has.** That is the same rule as for Claude workers, and it keeps a Codex worker from doing what this session's permissions would block. `danger-full-access` only when the orchestrator runs in bypass mode; otherwise `workspace-write` for writers, and keep anything the orchestrator would need approval for (pushes, external posts, installs) out of the brief and do it yourself, with approval.
- **Read-only tasks**: pass `-s read-only`, and say "read-only" in the brief.
- **Skills**: `~/.codex/skills` is symlinked to the same skills directory, so Codex sees most skills. Some can be disabled per skill in config.toml under `[[skills.config]] enabled = false`.
- **Memory**: `~/.codex/AGENTS.md` bridges to Claude's `memory/MEMORY.md` files.
- Codex has no Artifact or Claude Docs tools. Feishu work goes through `lark-cli`, which the lark skills document.

## Differences from Claude workers

- **Messaging is one-way, from you to the worker.** Codex has no SendMessage or ListAgents, so it can't message you or peers, and
  peers can't find it by name. You (or a peer you give the thread id to) can reach it:
  - workers started through the hub (`codex-worker.mjs start`/`turn`): `codex-worker.mjs steer` reaches the running turn
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
`codex features list`). Claude can't generate images, so image requests go to Codex in every routing mode.

- **Run** a short `codex exec` as a background task, Luna `low`, `-s workspace-write`, in the folder the image should land in:
  `codex exec [--skip-git-repo-check] -C <dir> -s workspace-write -m gpt-6-luna -c model_reasoning_effort='"low"' --json -o <dir>/codex-last.md "Generate one image with your image generation tool: <description, style, aspect>. Save it in the current directory as <name>.png and report the saved path." < /dev/null > <dir>/codex.jsonl 2>&1`
  The model only phrases the prompt and copies the file, so Luna `low` is enough; the image quality comes from the image
  tool, not the chat model. A test run (one 1254×1254 PNG, 1.5 MB) took about a minute and ~74K input (mostly cached) /
  ~300 output tokens.
- **Where the image is:** the tool writes to `~/.codex/generated_images/<thread id>/exec-<uuid>.png`; the copy into the
  workspace is a plain `cp` the model runs, so ask for the name and folder explicitly. The image call itself does not
  appear in the `--json` events (only the `cp` does): confirm the file exists, then look at it (Read the PNG) before
  reporting.
- **Iterate** by resuming the same thread with what to change, so it keeps the earlier prompt and style.

## Choosing model and effort

Relative plan usage, from OpenAI's Codex pricing as of 2026-10: Sol = 1x, Astra ≈ 5x, Terra ≈ 0.5x, Luna ≈ 0.05x. The Fast tier costs about 2.5x more. Higher effort just spends more tokens.

**Efforts.** Codex offers `low`, `medium`, `high`, `xhigh`, `max` and `ultra` (Luna stops at `max`). There is no `none` or `minimal`.
- `ultra` makes the model fan out its own sub-agents. Avoid it: the orchestrator already parallelizes, and `ultra` multiplies usage.
- Set the effort explicitly on every launch. The catalog default for Sol is `low`; the user's config sets `high`.

**Models.**
- `gpt-6.1-sol` is the workhorse: near Astra, 500K context.
- `gpt-6-astra` is the frontier model and expensive.
- `gpt-6.1-terra` is mid-tier (writing, computer use). It's new and its coding strength is unconfirmed, so check its output.
- `gpt-6-luna` is fast and cheap, for extraction, summaries and focused small edits.
- Don't pick `gpt-6-sol` or the `gpt-5.6-*` models: they're older at the same or higher cost.

Start from the table below, then adjust by the task's difficulty and stakes as SKILL.md describes. Check every worker's work:
- the cited file:line exist and say what's claimed;
- builds and tests really ran;
- commits contain only the intended files;
- conclusions match the evidence.

If a worker's result fails that check, or it stalls, resume it with a sharper instruction, raise the effort, or move a Terra task to Sol, and note it in the ledger.

**Tell the user promptly when Codex keeps falling short** (user's instruction, 2026-10-30), on any model. Report it right away rather than quietly working around it. Examples:
- repeated failed acceptance or escalations;
- fabricated evidence;
- touching files it was told not to touch;
- stalls or unfinished runs.

Include what happened (task, model, effort, symptom) and what you did about it. The user decides whether to keep using Codex.

| Task | Model + effort | Why |
|---|---|---|
| Code review | Sol `high` | Needs cross-file reasoning; `xhigh` rarely adds on normal diffs |
| High-stakes review (concurrency, ABI, crash fix) | Sol `xhigh`; Astra `high` as a second opinion | Catches subtle races |
| Implementing in a large C++/ObjC/Java codebase | Sol `high` (`xhigh` for cross-module or threading designs) | Large context, strong coding |
| Debugging | Sol `xhigh`; if it stalls, Astra `xhigh`, then `max` | Hard reasoning pays off here |
| Log or data analysis | Sol `medium`; Luna `medium` for pure extraction | Mostly reading |
| Docs or reports | Terra `medium` | Positioned for writing, at half Sol's usage |
| Long procedural build/device workflows | Sol `medium`; raise to `high` for diagnosis steps | Steps are routine |
| Quick lookups | Luna `low` | About 1/20 of Sol's usage, fastest |
| Usage is tight | Terra `medium` for most work, Luna `low` for lookups; keep Sol `high` for the one hard problem | Avoid Astra, Fast, `max`, `ultra` |

Sources: the OpenAI model docs and Codex pricing/model pages, the Codex CLI changelog, and the local `codex debug models` output. Benchmark numbers for the GPT-6.x models were mostly vendor or second-hand figures in 2026-10, so treat the ranking as guidance and switch models when a worker struggles.
