# Dynamic mini capacity

## Mini2

The registry keeps `mini2-exec-1` as the host's legacy alias. The independent
owner migration adds `dynamic-host`; the allocator creates `mini2-exec-N` lease
IDs on demand, with no numbered execution limit. Named takes still pin the
requested ID. The runner uses `wait-pool mini2` and returns its acquired ID.

Native light defaults are 1 core / 1 GiB memory / 8 GiB disk; heavy native and
Xcode defaults are 4 cores / 8 GiB / 16 GiB. `--cores`, `--mem-gib` and
`--disk-gib` declare different measured job costs. Minimum core/memory estimates
are 0.25; these are reservations, not OS resource enforcement. Default load
capacity is measured cores; default reserve is `max(4 GiB, 12% of RAM)`; disk
floor remains 20 GiB. The config accepts `derived` or explicit positive values.
Migration changes only the old explicit load 6 / memory 16 defaults to derived,
and stores exact registry/config backups. Mini2's 10 cores / 32 GiB gives load
capacity 10 and reserve 4 GiB. At idle with sufficient disk, default heavy
concurrency is min(floor(10/4), floor((32-4)/8)) = min(2,3) = 2. Ten default
native light leases can fit, or two default heavy leases plus two light leases.

Admission retains enabled/policy, maintenance, fresh UP link (300 seconds),
matching host, arm64, fresh valid metrics (300 seconds), normal pressure,
fresh tool facts (one hour), approved capabilities, and legacy cleanup gates.
Swap/compressor readings must be finite and nonnegative; memory availability
and normal pressure govern admission rather than new fixed swap limits. The
runner samples on demand before each claim. Raw `res` calls use that fresh
cache; missing, future or stale samples close admission. Waiting does not make
a stale sample admissible; refresh through the runner before retrying.
The acquired lease carries its resolved numeric load/memory/disk thresholds
through prepare, upload and remote launch. A pre-launch rejection cleans owned
scratch only after open-file proof; after execution starts, the existing boot,
process-generation and cleanup-receipt checks remain required.

The shared `dynamic_capacity.py` arithmetic is also used by CN devbox admission.
Each claim atomically writes its full declared cores, memory and disk reservation
in its hold and retains it until return or ownership-proven reclamation. No
measured process memory, CPU, footprint, ancestry or generation receives
reservation credit. Materialized use and declared costs deliberately count twice.
The reference devbox also retains full active reservations; its behavior is
preserved. Admission requires fresh metrics and normal pressure, with:

`available_memory - sum(live_declared_memory) - reserve_floor >= new_memory`

`load_limit - measured_load - sum(live_declared_cores) >= new_cores`

`free_disk - sum(live_declared_disk) - disk_floor >= new_disk`

Pending remote cleanup retains its full reservation and ID as before. Obsolete
usage/baseline fields in existing leases or metrics are ignored, not credited.

FIFO is shared across named and pool claims. A fitting, componentwise smaller
claim may pass a head blocked specifically by CPU, memory or disk at most three
times. The bypass count is persisted in the head's ticket under the host guard.
A fitting head, non-capacity gate or exhausted count prevents bypass. Successful
and timed-out tickets retire inside the same host transaction before publication. Dead
queue controllers lose their place. Publication failure removes the hold and
reservation together. Dead local holders are checked by PID start time. An
unbound dead lease is reclaimed immediately. A dispatched dead lease moves to
its own pending directory and keeps its reservation and ID until a generation
and run-matched cleanup receipt arrives; other work uses remaining capacity.
Machine-wide closure is still necessary for legacy unweighted holds or legacy
cleanup state, whose remote resource cost and ownership cannot be reconstructed,
and for the ordinary link/identity/maintenance/pressure/staleness gates.

Remote mutable paths are `~/mac-build-runner/runs/<run UUID>/{work,home,tmp,
cache,DerivedData,ModuleCache,bin}`. Each run has its own checkout, HOME, TMPDIR,
ccache, Swift/Clang module caches and Xcode DerivedData. The task PATH prepends
an `xcodebuild` wrapper which supplies `-derivedDataPath`, `-jobs` and the module
cache setting; top-level absolute Xcode calls and explicit DerivedData overrides
are rejected. Nested build scripts must use this PATH wrapper and the supplied
cache variables; scripts which deliberately override them are outside the
qualified concurrent command contract. The installed SDKs, compilers, tools and
toolchain setup are shared for reading; no mutable build cache is shared.
Concurrent runs take a shared host execution guard and an exclusive per-run
guard. Legacy runners' exclusive host guard remains effective. Reconciliation
locks only its run and checks all scratch trees for open files before cleanup.

`slot-host` is a JSON object with the existing devbox fields; `devbox-registry`
is a JSON array of slot rows (occupied IDs and a free candidate per host);
`pool-capacity` is a host map with numeric `claims` and string `gate`, plus
additive diagnostics. Mini2 `claims` counts additional default light claims.
`status mini2` displays capacity and closing reason without SSH or mutation.
Rollback restores the exact mini2 registry row and owning config, keeps compatible
code while new leases drain, and resolves their IDs from holds/pending state.
Changes to the target row or owning config cause rollback to refuse an overwrite.

## Main mini local lanes

The independent local migration marks `heavy-build` with `dynamic-local` and
adds `LOCAL_*` settings to machine.conf. Existing numbered rows remain resolver
aliases, and old holders finish through the legacy return commands. New build
claims acquire a build ID and a lane ID together; the wrapper captures
`build-id`/`build-lane`, binds dispatch before starting work, and returns its
own pair by holder plus PID. `wait-lane` defaults to medium; callers select
`--profile heavy|medium|light` or explicit measured weights. Named legacy takes
pin their names and build takes acquire the corresponding pair atomically.
The wrapper starts a FIFO-gated child, binds dispatch, then releases the FIFO.
`--workload-pid` remains accepted for existing wrappers but no longer triggers
credit-related process sampling. Bound, unbound and manual claims all retain
their full declared reservation. Binding still prevents unbound reclamation of
dispatched work; the existing checkout/process ownership proof is unchanged.

| Kind | Default cores | Default memory | Disk |
| --- | --- | --- | --- |
| Full build/link | ceil(physical cores / 4), min 1 | ceil(RAM / 8), min 2 GiB | 16 GiB |
| Compile | ceil(physical cores / 8), min 1 | ceil(RAM / 16), min 2 GiB | 8 GiB |
| Check | 1 | 2 GiB | 2 GiB |

Measured main-mini facts are 14 physical cores and 64 GiB RAM. Defaults are
load capacity 14, memory reserve 7.68 GiB, disk reserve 20 GiB. At idle and with
sufficient disk, default full-build concurrency is
min(floor(14/4), floor((64-7.68)/8)) = min(3,7) = 3. Default light and medium
concurrency is 14 and seven respectively; mixes cannot exceed 14 default claims
because each reserves at least one core. Each admission leaves the configured memory/disk
floors after measured use plus full declared reservations. This is a budget
for honest job estimates, not a process memory limit. The actual available
memory reading can reduce these counts substantially; nominal RAM never
substitutes for that reading.

Local claim attempts sample Mach VM counters, sysctl hardware/pressure and load
on demand without sudo or modifying security software. Prefer the live Darwin
available-memory level; use measured free/inactive pages only when that OID is
unsupported. Normal pressure is mandatory; warn/critical, missing counters,
future/stale metrics (default five seconds), invalid config and the existing
memory guard's HIGH state close admission. There is no last-good-config
fallback for dynamic admission. Swap/compressor diagnostics come from the same
live counters. The main mini remains under memory-panic observation until
2026-11-26; owner smoke uses light no-op work.

Local and mini2 share headroom arithmetic, bounded-bypass predicates and full
lifetime reservations. In the reviewer's timing scenario, availability is
sampled at 24 GiB, then an existing 8 GiB claim materializes during sampling.
Two claims still reserve 16 GiB; a third 8 GiB claim is refused because
24 - 16 - 8 = 0 GiB, below either the main-mini 7.68 GiB or mini2 4 GiB floor.
Shared parents, workload exit/restart and partial materialization never change
declared reservations. Previous root/descendant PID-reuse credit transfers are
structurally impossible: no credit or credit-related ancestry/generation/footprint
sampling remains. Holder-generation and remote ownership checks remain solely
for proven reclamation and cleanup, not budget discounts.
An unbound controlled dead holder is reclaimed; dispatched work is reclaimed
only when the existing checkout/process evidence proves no surviving work.
Uncertain or surviving work keeps its own ID/reservation while other claims
fit. Canonical checkout paths exclude conflicting full builds; caller worktrees
and their build paths remain the source-isolation boundary for local jobs.
Standalone lanes persist the same canonical checkout/process evidence as build
pairs. A dead bound lane is reclaimed only after a zero-process checkout probe;
surviving or uncertain work continues to reserve its declared cost.

Both migrations keep exact full backups but restore only their target registry
row, preserving the other migration and unrelated rows. Mini2 restores its own
config; local restores its own machine.conf additions. They can roll back in
either order while the compatible controller resolves draining IDs. A changed
target row or changed owning config causes refusal rather than overwriting an
owner's later change. The pinned VAK JSON shapes also cover local slot objects,
registry rows and host capacity maps.
Backup files, including the exact `0`/`1` presence marker, are published by
fsynced temporary-file renames. Rollback validates the entire backup set before
restoring anything; missing, invalid or inconsistent metadata refuses changes.
Rollback validates each owning file independently as exactly migrated or
exactly original before writing anything. Retrying any interrupted rollback
finishes the remaining file, including removal of a newly created machine.conf;
completed rollback is idempotent and unrelated registry rows remain untouched.
Configuration is restored before the registry marker, so an interrupted new
rollback cannot enable legacy admission with the derived dynamic thresholds.

Allocator entrypoints hold a pool-specific shared switch guard from selection
through admission/wait; migration takes its exclusive side without waiting.
It also refuses old live waiters, legacy allocator processes and the local
legacy transaction lock, naming their PIDs and requesting stop/restart on the
installed controller. The local and mini2 guards are separate. A new entrant
cannot select legacy mode on one side of a migration and admit on the other.
Interpreter flags, absolute interpreter/script paths, env, shell, node/python
wrappers, sourced wrappers, extra arguments and `--` separators do not hide
named waiters. Allocator-shaped commands that cannot be classified close both
migrations and list their PIDs. Prose arguments are exempt only when ps `comm`
identifies `codex` or `claude`, or `node` with its actual script argument equal
to `codex-worker.mjs` or `route.mjs`; agent names in argv never establish that
exemption. A legacy unweighted hold appearing after either migration closes
dynamic admission machine-wide, including light and named claims, until its
normal return. Other dynamic IDs cannot bypass this backstop.
Normal build/host transaction guards remain in place; switch guards are not
capacity leases and do not serialize concurrent claims against each other.

Resolvers and capacity reports emit strict JSON. Invalid/nonfinite numeric
metrics and invalid or unrepresentable timestamps become null, while admission
still fails closed. `heavy-check` keeps its legacy fields and adds
`dynamic_gate`, reason, additional claim count, reservations and memory floor;
a closed dynamic gate returns 5 even when the legacy display reports OK.

Rejected: numbered extra rows, a second budget formula, whole-host execution
serialization, timestamp-only reservation expiry, and dropping an unconfirmed
remote lease's cost. A full devbox-controller rewrite would mix its Linux I/O
and placement policy with mini2 link/qualification/cleanup policy; the shared
budget arithmetic is reused while the existing mini2 host transaction remains.
