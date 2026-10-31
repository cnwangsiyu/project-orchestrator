# Codex CLI as a worker

Use this when the user asks for Codex workers, for example because Claude Code credit is low. Codex runs on the user's ChatGPT plan, not on Claude credit. Verified 2026-10-30 on codex-cli 0.166.0. The model catalog changes, so re-check it with `codex debug models` before relying on the ids below.

## Launch, resume, follow

- **Launch** from the worker's workspace as a harness background task (Bash with `run_in_background`):
  `codex exec -C <workspace> -m <model> -c model_reasoning_effort='"<effort>"' --json -o <task dir>/codex-last.md "<one line pointing at the brief>" < /dev/null > <task dir>/codex.jsonl 2>&1`
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
- **Optional Codex plugin**: `node ~/.claude/plugins/cache/openai-codex/codex/<ver>/scripts/codex-companion.mjs task --background --write [--resume] --model <id> --effort <low…xhigh>`, then `status` / `result` / `cancel <job>`. Two caveats:
  - Never use `--model spark`. It maps to the retired `gpt-5.3-codex-spark`.
  - The plugin rejects the efforts `max` and `ultra`. Use `codex exec -c model_reasoning_effort=...` for those.

## Permissions and environment

- The user's `~/.codex/config.toml` defaults to yolo (`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`), which is the equivalent of bypass mode. On another machine, check it before assuming. The CLI flags are `-s read-only|workspace-write|danger-full-access` and `--dangerously-bypass-approvals-and-sandbox`.
- **Read-only tasks**: pass `-s read-only`, and say "read-only" in the brief.
- **Skills**: `~/.codex/skills` is symlinked to the same skills directory, so Codex sees most skills. Some can be disabled per skill in config.toml under `[[skills.config]] enabled = false`.
- **Memory**: `~/.codex/AGENTS.md` bridges to Claude's `memory/MEMORY.md` files.
- Codex has no Artifact or Claude Docs tools. Feishu work goes through `lark-cli`, which the lark skills document.

## Differences from Claude workers

- **No messaging.** Codex has no SendMessage or ListAgents, so peers can't reach it and you can't redirect it mid-run. The brief must be self-contained:
  - the workspace and the files it must not touch;
  - the git and push rules;
  - device holds through `res` (Codex can run the script);
  - where to write the report.

  The orchestrator relays everything else, such as device handoffs, changed plans and peer requests, by resuming the worker after its run ends.
- **Keep on Claude workers**: long device runs that must share phones with other projects mid-run, and anything that needs Artifact/Docs tools.
- **Verify before reporting.** Spot-check the cited file:line and commits, as for any worker.

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

Pick the model from the table below. Check every worker's work:
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
