# Router pipeline

`scripts/route.mjs` is the sole CLI router. It strictly parses input, reads public
status observations and task metadata through `lib/route-data.mjs`, calls
`routePure(taskSpec, snapshot)`, renders compatible worker commands, and logs the
result. There is no legacy selector, shadow mode or staged category switch.

The pipeline enumerates every declared account/model/lane/effort tuple, applies
named admission predicates, estimates completion using `lib/eta.mjs`, ranks
qualified candidates, constructs required reviewer seats, and validates the
whole plan. `policy.mjs` owns category qualification and preferences;
`review-policy.mjs` owns review rounds, optional review budget and project profiles.

The pure API returns an immutable LaunchPlan, BlockedPlan or DeferPlan. All time
comes from the snapshot. `ROUTE_NOW` and `ROUTE_REQUEST_ID` support reproducible
CLI fixtures; `ROUTE_SNAPSHOT_FILE` injects sanitized snapshot metadata. Cache
facts have a ten-minute TTL; TRAE quota and lane telemetry have a thirty-minute
TTL. Malformed, stale and future evidence becomes UNKNOWN. Explicitly absent desktop tools or vision block a launch. Browser-ready TTADK
and ChatGPT provide the desktop runtime; TRAE and Claude do not.

Fresh positive queue position with zero drain, or a fresh waiting state without
progress, is STALLED with no finite ETA. Runnable lanes rank first, including
when background quota preference would otherwise favor the stalled lane. If the
only qualified lane/reviewer set is stalled, defer until progress and replan.
Missing/stale telemetry remains UNKNOWN and uses the bounded optimistic fallback.

Company capacity is preferred; no runnable company work waits for a future reset.
If no company lane can start, needsUserOK/tellUser ask whether to use personal
quota now or wait until the named reset/progress trigger. `--urgent --user-ok
<reference>` records the user's answer and permits the personal command. Image
generation and Claude-only tools retain standing permission. Max effort outside
TTADK, Fable and reset redemption keep their separate decisions. Blocked
proposals contain no executable commands; gated second reviewers do not stop
an eligible company primary, and remain required before acceptance.

`--actual vendor:model:effort@account` supplies sanitized actual attempt evidence.
Fallback lookup uses task-owned launch/reroute records by name/project, then the
last named route decision. With no records, assume the category's first rung and
say so in why. Known actual floors and contradictions remain authoritative.
Automatic no-work reroutes retain cancellation receipts, owner and lane exclusions.

Browser order is TTADK, TRAE Playwright Extension, browser-ready personal ChatGPT
(ask), then Claude in Chrome (ask). Desktop order is TTADK then browser-ready
personal ChatGPT (ask); no TRAE or Claude desktop path. Capability intersection
and target scopes remain mandatory. Optional review budget excess adds
"over review budget — prefer accepting on tests" and never blocks dispatch.

`renderPlan(plan, context)` produces the established pick/secondOpinion,
needsUserOK/tellUser/why/notes, ETA, defer and queue fields, including tracked
launches and owner-scoped worker watches. `renderPlan(plan)` exposes the pure
plan envelope for validation tests. Preaction resource gates and post-write
acceptance reviews remain obligations of the owning orchestrator.

The acquisition adapter refreshes stale/missing/negative account status through
normal authenticated read-only commands. Successful hub usage is transport
evidence even if a large thread-list read times out. Account observations keep
individual timestamps; quota and telemetry keep their own timestamps. Frozen
ROUTE_NOW/snapshot fixtures perform no live acquisition. The adapter never opens
credentials, exports TTADK tokens, starts hubs, clears restrictions or claims
probes. --signing selects an ordinary full-access Codex company worker for
registered own-test packages; workers check the existing package registry and
identity allowlist at action time. Routing never reads signing material.

Run `node scripts/test/pipeline-invariants.mjs` for fixed audit cases, real CLI
checks, 10,000 generated snapshots and 1,000 transition sequences. Development
budgets are `PIPELINE_SEEDS` and `PIPELINE_SEQUENCES`. The suite is auto-discovered
by `node scripts/test/run-all.mjs`.
