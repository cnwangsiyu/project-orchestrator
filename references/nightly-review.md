# Nightly routing review

This runs every night at about 03:07 (user, 2026-11-03), via `scripts/nightly-review.sh`. It reviews the last 24 hours
of dispatching, quota and reset-card use, bad cases and model news. Then it tunes the routing policy (`scripts/route.mjs`,
`scripts/lib/state.mjs`, the docs) and tells every orchestrator to follow the new policy. "No change" is a fine outcome
when the evidence is thin.

## Who does what

The review follows the routing policy like any other task (user, 2026-11-09): the launcher gathers the data, routes
the review with `route.mjs analysis --stakes high` (logged as project `routing`, name `routing-nightly-review-<date>`),
and runs it as a one-shot **worker** on the account the route picks — TTADK first, then TRAE CLI. A worker that fails
or leaves no report is re-routed without its account (up to three tries). A short **Claude finisher** (`route.mjs
claude-tools`) checks the result and does what only Claude can. When the route lands on personal quota (a ChatGPT
account, or a whole Claude review), a short Claude session first asks the user with a Chinese card — run now on
personal quota, or skip tonight — and re-runs the launcher after a yes; a whole Claude review does both parts below.
`NIGHTLY_MODE=plan scripts/nightly-review.sh` prints the decisions without running anything.

- **The worker** (the routed Codex model, e.g. `gpt-6.1-sol` xhigh on TTADK or TRAE; full access, network on):
  steps 1, 2, 3 and 5.
  - The launcher has already run `review-data` (24h, 168h) and `orch-usage` into `<date>.data/`; read those files
    instead of running the scripts. It also gathered `resource-review-24h.txt/.json`, `resource-review-96h.json` and a
    read-only `resource-now.json`; resource failures/coverage gaps are UNKNOWN, not empty or healthy.
  - Model news: use web search and fetch the official pages yourself (the same pages and limits as in step 1).
  - Step 3 as written: worktree, edits, `route-scenarios.mjs` must print `all pass` before any commit, push, fast-forward,
    `--save-catalog`. Edit only the files step 3 names; anything else goes to proposals.
  - Don't message anyone (Codex can't reach the sessions). Instead write `<date>.notify.json`:
    `{"changed": bool, "commits": ["<sha> <subject>", …], "remotePull": bool, "message": "<the step-4 message>",
    "actions": [{"orchestrator": "<ledger Orchestrator session name>", "text": "<what it has to act on>"}],
    "proposals": bool, "decisions": [<decision>, …]}`. Write it even when nothing changed (`"changed": false`).
  - `decisions` lists what only the user can decide (see "Decisions for the user"), **in Chinese**, one entry each:
    `{"id": "<date>-<n>", "header": "<≤12 chars>", "question": "<one self-contained question ending in ?, with the
    evidence in a sentence>", "options": [{"label": "<1–5 words>", "description": "<what happens if chosen>"}, …],
    "recommended": <index of the recommended option>}` — 2 to 4 options, the recommended one first. Empty list when
    there is nothing to decide.
  - Write the report (step 5) with "Notified: pending (finisher)" in its notified section.
- **The finisher** (Claude Sonnet medium, bypass): only the checks and step 4.
  1. Read the report and `notify.json`. Check that each listed commit is on `origin/main` in both repos and that the
     live checkouts are at it; run `node scripts/test/route-scenarios.mjs` once.
  2. Read tonight's diff (`git show` of the listed commits) against the hard rules above. If a commit breaks one, revert
     it (`git revert`, push both repos, fast-forward), and move it to proposals in the report.
  3. Step 4: build the recipient list by name as described there (ledgers, `claude agents --json`, the roster file) and send the message (with the pull line for
     remote orchestrators when `remotePull` is true), plus each action to its orchestrator. Nothing to send when
     `changed` is false and `actions` is empty.
  4. Decisions (user, 2026-11-09: "每晚复盘如果有任何需要我决策的东西请用卡片弹窗问我，用中文"). If `decisions` is
     not empty: first send one PushNotification in Chinese (「夜间复盘有 N 个决定等你选择」), then ask them with
     AskUserQuestion — the card — in Chinese, at most 4 questions per card (several cards in a row if more), each
     question self-contained, the recommended option first with 「（推荐）」 at the end of its label. Wait for the
     answers. Then write `<date>.decisions.json` (`[{"id", "question", "answer", "notes", "at", "status": "approved"|
     "declined"|"other", "done": null}]`) and a 「用户决定」 section in the report. If `proposals` is true but no card
     was needed, send one PushNotification pointing at the report. Fill in the report's notified section, then end
     the turn.

## Hard rules — never change these; propose to the user instead

These are the user's decisions (2026-10-30 to 2026-11-03):

- **One routing mode, auto.** Routing is computed by the scripts. The orchestrator judges only the category, the
  stakes, whether an automatic check exists, and the failure count.
- **Artifact/Docs tools and peer negotiation run on Claude** (`claude-tools`). Browser work, frontend visual checks and
  desktop apps are not in this lock: they go to TTADK Codex when browser-ready (rules below).
- **Every task whose output is an image runs on Codex.**
- **Codex quota is use-it-or-lose-it.** Spend every account's week by its reset; everything either vendor can do
  goes to Codex first.
- **Claude must never run out before Codex.** It runs the orchestrators. The size and shape of its time-aware
  reserve may be tuned; the reserve may not be removed.
- **Reset cards: quota first, then cards.**
  - Suggest one only at ≥99%, or before a card expires.
  - Every redemption needs the user's explicit yes, every time. Never redeem a card yourself.
- **Fable, Astra on personal quota, `max` effort (off TTADK; on TTADK it needs no OK, user 2026-11-07) and an exhausted ladder need
  the user's OK.**
- **Codex accounts and browser (2026-11-07):**
  - Company accounts precede personal quota: TTADK first, then TRAE. The approved company balancing and explicit
    `--background` exceptions may prefer TRAE while TTADK is healthy; tune only within the bounds below.
  - TTADK has no concurrency cap: retry a rate-limited run once, then re-route without it.
  - Browser work goes to a browser-ready Codex account (TTADK first, else a ChatGPT account), else to Claude.
  - On a TTADK device, leave the ChatGPT and Claude quota for the user's other device (no TTADK there): don't add
    rules that spend it for its own sake there, and don't flag unspent ChatGPT quota or lapsed cards on a TTADK device
    as waste (user, 2026-11-07).
  - TTADK and TRAE are company quota; ChatGPT accounts and Claude are personal quota: on a TTADK device, never lower a TTADK effort to save
    cost, never count an unspent Claude week as waste, and judge a TTADK row only on quality and success. Moving work
    from TTADK to personal quota needs evidence that TTADK does it worse. The one exception (user, 2026-11-09):
    TTADK's quota is daily (~500M tokens), so throwaway code work starts at Sol `high` on the company accounts; a
    failure still climbs to `xhigh` and `max`.
  - Desktop apps (`computer-use`) go to TTADK Codex when browser-ready (user, 2026-11-07): a terminal Claude worker has
    no desktop computer-use tool (ledger 10-31), so Claude there is only a fallback that may report BLOCKED.
- **Permissions (2026-11-05; tightened 2026-11-13):** Claude workers use Remote Control and explicit Bypass;
  only actions Bypass cannot pass need authorization cards. Agents execute non-secret actions after approval;
  only the user types passwords/codes. Denials cannot be laundered, and Codex signing/credential files remain
  forbidden even with authorization. See [permission plan](../SKILL.md#permission-plan).
- **Git:** commit and push only `~/.agents/skills` changes, to `origin main`. Never force-push.

## 1. Gather (keep your own context small)

- `node ~/.agents/skills/project-orchestrator/scripts/review-data.mjs --hours 24`, and `--hours 168` for the week's
  trend. It covers:
  - routing decisions by project, category, pick and account;
  - deferrals, escalations, "tell the user" events and gates;
  - week resets with the share they left unused;
  - reset cards that expired unused, and cards redeemed;
  - the current lean;
  - the model catalog compared with the saved baseline;
  - outcomes (`outcome.mjs` records): first-pass rate, rework rounds and minutes per vendor, model and category of the
    first attempt, the failures, and named tasks with routing decisions but no outcome yet;
  - `duplicates`: tasks with more than one outcome record. They count once (latest result, most rounds); remind
    their orchestrator to record each task once, at close. Explicit corrections override normal aggregates; inspect
    `corrected` and `actualMismatches` before attributing outcomes to a model/account;
  - `routing.companyPolicies`: counts of balanced/background routing decisions and their named tasks, `why` and
    balance factors; `background` counts distinct tasks and their recorded wall-clock time;
  - `quota.companyByHour`: company quota snapshots grouped by UTC hour, including TRAE load by model and queue
    positions by family. Keep sample timestamps; missing telemetry is unknown, not zero load or an empty queue.
- **Hub probe:** on each account in `codex-accounts.json` whose hub is up, start one tiny thread
  (`codex-worker.mjs --account <name> start --cwd ~ --effort low --sandbox read-only --name hub-probe --log <tmp> "Reply OK"`)
  and check it answers. A failure that `quota.mjs` didn't flag is a bad case: restart that hub from `~` once no turn runs
  on it, and record it (user, 2026-11-08: the real probe runs here and after a failed start, not on every quota read).
- **Orchestrator context use:** `node ~/.agents/skills/project-orchestrator/scripts/orch-usage.mjs --hours 24`.
  For each local orchestrator it gives its own tool output, browser/computer-use calls, screenshots read, sleep
  polls and compactions, with FLAG lines above the limits.
- **Orchestrators:** the projects are `~/.claude/orchestrator/*/ledger.md`, except `_shared`. For each one, read
  only what changed in the last day:
  - `find ~/.claude/orchestrator/<p>/tasks -name report.md -mtime -1`;
  - in those reports, their status line and their "Durable lessons";
  - in the ledger, the entries dated today or yesterday: failures, escalations, user corrections, complaints about a
    model.

  Delegate wide reads to a background worker routed with `route.mjs extract --project routing-review` (a
  Codex run: Luna on ChatGPT, Sol on TTADK), not a subagent.
- **Model news:** WebFetch the official pages directly. Use at most about 10 fetches, with no search fan-out.
  - Anthropic: platform.claude.com/docs/en/about-claude/models/overview and /pricing, anthropic.com/news.
  - OpenAI: learn.chatgpt.com/docs/models.md, /pricing.md, /changelog.
  - Independent: artificialanalysis.ai/leaderboards/models.

  A new model, price or plan rule only counts once an official page states it.

### Account and model health

Owned by the routing/global-rules orchestrator (user, 2026-11-13), not the secretary. Include these checks every
night even when routing policy did not change; use sanctioned account-status/expiry metadata, never read login,
signing or credential files. Unknown login/expiry is unknown, not healthy; missing sign-in means BLOCKED.

- **Company logins:** check TTADK SSO expiry and TRAE login state. When any company login expires within **3 days**,
  put a Chinese reminder/renewal card in `decisions` for the finisher to show the user; report already-expired or
  missing login immediately. The user alone types secrets; don't transplant sessions or automate credential entry.
- **Dated TTADK reminder:** SSO expires **2026-11-21 19:37 PST** (2026-11-22 03:37 UTC), as supplied by the user
  on 2026-11-13. Start reminders by **2026-11-18 19:37 PST**, unless sanctioned metadata confirms renewal.
  `quota.mjs` uses `leanLines` and `POLICY.ttadkSsoWarnH = 72` in `scripts/lib/state.mjs`, including the boundary;
  this gives at least two days' notice with nightly checks. Don't run live auth reads as a Codex workaround.
- **Quota health:** inspect Claude all-model/Fable weekly projections, TRAE login/restriction recovery and Codex
  reset-card deadlines. Every reset-card redemption needs a fresh user OK, even after prior approvals. Company
  quota continues without asking; ask before personal quota or deferring runnable work. No LLM total-cost caps.
- **Resident signing worker:** count its user-approved personal Claude usage separately from all other Claude work.
  Use sanctioned worker/quota metadata only; never inspect signing, password, keychain or session files.
- **Persistent orchestrator models:** model selection lives in `~/.claude/jobs/<id>/state.json` `respawnFlags`;
  a `/model` switch is lost on restart. VAK and routing stay on **Fable**; Webview and Lynx returned to **Opus on
  2026-11-11** because their Fable weekly projection exceeded budget. These are orchestrator choices, not worker defaults.
- **Dated model check:** on/after **2026-11-17 09:00 PST** (Fable weekly reset; 2026-11-17 17:00 UTC), ask the user
  by Chinese card whether Webview/Lynx should move back to Fable, with fresh weekly projections and Opus/Fable
  options. Do not switch automatically; record the decision and update `respawnFlags` only after approval.

## 2. Find what to fix

Look for evidence in the data, not hunches. Typical findings:

### Global Rule Compliance (User, 2026-11-13)

Read `review-data.globalRules` for the day and week. Report violations **per orchestrator**: unrouted launches,
personal-quota launches without recorded user OK, TRAE GPT launches on security routes, and missing/stale
`rules-ack` vs the digest version. Read the launcher-provided `orch-usage` flags/blockedMinutes alongside them
for labour and foreground blocking. Launch records are attempts, not completion proof; legacy routes without
launch evidence and missing remote ledgers stay unknown, never proven compliant or violated.

Audit the resident Claude signing worker from its preregistration manifest, hashes-only PASS/FAIL reports and
sanctioned worker metadata: only registered own test packages and the specified H6/debug credentials are in scope;
any session/other keychain/production-release access, secret export/copy/print, richer report, or any other worker
reading signing material is a violation. Out-of-scope requests must be BLOCKED with a user card. `review-data` has
no trustworthy signing-material activity source, so keep its schema unchanged and report absent evidence as UNKNOWN.

Compare the last three nightly reports. A rule broken on three nights needs a concrete tool-level enforcement
proposal (evidence, owner, smallest effective gate and false-positive risk), not another repeated reminder.
Use a Chinese decision card if approval or a hard-rule change is needed; never silently expand permissions or
change thresholds. Push digest-version notes through the owner and require ledger `rules-ack <version>` from
each recipient. Hook injection records are not acknowledgements.

For a reported unreachable hub, first probe `codex-worker --account <name> list --limit 1`; an empty successful
list is reachable. Start with `codex-worker --account <name> hub` only if unreachable, and tell the global-rules
owner. Opt-in KeepAlive templates/commands are in `rules-enforcement.md`; this review does not install them.

### Machine resources

Read [resources.md](resources.md) and the launcher's `resource-review-24h.txt/.json`, `resource-now.json` and adjacent
`.err` files, plus `resource-review-96h.json` for multi-day threshold evidence. If run separately,
`node scripts/resource-review.mjs --hours 24 [--json]` or `--hours 96 --json` is read-only. Include this
step every night, even when coverage is zero. Never extrapolate missing samples or infer CPU/RSS consumers from load.

Send the user **two or three lines every night** from `utilisation` in `resource-review`/`review-data`: CPU hours
idle >50% while ready work existed and over the gate, memory availability/pressure, heavy-lane occupancy and queue
hours; TTADK tokens/TRAE per-model units unused at reset (sampled estimates/UNKNOWN); top idleness causes and action.
Readiness and metric coverage are separate; do not call gaps zero use, combine tokens with units, or claim causal
proof from idle correlations. Check `idle-hints.jsonl` targets on each orchestrator wake; hints never dispatch.
Approved utilisation settings (2026-11-13): lanes **2-3**, lane-3 take gate **load <=8 / memory >=32 GiB**,
idle hint **three samples at load <6 / CPU idle >50%, 60min cooldown**, TTADK expiry **<4h / projected <70%**.
Tune only inside explicit approved ranges; only lane count has numeric bounds in this brief. Retain the specified
point thresholds or ask a Chinese card for ranges before tuning them. The global-rules owner maintains lane-3
enforcement in `scripts/res/res` and [res-contract.md](res-contract.md); report the reviewed switch as pending
until owner rollout, and verify the appended `lane3=OPEN|CLOSED` without treating OPEN as FREE.
Keep 12/20/16 and the ONE package slot. Telemetry only observes, never implements a second gate or lock.

- Report coverage, metric availability, CPU idle with resource-ready queued tasks versus unverified waits, load/pressure/
  swap contention, sampled project/task shares, independent package-build overlap, continuous idle workers, possible
  terminal-task orphans, suspected hung Chrome, simulator services and disk trend. Give concrete UTC times, task owner,
  PID identity and evidence; include local times in the human report. RSS shares double-count shared pages, and a
  simulator service is not proof of a booted/unused simulator. Idle network/model waits are not necessarily waste.
- Include lock wait/hold lower-upper bounds and censoring, STALE local-PID observations, persistent heavy-build/lane
  candidates without matching wrapper-PID holders, authoritative overload periods and approved 12/20 lane-aware entry comparisons (memory 16 GiB), and threshold
  strict/loose/conflicting/insufficient assessment. `res status` is parsed from captures; live status writes temporary
  files, so the sampler uses read-only registry/metadata/PID observations. Minute journal timestamps cannot give exact
  holds, and the live journal has no wait starts/timeouts; sampled waits are not a complete queue history. Never reclaim.
- Include the two advisory misuse checks: `lock_taken_without_local_heavy_work` / `lock_wait_without_local_heavy_work`
  (deploy-classified purpose, >=1 minute, complete process samples and no matched local heavy root for the holder/owner)
  and remote-entry scripts that combine CI/remote markers with a local `res` lock or `verify-throttle`. Report them as
  advisory leads with owner/path/time; never reclaim a lock, kill a process or bypass admission from them. Remind workers
  that PPE/staging/TCE/BITS/SCM deploys, remote pipelines and CI runs never take a heavy-build/lane lock or `--shared-lock`,
  and shared remote/CI entry scripts stay unthrottled.
- Report hub ports 47321-47324 and all/partial listener outages, including isolated observations with duration UNKNOWN.
  Include supervisor BACKOFF/BLOCKED state, retry/failure counts and 8 MiB log-size/rotation checks; persistent faults
  go to the global-rules owner for repair, never silent restart loops or credential workarounds.
  Denied probes are UNKNOWN, not all four down. The user reported a Claude-daemon restart outage on **2026-11-13 at
  11:36 PST (19:36 UTC)**; distinguish that user report from measured history. Do not invent pre-install observations,
  assert daemon causality from ports, or restart hubs in the resource review.
- Report shared ccache latest cumulative rate and window hit/miss deltas/coverage/resets. The T83 pilot validated
  Android SDK native graph/host CMake-Ninja launchers, not Xcode or full APK acceptance. An empty/cache-stat-free first
  cold run has rate UNKNOWN; do not confuse pilot 100% hits with today's rate or attribute shared hits to one owner.
- Approved baseline (2026-11-13, secretary option A): ONE full-package slot, TWO heavy-task lanes;
  limit = 12 + 8 * lanes held by others, capped at 20; entry load <= limit, memory >=16 GiB unchanged. STALE/own locks don't
  count. T88 reports res contract v1.2 live on 2026-11-13: verify captured `limit`/`lanes_held`, distinguish legacy
  output and caller-context differences, report verified rollout mismatches, never bypass the installed controller.
  Overload analysis uses each sample's recorded limit and verdict; don't compare all readings against 12 or merge
  closure periods across limit/lane-count changes. Old output has limit 12 and lane count UNKNOWN, not zero.
  Check the installed shared controller with the routing/global-rules owner, including the current memory estimator;
  a fallback page estimate and memorystatus percentage are not interchangeable benchmarks. Shift heavy builds and
  dispatch ready lightweight work first; do not reduce model concurrency to fix compiler fan-out. Preserve affected-only
  fix tests, final full gates, cache provenance, device leases and quality constraints.
- Tune only within `scripts/resource-policy.json`'s **dated user-approved** `approvedRanges` and `approvalEvidence`.
  No numeric tuning range for the ordinary gate was supplied on 2026-11-13, so these start null: fixed 20 is approved,
  not a tuning range. Retain 12 / 20 / 16 / 1 and the installed lanes (2, or 3 after owner rollout) and ask a Chinese
  decision card for any change until the user records bounds. Never invent an approved range. With bounds recorded,
  small changes require at least three days of adequately covered comparable tasks, queue/wall-time and pressure evidence,
  old/new values and rollback criteria. Thin/conflicting evidence or values outside bounds require a card; silence is no OK.
  Use the 96h report: automatic eligibility requires >=80% comparable coverage on each of three full UTC days, consistent
  heavy-check estimator, no bypass candidates, valid dated approval and in-range candidates. This is a precondition,
  not proof of optimal thresholds; compare like task wall/wait outcomes, and change one gate at a time.
  Update observation policy in step 3 and put a controller update for its owner in `notify.json.actions`; only that owner
  updates the shared enforcement contract. Report it as pending until acknowledged, not already enforced.
- Add each project's concrete bad cases to `notify.json.actions` for its exact orchestrator name (union of ledgers and
  roster as in step 4). Unknown owners go to the routing/global-rules orchestrator for attribution, never a guessed project.
  Projects respond by fixing wrapper bypasses, concurrency/cache reuse or task-state metadata, not killing others' builds.
- The 04:30 [guarded cleanup](resources.md#cleanup) consumes the same history and separately coordinates **every**
  orchestrator. This review worker never sends signals, deletes live files, releases leases, enables apply or installs
  launchd agents. Hung Chrome means restart and a real browser-tool reconnect check afterwards, not just termination.
  Self-made build clone/template cleanup is only below 1 TB free and behind the explicit artifact allowlist/guards.

### Routing And Resource Findings

- **Waste:**
  - a Codex week reset with a large unused share;
  - a card expired unused;
  - a Claude week ended far under its cap while work was deferred or pushed to Codex (not on a TTADK device, where
    leaving Claude quota unspent is the point);
  - Claude ran close to empty.
- **Outcomes:** compare vendors and models by first-pass rate, rework rounds and time within the same category.
  - For code quality, use `reviewedReleaseByVendor`: reviewed `release` work is the only work every vendor is judged
    on the same way.
  - Check `byImpact` too. A run of `service`/`throwaway` failures that a review would have caught suggests moving
    that kind of work to `release`. Review rounds that block on trivia suggest tightening `review-rubric.md`. Change a row only when its numbers hold over several tasks; one task is an
  anecdote. When `missing` lists tasks without an outcome, remind their orchestrator to record them.
- **Rework causes (rework retro 2026-11-10):** `outcomes.byCause` splits rework by cause; `byVendor`, `byModel`,
  `traeVsCodex` and `reviewedReleaseByVendor` count `code` rework only. Remind orchestrators of `reworkWithoutCause`
  entries (record `--cause`), and report `infraRetries` and `scopeChanges` separately from model quality.
- **TRAE CLI vs native Codex (every night; user, 2026-11-08):** read `outcomes.traeVsCodex` from the 168-hour data,
  and from `review-data.mjs --hours 100000 --json` once samples are small. It compares the same model (e.g.
  gpt-6.1-sol) run on TRAE CLI against the official Codex CLI (TTADK and ChatGPT accounts), overall and per category:
  first-pass rate, fails, rework rounds, minutes, and Fisher's exact p on first pass. Put the table in the report
  every night, even when it says "too few tasks".
  - "TRAE significantly worse" (p < 0.05, at least 8 tasks on each side) for a model or a category: a finding. Don't
    change the company-before-personal order yourself; use the tuning bounds below for balancing eligibility,
    and propose broader exclusions with the numbers. Look at failing TRAE task logs for a harness cause (missing
    tool, prompt, queue).
  - TRAE takes work mostly when TTADK is out (later in the day), so check that the compared tasks are alike before
    blaming the harness.
  - `catalog.harnessDrift`: TRAE's GPT-6.1-Sol prompt vs official Codex's. 0.908 of lines shared and no tool-config
    difference on 2026-11-08; report a drop below 0.85 or any `toolConfigDiffers` entry.
- **Orchestrators stuck in details (user, 2026-11-10: judge from first principles, propose the fundamental fix):**
  for tasks with 3 or more attempts or fix rounds in the ledgers, check that the orchestrator stepped back — a
  re-scope, a design route, or a root-cause proposal to the user. Where it kept patching instead, tell that
  orchestrator in its action, naming the task and the recurring symptom.
- **Orchestrators doing work themselves:** for each FLAG from `orch-usage`, tell that orchestrator what kind of work
  to hand to workers, using its largest results as the example. Repeated flags on the same kind of work may mean a
  missing route category or a brief template gap.
- **Orchestrators blocking instead of running work in parallel:** for a `blockedMinutes` flag from `orch-usage`, or
  a ledger where a task waited on one pending item while other tasks were ready but not dispatched, tell that
  orchestrator which tasks could have run meanwhile, using the blocking examples and the ledger's dependencies.
  Also report over-splitting: coupled sibling tasks needing rework or conflicting over the same contract.
- **Bad cases:**
  - one category escalating repeatedly from its first pick: the pick is too weak, so raise its effort or model;
  - first picks that always succeed easily at a high cost: lower them (personal-quota picks only; never TTADK);
  - docs on TTADK Sol needing rework for their Chinese prose: propose Kimi-K3 for `docs` (user, 2026-11-07: watch
    first, switch on evidence);
  - "tell the user" events;
  - user corrections in a ledger;
  - categories the orchestrators keep stretching to fit a task: add a row, or clarify a description;
  - decisions with no `--project`: remind that orchestrator.
- **Models:**
  - A new or retired id in `codex debug models` or `claude --help`.
  - New official prices or plan multipliers.
  - New benchmark standings. A new model enters only with official documentation plus an independent benchmark.
    Start it as an escalation step or second opinion rather than a default. Promote it after it has worked in real
    tasks.

### Fallback models (user, 2026-11-10)

`outcomes.fallbackModels` in review-data: how often the company account's fallback models (DeepSeek-V4.1-Flash,
Gemini-3.1-Pro when listed, vision-only Seed-Evolving; references/model-routing.md, "Fallback models on the company account") ran, why
(`gpt-out` or `after-sol-fell-short`), how their tasks ended, and the extra reviews of their service code. Read it with
`--hours 168` too, since a day holds few. Reorder existing eligible fallbacks directly when the evidence is clear,
under the tuning bounds below. Changes to quality gates or removal of a family still need a decision card, for example:
- extra reviews that keep passing clean (say 10+ with nothing caught) → review only the weaker fallback, or drop the
  extra review; reviews that catch real defects → keep it, or extend it;
- a fallback whose tasks rework or fail clearly more than Sol's (byModel, code rework) → moving it down can follow
  the tuning bounds; dropping its family from ALTS needs a card. One that does as well as Sol may move earlier;
- fallback steps after Sol fell short that rarely rescue a task → drop them from the escalation (faster to Claude).
Say how many tasks the evidence rests on; the benchmark behind ALTS was 12 runs per model. DeepSeek-V4-Pro was
removed on 2026-11-13; historical outcome records remain valid. The difficulty-tier table may be reordered within
tiers by outcomes under the approved 2026-11-13 policy, never admitting weaker GPTs to hard work or using Astra for
normal/light substitutions. Our mid-size benchmarks do not separate GPT quality; read them alongside public evidence.

### Tuning the company-account policies

Every night review the policies added on 2026-11-13 against both the day's data and the week's trend:

- Company balancing currently keeps a 15% TRAE reserve, requires load <60% and no queue position >300 within
  30 minutes, and considers quota expiry <6 hours and TTADK burn projected before reset. Read the actual factors
  too: unknown telemetry has limited eligibility, and expiry balancing compares remaining quota shares.
- Check TRAE's quota-aware model choice (a depleted bucket → comparable Astra quota, then eligible fallbacks),
  the explicit `--background` lane, DeepSeek model-fit limits for build/device and high-stakes or security reviews,
  the `--security` exclusion of TRAE GPT, Seed-Evolving's vision-only role, and Astra's later company escalation rung.
  Background means nobody is waiting, with no deadline or near-term dependency; it never spends personal quota.
  Keep queued hub workers pending while queue/status arrives. TRAE controls priority, so `--background` cannot
  guarantee that high-priority quota stays untouched before depletion.
- Read `quota.companyByHour` and, where needed, the adjacent records in `quota-log.jsonl`: TTADK/TRAE quota over
  the day, TRAE load percentages and queue positions by hour, how often TTADK ran out and when, and the last
  observed unused TRAE buckets before each reset. Count depletion episodes, not every depleted snapshot; report
  sample gaps and avoid calling the last observation exact reset-time waste. Read `routing.companyPolicies`
  alongside route-log `why`/`balance` factors to explain balanced/background dispatches, grouping task names so
  retries are not new tasks. Compare corrected outcomes by model/account (`byModelAccount`), rework and wall-clock;
  get queue duration from task logs when recorded. Queue position is not queue time; missing duration stays unknown.
- Act autonomously when the evidence is clear and the change stays within the approved policy: tune reserve within
  5–30%, load within 40–80%, queue threshold within 100–800, or expiry window within 2–10 hours; reorder existing
  fallbacks by measured outcomes; widen or narrow the rows eligible for company balancing. Preserve capability,
  security, model-fit, device-lease/shared-lock exclusions and quality gates. Use small steps, compare similar tasks,
  and state in both the commit and report the old/new setting, evidence, number of days/tasks, and expected effect.
- If the evidence is thin, conflicting or unclear, or the change crosses those bounds, retain the current policy
  and raise a Chinese decision card with options, the data behind each and a recommendation. Examples: automatically
  sending normal-stakes work to low priority without an explicit `--background` brief, spending personal quota,
  dropping a model family, or changing quality gates. Apply the answer through "Decisions for the user" below.

## 3. Change (small, evidenced, tested)

- Make at most a few changes per night. Each one must name its evidence: numbers from review-data, a task id, a source
  URL.
- **Work in a worktree of the skills repo:**
  1. `git -C ~/.agents/skills worktree add -b nightly-review-<date> ~/.agents/skills/.claude/worktrees/nightly-review-<date> origin/main`
     (or `EnterWorktree`).
  2. Inside it, `git submodule update --init project-orchestrator`, then in `project-orchestrator`,
     `git checkout -B main origin/main`.
- **Edit:**
  - the table in `scripts/route.mjs`;
  - `POLICY` in `scripts/lib/state.mjs`;
  - company balancing thresholds in `BALANCE` / `balanceFactors` in `scripts/lib/company-load.mjs`, within the tuning
    bounds above; the corresponding eligibility, quota-choice and fallback rules in `scripts/route.mjs`;
  - the rationale in `references/model-routing.md`;
  - other docs only where they describe what changed.
  - `scripts/resource-policy.json`, only within evidenced user-approved ranges above; telemetry/cleanup code or changing
    the one-slot, protection or disk safety rules needs a separately authorized task, not silent nightly edits.
- **Test:**
  - Update the expectations in `scripts/test/route-scenarios.mjs` for any intended behaviour change. Add a case for
    each fix.
  - Run `node scripts/test/route-scenarios.mjs`. Don't commit unless it prints `all pass`.
  - If company telemetry or review reporting changes, also run `company-telemetry-scenarios.mjs` and
    `outcome-scenarios.mjs` under `scripts/test/`; both must print `all pass`.
  - For resource policy/reporting changes run `resource-scenarios.mjs`, `resource-nightly-scenarios.mjs` and
    `resource-lock-scenarios.mjs` under `scripts/test/`, plus `python3 -B scripts/resource-cleanup/test_cleanup.py`
    and `python3 -B scripts/resource-cleanup/test_disk_cleanup.py`; all must pass with synthetic data.
- **Commit and push:**
  1. In `project-orchestrator`, commit with a message stating the change and its evidence, then
     `git push origin HEAD:main`.
  2. In the skills worktree root, `git add project-orchestrator`, commit "Update project-orchestrator: <summary>",
     `git fetch` (rebase if origin moved), and `git push origin HEAD:main`.
  3. Fast-forward the live checkouts: `git -C ~/.agents/skills pull --ff-only origin main` and
     `git -C ~/.agents/skills/project-orchestrator pull --ff-only origin main`.
  4. Remove the worktree and its branch.
- After a successful review, run `review-data.mjs --save-catalog` so tomorrow compares against today.

## 4. Tell the orchestrators

Do this only when something changed, or an orchestrator has to act (missing `--project`, a pending card decision to
put to the user).

- **Owner and delivery (user, 2026-11-13):** the routing/global-rules orchestrator owns rollout for every global
  rule change, not just nightly routing edits. Send a short policy note through the secretary for the mini's
  group; notify MacBook orchestrators directly. The secretary only relays, keeps ledgers/roster and asks cards.
- **Recipients:** every orchestrator, local or remote (user, 2026-11-03). Build the list by name; don't rely on a
  `ListAgents` listing, which is truncated when there are many sessions (2026-11-08: 95 rows hidden, orchestrators
  possibly missed). The list is the union of:
  - the `Orchestrator session:` name in each `~/.claude/orchestrator/*/ledger.md`;
  - the local background sessions from `claude agents --json` whose `name` ends in `主对话`;
  - the roster `~/.claude/orchestrator/_shared/orchestrators.txt`, one session name per line, `#` lines are comments (it holds the remote
    orchestrators, which have no ledger here; the secretary keeps it current). Today: Webview 问题跟进主对话, Lynx Game
    主对话, Video Agent Kit 主对话, 获客平台主对话, AutoTrader 主对话.
  - For the mini group, send the secretary the exact recipient list and note to relay; for MacBook orchestrators,
    use `SendMessage` by exact name. A bare name reaches another machine even when a listing doesn't show it.
    Record relay delivery separately from confirmed recipients; unresolved/offline names are "not notified (no session)".
- **Remote orchestrators run on another machine with their own checkout.** When the skill changed, start their
  message with:
  `git -C ~/.agents/skills pull --ff-only origin main && git -C ~/.agents/skills submodule update --init project-orchestrator && git -C ~/.agents/skills/project-orchestrator pull --ff-only origin main`,
  then re-read the changed docs.
  - Their routing and quota logs stay on their machine, so this review doesn't see them.
  - If their decisions matter for a finding, say so in the report.
  - Remote Control reports no read receipt: list them in the report as "sent, unconfirmed".
- **Message:**
  - One line on what changed and why.
  - What to do differently. Usually "keep routing with `route.mjs`; the table already reflects it". Spell out any
    new flag or category.
  - "No reply needed."
  - Never ask an orchestrator to redeem a card, or to act on something the user hasn't approved.

## Decisions for the user

Only what the user must decide becomes a card; everything else the review decides itself by its recommended option and
records (user, 2026-11-08: far fewer approval requests). Cards are for: changing a hard rule above; a new default model
or plan; spending personal quota or company quota beyond the routing policy; reset cards; anything that changes what
other people see or that can't be undone. Write each in Chinese with the numbers that justify it.

For company-account tuning, thin or conflicting evidence is also a reason for a card, even if the proposed setting
is within the allowed range. Give the options, supporting and opposing data (days/tasks and telemetry gaps), and
a recommendation. Clear, small changes inside "Tuning the company-account policies" need no new approval; changes
outside it do. Do not treat an unanswered card as approval; keep the existing policy until the user decides.

- **Approved decisions are implemented by the next night's review**, in step 3 under the same rules (worktree, tests,
  commit), unless the user had the routing session do it sooner. The worker reads every
  `routing-review/*.decisions.json` entry with `status: "approved"` and `done: null`, implements it, and records the
  commit in `done` (it may edit those files for that). The user's approval covers the files the decision needs, beyond the files step 3 normally allows; it still needs `all pass` before the commit. A declined proposal is not proposed again without new evidence.
  A question with no answer by the next run (the launcher stops the finisher) is asked again, once more.

## 5. Report

- Write `~/.claude/orchestrator/_shared/routing-review/<date>.md` with these sections:
  - the data summary;
  - findings;
  - changes, with commits;
  - proposals that need the user: anything touching a hard rule, a new default model, a plan change (each also a
    Chinese card in `notify.json` `decisions`; the Claude-only review asks them itself with AskUserQuestion, as the
    finisher does);
  - approved decisions from earlier nights implemented tonight, with commits;
  - which orchestrators were notified.
- If there are proposals for the user: a Claude-only review asks them as Chinese cards (finisher step 4); otherwise
  send one PushNotification that points at the report.
- Then end your turn. The next night's launcher stops this session.

## Schedule (this machine)

`~/Library/LaunchAgents/com.user.routing-nightly-review.plist` runs `scripts/nightly-review.sh` daily at 03:07, on the
machine the orchestrators run on (the Mac mini since 2026-11-07). The script stops earlier review sessions, then (see
"Who does what") routes and runs the worker (`<date>.worker.jsonl`, up to 40 min per try) and starts the finisher
`routing-nightly-review-<date>-finish` (route.mjs `claude-tools`, bypass); on personal quota it starts
`routing-nightly-review-<date>-ask` (the Chinese card) first. cwd `_shared/routing-review/`; log `_shared/routing-review/launch.log`.
`NIGHTLY_MODE=plan` prints the routing only; `NIGHTLY_MODE=claude` forces a whole Claude review (after the card);
`NIGHTLY_MODE=dry` runs the worker read-only and stops (a test).

- **Install or reload:** `launchctl bootstrap gui/$(id -u) <plist>`, or `launchctl kickstart -k gui/$(id -u)/com.user.routing-nightly-review`
  to run it now.
- **Remove:** `launchctl bootout gui/$(id -u)/com.user.routing-nightly-review`.
- A Mac that is asleep at 03:07 runs the job when it wakes.
