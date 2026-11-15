# Pure candidate pipeline (Stage 2 modules)

`routePure(taskSpec, snapshot, history = [])` returns an immutable `launch`,
`blocked`, or `defer` plan. It performs no acquisition, filesystem access, clock
lookup, provider call, log write, timer registration, process operation, rotation,
resource admission, or dispatch. `scripts/route.mjs` is unchanged. Nothing in this
directory installs shadow mode or changes a live choice.

```js
import {
  parseTaskSpec, snapshotFromAnalyze, routePure, renderPlan, validatePlan,
} from './pipeline/index.mjs';

// All values below come from the outer, permitted metadata adapter.
const task = parseTaskSpec(argv, {
  taskId, requestId, project, owner, sandboxCeiling, previousAttempts,
});
const snapshot = snapshotFromAnalyze(sanitizedAnalysis, metadata);
const plan = routePure(task, snapshot);
const view = renderPlan(plan);
```

The caller persists a unique request ID before either router runs. Invalid CLI
input throws `TaskInputError` with `code` and `exitCode: 2`, before any state access.
`--table` yields static category metadata and is not a routing task. Approval
references and previous-attempt references never cause reads inside the parser.
An unresolved previous-attempt reference blocks reconstruction. `--user-ok` is
only a reference to independently supplied approval evidence.

## Modules and contracts

| Module | Responsibility |
| --- | --- |
| `taskspec.mjs` | Strict route argv, normalized constraints, derived review tasks, constraint fingerprints. |
| `snapshot.mjs` | Immutable sanitized observations and analyze-output adapter; field diagnostics and UNKNOWN. |
| `candidates.mjs` | Complete catalog × harness/lane × intersected effort product, with unresolved-capacity diagnostics. |
| `filters.mjs` | All 15 named hard predicates, partial retry dominance, exact approval scope and reviewer rules. Results contain `ok`, `pass`, `reason`, `gate`, and `reconsiderAt`. |
| `estimate.mjs` | Existing ETA arithmetic wrapped with provenance, separate costs, uncertainty and patience. |
| `choose.mjs` | Cohort-wide ordering terms; deterministic IDs and comparable-cost policy. |
| `validate.mjs` | Rechecks every seat, company witnesses, scoped approval, arguments, dependencies and plan identity. |
| `plan.mjs` | Three plan shapes and the sole notes/gates/command renderer. |
| `index.mjs` | Enumeration → predicates → complete reviewer sets → estimates/order → final validation. |
| `common.mjs` | Pure value, canonicalization, ID and freezing utilities. |
| `eta-compat.mjs` | Unchanged pure ETA source from the in-flight branch; temporary import boundary. |

`history` contains sanitized **actual Attempt records**, not ETA outcomes. Timing
samples belong in `snapshot.etaHistory`. Requested/planned tuples do not establish
an actual floor. Unknown attestation, missing attempt identity, same-model effort
reduction and incomparable retries block. A failed quality step cannot repeat
unchanged without its own scoped decision. No total cross-family quality order is
introduced; optional relation edges require the pinned version and evidence ID.

The current policy/schema/quality-relation version is `pipeline-v1`. Unknown
snapshot versions produce UNKNOWN facts. Unknown policy versions cannot launch.
Stable fingerprints are replay identifiers over sanitized values, **not**
cryptographic integrity checks or evidence of user authorization. An eventual
launcher must persist and authenticate its own plan/approval/attempt envelope.

## Snapshot input

Supply collection start/end and an injected decision timestamp in epoch
milliseconds. Direct scalar/array facts inherit collection end as their sample
and receipt timestamp. Cached facts must use observation envelopes:

```js
{
  status: 'KNOWN', value: true,
  sampledAt: sampleTimestamp, receivedAt: receiptTimestamp,
  maxAgeMs: 600000, source: 'sanitized-status'
}
```

Missing, malformed, contradictory, stale and future facts become UNKNOWN.
Samples after collection start but at/before collection end are valid. Receipt
before sampling, receipt after collection end, and a collection end after the
decision are invalid. Cache facts use 10 minutes; queue/load/progress use 30
minutes. A supplied shorter lifetime is honored. Bad optional reset cards do not
erase independently valid auth/catalog observations.

The adapter takes `metadata.accounts` containing **all** registered accounts,
`models`, `lanes`, approvals, restrictions, resources, and dependencies. The
legacy analyze result has only singleton TTADK/TRAE slots; metadata must preserve
additional company accounts. Legacy `usable`, `healthy`, `live`, `search` and
`browser` booleans are not sufficient authentication, transport or exact tool
evidence. The adapter never imports or calls `state.mjs`, whose current `analyze()`
can perform I/O and claim probes. Passing only that legacy summary usually blocks
on UNKNOWN rather than guessing capability.

Inject `metadata.analysisSampledAt` to adapt legacy catalogs and daily counters
without freshening them. TTADK `usage` and TRAE `quota.daily` remain timestamped
observations, not admission verdicts. Supply per-account/model
`metadata.laneTelemetry` from the permitted lane collector; the adapter preserves
its original `t` when mapping position, drain and `lastProgressAt`. Explicit
metadata observations take precedence over legacy fields.

Model IDs and known aliases are canonicalized; account and lane IDs remain opaque.
Model efforts and lane efforts are explicit. A provider-assigned lane must be
marked `evidenced: true` if it is not selectable. `mode` is its currently evidenced
provider mode, not an instruction to force priority. An UNKNOWN mode may launch
with uncertain cost/ETA if independent catalog, auth, transport and tools are
known. Missing buckets never establish bucket-free capacity.

Required capabilities must be positive at all three layers: model, account and
harness. Target keys such as `origin:https://example.test`,
`app:com.example.calc` and `device:test-phone` additionally require positive
account/harness evidence. Public browser access does not establish signed-in
browser access. Desktop access and image perception are separate facts.

## In-flight interface assumptions

Read source: `../po-wt-sandbox/scripts/lib/{eta,company-load,model-ladder,worker-reroute}.mjs`
(relative to the sibling worktree, as specified in the brief).

* `eta.mjs` exports `workMinutes(category, tier, history, effort)`,
  `requestsFor(category, tier)`, `laneEta(options)`, `ttadkEta({account,now,workMin})`
  and `patienceMinutes({now,ttadk})`. This worktree lacks that file.
  `eta-compat.mjs` is an unchanged copy, not a second arithmetic implementation.
  After the merge, compare it with `../eta.mjs`, then change only the import in
  `estimate.mjs` and remove the copy after the focused tests pass.
* `workMinutes` expects effort in `actual[0].effort` (or legacy `first`/`pick`).
  The wrapper adapts sanitized ETA history and excludes queue-only/cancelled/infra
  outcomes. Three usable outcomes establish a median. Cross-account/model
  category medians remain fallback-confidence evidence.
* `company-load` model telemetry has `t`, `position`, `drainPerMin`,
  `lastProgressAt`, `itemsPerMin`, `state`; map these to timestamped lane
  observations, especially `progressAt`. `modelLoad` yields `source:
  model|family|account`; preserve it as `loadSource` so direct progress can beat
  coarse sibling congestion. These effectful helpers are never imported here.
* `ttadkExpiringUnused` uses the approved four-hour / below-70%-projected-share
  thresholds from `resource-policy.json`. The wrapper uses injected fresh usage
  and burn observations with those same constants. No quota refresh is performed.
* `normalizeLadder` is legacy ordering, not actual retry authority. The pipeline
  uses actual attempts and pinned partial relations instead of rebuilding a floor
  from a recovered catalog.
* The in-flight rerouter uses depth 0..2, exit codes 7/8/9/10, exact failed
  account/model exclusions and no-work cancellation. It cannot consume these
  plans yet. Lifecycle execution and exit-code mapping remain outside this task.
  Raw rerouter `--exclude-lane` is not in the frozen Stage 2 argv allowlist;
  the outer adapter must translate it into a TaskSpec account-model exclusion.

Decided policy: explicit provider quota denial controls TTADK admission; numeric
dashboard disagreement is diagnostic. TRAE weekly semantics remain UNKNOWN.
Personal, max (except actual TTADK), Fable, reset and scarce-reviewer decisions
use separate finite task/constraint/role/action/tuple scopes. Personal company
bypass must be explicit. Background never uses personal quota. Unknown ETA uses
the existing optimistic completion fallback and bounded patience; it is not a
measured zero start delay. Ordinary light work conserves known zero-priority
capacity; background uses its separate expiring-TTADK-first conservation rule.

## Future shadow integration

1. Validate input before collection. Acquire sanitized metadata once using the
   Stage 1 permitted adapter, pin clock/policy/history and freeze it. Do not invoke
   the live legacy `analyze()` as a second shadow refresh.
2. Give guarded legacy and `routePure` the same request ID and evidence. Keep
   legacy raw output and Stage 1 validation result separately.
3. Record the pure plan and trace externally. Trace includes every tuple,
   predicate result, estimates, ordering terms, unknown inputs and rule version.
   The recorder classifies differences as `legacy-invalid`, `capability-recovery`,
   `company-recovery`, `approval-change`, `retry-floor`, `reviewer-set`, `ETA-choice`,
   `quota-conservation`, `UNKNOWN-input`, or `unexplained`.
4. Logging failure reports a coverage error while preserving the already
   validated legacy decision. Shadow never launches a second worker or changes
   quota/rotation/probe state. Candidate dispatch remains disabled.
5. A future launcher must collect a fresh safe snapshot, call `validatePlan`,
   reconcile attempt identity, and enforce dependency/preaction/acceptance gates.
   Changed evidence requires a new plan; it cannot silently substitute a tuple.

`LaunchPlan.primary.argv` and renderer `command` are a **symbolic guarded-launch
envelope** beginning with `validated-launch`. That executable/argument protocol
is not installed by Stage 2; do not execute it or treat it as current worker argv.
Blocked/deferred plans have no primary argv or command. Deferred plans name an
owner, trigger and optional known reset time; the outer owner must record the
wake, then replan. Future artifact reviews are derived TaskSpecs with acceptance
gates; the outer adapter must add the actual author and pinned artifact after
completion before routing them. They are not quietly launched early.

## Verification and remaining integration boundaries

Run `node scripts/test/pipeline-invariants.mjs`. It is automatically included by
`scripts/test/run-all.mjs`; `PIPELINE_SEEDS` may reduce its 10,000 fixed-seed
snapshot budget for development. The suite uses a separate Cartesian-product
oracle and explicit audit regressions. Failure artifacts contain synthetic
metadata only and are written beneath the operating-system temporary directory.
It also runs 1,000 fixed-seed retry/recovery/content sequences of up to 30
transitions (`PIPELINE_SEQUENCES` controls the development budget), with positive
launch controls to prevent a vacuous all-blocked property pass.

This extraction cannot certify the effectful I12/I14/I18/I19 components:
concurrent restriction writers, RPC cancellation races, nightly notification
delivery, metadata collectors, or forbidden-read prevention in external
adapters. It checks the planner-side contracts (restriction generations,
live-attempt blockers, resource preaction gates and pure imports). Those owning
modules, actual launcher wiring, shadow recorder, seven-day replay and category
promotion remain later-stage work, as required by the brief. No provider, signing,
device or live lock qualification was performed.
