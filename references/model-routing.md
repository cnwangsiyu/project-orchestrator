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
| Codex **Astra** | 5 (10x on cached input) | Frontier, +2–5 points over Sol; best on Terminal-Bench-Science (64.6%) | Hard work on a free company lane (2026-11-16 trial); escalation after Sol; a strongest-GPT second opinion; numerical or scientific work | Personal default without scoped OK; small tasks (it over-tests and asks questions) |
| Codex **Terra 6.1** | 0.5 | Writing and visual understanding; not a coding model (TB4 32% at `medium`) | Bulk prose drafts, translation, reading screenshots or images, writing when Claude has no spare | Coding; desktop work (Terra is not qualified for the supported TTADK/ChatGPT runtime) |
| Codex **Luna** (`gpt-6-luna`, personal ChatGPT) | 0.05 | Extraction and classification; very weak at coding (TB4 13% at `max`) | Personal lookup/extract; image-gen starts at low because the image tool does the work (standing permission, no question) | Any code change or code reasoning |

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
Malformed nested state becomes UNKNOWN for that account. Before a live browser,
ui-browser or desktop decision, TTADK and ChatGPT need a fresh local runtime check:
ChatGPT.app exists, the account's configured node_repl command is executable,
and browser work has a connected Chrome extension host. Cached browser flags
cannot override a failed check. The route explains the excluded account's reason
and keeps the usual fallback order and personal-quota approvals. Desktop does
not require the Chrome host; TRAE and Claude have no desktop path. Offline replay
uses supplied runtime observations without host probes. Runtime facts expire
after 30 seconds and contain no environment or provider configuration values.
`quota.mjs` text/JSON and `codex-worker status` expose fresh per-account Codex
browser runtime readiness independently of the usage cache.

Each account uses its newest catalog release for the Sol and Astra policy choices.
As observed on 2026-11-23, main and b list `gpt-6.2-sol` and `gpt-6.2-astra`;
the catalog does not make b eligible for new personal work. TRAE offers
`gpt-6.2-sol`, `gpt-6.1-sol` and `gpt-6-astra`; its current Sol choice is 6.2.
The provider daily-quota name `gpt_6_2` maps to `gpt-6.2-sol`, including when
the provider's model-to-quota mapping omits that entry. TTADK offers
`gpt-6.1-sol` and has no Astra entry. Company-lane comparison uses the qualified
Sol/Astra class, not identical release IDs across accounts.
The separate 5.6-Sol fallback retains its own quota bucket and tier.
Scoped Astra approvals and the hard-tier standing decision cover the family.

Company accounts remain first. Hard work stays on qualified Sol/Astra (or the
explicit adversarial non-GPT exception); light work uses the light list and
preserves known free capacity. ETA compares model-specific drain/progress and
known TTADK resets. Fresh positive queue position with zero drain, or waiting
without progress, is STALLED with no finite ETA and ranks after runnable lanes.
Only absent/stale telemetry uses the optimistic unknown fallback. A reset decision includes deferUntil, an owner and ledger/timer
instructions. Queued, unknown or delayed company lanes on either provider carry bounded queue patience and qualified company alternatives. No resource is
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

Personal quota asks first on devices with a registered TTADK or TRAE account,
except for the dated priority window or the standing personal Codex fallback
approved on 2026-11-17. The fallback's
default is `references/personal-fallback.json`; `_shared/personal-fallback.json`
overrides it (`PERSONAL_FALLBACK_FILE` selects a fixture/alternate file). Set
`enabled: false` to revoke it. The data records `userDecisionRef`, `since`,
`enabled` and `queueWaitMinutes` (default **5 minutes**, user: “干脆 5 分钟就算久好了，最近 codex 余额有点多”).
The quota gate passes when all qualified company options are exhausted, restricted
or excluded after infrastructure failures, or the best company option is a TRAE low-priority lane with predicted
start **over 5 minutes**, including a flat/stalled queue, and no faster company
option exists. Company capacity available within the threshold still wins.
Manual exclusions of healthy company accounts retain the scoped quota gate.
UNKNOWN/stale status alone keeps the question; retained explicit exhaustion or
restriction evidence can support fallback without freshening status or surviving
a known quota reset. Ready/progressing depleted TRAE lanes remain company capacity.
The same data records `allowHardPersonalAstra`, `hardAstraDecisionRef` and the
user's decision “特别难的任务用 astra 也不用问我，直接用吧”. Personal Astra's gate
passes for `tier === 'hard'` only while these fallback conditions hold, and the
plan names the hard-tier Astra standing decision; qualified ready personal Astra
is preferred for a hard-tier fallback. Normal-tier Astra still asks;
company capacity within the threshold still wins. Set `allowHardPersonalAstra: false`
to revoke just the Astra permission, or `enabled: false` to revoke the whole policy.
Personal Claude/Fable, personal max, reset redemption and explicit
review/security classes retain their separate gates. Fallback plans explain the
company blockers/queue wait and record
`approvalRef: standing:personal-fallback-2026-11-17`; launch-audit accepts the
routed seat without `--user-ok`. Replay snapshots carry their own policy data.
Without company accounts, personal ChatGPT is the default lane with standing
permission; eligible accounts with deadlines within 48 hours rotate under the
CLI counter, otherwise the earliest deadline wins. Ordinary Claude still asks. `--urgent --user-ok <reference>` only references a real matching scoped approval; it does not establish one; image generation and Claude-only tools retain standing
permission. Astra on personal ChatGPT needs its own scoped OK outside the enabled
hard-tier standing fallback. Hard-tier Astra also has standing permission on a
personal-only device; normal-tier Astra still asks there.
A runnable non-Astra escalation wins and
identifies Astra as a gated alternative; qualified TRAE Astra stays ungated.
Account-less explicit actuals keep the account UNKNOWN and retain the supplied
model/effort floor. Max effort outside company accounts (TTADK and TRAE), Fable and reset redemption keep separate
authorization. An eligible company primary launches while a gated personal
second reviewer awaits the user's answer before acceptance.

The user's 2026-11-21 clarification makes an `exclusive` personal-priority
window overflow-only: company lanes go first through the existing quality
ladder, free-TRAE/TTADK preferences and queue threshold. Personal quota is used
when company lanes cannot serve the task because of exhausted quota, excessive
queue/congestion or a missing required model/capability. During the window,
new personal Codex work goes only to `main`; `b` remains code-refused. If main
also cannot serve the task, defer with `[personal-main-wait]`. Claude-only
tools retain their route. Hard-tier Astra on main uses its separate enabled
standing decision; max effort, reset redemption and explicit review approvals
retain their separate gates.

The recorded decision lives in `_shared/personal-priority-window.json`; keep
its fields and the user's verbatim quote. Its inclusive start and optional
exclusive expiry (`until: null` means until revoked) bound the window. An
exclusive window follows main across reset-card redemption, requires fresh
weekly quota and at least 5% launch headroom, and restricts personal overflow
to main even when main is unavailable. Window-backed picks explain "company
lanes first; personal overflow only on main under the standing routing window"
and record the standing decision reference.

The legacy `prefer-first` mode still prefers ready, qualified main until the
specified expiry. It pauses at 90% weekly use, 95% projected use at reset or
when fresh weekly usage for that reset is unavailable. Both modes preserve
model, scope, capability, retry and independent-review checks.
Only install a window for a recorded user decision. Use the same
`RULES_SHARED` as the router, or omit it for the default shared directory.

```sh
node scripts/personal-priority.mjs add 'FROM_UTC_ISO' 'UNTIL_UTC_ISO' 'standing:personal-priority-DECISION' 'VERBATIM_USER_QUOTE'
node scripts/personal-priority.mjs add 'FROM_UTC_ISO' none 'standing:personal-priority-DECISION' 'VERBATIM_USER_QUOTE' --mode exclusive --exhaust-at-used 99
node scripts/personal-priority.mjs inspect
node scripts/personal-priority.mjs revoke 'standing:personal-priority-DECISION'
```

A window may carry `"exhaustAtUsed": N` (90–100). This replaces the default
90%/95% guard in `prefer-first` mode with a used-percentage threshold. In
`exclusive` mode the default spend-until threshold is 99%; the separate 5%
launch-headroom requirement still applies. Missing or stale weekly usage
refuses main. This field never changes exclusive mode's company-first order.


Review policy: Mandatory review is ONLY explicit --review-class A|B|C|D plus --review-reason: A a version that reaches external users and cannot be rolled back within hours; B login/auth/permission/signing logic; C irreversible data operations or billing/quota accounting; D a named adversarial review. High stakes, installation and fallback authorship alone do not qualify. Use `--review-reason` and optional stable `--review-scope`. Without a class, review-high downgrades with a note. Release impact is class A only; profiles without external release normalize other release requests to service. Internal-demo never blocks explicit classes or requires profile-override. Routine work uses tests, or one optional ordinary review when tests cannot cover it. Classified adversarial/review-high/release reviews require independent families; adversarial uses two non-GPT families. Required seconds are acceptance obligations and do not hold a runnable company primary.

At most two rounds per task/branch scope; no --review-override escape. Re-reviews check blocked findings. Targets: video-agent 10%, vesdk-mainline/webview 20%; aggregate share is observational. Optional excess warns and still dispatches; mandatory reviews remain. Outcome recording accepts `--review-result blocking|none`; interim notes `review: blocking found` / `review: none` are recognized. Unknown yield remains UNKNOWN.

Profiles live in `references/project-risk-profiles.json`. Video-agent uses package tests/typecheck/SG prepare and has no external release by default; SSO/employee admission, real deletion/retention and quota charging/refunds use explicit B/C, future production release A. Vesdk-mainline target 20% covers explicitly classified shipped mainline, concurrency/locks, signing and pre-merge review. Credential/device/lock and production approval rules remain.

The API and acquisition boundary are documented in `scripts/lib/pipeline/README.md`.
There is no legacy mode, shadow runner or per-category switch.

## Company capacity and execution

TRAE foreground tier lists are:

| Tier | Qualified preference |
|---|---|
| Light | GPT-5.6-Terra, GPT-5.5, DeepSeek-V4.1-Flash |
| Normal | Current Sol, GPT-5.6-Sol, GPT-5.6-Terra, DeepSeek-V4.1-Flash |
| Hard | Astra on a free company lane, then current Sol |

Walk the tier ladder in quality order across all company accounts. Select the first model class with a free lane; depleted-but-ready/progressing low-priority lanes count. For that class, free TRAE wins, including when TTADK quota expires soon; expiry is an advisory opportunity, not an override of company-lane order. If TRAE is congested/queued/stalled, use free TTADK for that same class before stepping down. Priority quota is at most a same-class lane tie-break, never a reason to downgrade Sol to Flash. Light work stays on its qualified light ladder; hard work never demotes. TRAE Gemini and `gpt-5.6-luna` are excluded; personal ChatGPT `gpt-6-luna` remains the first lookup/extract/image-gen choice; TTADK fresh catalog and historical model evidence remain.

Trial from **2026-11-16**, revisit **2026-11-23** with hard-tier first-pass success
and rework/fix rounds by model. Start hard tasks on company Astra when
its lane can start now with fresh model load <60% and no queue/stall. TRAE does
not normally publish Astra load: for Astra only, fresh daily units remaining,
a healthy hub and no fresh queue/stall evidence in lane/family telemetry or
recent Astra turns qualify instead. Recent queue-status and worker-health records
retain model attribution; Sol success does not clear an Astra queue signal.
Without published load, depleted, stale or missing Astra units do not qualify.
The why line names the units/no-queue evidence instead of quoting a sibling load. If Astra is
congested, queued or stalled (including a depleted daily bucket's low-priority
lane), try free Sol on TRAE, then TTADK under the existing same-model expiry rule.
Depletion alone does not exclude a free lane. If neither model is observed free,
retain the existing Sol fallback, ETA and personal approval behavior. The trial
leaves normal/light tiers, image-read, adversarial and capability rules unchanged.

Retries retain every actual model/effort floor. After Sol fails, prefer its next
effort on a free company lane, including ungated `max`, then qualified Astra at
an effort meeting the Sol floor. After Astra fails, increase Astra effort
(`high` → `xhigh` → `max`); Sol cannot satisfy an actual Astra floor. Exhausted
Astra `max` cannot restart on Sol or repeat its quality step automatically.
Personal Astra outside the hard-tier standing fallback and personal `max` still need independent scoped approvals.
Count-only retries without actual history retain the pre-trial Sol category/effort
assumption; the trial never invents an earlier Astra attempt from today's catalog.
The retained Sol preference uses known actuals for the same task and role;
planned records and attempts from another task or role do not change it.

Vision uses its separate qualified catalog. DeepSeek is unsuitable for full builds,
executable/auth/storage acceptance or a large file in one output. Seed is vision
only. Public catalog, account and harness capabilities must all support the task.

An observed free TRAE lane takes precedence over TTADK for work that its actual
model and harness can do, including browser/ui-browser on the ready Playwright
lane and depleted-bucket low-priority work. The lane must start now, have a fresh
load below 60% for that candidate model (or Astra's units/no-queue evidence above), and show no queue or stall. This preserves
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
telemetry is UNKNOWN; it does not prove the lane is free. TRAE expiry is model-bucket-specific, with its own fresh reset/usage evidence and unit, independent of TTADK share, and only ranks within the chosen quality model.

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

Registered own-test signing uses ordinary full-access Codex-family workers subject to the applicable quota policy. They check the existing package registry and identity allowlist. The resident
Claude signer is retired. All workers use installed, signed-in tools without
opening credential or session files.

CLI launch output retains account/model/effort, sandbox, owner, route arguments,
tracked-launch/inbox notes, queue alternatives and audit hooks. Unknown flags,
missing values and invalid scopes fail before acquisition. `--fresh` refreshes account observations through authenticated status interfaces
without exporting tokens, reading credential files or clearing restrictions.

Current acquisition refreshes individual stale/negative account readings through
authenticated read-only status commands; it never exports credentials or clears
restriction generations. No runnable company lane waits for a future quota
reset. In normal order, browser and ui-browser prefer observed free TRAE Playwright capacity, then
usable TTADK → browser-ready personal ChatGPT → Claude in Chrome. Personal ChatGPT asks on company devices; ordinary Claude asks on every device. Desktop: TTADK → browser-ready personal ChatGPT (ask), never TRAE/Claude. --signing uses ordinary full-access Codex-family workers subject to quota gates for registered
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
lists; Claude-in-Chrome device IDs belong only in Claude briefs and are candidates until the
target-machine loopback URL/expected token proof succeeds. Start `browser-identity.mjs serve --once`
on the target, try connected ids in new verification tabs, and block if no page matches. Names,
`isLocal`, remembered ids alone and a sole browser do not prove identity. After proof stay on that browser.
A thread whose
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
launch. References are recorded verbatim and identify a stored scoped approval or
the router's applicable standing personal-fallback policy; urgency alone never authorizes personal quota. Nightly
review launches the router's executable command/seat and records blocked plans;
it cannot supply its own personal-quota override.

Release impact means class A only: a version reaches external users and cannot be rolled back within hours. Reading/writing local or user data is not release; real irreversible data operations are class C. Personal/family apps, internal demos and PPE/test packages, or features that only read existing data are not release.

Project review defaults: `references/project-risk-profiles.json` has a `default` entry for new projects and named `profiles`. To disable optional review for a selected project, add `"<project-slug>": {"profile": "no-review"}`. To make it the new-project default, change `default.profile` to `no-review`. User decisions 2026-11-15 assign evelyns-world and acq (“evelyn 和获客都免审查吧”), and autotrader for now (“autotrader 也先免审查”). acq is its only key. New-project default remains standard; revisit autotrader when the user says. No-review projects print “no review (project profile no-review): accept on tests/build” and nightly reports counts without a review-share target. Such a project prints no review requirement or reviewer without an explicit A–D class and reason; a direct unclassified review request reports PROJECT_NO_REVIEW. Explicit user-requested classes override it.

## Failure and launch details (changed 2026-11-15)

`--failure-kind quality|tool|infra` defaults to quality and is recorded on the route. For browser/desktop tool failures, carry `--failures` and the known `--actual` tuple: the failed channel is excluded rather than raising effort there. Browser order remains observed free TRAE → TTADK → browser-ready personal ChatGPT (ask) → Claude (ask); desktop omits TRAE/Claude. Earlier quality failures keep their floor. `--dry` uses cached observations without refresh/probes and prints the cache age.

Browser routes require explicit `--browser-origins` (`--origins` alias); project `browserOrigins` merge with policy defaults and the supplied sites. Desktop scope accepts `--computer-use-apps` (`--apps` alias). These flags are preserved in worker launches and route args. Claude launches use `--trusted-cwd`, otherwise the configured project root; the prompt names the working directory. An unconfigured root keeps the supplied working directory and prints a note to verify trust or pass --trusted-cwd. Browser workers check the installed extension/host or the Playwright connect before the turn, within a few seconds; `--no-browser-preflight` skips it.

Read-only browser workers return their report in the final message. The launcher
writes `--out` (including codex-last.md), event logs and public status outside
the worker sandbox. A brief needing worker-created screenshots or other evidence
files must request `--sandbox workspace-write` and keep those files separate from
`--out`. Browser routing therefore retains read-only by default; report-only work
does not need a wider sandbox.

Historical benchmarks, bucket facts, Kimi-K3 rationale and dated user decisions are in [model-evidence.md](model-evidence.md). Its superseded policy passages are marked changed 2026-11-15; the current pipeline is authoritative.
