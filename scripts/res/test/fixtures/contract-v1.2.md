# Heavy-build lock contract (v1.2, 2026-11-13) — owner: vesdk-mainline; users: vesdk, Lynx, VAK

Resources in `res` (~/.claude/orchestrator/_shared/res):
- `heavy-build` — the ONE machine-wide full-package build slot.
- `heavy-lane-1`, `heavy-lane-2` — heavy-task lanes (at most 2 heavy tasks machine-wide).

Definitions:
- Full-package build = a full iOS or Android SDK+host-app build: an env verify run (preflight, stage, compile, acceptance), an xcodebuild of the app, a Gradle assemble with native compile. Needs `heavy-build` AND one lane, held for the whole run.
- Heavy task = full-package build, SG packaging, a heavy focused test that compiles native code or runs many processes for a sustained period. Needs one lane.
- NOT heavy: host unit tests that don't run a full native compile, single-TU compiles, doc/analysis work, device sessions without builds.

Commands (existing semantics unchanged):
- Try: `res take <id> --by <session> --project <slug> --for "<purpose>" --task <id> [--pid <pid>]` → 0 ok, 2 held (don't block).
- Block: `res wait <id> --by <session> --project <slug> --for "<purpose>" --task <id> [--pid <pid>] --timeout <minutes>` → retries with backoff until taken (0) or timeout (2). For `heavy-*` ids, wait uses the same lane-aware gate as heavy-check with its selected holder PID on every retry; it keeps waiting while load1m exceeds the limit or available memory < 16 GiB.
- Lane-aware load limit (v1.2): count currently held `heavy-lane-*` directories, excluding STALE holds and holds whose recorded PID equals the caller's holder PID. Limit = `12 + 8 * min(lanes_held, 1)`: zero other holds allows load1m <= 12; one or more allows <= 20. Legacy/remote/incomplete holds remain counted unless their recorded PID equals that PID. `heavy-build` itself does not count. With both lanes held there is no free lane; the gate never overrides a hold.
- Gate only: `res heavy-check [--pid <pid>]` → 0 ok, 5 overloaded, 1 metrics/usage error; prints `load1m=... limit=... lanes_held=... avail=...GiB`, memorystatus percentage, page headroom, swap used, and `gate=OK|OVERLOADED`. Default PID is the caller's (`res`'s `$PPID`); wrappers pass the same `--pid $$` as take/wait. Callers using plain `take` must run this check themselves first.
- Available memory = macOS memorystatus level × RAM (`kern.memorystatus_level / 100 * hw.memsize`). Only if the memorystatus sysctl is missing, use (free + inactive + speculative) pages * page size. Page headroom and swap usage are diagnostics, not extra gates. Linux still uses MemAvailable. Invalid/unreadable metrics return 1 without acquiring a hold.
- Release: `res return <id> --by <session>` on every exit path. Use a shell `trap 'res return …' EXIT`.
- Holder process (VAK addition): `take` and `wait` accept `--pid <pid>` naming the long-lived holder process; wrappers pass `--pid $$`. Default is the caller's PID (`res`'s `$PPID`), NEVER `res`'s own short-lived PID. A transient launcher exiting does not stale a hold whose recorded holder PID is still alive.
- Hold metadata: existing `by/project/task/for/since/until` keys are unchanged; new keys are `pid`, `host` (local `hostname`), and `start` (hold acquisition time, Unix epoch seconds).
- Crash/stale: take records holder PID, host and start time. STALE means the recorded PID is not alive. `res status` marks a hold STALE when the local-host PID is gone (legacy holds without PID/host and remote-host holds cannot be verified locally). `res wait` auto-reclaims a STALE heavy-* hold older than 10 minutes and writes a log line. Otherwise use the existing `res return --force --note`.
- Order: take `heavy-build` first, then a lane. Return in reverse order. Never hold a lane while waiting for `heavy-build`, to avoid deadlock.
- Holder PID: `take`/`wait` accept `--pid <pid>` (wrappers pass `$$`, their own long-lived PID); default is the caller's PID (res's `$PPID`). STALE means the recorded PID is not alive.
