# Shared res contract (v1.7, 2026-11-16) - owner: routing/global-rules orchestrator; users: all projects

Maintained source: this project-orchestrator repository, `scripts/res/res`. Ownership of the entire
tool (devices, checkouts, registry/notes, take/return/extend/add/note/log and heavy admission) transferred
from vesdk-mainline to the global-rules owner on 2026-11-13. The unmodified v1.2 contract is preserved
in `scripts/res/test/fixtures/contract-v1.2.md`. v1.7 is staged, not live until the owner's reviewed switch.

## Changes in v1.7

Fresh build/lane transactions cannot adopt a pre-existing hold, including a concurrent wrapper's
same-name hold that appears after the free-directory precheck. They return unavailable or keep waiting,
and roll back only their newly created resources. Same-`--by` single-resource take/wait idempotence
is unchanged, as is `wait-lane` reuse with the same `--by` and holder PID. Holder names remain opaque,
exact strings; no prefix or project/task comparison establishes ownership. Existing-hold diagnostics
from `take` and the same-name build-slot guard name the recorded holder, PID and since time instead
of calling the hold "yours". A shared `--by`
alone cannot identify a wrapper: keep using unique names per run and PID-scoped `return-build` cleanup.
Admission, FIFO, release authorization and the strictly >600-second dead-local-PID reclaim rule are unchanged.

## Changes in v1.6

Lane waits publish the same heartbeat and cleanup records as build waits. While another project
has a live, ready lane waiter and no non-STALE lane, a project holding a lane cannot take an additional one. Eligible
lane waiters proceed FIFO; capped projects yield queue position, and three gate-blocked polls
suspend priority until the next passing poll. Build waiters retain v1.5 priority. Status lists
waiting lanes. Machine gates accept validated optional `machine.conf` overrides. Device holds
and take logs retain adb line counts and adb/devicectl process identities. Review timing rejects
older released episodes when a later held snapshot reuses a name/PID, and marks inconsistent
release/acquisition bounds INVALID with unknown durations only when the release window proves the timing impossible; valid same-minute episodes retain coarse bounds. Review version labels come from this
source contract; they do not establish the installed version.

Resources in `res` (~/.claude/orchestrator/_shared/res):
- `heavy-build` — the ONE machine-wide full-package build slot.
- `heavy-lane-1`, `heavy-lane-2` - the two normal heavy-task lanes.
- `heavy-lane-3` - optional third heavy-task lane; default admission requires load1m <=8 AND available memory >=32 GiB at take time (see machine overrides below). Capacity floats between two and three lanes, not an automatic tuning range for load/memory.

Definitions:
- Full-package build = a full iOS or Android SDK+host-app build: an env verify run (preflight, stage, compile, acceptance), an xcodebuild of the app, a Gradle assemble with native compile. Needs `heavy-build` AND one lane, held for the whole run.
- Heavy task = full-package build, SG packaging, a heavy focused test that compiles native code or runs many processes for a sustained period. Needs one lane.
- Remote dev machines (user 2026-11-16, "开发机上不占用 mini 的资源"): a step that executes ON a devbox (render/export, Docker image build, SG image checks, slow suites) is NOT a mini heavy task: it never takes `heavy-build`, a `heavy-lane-*` or `--shared-lock`, and is not subject to `heavy-check`. The mini side (ssh, `git archive | ssh tar`, polling) is light. Devbox capacity is coordinated with machine-scoped `remote` resources shared by all projects. Use `res wait-pool devbox-cn --by <unique wrapper id> --project <slug> --task <task> --for "<step>" --pid <long-lived wrapper pid> --timeout <min>` for heavy steps. It selects any registered `remote` row named `devbox-cn-<number>` (including newly added slots), excluding light slots. Success prints `slot=<id>`: capture that ID, hold only around the remote step, then `res return <id> --by <unique wrapper id>`. Checks under ~5 min use `res wait-pool devbox-cn-light`, which selects `devbox-cn-light` or `devbox-cn-light-<n>`. Each pool has a FIFO queue shown by `res status`, with heartbeat/rejoin and cleanup on signals or timeout. Re-waiting with the same holder/PID/host returns its existing pool slot without changing the hold. A trailing hyphen in the prefix is optional and uses the same queue. No mini resource or heavy gate is acquired. Slots: devbox-cn-1..4 + devbox-cn-light on CN devbox 1 (10.37.121.175, 8 cores/32 GiB; one heavy e2e ≈ 2.5 cores/<3 GiB), devbox-cn-5..6 + devbox-cn-light-2 on CN devbox 2 (10.37.249.249, 8 cores/15 GiB). Remote wrapper standard (BC-83, 2026-11-17): ssh with `-o ServerAliveInterval=15 -o ServerAliveCountMax=4` and one retry on "message authentication code incorrect"/"Corrupted MAC"; run remote steps in their own process group with a pidfile (`setsid`), and on every exit kill that group and confirm it is gone BEFORE `res return` of the slot; a remote owner that acts as a subreaper must reap adopted children continuously while it runs (not only at shutdown), excluding its own Popen children, or zombies make liveness checks lie. The SG-BOE devbox (2 cores/4 GiB) has no slots: probes only. Company remote build services (RemoteX), remote pipelines and CI run on their own capacity: no devbox slot and no mini lock (user 2026-11-16, "remoteX 构建也不需要占 devbox 槽位"); only compile steps that still run on the mini take heavy-build. Access is the user's normal ssh (Kerberos); an ssh auth error is BLOCKED, workers never kinit. Only code and demo/synthetic media go to devboxes: no secrets, no user or colleague media.
- NOT heavy: host unit tests that don't run a full native compile, single-TU compiles, doc/analysis work, device sessions without builds. PPE/staging/TCE/BITS/SCM deploys, remote/cloud pipelines, CI runs, `build-run --env test` procedural deploys and shared remote/CI entry scripts are also NOT heavy: they never take `heavy-build`, a lane or `--shared-lock`, and stay unthrottled (local `res` locks/verify throttles live only in local-only wrappers; `route.mjs --no-local-build` marks the remote case).

Commands (existing single-resource semantics unchanged except the documented PID diagnostics):
- Full build, one attempt: `res take-build --by <session> --project <slug> --for "<purpose>" --task <id> [--pid <pid>] [--lane heavy-lane-1|heavy-lane-2|heavy-lane-3]` → 0 pair acquired, 2 unavailable, 5 overloaded, 1 usage/metrics error.
- Full build, bounded: `res wait-build` with the same flags and required `--timeout <minutes>` → 0 acquired, 2 timeout; other errors propagate. Acquires `heavy-build` AND the first free admitted lane (1, 2, then optional 3), or holds neither before every retry. `--lane` pins a lane without hold-and-wait. Both commands run heavy-check with the selected holder PID; lane 3 also checks its stricter gate at acquisition.
- Heavy task, any lane: `res wait-lane --by <session> --project <slug> --for "<purpose>" --task <id> [--pid <pid>] --timeout <minutes>` → selects 1, 2, then 3 if registered and OPEN, without taking `heavy-build`. Repeating it with the same `--by` and holder PID returns the caller's existing lane instead of consuming a second lane.
- Pair release: `res return-build --by <session> [--pid <holder-pid>] [--note "<text>"]` → returns that unique holder’s lanes (3/2/1) before `heavy-build`; leaves other holders untouched. Optional --pid limits release to that recorded holder PID; the build wrapper uses this to protect preexisting same-name holds. The two normal returns also work. Use a unique `--by` for each run, never share it with concurrent heavy tasks or nest/adopt an existing build hold. Success ends with `build-lane=<id>` or `lane=<id>` so a wrapper can capture the selected lane. New command help: `res take-build --help` (legacy help remains byte-preserved).
- Build-waiter fairness (v1.5): every blocking `wait-build` (including `take-build --wait` callers that map to it) publishes holder/project/task/PID/host/start plus a heartbeat refreshed on each poll. The record is removed on acquire, timeout, INT/TERM/HUP and ordinary exit. Records with a dead local PID or a heartbeat older than 45 seconds (about three maximum poll intervals) are ignored and cleaned. `res status` lists live waiting builds with holder, start time and current blocker (`gate`, `slot` or `lane`); the log records `waiter-start`, `waiter-acquire` and `waiter-timeout`.
- Lane reservation (v1.5): when the oldest live build waiter has passed its gate recently and no unrelated established build holds `heavy-build`, another caller may not consume its last free admitted lane. The oldest waiter proceeds; younger build waiters yield FIFO. A plain lane `take` returns 2 with `reserved for waiting build <holder>; retry or use wait-lane`; bounded lane waits keep polling. A pinned waiter reserves only its pinned lane, and lane 3 counts only while OPEN. The post-mkdir check makes simultaneous takers conservative without a new coordination lock. A waiter gate-blocked on its last three polls stops reserving until it passes the gate again. This reservation never grants a lane, evicts a holder, changes load/memory admission, or causes the waiter to hold either half while waiting.
- Lane-waiter fairness (v1.6): blocking `wait-lane` publishes the same fields and lifecycle under `lane-waiters/waiter.*`, with resource `heavy-lane-any` in waiter logs. Dead local PIDs or >45s heartbeat expiry remove priority. Among gate-ready waiters, a foreign waiting project with no non-STALE lane caps a project already holding a lane at one lane. When every waiting project already holds a lane, the oldest ready waiter may take spare capacity. A capped waiter yields FIFO position to eligible projects; it cannot deadlock their queue. A plain additional-lane take returns 2 with a project-priority explanation, and waits poll until eligible. Younger lane waiters yield to the oldest eligible waiter; other callers reserve its last free admitted lane. Build-waiter reservation is checked first, and the oldest ready blocking build waiter keeps priority over the lane queue. No live ready waiter means no cap or reservation; `res status` lists waiting lanes, including their blocker. Publication precedes the project check to cover concurrent takers. Reservations never acquire or evict a hold.
- Try: `res take <id> --by <session> --project <slug> --for "<purpose>" --task <id> [--pid <pid>]` → 0 ok, 2 held (don't block).
- Block: `res wait <id> --by <session> --project <slug> --for "<purpose>" --task <id> [--pid <pid>] --timeout <minutes>` → retries with backoff until taken (0) or timeout (2). For `heavy-*` ids, wait uses the same lane-aware gate as heavy-check with its selected holder PID on every retry; it keeps waiting while load1m exceeds the active limit or available memory is below the configured minimum (default 16 GiB).
- Lane-aware load limit (defaults unchanged from v1.2): count currently held `heavy-lane-*` directories, including lane 3, excluding STALE holds and holds whose recorded PID equals the caller's holder PID. With no other holds use LOAD_LIMIT (default 12); with one or more use LOAD_LIMIT_WITH_LANES (default 20). Legacy/remote/incomplete holds remain counted unless their recorded PID equals that PID. `heavy-build` itself does not count. The gate never overrides an occupied lane.
- Gate only: `res heavy-check [--pid <pid>]` → 0 ok, 5 overloaded, 1 metrics/usage error; prints `load1m=... limit=... lanes_held=... avail=...GiB`, memorystatus percentage, page headroom, swap used, and `gate=OK|OVERLOADED`. Default PID is the caller's (`res`'s `$PPID`); wrappers pass the same `--pid $$` as take/wait. Callers using plain `take` must run this check themselves first.
- Available memory = macOS memorystatus level × RAM (`kern.memorystatus_level / 100 * hw.memsize`). Only if the memorystatus sysctl is missing, use (free + inactive + speculative) pages * page size. Page headroom and swap usage are diagnostics, not extra gates. Linux still uses MemAvailable. Invalid/unreadable metrics return 1 without acquiring a hold.
- Machine thresholds (v1.6): optional `$RES_DIR/machine.conf` is plain `KEY=value` data, with blank lines, whole-line `#` comments and surrounding whitespace allowed. Supported keys/defaults are `LOAD_LIMIT=12`, `LOAD_LIMIT_WITH_LANES=20`, `MIN_AVAIL_GIB=16`, `LANE3_LOAD=8`, `LANE3_AVAIL_GIB=32`. Partial overrides keep remaining defaults. Values are positive decimals: load at most 1024, GiB at most 65536. Held-load limit must be at least idle-load limit; lane 3 load at most idle-load limit and memory at least normal memory. Duplicate/unknown keys, unreadable files and invalid values return 1. Publish the file atomically: write the complete configuration to a temporary file in RES_DIR, terminate every record with a newline, then rename it over machine.conf. Never edit machine.conf in place; the previous file stays active while the temporary file is written. Empty, unterminated or changing snapshots are rejected before applying any overrides. Missing entries select defaults; dangling symlinks, FIFOs and other nonregular entries return 1 for heavy-check and heavy takes. The reader validates its opened descriptor as readable and regular. Configuration reads use Python 3. The controller never creates this file. Each heavy-check reads it anew and prints `thresholds source=defaults|machine.conf` and all five active values before the existing metrics line; telemetry accepts both formats. Configured thresholds govern both normal and lane-3 admission using unrounded metrics on Darwin and Linux. Defaults retain 12/20/16 and 8/32 when the file is absent.
- v1.3 appends `lane3=OPEN|CLOSED` AFTER `gate=...` in Darwin and Linux heavy-check output; all previous fields and ordering remain unchanged. It describes lane-3 admission, NOT ownership/free status. An occupied lane can still report OPEN. A normal gate can be OK while lane3 is CLOSED. Both comparisons use unrounded metrics, so a displayed 8.00/32.00 can still be CLOSED. Old fixed-12 and v1.2 output remain accepted by the sampler with `lane3:null` (unknown, never OPEN).
- Lane-3 `take` checks this stricter gate itself and returns 5 when unavailable (1 for invalid/unreadable metrics). Lanes 1/2 and other resources retain their existing plain-take semantics. Lane-3 `wait` rechecks on every retry and before acquisition, treating a CLOSED lane like overload until bounded timeout (2), including if the gate closes between its check and take. Reclamation is allowed only with the lane's admission gate OPEN and age strictly >600 seconds. No existing holder is evicted if load/memory later changes; return works normally under a CLOSED gate.
- Release: `res return <id> --by <session>` on every exit path. Use a shell `trap 'res return …' EXIT`.
- Holder process (VAK addition): `take` and `wait` accept `--pid <pid>` naming the long-lived holder process; wrappers pass `--pid $$`. Default is the caller's PID (`res`'s `$PPID`), NEVER `res`'s own short-lived PID. A transient launcher exiting does not stale a hold whose recorded holder PID is still alive.
- Hold metadata: existing `by/project/task/for/since/until` keys are unchanged; new keys are `pid`, `host` (local `hostname`), and `start` (hold acquisition time, Unix epoch seconds).
- Crash/stale: take records holder PID, host and start time. STALE means the recorded PID is not alive. `res status` marks a hold STALE when the local-host PID is gone (legacy holds without PID/host and remote-host holds cannot be verified locally). `res wait`/`wait-build`/`wait-lane` auto-reclaim a STALE heavy-* hold older than 10 minutes and writes a log line. Otherwise use the existing `res return --force --note`.
- Order: full builds use `take-build`/`wait-build`, not two independent blocking waits. Internally a short attempt takes the slot then a free lane using the existing atomic mkdir arbitration; failed attempts and INT/TERM/HUP unwind in reverse. Rollback protection stays armed through cleanup and final process exit: the first cancellation is preserved even while the mkdir verdict is pending, freshly created holds are released, then that signal's 129/130/143 status is returned. A rollback helper interrupted before arming its signal shield is relaunched while its fresh directory remains. An interrupted parent wait reads the completed helper's actual verdict before retrying, so a replacement holder is not mistaken for the released attempt. Genuine cleanup errors return 1 rather than a saved cancellation status. `wait` applies the same fresh-ownership guard through its delayed PID diagnostic; an interrupted idempotent wait preserves the pre-existing hold. There is no extra coordination lock and no sleep/backoff with only one hold. The two directory creations are not a single filesystem transaction: observers can see a partial in-flight attempt, but contention, failure or signals return its newly created holds before waiting. SIGKILL/crash still relies on the existing STALE recovery. Never hold either resource while waiting for the other.
- Holder PID: `--pid` must name the long-lived wrapper or the long-lived build process itself. Workers never take/wait for heavy locks in a standalone tool call: every tool call has a fresh shell whose `$$` exits when that call returns. Acquisition, build and return must happen in ONE process, using `scripts/heavy-build.sh <command...>` or a wrapper around `take-build`/`wait-build`.
- PID diagnostics: a dead explicit PID warns at fresh take without refusing. Fresh explicit-PID `wait`, `take-build`, `wait-build` and `wait-lane` check once after 2 seconds, after acquisition, and append `pid_warning\tshort-lived pid` if it has died. Plain `take` has no delay; idempotent takes/waits do not rewrite metadata or run the delayed check. The warning says `res: --pid <n> is not a long-lived process; pass the wrapper's $$; use scripts/heavy-build.sh <command...>`. An unavailable process probe does not establish death. A successful acquisition can include this 2-second diagnostic grace period beyond the acquisition timeout.
- Early status: a proven local dead PID with `pid_warning`, or a hold acquired within the last 5 seconds, appears as `STALE?(short-lived pid)` and prints the wrapper fix. Status remains observational. This catches a standalone tool shell that dies only AFTER res returns; a synchronous take cannot predict that later exit. Older unwarned dead holds remain `STALE`. The `?` flags suspect holder selection; the local PID is still proven dead, and the >600s reclaim rule is unchanged.
- Worker liveness: wrappers must exit when their worker dies, using exit/signal traps plus a parent watch. `scripts/heavy-build.sh --watch-pid <pid> <command...>` optionally watches a long-lived worker/follower/agent shell; disappearance terminates its owned command group and returns both holds, including while acquisition is waiting. The watched PID is distinct from the holder PID, which remains the wrapper’s `$$`.
- Same-task successor: after quota exhaustion/crash, verify the predecessor’s project/task ID, local host and dead PID in `res status` and its hold info. The successor of that task returns the predecessor’s STALE lane then slot with `res return <id> --by <predecessor-holder>`, or an explicit `--force --note "same-task takeover <task-id> from <predecessor>"` under the existing rules, then re-takes with its own unique holder and long-lived PID. A young STALE hold need not wait 10 minutes for this coordinated manual return. Never adopt unchanged PID/start metadata or return an active/unverified hold merely because its task ID matches.

## Stable State and Device Interface

Default state remains `$HOME/.claude/orchestrator/_shared`; `RES_DIR` overrides it for isolated tests.
`resources.tsv` remains five TAB-separated columns: id/kind/policy/device/description. `log.tsv`
has no header and five columns: local minute timestamp/action/id/holder/note; actions include
take/return/extend/add/note/reclaim and the three waiter lifecycle actions. `locks/<id>.d` presence is the hold; `info` retains nine
TAB-separated keys in order: by/project/task/for/since/until/pid/host/start, with optional appended pid_warning. Healthy non-device holds retain the exact original nine keys. Device holds append `adb_device_lines` (all stdout lines from `adb devices -l`, including its header and blank lines) and `device_clients` (comma-separated `PID:adb`/`PID:devicectl`, or `none`/`unknown`); the take log carries the same values. Each device snapshot probe has a two-second timeout and uses Python 3; unavailable tools or timeouts produce unknown. The client snapshots and initial explicit-PID diagnostic finish before a fresh lease directory is created, so a hang cannot leave ownership half-published. Snapshot failures never fail the take. Device serials/details and process arguments are discarded; idempotent takes retain the original evidence. No state migration.
Live waiter records are private controller state under `build-waiters/waiter.*` and `lane-waiters/waiter.*`; callers do not create or remove them.
Status is observational, uses the same columns/notes, and does not reclaim. `until` is informational.
PID reuse counts as alive in the controller; legacy/remote metadata is not automatically reclaimed.
Same-by idempotent take never refreshes PID/start: a replacement process must return/re-take.
For an existing lane-3 hold, same-by re-take returns 0 without a new gate probe even if load/memory later closes
the gate; it does not acquire anew. New lane-3 acquisitions and bounded waits retain their admission checks.

Devices including iphone11/iphone8/s21 retain connection probes, `--offline`, ask-user/never policy,
default ask-user registration, notes and force-return coordination. `add --device -` still creates a
checkout, not a slot; the owner installs lane 3 via the reviewed registry row, not `res add`.
Legacy CLI help remains unchanged apart from the new `wait-pool` block; non-heavy command semantics and exit codes are unchanged (explicit dead-PID diagnostics also apply to take): 0 success, 2 held/timeout, 3 policy,
4 disconnected, 5 overload, 1 usage/metrics/other error. Tests never use live state or devices.

## Owner Switch

Branch -> all suites -> review -> owner switches -> dated digest notification and caller acknowledgements.
See [resources.md](resources.md#res-ownership) for source provenance, install/rollback and known pitfalls.
Do not merge over or replace the currently installed symlink target before it has been backed up.
Coordinate a quiescent switch; `--force` is an explicit owner override, never permission to kill waiters.
Old waiters keep old Bash code until their owners re-invoke them.

## Caller Compatibility and Observation

The public entry remains `$HOME/.claude/orchestrator/_shared/res` after the symlink switch; callers must
not use a private controller. The build wrapper's `RES_COMMAND`, env tools' `VESDK_RES_BIN`, and VAK's
`VAK_VERIFY_RES` retain their existing public-entry defaults. Existing env/VAK callers selecting only
lanes 1/2 remain compatible and need not adopt lane 3. Timeout arguments stay finite minutes (decimals
and zero allowed); pass the same long-lived `--pid $$` to heavy-check, take and wait.

The maintained `scripts/heavy-build.sh` uses `wait-build` for pair acquisition and reverse release.
v1.6 requires no caller changes: existing build/lane wrappers and finite timeouts automatically publish and clean their waiter record.
`HEAVY_BUILD_LANE` explicitly pins a lane. If unpinned lane 3 is unknown on a legacy installation, the wrapper
continues bounded waits on lanes 1/2 within the same timeout; on an exact legacy-help response from a rolled-back controller it uses zero-timeout slot/lane attempts, returning the slot before any backoff; unrelated errors still fail closed, and an explicit
missing lane-3 pin remains an error. The installer backs up code/registry, stages an idempotent lane-3 row and
publishes code before the atomic registry rename under owner quiescence, restoring both on publication failure.
The owner installs notes separately and publishes the combined rules digest with caller acknowledgements.
Rollback restores notes and the registry before switching to the printed code backup, so no old controller can
admit a registered, ungated lane 3. These two filesystem entries are not a single atomic transaction.

Telemetry recognizes an optional third lane only when observed; its absence does not make v1.2 incomplete.
`thirdLaneOnly` observations are excluded from normal-gate tuning because 8/32 admission is a distinct context.
Explicit machine.conf observations likewise stay outside default-gate tuning; their captured active
limits and memory minimum govern reader comparisons and gate diagnostics.
A captured `lane3=OPEN|CLOSED` is authoritative; legacy observations without that suffix never establish
lane-3 permission. Passive idle hints, quota-expiry preferences and utilisation reports cannot acquire,
release or modify locks, and do not change this contract's single package slot or configured machine gates.

## Fixture Tests

`node scripts/res/test/run.mjs` runs the registered res suites with scratch HOME, registry and PID probes.
Under load, run each suite separately, for example
`RES_TEST_SUITE=pools.mjs RES_TEST_NO_WATCHDOG=1 node scripts/res/test/run.mjs`.
The runner supplies `RES_TEST_ROOT` and `RES_SOURCE` to the individual suite and retains its logs;
only the outer watchdog is disabled, not the command's bounded waits or production admission checks.
