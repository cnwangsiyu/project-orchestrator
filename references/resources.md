# Machine Resources on the Mini

One design owned by the routing/global-rules orchestrator: collect every five minutes, review at 03:07, and run
separately coordinated cleanup at 04:30 local time. The two new launchd files are **templates only**, cleanup is
**dry by default**, and installation/apply require review. The owner installed these agents on 2026-11-13 (see Installed State below).
No sampler/review command runs a model, signals a process,
probes a device, changes a lease or reads authentication storage.

## Sampling

`node scripts/resource-sample.mjs --read-only --json` prints one JSON record without writing anything. Normal mode
appends to `~/.claude/orchestrator/_shared/resource-log.jsonl`. Exit 0 means all primary host metrics were collected;
exit 2 means incomplete/blocked, with still-useful partial JSON. `processComplete`, `attributionComplete` and lease
completeness are separate: an empty denied process list is UNKNOWN, not zero builds. JSON `failedProbes` and `errors`
identify denied, timed-out and malformed probes without storing their raw diagnostics; stderr reports their names.

- Time (UTC ISO + epoch ms), machine/core identity, 1/5/15-minute load, interval CPU user/system/idle.
- Physical RAM, available estimate/basis, free+inactive+speculative page headroom, `memory_pressure -Q` free percentage,
  swap allocation and VM counters. `warning`/`critical` are free-percentage heuristics (<20%/<10%), not OS event states.
- Free space on HOME's data volume, not the sealed OS volume. Disk cleanup threshold is **1 TB decimal**, not 1 TiB.
- All process PID/PPID/start/identity, cumulative CPU seconds, snapshot CPU %, RSS, state, safe executable name, cwd,
  kind and project/task owner; top 20 CPU/RSS identities. Cumulative CPU deltas, not lifetime ps %, drive the review.
- xcodebuild, Gradle client, native compiler/CMake/Ninja, Node test, worker, daemon, Chrome/headless, simulator and
  device-tool counts. Independent package roots exclude nested compiler children; counts are processes, not build jobs.
- Read-only resource registry and lock metadata show held device/slot holder, project/task, PID/host, epoch start and
  local STALE observations. The sampler includes a pure parser for captured `res status` output (`collect({statusText})`);
  live `res status` is deliberately not invoked because it writes temporary files. No simctl/devicectl/USB probe is run.
  Simulator services do not prove booted/unused simulators; device processes/leases do not measure device utilisation.
- Authoritative `res heavy-check` state, exit code, load1m, **limit**, **lanes_held**, memorystatus available memory,
  page headroom and swap diagnostics. Exact contract fields are persisted alongside compatible loadGate/lanesHeld aliases.
  Exit **5** is a valid OVERLOADED reading, not a probe failure. Exit 1/timeout/malformed output is UNKNOWN, never OK.
- Hub TCP listener liveness for **47321-47324** in every sample: LISTENING/NOT_LISTENING/UNKNOWN per port and listener
  PIDs. Narrow `lsof` LISTEN output only; no HTTP/WebSocket request, session injection, auth or restart. Listener presence
  is not application health. A failed/denied probe is not an outage; clean exit 1 with no matches is absence.
- Optional `ccache -s` cumulative hits/misses/direct/preprocessed hits and cacheable-call hit rate. It observes the shared
  `~/.vesdk-dev/ccache`, not unrelated default caches. Query environment disables config/log output; no config, cache-size,
  counter reset or compiler setting is changed. Storage-only output from an unused cache means available, rate UNKNOWN.
- Chrome GUI/headless counts and running/not-observed state. CPU history flags **suspected** hangs; responsiveness is unknown.

The probes all start concurrently with **independent** deadlines: 1.75 seconds each, CPU **4 seconds** to accommodate
`top -l 2 -s 1`. The CPU probe cannot consume another probe's budget; timers also bound injected/stalled probes and
abort timed-out children. JSON `probeTimeouts` records budgets. No sudo. Metadata reads are bounded (2 MiB per
ledger/route file); oversized route history marks ownership unverified instead of performing an expensive scan.
Installation acceptance requires a **complete** host run within the independent deadlines, including at load ~20
(up to ~4s for CPU, not a <2s total requirement); a fast blocked run
does not establish full-probe performance. No fallback circumvents sandbox process restrictions.

The earlier reports of blocked process, CPU, swap and memorystatus probes were **worker-sandbox restrictions**, not
host limitations. The orchestrator must run **one unsandboxed read-only sample** from the durable reviewed checkout
before installing either resource agent: `node "$SKILL/scripts/resource-sample.mjs" --read-only --json`. Verify
`complete:true`, no required `failedProbes`, useful process/ownership coverage and full-probe timing within ~4 seconds.
Missing/unavailable/storage-only ccache counters stay optional UNKNOWN in `ccache`; they do not fail a sample or cause exit 2.
If the host sample fails, diagnose its named probes and retain partial UNKNOWN data; do not install or weaken gates.

The sampler's diagnostic memory estimate prefers `kern.memorystatus_level * RAM`, with a page estimate fallback.
That fallback is **not** admission evidence. The installed shared `res heavy-check` is the authority: it falls back to
pages only when the sysctl is explicitly missing, not denied or erroneous. Rounded printed readings at exactly 12/20/16
can have either verdict; retain the controller's state, do not recompute from rounded decimals. No second semaphore.

**Gate change approved 2026-11-13 (secretary option A):** **limit = 12 + 8 * lanes held by others, capped at 20**;
entry requires load1m <= limit and available memory >=16 GiB. STALE and the caller's own verified
locks do not count; two other lanes leave no capacity. Unknown lane/PID identity is UNKNOWN, never permission for 20.
The contract's **T88 live v1.2** addendum reports rollout on 2026-11-13. The parser captures `limit`/`lanes_held`
from Darwin/Linux output, while old fixed-12 samples remain explicitly legacy (`limit:12`, `lanes_held:null`, never
an invented zero-lane count). Overload analysis uses each sample's limit and controller verdict, not a fixed 12;
periods with different limits/lane counts are kept separate. The review also accepts historical camelCase-only samples.
The review compares approved entry
readings per observed waiter PID (or an observer with no own locks) with the recorded controller context; different
caller lane counts are not proof of a rollout mismatch. Verified mismatches go to its owner, never a gate bypass.
Preserve the exact controller verdict at rounded bounds when contexts match; alternate-context readings are estimates.

## Heavy Lock Contract

Follow the [live T83 lock contract](/Users/bytedance/code/.claude-data/orchestrator/vesdk-mainline/tasks/T83/lock-contract.md)
and [build/cache discipline](../SKILL.md#build-discipline); observations never supersede their scope or authorization rules.

The live 2026-11-13 contract has ONE `heavy-build` slot and TWO `heavy-lane-*` lanes. Full iOS/Android SDK + host package
work holds the slot and a lane throughout preflight/staging/build/acceptance. SG packaging, sustained native compilation
and long multiprocess focused tests need a lane only. Host unit tests without a full native build, single-TU compilation,
docs/analysis and device-only work are exempt. Acquire slot before lane, release in reverse on every exit (`trap EXIT`),
use bounded `res wait --timeout`, and pass the long-lived wrapper PID rather than a short-lived res process PID.

User approved **2-3 heavy lanes on 2026-11-13**. The optional third `heavy-lane-3` requires known
`load1m <=8 && availableBytes >=32 * 2**30` at each acquisition attempt, and releases like every lane. The normal
v1.2 gates and single package slot stay unchanged. Implementation/rollout belongs exclusively to vesdk-mainline:
[requested contract and owner tests](heavy-lane-3-request.md). This checkout does not edit `res`. Sampler/review
recognize lane 3 only if present in registry/lease/status/journal/wait data; absence on v1.2 is not incomplete.

`heavyLocks` includes an equivalent status snapshot, bounded 128 KiB `log.tsv` tail and observed `res wait` processes.
Event IDs use journal inode/byte offset, so repeated tails are deduplicated. Purpose, return/reclaim notes and arbitrary
command arguments are never persisted. STALE is established only for a dead recorded **local-host** PID with a complete
process table and a start predating the process snapshot. Remote, legacy, reused-PID, denied or newly acquired locks
remain unverified. Observed age >600s can mark reclaim eligibility, but **only res wait** may perform automatic reclamation.

Build matching uses the holder PID in the build's own wrapper ancestry, never equal session/project names alone.
Full-package candidates require matching slot + lane; native/test heavy candidates require a lane. Diagnostics/device-only
Xcode, ordinary host tests and single-TU compiler processes do not establish a violation. Package builds nested beneath
lightweight drivers remain visible. Process/scope/ancestry/metadata gaps are UNKNOWN; owner verification precedes enforcement.

Holds are reconstructed from take/return/reclaim rows (minute precision), refined with metadata epoch starts. Reports
give lower/upper durations, source and left/right censoring; unknown ends are null, not zero. Active hold lower bounds
stop at the last observation. Journal history may be truncated. **Current res wait does not journal wait starts/timeouts**:
wait timing is inferred only from sampled wait PID/elapsed time (~1s), with acquisition confirmed by matching wrapper
metadata when possible. Disappearance alone is not proof of a timeout or successful acquisition. Wholly missed waits
cannot be reconstructed and no zero-wait claim is made.

## Cache Scope

T83 Part B validated ccache 4.14.3 for the Android SDK native graph (2,791 TUs): cold 0% hits / 1873s, cross-path rebuild
100% direct hits / 82s. These are contract-reported pilot figures, **not today's sampled rates**. Adopt CMake C/CXX
compiler launchers for Android NDK/host CMake-Ninja; not the Xcode generator. The shared cache policy is 96G,
base_dir=/Users/bytedance, hash_dir=false, compiler_check=content. The contract says the shared cache was emptied and
the first real run will be cold. Full APK/Gradle acceptance was not validated by that SDK-only pilot. Gradle pure-build
settings are build cache + idle daemon (300000 ms), two workers and -Xmx6g with a task-private Gradle home. No daemon
when process-exit isolation or signing/login material is involved. Preserve cold/final acceptance and provenance.

Review reports cumulative and sampled-window hit rates separately. Window rates use matching-scope monotonic counter
deltas, weighted by calls rather than averaging percentages. Counter decreases, gaps, scope changes and clipped boundary
intervals are omitted; undetected resets between samples remain a limitation. No calls/no counters means UNKNOWN, not
0% cache effectiveness. A shared cache rate cannot be attributed to a project or used as Xcode/full APK acceptance.

## Ownership and Task State

Read only `ledger.md`, optional `resource-tasks.json`, directory names under `tasks/`, and dispatch/outcome rows in
`route-log.jsonl`. Both `~/.claude/orchestrator` and `~/code/.claude-data/orchestrator` are discovered and real ledger
paths deduplicated. Explicit task paths, task worktree/cwd fields and worker names take precedence over project-only
repo paths. Descendants inherit an unambiguous owner. A shared tiktok_vesdk checkout can belong to multiple projects:
without task-specific evidence the owner stays ambiguous, never guessed. Path matching checks directory boundaries.
Within a uniquely owned repo a unique task ID in a worktree basename can suggest an owner for resource shares;
it is labeled `inferred-worktree-id` and **cannot authorize cleanup**. Prefer exact ledger/metadata mappings.

Markdown tables/status fields are best-effort and may be stale. For accurate queue analysis and cleanup evidence,
each project's orchestrator maintains this **non-secret** file alongside its ledger:

```json
{
  "tasks": [{
    "task": "T83-build-cache-audit",
    "status": "queued",
    "changedAt": 1794592800000,
    "activityAt": 1794592800000,
    "ready": true,
    "waitReason": "heavy-build",
    "paths": ["/Users/bytedance/code/repo/.worktrees/task-specific"],
    "workers": ["lynx-view-T83-build-cache-audit"]
  }]
}
```

Use real epoch milliseconds, exact task-directory names and absolute task-specific paths; do not register broad
HOME/root/shared source paths for a task. Update on dispatch, resource wait, retry, activity and close. Allowed waits:
resource/load/memory/heavy-build/dependency/user/network/quota. `ready:true` means its dependencies are satisfied and it
could execute if resources were admitted. CPU idle during unverified waits is only **possible** under-use; explicit
user/network/dependency waits are not under-use. Missing activity/status never authorizes cleanup. A later matching
route reopens a task; failed outcomes alone do not mean abandoned. A final pass/rework outcome supplies a terminal
timestamp and any later dispatch overrides it; newer explicit per-task metadata takes precedence. Without either,
the ledger's global mtime is conservatively used, which can overprotect old tasks.

## Live Idle Hints

Normal sampler mode calls `resource-idle-hint.mjs` after each append. It can also run on its own interval; never
install both without review. Read-only/dry-run samples never write hints. Three consecutive five-minute samples
(4-6 minute spacing, fresh last sample) must have `load1m <6`, CPU idle **>50%**, complete task/lock/process evidence
and **no heavy lock waiters**. Latest ready-but-undispatched tasks need explicit ledger `status: ready` (exact word)
or `resource-tasks.json` `ready:true` with ready/queued/waiting status and no user/dependency/network/quota wait.
Running/terminal/unknown states and observed dispatched processes cannot qualify. A route reopening the task clears
readiness; never infer ready from vague pending/TODO prose or a terminal task mentioning READY elsewhere.

Hints go to `~/.claude/orchestrator/_shared/idle-hints.jsonl`, grouped by exact ledger orchestrator name, at most
once per **60 minutes** per orchestrator (including across projects). Print the exact target/message; sampler prints
delivery text to stderr to keep stdout a JSON record. Exclusive append/cooldown checking prevents duplicate delivery;
stale locks/oversized history need owner inspection, never automatic deletion. Missing targets/metrics mean no hint.
Each orchestrator checks a cheap `tail -n 20` on startup/resume/compact and its patrol wake as required by SKILL.md.
No active Claude session, login, model call or live messaging is needed. This is **hint only**, never dispatch.

## Review and Retention

`node scripts/resource-review.mjs --hours 24 [--json]` reads active JSONL plus six archives, writes only stdout, and
returns 2 for missing coverage/read errors. `--input <telemetry.jsonl>` supports synthetic evidence; `--stdin` accepts
read-only sampler output. One sample cannot establish a day or a continuous duration. Windows use pairs <=10 minutes
apart, clipped at the requested start, with no tail/gap extrapolation. Mixed machines are refused. Missing observations
and short-lived processes between samples mean CPU shares are estimates, not complete accounting.

Reports include utilisation, resource-ready queues, contention, admission gate closures, >1 GiB interval swap growth
(allocation, not I/O), package overlap, >=2h idle workers/possible terminal-task orphans, >=1h high-CPU Chrome,
>=2h simulator services and disk trend. Cases carry times/PIDs/owners; project/task shares use cumulative process CPU
and sampled RSS*time. RSS double-counts shared pages and is not physical RAM ownership or promised freed memory.
They also include wait/hold bounds, STALE observations/periods, persistent build candidates with no matching holder,
authoritative gate coverage/overload periods, approved **12/20 lane-aware** entry comparisons (memory 16 GiB), shared ccache rates, and hub
outage observations/periods. Hub durations require two complete adjacent probes with common missing ports; a single
missing-listener sample is flagged but has no invented duration. Onset/recovery is bounded by probes, not exact.

`utilisation` includes CPU hours idle >50% with explicitly ready tasks, authoritative combined-gate hours, memory
mean/min/max available GiB and pressure hours, per-lane/aggregate occupancy, queue wall-hours and task-hours,
and top correlated causes (no ready tasks / user / lock gate / quota / ready but undispatched). Every metric carries
its own observed coverage and no coverage is UNKNOWN, not zero. Lane occupancy divides HELD lane-time by observed
provisioned lane-time; lane-3 presence is not evidence that its take gate was open. Queue task-hours count multiple
waiting tasks, unlike wall-hours. Causes are diagnostic ledger hints, not proven causal explanations.
`resource-review.mjs` joins default resource logs with quota history; `review-data.mjs` exposes the same utilisation
section in JSON and a three-line text summary. Synthetic `--input`/`--stdin` reports do not implicitly read host quota.
Unused TTADK **tokens** and TRAE per-model high-priority **units** require observed daily rollovers and a last reading
<=30 minutes before reset. They are upper-bound sampled estimates, not exact reset-time counters; absent/far-away
readings and wholly missed resets are UNKNOWN and tokens/units are never summed together.

Above 50 MiB the sampler atomically renames its own active log through `.1` ... `.6`; only the oldest telemetry
archive is removed. Maximum retained telemetry is about 350 MiB; actual days depend on process count. This is
**size-bounded**, not guaranteed 24h/7-day retention. Check report coverage before decisions. Current data files are
0600; avoid exposing the shared folder. Concurrent append/rotation has an exclusive lock; a crash-stale lock is
reported, never automatically deleted. Only the orchestrator may inspect/remove that job-owned lock after verifying
no writer is running. stderr and nightly reports are not auto-pruned by this feature.

`references/nightly-review.md`'s Machine resources step consumes the report, sends each project its concrete cases,
and tunes only within dated user-approved bounds. `scripts/resource-policy.json` records load 12 (empty) / 20 (one other heavy task) / memory 16 GiB /
one package slot / two heavy lanes with **null tuning bounds**: the fixed value 20 is approved, not a range for further tuning. No autonomous
range is invented. Thin evidence or any unapproved/out-of-range change goes to a Chinese decision card. The shared
controller's owner implements/acknowledges any further enforcement change; observation policy alone cannot apply it.
The new utilisation approval is separately recorded: lanes may float in **[2,3]**, but the brief gives only fixed
idle-hint 6/50/3/60, lane-3 8/32 and TTADK expiry 4h/70% values, not numeric threshold tuning bounds. Use those
approved values; ask a Chinese card before changing them. Do not reinterpret the range as permission to tune 12/20/16.

`tuning.direction` reports possibly-too-strict (observed wait for a free resource under a closed gate, >=60% idle,
normal pressure, no swap growth), possibly-too-loose (matching-holder build under an open gate, sustained pressure
and >1 GiB swap growth), conflicting, or insufficient-evidence. These are correlations, not causation or optimal settings.
Bypasses/fan-out/JVM/cache problems must be investigated first. Automatic eligibility requires three full UTC days
with >=80% comparable interval coverage each, one consistent other-lane admission context, a matching authoritative estimator/controller policy, no bypass
candidates, dated valid authorization, and candidate values inside explicit bounds. A human nightly review still
checks comparable tasks and wall/wait outcomes, chooses **one gate at a time** and records rollback conditions.

The nightly hook collects **96h JSON** as well as the 24h report; a 24h run alone cannot satisfy three-day evidence.
If the user later authorizes ranges, record `approvedRanges` as `{"loadGate":[min,max],"loadGateWithOneHeavyTask":[min,max]}` and
`approvalEvidence` as the dated approval reference. Bounds are **null today**: this document supplies no numeric approval.
Outside bounds, thin/conflicting evidence, admission-context or estimator drift means retain 12/20/16 and ask the user in Chinese before changes. Proposals change one load gate at a time; memory stays 16 GiB.

## Cleanup

`bash scripts/resource-cleanup.sh` is read-only inventory + proposed coordination text, no models/messages/writes/
signals. It ports the secretary's design and tests in `scripts/resource-cleanup/`; `protect.json` remains the safety
policy. Installed apply mode requires explicit user authorization, inherited `MINI_CLEANUP_MODE=apply` **and** an
executor `--apply`. Never set apply inside a dry session. The 04:30 launcher uses a date marker and flock, starts
one cleanup coordinator and never auto-stops an old worker; an old cleanup session requires its owner to review/end it.

Ordinary process cleanup requires a known finished/abandoned owner, status age >=2h, **continuous** same-identity idle
CPU history >=2h, and no recent activity anywhere in the bounded task-artifact stat walk. PPID=1/uptime alone is not
enough. Missing ownership/cwd/history/activity, stale inventory, new descendants/PID identity or changed policy vetoes
cleanup. Live orchestrators/hubs/workers and their trees, live task paths, user GUI apps, system/managed services,
Gradle/Kotlin daemons and CoreSimulator remain protected. Unknown/held device leases protect device tools. No device
probe, app-data wipe or lease release is permitted.

Inventory retains **PID/host/epoch start for every res lock**, including heavy-build, lanes, devices and other IDs.
Verified local holders and their complete descendant trees are protected regardless of task status or CPU idleness;
an ancestor action is vetoed by a protected holder below it. Missing/ambiguous metadata, reused PID/start identity or
failed lease reads veto cleanup. The last PID check rereads all holds immediately before every TERM/KILL; telemetry
never returns a lock to make its holder disposable. Remote PIDs are not mistaken for equal local PIDs.

The runtime [session prompt](../scripts/resource-cleanup/session-prompt.md) coordinates **every** roster member by
exact name, with a 20-minute deadline and exact PID/start/hash identities. Silence, offline/ambiguous replies, claims
or new recipients veto the entire tree. Claims are reread before each signal; fresh inventories recheck ownership,
activity, services, leases and original tree membership. TERM then same-identity survivors only after revalidation.
No pkill/killall/process-group signals. Dry-run plans may be empty even when reports contain bad cases.

Continuous sampler JSONL is adapted to the secretary inventory history schema via `--resource-log`; the identical
PID/start/command-hash contract is used by both. For explicit inventory histories, filenames must be this job's
`inventory*.json`, not sessions/credentials. Apply writes checkpoint audits and an execution flock under
`~/.claude/orchestrator/_shared/resource-cleanup/`. Unfinished process/disk audits or Chrome recovery block new work.

Chrome is the sole user-GUI exception: sustained high-CPU GUI Chrome plus full tree release and no protected member.
After termination starts, `finally` attempts direct binary `nohup ... --restore-last-session`, checks a new main
process and NEW Native Host ping/status log, and retries once. This is startup evidence, not tool connectivity:
the coordinator must reconnect through the already authorized browser tool and perform a read-only check; failure
is BLOCKED to the secretary, without reading cookies/profiles or login storage. Partial failure/normal interruption
still triggers restoration. TERM/HUP/INT are controlled exceptions that unwind through recovery; repeated termination
signals are ignored during that restoration. Original handlers are restored afterwards. SIGKILL of the executor,
crash or power loss cannot guarantee `finally` runs.
Even successful host startup returns `BLOCKED_browser_reconnect_pending` (exit 2) and stops further actions. Only
an actual authorized read-only browser-tool check may mark the job-owned audit's `browser_connection` verified;
the session prompt describes the receipt update. Missing/failed restoration or pending reconnect blocks later executors.

Disk cleanup is separately guarded by `disk-cleanup.py`. Default `build-artifacts.json` has an **empty allowlist**.
Only reviewed disposable **self-made build clones/templates** may be registered with exact canonical path, project/
task, `created_by:orchestrator`, kind and unique nonce, and an identical `.resource-build-artifact.json` marker inside
the generated tree. Register at creation, never retroactively label a user tree disposable. Never register source
worktrees, normal caches, task reports, release-referenced artifacts or trees containing credentials/signing/configs.
Below 1 TB, the planner checks terminal quiet task, >=2h artifact inactivity, no live owner/process/path/held-device
dependency and every orchestrator's **artifact identity** release. It refuses symlinks/special files, `.git`, `.env`,
auth, keys/profiles and unregistered roots. The executor resamples disk/protections/claims/registry and exact tree
metadata, audits first, then deletes descriptor-relative without following symlinks. Changed trees are preserved;
partial failures remain `running` for manual review. Never invoke the disk executor directly from the routing worker.

## Privacy and Installation

Hub foreground supervisors pass the same account `search-proxy.log` path as `ensureSearchProxy`. Their stdout/stderr
logs are bounded at **8 MiB each plus one archive**, with child output handled by the rotating writer. Failure state
under `hub-launchd/<account>.state.json` backs off 30s, 60s, 120s, 240s (cap 15 minutes); the fifth consecutive failure
becomes **BLOCKED**. The next KeepAlive process stays in blocked standby without child-start loops. Only 60 seconds
of stable list/proxy health resets failures. The sampler reads only these state files and log sizes; nightly review
reports BACKOFF/BLOCKED, oversized logs and UNKNOWN diagnostics separately from listener uptime. Owner repairs the
cause, clears the reviewed job-owned state and restarts the agent (or starts a reachable hub); never read auth storage.

Raw process arguments are transient in memory for classification/attribution/hash only. Persist executable name,
safe cwd and owner IDs, never arbitrary argument/prompt/env values, URL queries, token/password/API-key flags or
bearer strings. No environment/open-file lists, profile/session/cookie/keychain/CLI auth files or account registry
are read. Known credential-like metadata paths are refused. Login required => BLOCKED with what needs signing in.

The **orchestrator**, after installation approval and the complete unsandboxed host dry run above, may install the two agents. Use the durable skill
checkout, never this temporary worktree. Commands below are documentation, not run by this task:

```sh
SKILL="$HOME/.agents/skills/project-orchestrator"
STAGE="$HOME/.claude/orchestrator/_shared/resource-agents-reviewed"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude/orchestrator/_shared/resource-cleanup"
node "$SKILL/scripts/render-resource-agents.mjs" --directory "$STAGE"
plutil -lint "$STAGE/com.user.resource-sample.plist" "$STAGE/com.user.resource-cleanup.plist"
install -m 600 "$STAGE/com.user.resource-sample.plist" "$HOME/Library/LaunchAgents/com.user.resource-sample.plist"
install -m 600 "$STAGE/com.user.resource-cleanup.plist" "$HOME/Library/LaunchAgents/com.user.resource-cleanup.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.user.resource-sample.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.user.resource-cleanup.plist"
```

Renderer records the actual absolute Node path and PATH (launchd has no interactive shell/nvm), XML-escapes paths,
refuses overwriting staged plists and leaves cleanup `dry`. No RunAtLoad or KeepAlive. StartInterval 300 and 04:30
follow local macOS scheduling; sleeping machines may produce gaps or a late calendar run, so use actual timestamps.
Do not also install the secretary's old 04:30 agent: one owner/coordinator only. Review/transfer any existing job
before bootstrapping these. Applying cleanup needs a separate authorization after complete dry-run/coordination and
browser recovery qualification; merely installing these dry templates is not approval to signal/delete anything.
For hub rendering, omit `--node` to use absolute `process.execPath`; never substitute `$(command -v node)` under
nvm/zsh. An override must be absolute (obtain it via `node -p 'process.execPath'`); bare `node` is rejected.

## Installed State

Owner-reported **2026-11-13**: SessionStart hook installed in `settings.json`; four agents
`dev.project-orchestrator.hub.{ttadk,trae,main,b}` installed; terminating idle hub b was verified to restart it in
~35s. `com.user.resource-sample` runs every **300s** and `com.user.resource-cleanup` at **04:30 local time** with
**`MINI_CLEANUP_MODE=dry`**. Installed sampling at load ~17 exposed the former CPU timeout; this edit raises its
independent budget to 4s. Complete sampling at load ~20 still needs owner host acceptance, not a synthetic claim.
These facts come from the brief; this edit-only task does not reinstall, read settings/sign-ins, or alter cleanup mode.

For removal, first confirm no cleanup/recovery is running, then `launchctl bootout "gui/$(id -u)/com.user.resource-sample"`
and `launchctl bootout "gui/$(id -u)/com.user.resource-cleanup"`. Keep audits/history; do not delete old process state.

Validation (fixtures are created/deleted only inside this repo):

```sh
node scripts/test/resource-scenarios.mjs
node scripts/test/resource-nightly-scenarios.mjs
node scripts/test/resource-lock-scenarios.mjs
node scripts/test/run-all.mjs
python3 -B scripts/resource-cleanup/test_cleanup.py
python3 -B scripts/resource-cleanup/test_disk_cleanup.py
node scripts/resource-sample.mjs --read-only --json
node scripts/resource-review.mjs --hours 24 --json
node scripts/resource-review.mjs --hours 96 --json
```

Full host attribution, full-probe timing, actual message round trips, browser reconnect/recovery and actual launchd
scheduling require authorized host qualification. Unit tests do not substitute for those boundaries. Process identity
check-to-signal and tree metadata check-to-delete still have small races; the design is conservative, not an OS-level
atomic ownership guarantee.
