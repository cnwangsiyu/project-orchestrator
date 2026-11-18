# Machine-Wide Heavy-Task Protocol (current res contract)

Owner: routing/global-rules orchestrator since 2026-11-13. Maintained contract:
project-orchestrator/references/res-contract.md. Install only after reviewed owner switch.

- Full iOS/Android SDK+host-app builds need one counted `heavy-build` hold AND
  one heavy lane for the whole run. Default build capacity is two (configurable
  1..3); res status shows k/N. `take-build` / `wait-build` acquire the pair
  together or release partial acquisitions before retrying. NEVER hold either
  resource while waiting for the other. Default lane order is 1, 2, then 3.
  `--lane heavy-lane-N` (wrapper: HEAVY_BUILD_LANE) pins without hold-and-wait.
  Optional `--checkout <path|resource>` makes checkout identity explicit;
  concurrent builds must have distinct resolved checkout/repository identities.
- SG packaging and heavy focused tests use `wait-lane`, selecting any free
  admitted lane without taking heavy-build. Repeating `wait-lane` with the
  same holder name and PID returns that existing lane; it does not take two.
  Normal lanes 1/2 default to load1m <=1.25 x physical cores and available
  memory >=12 GiB. Optional lane 3 defaults to load1m <=8 AND available memory
  >=32 GiB at acquisition. Active values come from heavy-check.
- `wait-lane` publishes a live heartbeat record, shown by res status. While a
  ready waiter from another project with no lane exists, a project holding a lane yields
  additional lanes. Eligible lane waiters proceed FIFO; gate-blocked waiters
  stop reserving after three polls. Blocking builds retain their priority.
- Use ONE long-lived process for acquisition, build and return. Workers never
  take/wait for heavy locks in a standalone tool call: each call has a fresh
  shell whose $$ exits after the call, even if a later build remains alive.
  Use scripts/heavy-build.sh <command...>, or take-build inside a wrapper, or
  --pid naming the long-lived build itself. Wrappers should pass `--pid $$`.
  Default PID is res's $PPID (the caller), never res's own short-lived PID.
- Fresh takes warn for dead explicit PIDs without refusing. Plain take has no
  delay; explicit-PID wait/take-build/wait-build/wait-lane check once after 2s
  following acquisition, appending pid_warning if the PID dies. Status shows
  STALE?(short-lived pid) and says "use scripts/heavy-build.sh …" for warned
  local dead holders, or a proven dead holder acquired within 5s. A synchronous
  take cannot predict a shell that exits only after it returns; early status
  detects that usage error without mutating the hold. INT/TERM/HUP during
  acquisition or the delayed check returns every freshly acquired hold before
  exiting with the signal status; idempotent pre-existing holds stay. Fix the
  caller.
- `wait-build` / `wait-lane` require --timeout <non-negative minutes>; decimals
  and zero (one attempt) work, with 1/2/4/8/15s capped backoff. The timeout is
  for acquisition; a successful explicit-PID acquisition also has a 2s check.
  `take-build`: 0 pair acquired, 2 unavailable, 5 overloaded, 1 metrics/usage
  error (policy codes propagate). `wait-*`: 0 acquired, 2 timeout; other errors
  propagate. Legacy take/wait/return and their help remain compatible.
- Full-build acquisition retains the legacy heavy-check with the selected holder
  PID every retry: available memory >=16 GiB and load1m <=min(20,12+8*other lanes).
  Count held heavy-lane-* only, excluding local proven STALE and matching
  holder PID; legacy/remote holds count conservatively. Lane 3 enforces its
  stricter configured gate again at take time. OPEN does not mean FREE.
  Plain take still needs caller heavy-check (lane-3 take also enforces its gate).
- The first build also requires load1m <=1.5 x physical cores. Second/third
  builds require load1m <=0.6 x cores, available memory >=24 GiB, spare configured
  capacity and no checkout/repository conflict; unresolved legacy identity blocks
  overlap. A FIFO head load-blocked for 20 minutes may bypass only the new first-
  build/lane-1/2 gates, never legacy/concurrent/lane-3/metrics/ownership/FIFO checks.
- Optional RES_DIR/machine.conf overrides LOAD_LIMIT, LOAD_LIMIT_WITH_LANES,
  MIN_AVAIL_GIB, LANE3_LOAD, LANE3_AVAIL_GIB, LANE_LOAD_PER_CORE,
  LANE_MIN_AVAIL_GIB, BUILD_LOAD_PER_CORE, BUILD_MAX_CONCURRENCY,
  BUILD_CONCURRENT_LOAD_PER_CORE, BUILD_CONCURRENT_MIN_AVAIL_GIB,
  LOAD_OVERRIDE_MINUTES and LOAD_POLL_SECONDS as validated KEY=value data.
  heavy-check prints all active values and defaults/machine.conf source.
  Publish a complete newline-terminated file using temp + rename; never edit
  machine.conf in place. Invalid paths and incomplete/changing reads fail with
  exit 1 before overrides apply. Reads use Python 3. Consult references/res-contract.md for ranges. The controller never creates
  the file; absent configuration keeps the original thresholds.
- macOS available memory = kern.memorystatus_level/100 * hw.memsize. Only an
  explicitly missing sysctl permits (free+inactive+speculative) pages fallback.
  Page headroom and swap are diagnostics; Linux uses MemAvailable. Metrics
  failures stop admission. heavy-check: 0 OK, 5 overloaded, 1 metrics/error;
  prints limit/lanes_held and appends lane3=OPEN|CLOSED, using unrounded gates.
- Install EXIT/INT/TERM/HUP traps BEFORE acquisition. Return in reverse order:
  lane then slot, via return-build --by <unique-run-holder> or normal returns.
  The wrapper also passes --pid $$ on return-build to protect preexisting holds.
  Do not nest wrappers, share a holder across runs, or adopt preexisting holds.
  Signals during pair attempts unwind newly created holds. SIGKILL/crash uses
  STALE recovery. Two mkdirs can be briefly visible during an in-flight attempt;
  there is no backoff or lane wait with a partial hold. A private short-lived
  build-admission lock serializes slot selection; it is not capacity.
- Wrappers MUST exit when their worker dies: traps plus a parent watch. Optional
  heavy-build.sh --watch-pid <worker/follower/agent-shell PID> <command...>
  terminates owned command descendants and returns holds on worker death,
  including during acquisition. The holder remains the wrapper's $$.
- STALE means a recorded local-host PID is proven dead; remote/legacy holds
  are unverified. Only waits auto-reclaim heavy-* at age strictly >600s, with
  lane 3 also requiring OPEN. pid_warning never relaxes that rule. No eviction
  when load/memory changes; return still works when lane 3 is CLOSED.
- Same-task successor after quota exhaustion/crash: verify predecessor's
  project/task/local dead PID, return its STALE lane then slot with
  res return <id> --by <predecessor-holder>, or coordinated --force --note
  "same-task takeover <task-id> from <predecessor>"; then re-take with your own
  unique holder/PID. A matching task alone never permits active/unverified
  return. Never re-take idempotently with the predecessor's PID/start metadata.
- Optional lane 3 missing: unpinned callers wait on lanes 1/2 within the same
  timeout; an explicit missing lane-3 pin errors. A rolled-back controller's
  exact legacy help response selects the wrapper's zero-timeout pair fallback;
  it returns the slot before retry backoff. Other errors still stop admission.
  Old waiters retain old code until their owners re-invoke them; never kill them.

```bash
# Keep this entire invocation in one tool call. The wrapper owns acquisition,
# command lifetime, optional worker watch, and reverse release.
HEAVY_BUILD_BY="<unique-session-task-run>" \
HEAVY_BUILD_PROJECT="<slug>" HEAVY_BUILD_TASK="<task-id>" \
HEAVY_BUILD_TIMEOUT=60 scripts/heavy-build.sh --watch-pid <long-lived-worker-pid> \
  <complete-build-command...>
```

Compile 6 jobs; link 1; Xcode -jobs 6; Gradle 2 workers, Java heap 6 GiB.
Test concurrency 6-8. Keep directories fixed per base and build incrementally;
one cold build before formal acceptance. Ninja -j must be configurable.
Regenerate Pods/headers only for changed inputs; no native rebuild without
native changes. Use sanitized public inputs, no credential/session files or
extra credential-isolation source copies. Close owned children after tests;
never kill another session's processes. Timeout means report/queue, never bypass.
