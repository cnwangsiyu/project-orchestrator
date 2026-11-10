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
    instead of running the scripts.
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
- **Fable, Astra, `max` effort (off TTADK; on TTADK it needs no OK, user 2026-11-07) and an exhausted ladder need
  the user's OK.**
- **Codex accounts and browser (2026-11-07):**
  - Every task TTADK's GPT-6.1 Sol can handle runs there first whenever TTADK is healthy. Only the tasks it can't
    handle, or all tasks while it's unhealthy or excluded, follow the earlier routing (ChatGPT accounts, Claude).
  - TTADK has no concurrency cap: retry a rate-limited run once, then re-route without it.
  - Browser work goes to TTADK Codex when it is browser-ready, else to Claude.
  - On a TTADK device, leave the ChatGPT and Claude quota for the user's other device (no TTADK there): don't add
    rules that spend it for its own sake there, and don't flag unspent ChatGPT quota or lapsed cards on a TTADK device
    as waste (user, 2026-11-07).
  - TTADK is the company's quota and the rest is the user's own: on a TTADK device, never lower a TTADK effort to save
    cost, never count an unspent Claude week as waste, and judge a TTADK row only on quality and success. Moving work
    from TTADK to personal quota needs evidence that TTADK does it worse. The one exception (user, 2026-11-09):
    TTADK's quota is daily (~500M tokens), so throwaway code work starts at Sol `high` on the company accounts; a
    failure still climbs to `xhigh` and `max`.
  - Desktop apps (`computer-use`) go to TTADK Codex when browser-ready (user, 2026-11-07): a terminal Claude worker has
    no desktop computer-use tool (ledger 10-31), so Claude there is only a fallback that may report BLOCKED.
- **Permissions (2026-11-05):**
  - Before dispatching, the orchestrator does only the minimal permission-only part it is already authorized for,
    and workers do the rest.
  - When nobody holds a permission, the worker asks for it.
  - A blocked Claude worker asks the user in its own session and retries.
  - Nobody takes over a denied step, and relayed instructions are not authorization.
  - See SKILL.md, "Plan around permissions".
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
    their orchestrator to record each task once, at close.
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

## 2. Find what to fix

Look for evidence in the data, not hunches. Typical findings:

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
    change the order yourself (TTADK → TRAE → personal quota is the user's); propose keeping that category off TRAE,
    with the numbers, and look at the failing TRAE tasks' logs for a harness cause (missing tool, prompt, queue).
  - TRAE takes work mostly when TTADK is out (later in the day), so check that the compared tasks are alike before
    blaming the harness.
  - `catalog.harnessDrift`: TRAE's GPT-6.1-Sol prompt vs official Codex's. 0.908 of lines shared and no tool-config
    difference on 2026-11-08; report a drop below 0.85 or any `toolConfigDiffers` entry.
- **Orchestrators doing work themselves:** for each FLAG from `orch-usage`, tell that orchestrator what kind of work
  to hand to workers, using its largest results as the example. Repeated flags on the same kind of work may mean a
  missing route category or a brief template gap.
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
  - the rationale in `references/model-routing.md`;
  - other docs only where they describe what changed.
- **Test:**
  - Update the expectations in `scripts/test/route-scenarios.mjs` for any intended behaviour change. Add a case for
    each fix.
  - Run `node scripts/test/route-scenarios.mjs`. Don't commit unless it prints `all pass`.
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

- **Recipients:** every orchestrator, local or remote (user, 2026-11-03). Build the list by name; don't rely on a
  `ListAgents` listing, which is truncated when there are many sessions (2026-11-08: 95 rows hidden, orchestrators
  possibly missed). The list is the union of:
  - the `Orchestrator session:` name in each `~/.claude/orchestrator/*/ledger.md`;
  - the local background sessions from `claude agents --json` whose `name` ends in `主对话`;
  - the roster `~/.claude/orchestrator/_shared/orchestrators.txt`, one session name per line, `#` lines are comments (it holds the remote
    orchestrators, which have no ledger here; the secretary keeps it current). Today: Webview 问题跟进主对话, Lynx Game
    主对话, Video Agent Kit 主对话, 获客平台主对话, AutoTrader 主对话.
  - Message each one by its exact name with `SendMessage` (a bare name reaches a live session on this machine or another
    one even when a listing doesn't show it). A name that doesn't resolve, or is offline: record it in the report as
    "not notified (no session)" and move on.
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
