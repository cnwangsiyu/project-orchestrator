# Model and effort routing

Why `scripts/route.mjs` routes the way it does, and the quota policy behind it. The script is the source of truth;
this file is its rationale. Researched 2026-11-03 (Claude Code 2.1.317,
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

## The routing table lives in the script

`scripts/route.mjs` holds the table and applies it the same way every time. `route.mjs --table` prints it. Each row has
three parts:

- a first pick;
- the other vendor's alternative;
- an escalation ladder, plus a cross-vendor second opinion for high-stakes reviews and designs.

The orchestrator supplies only the inputs a script can't judge: the category, the stakes, whether an automatic check
catches a miss, and how many times the task has fallen short. How the table was chosen:

- **Codex Sol is the coding default.** It runs implementation, debugging, review, analysis, build/deploy runs and
  science. Its cost per solved task is a fraction of Opus's at about the same score.
- **Claude takes the work it is clearly ahead on, while Claude has spare:** docs, research, image reading,
  high-stakes review and design. On GDPval, Opus and Sonnet score ≈1845 against Astra's 1542. HLE with tools is
  Opus's best result, at 67.7%.
- **Claude-only work:** computer use, browser, Artifact/Docs tools and peer negotiation. The Codex CLI can't do
  them.
- **Codex-only work:** image generation.
- **Cheap rows:** Luna for lookups and extraction, never for code. Terra for prose drafts only. The Claude
  alternatives are Haiku and Sonnet.
- **Escalation order:** effort before model, and a vendor switch on a stalled debug for different blind spots. Fable
  and Astra come last and always need the user's OK.

To change routing for a kind of task, edit the table in `route.mjs` and this rationale together.

## What the router does, in order

1. **Ladder.** `--failures N` moves N steps up the row's ladder. Past its end, the router asks for the user's OK.
2. **Vendor.**
   - Claude-only and Codex-only rows are locked.
   - Other rows run on Claude only while Claude's budget allows: `claudeBetter` rows need `spare`; design, high-stakes
     review, or any `--stakes high`, also stays on Claude at `near`.
   - Codex is used unless every account is out.
   - A disallowed first pick moves to the alternative before any failure, or to the next allowed ladder step after
     failures. With neither available, the router prints `DEFER`.
   - A Codex 5-hour pause moves work to Claude only while Claude has spare. A full Claude 5-hour window defers new
     Claude work, Claude-only rows included, until it resets.
   - When every Codex account is out, `--stakes low` work waits for Codex; the rest goes to Claude within its budget.
3. **Effort**, one notch per rule:
   - Lower with `--auto-check` (no failures, stakes not high).
   - Higher for `--stakes high`; lower for `--stakes low`.
   - Higher on Codex while it is underused or front-loading cards (lookups, extraction, drafts and images excepted).
   - Lower on Codex while it is overspending and a check exists.
   - Higher on Claude when its headroom expires within a day.
   - Floors: Sol, Terra and Astra never go below `medium`. No notch raises past `xhigh`; only the ladder reaches `max`.
   - Fable is swapped for Opus `xhigh` while Fable's own window is ≥70%.
4. **Gates.** Fable, Astra, `max` effort, an exhausted ladder and every card redemption need the user's OK. Two or more
   Codex steps that fell short on one task print a "tell the user" line.
   - Hard Codex work (`implement-hard`, `debug`, `science`, `review`) gets an extra independent Codex review while Codex
     is underused or front-loading.
5. **Launch.**
   - The account is the one the quota state picks. When two or more accounts must each be spent within 48h, launches
     rotate across them.
   - The sandbox is `read-only` for read tasks. Writers get `danger-full-access` only when the orchestrator runs in
     bypass mode, else `workspace-write`.
   - The launcher is `codex exec` with that account's `CODEX_HOME` for one-shot rows, the hub `codex-worker` for
     the rest, and `claude --bg` or an Agent subagent for Claude.

## Quota policy (user, 2026-11-03)

All thresholds live in `POLICY` in `scripts/lib/state.mjs`.

- **Codex is use-it-or-lose-it.** Spend every account's week by its reset.
- **Claude never runs out before Codex.** Claude runs the orchestrators, so it keeps a reserve for them until the
  reset. Its budget moves with the clock (user, 2026-11-03), so a week about to reset isn't hoarded. With L the share
  of the week still left:
  - **reserve** = the orchestrators' burn until the reset: about 2.9% of the week per day
    (`QUOTA_CLAUDE_ORCH_PER_DAY`), at least 2%. That is ≈20% with a full week left and ≈3% with a day left.
  - **cap** = 100 − 5 − 15·L. Claude never plans to finish the week above this. The 15·L term is the projection's
    uncertainty and vanishes at the reset: 80% with a full week ahead, 95% at the reset.
  - **spare line** = cap − 20·L: 60% with a full week ahead, converging on the cap at the reset.
  - **room** = what Claude workers may still spend now: min(95 − reserve, cap) − used.

  The projection is the share used at the reset at the current burn rate, so a fast burn early in the week trips the
  cap, while 85% used with 2h left and a slow burn reads as spare.
- **Reset cards come last.**

Only the weekly window sets budgets, deadlines and card math; a 5-hour window just pauses work until it resets.
Projections use the recent burn rate (readings spanning ≥3h of the last 24h in the same window). Without that history
they use the window average, with its first tenth floored.

`quota.mjs` lean lines and what the orchestrator does about each:

| Lean line | Condition | Do |
|---|---|---|
| `codex first` | always, unless Codex is out | The router already sends shared work to Codex. |
| `claude has spare` | projected at reset ≤ the spare line (60% a week out, ≈95% at the reset) | Claude also takes the work it's clearly better at. |
| `claude near budget` | projected between the spare line and the cap | Claude takes Claude-only work, design and high-stakes calls. |
| `claude over budget` | projected above the cap (80% a week out, 95% at the reset), or no room left after the reserve | No new Claude workers except Claude-only work that can't wait. Keep the orchestrator lean: Haiku subagents, fewer reads, short briefs. |
| `claude usage unreadable` | no reading | Claude-only work only. Check `claude -p /usage`. |
| `new Codex work → account X` / `rotate across …` | several accounts | The router uses the open account whose quota is lost first (its reset, or an earlier card expiry; a tie goes to a live hub), or rotates when several must be spent within 48h. |
| `codex front-load` / `codex underused` | the account new Codex work lands on holds cards, or — after the first tenth of its week, or with a card deadline — isn't on course for 100% by its deadline | Pull queued and deferred work forward. Add second-opinion reviews. The router raises Codex effort. |
| `codex overspending` | one account left, no cards, projected >115% | The router lowers effort where a check exists. Save Sol `xhigh` and Astra for what matters. |
| `redeem a reset card` | every account ≥99%, or a card expires within the hour (or within a day on a spent account) and still gains | Ask the user (or use a standing approval in memory), then run the printed `reset-credit-use … --credit <id>` and `quota.mjs --fresh`. If declined, route with `--no-redeem`. |
| `X: spent; hold its card` | a spent account's card while another account has quota | Nothing yet: quota first. Redeem when the open accounts are spent, or a day before the card expires. |
| card with a deadline | a card expires before its account's week resets | Spend that account to 99% by then and redeem. Below the printed break-even, let it lapse. |
| `codex paused` | every open account's 5-hour window is full | Claude takes work only while it has spare; otherwise wait. |
| `codex out on every account` | weeks spent, no card worth redeeming | Tell the user. Claude takes what matters within its room. |
| `account X: not logged in` / `hub unreachable` / `login changed` | — | Ask the user for `! CODEX_HOME=… codex login`. Start the hub with `codex-worker.mjs --account X hub`, or restart it once no thread runs on it. |
| `stop` | neither vendor readable | The router defers everything. Check both, tell the user. |
| `expiring` lines, Fable line | a week resets within a day with ≥25% spendable; Fable window ≥70% | The router already adjusts effort and avoids Fable. Pull queued work forward. |

Card math: redeeming at usage u with d hours of a T-hour week left gains about u + d/T − 1 weeks:

- a full new week,
- minus the unused share forfeited,
- minus the delay to the next natural reset, since the clock restarts.

At u ≈ 100% the gain is d/T, so a week spent early in its cycle and then redeemed gains the most. That's why Codex is
front-loaded while cards are in hand.

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
