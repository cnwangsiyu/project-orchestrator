# Scheduler Allocation Audit

## Scope And Evidence

Branch: `sched-audit`, rebased onto `23a97082bd169564a6656a55ee0eb72a3a0630e9`
(`origin/main`). Worker tuple: `gpt-6.1-sol`, `high`, `ttadk`.
Digest: `2026-11-18.16`, one added worker clause, within the 61-line budget.
No installation, push, live registry/config edit, device operation or login-material access.
Runner tests use a task-private cache and the public scheduler. They create and
return their own remote leases, not mini build/lane locks.

Primary snapshot: November 18, 2026, 19:14:00 PST
(`2026-11-19T03:14:00.283Z`), trailing 24 hours. Task-local source:
`/Users/bytedance/.claude/jobs/9850afbb/tmp/task-sched-audit/audit.json`.
Only aggregate scheduler metadata and named acceptance evidence are reported;
there was no directory-wide task/build-log search. Downloaded test logs were
masked before reading. Counts below use this frozen
snapshot, not later acceptance-test activity. Starts are not CPU utilization;
short jobs and retries can inflate take shares.

| Host | Cores | Baseline / Dynamic / Never Heavy | Light Open | Heavy / Light Starts | Take Share / Core Share | Fresh Free GiB |
| --- | ---: | --- | ---: | --- | --- | ---: |
| CN1 `10.37.121.175` | 8 | 2 / 2 / 0 | 1 | 107 / 58 | 9.1% / 4.0% | 245.4 |
| CN6 `10.199.23.45` | 64 | 7 / 0 / 1 | 1 | 399 / 202 | 33.2% / 32.0% | 61.3 |
| CN7 `10.199.23.46` | 64 | 7 / 6 / 0 | 1 | 455 / 120 | 31.8% / 32.0% | 75.7 |
| CN8 `10.37.251.219` | 64 | 10 / 14 / 0 | 1 | 433 / 35 | 25.9% / 32.0% | 483.4 |

All four cached hardware probes were stale under the new hourly TTL: 23.6 to
27.9 hours old. Fresh admission metrics supplied the cores/free-disk values.
CN8's old probe said 271 GiB free. Journal replay through the snapshot found
peak aggregate heavy/light holds CN1=3, CN6=8, CN7=14, CN8=23; maximum sampled
load5 CN1=6.49, CN6=16.19, CN7=30.19, CN8=45.83. Reconstructed holds depend on
the retained journal and are not continuous CPU measurements.

## Findings And Disposition

| Finding | Evidence | Disposition |
| --- | --- | --- |
| Expired hardware became an invented eight-core host | Previous `capacity()` discarded probes after 24 hours and used `fallback.get(box, 8)`; all four cached probes aged past the new hourly TTL | Fixed: fresh metrics, fresh probe, core tag, labelled stale probe, then explicit unknown; stale disk is never reused |
| Slot-count ranking hid absolute CPU headroom | Previous `(held+1)/cores` could prefer an idle eight-core box over a lightly occupied 64-core box | Fixed: `cores - max(load5, recent reserved CPU) - task CPU`; memory, disk and ID break ties; fresh-metric ranking is configurable |
| Last-used affinity overrode headroom and unrelated caller names collided | Old host/slot terms preceded utilization until `nextScore > 0.5`; seven unscoped legacy keys existed on large hosts | Fixed: project/repository/ref-scoped keys, matching workspace receipt, controller ref-family filter, invalid-marker exclusion; affinity needs at least 50% of best admitted compatible spare in the same prefer tier |
| Missing worktree could still be warm to the controller | Runner and controller independently read the affinity cache | Fixed: invalidate the matching cached marker under lock before acquisition; do not overwrite a newer concurrent marker |
| Host/root probe never refreshed | Previous runner probed only missing/invalid cache entries; CN8 disk observation was obsolete | Fixed: hourly refresh, ten-second cached-root probe, one-minute failure backoff, retain old hardware/root and old age on failure |
| CN1 exporter preference biased generic work | Owner already removed `prefer=docker-exporter` and added `cores=` tags; CN1 still received 9.1% of starts for 4% of cores | Owner fix retained; no repeat live edit. New ranking is robust after probe expiry. Take share alone does not prove idle peers |
| CN6/CN7 slot envelopes can cap CPU below gate capacity | CN6 has seven baseline heavy rows and no dynamic rows; CN7 has 13; peak holds 8/14 while sampled load5 peaks 16.19/30.19 | Conditional registry proposals below, not an immediate admission increase |
| Disk is a demonstrated large-host bottleneck | CN6 recorded 578 disk denials, CN7 63; snapshot free disk only 61.3/75.7 GiB with a 53-GiB floor | Reported; cleanup and measured budgets precede extra slots. Never weaken the disk floor to hide this |
| Exporter/light capability coverage favors the small box | Open exporter rows CN1=5, CN6=2, CN7=2, CN8=0; each large box has only one light row | Conditional capability and light-row proposals below; verify actual tools first |
| Temporary disk costs are below defaults | Live heavy/light/vesdk overrides are 4/1/20 GiB versus code defaults 20/2/50 | Reported and conditional config restoration proposed. Raising reservations immediately on nearly full disks would worsen queueing |
| FIFO rare-cap blocking was suspected | `fifo_allows()` matches older waiters against eligible surplus; pool-surplus/identity/fairness/exclusion fixtures retain younger disjoint-cap progress | No pool FIFO defect reproduced. Direct maintenance takes intentionally wait behind pool waiters; report maintenance head-of-line debt, do not bypass arbitration |
| Mini lane 3 / second build supposedly never open | Snapshot starts: lane1=59, lane2=34, lane3=2, heavy-build=105, heavy-build-2=1 | Disproved literally. Sparse use remains a workload/gate question; no threshold weakening. Owner should reconcile live `LANE3_LOAD=10` with contract/default 8 |
| Router might leave a qualified free company lane unused | `pipeline/candidates.mjs` enumerates every account/model/lane/effort; `choose.mjs` selects observed-ready company cohorts before delayed fallbacks | No allocation defect reproduced in inspected selection logic; unrelated routing scenario failures are listed in acceptance evidence |
| Open rows might never be used | `res audit` found no unused open row in the trailing window or retained whole journal | No such defect in this snapshot |

The gate stays conservative: `load5 + reserved CPU + task CPU <= cores * limit`.
Ranking uses `max(load5, reserved CPU)` to avoid double-counting already reflected
starts, but does not relax admission. Reservations reflect configured cost
(observed costs were 1 or 3 cores), not measured per-command demand. A job using
30 threads does not acquire a magically measured 30-core reservation; actual
load and the runner CPU budget remain important safety constraints.
`prefer=` semantics are identical for heavy/light ranking: matching tier -1,
untagged tier 0, unrelated tagged tier 1. Unrelated tagged rows remain usable
when higher tiers are held or admission-closed. Explicit `--warm-cost` continues
to minimize wait plus rebuild cost, including receipt-verified legacy migration.
Repository identity retains the established contract: an explicit project name
selects one stable repository/store identity across linked worktrees and
source-only exports. Do not reuse a project name for unrelated repositories.
Without an explicit project, the normal origin/common-directory identity applies.

Code anchors: [capacity and audit](../scripts/res/res),
[runner probe and receipt-scoped affinity](../scripts/devbox-run.mjs),
[warm-input migration](../scripts/lib/devbox-inputs.mjs),
[pipeline enumeration](../scripts/lib/pipeline/candidates.mjs) and
[ready company selection](../scripts/lib/pipeline/choose.mjs).

## Exact Owner Proposals

These are proposals only. Recheck IDs against the current registry, hold
ownership, tool capability and disk budgets at application time. Preserve the
owner's existing CN1 `prefer=gpu`, core tags, and CN8 VESDK preferences.
Do not reuse retired/setup resources or force another task's lease.

1. Pin the optional ranking switch by adding `DEVBOX_RANK_BY_SPARE=1` to
   `machine.conf`; absence already means 1. `0` is the immediate ranking rollback.
2. After owner-authorized cleanup and a passing CN6 smoke check, replace only
   row `devbox-cn-28` with the following five columns (literal tabs, represented
   here as `\t`):

```text
devbox-cn-28\tremote\topen\t-\tCN devbox 6 tiger@10.199.23.45 heavy slot; owner-verified after cleanup; NOT a mini resource caps=vak,chromium,docker,vak-android,node dynamic-only cores=64
```

3. If measured CPU and disk demand still leave usable capacity at slot-full,
   append the following exact row templates with `N` expanded over the listed
   IDs. At audit time all proposed IDs were absent. These are maximum CPU-side
   envelopes, not a promise that the conservative gate or disk will admit 21 jobs.
   Stage additions incrementally and observe each batch; every new row is dynamic-only.

```text
# N = 66,67,68,69,70,71,72,73,74,75,76,77,78 (CN6: 7 baseline + 14 dynamic = 21)
devbox-cn-N\tremote\topen\t-\tCN devbox 6 tiger@10.199.23.45 heavy slot; owner-verified expansion; NOT a mini resource caps=vak,chromium,docker,vak-android,node dynamic-only cores=64
# N = 79,80,81,82,83,84,85,86 (CN7: 7 baseline + 14 dynamic = 21)
devbox-cn-N\tremote\topen\t-\tCN devbox 7 tiger@10.199.23.46 heavy slot; owner-verified expansion; NOT a mini resource caps=vak,chromium,docker,vak-android,node dynamic-only cores=64
```

4. After one additional quick-check workspace fits the measured disk budget,
   add these light rows, one host at a time:

```text
devbox-cn-light-9\tremote\topen\t-\tCN devbox 6 tiger@10.199.23.45 quick-check slot; NOT a mini resource caps=vak,chromium,docker,vak-android,node dynamic-only cores=64
devbox-cn-light-10\tremote\topen\t-\tCN devbox 7 tiger@10.199.23.46 quick-check slot; NOT a mini resource caps=vak,chromium,docker,vak-android,node dynamic-only cores=64
devbox-cn-light-11\tremote\topen\t-\tCN devbox 8 wangsiyu.chris@10.37.251.219 quick-check slot; NOT a mini resource caps=vak,chromium,docker,vesdk-android,node dynamic-only cores=64
```

5. Only after the same exporter venv/image/tool smoke passes on the named host,
   change the caps token on rows `devbox-cn-23`, `devbox-cn-24`, `devbox-cn-31`,
   `devbox-cn-32`, `devbox-cn-light-6`, `devbox-cn-light-7` from
   `caps=vak,chromium,docker,vak-android,node` to
   `caps=vak,chromium,docker,docker-exporter,vak-android,node`.
   Leave every other column/tag intact. This provides four heavy plus one light
   exporter row per large exporter host. Do not claim CN8 exporter capability
   without installing/verifying it through a separate authorized task.
6. After cleanup, measure peak new-workspace bytes for node, exporter and VESDK
   jobs before restoring defaults. Without evidence supporting smaller costs,
   propose these exact `machine.conf` replacements:

```text
DEVBOX_HEAVY_DISK_GIB=20
DEVBOX_LIGHT_DISK_GIB=2
DEVBOX_HEAVY_DISK_GIB.project.vesdk=50
```

The current respective values are 4, 1, 20. Retain smaller values only with an
owner-recorded measured budget and keep the 53-GiB free floor. Missing initial
facts and stale-metric dynamic rows remain closed. Do not deploy extra rows and
disk changes as an unobserved combined experiment.
For mini safety, propose `LANE3_LOAD=8` instead of current 10 unless the owner
identifies an explicit reviewed override; this is contract alignment, not an
allocation-speed fix. All other mini thresholds remain unchanged.

## Rollout And Rollback

Owner-only, after acceptance disposition and in a durable checkout. The task
worktree must not become the installed symlink target. No command here was run
against live state.

1. Integrate the audited branch using the owner's normal merge process, keep
   all current main policy changes, and verify `git diff --check`,
   `bash -n scripts/res/res`, `node --check scripts/devbox-run.mjs` and
   `node --check scripts/lib/devbox-inputs.mjs`.
2. Replay acceptance with the exact commands in the test section. Resolve or
   explicitly disposition unrelated baseline scenario failures before the
   installer, which runs `scripts/test/run-all.mjs` and will refuse failures.
   Do not bypass that installer check or run full Linux acceptance on the mini.
3. Coordinate res waiters/holds with their owners, run the required read-only
   health probe `node scripts/resource-sample.mjs --read-only --json`, and
   require a complete host/process sample. Capture the old installed res target,
   registry, machine config and affected source revision through the owner's
   existing install backup procedure. No credential/session directories belong
   in that backup.
4. From the durable checkout run `bash scripts/res/install.sh` without `--force`.
   Retain its printed backup path and exact rollback command. Publish digest
   `2026-11-18.16` and have active callers re-invoke their waiters. Runner/input
   changes travel through the same integrated source revision; no separate
   affinity-cache migration or live cache deletion is needed.
5. Before registry expansion, record `res audit --json`. Run ordinary short
   node heavy/light fixtures through `devbox-run` and check the returned lease,
   `cores_source`, fresh facts and receipt-scoped affinity. Sample
   `res audit --json` plus normal resource metrics every five minutes for one
   hour, compare similar jobs' wait/run times, disk denials, stale facts and
   admission failures. Starts/core share alone is not the acceptance metric.

Rollback triggers: a new placement/capability/FIFO regression, a lease not
returned, gate relaxation, failed probe presented as fresh, or greater wait
with unused admitted compatible capacity in repeated comparable samples.
First atomically set `DEVBOX_RANK_BY_SPARE=0` through the owner's config
publication procedure, preserving other keys, and re-invoke waiters. This
retains probe/audit fixes but restores slot-count selection. If the broader
change must roll back, coordinate quiescence and execute the installer's exact
printed rollback: restore its registry backup atomically BEFORE its res-code
backup. Restore only this task's runner/input changes to the recorded prior
source revision, retaining the owner's later policy work. For optional new
rows, mark just those proposed rows `never` after their holders return; never
delete an active lock. Restore only changed config keys from the owner's
recorded pre-change values. Do not restore a whole old config over newer work.

Exact source-only runner/input rollback preparation, from the durable checkout:

```sh
BASE=23a97082bd169564a6656a55ee0eb72a3a0630e9
AUDITED=c3ba4a16b92e16658a4754c6fda147e59dd97029
git diff "$BASE" "$AUDITED" -- scripts/devbox-run.mjs scripts/lib/devbox-inputs.mjs > runner-rollback.patch
git apply --reverse --check runner-rollback.patch
```

Only if that check succeeds and those files contain no newer owner changes,
the owner may run `git apply --reverse runner-rollback.patch`, followed by
`node --check scripts/devbox-run.mjs` and
`node --check scripts/lib/devbox-inputs.mjs`. Otherwise resolve the overlapping
change explicitly; never overwrite the files with a whole older revision.
The res-controller rollback remains the installer's printed registry-first
command, not this source patch.

## Acceptance Evidence

`DEVBOX_RANK_BY_SPARE` stays default-on because all 18 registered res suites
passed. The brief's count of 16 was outdated: there were 17 registered suites
before this task and the new ranking suite makes 18. The final res replay used
`c6cdb35`/`bb7e010`, which contain all production scheduler changes; subsequent
changes only removed a digest blank line. The affected rules and concurrent
receipt scenarios were confirmed on `c3ba4a1`.

Remote invocation used the brief's bounded GUI wrapper around a script that
runs `node scripts/devbox-run.mjs --project orchestrator --task sched-audit
--repo "$PWD" --ref HEAD --need node --timeout 25 --artifact
'reports/scheduler-audit-*.json' --out "$TASK/remote-ID" -- "$COMMAND"`.
The task-private `DEVBOX_CACHE_DIR` was `$TASK/runner-cache`.
Expected artifacts are the runner `summary.json` and `shard-1-attempt-1.tar`
containing named JSON test receipts. Individual receipt rows, not a shell's
final exit status, are the authority when multiple commands share a wrapper.

Exact replay commands, each in a separate bounded remote script:

```sh
node scripts/test/scheduler-audit-suites.mjs res 0 1 2 3 4 5
node scripts/test/scheduler-audit-suites.mjs res 6 7 8 9 10 11
node scripts/test/scheduler-audit-suites.mjs res 12 13 14 15
node scripts/test/scheduler-audit-suites.mjs devbox 0
node scripts/test/scheduler-audit-suites.mjs devbox 1 4 5 6 7 8 9 10 11
node scripts/test/scheduler-audit-suites.mjs devbox 15 2 3 12 13 14
node scripts/test/scheduler-audit-suites.mjs devbox 6
node scripts/test/scheduler-audit-suites.mjs scenarios 0 1 2 3 4 5 6 8 10 11 17 25 26 37 48
node scripts/test/scheduler-audit-suites.mjs scenarios 12 13 15 16 17 18 19 20
node scripts/test/scheduler-audit-suites.mjs scenarios 21 22 23 24 25 26 27
node scripts/test/scheduler-audit-suites.mjs scenarios 9 14 36 28 29 31 32 33 34 35
node scripts/test/scheduler-audit-suites.mjs scenarios 30
node scripts/test/scheduler-audit-suites.mjs scenarios 37 38 39 40 41 42 43 44
node scripts/test/scheduler-audit-suites.mjs scenarios 45 46 47 48
node scripts/test/scheduler-audit-suites.mjs scenarios 9 14 36
node scripts/test/scheduler-probe-scenarios.mjs
```

The two macOS-only suites were run locally against isolated fixtures:

```sh
RES_TEST_SUITE=config-reload.mjs node scripts/res/test/run.mjs
RES_TEST_SUITE=mini-build.mjs node scripts/res/test/run.mjs
```

For baseline reproduction the same runner used `--ref origin/main` pinned to
`23a9708`. It ran `node scripts/test/NAME-scenarios.mjs` for each failing name
listed below, with a 180-second child watchdog, masking each named `.log` before
reading and writing `reports/scheduler-audit-baseline.json` or
`reports/scheduler-audit-baseline2.json`. Source scheduler files were unchanged
in those baseline snapshots. Both baseline wrappers completed and returned their
leases; wrapper success does not mean the enclosed failing tests passed.

All failing worker scenarios remain reported, not repaired outside this task's
scope. In particular, the full installer/run-all is not claimed green.


### Res Suites

All 18 suites passed: 2,947 assertions.

| Suite | Assertions | Execution | Receipt Batch |
| --- | ---: | --- | --- |
| `build.mjs` | 570 | PASS, CN devbox | `final-c` |
| `config-reload.mjs` | 30 | PASS, macOS local | `local-final` |
| `devbox-admission.mjs` | 175 | PASS, CN devbox | `final-b` |
| `fairness.mjs` | 80 | PASS, CN devbox | `final-a` |
| `followups.mjs` | 182 | PASS, CN devbox | `final-c` |
| `lane3.mjs` | 256 | PASS, CN devbox | `final-a` |
| `lanes.mjs` | 267 | PASS, CN devbox | `final-a` |
| `mini-build.mjs` | 83 | PASS, macOS local | `local-final` |
| `pool-exclusions.mjs` | 17 | PASS, CN devbox | `final-b` |
| `pool-exec.mjs` | 67 | PASS, CN devbox | `final-b` |
| `pool-identity.mjs` | 34 | PASS, CN devbox | `final-b` |
| `pool-surplus.mjs` | 27 | PASS, CN devbox | `final-b` |
| `pools.mjs` | 405 | PASS, CN devbox | `final-b` |
| `scheduler-ranking.mjs` | 81 | PASS, CN devbox | `final-c` |
| `stale-holds.mjs` | 16 | PASS, CN devbox | `final-c` |
| `t88/legacy/test-res.sh` | 169 | PASS, CN devbox | `final-a` |
| `t88/memory/test-res.sh` | 101 | PASS, CN devbox | `final-a` |
| `t88/test-res.sh` | 387 | PASS, CN devbox | `final-a` |

### Worker Scenarios

All 49 required scenario files were exercised: 41 passed, 8 failed. Every failure also failed on main `23a9708`.

| Scenario File | Result | Receipt Batch | Main Baseline |
| --- | --- | --- | --- |
| `astra-telemetry-scenarios.mjs` | PASS | `initial-confirm` | Not needed |
| `auto-outcome-scenarios.mjs` | PASS | `initial-confirm` | Not needed |
| `balance-replay-scenarios.mjs` | PASS | `initial-confirm` | Not needed |
| `board-contention-scenarios.mjs` | PASS | `initial-confirm` | Not needed |
| `browser-preflight-scenarios.mjs` | PASS | `initial-confirm` | Not needed |
| `company-read-scenarios.mjs` | PASS | `initial-confirm` | Not needed |
| `company-telemetry-scenarios.mjs` | FAIL | `initial-confirm` | FAIL, reproduced |
| `devbox-run-scenarios.mjs` | PASS | `16 devbox slices` | Not needed |
| `devbox-transfer-check-scenarios.mjs` | PASS | `initial-confirm` | Not needed |
| `global-rules-scenarios.mjs` | PASS | `rules-confirm` | Not needed |
| `hub-launchd-scenarios.mjs` | FAIL | `initial-confirm` | FAIL, reproduced |
| `lean-route-scenarios.mjs` | FAIL | `initial-confirm` | FAIL, reproduced |
| `live-routing-scenarios.mjs` | PASS | `scenarios-c2` | Not needed |
| `live-turn-status-scenarios.mjs` | PASS | `scenarios-c2` | Not needed |
| `monitor-tail-scenarios.mjs` | PASS | `rules-confirm` | Not needed |
| `nightly-audit-scenarios.mjs` | PASS | `scenarios-c2` | Not needed |
| `nightly-metrics-scenarios.mjs` | PASS | `scenarios-c2` | Not needed |
| `nightly-review-scenarios.mjs` | FAIL | `initial-confirm` | FAIL, reproduced |
| `oneshot-visibility-scenarios.mjs` | PASS | `scenarios-c2` | Not needed |
| `orch-usage-scenarios.mjs` | PASS | `scenarios-c2` | Not needed |
| `outcome-scenarios.mjs` | PASS | `scenarios-c2` | Not needed |
| `personal-fallback-scenarios.mjs` | PASS | `scenarios-d` | Not needed |
| `policy-block-scenarios.mjs` | PASS | `scenarios-d` | Not needed |
| `queue-stall-watch-scenarios.mjs` | PASS | `scenarios-d` | Not needed |
| `quota-monitor-scenarios.mjs` | PASS | `scenarios-d` | Not needed |
| `reroute-scenarios.mjs` | FAIL | `initial-confirm` | FAIL, reproduced |
| `resource-nightly-scenarios.mjs` | FAIL | `initial-confirm` | FAIL, reproduced |
| `resource-scenarios.mjs` | PASS | `scenarios-d` | Not needed |
| `review-data-scenarios.mjs` | PASS | `final-rules` | Not needed |
| `review-policy-scenarios.mjs` | PASS | `final-rules` | Not needed |
| `route-scenarios.mjs` | PASS | `route-only` | Not needed |
| `router-tail-scenarios.mjs` | PASS | `final-rules` | Not needed |
| `rules-auto-scenarios.mjs` | PASS | `final-rules` | Not needed |
| `rules-enforcement-scenarios.mjs` | PASS | `final-rules` | Not needed |
| `rules-hook-deadline-scenarios.mjs` | PASS | `final-rules` | Not needed |
| `shared-state-scenarios.mjs` | PASS | `final-rules` | Not needed |
| `signing-allowlist-scenarios.mjs` | PASS | `rules-confirm` | Not needed |
| `skill-autoupdate-scenarios.mjs` | FAIL | `initial-confirm` | FAIL, reproduced |
| `symlink-path-scenarios.mjs` | PASS | `scenarios-f` | Not needed |
| `task-board-scenarios.mjs` | PASS | `scenarios-f` | Not needed |
| `trae-browser-scenarios.mjs` | PASS | `scenarios-f` | Not needed |
| `worker-ask-delivery-scenarios.mjs` | PASS | `scenarios-f` | Not needed |
| `worker-guards-scenarios.mjs` | PASS | `scenarios-f` | Not needed |
| `worker-inbox-fix-scenarios.mjs` | PASS | `scenarios-f` | Not needed |
| `worker-inbox-scenarios.mjs` | PASS | `scenarios-f` | Not needed |
| `worker-redaction-scenarios.mjs` | PASS | `scenarios-g` | Not needed |
| `worker-rules-push-scenarios.mjs` | PASS | `scenarios-g` | Not needed |
| `worker-talkback-relay-scenarios.mjs` | PASS | `scenarios-g` | Not needed |
| `worker-talkback-scenarios.mjs` | FAIL | `initial-confirm` | FAIL, reproduced |

### Failure Details

| Scenario | Observed Failure |
| --- | --- |
| `company-telemetry-scenarios.mjs` | Line 190: queue telemetry expected `[1000,900]`, received `[]`; fixture reuses terminal thread/turn state. |
| `hub-launchd-scenarios.mjs` | Line 133: PID still exists immediately after escalation; Linux process/reaping observation. |
| `lean-route-scenarios.mjs` | Line 45: verbose argv retains `--verbose`, violating the fixture's exact nonverbose-argv comparison. |
| `nightly-review-scenarios.mjs` | Line 193: spawned status null, `/bin/zsh` absent on both tested Linux hosts (baseline recorded absence). |
| `reroute-scenarios.mjs` | Line 237: fixture cleanup `ENOTEMPTY`, consistent with a child cleanup race; no scheduler production code changed. |
| `resource-nightly-scenarios.mjs` | Line 44: spawned status null, `/bin/zsh` absent on tested Linux hosts. |
| `skill-autoupdate-scenarios.mjs` | Line 148: slow fixture omits `scripts/resource-policy.json`, which its copied module imports. |
| `worker-talkback-scenarios.mjs` | Line 90: terminal-worker `SKIPPED` line precedes the note and breaks the exact-output regex. |

These are observed baseline failures, not authorization to alter unrelated worker,
routing or nightly behavior. The suspected telemetry/reaping/cleanup causes have
not been repaired in this task; reproducing the failure is stronger evidence than
assuming the cause. The missing-shell cases cannot exercise their shell payload.

### Devbox And Probe Coverage

All 16 devbox slices passed, covering the full default scenario program:

`baseline`, `dead-slot`, `inputs`, `hygiene`, `credentials`, `packed-module`, `receipt`, `res-progress`, `cpu`, `auto`, `units`, `prewarm`, `metrics`, `placement`, `ssh-drop`, `affinity`.

The `baseline` slice includes bundle recovery, stop ownership, root/shell probes,
sharding, history/source gates, GC, cancellation/timeout and cleanup cases. The
new affinity slice includes missing-receipt invalidation before controller access
and ref-family propagation. The receipt slice uses a bounded two-shard rendezvous
rather than assuming tiny commands remain simultaneous. The standalone scheduler
probe scenario also passed.

An earlier combined worker slice exceeded the GUI watchdog and retained its
own remote lease pending confirmation. The run-id-bound stop command confirmed
cleanup and returned `devbox-cn-21`; its remaining scenarios were re-run in
bounded slices, including a passing standalone full route scenario. Final shared
lease inspection found no `sched-audit` holds. No foreign process or hold was killed.

Aggregated named receipts are retained task-locally as
`/Users/bytedance/.claude/jobs/9850afbb/tmp/task-sched-audit/acceptance-results.json`.
Original per-batch JSON receipts remain inside their named runner artifact tars.
Syntax checks and `git diff --check` passed. The installed tool and live
registry/config were not changed.

