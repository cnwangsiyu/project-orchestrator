# Third Heavy Lane Request

Owner: **vesdk-mainline orchestrator**, shared `~/.claude/orchestrator/_shared/res`, currently contract v1.2.
Approval: user approved all four utilisation measures on **2026-11-13**. This request does not edit/install `res`,
change the ONE package slot, or authorize any worker to bypass the existing gate.

## Exact Gate

Keep two normal lanes, `heavy-lane-1` and `heavy-lane-2`, with the v1.2 caller-aware gate unchanged:
`load1m <= min(20, 12 + 8 * lanes_held_by_others) && availableBytes >= 16 * 2**30`.
STALE and verified caller-owned locks do not count. Use the existing authoritative memory source/fallback contract.

Provision optional `heavy-lane-3`. At **every take/wait acquisition attempt**, admit it only if both readings are
known and finite and **`load1m <= 8 && availableBytes >= 32 * 2**30`**. These are inclusive exact comparisons,
not rounded display comparisons. Do not add a waiter-age condition: the final approved brief removed that clause.
Missing/denied metrics are UNKNOWN and cannot admit it. Gate + atomic acquisition must retain existing race handling.
An occupied lane remains exclusive. Once taken it is held/released like any lane; a later load/memory change must
not revoke it, signal its holder, or end its work. Normal lanes stay usable under v1.2 even when lane 3 is gated off.
Capacity is normally two and may float to three; full-package work still takes `heavy-build` before a lane and
returns lane then build, with finite wait timeouts, long-lived wrapper PID and EXIT cleanup on every path.

## Status And Observation

- Register lane 3 in `resources.tsv` as the same slot kind as other lanes. Keep existing status columns and emit a
  `heavy-lane-3 slot ... FREE` / holder / STALE row, PID/host/start info, and take/return/reclaim journal rows.
- A FREE status is not gate permission. Add a separate lane-3 gate diagnostic with exact admission verdict and
  displayed `load1m`, `limit=8`, `avail`, `memory_gate=32GiB`, and `gate=OK|OVERLOADED|UNKNOWN` (a distinct
  `lane3-gate` prefix, not an ambiguous `heavy-lane-3 slot` status row).
- Keep generic `heavy-check` v1.2 output backward compatible. Its `lanes_held` counts the third lane when present,
  excluding STALE/verified caller-owned holds; limit stays capped at 20. Lane-3 attempts need the specific stricter
  check, not the generic gate's OK. Use current success/overload/unknown codes consistently and document them.
- The sampler/review in this request already recognize optional lane-3 registry/status/lease/wait/journal records.
  They do not require lane 3 on a v1.2 installation, claim rollout, or recompute rounded controller verdicts.
  Normal-gate tuning excludes third-lane-only contexts. Occupancy reports provisioned lane-time, not gate availability.

## Required Owner Tests

1. Exact load 8 / memory 32 GiB admits; load 8+epsilon or memory 32 GiB-epsilon refuses; missing, denied,
   non-finite, malformed metrics refuse. Rounded display boundaries retain authoritative verdicts.
2. Two normal lanes busy plus lane-3 gate OK allows one third holder; simultaneous contenders admit at most one.
   With the lane-3 gate closed, normal lanes still follow v1.2. Fourth holder cannot acquire any lane.
3. Repeated waits recheck the lane-3 gate at actual acquisition, not once before waiting. Finite timeout reports/
   queues without bypass and releases only owned/acquired holds, including a build hold if no lane was acquired.
4. FREE/HELD/STALE and metadata/journal/PID output include lane 3; stale reclaim follows existing >600s rules.
   Return/EXIT cleanup, holder death, reverse release and race tests cover lane 3 without killing foreign work.
5. Generic v1.2 gate counts occupied lane 3, excludes STALE/own verified holds and stays capped at 20. An already
   held lane 3 is not revoked when load/memory crosses its take-time gate. Old two-lane installations still work.

Owner returns the implemented contract version, actual status/check examples, all test results and rollout/acknowledgement.
Until that response, workers use only lanes the owner has actually provisioned and implemented.
