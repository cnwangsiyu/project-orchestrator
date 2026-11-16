# Skill slimming inventory (2026-11-16)

Source: project-orchestrator `85739a2`, SKILL.md lines 1–859 (91,025 bytes). Source line numbers
below are pinned to that commit, not the shortened file. This is a review/audit artifact, not
another runtime policy source. Current SKILL.md + the injected digest govern; historical wording
listed here does not reactivate a superseded rule. No scripts or nightly-review.md were edited.

## Keep / move / delete

Every original line belongs to exactly one interval below. Moving means using the existing
fitting reference or help where it already explains the rule; it does not imply copying every
duplicate payload. Safety and user decisions remain independently mapped below.

| Original lines | Section | Disposition | Current destination |
|---|---|---|---|
| 1–24 | Identity, project scope and workers | Keep | SKILL.md introduction |
| 25–32 | Tracked launch, watch and inbox | Keep judgment; move mechanics | SKILL.md orchestrator behaviour; worker-inbox.md; worker-operations.md#identity-launch-and-follow |
| 33–58 | Project ownership and first principles | Keep; remove obsolete strongest-main-model claim | SKILL.md orchestrator behaviour; worker-operations.md#orchestrator-models |
| 59–70 | Startup, reconciliation and idle hints | Keep decisions; move commands | SKILL.md project state; worker-operations.md; resources.md#live-idle-hints |
| 71–88 | Global ownership/digest index/rollout | Keep ownership; delete duplicate policy summaries | SKILL.md policy ownership; global-rules.md; rules-enforcement.md |
| 89–107 | Project/resource discovery | Keep | SKILL.md project state and planning |
| 108–137 | Context budget and report summary | Keep judgment; move measurement mechanics | SKILL.md orchestrator behaviour; worker-operations.md |
| 138–158 | Coupling/parallel work and concurrency | Keep; delete duplicated browser/account ladder | SKILL.md orchestrator behaviour; model-routing.md; codex-workers.md |
| 159–166 | Worker vs subagent delegation | Keep | SKILL.md orchestrator behaviour; global-rules.md Worker Rules |
| 167–177 | Ledger/state/reconciliation | Keep schema decisions; move follower commands | SKILL.md project state; worker-operations.md |
| 178–193 | Self-contained brief/report/git rights | Keep; replace obsolete worker-direct-user-card mechanism | SKILL.md briefs/safety; worker-operations.md; worker-inbox.md |
| 194–217 | Acceptance and build-brief preflight | Keep Acceptance/30-second check; delete duplicated injected build clauses | SKILL.md briefs/build decisions; resources.md#build-and-cache-execution; res-contract.md |
| 218–234 | Scope/backup/device injection | Delete duplicated fixed clauses; retain orchestration boundaries | SKILL.md safety; global-rules.md Worker Rules; resources.md |
| 235–265 | Credential/signing/console authorization | Keep decision/preflight; delete duplicated injection payload | SKILL.md safety; global-rules.md Worker Rules; codex-workers.md; rules-enforcement.md |
| 266–275 | Expensive-launch evidence | Keep | SKILL.md write briefs that prevent rework |
| 276–290 | Target artifact, flags and deploy rollback | Keep | SKILL.md #done-on-target/#feature-flags-before-merge/#deploy-release-briefs |
| 291–304 | Shared failure contract/fix rounds | Keep; move outcome flags | SKILL.md briefs/rework; worker-operations.md#outcome-corrections |
| 305–317 | Same-task original thread exception | Keep judgment; delete duplicated execution-recording mechanics | SKILL.md #rework-thread-rule; worker-operations.md |
| 318–349 | Security/adversarial/defensive decisions | Keep content boundaries; move exact routes/telemetry | SKILL.md safety; global-rules.md Worker Rules; model-routing.md; codex-workers.md |
| 350–354 | Pilot device/sampling matrices | Keep | SKILL.md briefs |
| 355–360 | Review classes and scope | Keep | SKILL.md acceptance and review classes; review-rubric.md |
| 361–375 | Automatic outcomes/manual corrections | Keep correction judgment; move formats/flags | SKILL.md acceptance; worker-operations.md#outcome-corrections; worker-operations.md Outcome corrections / outcome source header |
| 376–393 | Memory and task capability | Keep judgment; move report/input mechanics | SKILL.md briefs/routing; worker-operations.md#brief-inputs-and-reports |
| 394–451 | Route TaskSpec and flags | Keep judgment inputs; move parser/flag/mechanics details | SKILL.md routing table; model-routing.md; worker-operations.md (TaskSpec/route --table) |
| 452–540 | Candidate ladders, accounts, buckets, retries and queue exits | Delete superseded/duplicated ladders; move remaining mechanics to existing references/help | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 541–550 | Follow executable route and approvals | Keep decisions; move command/audit detail | SKILL.md routing; worker-operations.md |
| 551–577 | Nightly/quota goals/actions | Keep user gates/goals; delete duplicated calculation descriptions | SKILL.md routing/policy; model-routing.md; model-evidence.md#quota-policy-user-2026-11-03; nightly-review.md (unchanged) |
| 578–599 | Context reuse, workspaces and retention | Keep decisions; move creation commands | SKILL.md project state; worker-operations.md#workspaces; resources.md#review-and-retention |
| 600–619 | Build/device classification | Keep local/remote judgment; correct obsolete version claims | SKILL.md #build-discipline; resources.md#heavy-lock-contract; res-contract.md (installed state authoritative) |
| 620–660 | Locks/gates/wrapper/PID/reclaim/takeover | Move mechanics; delete duplicated locked-in clauses | res-contract.md; resources.md#build-and-cache-execution; resources.md wrapper flags / res take-build --help; global-rules.md Worker Rules |
| 661–694 | Build/cache/device scope and acceptance | Keep boundary decisions; move exact cache flags/paths | SKILL.md safety; resources.md#build-and-cache-execution; global-rules.md |
| 695–705 | Shared resource authority/priorities | Keep judgment; move command formats | SKILL.md #shared-resources; res-contract.md; resources.md |
| 706–729 | Conflict integration/merge/user changes | Keep | SKILL.md integration/safety; worker-operations.md#workspaces |
| 730–748 | Permission planning and communication | Keep; align cards with secretary/direct-no-group distinction | SKILL.md safety/integration; global-rules.md |
| 749–770 | Tools/Claude launch/injection/audit | Move; replace exact launch construction with printed executable output | worker-operations.md#identity-launch-and-follow; rules-enforcement.md; worker-operations.md (TaskSpec/route --table) |
| 771–781 | Settings and prepared workspace | Move; keep settings non-mutation boundary | worker-operations.md#orchestrator-models/#workspaces |
| 782–810 | Res commands/notes and git worktrees | Move; discard obsolete policy-force/session-only reclaim advice | res-contract.md; resources.md; worker-operations.md#workspaces; SKILL.md safety |
| 811–849 | Notifications/lifecycle/offline/research/Codex | Move mechanics; keep route eligibility/context choice | worker-operations.md; worker-inbox.md; codex-workers.md; SKILL.md project state |
| 850–859 | Duplicate dependency/release/profile/history/checklist appendices | Delete duplicates; keep every decision once | SKILL.md briefs/review/safety; model-routing.md; model-evidence.md; rules-enforcement.md |

## Every user-attribution line

This is the exhaustive original-line inventory of explicit user/date decisions, user-approved
rules, pre-approval and Chinese user quotations. Continuation lines retain their enclosing rule's
destination. Generic mentions such as “ask the user” are safety/authorization rules, covered below.

| Source line | Original attribution / quotation | Current rule destination |
|---|---|---|
| 4 | Turn the current conversation into the orchestrator ("主对话") for one project: the user only | SKILL.md introduction |
| 41 | **Judge from first principles, with the whole picture** (user, 2026-11-10: "我给所有主对话都用的是最强模型， | SKILL.md orchestrator behaviour; worker-operations.md#orchestrator-models |
| 42 | 我希望他们具有敏锐的判断力，也知道最全的 context，遇到问题多从第一性原理来思考问题并及时提出更根本的解法，别只陷在细节里出不来"). | SKILL.md orchestrator behaviour; worker-operations.md#orchestrator-models |
| 73 | User, 2026-11-13: the routing/global-rules orchestrator owns global policy here (「都交给他来负责，让他统一管理」); the secretary only relays, keeps ledgers and asks decision cards, never owns or changes policy. | SKILL.md policy ownership; global-rules.md; rules-enforcement.md |
| 80 | - **TRAE:** [account rules](references/codex-workers.md#trae-cli-as-the-second-company-account-user-2026-11-08) separate restrictions from concurrency/quota, never reduce concurrency for queues, enforce only QPM/TPM limits for LLM use (no total-cost caps), and name the concrete worker model in reports. | SKILL.md routing/quota; codex-workers.md TRAE account rules |
| 83 | - **Orchestrator models:** [account/model health](references/nightly-review.md#account-and-model-health) records persistent `jobs/&lt;id&gt;/state.json` `respawnFlags`, VAK/routing on Fable, Webview/Lynx on Opus since 2026-11-11, and a user check on/after 2026-11-17 09:00 PST. | SKILL.md all-opus rule; worker-operations.md Orchestrator models (old assignments/check superseded) |
| 108 | &lt;a id="judge-not-labour"&gt;&lt;/a&gt;**Protect the orchestrator's context: judge, don't labour** (user, 2026-11-05; repeated 2026-11-11 and reaffirmed 2026-11-13: "主对话别自己去干活，只做判断，活让 worker 去干"; the nightly review now also counts source edits — Edit/Write or shell writes in a code checkout — and test/build runs by the orchestrator itself). This session is the | SKILL.md orchestrator behaviour; worker-operations.md |
| 138 | &lt;a id="split-by-coupling"&gt;&lt;/a&gt;**Split by coupling, run what is independent in parallel; don't wait on one thing** (user, 2026-11-11; reaffirmed 2026-11-13: | SKILL.md orchestrator behaviour; model-routing.md; codex-workers.md |
| 139 | "之后让他们都把一些能并行的事项并行起来做，记住，别老是阻塞在那等着"; | SKILL.md orchestrator behaviour; model-routing.md; codex-workers.md |
| 140 | "当然，别为了并行去强拆任务，有耦合的任务请放一起做，只是没有依赖的任务可以拆出去，记住"). | SKILL.md orchestrator behaviour; model-routing.md; codex-workers.md |
| 154 | Company accounts have no concurrency cap. Don't lower TRAE concurrency for fear of its queue (user, 2026-11-11: | SKILL.md orchestrator behaviour; model-routing.md; codex-workers.md |
| 155 | "排队跟我们自己的并发没什么关系"): queueing comes from TRAE's overall load, not from how many tasks we run; a | SKILL.md orchestrator behaviour; model-routing.md; codex-workers.md |
| 157 | [TRAE CLI](references/codex-workers.md#trae-cli-as-the-second-company-account-user-2026-11-08)). | SKILL.md coupling/concurrency; codex-workers.md TRAE queue mechanics |
| 159 | **Delegate to workers, not subagents** (user, 2026-11-03). Whenever a background worker can do | SKILL.md orchestrator behaviour; global-rules.md Worker Rules |
| 202 | Launchers inject the fixed **build rules** automatically (user, 2026-11-13); the task brief supplies the concrete commands, lock IDs, wrapper identity and timeout: "Full-package builds use `scripts/heavy-build.sh &lt;command...&gt;` | SKILL.md briefs/build decisions; resources.md#build-and-cache-execution; res-contract.md |
| 218 | Launchers inject these fixed safety clauses automatically for work that writes or touches devices (user, 2026-11-04, after a worker overwrote a user header and another wiped test-app data): | SKILL.md safety; global-rules.md Worker Rules; resources.md |
| 236 | user-approved 2026-11-11 rule after a TRAE | SKILL.md safety; global-rules.md Worker Rules; codex-workers.md; rules-enforcement.md |
| 238 | login; the user had to sign in again; the second is the user's 2026-11-13 test-signing authorization): | SKILL.md credentials/own-test signing; global-rules.md adjacent Worker Rules; rules-enforcement.md |
| 244 | `~/.claude/orchestrator/_shared/user-signing/registry.json`, using only identities on the user-approved allowlist | SKILL.md safety; global-rules.md Worker Rules; codex-workers.md; rules-enforcement.md |
| 257 | - **Console access preflight** (user-approved 2026-11-11 retro; W291-L1c needed signed-in consoles on headless TRAE): | SKILL.md safety; global-rules.md Worker Rules; codex-workers.md; rules-enforcement.md |
| 261 | - **Test signing route** (user, 2026-11-13): pass `--signing`; it forces full access and makes the scoped rule the first | SKILL.md safety; global-rules.md Worker Rules; codex-workers.md; rules-enforcement.md |
| 266 | **Prevent rework at the brief** (rework retro of 2026-11-06–10, 89 rework chains; user-approved 2026-11-10). Most | SKILL.md write briefs that prevent rework |
| 274 | you have: missing login access or anything outside the registered test-signing scope is one card to the user, never | SKILL.md write briefs that prevent rework |
| 281 | paths intact (user-approved 2026-11-11 retro; W291-L1g smokes bypassed an unpackaged worker); fakes may replace external | SKILL.md #done-on-target/#feature-flags-before-merge/#deploy-release-briefs |
| 283 | - &lt;a id="feature-flags-before-merge"&gt;&lt;/a&gt;**Feature flags before merge** (user-approved 2026-11-11 retro; W291-L1 landed OFF/build checks but could not activate): | SKILL.md #done-on-target/#feature-flags-before-merge/#deploy-release-briefs |
| 287 | - &lt;a id="deploy-release-briefs"&gt;&lt;/a&gt;**Deploy/release briefs** (user-approved 2026-11-11 retro; W291-L1-ppe2a mistook normal WS/mediaScope for a crash loop): | SKILL.md #done-on-target/#feature-flags-before-merge/#deploy-release-briefs |
| 301 | rounds (user, 2026-11-13), not the full matrix; the target-artifact acceptance gate still applies. If the second fix of a task brings a | SKILL.md briefs/rework; worker-operations.md#outcome-corrections |
| 305 | - &lt;a id="rework-thread-rule"&gt;&lt;/a&gt;**Rework thread choice** (VAK rulings, user-approved 2026-11-13). Route the fix round first. | SKILL.md #rework-thread-rule; worker-operations.md |
| 318 | - **Security follows the worker's context** (VAK ruling, user-approved 2026-11-13). An implementation/fix round that | SKILL.md safety; global-rules.md Worker Rules; model-routing.md; codex-workers.md |
| 325 | - **Adversarial security reviews** (user decision 2026-11-13, option A). OpenAI's cyberPolicy blocked a TTADK | SKILL.md safety; global-rules.md Worker Rules; model-routing.md; codex-workers.md |
| 339 | - **Defensive security confirmation** (`--defensive`, user ruling 2026-11-13). On `review`, `review-high` or | SKILL.md safety; global-rules.md Worker Rules; model-routing.md; codex-workers.md |
| 355 | **Review only what is costly to undo, and record how each task ended** (user, 2026-11-15). | SKILL.md acceptance and review classes; review-rubric.md |
| 394 | &lt;a id="route-every-task"&gt;&lt;/a&gt;**Route every task with `scripts/route.mjs`; judge only what it can't** (user, 2026-11-03; work/quota rules reaffirmed 2026-11-13). Every new | SKILL.md routing table; model-routing.md; worker-operations.md (TaskSpec/route --table) |
| 418 | (user, 2026-11-12: "这种类型的任务排除掉 trae gpt 之后再按照路由规则来走就行吧，不需要写死一个路由"). This includes | SKILL.md routing table; model-routing.md; worker-operations.md (TaskSpec/route --table) |
| 458 | images) goes to Codex as `image-gen` (user, 2026-11-03). | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 462 | CLI with its own model pool), then personal quota (user, 2026-11-08). route.mjs moves TTADK's work | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 470 | - Normal/light fallback models (user, 2026-11-10): when the company account's GPT is out, route.mjs uses DeepSeek-V4.1-Flash, | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 476 | - Difficulty-tiered TRAE substitutions (user-approved 2026-11-13): hard (`implement-hard`, `debug`, `science`, | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 491 | - Free TRAE first (user, 2026-11-15): when the qualifying candidate's own model load is below 60%, | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 505 | - Never hold or postpone work on your own (user, 2026-11-09: "不要擅自决定去暂缓一些工作"), low-stakes | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 521 | - TTADK is not unlimited (measured 2026-11-08): about 500M tokens a day per user, input + output with | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 527 | (TTADK, TRAE) instead of `xhigh`; a failure still climbs to `xhigh` and `max` (user, 2026-11-09). | model-routing.md (current Astra-first trial); model-evidence.md (dated history); codex-workers.md; global-rules.md; worker-operations.md (TaskSpec/route --table) |
| 561 | own; user, 2026-11-03); | SKILL.md routing/policy; model-routing.md; model-evidence.md#quota-policy-user-2026-11-03; nightly-review.md (unchanged) |
| 568 | Its rules, from goals the user set on 2026-11-03: | SKILL.md routing/quota; model-evidence.md Quota policy |
| 596 | no worker space caps (user, 2026-11-13). Auto-clean only self-made build clones/templates/caches, and only when the | SKILL.md project state; worker-operations.md#workspaces; resources.md#review-and-retention |
| 600 | &lt;a id="build-discipline"&gt;&lt;/a&gt;**Build and device environment discipline** (user-approved; heavy-build lock live 2026-11-13, | SKILL.md #build-discipline; resources.md#heavy-lock-contract; res-contract.md (installed state authoritative) |
| 622 | metrics return 1, no acquisition). User-approved entry load (2026-11-13, secretary option A): | res-contract.md; resources.md#build-and-cache-execution; resources.md wrapper flags / res take-build --help; global-rules.md Worker Rules |
| 681 | stays ambiguous without task evidence. Send each project its cases; tune only within evidenced, dated user-approved | SKILL.md safety; resources.md#build-and-cache-execution; global-rules.md |
| 702 | and wait; never use a held resource. Schedule devices **short/urgent first, long/low-priority later** (user, 2026-11-13); | SKILL.md #shared-resources; res-contract.md; resources.md |
| 717 | pre-approved merging verified task branches into branches the ledger marks as project-owned: have | SKILL.md integration/safety; worker-operations.md#workspaces |
| 730 | &lt;a id="permission-plan"&gt;&lt;/a&gt;**Plan around permissions before you dispatch** (user, 2026-11-05; tightened 2026-11-13). | SKILL.md safety/integration; global-rules.md |
| 755 | It prints `backgrounded · &lt;id&gt; · &lt;name&gt;`. Always pass Remote Control and explicit **Bypass** (user, 2026-11-13): | worker-operations.md#identity-launch-and-follow; rules-enforcement.md; worker-operations.md (TaskSpec/route --table) |
| 771 | - &lt;a id="claude-worker-settings"&gt;&lt;/a&gt;**Claude worker settings** (user, 2026-11-13; document only): | worker-operations.md#orchestrator-models/#workspaces |
| 851 | **Never ask for dependency installation** (user, 2026-11-15: “下载依赖这种事情不需要问我，直接下就好了”). Project dependencies and build tools fetched through normal package managers and registries (npm/pnpm/yarn, pip/uv, gradle/maven, CocoaPods/SPM, cargo, go modules, brew formulae, and SDK/toolchain components the build asks for) are installed directly into the task workspace or user-level caches, without a card or question. No secrets/credentials, production changes without a card, unapproved personal quota, or system security changes; a required login the worker lacks is BLOCKED. | SKILL.md briefs/review/safety; model-routing.md; model-evidence.md; rules-enforcement.md |
| 855 | Project defaults are configured in `references/project-risk-profiles.json`: new projects retain the standard four-class policy. evelyns-world/acq and autotrader (for now) use the user-approved no-review profile: accept on tests/build and print no reviewer unless the user asks by explicit class/reason; nightly reports counts and excludes their review-share targets. | SKILL.md briefs/review/safety; model-routing.md; model-evidence.md; rules-enforcement.md |

Count: **55 original attribution/quotation lines**.

New approved rules: 2026-11-16 reading delegation lives in SKILL.md Orchestrator behaviour and
one digest Orchestrator Rules line; all main conversations use opus with routed Astra/Fable
reasoning in both files and worker-operations.md; secretary cards/status-from-tools in both files.
Older “strongest main model”, Fable assignments and planned Fable restoration are explicitly
superseded, with historical details retained in worker-operations.md#orchestrator-models.

## Safety and reserved-decision coverage

| Original source | Decision / boundary retained | Current location |
|---|---|---|
| 26–31, 130–151, 811–840 | Tracked/background launches, notification rather than foreground wait; reattach/re-arm, no duplicate worker | SKILL.md behaviour; worker-operations.md; worker-inbox.md (45 s debounce, deferred info/progress, waking risk/scope/ask) |
| 59–70, 167–177 | Reconcile one project owner/ledger; idle hints are advisory, no bypass/automatic dispatch | SKILL.md project state; resources.md Live Idle Hints; worker-operations.md |
| 73–87, 551–556 | Rules/global res owned by global-rules, secretary relay only; owner-controlled installation/rollout, unresolved recipients | SKILL.md integration; global-rules.md; rules-enforcement.md; nightly-review.md unchanged |
| 108–165 | Main judges/delegates execution and bulky reads; parallel independent tasks, coupled work together; no worker subagents/model switches | SKILL.md behaviour; global-rules.md |
| 178–217, 859 | Self-contained scope/git/access/acceptance/checklist; NOT-READY blocks dispatch; avoid overwriting --out deliverable | SKILL.md briefs; worker-operations.md; worker-inbox.md |
| 218–225, 726–728 | Never touch out-of-scope/user uncommitted files; byte-for-byte restore/report accidents, stage own files, no broad add/stash/reset | SKILL.md project state/safety/integration; global-rules.md Worker Rules (verbatim restoration) |
| 223–234, 688–694 | Device/simulator backup before destructive operation; readable iOS backup excluding protected SplashBoard, save-preserving over-install | SKILL.md safety; resources.md Build and cache execution; injected fixed iOS backup clause |
| 226–234, 688–694, 782–803 | Only iphone8/iphone11/s21; never personal/unregistered device, <=2 h lease, connected/unlocked; authorized own-app dialogs, no credentials/codes/purchases; route Codex prompt refusal to Claude | SKILL.md safety; global-rules.md Worker Rules; resources.md; res-contract.md device interface |
| 235–242, 257–260, 741–743 | No login files/sessions/tokens/cookies/profile/keychain access or login bypass, normal signed-in CLI/ssh/git allowed; project key only via project code/official service, no printing/export/copy/outside read | SKILL.md credentials/browser; global-rules.md Worker Rules (full adjacent clauses); rules-enforcement.md |
| 239–242, 416–425, 528 | No internal/private source/logs in public searches; TTADK search via local proxy | SKILL.md credentials; global-rules.md Worker Rules; codex-workers.md TTADK |
| 243–264 | Only existing manifest/hash own-test packages and dated allowlisted identities; H6, DH59R4RNRY/3JVMQQBHUR/2027-09, repo debug keystore; owner registry, workers read-only | SKILL.md own-test signing; global-rules.md; codex-workers.md; rules-enforcement.md |
| 249–256, 261–264, 742–743 | New identity/entry BLOCKED/new card; designated stdin/FD secret input only, no argv/env/log, no production/other-keychain signing; receipts, masked scans and re-lock | SKILL.md own-test signing; global-rules.md Worker Rules full text; rules-enforcement.md |
| 257–275, 455–457, 530–535, 730–743 | Exact signed-in origins/browser/apps/tools preflight; public/local headless is not console access; tools/access missing BLOCKED; no permission laundering/worker action handoff to user | SKILL.md safety; codex-workers.md browser/preflight; global-rules.md; secretary cards rule |
| 276–282 | Final artifact/server/session/build/core/runtime/loader/CI/permissions qualify Done; provider fakes only, device run finishes | SKILL.md #done-on-target |
| 283–286 | Flag ON/OFF from clean isolated state on final package; never wipe user data; missing proof NOT-READY | SKILL.md #feature-flags-before-merge; review-rubric.md |
| 287–290, 859 | Baseline/control/threshold/window/rollback/restoration fixed before deploy; unexpected evidence needs stronger judgment; exact continuation checklist | SKILL.md #deploy-release-briefs; injected deploy/build checklist |
| 291–304 | Shared contract/fixtures before parallel state adapters; at-most-once failure semantics; original/fix/neighbor checks, affected tests; second same-kind defect re-scope | SKILL.md briefs/rework; worker-operations.md correction causes |
| 305–317, 828–840 | Same-task context reuse only after route, floor/family/effort/account/capability/approval checks; no excluded/paused model, no independent-seat reuse | SKILL.md #rework-thread-rule; worker-operations.md lifecycle; global-rules.md |
| 318–349, 416–425 | Security content routes including fix context; defensive requirements alternative; ordinary rules/code stay ordinary; adversarial default/non-GPT pair; defensive review only, no conflicting flags; never GPT-retry policy block | SKILL.md security; global-rules.md Worker Rules (telemetry/exact paths); model-routing.md; codex-workers.md |
| 325–349 | Personal Claude/non-GPT fallback and incomplete required reviewer sets need user decision; executable evidence resolves disagreement; vendor access is user/company decision | SKILL.md security/review; global-rules.md; model-routing.md |
| 350–354 | Pilot matrix first; host-side lease/deadline/disconnect/settings return independent of final report | SKILL.md briefs/safety; resources.md; res-contract.md |
| 355–375, 853–855 | Explicit A–D/reason only, A external release/C irreversible local data, tests otherwise; preaction A/C/signing; frozen independent seats, P0/P1/three notes, two rounds/scope; target/profile exceptions | SKILL.md review; review-rubric.md; model-routing.md; global-rules.md |
| 361–375 | Automatic outcomes/model/yield; only correct judgment, UNKNOWN missing proof, queue-inclusive time, manual precedence | SKILL.md review/rework; worker-operations.md Outcome corrections; worker-operations.md Outcome corrections / outcome source header |
| 377–386 | Relevant memory explicit required inputs/durable lessons, no full-index dump | SKILL.md briefs; worker-operations.md Brief inputs and reports; applicable memory policy |
| 394–451 | Every launch/amendment escalates via router; hardest category, task facts, actual floors, no hand-selected model | SKILL.md routing; model-routing.md; worker-operations.md (TaskSpec/route --table) |
| 410–415, 426–447, 505–550 | Impact A-only release; env not location; background only no waiting/deadline; no resource queued, company-only confirmed cancellation bounded handoff, no duplicate/personal/signing auto-launch | SKILL.md routing/build decisions; global-rules.md Worker Rules; codex-workers.md; model-routing.md |
| 452–550 | Qualified capability model, no coding Luna/unsupported vision/build acceptance/oversized DeepSeek output; no quality downgrade or fixed manual ladders | SKILL.md routing/thread eligibility; model-routing.md; model-evidence.md historical restrictions |
| 497–527, 543–545, 557–573 | Company quota/max no card; personal/Astra/max/Fable/reset scoped gates; no invented OK/automatic hold; reset freshly approved each time, Codex expiry/Claude reserve goals | SKILL.md routing/quota; global-rules.md; model-routing.md; model-evidence.md Quota policy |
| 579–599, 716–728, 775–810 | Correct worktree base/one writer/builds write; project local fast-forward preapproved, shared/push/MR/post/force/unmerged deletion reserved; no user edits, existing denial not bypassable | SKILL.md planning/integration; worker-operations.md Workspaces; global-rules.md |
| 595–599, 664–665 | No worker disk caps; self-created build clone/template/cache cleanup only <1 TB/no active need; user/workspace deletion always card | SKILL.md retention; resources.md cleanup/build scope; global-rules.md |
| 600–660, 696–704, 782–803 | Shared res/live owner authority, no private locks, short/urgent-first, user resolves priority; registry does not authorize new personal device; disconnected lease not unlimited | SKILL.md #shared-resources/#build-discipline; resources.md; res-contract.md; worker-operations.md |
| 607–660 | Local heavy classification, pair atomic/no hold-and-wait, one watched process/PID, finite gate/wait/reverse cleanup, no active/unverified reclaim/other-task kill; same-task dead predecessor verified | SKILL.md build decisions; resources.md corrected Heavy Lock Contract/new Build and cache execution; res-contract.md; resources.md wrapper flags |
| 614–618, 632–649 | Remote/CI never local lock/throttle; local-only wrapper, no detached acquisition, resources returned before replacement | SKILL.md routing/build decisions; resources.md; global-rules.md Worker Rules; model-routing.md |
| 620–631, 638–644, 681–687 | Approved default 12/20/16 + optional 8/32, installed vs staged lane claim, UNKNOWN blocks, no bypass/automatic threshold changes; owner sample before install | SKILL.md build/policy; resources.md; res-contract.md authoritative configured gates; global-rules.md |
| 661–677 | Fixed per-base incremental, compile6/link1/Xcode6/Gradle2, one cold acceptance, no unnecessary native rebuild; scoped ccache/no broad HOME/reset/sloppiness, private Gradle/no secret daemon | SKILL.md build; resources.md Build and cache execution (exact commands/paths/flags); global-rules.md |
| 604–606, 678–687 | Guarded cleanup: continuous idle evidence, live/lease/all-owner releases, no PPID/age permission; telemetry never reclaim/restart/unknown-as-good | SKILL.md build/policy; resources.md Cleanup/Privacy and Installation; global-rules.md |
| 706–724 | Dependency-order integration, notify semantic/base changes, later worker resolves conflict; user decides intent clash; combined verification before deliver | SKILL.md integration; worker-operations.md Workspaces |
| 730–743, 851 | Full writer/BYPASS vs read-only reviewer/test-generated workspace writes; no dependency download card, no secrets/prod/personal/security widening | SKILL.md safety; worker-operations.md; global-rules.md; rules-enforcement.md Never-Ask Dependency Installation |
| 751–774, 814–840 | Explicit routed flags/audit/digest/Remote Control/Bypass; no settings mutation, saved respawn not transient model; avoid duplicate copied resume | worker-operations.md; rules-enforcement.md; current all-opus SKILL.md/digest (old Fable plans superseded) |
| 83–84, 551–575 | Nightly owner reminders/ranges/Chinese cards, login <=3 days, TTADK dates, Claude/Fable budget; only owner may fix policy globally | SKILL.md policy; worker-operations.md reminder dates; nightly-review.md unchanged |

## Current-behaviour reconciliation

- Lean route output and fixed worker injection: source route.mjs + pipeline/presentation.mjs; briefs carry task facts only.
- Hook-delivered changes/seen-version acknowledgement: rules-enforcement.md, no manual rules-ack.
- Automatic provisional outcomes/reviewer markers: scripts/lib/worker-outcome.mjs; rubric/manual instructions corrected.
- Inbox: info/progress deferred, risk/scope/ask wake, watch default 45 seconds.
- Current all-opus/strong-worker/secretary rules: approved brief, reflected in SKILL.md and digest; no session-settings mutation here.
- Stale resource wording “slot then blocking lane” corrected to atomic pair; env=test alone never establishes remote execution.
- Digest remains version 2026-11-16.4 and 60 lines. Worker Rules payload is untouched.
- Help verification found route/codex-worker/outcome/heavy-build have no --help implementation; use
  the printed route, maintained references or bounded source option/header excerpts. Only supported
  res help is recommended; no script changes were made to add help.

## Size and verification

All bytes below are UTF-8 file sizes, including this audit artifact. SKILL.md is below the
strict decimal 30,000-byte target (392 lines), with unchanged skill metadata. The new operations
and audit references are loaded only when relevant. Digest stays 60 lines/version 2026-11-16.4;
its Worker Rules section is byte-for-byte unchanged. No scripts or nightly-review.md edits.

| File | Before bytes | After bytes | Delta |
|---|---:|---:|---:|
| SKILL.md | 91,025 | 29,877 | -61,148 |
| references/global-rules.md | 23,355 | 23,735 | +380 |
| references/resources.md | 45,498 | 50,077 | +4,579 |
| references/review-rubric.md | 5,536 | 5,886 | +350 |
| references/worker-operations.md | 0 | 10,195 | +10,195 |
| references/skill-slim-inventory.md | 0 | 39,324 | +39,324 |

SKILL.md reduction: **61,148 bytes (67.2%)**.

Required checks: global-rules, rules-enforcement and signing-allowlist all **PASS**. Every test
found by searching scripts/test for SKILL.md/references is included in the complete run below.
All 43 scripts/test/*-scenarios.mjs suites ran once; reroute was rerun once as requested.
Final suite counts: **37 PASS, 5 FAIL, 1 TIMEOUT** (44 main-run attempts). No blocker notes were sent.

Additional validation: git diff --check, authorized-path scope, local Markdown destinations/anchors,
existing SKILL anchor backlinks, all-original-line section coverage and exhaustive 55-line
user-attribution coverage passed. Source inspection verified lean route output, fixed injection,
hook acknowledgements, automatic outcome/yield recording and 45-second watch debounce.

### Non-passing suites and baseline evidence

| Suite | Result / evidence | Baseline comparison |
|---|---|---|
| balance-replay | FAIL line 61: ttadk vs expected trae | Same assertion with original digest; routing scripts/JSON profiles unchanged |
| eta | FAIL line 48: missing company ETA why | Same assertion with original digest; routing scripts/JSON profiles unchanged |
| light-deploy | FAIL line 82: Terra vs expected Sol retry | Same assertion with original digest; routing scripts/JSON profiles unchanged |
| reroute | FAIL line 135: exit 4 vs expected 0, both initial run and one retry | Brief identifies timing-sensitive baseline; no third run |
| res | TIMEOUT at 240 s (owned process group terminated) | Brief identifies res-suite timeouts under machine load; not rerun |
| skill-autoupdate | FAIL line 151: detached coordinator fetch-start timeout | Exact 85739a2 archive also FAILs, at earlier line 137 (submodule tip mismatch); baseline did not reach line 151, so that exact comparison remains unverified |

Failures are reported without editing executable code outside this task's documentation scope.
The update baseline used an exact git archive of scripts, references and SKILL.md in task test
scratch; no login/signing material was accessed. The other three baseline reruns restored their
only changed policy input (digest) while scripts/profiles remained identical.

### Complete run

| Suite | Final result | Attempts | Seconds (last attempt) |
|---|---|---:|---:|
| astra-first-scenarios.mjs | PASS | 1 | 8.6 |
| astra-telemetry-scenarios.mjs | PASS | 1 | 3.6 |
| auto-outcome-scenarios.mjs | PASS | 1 | 7.7 |
| balance-replay-scenarios.mjs | FAIL | 1 | 0.5 |
| browser-preflight-scenarios.mjs | PASS | 1 | 1.5 |
| company-read-scenarios.mjs | PASS | 1 | 11.7 |
| company-telemetry-scenarios.mjs | PASS | 1 | 5.6 |
| eta-scenarios.mjs | FAIL | 1 | 0.2 |
| fix2-routing-scenarios.mjs | PASS | 1 | 5.2 |
| global-rules-scenarios.mjs | PASS | 1 | 14.1 |
| hub-launchd-scenarios.mjs | PASS | 1 | 5.7 |
| lean-route-scenarios.mjs | PASS | 1 | 4.0 |
| light-deploy-scenarios.mjs | FAIL | 1 | 1.1 |
| live-routing-scenarios.mjs | PASS | 1 | 19.2 |
| monitor-tail-scenarios.mjs | PASS | 1 | 1.4 |
| nightly-review-scenarios.mjs | PASS | 1 | 165.1 |
| orch-usage-scenarios.mjs | PASS | 1 | 52.2 |
| outcome-scenarios.mjs | PASS | 1 | 3.4 |
| policy-block-scenarios.mjs | PASS | 1 | 0.3 |
| quota-monitor-scenarios.mjs | PASS | 1 | 0.9 |
| reroute-scenarios.mjs | FAIL | 2 | 5.5 |
| res-scenarios.mjs | TIMEOUT | 1 | 240.1 |
| resource-lock-scenarios.mjs | PASS | 1 | 0.8 |
| resource-nightly-scenarios.mjs | PASS | 1 | 2.4 |
| resource-scenarios.mjs | PASS | 1 | 0.7 |
| review-data-scenarios.mjs | PASS | 1 | 8.7 |
| review-policy-scenarios.mjs | PASS | 1 | 2.3 |
| route-scenarios.mjs | PASS | 1 | 118.8 |
| router-tail-scenarios.mjs | PASS | 1 | 52.4 |
| rules-auto-scenarios.mjs | PASS | 1 | 3.1 |
| rules-enforcement-scenarios.mjs | PASS | 1 | 172.4 |
| shared-state-scenarios.mjs | PASS | 1 | 2.3 |
| signing-allowlist-scenarios.mjs | PASS | 1 | initial check |
| skill-autoupdate-scenarios.mjs | FAIL | 1 | 122.2 |
| tier-routing-scenarios.mjs | PASS | 1 | 103.6 |
| trae-browser-scenarios.mjs | PASS | 1 | 2.5 |
| ttadk-quota-scenarios.mjs | PASS | 1 | 0.3 |
| utilisation-scenarios.mjs | PASS | 1 | 23.4 |
| worker-guards-scenarios.mjs | PASS | 1 | 13.0 |
| worker-inbox-fix-scenarios.mjs | PASS | 1 | 11.6 |
| worker-inbox-scenarios.mjs | PASS | 1 | 10.7 |
| worker-talkback-relay-scenarios.mjs | PASS | 1 | 7.0 |
| worker-talkback-scenarios.mjs | PASS | 1 | 13.1 |

Raw results/logs: `/var/folders/g0/sm9mp35s6fq3pfpxsyjvh36c0000gn/T/po-skill-slim-tests-9a6bhu08`. `results.json` covers the main run; `baseline-results.json` covers
the four baseline comparisons. The initial signing-allowlist PASS is in the tool transcript.
Branch is skill-slim, commit locally only; the commit SHA is returned in the final worker message
(no self-referential commit hash in this file). No push or policy installation.

Model: gpt-6.1-sol; effort: high; account: trae.
