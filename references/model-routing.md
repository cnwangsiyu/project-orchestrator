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

On personal ChatGPT accounts, don't pick `gpt-6-sol` or `gpt-5.6-*` (older at the same or higher cost); the approved
TRAE choices below are a separate company-quota policy. Don't pick Codex `ultra` (fans out its own sub-agents
and multiplies usage), the Fast/Ultrafast tiers (2.5x+ usage), or the alias `spark`.

## Candidate pipeline

`route.mjs` is a thin CLI over `scripts/lib/pipeline`. The sole selection path is:
strict TaskSpec parsing → public-cache snapshot → complete tuple enumeration →
capability/content/quality/approval filters → completion estimates → ordered
choice and reviewer-set construction → final validation → one notes/command
renderer. `route.mjs --table` reads static category metadata only.

The clock, quota, model capabilities, restrictions, attempts and review history
are pinned inputs. `ROUTE_NOW` supports deterministic fixtures. Quota and lane
telemetry expire after 30 minutes; identity/catalog facts after 10 minutes.
Malformed nested state becomes UNKNOWN for that account. Browser-ready TTADK and ChatGPT have the desktop runtime unless explicitly
unavailable; TRAE and Claude have no desktop path. Missing tools or vision blocks.

Company accounts remain first. Hard work stays on qualified Sol/Astra (or the
explicit adversarial non-GPT exception); light work uses the light list and
preserves known free capacity. ETA compares model-specific drain/progress and
known TTADK resets. Fresh positive queue position with zero drain, or waiting
without progress, is STALLED with no finite ETA and ranks after runnable lanes.
Only absent/stale telemetry uses the optimistic unknown fallback. A reset decision includes deferUntil, an owner and ledger/timer
instructions. Low-priority lanes carry bounded queue patience. No resource is
held while waiting for a model response or an automatic replacement.

Retries use the actual prior tuple (`--actual vendor:model:effort[@account]`, or
sanitized task-owned attempt metadata), never a ladder rebuilt from the current
catalog. Missing history falls back to the first category rung with an explicit
why note. Inferred history is used only with `--failures > 0`, and only actual
accepted/terminal launches of the same project, name and category count. Route
decisions and planned/dry/unlaunched records never establish a retry floor.
Explicit `--actual` applies even at zero failures. Every replacement must satisfy all actual
floors, exclusions and confirmed-cancellation requirements. Automatic hops are
company-only, owner-preserving, and capped at two.

Personal quota asks first on devices with a registered TTADK or TRAE account.
Without company accounts, personal ChatGPT is the default lane with standing
permission; eligible accounts with deadlines within 48 hours rotate under the
CLI counter, otherwise the earliest deadline wins. --urgent --user-ok <reference> records one user yes
and produces a command; image generation and Claude-only tools retain standing
permission. Astra on personal ChatGPT always needs its own scoped OK, including
on devices without company accounts. A runnable non-Astra escalation wins and
identifies Astra as a gated alternative; qualified TRAE Astra stays ungated.
Account-less explicit actuals keep the account UNKNOWN and retain the supplied
model/effort floor. Max effort outside company accounts (TTADK and TRAE), Fable and reset redemption keep separate
authorization. An eligible company primary launches while a gated personal
second reviewer awaits the user's answer before acceptance.

Review policy: at most two rounds per task/branch; `--review-override "reason"`
permits one more and is logged. Re-reviews inspect only blocked findings. Routine
reviews have one reviewer. Adversarial, review-high and release reviews require
independent families; adversarial reviews require two non-GPT families. Missing
required reviewers remain an acceptance obligation and do not hold the company primary.
Fallback-written service code only needs review for release/high stakes,
build/acceptance involvement, or recent same-model/category failure. Optional
reviews above 10% of rolling 24-hour dispatches overall or per project warn
"over review budget — prefer accepting on tests"; dispatch and required reviews continue.

| Project | Profile | Landing gate |
|---|---|---|
| video-agent | internal-demo: ordinary executable acceptance; no default security/adversarial/review-high or second review | Package tests + typecheck + SG prepare; full verify for wide changes or once/day main |
| Other | Existing required-review rules | Existing build discipline |

Profiles live in `references/project-risk-profiles.json`; explicit security/high
review requests on internal-demo explain the acceptance route and
`--profile-override "reason"`. Revisit when external users, real user data or
scale arrive. Credential/device/lock rules and production release approval remain.

The API and acquisition boundary are documented in `scripts/lib/pipeline/README.md`.
There is no legacy mode, shadow runner or per-category switch.

## Company capacity and execution

TRAE foreground tier lists are:

| Tier | Qualified preference |
|---|---|
| Light | GPT-5.6-Terra, GPT-5.5, DeepSeek-V4.1-Flash |
| Normal | GPT-6.1-Sol, GPT-5.6-Sol, GPT-5.6-Terra, DeepSeek-V4.1-Flash |
| Hard | GPT-6.1-Sol, GPT-6-Astra |

Within a normal/light ladder, uncongested models with priority quota left rank
ahead of depleted lanes, even when a depleted lane reports immediate progress.
Light work stays on its light ladder while a qualified light lane is usable;
it does not climb to Sol because Sol happens to be free. Depleted lanes remain
available when no ladder model has usable priority quota. Hard work never demotes.

Vision uses its separate qualified catalog. DeepSeek is unsuitable for full builds,
executable/auth/storage acceptance or a large file in one output. Seed is vision
only. Public catalog, account and harness capabilities must all support the task.

An observed free TRAE lane takes precedence over TTADK for work that its actual
model and harness can do, including browser/ui-browser on the ready Playwright
lane and depleted-bucket low-priority work. The lane must start now, have a fresh
load below 60% for that candidate model, and show no queue or stall. This preserves
TTADK daily tokens for later and for capabilities unavailable on TRAE (desktop,
Kimi and any browser tools absent from its harness). The explanation says
"TRAE lane free: saving TTADK quota" and names the model whose load it quotes.
Sibling/account loads do not establish that model's congestion. A queued, stalled
or congested qualifying lane yields to usable TTADK. Hard floors, actual retry
floors, capability and authorization gates still apply. A same-model Sol/max
retry is ungated on both company accounts; prefer that retained effort step over
switching to missing/stalled telemetry at the same floor.

Fresh reserve/burn observations still explain company capacity. An available
TTADK lane wins when TRAE cannot demonstrate immediate uncongested capacity. TTADK reset within four hours with projected burn below 70%
prefers TTADK so its quota does not expire unused. Only truly absent or stale lane
telemetry is UNKNOWN; it does not prove the lane is free.

Personal windows retain reserve/deadline and effort policy. Reset redemption is
an independent scoped action followed by refreshed quota and a new plan; a reset
proposal is never an executable worker launch. Pure planning does not advance an
ambient rotation counter. Exact account selection is subject to capabilities,
current authorization and the actual attempt floor.

`--env test` describes the target, not execution location. Only an explicit remote
execution scope (`--no-local-build` / `--execution remote`) removes local resource
admission. Follow [resources.md](resources.md) and the injected worker digest for
res v1.5, one-process build wrappers, registered devices and restoration. Acquire
holds after the first model response and return them before a replacement.

Registered own-test signing uses ordinary full-access Codex-family company
workers and the existing package registry and identity allowlist. The resident
Claude signer is retired. All workers use installed, signed-in tools without
opening credential or session files.

CLI launch output retains account/model/effort, sandbox, owner, route arguments,
tracked-launch/inbox notes, queue alternatives and audit hooks. Unknown flags,
missing values and invalid scopes fail before acquisition. `--fresh` refreshes account observations through authenticated status interfaces
without exporting tokens, reading credential files or clearing restrictions.

Current acquisition refreshes individual stale/negative account readings through
authenticated read-only status commands; it never exports credentials or clears
restriction generations. No runnable company lane waits for a future quota
reset. Browser and ui-browser prefer observed free TRAE Playwright capacity, then
usable TTADK → browser-ready personal ChatGPT → Claude in Chrome. Personal quota asks only on devices with company
accounts. Desktop: TTADK → browser-ready ChatGPT. --signing uses ordinary full-access Codex company workers for registered
own-test packages and allowlisted identities; the resident Claude signer is retired.

Main's browser bridge configures Playwright per thread for TRAE start and turn,
through scripts/playwright-extension-mcp.mjs. Only the launcher reads the pairing
file. There is no --allowed-origins flag: allowed sites and read/write scope are
stated to the worker and are not technically enforced on TRAE. Irreversible
actions retain user confirmation. Desktop tasks never use TRAE or Claude.

Launcher setup has a bounded deadline with connecting: output. Follow-up turns
inherit saved launch context through scripts/lib/worker-launch.mjs and print
inherited: evidence. scripts/lib/worker-model.mjs records requested, effective
and actual model provenance (actual-model:); reviewer model guards remain intact.
The hub supervisor preserves a live hub after a slow probe, and generated launchd
accounts retain their render-hub-launchd configuration.

Printed commands use `<workspace>` and `<task dir>` unless `--cwd`/`--task-dir`
provide absolute resolved paths. One-shot exec always includes
`--skip-git-repo-check`; failed startup prints the stderr tail and records a failed
worker event. `--network on|off` carries the requested access without widening
filesystem permissions, including read-only workers. Device/account notes follow
the resources registered here. Browser workers use the tools their own harness
lists; Claude-in-Chrome device IDs belong only in Claude briefs. A thread whose
saved permission denies the target site needs a new thread with
`--browser-origins`.

Failed or partial account reads retain independent public last-good readings in
`quota.json.routing-last-good.json`, marked stale with the original sample time.
Atomic replacement and a nonblocking merge lock preserve that file across partial
or locked quota-cache writes. TTLs and current health/restriction gates still
apply; fallback never renews an observation or clears a denial. Claude's declared
harness catalog remains present when usage is UNKNOWN, so Claude-only work reports
the account-state blocker. No last-good observation means UNKNOWN.

Launch audits compare the project/name and routed seat (including second reviewer)
against account/model/effort/sandbox on start and continuation. Mismatches emit one
warning, a `launch-mismatch` row, and nightly audit evidence. Only a company pick
replaced by personal quota without a user reference on its routed decision blocks
launch. References are free text recorded verbatim, not verified consent. Nightly
review launches the router's executable command/seat and records blocked plans;
it cannot supply its own personal-quota override.
