# Model and effort routing (auto mode)

The starting point for picking vendor, model and effort per worker, subagent or side task. SKILL.md's judgment rules
still apply: this table is the default, and outcomes override it. Researched 2026-11-03 (Claude Code 2.1.317,
codex-cli 0.166); re-check `claude --help`, `codex debug models` and the sources at the bottom when a model changes.

## The lineup at a glance

Relative cost is the output-token price normalized to Sol 6.1 = Sonnet 5.5 = 1 (Codex: plan credits; Claude: API
price, since Anthropic publishes no plan multipliers). The two vendors are separate subscription pools: cost decides
the model inside a pool, quota decides the pool.

| Model | Rel. cost | Strength (public benchmarks) | Use for | Don't use for |
|---|---|---|---|---|
| Claude **Opus 5.5** | 2 | Top or tied on most coding (FrontierCode 54%, CursorBench 58%), knowledge work (GDPval 1846), HLE with tools 67.7%; `medium` is the sweet spot | Open-ended or ambiguous work, design, hard-debugging escalation, high-stakes review, analysis-heavy reports | Routine bulk work; `max` by default |
| Claude **Sonnet 5.5** | 1 | Near Opus on well-scoped work: Terminal-Bench 4 70.6% (vendor), OSWorld 80%, GDPval 1844, SWE-bench Pro subset 87.6% at $0.11 per solved task | Well-specified coding, computer use, browser, docs and reports, Artifact/Docs work, research | `max` (costs as much as Opus `max`, scores lower); open-ended design |
| Claude **Haiku 5.5** | 0.05 | Cheapest Claude; beats Luna on code (TB4 33–39%, FrontierCode 46%) | Lookups, file finding, summaries, polling, Explore-style subagents | Anything needing judgment |
| Claude **Fable 5.1** | 5 | Long-horizon reasoning, but at or below Opus 5.5 on most coding benchmarks for ~3x the cost; its own weekly cap (≤50% of the week, and it also counts toward the all-models week) | Only after Opus `xhigh` visibly fell short, or the longest single-thread reasoning; tell the user first | Default anything |
| Codex **Sol 6.1** | 1 | Near Astra at ~1/5 the usage (AA index: `high` 50 at $0.59/task, `xhigh` 52 at $0.76; Opus `high` 52 at $3.46); 500K context | The coding workhorse: implementation, build/test/deploy runs, debugging, code review, log analysis | `low` effort for any coding (TB4 31%) |
| Codex **Astra** | 5 (10x on cached input) | Frontier, +2–5 points over Sol; best on Terminal-Bench-Science (64.6%) | Escalation after Sol `xhigh` failed; a strongest-GPT second opinion; numerical or scientific work Sol couldn't crack | Default anything; small tasks (it over-tests and asks questions) |
| Codex **Terra 6.1** | 0.5 | Writing and visual understanding; not a coding model (TB4 32% at `medium`) | Bulk prose drafts, translation, reading screenshots or images, writing when Claude has no spare | Coding; computer use (the Codex CLI can't do computer use at all) |
| Codex **Luna** | 0.05 | Extraction, classification, structured summaries; very weak at coding (TB4 13% at `max`) | Bulk extraction or classification, quick lookups, image generation (the image tool does the work) | Any code change or code reasoning |

Don't pick `gpt-6-sol` or `gpt-5.6-*` (older at the same or higher cost), Codex `ultra` (fans out its own sub-agents
and multiplies usage), the Fast/Ultrafast tiers (2.5x+ usage), or the alias `spark`.

## Task → first pick

"Alt" is the other vendor's equivalent, used when quota points that way (see Quota — Claude picks for work Codex
can also do are conditional on Claude having spare) or as a second opinion. "Escalate"
is the next step when the first pick visibly falls short.

| Task | First pick | Alt | Escalate |
|---|---|---|---|
| Quick lookup, find a file, status check, poll | Haiku `low` (Agent subagent) | Luna `low` (`codex exec`) | Sonnet `medium` |
| Bulk extraction, classification, summarizing data or logs | Luna `medium` | Haiku `medium` | Sol `medium` |
| Log or data analysis that needs reasoning | Sol `medium` | Sonnet `medium` | Sol `high` |
| Web research and synthesis | Sonnet `medium` | Sol `medium` | Opus `high` for judgment-heavy synthesis |
| Well-scoped implementation (clear spec, tests or a build to check it) | Sol `high` | Sonnet `medium` | Sol `xhigh` |
| Large, cross-module or threading implementation; refactor | Sol `xhigh` | Opus `high` | Opus `xhigh` |
| UI or frontend work that needs a browser or a visual check | Sonnet `high` | — | Opus `high` |
| Debugging, root cause across components | Sol `xhigh` | Opus `high` | Switch vendor (Opus `xhigh` ⇄ Sol `max`), then Fable `high` or Astra `xhigh` (tell the user) |
| Routine code review | Sol `high` | Sonnet `high` | Sol `xhigh` |
| High-stakes review (concurrency, ABI, crash fix, security) | Opus `xhigh` **and** Sol `xhigh`, independently | — | Astra `high` as a third opinion |
| Design, architecture, plan, trade-off decision | Opus `high` | — | Opus `xhigh`, with Sol `xhigh` as a second opinion |
| Docs, reports, user-facing writing, Feishu docs | Sonnet `medium` | Terra `medium` (drafts only; review closely) | Opus `medium` for analysis-heavy reports |
| Long procedural build, deploy or device workflow | Sol `medium` (`high` for diagnosis steps) | Sonnet `medium` | Sol `high` |
| Computer use, browser automation, Artifact/Docs tools, peer negotiation | Sonnet `medium` | — (Claude only) | Opus `high` |
| Device run that hands phones over mid-run | Sol `medium` through the hub (you broker by steering) | Sonnet `medium` (negotiates itself) | — |
| Scientific or numerical computation | Sol `xhigh` | Opus `xhigh` | Astra `high` |
| Image generation | Luna `low` (Codex only) | — | — |
| Reading screenshots or images (no computer use) | Sonnet `medium` | Terra `medium` | Opus `high` |
| Second opinion on any conclusion | The other vendor at the same tier | — | — |

The orchestrator itself stays on whatever the user runs it with (Opus 5.5 by default); it delegates rather than
thinking at `max`.

## Effort rules

- **Always set effort explicitly.** Defaults differ: Claude Code runs Opus/Sonnet/Haiku at `medium` and Fable at
  `high`; the Codex catalog defaults Sol to `low`, while the user's config sets `high`. Claude takes
  `--effort low|medium|high|xhigh|max`; Codex adds `ultra` (never use it).
- **Claude:** `low` for subagent lookups; `medium` for most agentic work (Opus 5.5 `medium` beat Opus 5 `max` at ~1/5
  the cost); `high` for complex coding; `xhigh` for long (>30 min) agentic or coding runs; `max` only after `xhigh`
  visibly fell short, and then on Opus rather than Sonnet.
- **Codex:** never below `medium` for coding on Sol; `medium` for routine work, `high` as the coding default, `xhigh`
  for hard or long work, `max` for the one hardest problem. Luna at `medium`–`high` for extraction; Luna `low` only for
  trivial lookups and images.
- **Cheap first, escalate on failure — when a miss is caught automatically.** In Anthropic's data, running at
  low/medium and re-running only the failures at high solved more tasks (≈97%) for less than running everything at high
  (95%). Start one notch below the table when a test, build or exact acceptance check will catch a miss; don't when a
  miss is silent or costly (device runs, irreversible operations, design, reviews whose output you won't re-verify).
- **Effort before model:** step effort within a model first; switch model, or vendor, when effort can't close the gap.
  Switching vendor on a stalled debug also buys a different set of blind spots.
- Note each escalation in the ledger with its symptom; when a kind of task runs easily, start it lower next time.

## Quota: spend Codex fully, keep Claude alive (user, 2026-11-03)

The two subscriptions have different jobs:

- **Codex is use-it-or-lose-it.** The target is to have every Codex account's week spent by its reset. Reset cards
  extend that, and they gain most when an account is spent early in its cycle, so Codex is front-loaded while cards
  are in hand. Everything either vendor can do goes to Codex first.
- **Claude also runs the orchestrators.** If it runs out, nothing can be dispatched. It must never run out before
  Codex. About 20% of its window stays reserved for orchestration (`QUOTA_CLAUDE_RESERVE`), so Claude workers get at
  most the other 80%.

So the Claude picks in the table above are conditional. Rows that only Claude can do (computer use, browser,
Artifact/Docs, peer negotiation) always stay on Claude. Rows where Claude is merely better (docs, design, research,
open-ended work, UI) stay on Claude only while Claude has spare; otherwise use the Codex alternative (Sol `medium`
for docs and research, Sol `xhigh` for design, with a closer review).

Run `node <this skill>/scripts/quota.mjs` before launching a worker either vendor could run, and at least every half
hour while work is queued. Its `budget` line projects each vendor's share at reset at the current rate. Its `lean`
line applies these rules:

| Script says | Do |
|---|---|
| `codex first` | Default: anything either vendor can do runs on Codex. |
| `claude has spare` (projected ≤60%) | Claude also takes the work it is clearly better at. |
| `claude near budget` (60–80%) | Claude gets only Claude-only work, design and high-stakes calls. |
| `claude over budget` (projected >80%, or on course to run out before Codex) | No new Claude workers except Claude-only work that can't wait. Move Claude-strength work to Codex Sol. Keep the orchestrator lean: Haiku subagents, fewer reads, short briefs. |
| `codex underused` (projected <85%) | Spend it. Raise effort on Codex work (`high` → `xhigh`). Add Codex second-opinion reviews. Pull queued or deferred work forward. Move Claude-strength work that Codex can do well enough (research, routine docs) to Codex. |
| `codex overspending` (projected >115%) | Lower effort where a test or build catches misses. Save Sol `xhigh` and Astra for what matters. |
| `split` (Codex overspending, Claude has spare) | Claude also takes some work either vendor can do, while it stays under its cap. |
| `new Codex work → account X` | Several Codex accounts: start new Codex workers on that account (`--account X`); it is the one whose unused quota is lost first. |
| `redeem a reset card` | Every account is spent (≥99%), or a card is about to expire: redeem with the user's OK (see codex-workers.md). Never earlier: quota first, then cards. |
| reset card with a deadline | A card expires before its account's window resets: spend that account to 99% by then, then redeem. Below the printed break-even, let the card lapse. |
| `codex out on every account` | Tell the user. Claude takes what matters before the next Codex reset, within its room under the cap. The rest waits. |
| `expiring` note | A window resets within a day with much left (for Claude, above the reserve). Use stronger settings there and pull queued work forward. Never start Fable or Astra on that basis alone. |
| Fable note | Fable's own window is at ≥70%: skip Fable. |

Say in the launch line which model and effort you chose and, when quota changed the choice, why.

## Sources (2026-11-03)

- Claude: platform.claude.com/docs/en/about-claude/pricing, …/models/overview,
  …/models/optimizing-for-cost-and-intelligence, …/build-with-claude/effort; anthropic.com/claude-opus-5-5,
  /claude-sonnet-5-5, /claude-haiku-5-5, /claude-fable-and-mythos-5-1; code.claude.com/docs/en/model-config;
  support.claude.com articles 11647753 and 15424964.
- OpenAI: developers.openai.com/api/docs/pricing.md and /models/<id>.md; learn.chatgpt.com/docs/pricing.md, /models.md,
  /agent-configuration/speed.md, /changelog.
- Independent: artificialanalysis.ai (Intelligence Index, Terminal-Bench 4.0, FrontierCode 2.0, AutomationBench, cost
  per task at each effort); vals.ai comparisons.
- Caveats: vendor and independent numbers disagree in places (Sonnet 5.5 on Terminal-Bench is 70.6% per the vendor but
  44% at `high` on AA; AA's Fable row is labeled "with fallback"). OpenAI's own launch benchmarks weren't reachable.
  Anthropic publishes no per-model plan multipliers; Codex credits per MTok are Astra 5x, Sol 1x, Terra 0.5x and
  Luna 0.05x of Sol (cached input: Astra 10x, Luna 0.1x).
