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
capacity 10 and reserve 4 GiB: ten default native light leases can fit at idle
with sufficient disk, or two default heavy leases plus two light leases.

Admission retains enabled/policy, maintenance, fresh UP link (300 seconds),
matching host, arm64, fresh valid metrics (300 seconds), normal pressure,
fresh tool facts (one hour), approved capabilities, and legacy cleanup gates.
Swap/compressor readings must be finite and nonnegative; memory availability
and normal pressure govern admission rather than new fixed swap limits. The
runner samples on demand before each claim. Raw `res` calls use that fresh
cache; missing, future or stale samples close admission. Waiting does not make
a stale sample admissible; refresh through the runner before retrying.

The shared `dynamic_capacity.py` arithmetic is also used by CN devbox admission.
Each claim atomically writes its reservation in its hold. CPU/memory credit
requires fresh (15-second) run-attributed usage, capped both by declared cost
and by the host load/memory increase since the outstanding batch's baseline.
Credits consume one shared visibility budget, so the same measured increase
cannot remove multiple reservations. The supervisor reports owned RSS and
elapsed five-minute CPU-load contribution; credit is deliberately conservative
when unrelated memory is freed or load falls. Disk stays reserved to cleanup.
A newer timestamp alone never removes a reservation. This mini2 convergence is
new: the reference devbox code currently retains active dynamic reservations
for their full lifetime; its behavior is preserved in this change.

FIFO is shared across named and pool claims. A fitting, componentwise smaller
claim may pass a head blocked specifically by CPU, memory or disk at most three
times. The bypass count is persisted in the head's ticket under the host guard.
A fitting head, non-capacity gate or exhausted count prevents bypass. Dead
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
Rollback restores registry/config bytes, keeps the compatible code while new
leases drain, and resolves their IDs from holds/pending state. Registry/config
changes since migration cause rollback to refuse an overwrite.

Rejected: numbered extra rows, a second budget formula, whole-host execution
serialization, timestamp-only reservation expiry, and dropping an unconfirmed
remote lease's cost. A full devbox-controller rewrite would mix its Linux I/O
and placement policy with mini2 link/qualification/cleanup policy; the shared
budget arithmetic is reused while the existing mini2 host transaction remains.
