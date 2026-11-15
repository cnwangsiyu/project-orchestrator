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

Retries use the actual prior tuple (`--actual vendor:model:effort@account`, or
sanitized task-owned attempt metadata), never a ladder rebuilt from the current
catalog. Missing history falls back to the first category rung with an explicit
why note, after task launch/reroute metadata and the last named route decision. Every replacement must satisfy all actual
floors, exclusions and confirmed-cancellation requirements. Automatic hops are
company-only, owner-preserving, and capped at two.

Personal quota asks first. --urgent --user-ok <reference> records one user yes
and produces a command; image generation and Claude-only tools retain standing
permission. Max effort outside TTADK, Fable and reset redemption keep separate
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

An opportunistic transfer from a ready TTADK account needs a fresh TRAE reserve
of at least 15% (or an explicitly free bucket), load below 60%, and family queue
at most 300. Normal work requires fresh load; light/low/throwaway work may use an
unknown load. Triggers are low-priority work, TTADK projected to run out before
reset, or TRAE reset within six hours with a larger remaining share. Browser,
desktop, device, local build and hard security work do not use this transfer rule.
Measured per-model progress/drain remains the basis for ETA decisions. TTADK
reset within four hours and projected use below 70% preserves its expiry priority.
Unknown or depleted TRAE buckets remain bounded low-priority capacity when needed.

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
reset. Browser order: TTADK → TRAE Playwright Extension → browser-ready personal
ChatGPT (ask) → Claude in Chrome (ask). Desktop: TTADK → browser-ready ChatGPT
(ask). --signing uses ordinary full-access Codex company workers for registered
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
