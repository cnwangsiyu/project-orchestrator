# Global Rules Enforcement

User-approved 2026-11-13: four layers. `global-rules.md` is the versioned, <=60-line single injection source;
its `Worker Rules` section is extracted, not maintained as a second copy. Nothing below installs automatically.

## Injection And Acknowledgement

`rules-digest-hook.mjs` handles SessionStart startup/resume/compact. Detection uses `session_title` (or name/title
aliases) ending in 主对话 or matching `_shared/orchestrators.txt`, an already-recognized session id, the skill cwd,
or a skill-load marker in the first/last 16 KiB of an allowed Claude `projects/*.jsonl` transcript. It does not read
job/login/auth stores or run a CLI/network query. Use named orchestrators for reliable detection; a marker outside
the bounded transcript windows can be missed on a first injection, and a skill-maintenance session in the skill
cwd can also match. Cached recognition survives compaction; explicit names/roster remain preferred.

Input errors, missing files, contention and write failures are fail-open (exit 0). A 250 ms timer bounds stdin
waiting; reads are bounded and the seen-state lock is nonblocking. `rules-seen.json` atomically records session
versions and eight recent version snapshots; older comparisons request a full re-read. It records injection,
NOT acknowledgement. After a version change each orchestrator writes `rules-ack <version>` in its ledger.
The owner pushes change notes via the secretary for the mini group and directly to MacBook orchestrators.

The official Claude hooks reference confirms `hookSpecificOutput.hookEventName="SessionStart"` and
`additionalContext`; `session_title` is optional. Source: `https://code.claude.com/docs/en/hooks.md`.
Local native CLI help, Claude Code 2.1.323, confirms `--bg` and `--append-system-prompt` are not print-only.
Routed Claude workers use `--append-system-prompt "$(node <skill>/scripts/rules-worker-digest.mjs)"`;
Codex threads and one-shot execs receive the same worker section as developer instructions. Existing resumed
threads retain their earlier instructions: re-brief them with the current digest before continuing.

Owner installation only: merge `templates/session-start-hook.json` into the existing `~/.claude/settings.json`
without replacing other hooks/settings. Its exact fragment uses an absolute Node binary; adjust if Node moves:

```json
{"hooks":{"SessionStart":[{"matcher":"startup|resume|compact","hooks":[{"type":"command","command":"/Users/bytedance/.nvm/versions/node/v22.17.0/bin/node \"$HOME/.agents/skills/project-orchestrator/scripts/rules-digest-hook.mjs\"","timeout":1}]}]}}
```

## Launch And Build Evidence

`codex-worker start` and routed Claude/one-shot launches check the last 24h of routing decisions for the same
name or task-prefix. Missing decisions warn `unrouted-launch` and append `kind: unrouted`; attempted launches
append `kind: launch` with actual account/model/vendor, timestamp and matched route timestamp. They don't block.
Pass `--user-ok <actual-card-or-ledger-reference>` after a real user approval; `route --urgent` records the already
approved personal-quota choice, not permission for reset cards or other gates. Missing evidence stays unknown.
`review-data.globalRules` reports unrouted launches, personal-quota launches without recorded OK, TRAE GPT on
security routes, latest ledger acknowledgements vs the digest version, and pointers to orch-usage flags.

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
the worker's credential-denying sandbox/brief remains mandatory.

## Opt-In launchd Hubs

Templates exist for ttadk (including its proxy), trae, main and b. Each runs `codex-worker hub --foreground` with
RunAtLoad/KeepAlive, 10-second launchd throttling, an explicit Node PATH, HOME cwd and separate logs. Foreground
mode probes `list --limit 1` before starting a hub, owns its foreground hub/proxy children, and exits on their
failure so launchd restarts them independently of Claude daemon/session restarts. A reachable existing hub is
retained in standby, never restarted or duplicated. A missing/unusable sign-in remains BLOCKED; no credential
files or sessions are copied into templates. These are per-user agents, not system daemons; they survive Claude
restarts, not user logout. Automatic account login is not attempted.

Hub unreachable rule: probe with list, start with codex-worker hub only if unreachable, tell the global-rules owner.
Do not confuse an empty successful list with an unreachable hub. Installation commands for the owner only:

```bash
skill="$HOME/.agents/skills/project-orchestrator"
node "$skill/scripts/render-hub-launchd.mjs" --out /tmp/po-hub-launchd --skill "$skill" --node "$(command -v node)"
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
