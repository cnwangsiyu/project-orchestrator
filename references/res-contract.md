# Shared res contract (v1.3, 2026-11-13) - owner: routing/global-rules orchestrator; users: all projects

Maintained source: this project-orchestrator repository, `scripts/res/res`. Ownership of the entire
tool (devices, checkouts, registry/notes, take/return/extend/add/note/log and heavy admission) transferred
from vesdk-mainline to the global-rules owner on 2026-11-13. The unmodified v1.2 contract is preserved
in `scripts/res/test/fixtures/contract-v1.2.md`. v1.3 is staged, not live until the owner's reviewed switch.

Resources in `res` (~/.claude/orchestrator/_shared/res):
- `heavy-build` — the ONE machine-wide full-package build slot.
- `heavy-lane-1`, `heavy-lane-2` - the two normal heavy-task lanes.
- `heavy-lane-3` - optional third heavy-task lane; admission requires load1m <=8 AND available memory >=32 GiB at take time. Capacity floats between two and three lanes, not an automatic tuning range for load/memory.

Definitions:
- Full-package build = a full iOS or Android SDK+host-app build: an env verify run (preflight, stage, compile, acceptance), an xcodebuild of the app, a Gradle assemble with native compile. Needs `heavy-build` AND one lane, held for the whole run.
- Heavy task = full-package build, SG packaging, a heavy focused test that compiles native code or runs many processes for a sustained period. Needs one lane.
- NOT heavy: host unit tests that don't run a full native compile, single-TU compiles, doc/analysis work, device sessions without builds. PPE/staging/TCE/BITS/SCM deploys, remote/cloud pipelines, CI runs, `build-run --env test` procedural deploys and shared remote/CI entry scripts are also NOT heavy: they never take `heavy-build`, a lane or `--shared-lock`, and stay unthrottled (local `res` locks/verify throttles live only in local-only wrappers; `route.mjs --no-local-build` marks the remote case).

Commands (existing semantics unchanged):
- Try: `res take <id> --by <session> --project <slug> --for "<purpose>" --task <id> [--pid <pid>]` → 0 ok, 2 held (don't block).
- Block: `res wait <id> --by <session> --project <slug> --for "<purpose>" --task <id> [--pid <pid>] --timeout <minutes>` → retries with backoff until taken (0) or timeout (2). For `heavy-*` ids, wait uses the same lane-aware gate as heavy-check with its selected holder PID on every retry; it keeps waiting while load1m exceeds the limit or available memory < 16 GiB.
- Lane-aware load limit (unchanged from v1.2): count currently held `heavy-lane-*` directories, including lane 3, excluding STALE holds and holds whose recorded PID equals the caller's holder PID. Limit = `min(20, 12 + 8 * lanes_held)`: zero other holds allows load1m <=12; one or more allows <=20. Legacy/remote/incomplete holds remain counted unless their recorded PID equals that PID. `heavy-build` itself does not count. The gate never overrides an occupied lane.
- Gate only: `res heavy-check [--pid <pid>]` → 0 ok, 5 overloaded, 1 metrics/usage error; prints `load1m=... limit=... lanes_held=... avail=...GiB`, memorystatus percentage, page headroom, swap used, and `gate=OK|OVERLOADED`. Default PID is the caller's (`res`'s `$PPID`); wrappers pass the same `--pid $$` as take/wait. Callers using plain `take` must run this check themselves first.
- Available memory = macOS memorystatus level × RAM (`kern.memorystatus_level / 100 * hw.memsize`). Only if the memorystatus sysctl is missing, use (free + inactive + speculative) pages * page size. Page headroom and swap usage are diagnostics, not extra gates. Linux still uses MemAvailable. Invalid/unreadable metrics return 1 without acquiring a hold.
- v1.3 appends `lane3=OPEN|CLOSED` AFTER `gate=...` in Darwin and Linux heavy-check output; all previous fields and ordering remain unchanged. It describes lane-3 admission, NOT ownership/free status. An occupied lane can still report OPEN. A normal gate can be OK while lane3 is CLOSED. Both comparisons use unrounded metrics, so a displayed 8.00/32.00 can still be CLOSED. Old fixed-12 and v1.2 output remain accepted by the sampler with `lane3:null` (unknown, never OPEN).
- Lane-3 `take` checks this stricter gate itself and returns 5 when unavailable (1 for invalid/unreadable metrics). Lanes 1/2 and other resources retain their existing plain-take semantics. Lane-3 `wait` rechecks on every retry and before acquisition, treating a CLOSED lane like overload until bounded timeout (2), including if the gate closes between its check and take. Reclamation is allowed only with the lane's admission gate OPEN and age strictly >600 seconds. No existing holder is evicted if load/memory later changes; return works normally under a CLOSED gate.
- Release: `res return <id> --by <session>` on every exit path. Use a shell `trap 'res return …' EXIT`.
- Holder process (VAK addition): `take` and `wait` accept `--pid <pid>` naming the long-lived holder process; wrappers pass `--pid $$`. Default is the caller's PID (`res`'s `$PPID`), NEVER `res`'s own short-lived PID. A transient launcher exiting does not stale a hold whose recorded holder PID is still alive.
- Hold metadata: existing `by/project/task/for/since/until` keys are unchanged; new keys are `pid`, `host` (local `hostname`), and `start` (hold acquisition time, Unix epoch seconds).
- Crash/stale: take records holder PID, host and start time. STALE means the recorded PID is not alive. `res status` marks a hold STALE when the local-host PID is gone (legacy holds without PID/host and remote-host holds cannot be verified locally). `res wait` auto-reclaims a STALE heavy-* hold older than 10 minutes and writes a log line. Otherwise use the existing `res return --force --note`.
- Order: take `heavy-build` first, then a lane. Return in reverse order. Never hold a lane while waiting for `heavy-build`, to avoid deadlock.
- Holder PID: `take`/`wait` accept `--pid <pid>` (wrappers pass `$$`, their own long-lived PID); default is the caller's PID (res's `$PPID`). STALE means the recorded PID is not alive.

## Stable State and Device Interface

Default state remains `$HOME/.claude/orchestrator/_shared`; `RES_DIR` overrides it for isolated tests.
`resources.tsv` remains five TAB-separated columns: id/kind/policy/device/description. `log.tsv`
has no header and five columns: local minute timestamp/action/id/holder/note; actions are
take/return/extend/add/note/reclaim. `locks/<id>.d` presence is the hold; `info` retains nine
TAB-separated keys in order: by/project/task/for/since/until/pid/host/start. No state migration.
Status is observational, uses the same columns/notes, and does not reclaim. `until` is informational.
PID reuse counts as alive in the controller; legacy/remote metadata is not automatically reclaimed.
Same-by idempotent take never refreshes PID/start: a replacement process must return/re-take.
For an existing lane-3 hold, same-by re-take returns 0 without a new gate probe even if load/memory later closes
the gate; it does not acquire anew. New lane-3 acquisitions and bounded waits retain their admission checks.

Devices including iphone11/iphone8/s21 retain connection probes, `--offline`, ask-user/never policy,
default ask-user registration, notes and force-return coordination. `add --device -` still creates a
checkout, not a slot; the owner installs lane 3 via the reviewed registry row, not `res add`.
CLI help, non-heavy commands and exit codes are unchanged: 0 success, 2 held/timeout, 3 policy,
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

The maintained `scripts/heavy-build.sh` tries lanes 1, 2, then 3 with bounded retry and reverse release.
`HEAVY_BUILD_LANE` explicitly pins a lane. If unpinned lane 3 is unknown on a legacy installation, the wrapper
continues bounded waits on lanes 1/2 within the same timeout; unrelated errors still fail closed, and an explicit
missing lane-3 pin remains an error. The installer backs up code/registry, stages an idempotent lane-3 row and
publishes code before the atomic registry rename under owner quiescence, restoring both on publication failure.
The owner installs notes separately and publishes the combined rules digest with caller acknowledgements.
Rollback restores notes and the registry before switching to the printed code backup, so no old controller can
admit a registered, ungated lane 3. These two filesystem entries are not a single atomic transaction.

Telemetry recognizes an optional third lane only when observed; its absence does not make v1.2 incomplete.
`thirdLaneOnly` observations are excluded from normal-gate tuning because 8/32 admission is a distinct context.
A captured `lane3=OPEN|CLOSED` is authoritative; legacy observations without that suffix never establish
lane-3 permission. Passive idle hints, quota-expiry preferences and utilisation reports cannot acquire,
release or modify locks, and do not change this contract's single package slot or normal 12/20/16 gates.
