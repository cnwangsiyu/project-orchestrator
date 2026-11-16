# Global Rules Enforcement

User-approved 2026-11-13: four layers. `global-rules.md` is the versioned, <=60-line single injection source;
its `Worker Rules` section is extracted, not maintained as a second copy. Nothing below installs automatically.

## Injection And Acknowledgement

`rules-digest-hook.mjs` handles SessionStart startup/resume/compact/fork/clear. The existing
`worker-inbox-hook.mjs` delivers mid-session version changes at Stop or SessionStart, combining pending inbox
items and rule changes into one block reason. `stop_hook_active` skips all continuation delivery.
Both reuse `lib/rules-delivery.mjs` and the same orchestrator detection: title/name aliases ending in 主对话,
`_shared/orchestrators.txt`, cached recognition, the skill cwd, or a skill-load marker in the first/last 16 KiB
of an allowed Claude `projects/*.jsonl` transcript. Explicit agent/worker identity and exact session matches in
public `_shared/worker-context/<account>/<thread>.json` exclude workers before those hints. No login/auth stores
or network queries are read. Prefer named orchestrators; bounded transcript windows can miss a first marker.

The first digest injection contains all rules; subsequent versions deliver only added/changed and removed/replaced
bullet lines since the seen snapshot. Unchanged rules are omitted. An unchanged SessionStart digest hook only
reports no changes. Snapshot absence, corrupt seen state, invalid input, I/O failures and lock contention fail open
(exit 0); they never reset the saved acknowledgement. Hard timers bound all asynchronous I/O: 700 ms for the digest
hook and 220 ms for the inbox hook, within the existing two-second settings timeouts (and five-second Stop budget).

`_shared/rules-seen.json` is the acknowledgement file, keyed by session id with `host`, `title`, optional `project`,
`version`, `at` (epoch milliseconds) and cached `orchestrator` recognition. A nonblocking lock serializes merged
updates. State is staged before output and atomically renamed after successful stdout delivery; a crash or failed
commit leaves the version eligible for retry. Exit cleanup removes owned temporary files/locks. Keep at most 128
recent sessions, eight recent snapshots plus snapshots still referenced by those sessions, bounded to 4 MiB.
Recording the seen version IS acknowledgement; orchestrators no longer write ledger `rules-ack` lines by hand.
`node scripts/rules-worker-digest.mjs --acks` prints session, host, project/title, version and time (`--json` also
available). Nightly audits prefer these hook receipts, accepting legacy ledger `rules-ack` records as fallback;
roster-only sessions and missing evidence remain UNKNOWN. Run the listing on each machine: shared files are local,
so remote acknowledgements are not inferred. The owner sends separate messages only for required actions such as
stop/re-route/re-run or a remote checkout update; no settings edits or new hook entries are needed for delivery.

The official Claude hooks reference confirms `hookSpecificOutput.hookEventName="SessionStart"` and
`additionalContext`; `session_title` is optional. Source: `https://code.claude.com/docs/en/hooks.md`.
Local native CLI help, Claude Code 2.1.323, confirms `--bg` and `--append-system-prompt` are not print-only.
Routed Claude workers use `--append-system-prompt "$(node <skill>/scripts/rules-worker-digest.mjs)"`;
Codex threads and one-shot execs receive the same worker section as developer instructions. Every start, one-shot exec and resumed thread receives the latest worker digest, including no delegation or requests to switch models.
On each orchestrator wake, also `tail -n 20 ~/.claude/orchestrator/_shared/idle-hints.jsonl` when present and match
its exact target/name. This passive file-delivery path is documented in SKILL.md; no Claude messaging session is needed
and the hook does not auto-dispatch or change its bounded injection implementation.

Owner installation only: merge `templates/session-start-hook.json` into the existing `~/.claude/settings.json`
without replacing other hooks/settings. Its exact fragment uses an absolute Node binary; adjust if Node moves:

```json
{"hooks":{"SessionStart":[{"matcher":"startup|resume|compact|fork|clear","hooks":[{"type":"command","command":"/Users/bytedance/.nvm/versions/node/v22.17.0/bin/node \"$HOME/.agents/skills/project-orchestrator/scripts/rules-digest-hook.mjs\"","timeout":2}]}]}}
```

## Launch And Build Evidence

Worker completion has a separate [durable owner inbox, tracked watcher and Stop enforcement](worker-inbox.md).
The updated SessionStart template includes both digest and inbox hooks; merge it along with
`templates/stop-hook.json` after owner review. The older digest-only fragment above is insufficient for the inbox.
No hook was installed by the inbox task.

`codex-worker start` and routed Claude/one-shot launches check the last 24h of routing decisions for the same
name or task-prefix. Missing decisions warn `unrouted-launch` and append `kind: unrouted`; attempted launches
append `kind: launch` with actual account/model/vendor, timestamp and matched route timestamp. They don't block.
Pass `--user-ok <actual-card-or-ledger-reference>` after storing the matching scoped task/role/account/model/effort approval. Urgency/reference text alone is not consent; personal Astra/max/Fable/reset remain separate gates. Missing evidence stays unknown.
`review-data.globalRules` reports unrouted launches, personal-quota launches without recorded OK, TRAE GPT on
security routes, shared seen-version acknowledgements (legacy ledger fallback) vs the digest version, and pointers to orch-usage flags.

Full-package build briefs use the wrapper or explicit equivalent res protocol:

```bash
HEAVY_BUILD_BY="<unique-session-holder>" HEAVY_BUILD_PROJECT="<slug>" HEAVY_BUILD_TASK="<task-id>" \
HEAVY_BUILD_TIMEOUT=60 HEAVY_BUILD_LANE=heavy-lane-1 \
bash "$HOME/.agents/skills/project-orchestrator/scripts/heavy-build.sh" <command> <args...>
```

The wrapper holds heavy-build then the chosen lane, using gated finite res waits, long-lived PID and EXIT/signal
cleanup of owned process groups; never nest it or enter already holding heavy locks. Set lane 2 when appropriate.
Other heavy tasks use lane-only res take/return. The [resource sampler](resources.md) independently detects builds
without holders; denied probes remain UNKNOWN and telemetry never reclaims locks/restarts hubs. The wrapper doesn't enforce signing safety by sandboxing;
the injected adjacent login-material/test-signing rules and the brief remain mandatory. A signing task uses
`--signing` (full access), a registry-listed manifest/hash and designated identity, secret-safe stdin/file descriptors,
a receipt, masked log scan and keychain re-locking; everything outside that scope is BLOCKED. Identities must
be on the user-approved `~/.claude/orchestrator/_shared/user-signing/identities.json` allowlist, maintained by
the rules owner with dated user approval: H6 keychain identity (iPhone 8), cosign team DH59R4RNRY development
certificate + profile 3JVMQQBHUR (iPhone 11, valid to 2027-09), or repo-committed Android debug keystore.
Only orchestrators write registry.json entries; signing workers treat registry.json and identities.json as
read-only. New identities need a new user approval card and an allowlist entry; workers needing a new entry
or an unlisted identity report BLOCKED. Nightly receipts must match allowlisted identities and registered packages.

## Opt-In launchd Hubs

Templates exist for ttadk (including its proxy), trae, main and b. Each runs `codex-worker hub --foreground` with
RunAtLoad/KeepAlive, 10-second launchd throttling, an explicit Node PATH, HOME cwd and separate logs. Foreground
supervisors additionally use persistent exponential backoff and BLOCKED standby after five consecutive failures;
their 8 MiB rotating logs/state are checked in the nightly resource review (see resources.md). Foreground
mode probes `list --limit 1` before starting a hub, owns its foreground hub/proxy children, and exits on their
failure so launchd restarts them independently of Claude daemon/session restarts. A reachable existing hub is
retained in standby, never restarted or duplicated. A missing/unusable sign-in remains BLOCKED; no credential
files or sessions are copied into templates. These are per-user agents, not system daemons; they survive Claude
restarts, not user logout. Automatic account login is not attempted.

Hub unreachable rule: probe with list, start with codex-worker hub only if unreachable, tell the global-rules owner.
Do not confuse an empty successful list with an unreachable hub. Installation commands for the owner only:

```bash
skill="$HOME/.agents/skills/project-orchestrator"
node "$skill/scripts/render-hub-launchd.mjs" --out /tmp/po-hub-launchd --skill "$skill"
plutil -lint /tmp/po-hub-launchd/*.plist
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude/orchestrator/_shared/hub-launchd"
for account in ttadk trae main b; do
  label="dev.project-orchestrator.hub.$account"
  cp "/tmp/po-hub-launchd/$label.plist" "$HOME/Library/LaunchAgents/$label.plist"
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
  launchctl print "gui/$(id -u)/$label"
done
```

Confirm each account profile/bin/proxy configuration exists first; no auth files need inspection. Inspect existing
labels before bootstrap; don't overwrite an existing agent without review. To remove an installed agent, use
`launchctl bootout gui/$(id -u)/dev.project-orchestrator.hub.<account>`; it stops only owned children, not a reachable
unmanaged hub retained in standby. No install/bootstrap/bootout command was run by this task.

The renderer defaults to absolute `process.execPath`; an explicit `--node` must be absolute, not `node` or a
relative path. Under nvm/zsh `command -v node` can return a bare shell-resolved name. If overriding, obtain the
binary with `node -p 'process.execPath'`; launchd cannot use the interactive shell's nvm function.

## Installed State

Owner-reported **2026-11-13** installation: SessionStart hook merged into `settings.json`; four hub agents
`dev.project-orchestrator.hub.{ttadk,trae,main,b}` installed. The owner verified that terminating idle hub b caused
restart in approximately **35 seconds**. `com.user.resource-sample` is installed at **300 seconds** and
`com.user.resource-cleanup` at **04:30 local time**, with **`MINI_CLEANUP_MODE=dry`**. These are host installation
facts from the brief, not live checks by this edit-only task. Reinstalling/reading settings or sign-in storage is out
of scope. The lane-3 contract request is separate and must not be confused with these installed agents.

## Never-Ask Dependency Installation

Project dependencies and build tools fetched through normal package managers and registries (npm/pnpm/yarn, pip/uv, gradle/maven, CocoaPods/SPM, cargo, go modules, brew formulae, and SDK/toolchain components the build asks for) are installed directly into the task workspace or user-level caches, without a card or question. No secrets/credentials, production changes without a card, unapproved personal quota, or system security changes; a required login the worker lacks is BLOCKED.
