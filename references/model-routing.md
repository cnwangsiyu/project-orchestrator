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
| Claude **Haiku 5.5** | 0.05 | Cheapest Claude; beats Luna on code (TB4 33–39%, FrontierCode 46%) | Lookups, file finding, summaries, polling (as a background worker) | Anything needing judgment |
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
- **Claude-only work (`claude-tools`):** Artifact/Docs tools and peer negotiation.
- **Browser and desktop work:** `browser` (web pages in Chrome), `ui-browser` (frontend work with a visual check) and
  `computer-use` (desktop apps; `--apps <bundle ids>`) go to TTADK Codex once `browser-setup` is done, else to Claude
  (user, 2026-11-07). A terminal Claude worker can drive Chrome (Claude in Chrome) but has no desktop computer-use tool
  (ledger 10-31), so for desktop apps the Claude fallback may only report BLOCKED. TTADK desktop work needs an unlocked
  screen.
  - A background Claude worker can drive the user's signed-in Chrome. Its brief names the Chrome by `deviceId`
    (recorded in the ledger once the user has picked it), and the worker calls `select_browser` with that id when
    several browsers are connected. A worker that still can't reach the browser reports BLOCKED with the tool's
    error. Clicking never falls back to the orchestrator: video-agent W258 did, and that orchestrator then made 510
    browser calls in 24h (nightly review 2026-11-05). Headless Playwright suits pages that don't need the user's
    sign-in, as W260 did.
- **Codex-only work:** every task whose output is an image — generating, editing, variants, icons, illustrations,
  mockup images (user, 2026-11-03). Luna `low` writes the prompt (the image tool makes the picture); Sol `medium` if an
  iteration needs more judgment.
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
   - A retry can come out identical to the attempt that failed: the Codex notch has already put the first pick at the
     next step's effort, and Claude's budget rules out the Claude steps. In that case the router says so and adds a
     note rather than calling it an escalation. The retry is no stronger, so put the failure's concrete findings in
     its brief. Seen on 2026-11-03 in video-agent W228c: `implement --failures 2` ran the same Sol `xhigh` as the
     first picks.
4. **Review.** Code work must pass `--impact`.
   - `release`: always reviewed (`review-high` when stakes are high).
   - `service`: reviewed only at high stakes.
   - `throwaway`: never reviewed.
   - Reviewers follow `references/review-rubric.md` and block only on P0/P1.
5. **Gates.** Fable, Astra, `max` effort (except on TTADK), an exhausted ladder and every card redemption need the
   user's OK. Two or more
   Codex steps that fell short on one task print a "tell the user" line.
   - Hard Codex code work (`implement-hard`, `debug`, `science`) gets an extra independent Codex review while Codex is
     underused or front-loading, but only where the review policy wants a review anyway (release code, or service
     code at high stakes; user, 2026-11-07), never on a review, and never on a TTADK device.
   - A required review is told who wrote the code (`--author`); a Codex-written change is reviewed by Claude first.
6. **Launch.**
   - The account is the one the quota state picks. When two or more accounts must each be spent within 48h, launches
     rotate across them.
   - The sandbox is `read-only` for read tasks. Writers get `danger-full-access` only when the orchestrator runs in
     bypass mode, else `workspace-write`.
   - The launcher is `codex exec` with that account's `CODEX_HOME` for one-shot rows, the hub `codex-worker` for
     the rest, and a `claude --bg` worker for Claude (never an Agent subagent).

## Codex accounts: TTADK first (user, 2026-11-07)

- **TTADK first, for everything its Sol can handle.** When the TTADK company gateway is healthy (CLI present, SSO
  active, `gpt-6.1-sol` listed), every row runs first on TTADK `gpt-6.1-sol`, Claude-strength rows included (docs,
  research, design, high-stakes review).
  - **TTADK's quota is daily, not unlimited** (about 500M tokens per user per day, shared by all models, resets 16:00
    UTC; measured 2026-11-08). When it runs out, TTADK is paused until the reset and its normal work waits
    (`--urgent` / high stakes run on personal quota); see codex-workers.md, "Health and fallback".
  - **Burn TTADK, not personal quota, without losing quality (user, 2026-11-07).** TTADK is the company's quota;
    Claude and the ChatGPT accounts are the user's own. So on TTADK:
    - the first effort is the higher of the row's first pick and its Sol alternative, at least `high` for docs,
      research, image-read and analysis, `xhigh` for a review of Codex-written code, one notch up at high stakes;
      `--auto-check` and low stakes don't lower it (that saves nothing on TTADK);
    - after a failure Sol climbs every notch to `xhigh`, then `max` (no OK needed on TTADK; lookup, extract, draft
      and browser stop at `xhigh`), before the row's personal-quota steps: e.g. implement-hard Sol xhigh → Sol max →
      Opus xhigh; science Sol xhigh → Sol max → Astra (ChatGPT, needs an OK; dropped when ChatGPT is out);
    - a routine review of Codex-written code runs on TTADK (`review --author codex`): a fresh Sol xhigh reviewer plus
      a second free one with a different focus (failure paths, concurrency, edge cases, tests). High-stakes review
      and design keep Claude in the pair;
    - when Claude has no room for a cross-vendor second opinion, a fresh TTADK reviewer stands in instead of the
      second opinion being dropped or deferred;
    - TTADK down for a reason the user can fix (SSO, CLI, models): tell the user at once; work TTADK would take waits
      unless it is high-stakes or `--urgent`. A rate-limited run still retries once, then re-routes.
  - Image generation never runs on TTADK, its Sol fallback step included.
  - The extra Codex review added while ChatGPT Codex quota is underused runs on a ChatGPT account (its purpose is to
    spend that quota). Other Codex second opinions follow TTADK first.
  - Not TTADK-capable, so routed as before: `claude-tools` (`browser`, `ui-browser` and `computer-use` go to TTADK once
    `browser-setup` is done, user 2026-11-07), `image-gen` (no image tool
    on the gateway), `research` on a TTADK account without its local proxy (Codex sends no search tool to the gateway;
    the proxy in `references/codex-workers.md` adds it for every TTADK worker),
    `second-opinion --against codex`, a high-stakes review of Codex-written code (Claude first), and `browser` before
    `browser-setup`. `image-read` works on the gateway.
  - Later ladder steps never step back: Codex steps no stronger than the Sol already tried (Luna, Terra, a weaker Sol)
    are dropped; Astra stays after Sol max on a ChatGPT account and is dropped when those are out.
  - **A TTADK device saves the rest (user, 2026-11-07).** The user's other device has no TTADK and uses the shared
    ChatGPT and Claude quota, so on a device with a TTADK account nothing spends that quota for its own sake: no
    underused, front-load or expiring-week effort raises, no extra quota-spending reviews, and Claude takes only
    what TTADK can't do. Reset-card prompts appear only when ChatGPT-only work lands on that account. Cards may lapse
    on this device; that is accepted (TTADK always first).
  - Cross-vendor pairs stay cross-vendor: with Sol first, the second opinion is Claude.
  - Trade-off accepted by the user: on knowledge-work benchmarks (GDPval), Claude scores well above GPT. The nightly
    review compares outcomes per category and flags a category that gets worse.
- **No quota notches on TTADK.** Quota-driven effort notches (underused, front-load, overspending) apply only to
  ChatGPT accounts, and the auto-check and low-stakes notches don't apply on TTADK either. TTADK has no windows.
- **TTADK's other models (tested 2026-11-07, ~110 runs on TTADK, plus public data).** None beats Sol on quality where
  it matters: agentic coding, debugging and frontend tasks tied at full marks; Sol had the best pure reasoning (12/12,
  with DeepSeek-V4.1-Flash), and public indexes put it clearly ahead (Artificial Analysis v5: Sol 55, GLM-5.3 and
  DeepSeek-V4.1-Flash 32; DeepSWE: Sol 75, Kimi-K3 and GLM-5.3 ~67). So Sol stays the default.
  - **Kimi-K3** is the second reviewer of Codex-written code on TTADK (user, 2026-11-07): 100% recall on planted
    defects (Sol 88%), misses not overlapping Sol's, no nitpicks. Its Chinese prose read most naturally (25/25 vs Sol
    24, one judge, one run) but it is slow (88–150s for a short essay): docs stay on Sol until the nightly review shows
    rework on Chinese docs.
  - GPT-5.6-Terra and DeepSeek-V4.1-Flash are faster (Terra 510s vs Sol 858s over seven Codex tasks; Flash 200+
    tokens/s) but each slipped on spec-following or reasoning; not used by default.
  - Gateway aliases: `deepseek-v4-pro-0813` and `deepseek-v4-flash-0731` currently resolve to deepseek-v4.1-flash;
    `auto` is glm-5 (slow, timed out once); `auto-max` is gpt-5.4; `gpt-5.5` is expired. GLM-5.3 drove the desktop's
    Safari through osascript during a Codex task: don't route agentic work to it.
- **No concurrency cap on TTADK.** A rate-limited run is retried once on TTADK, then re-routed with
  `--exclude-account ttadk`. So is a run that fails for TTADK reasons.
- **ChatGPT quota left unspent.** Preferring TTADK leaves more of the ChatGPT weeks unspent. The user chose this: on a
  TTADK device it is not waste, and the nightly review doesn't report it as such (hard rule, user 2026-11-07).
- **Browser row.** `browser` (web pages in the user's signed-in Chrome) goes to TTADK Codex, Sol `medium`, through the
  hub with `--browser-origins`, when the account is browser-ready (`browser-setup`). Otherwise it goes to Claude Sonnet
  `medium` (Claude in Chrome). Its ladder runs Sol `high`, then Claude.
  - Measured: the two do the same read and interaction tasks, but Claude was 3–10x faster per task.
  - Chrome must be running before either starts.

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
| `TTADK first` | a healthy TTADK account | The router sends everything TTADK's Sol can handle there. |
| `TTADK device` | a TTADK account is set up | Leave ChatGPT and Claude quota for the other device; no spending for its own sake. |
| `codex first` | always, unless Codex is out | The router already sends shared work to Codex. |
| `claude has spare` | projected at reset ≤ the spare line (60% a week out, ≈95% at the reset) | Claude also takes the work it's clearly better at. |
| `claude near budget` | projected between the spare line and the cap | Claude takes Claude-only work, design and high-stakes calls. |
| `claude over budget` | projected above the cap (80% a week out, 95% at the reset), or no room left after the reserve | No new Claude workers except Claude-only work that can't wait. Keep the orchestrator lean: no subagents, fewer reads, short briefs. |
| `claude usage unreadable` | no reading | Claude-only work only. Check `claude -p /usage`. |
| `new Codex work → account X` / `rotate across …` | several accounts | The router uses the open account whose quota is lost first (its reset, or an earlier card expiry; a tie goes to a live hub), or rotates when several must be spent within 48h. |
| `codex front-load` / `codex underused` | the account new Codex work lands on holds cards, or — after the first tenth of its week, or with a card deadline — isn't on course for 100% by its deadline | Pull queued and deferred work forward. Add second-opinion reviews. The router raises Codex effort. |
| `codex overspending` | one account left, no cards, projected >115% | The router lowers effort where a check exists. Save Sol `xhigh` and Astra for what matters. |
| `redeem a reset card` | every account ≥99%, or a card expires within the hour (or within a day on a spent account) and still gains | Ask the user every time — never redeem on your own (user, 2026-11-03) — and only after an explicit yes run the printed `reset-credit-use … --credit <id>` and `quota.mjs --fresh`. If declined, route with `--no-redeem`. |
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
