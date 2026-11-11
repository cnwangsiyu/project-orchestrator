# Codex CLI as a worker

Use this whenever `scripts/route.mjs` puts a task on Codex — mostly coding (implementation, build/test/deploy and debugging runs, code review), plus bulk extraction, quick lookups, drafts and image generation. The router also prints the exact launch command, with the account, model, effort and sandbox filled in. Codex runs on the user's ChatGPT plans, not on Claude credit.

**Which launcher:** use `scripts/codex-worker.mjs` through the hub (below) by default, since only it can steer, interrupt and re-attach. Use plain `codex exec` for short one-shot runs that will never need steering (the router's `exec` rows: lookups, extraction, drafts, image generation and the `second-opinion` row; the paired second opinions of `review-high` and `design` run as hub workers). Verified 2026-10-30 on codex-cli 0.166.0. The model catalog changes, so re-check it with `codex debug models` before relying on the ids below.

## Launch, resume, follow

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

`codex exec` can't be steered mid-run, but the app-server protocol can: `turn/steer` injects a message into the running turn (taken
into account in that same turn), and `turn/interrupt` stops it. `scripts/codex-worker.mjs` wraps this. Every command connects to its account's
hub over WebSocket (`--account <name>`, default `main`), so the process that started a worker and the one that steers it can differ.

- **Hub**, one per account, localhost only, reused by every orchestrator. `codex-worker.mjs --account <name> hub` checks it and, if it's down,
  starts it detached (log in `<account home>/hub.log`) so it outlives your session. Running workers die if the hub dies. `CODEX_HUB` overrides the URL. The hub has no
  authentication: any local process can start or steer a thread on it, so keep it on 127.0.0.1 and only on a machine you trust. (The managed daemon's unix socket speaks WebSocket too; Node's
  WebSocket can't dial a unix socket, hence the TCP hub.)
- **After a re-login or plan change, restart that account's hub.** (To use another account, add it as a profile — see Several Codex accounts — rather than re-logging the main home.) It keeps the login it started with, so once `<account home>/auth.json`
  changes, hub calls fail with `401 ... token_expired` (seen 2026-10-30 after the upgrade to Pro). Restart it only while no
  worker runs on it — `codex-worker.mjs --account <name> list` shows every thread `notLoaded` — by stopping that account's
  `codex app-server --listen <its hub>` process and running `codex-worker.mjs --account <name> hub`; `quota.mjs` flags a hub whose login changed; otherwise tell the other orchestrators first. `codex exec` runs read the
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
  - A running shell command still produces events, but a worker waiting on its own sub-agents can be quiet that long.
    So first check `status` and the worker's child threads (`parent_thread_id` under `<account home>/sessions/`).
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

**Why it's preferred:** usage goes to the company and counts toward the user's Devmind AI contribution, not to a
ChatGPT plan. **Prefer it whenever it is healthy; fall back to the ChatGPT accounts when it isn't.** `route.mjs` does
this.

### Setup on a new machine

1. Install the CLI: `npm install -g @byted/ttadk@latest --registry=https://bnpm.byted.org`.
2. Log in to SSO once. The user runs `! ttadk auth login sso`. The session lasts about two weeks; `quota.mjs` warns two
   days before it ends.
3. Run `node <this skill>/scripts/codex-worker.mjs ttadk-setup`. It:
   - checks `ttadk`, the SSO session and that the gateway lists `gpt-6.1-sol` for codex;
   - creates `~/.codex-ttadk` with the gateway provider config (auth through `ttadk get_params --sso sso`);
   - symlinks `AGENTS.md`, `skills` and `rules` from `~/.codex`;
   - registers account `ttadk` (kind `ttadk`) on the next hub port.
4. Start its hub: `codex-worker.mjs --account ttadk hub`. Hub workers need it; `codex exec` runs don't.
5. For browser work, also run `codex-worker.mjs --account ttadk browser-setup` (see the next section).

### Models and routing

- **Models:** the gateway's codex list is `ttadk models -f json` (agents including `codex`). As of 2026-11 it has
  `gpt-6.1-sol` and `gpt-5.6-terra`, but no Luna, Astra or GPT-6.1 Terra. The image tool isn't served either.
- **Routing:** every task TTADK's Sol can handle runs there first (user, 2026-11-07), as Sol at the row's effort (at
  least `medium`), one notch higher after a failure when that is below `max`. Claude-only rows, image generation (its
  Sol fallback step included), `research` on an account without the proxy below, second opinions and reviews of
  Codex's work, and browser work before `browser-setup` follow the earlier routing (`references/model-routing.md`).
  On a TTADK device the ChatGPT and Claude quota is left for the user's other device.
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
  until the reset; "wait": hold it until then. Only `--urgent` (already approved) runs on personal quota without asking; high stakes ask too (user, 2026-11-09). `codex-worker` prints
  `quota-exhausted:` for such a failure: don't retry, and don't try another TTADK model. Usage dashboard:
  `https://gdp-portal.bytedance.net/llmbox/dashboard` (extra quota can be requested there; that is the user's call).
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

Order for Codex work: **TTADK first, then TRAE CLI, then personal quota** (ChatGPT accounts / Claude). `route.mjs` picks
TRAE whenever TTADK is out (daily quota used up, down, or `--exclude-account ttadk`) and TRAE is healthy; the OK gate for
personal quota appears only when both company accounts are out. The user chose not to cap TRAE usage.

- **What it is.** TRAE CLI (`traecli` / `traex`) is the company's official agent CLI (the compliance FAQ lists it as
  cleared), a fork of Codex maintained by the TRAE team, with its own model pool, separate from TTADK's. Models include
  GPT-6.1-Sol, GPT-6-Astra (often queued), GPT-5.6 Sol/Terra/Luna, Gemini 3.1 Pro, Seed, DeepSeek; no Opus on this
  account, no Kimi.
- **Same harness as Codex for GPT-6.1-Sol** (compared 2026-11-08): the same "You are Codex…" base prompt (about 28 lines
  differ, in the plugin/app section), the same tools (code mode, unified exec, freeform apply_patch, multi-agent v2, web
  search). A 5-check test (fix + tests + AGENTS.md, web search, skills, image input, resume) passed on GPT-6.1-Sol and
  Gemini 3.1 Pro, and `traex app-server` worked unchanged as a codex-worker hub.
- **Not on TRAE:** the ChatGPT Chrome / Computer Use plugins (its browser runtime finds no browser: the Chrome extension
  side accepts only the OpenAI-signed Codex client, which we don't work around), and image generation. Browser, ui-browser,
  computer-use and image work stay on TTADK / Claude / ChatGPT. A TRAE worker that needs a web page has the `playwright`
  MCP server: a separate headless Chrome with no user sign-ins.
- **Setup** (once per machine): install (`sh -c "$(curl -fsSL https://code.byted.org/api/tos-proxy/download/traex_install.sh)"`),
  `traecli login --git-code` (no browser needed; `--sso` otherwise), then `codex-worker.mjs trae-setup` (registers
  account `trae`, hub port next free; writes into `~/.trae/traecli.toml`: `commit_attribution = ""`, `web_search = "live"`,
  the playwright MCP server, network in workspace-write, `hatch-pet` off as on the main home; installs the same
  document plugins as the other accounts: documents, pdf, spreadsheets, presentations, template-creator, visualize) and
  `codex-worker.mjs --account trae hub` (starts `traex app-server`). Rerun `trae-setup` after a ChatGPT app update.
- **Same skills and instructions as the other Codex workers** (checked 2026-11-08): TRAE reads `~/.agents/skills`
  itself, and after `trae-setup` the skill list matches a TTADK worker's except TRAE's own two company plugins
  (`traex-guide`, `ai-contribution`, kept). Like every Codex worker it has no global AGENTS.md or Claude memory: the
  brief and the repo's own AGENTS.md carry the context.
- **Use.** Hub workers: `codex-worker.mjs --account trae start … --model GPT-6.1-Sol` (lower-case ids are mapped).
  One-shot: `traecli exec -C <dir> -s <sandbox> -m GPT-6.1-Sol -c model_reasoning_effort='"high"' --json -o <file> "<prompt>"`.
  `route.mjs` prints both. Sessions live in `~/.trae/cli/sessions`.
- **Health.** `quota.mjs` reads the account as healthy when the CLI is present, logged in and lists GPT-6.1-Sol, its
  hub is sound, and it isn't paused. TRAE publishes no quota numbers; a popular model can sit "Queued for capacity": no
  progress for 15 minutes → interrupt and re-route with `--exclude-account trae`.
- **Pause after failures** (`scripts/lib/trae-health.mjs`, user 2026-11-08). codex-worker records every failed or
  stalled TRAE turn and clears the record on a completed one. While paused, `quota.mjs` shows TRAE unavailable and
  `route.mjs` skips it (TTADK if usable, else the personal-quota OK gate), so tasks stop failing one by one. Pauses by
  kind (user, 2026-11-08):
  - transient — queue full (`request queue size is exceed`: seen 2026-11-08 with about 8 concurrent GPT-6.1-Sol tasks),
    rate limits, gateway errors, timeouts, stalls: two within 15 minutes pause it for 5 minutes, then 10, 20, at most 30
    while pauses follow each other without a success (the backoff starts over after a success or an hour clear);
  - auth — not logged in, 401, expired token: 30 minutes, lifted as soon as `login status` is fine again;
  - hard — quota used up, banned, 403 Forbidden, `Model access temporarily restricted` (code 983: TRAE restricted the
    account's GPT models on 2026-11-10 after about 1.3B tokens in a day; Gemini/Seed/DeepSeek kept working): 30 minutes,
    then 60, 120, at most 240 while they keep coming without a success. codex-worker prints `trae-paused:` when it pauses. A `traecli exec` run bypasses codex-worker: record its failure
  (or a run you interrupted) with `codex-worker.mjs --account trae note-failure "<error>"`. To lift a pause by hand,
  delete `~/.trae/worker-health.json`.

## Browser use (and Computer Use) on a Codex worker (verified 2026-11-07)

**Which accounts count as browser-ready** (2026-11-10): an account marked by `browser-setup`, or any Codex home whose
`config.toml` has the `node_repl` MCP server with the browser service — the ChatGPT app writes that itself into its own
home (`~/.codex`, account `main`), so `main` is ready wherever the ChatGPT app is installed and set up for Chrome.
`route.mjs` sends browser, ui-browser and computer-use work to TTADK when it is browser-ready, else to a browser-ready
ChatGPT account, else to Claude. On a new machine: install the ChatGPT app and its Chrome extension, then run
`browser-setup` for every other account (`--account b`).

A Codex worker can operate the user's signed-in Chrome through the ChatGPT app's **Chrome plugin**. It can also operate
desktop apps through the **computer-use plugin**. Both use the local pieces the ChatGPT desktop app uses, and both work
with any model provider, TTADK included. Routing (user, 2026-11-07): the `browser` row goes to TTADK Codex when that
account is browser-ready, and to Claude otherwise.

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
- **Never give a Codex worker more than the orchestrator has.** That is the same rule as for Claude workers, and it keeps a Codex worker from doing what this session's permissions would block. `danger-full-access` only when the orchestrator runs in bypass mode; otherwise `workspace-write` for writers, and keep anything the orchestrator would need approval for (pushes, external posts, installs) out of the brief and do it yourself, with approval.
- **`workspace-write` can't run git writes** (verified 2026-10-30): Codex keeps every git metadata dir read-only in it — the worktree's `.git`, the main repo's `.git/worktrees/<name>`, even when added as a writable root — so `git add`, `commit`, `fetch` and `rebase` fail with "Operation not permitted". That is deliberate (a sandboxed write to `.git/hooks` or `.git/config` would run outside the sandbox at the next git command), so don't work around it. Brief such workers to edit only, leave the changes uncommitted and report the changed files and a commit message; then review the diff and commit yourself. If the diff touches hook scripts or their config (`.husky/`, `.pre-commit-config.yaml`, `core.hooksPath` targets, package scripts run by hooks), commit with `--no-verify` or ask the user, since your commit would run them unsandboxed. Its network follows `[sandbox_workspace_write] network_access` in `~/.codex/config.toml` (on in the user's config); `--network on|off` overrides it per worker or turn.
- **Quota**: `codex-worker.mjs [--account <name>] usage` prints a ChatGPT account's windows, reset cards and id as JSON (`quota` the windows only); `scripts/quota.mjs` combines every account with Claude's (see SKILL.md, routing). A TTADK account has no windows; `quota.mjs` reports its health instead (see TTADK above).
- **Read-only tasks**: pass `-s read-only`, and say "read-only" in the brief.
- **Skills**: `~/.codex/skills` is symlinked to the same skills directory, so Codex sees most skills. Some can be disabled per skill in config.toml under `[[skills.config]] enabled = false`.
- **Memory**: `~/.codex/AGENTS.md` bridges to Claude: it tells Codex to read `~/.claude/CLAUDE.md`, then the memory files a brief's "Relevant memory" section names, then the `memory/MEMORY.md` of the project its working directory maps to. That is only an instruction (in a 2026-10 sample, about 4 of 7 real worker runs read any Claude memory), so the brief's "Relevant memory" section, as SKILL.md describes, is what makes it reliable. Tested 2026-10-30 on Luna `low`: given only a list of memory paths, it answered without opening any file; told "before anything else, read each of these with a shell command; they are required input", it read them and `~/.claude/CLAUDE.md` and answered both questions correctly. What Codex learns goes to its own `~/.codex/memories/`, which Claude never reads; the report's "Durable lessons" section brings it back.
- Codex has no Artifact or Claude Docs tools. Feishu work goes through `lark-cli`, which the lark skills document.

## Sub-agents inside a Codex worker (verified 2026-11-04, codex-cli 0.166)

A Codex worker can spawn its own sub-agents: the `multi_agent` feature is stable and on (`codex features list`;
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

**Allowed; the worker decides** (user, 2026-11-04). Codex workers may use sub-agents. Whether to use them, how many,
and for what is the worker's own call. Briefs don't ask for them, forbid them or prescribe how to use them.

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
- **Keep on Claude workers**: anything that needs Artifact/Docs tools (browser work, frontend checks and desktop apps go
  to TTADK Codex once `browser-setup` is done), or a worker that must negotiate
  with peers itself. Device runs that share phones mid-run can go to a hub-started Codex worker: steer it with handoffs. It
  can't negotiate with peers, so you broker.
- **Verify before reporting.** Spot-check the cited file:line and commits, as for any worker.

## Image generation (verified 2026-10-30, codex-cli 0.166)

Codex has a built-in image tool (`image_gen.imagegen`; feature flag `image_generation`, stable and on by default; check with
`codex features list`). Claude can't generate images, and the user prefers Codex for every image-producing task (2026-11-03), so they all go to
Codex (`route.mjs image-gen`: Luna `low` first, Sol `medium` when iterating on a result needs judgment).

- **Run** a short `codex exec` as a background task, Luna `low`, `-s workspace-write`, in the folder the image should land in:
  `CODEX_HOME=<account home> codex exec [--skip-git-repo-check] -C <dir> -s workspace-write -m gpt-6-luna -c model_reasoning_effort='"low"' --json -o <dir>/codex-last.md "Generate one image with your image generation tool: <description, style, aspect>. Save it in the current directory as <name>.png and report the saved path." < /dev/null > <dir>/codex.jsonl 2>&1`
  The model only phrases the prompt and copies the file, so Luna `low` is enough; the image quality comes from the image
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
  CLI. Don't route to `ultra` (the router never does): it makes every turn fan out and multiplies usage. Sub-agents a
  worker chooses to spawn are fine (see Sub-agents inside a Codex worker).
  Set the effort on every launch: the catalog default for Sol is `low` (weak for coding: Terminal-Bench 4 31%); the
  user's config sets `high`.
- **Models:** `gpt-6.1-sol` is the workhorse and Codex's default (near Astra, 500K context); `gpt-6-astra` is the
  frontier model at 5x; `gpt-6.1-terra` is positioned for writing and visual understanding, not coding (its
  computer-use strength is not what the Codex computer-use plugin relies on); `gpt-6-luna` is fast and cheap, for
  extraction, classification, summaries and images, and should not write code. Don't pick `gpt-6-sol` or the
  `gpt-5.6-*` models: they're older at the same or higher cost.

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
