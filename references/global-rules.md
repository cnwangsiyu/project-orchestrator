# Global Rules
version: 2026-11-13.6

## Changes In This Version
- Approved utilisation: passive idle hints, optional lane 3 requested (load <=8, available >=32 GiB), expiring TTADK quota preference and nightly utilisation; CPU probe has an independent 4s budget, optional ccache stays UNKNOWN.
- Persist both heavy-check formats with limit/lanes_held; overload review uses each sample's limit; live formula is min(20, 12 + 8 * lanes held by others).
- Close cleanup/lock interruption races, bound hook disk stalls, and surface hub backoff/logs; adopt live T88 v1.2 load gates 12/20.
- Integrate machine-wide resource sampling/retro/guarded cleanup; failed probes stay UNKNOWN, unsandboxed host qualification precedes installation.
- Consolidate owner-led policy, injection, launch/lock checks, acknowledgements and nightly audit.
- Live heavy-build contract and completed Android-native ccache pilot; first real cache use is cold.
- Owner installed SessionStart, four hub agents and 300s sampler on 2026-11-13; 04:30 cleanup stays dry. New template changes are not installed automatically.

## Orchestrator Rules
- Owner: routing/global-rules Orchestrator 主对话; secretary only relays, keeps ledgers/roster and asks cards.
- Read this digest on startup/resume/compact; after each version change write `rules-ack <version>` in your ledger.
- On every wake/patrol, cheaply tail `_shared/idle-hints.jsonl`, match your exact target and current ledger. Three low-load/high-idle samples/no waiters yield at most one hint per orchestrator/hour; hints never dispatch or bypass prerequisites.
- Owner pushes version/change/action/link notes via the secretary for the mini group, directly to MacBook orchestrators.
- Orchestrators judge, workers work. Route every task; parallelize independent work, keep coupled work together.
- Never silently hold runnable work: company quota without asking, personal quota after asking; reset cards need a fresh user OK every time.
- Claude workers always use `--remote-control --permission-mode bypassPermissions`; cards for what Bypass cannot pass, agents execute non-secret actions, only the user types secrets.
- TRAE restrictions are unrelated to our concurrency/quota; never reduce concurrency for queues. LLM throughput limits are QPM/TPM, no total-cost caps.
- Resources use shared `res`: short/urgent first, long/low-priority later; resources.md supplies five-minute sampling/retro/guarded cleanup and unlocked-build detection. Failed probes are UNKNOWN; telemetry never restarts hubs/reclaims locks. Validate a complete unsandboxed host sample before installation.
- Full-package builds hold `heavy-build` then a lane throughout; other heavy tasks hold a lane. ONE package slot stays; normal TWO lanes may float to THREE only after vesdk-mainline implements heavy-lane-3 with take-time load1m <=8 and available >=32 GiB. See heavy-lane-3-request.md; not rolled out here, use installed lanes only.
- Use `scripts/heavy-build.sh` or explicit `res` take/return. Plain take needs heavy-check; wait has a finite timeout. Live T88 v1.2 load limit = 12 + 8 * lanes held by others, capped at 20; STALE and caller-owned locks don't count, memory >=16 GiB unchanged. Check limit/lanes_held in heavy-check output; never bypass; timeout means report/queue.
- Pass the long-lived wrapper PID; return only owned holds in reverse order on every exit. STALE local dead-PID heavy locks older than 10 minutes may be reclaimed by res wait; never force active/unverified holds.
- Compile 6/link 1/Xcode -jobs 6/Gradle 2 workers; fixed per-base incremental directories, one cold acceptance build, affected tests in fixes, no native rebuild without native changes.
- No worker disk caps; auto-clean self-made clones/templates/caches only below 1 TB free on the data disk; deleting real workspaces/user data needs a card.
- ccache: Android NDK and host CMake Ninja/Makefiles only, both compiler launchers=/opt/homebrew/bin/ccache; not Xcode. SDK native graph validated, not full APK/Gradle acceptance.
- Shared CCACHE_DIR=$HOME/.vesdk-dev/ccache; max_size=96G/base_dir=/Users/bytedance/hash_dir=false/compiler_check=content. Allow only approved cache writes or scratch data with shared CCACHE_CONFIGPATH; no broad HOME grant/counter reset/sloppiness. First real use is cold.
- Gradle public/sanitized pure builds: --build-cache --daemon --max-workers=2, idle timeout 300000 ms, -Xmx6g; task-private Gradle home. No daemon when isolation depends on process exit or signing/login material; stop only your task's daemon.
- Claude settings document only: env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1; idle-stop has no switch (pin/keep working).
- Orchestrator models persist in jobs/<id>/state.json respawnFlags, not /model: VAK/routing Fable; Webview/Lynx Opus since 2026-11-11. On/after 2026-11-17 09:00 PST ask whether to restore Fable.
- Nightly account/model health: card for any company login expiring within 3 days, TRAE login state, Codex reset cards, Claude/Fable weekly projections. TTADK SSO expires 2026-11-21 19:37 PST; 72h warning, remind by 2026-11-18 19:37 PST unless renewed.
- TTADK reset <4h and fresh burn projection <70% of limit: eligible background/light work prefers TTADK over TRAE; missing data changes nothing. No quality downgrade, personal-quota spend or new work merely to use quota.
- Nightly: report utilisation in 2-3 lines (idle CPU with ready tasks/gate/memory/lane occupancy, reset quota waste by unit/model, queue hours/top causes). Tune within explicit approved ranges or ask; only lanes [2,3] have new numeric bounds, not idle/expiry/gate thresholds.
- Hub unreachable: probe with `codex-worker --account <name> list --limit 1`; start with `codex-worker --account <name> hub` only if unreachable; tell the global-rules owner. An empty successful list is reachable, not a restart signal; never duplicate workers.
- Cleanup never terminates any res-lock holder/tree; ambiguous PID/host/start metadata vetoes it. TERM/HUP/INT unwind through Chrome restoration, protected from repeated signals; SIGKILL/crash cannot guarantee recovery. Hub retries back off and eventually BLOCKED; nightly review reports state and log sizes.

## Worker Rules
- Never read, copy or load any login session or credential file (cookies, SSO/session tokens, CLI auth files such as bytedcli's, keychain items, .netrc, API keys), and never inject a session into a browser or tool to get past a login. Wherever a login or authorization is needed, stop and report BLOCKED with what needs signing in.
- Codex workers on this machine never touch signing/credential files, including keychain-password files or hashing, regardless of authorization. Strip/use sanitized public inputs, or the user runs the necessary operation once; do not plan on approval lifting the ban.
- Security follows context: attack-style findings/exploit material require a --security route, including implementation/fix work that reads them. Otherwise pass defensive requirements only; other security content still requires --security. No TRAE GPT on security decisions; don't bypass restrictions.
- Report the concrete model, effort and account (not merely TRAE); work only within the brief and sandbox. Missing login/access means BLOCKED, never a session transplant, login bypass or permission laundering.
- Builds use the heavy-build wrapper or res take/return per the contract; timeout means report/queue, never bypass. Return resources/close owned children on every exit; never kill another task's processes.

## Details
See SKILL.md's global index/build discipline, [resources.md](resources.md), nightly-review.md, and the live T83 lock-contract.md/enable-build-cache.md linked there. Launchd and hook install commands are in rules-enforcement.md; nothing is installed automatically.
