# Machine-Wide Heavy-Task Protocol (res Contract v1.3)

Owner: routing/global-rules orchestrator since 2026-11-13. Maintained contract:
project-orchestrator/references/res-contract.md. Install only after reviewed v1.3 switch.

- Full iOS/Android SDK+host-app builds hold `heavy-build` AND one of
  `heavy-lane-1` / `heavy-lane-2` / `heavy-lane-3` for the entire run. SG packaging
  and heavy focused tests hold one lane. At most one full build, two normal
  heavy tasks, or three when lane 3 is admitted at load1m <=8 AND avail >=32 GiB.
- ORDER: acquire `heavy-build` FIRST, then one lane; return lane FIRST, then
  `heavy-build`. NEVER hold a lane while waiting for `heavy-build` (deadlock).
- `res wait <id> --by <session> --project <slug> --for "<purpose>" --task <id>
  --pid $$ --timeout <minutes>` retries with 1/2/4/8/15-second capped backoff.
  For `heavy-*`, it waits while load1m exceeds the lane-aware limit OR
  available memory < 16 GiB. With no other heavy lanes held, the load limit is
  12; with one or more held, it is 20 (capped there, including two held lanes).
  Count `heavy-lane-*` holds only, excluding STALE holds and those whose
  recorded PID equals the caller's holder PID. Unverified legacy/remote holds
  count unless their recorded PID equals that PID. Lane-3 holders count too;
  the load gate does not override resource ownership.
  Timeout is non-negative minutes (decimals allowed); zero makes one attempt.
- `take` and `wait` accept `--pid <pid>` for the LONG-LIVED holder process.
  Wrappers should pass `--pid $$`. Default is res's `$PPID` (the caller), NEVER
  res's own short-lived PID. Do not name a transient launcher/subshell.
- `res heavy-check [--pid <pid>]` prints load1m, limit, lanes_held, available
  memory, memorystatus percentage, page headroom, and swap used:
  0 OK, 5 overloaded, 1 metrics/usage error. The default PID is the caller's
  (`res`'s `$PPID`); pass the same `--pid $$` as take/wait from wrappers.
  Plain `take` remains nonblocking; callers MUST check first for heavy tasks.
  Lane 3 additionally enforces load1m <=8 AND avail >=32 GiB inside take, using
  unrounded readings and the same memory basis; CLOSED returns 5. Lane-3 wait
  keeps waiting while CLOSED, including closure between check and take.
  Output appends `lane3=OPEN|CLOSED`; OPEN does not mean the lane is unoccupied.
  `wait` passes its selected holder PID to this same gate on every retry.
  macOS available memory = macOS memorystatus level × RAM:
  `kern.memorystatus_level / 100 * hw.memsize`. Only if that sysctl is missing,
  fall back to (free + inactive + speculative) pages * page size. Page headroom
  and swap used are diagnostics, not additional gates. Linux uses MemAvailable.
- `take`: 0 acquired/already yours, 2 held, 3 policy, 4 disconnected, 5 lane-3 unavailable, 1 error.
  `wait`: 0 acquired, 2 timeout (including overload), other errors propagate.
- A take records PID, host, and epoch start (plus existing since/until fields).
  `status` marks STALE when the recorded local-host PID is not alive; it never
  reclaims. Legacy holds without PID/host and remote-host holds are unverified.
  Only `wait` auto-reclaims STALE `heavy-*` holds older than 10 minutes and logs
  `reclaim` / `auto-reclaim STALE`. Younger, live, non-heavy, legacy, and remote
  holds remain untouched. Otherwise: `res return <id> --by <session> --force
  --note "<why>"`. Never kill another session's processes.
- Lane-3 STALE reclaim also needs its stricter gate OPEN; age must be >600s.
  Return still works while CLOSED. No eviction when load/memory changes.
  Old waiters retain old code until re-invoked by their owners; do not kill them.
- Install an EXIT trap BEFORE acquisition; release on all failures/timeouts
  and signals. `scripts/heavy-build.sh` tries lanes 1, 2, then 3 with bounded
  retry; HEAVY_BUILD_LANE can explicitly pin 1/2/3. Example (fixed lane here):

```bash
res="$HOME/.claude/orchestrator/_shared/res"
by="<session>"; project="<slug>"; task="<id>"
build_held=0; lane_held=0
cleanup() {
  if [ "$lane_held" = 1 ]; then "$res" return heavy-lane-1 --by "$by"; fi
  if [ "$build_held" = 1 ]; then "$res" return heavy-build --by "$by"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
"$res" wait heavy-build --by "$by" --project "$project" --for "full build" \
  --task "$task" --pid $$ --timeout 60 || exit $?
build_held=1
"$res" wait heavy-lane-1 --by "$by" --project "$project" --for "full build" \
  --task "$task" --pid $$ --timeout 60 || exit $?
lane_held=1
# Run the complete build/preflight/stage/acceptance here.
```

- Compile 6 jobs; link 1; Xcode `-jobs 6`; Gradle 2 workers and Java heap 6 GiB.
  Total test concurrency 6-8. Keep dirs fixed per base and build incrementally;
  do one cold build before formal acceptance. Ninja `-j` must be configurable.
- Regenerate Pods/headers only when inputs change; no native build without
  native changes. No extra source copies for credential isolation: use
  sanitized public inputs. Close browsers/child processes after tests.
