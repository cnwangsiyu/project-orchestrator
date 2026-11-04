# Nightly routing review

A fresh background Claude session runs this every night at about 03:07 (user, 2026-11-03), via `scripts/nightly-review.sh`.
It reviews the last 24 hours of dispatching, quota and reset-card use, bad cases and model news. Then it tunes the routing
policy (`scripts/route.mjs`, `scripts/lib/state.mjs`, the docs) and tells every orchestrator to follow the new policy.
"No change" is a fine outcome when the evidence is thin.

## Hard rules — never change these; propose to the user instead

These are the user's decisions (2026-10-30 to 2026-11-03):

- **One routing mode, auto.** Routing is computed by the scripts. The orchestrator judges only the category, the
  stakes, whether an automatic check exists, and the failure count.
- **Computer use, browser, Artifact/Docs tools and peer negotiation run on Claude.** The Codex CLI can't do them.
- **Every task whose output is an image runs on Codex.**
- **Codex quota is use-it-or-lose-it.** Spend every account's week by its reset; everything either vendor can do
  goes to Codex first.
- **Claude must never run out before Codex.** It runs the orchestrators. The size and shape of its time-aware
  reserve may be tuned; the reserve may not be removed.
- **Reset cards: quota first, then cards.**
  - Suggest one only at ≥99%, or before a card expires.
  - Every redemption needs the user's explicit yes, every time. Never redeem a card yourself.
- **Fable, Astra, `max` effort and an exhausted ladder need the user's OK.**
- **Git:** commit and push only `~/.agents/skills` changes, to `origin main`. Never force-push.

## 1. Gather (keep your own context small)

- `node ~/.agents/skills/project-orchestrator/scripts/review-data.mjs --hours 24`, and `--hours 168` for the week's
  trend. It covers:
  - routing decisions by project, category, pick and account;
  - deferrals, escalations, "tell the user" events and gates;
  - week resets with the share they left unused;
  - reset cards that expired unused, and cards redeemed;
  - the current lean;
  - the model catalog compared with the saved baseline.
- **Orchestrators:** the projects are `~/.claude/orchestrator/*/ledger.md`, except `_shared`. For each one, read
  only what changed in the last day:
  - `find ~/.claude/orchestrator/<p>/tasks -name report.md -mtime -1`;
  - in those reports, their status line and their "Durable lessons";
  - in the ledger, the entries dated today or yesterday: failures, escalations, user corrections, complaints about a
    model.

  Delegate wide reads to a cheap subagent: `route.mjs extract`, or a Haiku Agent.
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
  - a Claude week ended far under its cap while work was deferred or pushed to Codex;
  - Claude ran close to empty.
- **Bad cases:**
  - one category escalating repeatedly from its first pick: the pick is too weak, so raise its effort or model;
  - first picks that always succeed easily at a high cost: lower them;
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

- **Recipients:** every orchestrator, local or remote (user, 2026-11-03). These are the `ListAgents` rows whose name
  equals the `Orchestrator session:` name in a ledger, or ends in `主对话`.
  - Include the local background sessions, and the Remote Control sessions on other machines that are not offline.
  - Message each one.
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

## 5. Report

- Write `~/.claude/orchestrator/_shared/routing-review/<date>.md` with these sections:
  - the data summary;
  - findings;
  - changes, with commits;
  - proposals that need the user: anything touching a hard rule, a new default model, a plan change;
  - which orchestrators were notified.
- If there are proposals for the user, also send one PushNotification that points at the report.
- Then end your turn. The next night's launcher stops this session.

## Schedule (this machine)

`~/Library/LaunchAgents/com.user.routing-nightly-review.plist` runs `scripts/nightly-review.sh` daily at 03:07. The
script stops earlier review sessions and starts `routing-nightly-review-<date>` (Opus `high`, bypass, cwd
`_shared/routing-review/`). Its log is `_shared/routing-review/launch.log`.

- **Install or reload:** `launchctl bootstrap gui/$(id -u) <plist>`, or `launchctl kickstart -k gui/$(id -u)/com.user.routing-nightly-review`
  to run it now.
- **Remove:** `launchctl bootout gui/$(id -u)/com.user.routing-nightly-review`.
- A Mac that is asleep at 03:07 runs the job when it wakes.
