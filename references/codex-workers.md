# Codex CLI as a worker

Use this whenever `scripts/route.mjs` puts a task on Codex — mostly coding (implementation, build/test/deploy and debugging runs, code review), plus bulk extraction, quick lookups, drafts and image generation. The router also prints the exact launch command, with the account, model, effort and sandbox filled in. Codex runs on the user's ChatGPT plans, not on Claude credit.

**Which launcher:** use `scripts/codex-worker.mjs` through the hub (below) by default, since only it can steer, interrupt and re-attach. Use plain `codex exec` for short one-shot runs that will never need steering (the router's `exec` rows: lookups, extraction, drafts, image generation and the `second-opinion` row; the paired second opinions of `review-high` and `design` run as hub workers). Verified 2026-10-30 on codex-cli 0.166.0. The model catalog changes, so re-check it with `codex debug models` before relying on the ids below.

## Launch, resume, follow

Keep route.mjs's `run-tracked.sh` wrapper for one-shot execs; the raw examples below describe the underlying CLI,
not a substitute for the durable launcher. Every worker is a tracked background task or covered by an armed
owner watcher, never detached with `&`. See [worker inbox and owner identity](worker-inbox.md);
on wake handle finished workers first and re-arm `codex-worker watch --owner <session-id>` if workers remain.
Both launchers automatically redact `--log`, `--out` and the Codex rollout at turn end after hub-idle and two-second writer checks; counts and a non-waking info note are recorded, while manual `redact-log` remains available for other logs.

- **Launch** from the worker's workspace as a harness background task (Bash with `run_in_background`):
  `CODEX_HOME=<account home> codex exec -C <workspace> -s <sandbox> -m <model> -c model_reasoning_effort='"<effort>"' --json -o <task dir>/codex-last.md "<one line pointing at the brief>" < /dev/null > <task dir>/codex.jsonl 2>&1`
  - `CODEX_HOME` picks the account (see Several Codex accounts); without it the run spends `main`.
  - Never launch it with a trailing `&` inside a normal Bash call. That run gives no exit notification, so a failure goes unnoticed. In one case a usage-limit stop sat unseen until the user asked.
  - Always redirect stdin from `/dev/null`. Otherwise Codex waits on "Reading additional input from stdin".
  - Outside a git repo, add `--skip-git-repo-check` (to `exec` and `exec resume`).
  - The session id is the `thread_id` in the first JSONL events. Record it in the ledger next to the cwd and brief, because Codex sessions don't appear in `claude agents` or `ListAgents`.
- **Resume** the same worker for its next task, so its context survives:
  `CODEX_HOME=<same account home> codex exec resume [--skip-git-repo-check] <session uuid> [-m <model>] -c model_reasoning_effort='"<effort>"' --json -o <file> "<what changed + new task>" < /dev/null`
  - Run it from the original workspace, also as a background task.
  - A worker can only be resumed after its current run has ended.
  - `-m` switches the model for the resumed run, for example to escalate.
  - Threads live in their account's home: resume with the same `CODEX_HOME`. (A re-login inside one home keeps its threads.)
- **Follow**: the background task's exit is the completion signal. The final answer is in the `-o` file. Check how the run ended in the JSONL: the last `turn.completed`, or a `turn.failed` with its error.
  - On a usage limit, the run ends with `turn.failed` and "You've hit your usage limit".
  - Run `quota.mjs --fresh`: it says whether another account, a reset card or a wait is next. Resume once it's sorted.
  - First verify any write whose result is unknown, before redoing it.
- **Queue a message for a worker:** `codex queue --thread <session uuid> --message "<text>"` (codex-cli 0.166). Tested 2026-10-30 with `codex exec`: a message queued while the run is going is NOT seen by that run. It is delivered at the next `codex exec resume` of the thread. So it works as a mailbox (peers or the orchestrator can leave instructions anytime), not live steering. `--resume` tries to resume the thread on the local app-server daemon. Live mid-run delivery for daemon-hosted sessions is unverified. To change course now, stop the run and resume.
- **A run that was already started without notification:** start a background watcher. It waits on the PID (`while kill -0 <pid>; do sleep 20; done`), then prints the last `turn.completed`/`turn.failed` line.
- **No Codex Claude Code plugin** (removed 2026-10-30 at the user's request): use `codex exec` or `scripts/codex-worker.mjs` (below). Add any missing capability (e.g. a review mode) to codex-worker, not via the plugin. Never use the model alias `spark`, which maps to a retired model.

## Live steering: codex-worker + an app-server hub (verified 2026-10-30, codex-cli 0.166)

**Hub recovery / persistence (user, 2026-11-13):** probe `codex-worker --account <name> list --limit 1` first;
start with `codex-worker --account <name> hub` only if unreachable, and tell the global-rules owner. An empty
successful list is reachable, not a restart signal. [KeepAlive templates and owner-only install commands](rules-enforcement.md#opt-in-launchd-hubs)
cover ttadk including its proxy, trae, main and b; `hub --foreground` owns children under launchd, not Claude.

`codex exec` can't be steered mid-run, but the app-server protocol can: `turn/steer` injects a message into the running turn (taken
into account in that same turn), and `turn/interrupt` stops it. `scripts/codex-worker.mjs` wraps this. Every command connects to its account's
hub over WebSocket (`--account <name>`, default `main`), so the process that started a worker and the one that steers it can differ.

- **Hub**, one per account, localhost only, reused by every orchestrator. `codex-worker.mjs --account <name> hub` checks it and, if it's down,
  starts it detached (log in `<account home>/hub.log`) so it outlives your session. Running workers die if the hub dies. `CODEX_HUB` overrides the URL. The hub has no
  authentication: any local process can start or steer a thread on it, so keep it on 127.0.0.1 and only on a machine you trust. (The managed daemon's unix socket speaks WebSocket too; Node's
  WebSocket can't dial a unix socket, hence the TCP hub.)
- **After a re-login or plan change, restart that account's hub.** (To use another account, add it as a profile — see Several Codex accounts — rather than re-logging the main home.) It keeps the login it started with; after a re-login,
  hub calls can fail with `401 ... token_expired` (seen 2026-10-30 after the upgrade to Pro). Restart it only while no
  worker runs on it — `codex-worker.mjs --account <name> list` shows every thread `notLoaded` — by stopping that account's
  `codex app-server --listen <its hub>` process and running `codex-worker.mjs --account <name> hub`; quota identity is public registry metadata plus the hub's usage account id. A missing hub leaves login/identity unknown; never inspect login files to diagnose it. Tell the other orchestrators first. `codex exec` runs read the
  login fresh and aren't affected.
- **Start** a worker as a harness background task (its exit is the completion signal; it exits 0 on completed, 1 on
  failed/interrupted):
  `node ~/.agents/skills/project-orchestrator/scripts/codex-worker.mjs --account <name> start --cwd <workspace> --model <id> --effort <e> --sandbox <s> --name <worker> --log <task dir>/codex.jsonl --out <task dir>/codex-last.md "<one line pointing at the brief>"`
  `--effort` and `--sandbox` are required. Its first stdout line is `thread=<id> turn=<id>`. Record the thread in the ledger.
  On exit it prints `turn <status>`, the thread's token usage and `final: <first line of the final message>` — so the
  completion notice already carries the worker's `[<id>] DONE | QUESTION | …` line — and writes the whole final message to `--out`.
- **Stall alarm** (verified 2026-11-04). `start`, `turn` and `wait` exit with code **4** and print `stalled: …` when the
  turn has had no events of its own for `--stall-min` minutes (default 30; `0` turns it off).
  - The turn keeps running on the hub; the alarm only wakes you.
  - A running shell command can be quiet; inspect the actual turn and progress before declaring it stalled. Workers may not delegate.
    First check `status` and this turn's tools/output/progress, then report to its owner.
  - Then re-attach with `wait` as a background task, or steer or interrupt the turn.
  - It exists because a worker once sat silent for 18h with nobody noticing (video-agent W222).
- **Re-attach** after the orchestrator restarted (its background tasks, including the `start`/`turn` follower, are gone, but
  the turn keeps running on the hub): `codex-worker.mjs --account <name> wait --thread <id> --log <file> --out <file>`, again as a background
  task. It exits like `start` when the turn ends, or at once if it already has. Several clients can follow one turn.
- **Find** a thread whose id the ledger lost: `codex-worker.mjs --account <name> list [--cwd <workspace>] [--search <name>]` (hub and `codex exec`
  threads, newest first: id, updated, status, source, name, cwd).
- **Steer** the running turn: `codex-worker.mjs --account <name> steer --thread <id> "<message>"`. This is the messaging channel: relay peer requests,
  device handoffs and plan changes this way.
- **Interrupt**: `codex-worker.mjs --account <name> interrupt --thread <id>`. **New task** on the same thread: `codex-worker.mjs --account <name> turn --thread <id>
  --effort <e> --log <file> --out <file> [--model <id>] [--sandbox <s>] "<what changed + new task>"` (also as a background
  task); `--model`, `--effort` and `--sandbox` change it for this and later turns, e.g. read-only research, then a write task.
  **Status**: `codex-worker.mjs --account <name> status --thread <id>`.
- The log is app-server notifications: agent text is `item/completed` with `item.type == "agentMessage"`; the end is
  `turn/completed` with `turn.status`.
- Workers started this way use `approvalPolicy: never`, so the sandbox is their only bound; choose it by the rule under
  Permissions below. Nobody answers at the hub: codex-worker refuses every server request validly, and if a worker asks
  the user a question it is told to end the turn with a `QUESTION` final message (in tests, hub workers had no
  question tool at all).

## Several Codex accounts and reset cards (user, 2026-11-03)

**Accounts run side by side; nobody switches logins.** Each account is a profile in
`~/.claude/orchestrator/_shared/codex-accounts.json` with its own `CODEX_HOME` (so its own login) and its own hub port.
`main` is `~/.codex` on port 47321.

- **Add an account:** run `codex-worker.mjs account-add <name>`. It creates `~/.codex-<name>`, symlinks the main home's
  `config.toml`, `AGENTS.md`, `skills` and `rules` into it, and assigns the next hub port. The user then logs it in once
  with `! CODEX_HOME=~/.codex-<name> codex login`. After that, start its hub with
  `codex-worker.mjs --account <name> hub`. `codex-worker.mjs accounts` lists the profiles.
- **Name the account on every command.** `--account <name>` works with every codex-worker command (start, turn, wait,
  steer, interrupt, status, list, hub, usage, reset-credit-use). For `codex exec`, prefix `CODEX_HOME=<home>`.
- **Threads belong to their account.** Resume, steer and wait on the same account that started the thread. Record the
  account in the ledger next to the thread id. Memories and session history are per home; the shared `AGENTS.md`
  bridge still applies to every account.
- **Pick the account with `quota.mjs`.** It reads every account live through its hub. If a hub is down, it projects
  that account from its last reading and says so.
  - Its `lean` names the account for new Codex work: the one whose unused quota is lost first (its reset, or an
    earlier expiring card).
  - It flags a login whose hub still runs the old account. Restart that hub once no thread runs on it.

**Reset cards ("rate-limit reset credits").** `codex-worker.mjs [--account <name>] reset-credits` lists an account's
cards with their expiry. Redeeming a card puts the account's windows back to 0% and restarts their clock now. So the
card gains about `used + time-left/window − 1` windows:

- It is worth the most when the window is spent early in its cycle. With cards in hand, Codex is front-loaded.
- The quota comes first, then the cards (user, 2026-11-03). `quota.mjs` suggests a card only when:
  - every account is at ≥99%, or
  - a card would otherwise expire. A card that expires before its window resets sets a deadline to spend that
    account by, with a break-even usage below which the card isn't worth redeeming.
- Redeem with `codex-worker.mjs [--account <name>] reset-credit-use --key <new uuid>`. Reuse the same key if you retry
  the same attempt. Redeeming is irreversible: ask the user every time and redeem only after an explicit yes; there is no
  standing approval (user, 2026-11-03).
- After redeeming, run `quota.mjs --fresh`.

## TTADK (company gateway) as a Codex account (user, 2026-11-07)

TTADK serves the company's model gateway, which includes GPT-6.1 Sol. It runs the same Codex binary, so `codex exec`,
resume, the read-only sandbox and hub workers behave as with a ChatGPT account (verified 2026-11-06/07).

**Why it is a company lane:** usage counts toward the user's Devmind AI contribution. Route in quality order across company accounts, preferring free TRAE for that model; TTADK takes its capability-only work, congestion fallbacks and expiring quota. Personal quota stays behind its scoped gates.

### Setup on a new machine

1. Install the CLI: `npm install -g @byted/ttadk@latest --registry=https://bnpm.byted.org`.
2. Log in to SSO once. The user runs `! ttadk auth login sso`. The session lasts about two weeks; `quota.mjs` warns 72 hours (three days) before it ends.
3. Run `node <this skill>/scripts/codex-worker.mjs ttadk-setup`. It:
   - checks `ttadk`, the SSO status and at least one usable qualified Codex model in the fresh catalog; Sol is preferred when listed, but its absence does not invalidate other usable models;
   - creates `~/.codex-ttadk` with the gateway provider config (auth through `ttadk get_params --sso sso`);
   - symlinks `AGENTS.md`, `skills` and `rules` from `~/.codex`;
   - registers account `ttadk` (kind `ttadk`) on the next hub port.
4. Start its hub: `codex-worker.mjs --account ttadk hub`. Hub workers need it; `codex exec` runs don't.
5. For browser work, also run `codex-worker.mjs --account ttadk browser-setup` (see the next section).

### Models and routing

- **Models:** the gateway's codex list is `ttadk models -f json` (agents including `codex`). As of 2026-11 it has
  `gpt-6.1-sol` and `gpt-5.6-terra`, but no Luna, Astra or GPT-6.1 Terra. The image tool isn't served either.
- **Routing:** company work prefers an observed free TRAE lane (candidate model load <60%, no queue/stall),
  then TTADK. TTADK's expiring unused quota retains preference; capability/retry floors and personal-quota
  approvals remain. Browser/ui-browser require the ready TRAE Playwright bridge for that first step;
  computer-use uses TTADK → browser-ready personal ChatGPT (needs OK), with no TRAE/Claude desktop path.
- **Web search, through a local proxy (verified 2026-11-07).** Image input works on the gateway as is; web search
  needs this setup. Every TTADK worker gets it, as on ChatGPT accounts and Claude Code, where it is on by default.
  - *Why:* Codex sends its hosted `web_search` tool only to OpenAI's own provider; to TTADK it sends none ("NO WEB
    SEARCH TOOL", also with `web_search = "live"`). With `supports_standalone_web_search = true` it calls OpenAI's
    `/alpha/search` endpoint instead, which the gateway doesn't have (404). The gateway does run the hosted tool when a
    Responses request carries it: a direct call returned `web_search_call` items.
  - *How:* `scripts/ttadk-search-proxy.mjs` listens on 127.0.0.1 only and adds `{ type: "web_search" }` to every
    `POST /responses`; everything else passes through unchanged (SSO auth and headers included). `ttadk-setup` points
    the account's own provider (`ttadk_app`) at it and registers `searchPort` (hub port + 100) on the account.
  - *Use:* nothing per task. `hub`, `start`, `turn` and `wait` bring the proxy up when it isn't running, and exit 6
    with `proxy-unavailable:` when they can't; the task is then re-routed with `--exclude-account ttadk`. A TTADK
    `codex exec` bypasses codex-worker, so route.mjs prefixes it with `codex-worker --account ttadk proxy`.
    `codex-worker --account ttadk proxy` also starts or checks it by hand.
  - *Dependency:* every TTADK model call now goes through the proxy, so a proxy that can't start takes TTADK out (and
    the routing falls back), not just search.
  - *Privacy:* every worker brief, on any vendor, says that search queries go to the public internet and must not carry
    internal code, internal project or product names, people, internal URLs or secrets.
  - *Measured:* the codex release question answered correctly (0.167.0, published 2026-11-06, checked against the
    GitHub API): 20s on a hub worker, 14s with `codex exec`; browser use unchanged. Log: `<home>/search-proxy.log`
    (method, path, status; never headers or bodies).
  - *Tried first:* a separate provider for research only, which needed a second app-server, because a thread can't
    switch providers inside one hub (turn/start: "This chat uses ttadk_search, but your current provider is
    ttadk_app"). Dropped, since official Codex and Claude Code search on every task anyway (user, 2026-11-07).
  - *Alternatives considered:* Ferry (a colleague's local gateway onto TRAE's models, with its own `/alpha/search`)
    rides the user's personal TRAE quota, and TRAE bans heavy unattended use, so it is not used for workers.
- **Quality:** a 40-run benchmark against ChatGPT's GPT-6.1 Sol showed equal pass rates, the same reasoning-token
  scaling with effort, and equal output speed. Small calls carry about 5s of extra latency.

### Health and fallback

`quota.mjs` and `route.mjs` treat TTADK as usable when the `ttadk` CLI is present, the SSO session is active and the
gateway lists a healthy `gpt-6.1-sol`. The hub being down only matters for hub workers, and the router says to start it.

There is no concurrency cap (user, 2026-11-07):
- The gateway limits queries per minute. About 90 per minute sustained was fine; a burst of 20 simultaneous starts got
  throttled.
- **Token quota (measured 2026-11-08).** Not unlimited: each user gets a fixed number of tokens per day, about 500M
  (input + output, cached input counted in full; models weigh differently, Sol ×1), plus an hourly cap, shared by all
  models. Over it the gateway answers 403 `quota exceeded: Daily Limits exceeded. Resets at <ISO>` (16:00 UTC for the
  daily one) to every model. A day of TTADK-first work used it up in about 8 hours. The proxy records the limit in
  `<ttadk home>/quota-limit.json`; `quota.mjs` then shows TTADK paused until the reset, and `route.mjs` routes normal
  work that TTADK would take to personal quota behind a "needs the user's OK" gate: the orchestrator asks the user once
  whether to go on now or wait for the reset (user, 2026-11-08). "Go on": launch, and pass `--urgent` for TTADK's work
  until the reset; "wait": hold it until then. Only a matching stored scoped approval authorizes personal quota on a company device; urgency alone does not. High stakes ask too (user, 2026-11-09). `codex-worker` prints
  `quota-exhausted:` for such a failure: don't retry, and don't try another TTADK model. Usage dashboard:
  `https://gdp-portal.bytedance.net/llmbox/dashboard` (extra quota can be requested there; that is the user's call).
- **Where the daily number comes from (user-approved 2026-11-13).** `quota.mjs` reads TTADK's own quota from
  `GET https://llmbox-global.byteintl.net/api/v1/user/quota` (the LLMBox dashboard's API; response shape from its
  frontend, not yet confirmed against a live account) and prints `ttadk day 37% used (185M / 500M) resets …`; at ≥80%
  the lean warns that TRAE takes over when it runs out. The token comes from the ttadk CLI itself
  (`ttadk auth token jwt`, falling back to `ttadk auth token sso` for LLMBox's `Authorization: Bearer at-…`), is used in
  memory for this one read-only query and dropped: **the approved exception to the credential rule, scoped to this query
  inside `quota.mjs`/`lib/state.mjs`**. No worker may open, print or copy it, and it is never written to the quota cache,
  a log or an error. A failed or unidentifiable read sets `usage:null` and `usageError` (short reason, e.g.
  `llmbox HTTP 401`); it never affects TTADK's health, and `route.mjs` does not use the number yet.
- **A rate-limited run is retried once on TTADK.** `codex-worker` prints a `rate-limited:` line when a turn fails that
  way.
- If the retry fails too, or the run fails for TTADK reasons (SSO, auth, gateway error), re-route with
  `route.mjs … --exclude-account ttadk`.
- **A hub that answers but can't start threads** (any account; 2026-11-08: `-32603: thread startup task stopped
  before completing`, hub.log `provider auth cwd must resolve`, after the hub's working directory was removed).
  `quota.mjs` checks two things that cost nothing: the hub process's working directory still exists, and hub.log has no
  panic in the last 30 minutes since the hub's last start (a one-off panic ages out, 2026-11-09). When either fails it marks the account (TTADK: unavailable; ChatGPT: not live) and
  prints the restart: once its running turns finish, `kill <pid>; cd ~ && codex-worker.mjs --account <name> hub`.
  `hub` itself starts from `$HOME`. The real probe, one tiny thread (`start --cwd ~ --effort low --sandbox read-only
  "Reply OK"`), takes seconds, so run it only after a start fails that way, and in the nightly review.
- Record repeated TTADK trouble in the ledger; the nightly review reads it.

### Data

The guide states no data-security rules, and a compliance question about it was taken offline. Use it for TikTok/ByteDance
engineering work. Ask the user before sending other companies' or personal data through it.

## TRAE CLI as the second company account (user, 2026-11-08)

Order for Codex work: **observed free TRAE lane first, then TTADK, then eligible TRAE fallback, then personal quota** (ChatGPT accounts / Claude). `route.mjs` picks
TRAE whenever TTADK is out (daily quota used up, down, or `--exclude-account ttadk`) and TRAE is healthy; the OK gate for
personal quota needs approval based on the actual primary/second-opinion account, including ladder fall-throughs
while a company account remains usable (`--urgent` and standing exceptions apply). The user chose not to cap TRAE usage.
User, 2026-11-13: restrictions are unrelated to our concurrency/quota; never lower concurrency for fear of queueing.
For LLM use, only QPM/TPM throughput limits matter; impose no total-cost caps. Provider daily buckets and queues
remain routing telemetry, not local spending/concurrency caps. Reports must name the concrete worker model
(e.g. `TRAE GPT-6.1-Sol high`), not just "TRAE".

- **What it is.** TRAE CLI (`traecli` / `traex`) is the company's official agent CLI (the compliance FAQ lists it as
  cleared), a fork of Codex maintained by the TRAE team, with its own model pool, separate from TTADK's. Models include
  GPT-6.1-Sol, GPT-6-Astra (often queued), GPT-5.6 Sol/Terra, GPT-5.5, Seed and DeepSeek-V4.1-Flash; TRAE gpt-5.6-luna and Gemini are excluded; no Opus on this
  account, no Kimi.
- **Same harness as Codex for GPT-6.1-Sol** (compared 2026-11-08): the same "You are Codex…" base prompt (about 28 lines
  differ, in the plugin/app section), the same tools (code mode, unified exec, freeform apply_patch, multi-agent v2, web
  search). A 5-check test (fix + tests + AGENTS.md, web search, skills, image input, resume) passed on GPT-6.1-Sol and
  Gemini 3.1 Pro, and `traex app-server` worked unchanged as a codex-worker hub.
- **Browser on TRAE uses a different bridge.** TRAE still cannot use the ChatGPT Chrome / Computer Use plugins (their
  extension accepts only the OpenAI-signed Codex client, which we do not work around), so desktop `computer-use` and
  image generation stay on TTADK / ChatGPT / Claude. For `browser`, TRAE can drive the user's
  signed-in Chrome through Microsoft's Playwright Extension bridge when the user-pasted token file exists.
  `ui-browser` uses headless isolated Chrome for public/local UI checks. Other TRAE threads disable Playwright unless
  the launch explicitly requests a browser with `--browser-origins`.
- **Playwright Extension setup** (once per machine): install Chrome extension
  `mmlmfjhmonkocbjadbfplnigmagldckm`, copy the token shown by the extension to
  `~/.trae/playwright-extension-token`, and `chmod 600` that file. The token is created and pasted by the user; workers
  and setup code never extract it from Chrome or a profile, and capability checks only test that the file exists.
  `PLAYWRIGHT_EXTENSION_TOKEN_FILE` overrides the path for tests. Browser threads default to Chrome profile directory
  `Profile 1`; route/launch code can override it with `--chrome-profile-dir <name>`.
- **Setup** (once per machine): install (`sh -c "$(curl -fsSL https://code.byted.org/api/tos-proxy/download/traex_install.sh)"`),
  `traecli login --git-code` (no browser needed; `--sso` otherwise), then `codex-worker.mjs trae-setup` (registers
  account `trae`, hub port next free; writes into `~/.trae/traecli.toml`: `commit_attribution = ""`, `web_search = "live"`,
  network in workspace-write, `hatch-pet` off as on the main home; installs the same
  document plugins as the other accounts: documents, pdf, spreadsheets, presentations, template-creator, visualize) and
  `codex-worker.mjs --account trae hub` (starts `traex app-server`). Rerun `trae-setup` after a ChatGPT app update.
  Setup omits the global headless Playwright block by default. `trae-setup --headless-playwright` opts into it for
  direct CLI use. To remove the block written by earlier setup versions from an existing `~/.trae/traecli.toml`, rerun
  `codex-worker.mjs trae-setup --no-headless-playwright` (default setup also removes it). Setup backs up the config
  first and removes only its marked Playwright block; independently configured servers are preserved.
- **Same skills and instructions as the other Codex workers** (checked 2026-11-08): TRAE reads `~/.agents/skills`
  itself, and after `trae-setup` the skill list matches a TTADK worker's except TRAE's own two company plugins
  (`traex-guide`, `ai-contribution`, kept). Like every Codex worker it has no global AGENTS.md or Claude memory: the
  brief and the repo's own AGENTS.md carry the context.
- **Use.** Hub workers: `codex-worker.mjs --account trae start … --model GPT-6.1-Sol` (lower-case ids are mapped).
  One-shot: `traecli exec -C <dir> -s <sandbox> -m GPT-6.1-Sol -c model_reasoning_effort='"high"' --json -o <file> "<prompt>"`.
  `route.mjs` prints both. Sessions live in `~/.trae/cli/sessions`.
- **Health.** `quota.mjs` reads the account as healthy when the CLI is present, logged in and lists GPT-6.1-Sol or one
  of its fallback models (model-routing.md, "Fallback models on the company account"), its hub is sound, and it isn't
  paused. A popular model can sit "Queued for capacity": a hub worker then prints `queued: position N (state)` from
  TRAE's `queue/status` notifications (see "Queue position" below); let it wait, and interrupt only a worker with no
  events at all for 15 minutes, or an exec run, then re-route with `--exclude-model <its family>`.
- **Queue position** (user, 2026-11-13; 954 `queue/status` notifications in one 13-minute wait). Over the hub TRAE sends
  `queue/status` `{threadId, turnId, state: queued|waiting|ready, position, message}` while a turn waits in its model
  queue. `codex-worker start|turn|wait` prints `queued: position N (state)` on a state change or a ≥10% position move (at
  most one line a minute) and `queue cleared after Mm` when it becomes ready; `status --thread` shows the last state
  (or `no queue info`). These notifications carry the thread id, so they count as progress for the stall alarm — a queued
  worker is waiting, not stalled. `traecli exec` shows none of this (no hub), which is why an exec run still uses the
  15-minute no-progress rule.
  For company balancing, the follower also samples each model family's latest `{t, position, state, lowPriority}` into
  `<trae home>/queue-state.json`. Writes are atomic and coalesced to at most one per minute across workers. A `high`
  observation retains a position above 300 for 30 minutes even after a later ready event. Other threads' events are
  ignored. This is best-effort telemetry: it never holds a worker or reduces concurrency. `quota.mjs` reads it live,
  ignores observations older than 30 minutes, and appends it to each quota refresh snapshot with per-model CLI load.
- **Automatic queue handoff** (user, 2026-11-14). `route.mjs` passes `--route-args '<JSON argv>'`,
  `--auto-reroute-depth N` and, on slow/unknown lanes, `--queue-patience-min M --alt '<alternative>'`.
  The worker compares elapsed wait with the patience deadline and `--queue-alt-start-min` alternative estimate,
  whichever is earlier, using an independent alarm even when notifications stop or positions plateau. At least two
  minutes of falling positions also permit an earlier predicted-start decision. The generic stall alarm defers to
  queue patience and cannot cut off its cancellation. It checks
  the turn for work, interrupts it once, and confirms it is interrupted
  without progress before calling `route.mjs` with original flags, the same `--failures`, an `--exclude-lane account:model`
  for the slow lane and depth N+1. `--queue-alternative` retains the structured route alternative, so TTADK may run
  the same model after its reset. Reroutes remove `--fresh`; quota identity never parses credential files. It launches a fresh company hub thread with the same brief and a git status/diff
  continuation header, follows that child, and returns its result to the original caller. Each hop prints
  `rerouted: <from> (queued P, waited M min) → <to>` and logs a `kind:'reroute'` plus the child's launch.
  Unavailable TRAE models at thread/turn start and first-request vendor restrictions (983) use the same guards.
  Never hop after tools, reasoning, output or ready state; never hop background tasks; at most two automatic hops.
  A held resource or unknown resource-bound metadata stops the handoff: the owning wrapper returns its holds
  on exit, never another task's holds. Acquire device/build resources only after the first model response.
  Cancellation/read failure stops within three seconds with `queue-cancel-unconfirmed`, exit 7, no replacement.
  Router failure also exits 7 and persists `reroute.json` before routing, including cancelled thread/turn ids,
  route argv and the continuation prompt for recovery; a followed child's later deferral record remains authoritative.
  Approval/personal quota stops with `reroute-needs-user`, exit 8; deferral writes `reroute.json` with the full
  route and `deferUntil`, exit 9, for the orchestrator's timer (no worker timer or long sleep); depth limit exits 10.
  A policy block is never resent to GPT. Only an already `--security`/`--adversarial` route can auto-hop, with
  `--adversarial` added and `--defensive` removed. Signing is never automatically launched by a Codex worker.
  Legacy launches without route args keep exit 7 handoff behaviour. Outcome chains are derived from hop records;
  nightly `routing.automaticReroutes` reports waits and observed faster/slower/unknown starts, not assumed speedups.
  Required company second opinions are followed separately with their routed read-only sandbox and separate reports;
  any personal secondary pick also stops the hop for approval, even when the original route carried `--urgent`.
- **Per-model daily quota** (user-approved 2026-11-13). The hub answers the read-only `model/internalUsage/read` with
  `{dailyUsage:[{quotaKey, quotaLimit, quotaUsed, quotaRemaining, usagePercent, isDepleted, periodStart, resetTime}],
  usage:{usage_percent, quota_remaining, quota_limit, is_depleted, reset_time}}` — one independent daily (24 h) bucket per
  model, plus the aggregate weekly pool (TUI "Weekly quota"). Amounts are strings, times unix seconds;
  `model/list` maps each model to its `businessMetadata.internal_daily_quota_key` (null for Seed, DeepSeek and older GPTs:
  no daily bucket). `codex-worker.mjs --account trae usage` prints this as `{kind:'trae', dailyUsage, usage, modelQuotas}`;
  `state.mjs` stamps the normalized quota with `sampledAt`; daily readings older than 30 minutes or without a valid
  sample time are unknown, even if resetTime is still in the future. Cached reads preserve the original timestamp.
  `quota.mjs` shows one row per model with a daily bucket plus the weekly row. A depleted bucket (`isDepleted`) moves only
  that model into TRAE's **low-priority queue** (`queue/status` `modelQuotaLowPriority: true`; requests then wait with
  positions in the hundreds). For new dispatches compare completion within the task's tier (see model-routing.md,
  "Difficulty-tiered company model choice"): hard work stays on Sol/Astra, normal work keeps its quota-bearing 5.6
  order then bucket-free DeepSeek, and light work prefers bucket-free models. Per-model fresh queue/progress evidence
  controls the estimate; depletion alone proves no delay. A faster reset produces an explicit ledger/timer dispatch,
  and a launch with missing lane evidence carries queue patience. Never launch a duplicate of an accepted queued turn.
  Keep parallel task concurrency unchanged. A bucket at ≥80% with priority quota left starts now unless fresh lane
  congestion changes the completion estimate. `account/rateLimits/read` does not work for this login.
- **Pause after failures** (`scripts/lib/trae-health.mjs`, user 2026-11-08). codex-worker records every failed or
  stalled TRAE turn and clears the record on a completed one. Failures count **per model family** (gpt, deepseek,
  gemini, seed…; 2026-11-10: TRAE restricted only GPT while the others kept working): a paused family's models drop out
  of `route.mjs`'s choices and the next family takes the work. Auth failures, and failures noted without `--model`,
  pause the whole account: then `quota.mjs` shows TRAE unavailable and `route.mjs` skips it (TTADK if usable, else the
  personal-quota OK gate). codex-worker knows each thread's model (`<trae home>/thread-models.json`), so a later `turn`
  or `wait` records against the right family. Pauses by kind (user, 2026-11-08):
  - transient — queue full (`request queue size is exceed`, first seen 2026-11-08; it reflects TRAE's overall load, not our own concurrency — user 2026-11-11: don't run fewer TRAE tasks because of it),
    rate limits, gateway errors, timeouts, stalls: two within 15 minutes pause it for 5 minutes, then 10, 20, at most 30
    while pauses follow each other without a success (the backoff starts over after a success or an hour clear);
  - auth — not logged in, 401, expired token: 30 minutes, lifted as soon as `login status` is fine again;
  - vendor restriction — `Model access temporarily restricted` / `access restricted` or code 983: pause that family
    until the next 00:00 UTC strictly after the failure (08:00 China time; user, 2026-11-12). TRAE's FAQ specifies this
    recovery time; the 11-10..12 retro found every block lifted just after 00:00 UTC and every earlier 30-minute probe failed;
  - OpenAI cyberPolicy block — `codexErrorInfo=cyberPolicy` / "flagged for possible cybersecurity risk" (2026-11-13):
    on TRAE it is recorded like the 983 restriction above (family out until the next 00:00 UTC, then probed) and printed
    as `trae-restricted:`; `codex-worker` also appends `kind:'policy-block'` to the route log for the nightly review on
    both accounts. TTADK writes only that policy-block row and never pauses. Never retry the thread or resend the content
    to another GPT account; re-route with `--adversarial`;
  - other hard failures — quota used up, banned, 403 Forbidden: a family's pause is 30 minutes, then a recovery probe;
    whole-account pauses back off 30, 60, 120, at most 240 minutes while they keep coming without a success.
    codex-worker prints `trae-paused:` when it pauses.
  - model unavailable — `is unavailable because its metadata could not be resolved`, `model … not found | does not exist |
    unsupported`, or `-32600` together with "model" (TRAE dropped Gemini from its list, 2026-11-13): applies to the
    **model**, not its family. One failure pauses just that model id for 6 hours (no probe; the next real launch tries
    again) while its family-mates stay usable, and `route.mjs`/`quota.mjs` say so. A `thread/start` failure is recorded
    too, and codex-worker prints `model-unavailable: <model> isn't available on TRAE; re-route (route.mjs skips it now)`.
  A `traecli exec` run bypasses codex-worker: record its failure
  (or a run you interrupted) with `codex-worker.mjs --account trae note-failure --model <model> "<error>"`. To lift a
  pause by hand, delete `~/.trae/worker-health.json`.
- **Recovery probe** (user, 2026-11-10, updated 2026-11-12). A model family's vendor restriction waits until the next
  00:00 UTC (08:00 China time); other hard pauses (quota, banned, 403) wait 30 minutes. When it ends the family stays
  out of routing until a probe succeeds: the next `route.mjs`/`quota.mjs` read starts `codex-worker.mjs --account trae
  probe --model <its model>` in the background (one read-only "reply OK" turn at low effort through `traecli exec`).
  OK → the family is back (verified end to end 2026-11-10: about 20 seconds); a failed restriction probe waits until
  the following 00:00 UTC, even if its error differs; other hard failures wait 30 more minutes. Probes are claimed
  once when due, with the existing 10-minute stale-claim retry. No restriction probe runs before its reset. Transient pauses (queue full)
  still just end. The whole-account pauses (auth, or failures noted without `--model`) keep the backoff above. Verified 2026-11-10: a DeepSeek-V4.1-Flash hub worker on TRAE
  searches the web like Sol does.

## Browser use (and Computer Use) on a Codex worker (verified 2026-11-07)

**Which accounts count as browser-ready** (2026-11-10): an account marked by `browser-setup`, or any Codex home whose
`config.toml` has the `node_repl` MCP server with the browser service — the ChatGPT app writes that itself into its own
home (`~/.codex`, account `main`), so `main` is ready wherever the ChatGPT app is installed and set up for Chrome.
Two browser runtimes can ask for site/app approval: `node_repl` (browser-setup's config) and `cua_repl` (the ChatGPT
app's unified-computer-use plugin, enabled on the app's own home). codex-worker answers both from `--browser-origins` /
`--computer-use-apps` (2026-11-10: it used to accept only `node_repl`, so on the MacBook's `main` every site was declined
as "The user declined approval"). Each answer is logged to `--log` as `accessApproval`; an unrecognised request is
declined and logged with its raw content.
Browser and desktop threads (`--browser-origins` / `--computer-use-apps`) start with the ChatGPT app's
unified-computer-use plugin turned off for that thread and `approvalsReviewer: "user"` (2026-11-10): under the CLI hub,
`cua_repl` accepted the site approval and then failed every call with "Cannot read properties of undefined (reading
'timeoutMs')", and an account set to auto-review declined approvals itself. They use `node_repl` with the chrome plugin
instead, the path verified on TTADK and `b`. Only that thread changes; the app keeps its plugin.
codex-worker also gives those threads developer instructions on how to start (2026-11-10: a MacBook worker followed a
Claude skill and looked for `mcp__claude-in-chrome__*` tools a Codex session doesn't have): use `node_repl`'s `js`,
bootstrap Chrome from `<chrome plugin>/scripts/browser-client.mjs` (`setupBrowserRuntime` → `agent.browsers.get("chrome")`
→ `documentation()`), `@oai/sky` for desktop apps, only the allowed sites/apps, no Claude tools or skills. Verified on
the mini's `main` (an app-configured home) the same day: example.com opened and read through `node_repl`.
The chrome plugin used for that bootstrap is the copy the installed ChatGPT app unpacked
(`~/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/chrome`), so it matches the app's `node_repl` and browser
service; a newer cached plugin with an older app (MacBook, app 26.1007, 2026-11-10) opened tabs and then failed every
page call with "Cannot read properties of undefined (reading 'timeoutMs')". Keep the ChatGPT app up to date on every
machine that runs browser workers.
- **App older than its Chrome extension.** The extension (`hehggadaopoacecdllhhajmbjkdcmajg`, under
  `~/Library/Application Support/Google/Chrome/*/Extensions/`) updates itself; the app doesn't. App 26.1007 with
  extension 1.26.1102 (MacBook, 2026-11-10) connected and opened tabs, then every page call failed with "Cannot read
  properties of undefined (reading 'timeoutMs')"; updating the app and restarting Chrome fixed it. codex-worker checks
  this before a browser thread starts and exits 7 with `browser-version-mismatch:` — ask the user to update the app.
`route.mjs` sends browser and ui-browser work to TRAE when the Playwright token
file exists and the qualifying model can start now at load <60% without a queue/stall, then to browser-ready TTADK, then to a browser-ready personal ChatGPT account (needs the user's OK), else personal Claude (also needs
the user's OK). `computer-use` never uses TRAE: it keeps TTADK → personal ChatGPT (needs OK). On a
new machine, set up the matching bridge for each account as described here.

### Playwright Extension browser threads on TRAE

For a TRAE `browser` route or a launch with `--browser-origins` outside `ui-browser`, codex-worker injects a per-thread `mcp_servers.playwright` override:
our launcher running `npx -y @playwright/mcp@latest --extension --profile-dir-name 'Profile 1'`. No `--allowed-origins` is passed: Playwright's list takes only full origins or wildcard ports (no host globs such as `*.larkoffice.com`) and filters every request a page makes, so signed-in pages fail with `net::ERR_BLOCKED_BY_CLIENT` (live test 2026-11-14).
`--chrome-profile-dir` changes the profile. The per-thread server is our launcher `scripts/playwright-extension-mcp.mjs` (run with node), which reads the token file itself and passes the token to `@playwright/mcp` only through that child's environment. The token is never in the hub's environment (every worker shell inherits that), on argv, in TOML or in logs, so adding or replacing the token needs no hub restart.

For `ui-browser`, the per-thread server instead runs `npx -y @playwright/mcp@latest --browser chrome --headless --isolated`.
It needs no running signed-in Chrome or extension token. Other TRAE starts and resumes pass `enabled: false` for
`mcp_servers.playwright`, so an existing global headless block does not start a server for those threads. Browser modes
pass `enabled: true`, including when a global server is disabled. Every override includes a command and arguments:
TRAE rejects a disabled entry without a transport when no global Playwright server exists. The saved launch's route
arguments or routed-seat category and browser flags determine the same mode on subsequent `turn` calls.

Configuration evidence (TRAE CLI 0.214.1, 2026-11-16): in a throwaway `HOME`/`TRAE_HOME`/`CODEX_HOME`,
`traex mcp get playwright --json` reported `enabled: true` for a configured fixture command;
`traex mcp get playwright --json -c mcp_servers.playwright.enabled=false` reported `enabled: false` and retained its
transport. The installed CLI's `app-server generate-json-schema --out <fixture-dir>` exposes arbitrary `config`
objects in both `ThreadStartParams` and `ThreadResumeParams`. Launcher fixtures verify the override on both RPCs.
An isolated Codex CLI 0.167.0 app-server control with a fixture MCP command reported `runtimeStatus: disabled` and zero fixture
server starts for `thread/start` with `config.mcp_servers.playwright.enabled: false`; enabling it launched the fixture.
An isolated TRAE app-server `thread/start` probe stopped at `No Trae auth token available for Trae model fetch`;
no real hub or credentials were used, so live TRAE process suppression has not been measured in this change.

The worker uses Playwright MCP's `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_fill_form`, `browser_take_screenshot`, and other `browser_*` tools. It does not use the ChatGPT runtime or
Claude browser skills. If the extension/browser is unreachable it reports BLOCKED with the exact Playwright error;
`Extension connection timeout` means the extension/pairing or the TRAE hub's Chrome-profile access needs repair; the
verified token flow does not show a manual approval dialog. The ChatGPT-app
version-mismatch guard does not apply to this bridge. The `--browser-origins` list is given to the worker as the set of sites it may visit; nothing enforces it technically on TRAE (unlike the per-site approvals on TTADK/ChatGPT), so the task brief is the scope boundary and the worker reports BLOCKED when a task or redirect leaves the list.

Live verification on this Mac (2026-11-14): `--extension --profile-dir-name 'Profile 1'` with the token in the named
environment variable connected without an approval dialog while the screen was locked. `browser_navigate` reached
example.com and the signed-in Lark Drive home. The MCP server must be spawned by the TRAE hub/thread, which has access
to the Chrome profile directory; an ordinary sandboxed test shell does not.

A non-TRAE Codex worker can operate the user's signed-in Chrome through the ChatGPT app's **Chrome plugin**. It can also operate
desktop apps through the **computer-use plugin**. Both use the local pieces the ChatGPT desktop app uses, and both work
with any model provider, TTADK included. Routing (user, 2026-11-15): `browser` and `ui-browser` go to an observed free TRAE
Playwright lane (token present, candidate model load <60%, no queue/stall), then browser-ready TTADK Codex, a browser-ready personal ChatGPT account, and Claude. The
two personal steps need the user's OK; re-run route.mjs after an account failure instead of choosing one by hand.

### Prerequisites (once per machine)

- **ChatGPT desktop app.** Install it and open it once. It unpacks the bundled plugins under
  `~/.codex/.tmp/bundled-marketplaces/openai-bundled/` and ships `node_repl` under
  `/Applications/ChatGPT.app/Contents/Resources/cua_node/`.
- **ChatGPT Chrome extension.** In the ChatGPT app, go to Settings > Computer use > Google Chrome and install the
  extension; this also registers the native host `com.openai.codexextension`. Verify with
  `node <plugin>/scripts/check-extension-installed.js --browser chrome --json`.
- **macOS permissions (computer use only).** "Codex Computer Use" needs Screen Recording and Accessibility, which the
  ChatGPT app's computer-use setup asks for.
- **Account config.** Run `codex-worker.mjs --account <name> browser-setup` on an account with its own config.toml,
  such as `ttadk`. It refuses a home whose config.toml is a symlink to `~/.codex`. It writes:
  - the main home's plugins, installed with `codex plugin add` (an enabled entry in config.toml alone does not install
    a plugin; before 2026-11-07 TTADK ran with none of them): `chrome`, `computer-use` and `visualize` from the app's
    bundled marketplace, and `documents`, `pdf`, `spreadsheets`, `presentations` and `template-creator` from the
    primary runtime (`~/.cache/codex-runtimes/codex-primary-runtime/...`, unpacked by the ChatGPT app; their
    dependencies live there too). They are skills and hooks, so they work on any model provider (user, 2026-11-07:
    align the accounts). The marketplace name `openai-bundled` resolves only on the app's own home, so other homes
    list the same plugin dirs through `<home>/marketplaces/chatgpt-bundled` (rebuilt on every run, plugins symlinked
    to the app's unpacked copy). Rerun `browser-setup` after a ChatGPT app update.
  - Not enabled: the in-app `browser`, `codex-app-tools`, and `unified-computer-use`, whose `cua_repl` needs the app's
    browser access host (a CLI run gets "The browser access host is unavailable", tested 2026-11-07); ChatGPT
    connectors (Gmail, Drive…) come with a ChatGPT account and don't exist on TTADK;
  - `node_repl` with `default_tools_approval_mode = "approve"` (otherwise CLI runs refuse its calls outright);
  - `NODE_REPL_TRUSTED_SERVICES = {"sky":"@oai/sky/service","browser":"@oai/browser-desktop/service"}`. The ChatGPT app
    sets this itself; without it the CLI fails with "Trusted RPC service is not configured: browser", or with "sky
    requires node_repl" for computer use.

  It then marks the account `browser: true` in `codex-accounts.json`.

### Running a browser worker

- **Hub workers only.** Per-site approval ("Allow Browser use to access <origin>?") and per-app approval arrive as MCP
  elicitations. Only `codex-worker` can answer them: `--browser-origins` takes origins or host globs such as
  `*.bytedance.net`, and `--computer-use-apps` takes bundle ids. Those flags start the thread on-request; the worker
  accepts listed sites and apps for the session, declines everything else, and logs each decision.
  - `codex exec` can't answer elicitations, so it can't reach any site.
  - The official `[browser_use.origins]`, `[browser_use.default_origin_policy]` and `[computer_use.macos.bundle_ids]`
    config is not consulted on CLI runs (tested).
  - `route.mjs browser` prints the command, with `POLICY.browserOrigins` (internal domains) plus `--origins`.
- **Chrome must already be running.** In the read-only sandbox a worker can't check processes or launch apps, and the
  plugin's own docs say to ask before launching Chrome. Run `pgrep -x "Google Chrome" >/dev/null || open -a "Google Chrome"`
  before dispatching.
- **Computer use needs an unlocked screen.** A locked Mac shows no windows (`cgWindowNotFound`), and `codex-worker`
  exits 5 early. The ChatGPT app's "Locked use" unlock is reserved to its own turns by design. Don't try to reuse it.
- **Codex browser brief.** Paste these clauses into every Codex browser worker's brief:
  1. "Use the node_repl `js` tool (may appear as `mcp__node_repl__js`). First run:
     `const { setupBrowserRuntime } = await import("<chrome plugin>/scripts/browser-client.mjs"); const agent = await setupBrowserRuntime(); const chrome = await agent.browsers.get("chrome"); nodeRepl.write(await chrome.documentation());`
     and follow that documentation, including tab-claiming-chrome."
  2. "Work in tabs you create (`chrome.tabs.new()`). If your own click opens a new tab, you may claim exactly that tab:
     list `chrome.user.openTabs()` before and after the click, and claim the new entry whose URL matches the link. Close
     the tabs you created and any tab you claimed; claimed tabs are not closed automatically. Never read, touch or
     close the user's other tabs."
  3. "Read-only unless this brief says otherwise: don't submit, approve, buy or change settings."
  4. "Don't read cookies, passwords or storage. If a site is declined or sign-in blocks you, report BLOCKED with the
     exact error rather than working around it."
- **Measured (2026-11-07, TTADK Sol, read-only):**
  - Feishu wiki: read and followed a new-tab link; BITS and ByteCloud dashboards: read.
  - Google search: typed a query and pressed Enter; example.com: screenshot.
  - A site outside the allow-list was declined.
  - Each task took 50–110s. Claude in Chrome did the same suite in 4–20s, because Codex reloads the plugin and its
    docs on every run.
- **Fragility:** this relies on ChatGPT.app internals (`NODE_REPL_TRUSTED_SERVICES`, the cua_node paths). After a
  ChatGPT app update, rerun `browser-setup`, or fix `config.toml` by hand if a path moved. If Codex browser work keeps
  failing, re-route with `--exclude-account ttadk` (it goes to Claude) and tell the user.
  - `browser-setup` writes the node_repl env the ChatGPT app writes for itself, including `env_vars` for the
    `BROWSER_USE_ACCESS_*` pass-through, `BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"`,
    `BROWSER_USE_TINYSKY_ENABLED`, and `BROWSER_USE_CODEX_APP_VERSION`, which is read from ChatGPT.app's Info.plist.
    Rerunning it rewrites its own marked block in place.
- **"Browser is not available: chrome"** comes up even when everything is set up, if the extension's native host
  ("ChatGPT for Chrome", socket under `/tmp/codex-browser-use/`) is momentarily disconnected. On 2026-11-07 it came back
  on its own within a minute. `codex-worker` prints a `browser-unavailable:` line. Check
  `pgrep -f "ChatGPT for Chrome"`, wait a minute, and retry once. If it fails again, re-route to Claude.

## Permissions and environment

- The user's `~/.codex/config.toml` defaults to yolo (`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`), which is the equivalent of bypass mode. On another machine, check it before assuming. The CLI flags are `-s read-only|workspace-write|danger-full-access` and `--dangerously-bypass-approvals-and-sandbox`.
- **Router default (user decision 2026-11-13):** writing workers on ChatGPT Codex, TTADK and TRAE use `danger-full-access`; `--mode` remains accepted but does not change that choice. A full-access worker may commit on its task branch only when the brief says so; never push to main, never force-push, and add no co-author/tool trailer. Claude workers separately always use explicit Bypass.
- **Review/test boundary:** non-writing categories, including reviews, default to `read-only` so a reviewer cannot edit the code under review. Pass `--runs-tests` when that task must run suites that create temporary/build files; it selects `workspace-write`, never full access. Pass `--sandbox workspace-write|read-only` only as an explicit narrower override for one Codex-family task.
- **Signed-in CLI queries:** add `route.mjs ... --read-only --needs-cli lark,bytedcli` when the task needs an installed, already signed-in CLI. Codex `read-only` and `workspace-write` sandboxes block the keychain access these CLIs need. `--needs-cli` selects `danger-full-access` even with `--read-only` or a narrower `--sandbox`; it keeps the task's read-only intent, records `needsCli` and `readOnlyByInstruction` in the task spec, and prints the query-only instruction once. The brief must keep CLI use to queries, with no writes. A parent sandbox ceiling still applies. Without the flag, an explicit `--read-only` route prints a short keychain warning. This flag does not authorize reading or exporting login material; use the CLI's normal commands and report BLOCKED if they require login.
- **Cards do not widen sandboxes.** For approvable non-secret actions (pushes, external posts, installs), arrange a user card and let an authorized agent execute, not the user; never evade a sandbox/denial. See [permission plan](../SKILL.md#permission-plan).
- **Login material is forbidden for every worker:** never read, copy, load or inject login sessions, SSO/session tokens, cookies, CLI auth files such as bytedcli's, API keys, `.netrc`, browser profiles, or other people's/other apps' keychain items, and never use any way of getting past a login. Running an installed, already signed-in CLI (for example bytedcli) through its normal commands is allowed and expected; what is forbidden is reading, copying, exporting or injecting its auth files or session. Stop only when the command itself reports an authentication error. The same holds for ssh and git: let them use the user's normal ~/.ssh configuration and default keys through their own commands, and do not override GIT_SSH_COMMAND, `ssh -F` or IdentityFile to avoid them; what is forbidden is reading, copying, printing or exporting key material yourself. Service keys the user placed in a project's own configuration (for example the project's .env) may be USED by running that project's code or CLI, only to call that service's official API as the project does; never print, copy, write elsewhere or send them to another service, and never read keys, sessions or auth files that live outside the project. Missing login or authorization means BLOCKED with what needs signing in.
- **Our own registered test packages may be signed** (user-authorized 2026-11-13): `--signing` retains the scoped signing note and full-access policy. Manifest and hash must be in `~/.claude/orchestrator/_shared/user-signing/registry.json`; identities must be on the user-approved `~/.claude/orchestrator/_shared/user-signing/identities.json` allowlist (rules owner maintains dated approvals): H6 keychain identity for iPhone 8; cosign team DH59R4RNRY development certificate + profile 3JVMQQBHUR for iPhone 11, valid to 2027-09; repo-committed Android debug keystore. Only orchestrators write registry entries; signing workers treat registry.json and identities.json as read-only. New identities require a new user approval card and allowlist entry; a worker needing a new entry or an unlisted identity reports BLOCKED. If H6 is locked, pass only its one designated password file through stdin, never argv/env/logs. Android's repo debug passphrase from build.gradle goes through file descriptors such as apksigner file:/dev/fd/N, never argv. Never export/copy/print/log passwords or keys; report PASS/FAIL, certificate fingerprint and hashes; write a receipt under user-signing/receipts/; re-lock the keychain unless another registered signing run is active; never sign production/release packages or touch other keychains. Anything outside scope is BLOCKED and needs a user card. A Codex worker never auto-launches a signing hop.
- **A `workspace-write` override can't run git writes** (verified 2026-10-30): Codex keeps every git metadata dir read-only in it — the worktree's `.git`, the main repo's `.git/worktrees/<name>`, even when added as a writable root — so `git add`, `commit`, `fetch` and `rebase` fail with "Operation not permitted". That is deliberate (a sandboxed write to `.git/hooks` or `.git/config` would run outside the sandbox at the next git command), so don't work around it. Brief such workers to edit only, leave the changes uncommitted and report the changed files and a commit message; then review the diff and commit yourself. If the diff touches hook scripts or their config (`.husky/`, `.pre-commit-config.yaml`, `core.hooksPath` targets, package scripts run by hooks), commit with `--no-verify` or ask the user, since your commit would run them unsandboxed. Its network follows `[sandbox_workspace_write] network_access` in `~/.codex/config.toml` (on in the user's config); `--network on|off` overrides it per worker or turn.
- **Quota**: `codex-worker.mjs [--account <name>] usage` prints a ChatGPT account's windows, reset cards and id as JSON (`quota` the windows only); `scripts/quota.mjs` combines every account with Claude's (see SKILL.md, routing). A TTADK account has no windows; `quota.mjs` reports its health instead (see TTADK above).
- **Read-only tasks**: the router passes `-s read-only` by default for non-writing categories; say "read-only" in the brief.
- **Skills**: `~/.codex/skills` is symlinked to the same skills directory, so Codex sees most skills. Some can be disabled per skill in config.toml under `[[skills.config]] enabled = false`.
- **Memory**: `~/.codex/AGENTS.md` bridges to Claude: it tells Codex to read `~/.claude/CLAUDE.md`, then the memory files a brief's "Relevant memory" section names, then the `memory/MEMORY.md` of the project its working directory maps to. That is only an instruction (in a 2026-10 sample, about 4 of 7 real worker runs read any Claude memory), so the brief's "Relevant memory" section, as SKILL.md describes, is what makes it reliable. Tested 2026-10-30 on Luna `low`: given only a list of memory paths, it answered without opening any file; told "before anything else, read each of these with a shell command; they are required input", it read them and `~/.claude/CLAUDE.md` and answered both questions correctly. What Codex learns goes to its own `~/.codex/memories/`, which Claude never reads; the report's "Durable lessons" section brings it back.
- Codex has no Artifact or Claude Docs tools. Feishu work goes through `lark-cli`, which the lark skills document.

## Sub-agents inside a Codex worker (verified 2026-11-04, codex-cli 0.166)

Historical capability evidence only, not current permission. In the 2026-11-04 experiment a Codex worker could spawn its own sub-agents: the `multi_agent` feature is stable and on (`codex features list`;
`multi_agent = true` in `~/.codex/config.toml`). Tested with `codex exec` and with a hub `codex-worker start`, both on
Luna `low` with a read-only sandbox. In each run the worker spawned 2 sub-agents through `collaboration.spawn_agent`,
and both returned the right file contents.

- **Sandbox:** sub-agents inherit the worker's sandbox. A write in a read-only run failed with "operation not
  permitted".
- **Quota:** sub-agents spend the same account's Codex quota, never Claude's, and add nothing to the orchestrator's
  context.
- **Visibility:** the run's JSONL (`codex exec --json` or the hub log) shows only `collab_tool_call` items with
  `"tool":"wait"`. The spawns themselves don't appear there. Each sub-agent is its own thread under
  `<account home>/sessions/`, with `parent_thread_id` set to the worker's thread.

**Current rule (2026-11-15): workers do the work themselves, with no sub-agents or handing work/review to another model. They never ask to switch model/account or personal quota; report actual model/tool unavailability to the orchestrator. Starts, one-shot execs, resumes and automatic reroutes inject the latest worker digest plus the shared fixed operational clauses. Copy only task-specific route `notes` into briefs; `fixedNotes` in `--json` are diagnostics and need no copying. Default route text omits them; `--verbose` includes them. Claude launch commands load the same rules with `rules-worker-digest.mjs` and `--append-system-prompt`.**

## Differences from Claude workers

- **Messaging is one-way, from you to the worker.** Codex has no SendMessage or ListAgents, so it can't message you or peers, and
  peers can't find it by name. You (or a peer you give the thread id to) can reach it:
  - workers started through the hub (`codex-worker.mjs start`/`turn`): `codex-worker.mjs --account <name> steer` reaches the running turn
    immediately, and `interrupt` stops it. Relay device handoffs, changed plans and peer requests this way;
  - `codex exec` runs can't be steered: queue a message with `codex queue` (it's read at the next resume), or stop and resume.
  The worker still reports only through its files and its final message, so the brief must be self-contained:
  - the workspace and the files it must not touch;
  - the git and push rules;
  - device holds through `res` (Codex can run the script), taken as `--by codex:<thread id>`;
  - where to write the report, and to start its final message with `[<id>] DONE | QUESTION | BLOCKED | FAILED`. A question
    ends the run; resume it with the answer.
- **Keep on Claude workers**: anything that needs Artifact/Docs tools (browser/frontend work follows free TRAE
  Playwright Extension → TTADK → personal ChatGPT → Claude; desktop uses TTADK → personal ChatGPT), or a worker that must negotiate
  with peers itself. Device runs that share phones mid-run can go to a hub-started Codex worker: steer it with handoffs. It
  can't negotiate with peers, so you broker.
- **Verify before reporting.** Spot-check the cited file:line and commits, as for any worker.

## Image generation (verified 2026-10-30, codex-cli 0.166)

Codex has a built-in image tool (`image_gen.imagegen`; feature flag `image_generation`, stable and on by default; check with
`codex features list`). Claude can't generate images, and the user prefers Codex for every image-producing task (2026-11-03), so they all go to
Codex (`route.mjs image-gen`: personal gpt-6-luna `low` first (standing exception, no question), Sol `medium` when iteration needs judgment; the image tool determines image quality).

- **Run** a short `codex exec` as a background task, personal Luna (`gpt-6-luna`) `low`, `-s workspace-write`, in the folder the image should land in:
  `CODEX_HOME=<account home> codex exec [--skip-git-repo-check] -C <dir> -s workspace-write -m gpt-6-luna -c model_reasoning_effort='"low"' --json -o <dir>/codex-last.md "Generate one image with your image generation tool: <description, style, aspect>. Save it in the current directory as <name>.png and report the saved path." < /dev/null > <dir>/codex.jsonl 2>&1`
  The model only phrases the prompt and copies the file, so personal Luna `low` is enough; the image quality comes from the image
  tool, not the chat model. A test run (one 1254×1254 PNG, 1.5 MB) took about a minute and ~74K input (mostly cached) /
  ~300 output tokens.
- **Where the image is:** the tool writes to `<account home>/generated_images/<thread id>/exec-<uuid>.png`; the copy into the
  workspace is a plain `cp` the model runs, so ask for the name and folder explicitly. The image call itself does not
  appear in the `--json` events (only the `cp` does): confirm the file exists, then look at it (Read the PNG) before
  reporting.
- **Iterate** by resuming the same thread with what to change, so it keeps the earlier prompt and style.

## Choosing model and effort

`scripts/route.mjs` picks model, effort and account; `references/model-routing.md` explains why. Codex-specific
facts behind it (2026-11-03):

- **Plan:** Pro since 2026-10-30 (the API reports `prolite`): a single weekly window — OpenAI's docs say Pro plans
  currently have no five-hour limit. Plan credits per MTok, relative to Sol 6.1: Astra 5x (10x on cached input),
  Terra 0.5x, Luna 0.05x (0.1x cached). Fast costs 2.5x of included usage, Ultrafast 8x. There is no per-effort
  multiplier: higher effort just spends more tokens. Sol has no long-context surcharge in Codex.
- **Efforts:** `low`, `medium`, `high`, `xhigh`, `max`, `ultra` (Luna stops at `max`); no `none` or `minimal` in the
  CLI. Don't route to `ultra` (the router never does): it makes every turn fan out and multiplies usage. Workers may not spawn sub-agents; the experiment below is historical only.
  Set the effort on every launch: the catalog default for Sol is `low` (weak for coding: Terminal-Bench 4 31%); the
  user's config sets `high`.
- **Models:** `gpt-6.1-sol` is the workhorse and Codex's default (near Astra, 500K context); `gpt-6-astra` is the
  frontier model at 5x; `gpt-6.1-terra` is positioned for writing and visual understanding, not coding (its
  computer-use strength is not what the Codex computer-use plugin relies on); personal `gpt-6-luna` remains the first lookup (`low`), extract (`medium`) and image-generation (`low`) choice. Only TRAE `gpt-5.6-luna` is unused (slow, about 3x tokens). Don't pick `gpt-6-sol` or the
  `gpt-5.6-*` models on personal ChatGPT accounts: they're older at the same or higher cost. TRAE's approved company-quota
  choices are separate: hard work uses Sol then Astra; normal work uses Sol, 5.6-Sol, 5.6-Terra then Flash;
  light/background work walks 5.6-Terra, 5.5 then Flash unless a hard rule applies
  (2026-11-13; references/model-routing.md). Same-task rework may reuse the author thread only under SKILL.md's
  "Rework thread choice" rule; keep the reason in the ledger. The follower records actual model/account/effort
  and provisional task outcomes automatically; `outcome.mjs` is only for acceptance, cause, scope or cancellation
  corrections. Manual fields override automatic records, and `--correct` overrides previous manual fields.
  Review seats must finish with exactly `REVIEW-RESULT: blocking` or `REVIEW-RESULT: none`; missing markers stay UNKNOWN.

Check every worker's work:
- the cited file:line exist and say what's claimed;
- builds and tests really ran;
- commits contain only the intended files;
- conclusions match the evidence.

If a worker's result fails that check, or it stalls, resume it with a sharper instruction, raise the effort, or follow
re-route with `route.mjs <category> --failures <n+1>`, and note it in the ledger.

**Tell the user promptly when Codex keeps falling short** (user's instruction, 2026-10-30), on any model. Report it right away rather than quietly working around it. Examples:
- repeated failed acceptance or escalations;
- fabricated evidence;
- touching files it was told not to touch;
- stalls or unfinished runs.

Include what happened (task, model, effort, symptom) and what you did about it. The user decides whether to keep using Codex.

Company queue/unavailable handling applies to the actual TTADK or TRAE account/model lane: bounded patience, no-work cancellation, scoped exclusions and owner handoff. TRAE queue backoff and 983/cyberPolicy midnight restriction are provider-specific; TTADK records ordinary unavailable/policy evidence without that restriction. Never clear restriction/denial state merely to probe. Project dependencies and build tools fetched through normal package managers and registries (npm/pnpm/yarn, pip/uv, gradle/maven, CocoaPods/SPM, cargo, go modules, brew formulae, and SDK/toolchain components the build asks for) are installed directly into the task workspace or user-level caches, without a card or question. No secrets/credentials, production changes without a card, unapproved personal quota, or system security changes; a required login the worker lacks is BLOCKED.

### Browser launch preflight (changed 2026-11-15)

Before browser `start`/`turn`, codex-worker checks the installed ChatGPT `check-extension-installed.js` plus the connected Chrome host, or checks the Playwright pairing-file existence and performs a bounded `browser_tabs` connect through the existing MCP launcher. It never prints or reads pairing material itself. Failure emits one `BLOCKED browser preflight:` line with a repair hint and exits nonzero before the hub turn. The bound is a few seconds; `--no-browser-preflight` explicitly skips it. Use `route.mjs --failure-kind tool --failures N --actual vendor:model:effort@account` for a failed browser channel.

Inbox replies received before delivery are rendered once as `answered: <question> → <answer>` rather than an open ask. Unique short owner UUID prefixes resolve from full owner IDs in events; ambiguous/unmatched prefixes are reported unresolved in `mine` and the worker-event audit.

Claude launches use the trusted project root (`--trusted-cwd` or project-profile `root`/`projectRoot`), and name the actual working directory in the prompt. Takeover/build briefs carry exact checked commands, non-secret variables and expected artifacts. iOS backups exclude protected `Library/SplashBoard/`, must be readable before install, and use over-the-top installation when save data matters.

Existing-thread turns check the rollout before contacting the hub. Above 5 MB or a recorded 20 million cumulative input tokens, `turn` exits 9 and prints the original route command with `--failure-kind infra`; start a fresh thread with a complete handoff brief. Override limits with `--max-rollout-mb` / `CODEX_WORKER_MAX_ROLLOUT_MB` and `--max-input-tokens` / `CODEX_WORKER_MAX_INPUT_TOKENS`; `--force-large` explicitly bypasses the check. Setup-stalled followers settle only when a bounded complete hub list confirms the thread is absent or idle. Read-only `status` never writes run events.
Provider error `-4399` / `exceeded request buffer limit` is `thread-too-large`, not a retryable infrastructure or model failure: it prints the same fresh-thread guidance and records the time in the thread's launch metadata. Later `turn` calls exit 9 before contacting the hub, even below the rollout/token limits; `--force-large` bypasses the guard without clearing the marker.
