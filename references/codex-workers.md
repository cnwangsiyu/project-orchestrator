# Codex CLI as a worker

Use this when the user asks for Codex workers, for example because Claude Code credit is low. Codex runs on the user's ChatGPT plan, not on Claude credit. Verified 2026-10-30 on codex-cli 0.166.0. The model catalog changes, so re-check it with `codex debug models` before relying on the ids below.

## Launch, resume, follow

- **Launch** in a background Bash from the worker's workspace:
  `codex exec -C <workspace> -m <model> -c model_reasoning_effort='"<effort>"' --json -o <task dir>/codex-last.md "<one line pointing at the brief>" > <task dir>/codex.jsonl 2>&1`
  The session id is the `thread_id` in the first JSONL events. Record it in the ledger next to the cwd and brief, because Codex sessions don't appear in `claude agents` or `ListAgents`.
- **Resume** the same worker for its next task, so its context survives:
  `codex exec resume <session uuid> -c model_reasoning_effort='"<effort>"' -o <file> "<what changed + new task>"`
  Run it from the original workspace. A worker can only be resumed after its current run has ended.
- **Follow**: the background Bash exiting is the completion signal. The final answer is in the `-o` file.
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

**User preference (2026-10-30): try Terra first.** OpenAI positions it as close to Sol at half the usage. Default to Terra at the same effort you'd give Sol, and check its work harder:
- the cited file:line exist and say what's claimed;
- builds and tests really ran;
- commits contain only the intended files;
- conclusions match the evidence.

If Terra's result fails that check, or it stalls, resume or relaunch on Sol (same or higher effort) and note it in the ledger. Repeated misses on one kind of task mean that kind defaults to Sol from then on.

| Task | Default (try first) | Escalate to |
|---|---|---|
| Code review | Terra `high` | Sol `high` |
| High-stakes review (concurrency, ABI, crash fix) | Terra `xhigh` | Sol `xhigh`; Astra `high` as a second opinion |
| Implementing in a large C++/ObjC/Java codebase | Terra `high` (`xhigh` for cross-module or threading designs) | Sol `high` / `xhigh` |
| Debugging | Terra `xhigh` | Sol `xhigh`, then Astra `xhigh` |
| Log or data analysis | Terra `medium`; Luna `medium` for pure extraction | Sol `medium` |
| Docs or reports | Terra `medium` | Sol `medium` |
| Long procedural build/device workflows | Terra `medium`; `high` for diagnosis steps | Sol `medium` / `high` |
| Quick lookups | Luna `low` | Terra `low` |

Avoid Astra, Fast, `max` and `ultra` unless a task has already failed on Sol.

Sources: the OpenAI model docs and Codex pricing/model pages, the Codex CLI changelog, and the local `codex debug models` output. Benchmark numbers for the GPT-6.x models were mostly vendor or second-hand figures in 2026-10, so treat the ranking as guidance and switch models when a worker struggles.
