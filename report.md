# Slot Trees On Demand

Branch `slot-ondemand`, base `d4168da`. Worker `gpt-6.1-sol`, effort `high`, account `ttadk` (launcher metadata). Local commit only; no push, live shared changes or devbox mutations.

## Design And Limits

- Runner-only per-host `machine.conf` switch `DEVBOX_TREE_PLACEMENT.<IP>=1` opts in. Missing/zero preserves old SSH scripts and payloads byte-for-byte. The controller already ignores well-formed unknown settings; `scripts/res/res` is untouched.
- Checkout already creates trees on demand. Row proposals preserve address/capability/preference/hardware tags and add `dynamic-only` to extras, so a generous ceiling does not enlarge stale-metric baseline concurrency. The generator prints only and rejects ID collisions.
- Primary keeps repositories/shared caches/inputs/receipts; secondary roots contain only `wt/`. New-tree score is surplus above floor and matching live new-tree reservations, multiplied by observed disk idle fraction. Default floors are 53/20 GiB and new-tree reserve 20 GiB. One-second sysfs deltas measure per-device busy time; unknown devices fall back to space for every root. Benchmark IOPS are not substituted for measurements.
- Atomic map replacement uses the existing repository lock plus a global remote map lock. New-tree reserves are tied to public lease-info digests, not permanent slot budgets. Cleanup clears the exact owner's reserve before normal lease return; observed replaced owners retire. Delayed SSH/unknown publications cannot omit a recent reserve: missing evidence retains it for up to four hours (maximum preparation plus command budget), and a matching held owner keeps it beyond that. Failed reserve cleanup warns and may conservatively bias placement until expiry/reuse. Existing trees never move/rescore, and runner/Git identity is checked before reuse. A removed registered root or partial/foreign tree fails closed.
- One read-only inventory per enabled host ranks currently free slots: newest matching project/store, empty, then oldest foreign tree. Exactly one soft `--prefer-slot` goes to `wait-pool`, scoped to the explicit/verified preferred host when available; caller slot preference wins. Attempt records include the hint/reason. No force-take or FIFO change is introduced.
- Attempts, phase receipts and worktree metadata contain `treeRoot`, `treeState` and placement inputs: free/floor/reserved GiB, device busy time, score and mode. Warm reuse emits an empty score array instead of inventing a sample. Inspection/launch recheck both floors.
- Opt-in owner eviction takes/returns a public maintenance lease per candidate, rechecks under remote locks, and removes only identified `wt/<project>/id-*/<slot>` trees. It covers secondary roots, cold age (default 3 days) and below-floor LRU, logging path/allocated size/space before and after. Held/unregistered slots, dirty/private trees, symlinks, foreign repositories and live/unknown processes survive. The matching controller's existing `retain-remote` protects deletion leases; unknown SSH completion retains a protected hold for owner recovery rather than making the slot reclaimable. Log writability is checked before deletion. Default eviction is the original `.data`-only command; ordinary leased GC gains secondary inventory but retains `--days` semantics.

Not done: live installation, remote builds/eviction/provisioning, moving trees, automatic root discovery, deleting dirty/private state, shared-cache eviction, or the companion host I/O admission gate (another worker's file). All SSH-looking acceptance uses isolated PATH shims and task-created temporary files. No live target acceptance is claimed.

The primary-disk controller gate stays conservative: secondary space cannot rescue primary admission. Minimal future `res` change: accept per-device placement/reservation records, sum/check the selected device's free space and floor, and separately protect primary shared-store growth. Never remove the primary guard to work around this finding.

A single static `--prefer-slot` cannot guarantee full host-local order after the controller changes host or the hint becomes busy. Minimal future `res` change: consume timestamped per-host ordered slot hints within the existing admitted/spare-core affinity tier. Old controllers report an unapplied hint. Legacy non-`id-` stores retain primary-only behavior and are excluded from whole-tree eviction. Auto shard sizing still uses registry rows; simultaneous admission remains in `res`.

## Owner Enable Steps

Publish the reviewed runner, `lib/devbox-trees.mjs`, both eviction entries and row generator from the same revision. Preserve the controller and merge companion I/O work separately. Drain host holders/old waiters before switching runner/config. Keep owner-managed prior executable/config/registry copies for rollback, without copying any login/session material. Baseline/control checks: `res audit --json` and `res status` before/after, dynamic host enrollment, fresh five-minute metrics, primary free >=53 GiB, configured secondary floor, and the companion I/O gate. Unexpected refusals or lost holds stop the trial; do not bypass gates.

1. Devbox 9 first: enable primary-only placement initially. A system-disk overflow root is sensible given the supplied 147 GiB free and independent disk I/O, but its supplied 4.2k random IOPS is about half the data disk's 8.6k. Keep primary/shared caches on data. Proposed overflow root `/srv/devbox-run-2` must be provisioned writable by `tiger` and verified on the system disk, not a symlink/data mount. Recommend an 80 GiB secondary floor for the initial trial (about 67 GiB surplus before reserves), then owner tuning based on receipts/pressure.
2. Devbox 8 next: use `/data00/devbox-run-2`, writable by `wangsiyu.chris`. The supplied independent 5.9k IOPS disk with 119 GiB free is useful overflow beside the primary 10.9k IOPS system disk. Start with default 20 GiB secondary floor/reserve; leave warm primary trees where they are.
3. Run these read-only filesystem probes before provisioning/enabling secondary roots:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 tiger@10.199.23.51 'findmnt -n -o SOURCE,MAJ:MIN,TARGET -T /data00/home/tiger/devbox-run; findmnt -n -o SOURCE,MAJ:MIN,TARGET -T /srv; df -BG /data00/home/tiger/devbox-run /srv'
ssh -o BatchMode=yes -o ConnectTimeout=10 wangsiyu.chris@10.37.251.219 'findmnt -n -o SOURCE,MAJ:MIN,TARGET -T /srv/devbox-run; findmnt -n -o SOURCE,MAJ:MIN,TARGET -T /data00; df -BG /srv/devbox-run /data00'
```

The owner provisions only each secondary root's `wt/` parent through the normal approved process, never per-project/slot trees. Publish complete settings by temporary-file/atomic rename, preserving unrelated settings. Devbox 9 starts with only its switch, then its extra-root settings; devbox 8 follows:

```ini
DEVBOX_TREE_PLACEMENT.10.199.23.51=1
DEVBOX_EXTRA_ROOTS.10.199.23.51=/srv/devbox-run-2
DEVBOX_TREE_SECONDARY_FLOOR_GIB.10.199.23.51=80
DEVBOX_TREE_PLACEMENT.10.37.251.219=1
DEVBOX_EXTRA_ROOTS.10.37.251.219=/data00/devbox-run-2
```

Generate proposals from this checkout. The proposed ID ranges are collision-checked; choose a different free range if rejected. These commands print, never install:

```sh
REGISTRY="$HOME/.claude/orchestrator/_shared/resources.tsv"
ROWS9=$(awk -F '\t' '$1 ~ /^devbox-cn-[0-9]+$/ && $2=="remote" && $3=="open" && index($5,"@10.199.23.51") {n++} END {print n+0}' "$REGISTRY")
ROWS8=$(awk -F '\t' '$1 ~ /^devbox-cn-[0-9]+$/ && $2=="remote" && $3=="open" && index($5,"@10.37.251.219") {n++} END {print n+0}' "$REGISTRY")
node scripts/devbox-slot-rows.mjs --registry "$REGISTRY" --host 10.199.23.51 --count "$((40-ROWS9))" --first-id 1000
node scripts/devbox-slot-rows.mjs --registry "$REGISTRY" --host 10.37.251.219 --count "$((40-ROWS8))" --first-id 2000
```

Skip a host already at 40 rows; substitute 32 for a smaller trial. Review TSV, retain baseline rows unchanged, and publish through the owner's atomic registry process only after dynamic/companion I/O acceptance. Missing/stale metrics must exclude all new `dynamic-only` rows.

Trial a source-only test repository with serial runs: create a new tree, run again, verify the same `treeRoot`, `cold-new` then `warm`, preserved cache, newest warm hint, score inputs, and all lease returns. Observe both disks and gate refusals during controlled owner-approved load; rows are not concurrency. Live eviction remains the rules owner's separate decision, never a runner placement workaround.

## Disable And Verification

Drain active holders and queued old-runner requests. Atomically set each placement switch to `0` (or remove this change's settings) and restart callers to discard in-process snapshots. New runs use the old primary path and `.data`-only eviction. Leave secondary roots/trees/map untouched: disabling may create a separate primary tree and temporarily lose warmth, but moves/deletes nothing. Re-enable only with mapped roots registered; the map resolves duplicates, otherwise ambiguity fails closed.

Keep extra rows `dynamic-only`; dynamic admission off restores only baseline admission. To undo the ceiling, drain each extra row's holder/waiter before atomically restoring the prior registry. Restore prior runner/eviction executables for code rollback. Never force-return unknown processes or remove roots used by active holders. Map reserves retire by lease identity, not manual deletion.

All 12 `scripts/test/devbox-*-scenarios.mjs` passed serially with normal fixture budgets. The serial wrapper ran each script with `node`, saved a named `.log`, successfully masked it, then started the next script. Final masked evidence: `/Users/bytedance/.claude/jobs/9850afbb/tmp/task-slot-ondemand/test-logs/final/`. Equivalent test command: `for test in scripts/test/devbox-*-scenarios.mjs; do node "$test" || exit; done`.

Coverage includes new-tree space/I/O scoring, native one-second stat deltas, missing-I/O fallback, reserve floors and launch rechecks, stale-inventory reservation protection/return, warm reuse/newest-slot/held-slot fallback, secondary run-data cleanup and dead-holder discovery, safe cold/LRU eviction, protected holds on unknown SSH completion, duplicate-tree map preservation, and byte-identical legacy wire snapshots/payloads with flags absent/OFF. JavaScript syntax checks, `zsh -n scripts/devbox-evict.sh`, and `git diff --check` passed.

The initial full run found an artifact fixture regression caused by globally canonicalizing macOS temporary paths: `/private` triggered the existing output redactor. Legacy fixture paths were restored, canonical paths restricted to tree fixtures, and `DEVBOX_TEST_CASE=baseline-artifacts node scripts/test/devbox-run-scenarios.mjs` passed alone before the final complete serial run. No increased test budgets, live mutations, or live target acceptance are claimed.
