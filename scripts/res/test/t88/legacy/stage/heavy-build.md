# Machine-Wide Heavy-Task Protocol (T83 Contract v1)

- Full iOS/Android SDK+host-app builds hold `heavy-build` AND one of
  `heavy-lane-1` / `heavy-lane-2` for the entire run. SG packaging and heavy
  focused tests hold one lane. At most one full build and two heavy tasks.
- ORDER: acquire `heavy-build` FIRST, then one lane; return lane FIRST, then
  `heavy-build`. NEVER hold a lane while waiting for `heavy-build` (deadlock).
- `res wait <id> --by <session> --project <slug> --for "<purpose>" --task <id>
  --pid $$ --timeout <minutes>` retries with 1/2/4/8/15-second capped backoff.
  For `heavy-*`, it waits while load1m > 12 OR available memory < 16 GiB.
  Timeout is non-negative minutes (decimals allowed); zero makes one attempt.
- `take` and `wait` accept `--pid <pid>` for the LONG-LIVED holder process.
  Wrappers should pass `--pid $$`. Default is res's `$PPID` (the caller), NEVER
  res's own short-lived PID. Do not name a transient launcher/subshell.
- `res heavy-check` prints load1m, available memory, memorystatus percentage,
  page headroom, and swap used: 0 OK, 5 overloaded, 1 metrics error.
  Plain `take` remains nonblocking and ungated: callers MUST check first.
  macOS available memory = macOS memorystatus level × RAM:
  `kern.memorystatus_level / 100 * hw.memsize`. Only if that sysctl is missing,
  fall back to (free + inactive + speculative) pages * page size. Page headroom
  and swap used are diagnostics, not additional gates. Linux uses MemAvailable.
- `take`: 0 acquired/already yours, 2 held, 3 policy, 4 disconnected, 1 error.
  `wait`: 0 acquired, 2 timeout (including overload), other errors propagate.
- A take records PID, host, and epoch start (plus existing since/until fields).
  `status` marks STALE when the recorded local-host PID is not alive; it never
  reclaims. Legacy holds without PID/host and remote-host holds are unverified.
  Only `wait` auto-reclaims STALE `heavy-*` holds older than 10 minutes and logs
  `reclaim` / `auto-reclaim STALE`. Younger, live, non-heavy, legacy, and remote
  holds remain untouched. Otherwise: `res return <id> --by <session> --force
  --note "<why>"`. Never kill another session's processes.
- Install an EXIT trap BEFORE acquisition; release on all failures/timeouts
  and signals. Example (lane choice fixed here; scripts may try both lanes):

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
