# Shared devbox runner

`scripts/devbox-run.mjs` runs Linux commands on registered, open CN devbox slots.
It requires Node 22, Python 3, Git, tar and the user's working SSH command locally; boxes
need Linux, Python 3.9 or later, Git, tar and Bash. It uses the public
`~/.claude/orchestrator/_shared/res` controller, with no local build/lane locks.

```sh
node scripts/devbox-run.mjs \
  --project my-project --task verify --repo /absolute/path/to/repo \
  --ref worktree --pool devbox-cn --shards 4 --timeout 90 \
  --need node --artifact 'reports/*.xml' --out /tmp/my-verification \
  -- 'npm test -- --shard={shard}/{shards}'

node scripts/devbox-run.mjs \
  --project vesdk --task android-verify --repo /absolute/path/to/tiktok_vesdk \
  --need vesdk-android --affinity vesdk-android-main \
  -- './gradlew test'

node scripts/devbox-run.mjs gc --host 192.0.2.10 --days 7

node scripts/devbox-run.mjs \
  --project my-project --task tests --repo /absolute/path/to/repo \
  --shards auto --units-file /tmp/test-files.txt --need node \
  -- 'npm test -- {units}'

node scripts/devbox-run.mjs prewarm \
  --project my-project --repo /absolute/path/to/repo --ref main \
  --need node --command 'npm ci && npm run build'
```

VE/vesdk Android work must specify **`--need vesdk-android`**. The capability
belongs only on boxes provisioned with that toolchain; a large CPU count does
not establish readiness. Other examples include `--need node,chromium`.
Multiple `--need` arguments combine their requirements. Every required
capability must appear in the slot's `caps=...` registry description.
A `prefer=vesdk-android` slot ranks first for eligible requests that need
`vesdk-android` and last for generic work. Generic jobs may use it when the
other eligible slots are occupied.

The text after `--` is a Bash command. Quote it as one shell argument when it
contains shell expansion, pipes or redirects. `{shard}` is one-based and
`{shards}` is the total. Each shard is a separate local holder process and takes
its own remote slot. Shards can queue when fewer slots are available.

Each box may provision a **nonsecret `~/devbox-env.sh`** with its toolchain
`PATH`, `JAVA_HOME`, `ANDROID_HOME` and similar settings. The runner sources it
inside `bash -lc` before the command. If absent, it prepends
`$HOME/.local/node/bin:$HOME/.local/bin` to PATH. Shared-cache exports and
explicit `--env` values are applied after this bootstrap. The runner never
copies this file between machines; the box owner maintains it. TikTok host
repositories remain on RemoteX / TT-VEIS, rather than these devbox worktrees.

## Options and results

| Option | Behavior |
| --- | --- |
| `--project`, `--task`, `--repo` | Task and repository root are required. An explicit project names the shared repository. |
| `--ref HEAD\|worktree\|<commit-or-ref>` | Defaults to HEAD; worktree adds the tracked diff against HEAD and nonignored untracked files |
| `--pool devbox-cn\|devbox-cn-light` | Heavy pool by default; light for checks under about five minutes |
| `--shards N\|auto` | 1–64 independent shard holders; auto sizes from free eligible slots and duration history |
| `--units-file PATH` | One source-relative test file per line; units are balanced and invoked separately |
| `--timeout MIN` | Positive minutes, at most 120, default 120; bounds each shard's queue, transfer and command together |
| `--artifact GLOB` | Repeatable, workspace-relative files; fetched into one tar per shard attempt |
| `--fetch-timeout MIN` | Artifact readback limit per shard attempt (default 15, max 120). On failure the summary records `artifactsLeft` (slot, host, workspace, patterns); the files stay on the slot until it is reused |
| `--out DIR` | Logs and summary; defaults to a unique directory in the local temporary directory; refuses to overwrite a previous run |
| `--env K=V` | Repeatable explicit command environment; credential-related and SSH/Git configuration variables are refused |
| `--affinity KEY` | Defaults to repository identity + branch/ref |
| `--prefer-host IP`, `--prefer-slot ID` | Preferred box or slot, subject to availability, capabilities and FIFO |
| `--need CAP[,CAP]` | Required registry capabilities |
| `--exclude-slot ID[,ID]`, `--exclude-host IP[,IP]` | Initially skip these slots or hosts. Both options are repeatable. |
| `--exclude-reason TEXT` | State a reason and keep caller exclusions for the entire wait. Include the reason in the worker report when adding exclusions or a slot preference. |
| `--submodules` | Transfer recursively pinned commits from initialized local submodules, including unpublished commits. |
| `--rerun-on-fail` | Retry a failed shard once on another slot, preferring a different box |
| `--allow-flaky` | A failing shard that passes its rerun may make the overall run pass |
| `--watch-pid PID` | Watch an explicit worker PID; otherwise watches the launching parent |

`shard-k.log` streams command output and runner diagnostics. `summary.json`
contains the project, task, commit, command hash, overall exit and a `shards`
array. Each shard includes `slot`, `host`, `exit`, `durationSec`, `log`, `flaky`
and `attempts`; attempts also record returns, bundle bytes, artifacts and
cleanup failures. The overall exit is the first nonzero shard result in shard
order, or the cancellation status. Command failures retain their exit codes;
timeout is 124, SIGINT is 130 and SIGTERM is 143.

Res acquisition and return stdout/stderr stream line by line with UTC timestamps
into each shard log. `shard-k-state.json` is updated atomically during waits,
including waiter-start, rollback/return, acknowledgement and reported-slot
progress; it is finalized after cleanup. Summaries include `stateFile` and
`resEvents` with operation, stream and time. Live state retains the first 10
and newest 490 events (2,000 characters each); logs retain the complete stream.
The final raw res stdout is still parsed after close, so progress/redaction
does not change lease arbitration or slot ownership. This observability does
not override the controller's current stale-waiter setting, including the
`RES_WAITER_STALE_SECONDS=300` live hotfix.

The summary also includes `requestedShards`, `shardPlan` (count, assignment
strategy and expected total command seconds), and the run mode. Attempts record
`cpus`, `hostCores`, `heavyHolders` and `commandDurationSec`; unit runs include
their assigned `units` and per-unit duration/exit receipts.

## Placement waits

Keep task inputs usable on any matching devbox. When free matching capacity is
available only on an excluded host, the controller names those hosts in the
shard log and displays `self_restricted` in `res status`. With no reason,
a queued shard drops its soft exclusions after five minutes in this condition,
keeps its FIFO position, and records `softExclusionsDropped: {hosts, slots, afterSec}`
in `summary.json`. A subsequent failure includes the rerun guidance.
`DEVBOX_SOFT_EXCLUDE_MINUTES` changes the threshold. A reasoned wait longer
than ten minutes in this condition wakes an armed owner watcher once. Failed
slots, hosts refused by the live disk guard, quarantine, and slot requirements
still constrain placement. Auto sizing and prewarm plan from current eligible
capacity and can decline to launch when it is unavailable. Install the matching
`res` for soft fallback, waiter diagnostics and retained-hold protection.

## Rebuild costs and declared inputs (BC-135–137)

Declare input availability instead of pinning a cache with host exclusions:

```sh
node scripts/devbox-run.mjs --project vesdk --task android-verify --repo "$PWD" \
  --need vesdk-android --affinity vesdk-android-main --warm-cost 27m \
  --input 'name=android-sdk,hash=none,rebuildable=yes,cost=45s,size=2' \
  -- './gradlew test'
```

`--input name=N,hash=SHA256|none,rebuildable=yes|no,cost=45s|27m,size=GiB[,seed=SOURCE][,path=/remote/path]`
is repeatable. `--inputs FILE.json` accepts an array (or `{ "inputs": [...] }`)
with the same fields; JSON may use a boolean for `rebuildable` and seconds for
`cost`. Names are unique within a call. Paths are optional, absolute remote
paths; without one, the input lives at `ROOT/inputs/NAME/HASH`. SHA-256 covers
file bytes; directory hashing covers sorted relative UTF-8 file names, newline,
size in bytes, newline, then each file's bytes. Empty directories do not affect
the hash. Symlinks and special files are refused. `size` is a GiB budget, not an
exact-byte assertion; positive sizes bound the verified content. Seeded inputs
require a SHA-256 and a positive size.

A local seed path is scanned before any SSH or lease using the existing
credential transfer gate, then staged as a task-owned archive. Private paths,
symlinks and special files are refused before copying. Hash and size must match
before transfer; the receiver verifies again before publishing the input.
Binary plist seeds require a source-only export. `seed=cmd:COMMAND` runs a
source-only seed command on the selected box under the normal supervisor;
`DEVBOX_INPUT_PATH` names its output. Commands cannot fetch login-dependent
material. Such dependencies must be non-rebuildable or prepared by the task
through its normal authorized tooling. Seed commands get separate control
directories and cleanup before the main command.

The main command receives `DEVBOX_INPUTS_DIR=ROOT/inputs` and
`DEVBOX_INPUTS_FILE=CONTROL/inputs.json`, a JSON map from input names to paths.
It must build any missing rebuildable input that has no seed or is too expensive
to seed automatically. Ordinary runs seed inputs costing at most 300 seconds;
`prewarm` seeds all declared sources on otherwise idle eligible hosts:

```sh
node scripts/devbox-run.mjs prewarm --project video-agent --repo "$PWD" \
  --input 'name=sg-prepare,hash=SHA256,rebuildable=yes,cost=45s,size=1,seed=./prepare-inputs'
```

An input-only prewarm command defaults to `true`; optional `--command` still
runs once per idle host at nice 10. No prewarm queues or busy-host work is added.

`devbox-inputs/HOST.json` (under the normal runner cache directory) records
version 1, `inputs`, and entries keyed `NAME+HASH`, with `path`, `bytes`, and
`verifiedAt` Unix seconds. Missing or expired entries trigger read-only SSH
hash/size verification; a failed verification removes the entry. Successful
seeds and runs update the index atomically under its existing local state lock.
Hardware, running emulators/devices, stateful containers, and state that requires
login to retrieve must be declared non-rebuildable. A task can provide an
absolute verification path or have the owner register a current marker in the
index. The runner verifies the marker/content, not emulator or container health;
the task retains those health probes. Uncommitted source is transferred by
`--ref worktree` and is not host-bound input state.

The implicit warm input is keyed by project, repository identity and affinity,
and tracked separately for each slot. `--warm-cost` declares its cold rebuild
penalty. Successful timing receipts record cold and warm durations; with history,
the estimate is their median difference. Explicit costs remain authoritative
until both classes have at least three observations. Seed observations likewise
replace declared input costs after three samples, using a bounded 21-sample
median. For an unseeded rebuild, one missing input can be measured against three
successful runs with all inputs present and the same warm/cold cache class; its
command-duration delta supplies the observations. Multi-input rebuilds retain
declared costs until separately observed; the runner does not invent per-input
breakdowns. Without a manifest, declared warm cost, or usable history, rebuild cost
is zero and normal placement/exclusion behavior applies.

For each hard-compatible candidate, the runner supplies missing-input cost and
estimated holder time remaining (historical slot duration minus holder age,
minimum 60 seconds, maximum 2,700 seconds, 300-second fallback). `res` checks
actual admission: a free admitted slot has zero wait, a gated slot has at least
60 seconds estimated wait, and disk-denied/floating-closed rows are excluded.
A missing non-rebuildable input excludes the candidate with the input's name.
The minimum wait-plus-rebuild score wins; a busy warm winner remains queued
instead of immediately taking a more expensive cold slot. `res` continues to
own FIFO and rechecks policy, capabilities, quarantine and gates after claiming.
The runner refreshes inputs, metrics and scores each minute while waiting.
Decision tables (`host`, `slot`, `waitSec`, `rebuildSec`, `totalSec`, reasons)
appear in shard logs and `attempts[].placementDecisions` in `summary.json`;
the runner's input estimate is also retained in `attempts[].inputPlan`.

With a 27-minute cold VESDK build and 43-second warm build, measured rebuild
penalty is 1,577 seconds. A warm slot with 15 minutes remaining scores 900
seconds versus a free cold slot's 1,577 seconds: wait on the warm slot. With
35 minutes remaining, the warm score is 2,100 seconds: use the free cold slot.
For VAK SG prepare, a 45-second reusable source-only prepare input missing on
an idle host beats waiting 10 minutes for a cached host; seed the input, verify
its hash, and run the prepare command using its mapped path. A box-local
stateful prepare container declared `rebuildable=no` keeps the job on the box
that has a verified marker. These examples assume matching registered CN
capabilities and the normal disk/load/memory gates; SG itself remains probes-only.

`machine.conf` adds the following integer keys (no host suffixes):

| Key | Default | Meaning |
| --- | --- | --- |
| `DEVBOX_REBUILD_PLACEMENT` | `1` | `0` disables cost-aware placement; non-rebuildable manifests then fail closed |
| `DEVBOX_INPUT_TTL_SECONDS` | `300` | Read-only input verification TTL, 1–86400 seconds |
| `DEVBOX_INPUT_WAIT_CAP_SECONDS` | `2700` | Maximum holder wait estimate, 1–86400 seconds |
| `DEVBOX_INPUT_SEED_MAX_SECONDS` | `300` | Normal-run seed cost limit, 1–86400 seconds |

Publish configuration via a sibling temporary file and rename. The kill switch
retains normal placement, disk reservation and slot hygiene; rebuildable inputs
still get verified/seeded for the command. Matching runner and `res` revisions
are required for explicit input placement.

BC-137 reservations end on return/reclaim and never duplicate a live slot's
exact owner. New workspaces retain configured project/host disk cost; existing
per-slot project worktrees reserve zero base disk. Missing declared content
adds its size budget, including prewarm, with a live disk check before seeding.
Direct `res take`/`wait-pool` may pass `--disk-gib N` (zero allowed),
`--disk-gib-file JSON` for per-slot overrides, or `--extra-disk-gib N` to add
content cost without reducing the configured base. The real 53 GiB floor stays.
Legacy anonymous reservations expire at the previous TTL; the owner should
archive them under quiescence as part of rollout rather than retaining churn.

`res take SLOT --maintenance --for 'worktree cleanup' ...` exempts only disk
admission and reserves zero disk; load/memory, policy, row limits and FIFO still
apply. `gc` uses this explicit flag for expired-tree and repo/image cleanup.
Workers never edit a slot worktree in place: use a separate checkout or ship an
experiment through the snapshot. At reuse, tracked edits in every initialized
submodule and the superproject are saved under `CONTROL/slot-edits/*.patch`
before recursive `reset --hard` and `clean -ffd`. Ignored build caches survive.
The summary/log records every patch path and the previous job from the slot
receipt or controller take journal (if both are unavailable, legacy slots explicitly say unknown). These patch files are not
removed by slot reuse or this change's GC.

## CPU budgets and unit sharding

On enrolled CN hosts the runner refreshes admission metrics before requesting a slot
when the cached sample is over 60 seconds old. It checks again every minute while
waiting and refreshes the selected host after a run with confirmed cleanup.
The probe reads field 2 of Linux `/proc/loadavg` (the five-minute average), the
CPU count, `MemAvailable` and available GiB on the workspace-root filesystem. Samples are atomically published to
`<RES_DIR>/devbox-metrics/<host>.json` with a local Unix timestamp in seconds.
The runner can still place work when the probe is unavailable. With no sample
under five minutes old, `res` uses the baseline static rows and leaves
`dynamic-only` rows closed. Existing workspace disk checks still run before the job.
With light reclaim enabled, a light-pool FIFO head can recover a hold older than
15 minutes when `res` can prove the recorded local holder PID is dead.
The dynamic disk budget keeps at least 53 GiB available after 15-minute
reservations, released on return. The runner inventories per-slot project worktrees before admission and uses zero disk cost for existing workspaces; new workspaces use the configured project/host cost. See the res contract for [disk budgets and rollout](res-contract.md#changes-in-v110) and [load and memory admission](res-contract.md#changes-in-v19).

Immediately before each command launch, the runner reads host cores from the
mini's `devbox-hosts.json` and counts currently held registered heavy slots on
that box. Proven dead local holder PIDs are excluded; incomplete or remote
holder metadata is counted conservatively. Light slots do not contribute to
the denominator. The budget is
`min(host_cores, max(2, floor(host_cores / max(1, heavy_holders))))`.
Each retry recomputes it. A budget is a launch-time snapshot, not a dynamically
changing limit when another job starts or finishes.

Commands receive `DEVBOX_CPUS`, `MAKEFLAGS=-j$DEVBOX_CPUS`,
`CMAKE_BUILD_PARALLEL_LEVEL`, `NODE_TEST_WORKERS`, `VITEST_MAX_THREADS`,
`JEST_WORKERS`, and `npm_config_jobs`. The runner appends
`-Dorg.gradle.workers.max=$DEVBOX_CPUS` to `GRADLE_OPTS` after the toolchain
bootstrap and explicit environment, preserving any existing options. Generated
CPU limits take precedence over conflicting `--env` values. Jobs with their
own worker option should use the budget explicitly, for example
`ninja -j"$DEVBOX_CPUS"` or `pytest -n "$DEVBOX_CPUS"`.

`--shards auto` never launches more than the currently free eligible slots
(capabilities, exclusions and current box quarantines apply), or more shards
than units. With history,
it targets at least 120 seconds per shard. For known unit timings it also
reduces N when an uneven assignment would leave a shard below that target.
Cold jobs use one shard. With zero free eligible slots it refuses rather than
queueing; explicit N retains normal bounded queueing. A short job still needs
one shard, and availability can change after planning.

With `--units-file`, each nonblank line is an exact workspace-relative source
file, including spaces if present. Duplicate paths, traversal, and files absent
from the selected snapshot are refused. `{units}` without a list discovers
conventional tracked JS/TS `.test`/`.spec` files and `__tests__` files,
Python `test_*.py`, Go `*_test.go`, and Java/Kotlin `*Test` files; use a list for
other layouts. Worktree mode also discovers uploaded overlay test files.
With `--submodules`, transferred pinned module files are valid units and are
included in discovery using their superproject-relative paths.

Each unit invokes the Bash command separately, replacing `{units}` with one
shell-quoted filename; without that placeholder the filename is appended.
Use `{units}` for commands containing pipelines or multiple shell statements.
Units within a shard run sequentially and remaining units run after a test
failure, retaining the first nonzero exit. `{shard}` and `{shards}` still work.
When all units have previous timings, longest-first greedy assignment puts the
next longest unit on the least-loaded shard. Otherwise assignment is
round-robin. Explicit N greater than the unit count is refused.

After cleanup, the mini merges successful unit durations and successful-run
aggregate command durations into `_shared/timings/<repo-id>.json`, with sample
counts and UTC update times. The repository identity is shared across linked
worktrees. Command history keys include the command and unit list, so unrelated
lists do not share auto-sizing estimates. Unit durations include command
startup overhead, but exclude source transfer and cleanup. Failed/cancelled
units do not become successful duration samples. With `DEVBOX_CACHE_DIR`, all
runner cache records, including timings, live there instead. Timing-fetch
warnings appear in the attempt; failure to write local history is exit 74.

## Hard Pre-Transfer Gate

Every project and prewarm run completes a local, fail-closed configuration scan
before any SSH, lease acquisition, bundle upload, patch or untracked archive
transfer. Recursive module snapshots must pass too. The scanner checks the
selected commit's tree and the configuration history that the next bundle will
transfer, including merge-parent changes and later-deleted files. Known bundle
bases exclude already-remote history; a first transfer scans full history once,
then reuses content-addressed clean-blob verdicts. Worktree runs additionally
check staged blobs, changed working files and nonignored untracked files before
constructing upload archives.

Patterns include `*.properties`, `.env*`, `*.gradle`, `*.gradle.kts`,
`*.yml`, `*.yaml`, `*.toml`, `*.ini`, `*.cfg`, `*.conf`, `*.json`, `*.plist`,
`*.xcconfig`, `*.strings`, and JavaScript/TypeScript, Java/Kotlin, Swift and
Objective-C source files. Binary plists are decoded locally. A configuration
symlink is allowed only when it resolves inside the scanned repository to a
tracked regular file; escaping, untracked, ignored, missing and non-file targets
fail closed. Unavailable blobs/parsers also fail closed. Module scans use the
same ancestor-object fallback as export staging, without repairing source
repositories. Known private paths and their history are rejected by filename
before any configuration contents are read. The npm gates remain in force, so
an allow entry cannot authorize private files or npm credentials.

The transfer detector reuses the nightly audit's literal parsing but applies
key-name DSL heuristics only to Gradle build configuration. JSON, YAML, TOML,
plist and xcconfig keys require either an exact strong credential name with a
nonblank non-reference string literal, or a separator-delimited weak credential
token whose literal is at least eight non-whitespace characters and looks
secret-like. Generic `key`, camelCase fragments such as `passStart`, and `author`
are not credential names. Asset-catalog `Contents.json`, localization JSON,
`*.strings`, plain source, and generated dependency lockfiles use value-shape
detectors only. Package names and `node_modules/` dependency paths are never
credential keys.

PEM private-key markers, AKIA-style access keys, JWTs, URLs with embedded
user/password credentials, and `_authToken`/`_auth` assignments are refused
even without a matching field name. Blank values, environment references such
as `${ENV}`, source variable/method references, booleans, nulls and public URLs
are not credential literals. Generated lockfiles retain all of these shape
checks while skipping key-name heuristics.

On refusal, diagnostics contain only **path, key name and count**, never the
suspected value. Use a source-only export with these fields blanked. Blanking
only the current tree is insufficient if the source history still contains
credentials. Alternatively, the owner can document a proven non-secret with
an exact repo-level allow entry below: `repoId` is the normalized-origin (or
Git common-directory) identity from `storeIdentity(repo)` **without** a project
override, `path` and `key` are exact, and `reason` records the proof. There is no
CLI or environment bypass and no wildcard allow. Do not add credential values
to the entry. Approved entries remain repository-, path-, and detector-specific;
test fixture exceptions do not weaken the corresponding value-shape detector
elsewhere.

<!-- devbox-nonsecret-allow -->
```json
[
  {
    "repoId": "id-a53976bd7bafd0216991445b719692d85a4db1b801739ef0ccac0722eec7b205",
    "path": "apps/android/app/src/test/java/com/videoagent/app/BlobUploadRoutingTest.java",
    "key": "EMBEDDED_URL_CREDENTIAL",
    "reason": "VAK upload-routing test fixture exercises redacted URL handling with a synthetic credential-shaped URL."
  },
  {
    "repoId": "id-a53976bd7bafd0216991445b719692d85a4db1b801739ef0ccac0722eec7b205",
    "path": "apps/app-ui/test/upload-routing.test.ts",
    "key": "EMBEDDED_URL_CREDENTIAL",
    "reason": "VAK upload-routing test fixture exercises redacted URL handling with a synthetic credential-shaped URL."
  },
  {
    "repoId": "id-a53976bd7bafd0216991445b719692d85a4db1b801739ef0ccac0722eec7b205",
    "path": "apps/ios/Packages/AgentKit/Tests/AgentClientTests/BlobUploadURLTests.swift",
    "key": "EMBEDDED_URL_CREDENTIAL",
    "reason": "VAK upload-routing test fixture exercises redacted URL handling with a synthetic credential-shaped URL."
  },
  {
    "repoId": "id-a53976bd7bafd0216991445b719692d85a4db1b801739ef0ccac0722eec7b205",
    "path": "services/agent/test/director-bridge.test.ts",
    "key": "EMBEDDED_URL_CREDENTIAL",
    "reason": "VAK director-bridge test fixture validates rejection of a synthetic credential-shaped URL."
  },
  {
    "repoId": "id-a53976bd7bafd0216991445b719692d85a4db1b801739ef0ccac0722eec7b205",
    "path": "services/agent/test/employee-profile.test.ts",
    "key": "EMBEDDED_URL_CREDENTIAL",
    "reason": "VAK employee-profile test fixture validates synthetic identity-provider URLs."
  },
  {
    "repoId": "id-a53976bd7bafd0216991445b719692d85a4db1b801739ef0ccac0722eec7b205",
    "path": "services/agent/test/employee-session-ingress.test.ts",
    "key": "JWT",
    "reason": "VAK employee-session test fixture validates a synthetic JWT-shaped input."
  },
  {
    "repoId": "id-a53976bd7bafd0216991445b719692d85a4db1b801739ef0ccac0722eec7b205",
    "path": "services/agent/test/employee-sign-in-claims.test.ts",
    "key": "EMBEDDED_URL_CREDENTIAL",
    "reason": "VAK employee-sign-in test fixture validates a synthetic identity-provider URL."
  },
  {
    "repoId": "id-f2b50a216f270092e558d06ffd23da41628a3adcdece55d66398b26153f3de8e",
    "path": "lynx-games/tools/effect-relay/check_input.m",
    "key": "EMBEDDED_URL_CREDENTIAL",
    "reason": "The lynx-games effect-relay input checker uses a synthetic credential-shaped URL as rejected test input."
  },
  {
    "repoId": "id-26e536eedee9afa400661964c5e6ae6af4b89be87db960e9434d23e06c5b1b56",
    "path": ".codebase/pipelines/publish-bnpm.yaml",
    "key": "NPM_TOKEN",
    "reason": "The lynx2video pipeline maps NPM_TOKEN to a secret-provider variable name rather than embedding a credential value."
  }
]
```
<!-- /devbox-nonsecret-allow -->

Runner output additionally masks these credential assignment families,
multiline PEM private-key output and AKIA-style keys before streaming or
writing shard logs. Commands must still never deliberately emit credentials;
redaction cannot identify arbitrary unlabeled sensitive strings.

## Nightly prewarm

`prewarm --project P --repo PATH --ref main --command '<build cmd>' [--need CAP]`
uses the same source checks, incremental store sync, persistent worktrees,
space guards and supervised cleanup as a regular run. Its default ref is
`main` and task is `prewarm`. It runs once per idle eligible CN box, preferring
an eligible light slot and then the most recently used slot in that pool for
the project. When no light slot has the required capabilities, it uses the
most recently used eligible heavy slot. The build runs under `nice -n 10`.

Prewarm uses only nonblocking `res take`, never `wait` or `wait-pool`. A held
heavy or light slot makes the box busy; quarantined boxes are also skipped.
It rechecks holder and quarantine state after taking its own slot
and returns it without starting a command if another holder appeared. Busy
boxes are skipped, and no idle eligible boxes is a successful no-op. It does
not move a failed prewarm to another box, rerun it, or accept unit sharding.
New arrivals can still start after the idle check; niceness limits interference.
This command is intended for a nightly-review caller. The runner does not
install or schedule a nightly job.

A successful rerun sets `flaky: true` and appends project, task, command hash,
shard, both hosts and time to `_shared/flaky-log.jsonl`. Without
`--allow-flaky`, the original failure remains the exit status. Failure to fetch
a requested artifact also fails the run. Artifact tars retain relative names;
inspect with `tar -tf` and extract them into a destination you choose.

## Shared storage and incremental builds

The registry's five-column `resources.tsv` supplies both the slot and the
unambiguous `<user>@<ip>` in its description. The runner never guesses an SSH
account or uses rows with `never` or `ask-user` policy.

Root discovery tries `/data00/home/<user>/devbox-run`, then
`/data00/<user>/devbox-run`, then `~/devbox-run`, choosing the first directory
that exists or can be created and accepts a temporary file. This prefers the
data disk and never uses sudo. Its layout is:

```text
<root>/repos/<project>/<repo>          one bare Git object store
<root>/wt/<project>/<repo>/<slot>      persistent detached Git worktree
<root>/shared/gradle                  GRADLE_USER_HOME
<root>/shared/npm                     npm_config_cache
<root>/shared/pnpm                    PNPM_STORE_DIR
<root>/shared/ccache                  CCACHE_DIR (CCACHE_MAXSIZE=20G)
<root>/shared/pip                     PIP_CACHE_DIR
<root>/shared/toolchains              DEVBOX_TOOLCHAINS
<root>/runs/<run-id>                  process identity and cleanup receipts
```

The first transfer sends a Git bundle of the requested commit and its history.
Later transfers use only locally readable ancestors of the requested commit as
bundle prerequisites. If packing fails, the runner tries a smaller set when
possible, then a self-contained bundle. When the requested object is already
present, no bundle is sent. A temporary local bare
repository references the source's objects without modifying its refs or
copying its Git configuration. A per-repository remote flock serializes fetch,
worktree changes and garbage collection. No remote Git login is needed.

Temporary export alternates use canonical absolute paths. Recursive module
exports also include their ancestor repositories' object directories: locally
assembled module stores can have missing blobs that exist in a superproject's
packed objects. This fallback changes staging only, not source alternates,
refs or configuration, and exports only the selected commit's reachable graph.
It does not fetch missing source objects or consult unrelated repositories.
An object missing from all these stores remains a bundle failure.

Bundle packing failures, including recovered attempts, report `bundleFailures`
in the log and attempt summary; terminal errors also include `bundleDiagnostics`:
source repository, exact Git argv and executable, working
directory, relevant environment names (only allowlisted path/config values),
and the export's recursively resolved alternates chain. Other Git environment
values are omitted. This distinguishes a module-object failure from a
superproject failure even after the top-level bundle already transferred.
`node scripts/test/devbox-bundle-repro.mjs --repo PATH --ref COMMIT
--parent-objects OBJECT_DIR --out SCRATCH_DIR` exercises the exact `makeBundle`
path without modifying the source; it retains a scratch bundle and receipt.
Use the normal local-heavy lane wrapper for a substantial packing probe.

Checkout resets tracked files to the requested commit and removes only the
previous overlay's uploaded untracked files. It leaves build outputs,
`node_modules`, `.gradle`, and other generated files in place. It does not run
`git clean -fdx`. Unchanged tracked files retain their mtimes. Worktree mode
then applies `git diff --binary HEAD` to both the remote index and checkout,
so the next reset also removes staged additions. It uploads a tar of `git ls-files --others
--exclude-standard`. Keep generated caches ignored by Git so they do not
become upload overlays. Each project name selects one repository identity, including across linked
worktrees. Without a project, the runner hashes the normalized origin (host in
lowercase, without transport, user or trailing `.git`). With no origin it hashes
the real path of the Git common directory. On a box with an older basename
store, the runner records a matching store in place when it can verify shared
history in the project namespace. Existing worktree links remain usable.

The slot-root `.devbox-run.json` receipt remains readable by jobs via
`DEVBOX_RUN_RECEIPT`. Checkout idempotently adds `/.devbox-run.json` to the file
resolved by `git rev-parse --git-path info/exclude`, under the repository lock.
Linked worktrees share that common-directory exclude; existing rules are
preserved. The receipt therefore does not make `git status --porcelain` dirty
and does not need a tracked `.gitignore` change. Its generated environment path
takes precedence over a conflicting `--env` value.

With `--submodules`, initialize the pinned repositories locally before running.
The runner reads the gitlinks from the selected superproject commit and feeds
each pin and its ancestors from local Git objects. Each box holds one bare
store per submodule identity. Slot clones reference that store. Each level uses
a local URL and file-only Git transport. Uncommitted submodule changes and LFS
objects are outside the snapshot. Attempt records include the superproject
repository path and transferred bundle bytes (`submoduleBundleBytes` for modules,
absent or zero on a warm run).

A tracked registry-only `.npmrc` is accepted. The selected tree plus staged,
modified and untracked worktree configuration are checked for credential
settings and token expansions before leasing. After target-store inspection,
historical configuration scanning uses the same exclusions as the next bundle:
only commits not reachable from the usable remote bases are checked. A first
transfer has no base and scans the full history. If bundle packing falls back to
fewer bases or a self-contained bundle, the scanner expands its history range
before that attempt. No bundle bytes are uploaded until this check passes.

Blob contents are read through one `git cat-file --batch` process per scan, with
binary framing preserved for plist parsing. Zero-finding blob OIDs are appended
to `<state>/scan-cache/<scanner-version>/<repo-id>.oids`; the version component
invalidates old clean verdicts when rules change. Blobs with any finding remain
uncached even when a repo-level nonsecret allow entry suppresses the refusal, so
allow-list edits take effect without cache invalidation. Staged and worktree
files retain their direct checks. Each scan keeps the 300-second hard limit; a
timeout reports its last phase and discovered, processed and cached blob counts.
Refusals and timeout diagnostics contain only paths, setting names and counts.
Other private-file path rules still apply. Set `DEVBOX_CACHE_DIR` to an existing
private directory to keep the runner's scan cache, host, affinity and flaky
records there while using public res for leases.

Machine-generated dependency manifests (`package-lock.json`,
`npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `Podfile.lock`,
`Gemfile.lock`, `Cargo.lock`, `poetry.lock`, `gradle.lockfile` and
`Package.resolved`) do not use credential-like key-name heuristics: dependency
names such as `js-tokens` and `path-key` are not settings. They still reject
private-key blocks, access-key and JWT shapes, registry URLs with embedded
user/password credentials, and literal `_authToken`/`_auth` assignments. Valid
JSON likewise applies key-name checks only to non-reference string values, and
skips dependency maps and `node_modules/...` subtrees rather than interpreting
package names or dependency paths as configuration keys.

`_shared/devbox-affinity.json` remembers the last host and slot for each key.
The runner passes the remembered eligible slot through `--prefer-slot` when
advertised by `res wait-pool`. Older controllers first try that slot without
waiting, then use the pool. It passes `--prefer-host` and `--need` only when
the controller's usage advertises them. With an older controller, a mismatching
pool selection is returned before a normal `res wait` for an eligible slot.
The controller remains responsible for lease ownership and queue arbitration.

`_shared/devbox-hosts.json` is keyed by IP. Each entry contains `user`, `root`,
`fs`, `freeGiB`, `totalGiB`, `cores`, `memGiB`, and `probedAt` (UTC). Writes merge
per host and publish atomically. Root discovery is cached; free space is checked
on the workspace filesystem for every run. Consumers should label host
measurements older than 24 hours stale.

## VE Android Source-Only Recipe

T152 qualified the unsigned MT Android vemo build on devbox 8 at
`91e795f3e661427dd1cad7a540d9a924f68cf459`. With 9 allocated CPUs,
the cold build ran in 1641.222s and compiled 4,771 native objects.
The warm build ran in 43.354s with zero new native objects.
See `tasks/T152/report.md` for the APK and verification receipts.

VE and Lynx use the shared `vesdk` namespace on devbox 8
(`10.37.251.219`). Request `--need vesdk-android` and keep the runner's
per-slot worktree. The base JDK, Android SDK, NDK 21.1, CMake and Gradle 7.6.3
live under `shared/toolchains`. The separate `VESDK_ANDROID_OVERLAY`
provides the Ninja wrapper, SWIG 4.0.2, and the Python libraries needed by
AmazingEngine. The setup script
`install-swig.sh` installs the SHA-256-verified Linux wheel from
[PyPI](https://pypi.org/project/swig/4.0.2/) into that overlay. The build
uses the BCE-carrying Bach
`22.7.0.15-MT-debug` with `USE_BACH_SOURCE=0`.

Blanking rules (2026-11-18, BC-141): the sanitizer and the recipe's own `credential-audit.py` match credential
labels by word (password, token, secret, credential, auth, and access/secret/api/private key pairs), never by
substring. Boolean, numeric and empty values, `ENABLE_`/`DISABLE_`/`IS_`/`USE_` switches and A/B experiment
identifiers are kept and listed in `source-build-fields.json`. Value-shape detectors (private-key blocks, access-key
ids, JWTs, URL credentials) are unchanged, and the devbox-run transfer gate still checks the export again.

Prepare from a local vesdk branch name or full commit. The exporter creates
a parentless Git snapshot and records the original commit in
`source-provenance.json`. Prep generates the EffectSDK Android version metadata
and MT build flags from the pinned parser in this isolated snapshot. Its local
Python needs PyYAML, requests and rich. It rejects credential-file paths and blanks
credential-labelled fields in Gradle and properties, including HTTP headers
embedded in command strings. `source-build-fields.json` records path,
key and count only. A branch must use matching engine, nodegraph, Bach,
and LFS inputs. Prep resolves AmazingEngine, tiktok_nodegraph and the
branch's declared Android MT-debug Bach pin through a payload manifest.
Each dependency set has its own directory under
`shared/deps/vesdk-android`. The qualified `T152-v1` keeps its staged
`22.7.0.15-MT-debug` compatibility override. New sets use a sibling
directory with their own pinned sources, Bach binary and audited LFS.
Run both transfer gates before installing a new set. A successful prep
writes `payload-id`, which `run-verified.sh` uses to select the install.

Prep exports the following configure-time source inputs on the mini from
exact local Git objects. Each export omits repository metadata and is
audited before transfer. The shared payload uses AmazingEngine
`99eef0da72b9ddd6f4983c26a928187fc317ec4f`.

| Consumer | Source | Revision |
| --- | --- | --- |
| AmazingEngine | EasySensor | `eaf4802cb67de29b8c02cbf379d25ccf72081254` |
| AmazingEngine | pathkit | `64a34916a1019aca045cd58b3250f0a39f228171` |
| AmazingEngine | jazz | `655dc6847d8508ef7acdc3248af773165d0966f4` |
| AmazingEngine | VECodecHeader | `6853578c01aa57608c1f41677aa3a9f1713de9c2` |
| EffectSDK | EasySensor | `c3c5e8f649d6e0597254c17f095818759a0c5df3` |
| EffectSDK | tiktok_nodegraph | `2e21a7279266d1680551e637ebaba23aa3bd3fdc` |

The worktree prep installs the six exports at the paths declared in the
two version files and writes `<dependency>=debug` in the corresponding
uncommitted `local.cfg`. The build permits only local Git transport.
The five staged TTBin packages are freetype 1.0.9, harfbuzz 1.0.2,
ICU 1.0.24, Lua 1.0.2 and YAML 1.0.2. The mini records a SHA-256
inventory for their files. The worktree verifies the relocated bytes
and regenerates the upstream path-dependent cache index before CMake.
Integrated AmazingEngine uses the Bach binary chosen by EffectSDK, so the
worktree overlay skips AmazingEngine's standalone availability probe.
The debug overlay restores the branch's MT selector, keeps one EffectSDK
publication include tree, and enables exceptions only for generated SWIG
JNI translation units. MetaNative uses a local build description with
remote caching disabled.
This MT Android configuration leaves ACanvas and nodegraph's test and
benchmark fetches disabled. A branch that changes a required pin needs a
matching, audited payload before it can use the shared recipe.

The same prep command stages a separate copy of the native dependencies.
The path globs for the three Bach layouts are
`native-deps/bach-sdk/pub/inc/smash/avatar_base_model.h`,
`ecache/ttbin/android/BachSDK_android/*/inc/smash/avatar_base_model.h`,
and `bach/*/inc/smash/avatar_base_model.h`. At each match,
`stage-build-payload.py` replaces the `m_authCode` initializer with
`""`, preserving the declaration and donor file. A different initializer
shape stops prep. The prep manifest records path, identifier and count.
The rule applies to VE and Lynx. There is no allowlist entry for this field.

Prep omits staged Maven and Gradle caches so Gradle resolves them on devbox
8 through credential-free repositories. It also omits AmazingEngine
`Demos`, `.ci`, `Tests`, and nodegraph's `.claude` directory.

| Scope | Excluded inputs | Reason |
| --- | --- | --- |
| All source-only refs | `lynx-games/tools/` | Developer tools outside the vemo build graph. |
| T176 LFS, default vemo debug | Two exact paths under `lynx-games/MobilePerfTest/effect-packages/lynx/` in `T176/configure-source-pins.json` | The Gradle asset task runs only with `VEMO_LYNX_PERF_PACKAGES=true`. |
| T176 LFS, default vemo debug | Ten exact paths under `lynx-games/effect-packages/original-images-20261017/` in the same manifest | The vemo asset source set uses `lynx-games/effect-packages/android/`. |
| T176 snapshot and LFS only | `proj/android/vemo/src/main/assets/sticker/round20261014_case-13_texturefix_lynx.zip` | Lynx opted to omit this October harness sticker from its APK. |
| T176 snapshot and LFS only | `proj/android/vemo/src/main/assets/sticker/round20261014_case-16_lynx.zip` | Lynx opted to omit this October harness sticker from its APK. |

AmazingEngine's `cache_recycling.sh` (line 194) expires cached TTBin packages after 30 days, judged by the newest
mtime among the first 200 files. Prep therefore refreshes the TTBin package timestamps and then rebuilds the cache
index (T183). The `T176-22.4.0` set also carries `jazz` (from `configure-source-v2`, pin `f83ee6291ad8`) and seven
AILib dependency trees, each recorded in its `install-receipt.json`.

The independent source and dependency gates and the stock runner's snapshot,
history and source checks must all pass with zero unapproved findings and
zero read errors. Dependency exceptions are limited to the four documented
C++ enum or glyph expressions in `payload-allowlist.json`. Each matches
an exact path, line and line SHA-256. LFS and separately uploaded recipe
files pass the credential-shaped gate as well. If the stock runner refuses
a blanked export, report its path and key to the rules owner and stop
before transfer. Keep values out of reports and logs.

```sh
RECIPE=/Users/bytedance/code/.claude-data/orchestrator/vesdk-mainline/tasks/T152
VESDK=/Users/bytedance/code/tiktok_vesdk
REF=91e795f3e661427dd1cad7a540d9a924f68cf459   # Or an existing local branch or commit.
PREP=/absolute/path/to/new-prep-directory
bash "$RECIPE/prepare-transfer.sh" "$VESDK" "$REF" "$PREP"
```

The one-time shared setup uses `bash "$RECIPE/setup.sh" "$PREP"` after
a successful prep. It rechecks the staged inputs before acquiring a slot
or transferring them. It installs the filtered payload, LFS objects
and overlay. On devbox 8, the existing T152 base payload can be upgraded
with `bash "$RECIPE/setup.sh" "$PREP" --configure-only`. Slot prep validates that the snapshot contains generated EffectSDK
metadata. Subsequent compatible builds use the existing shared native inputs.
For a new dependency set, coordinate a versioned setup with the recipe
owner before running the build.

Pass the prepared export as the runner repo with `--ref HEAD`. Pass the
original commit from the prep manifest separately for artifact provenance.
The Gradle and Ninja limits follow `DEVBOX_CPUS`; the native link pool
has one worker. The recipe assembles an unsigned vemo APK with
`:vemo:assembleDebug -PENABLE_EFFECT_DEBUG=true` twice in the same
workspace. The first run is labeled `cold` when the workspace has no native
objects and `incremental` when it reuses them. The runner returns the APK
and receives the timing and disk receipts. Signing runs separately on the
mini when authorized.

```sh
SOURCE_COMMIT=$(node -p 'require(process.argv[1]).sourceCommit' "$PREP/source-provenance.json")
bash "$RECIPE/run-verified.sh" \
  --project vesdk --task lynx-vemo-build --repo "$PREP/source-only" --ref HEAD \
  --need vesdk-android --prefer-host 10.37.251.219 \
  --affinity vesdk-android-main --timeout 120 \
  --env "VESDK_SOURCE_COMMIT=$SOURCE_COMMIT" \
  --artifact 't152-proof/*' --out /absolute/path/to/new-build-results \
  -- 'python3 "$VESDK_ANDROID_DEPS/recipe/remote-build.py" build'
```

The returned shard archive contains `t152-proof/vemo-debug-unsigned.apk`,
`acceptance.json`, and `disk.json` under `t152-proof/`.

The pinned T152 qualification uses `remote-build.py qualify`. The
runner prints `cold_apk_ready=...` when the unsigned APK is ready. Run
`bash "$RECIPE/watch-cold-apk.sh" "$RUN_RESULTS" "$RUN_OUTPUT" "$MINI_OUT"`
alongside the qualification run, using its result directory and redirected
console output. The watcher acquires a light slot to return the APK while
the runner retains its workspace. The mini verifies the APK and
the commit-specific AArch64 marker in `lib/arm64-v8a/libeffect.so`, then
returns a receipt that starts the warm build. See `tasks/T152/report.md`
for the qualification status, artifact, timings, and disk usage.

## Cleanup and space guard

Before transfer and again before launching the command, the runner requires 53 GiB free: 33 GiB reserve plus 20 GiB
for a slot. Below 73 GiB (reserve plus 40 GiB), it first checks for worktrees
unused for seven days and tries garbage collection. It returns a slot rejected
by the guard and retries another eligible slot once, preferring another box.

`gc [--host IP] [--days N]` finds worktrees recorded by this runner that have
not been used for N days (default 7, minimum 1). It tries to lease their slots
without waiting, rechecks their timestamps after leasing, removes expired
worktrees and their build outputs, then runs `git worktree prune` and
`git gc --auto` with automatic detaching disabled. Docker cleanup uses only
`docker image prune --force` (dangling images); it does not prune volumes or
all unused images. Shared caches and toolchains remain. The result prints the
change in filesystem free space; concurrent activity can affect that number.
Busy, retired, unregistered and approval-required slots are skipped.

A wrapper can cancel its run by saving the UUID printed as `runId=...` at
launch and calling `node scripts/devbox-run.mjs stop --out DIR --run-id UUID`.
The runner also writes the UUID to `DIR/run.json`. Use a fresh directory for each
run. The stop command checks the receipt and writes a UUID-specific request.
The wrapper should wait for the runner to finish cleanup and return its leases.
Sending TERM to a PID recovered from an old file can stop a different task.

Every command starts a new session and process group using `setsid(2)`. A Linux subreaper
outside that group continuously reaps adopted children, records process
identity, and enforces a remote deadline even when the local connection is
lost. Signals, timeout and normal completion all stop remaining descendants.
Cleanup writes a cancellation marker, waits for the supervisor's receipt and
confirms that the group is gone before artifact retrieval and `res return`.
If the remote command's SSH session drops with exit 255, the runner opens
up to three read-only reconnects. If the remote process group is confirmed gone,
the runner returns the slot and preserves the command's transport exit status.
If it is still running or cleanup cannot be proven, the runner retains the slot
and records the exact UUID-scoped stop command. The reconnect never requests
cancellation. An explicit `stop` can use the retained run receipt after the
local runner exits. It verifies the slot holder, requests remote cleanup and
returns the slot after confirmation.

SSH uses batch mode and 15-second keepalives with four missed responses;
interrupted bundle/overlay uploads get one fresh connection retry on Broken
pipe or MAC errors.

Shard SSH starts are staggered by 0.5–1.5 seconds of random jitter. Before the
remote command emits its start marker, the exact `Permission denied
(gssapi-with-mic)` and `Connection closed` establishment errors may retry
three times, each after a random 2–10 seconds. Exhaustion is recorded as
`infraFailure`; it does not trigger another flaky rerun. After the start marker,
these errors never replay the command. `ControlMaster`, `ControlPath` reuse and
`ControlPersist` are explicitly disabled so one connection cannot take down
other shards.

If the box cannot confirm process cleanup, the runner reports **BLOCKED** and
retains that slot for owner recovery instead of admitting another run over
unknown processes. A failed return is also recorded. Cleanup and artifact
transfer have separate bounded grace periods after the execution timeout.
Never force-return such a slot until its remote descendants are confirmed gone.

The runner transfers source and explicit nonsecret environment only. It does
not read login files or forward an SSH agent or delegated credentials. Common
credential-file paths are rejected from the source tree, reachable Git history
and artifacts. Use a repository with complete, source-only history. Worktree
overlays also reject nested untracked repositories. Logs
mask sensitive assignment lines and explicit environment values; commands
should never deliberately emit credentials. Output redaction cannot classify
arbitrary unlabeled secrets. Authentication failures require fixing the user's
normal signed-in SSH environment outside the runner.

## Validation

`node scripts/test/devbox-run-scenarios.mjs` uses isolated PATH shims for SSH
and res, real local Git bundles/worktrees, and no network. It covers shard
leases, registry mapping, capabilities on new and old controllers, shared
objects, incremental transfer, mtimes, overlays, shared cache environment,
affinity, upload and disk retries, artifacts, flaky bookkeeping, signal and
timeout cleanup, interrupted acquisition recovery and leased GC.
It also covers packed donor objects for incomplete modules, bundle diagnostics,
CPU budgets, auto sizing, unit assignments/timing history and idle prewarm.
`node scripts/test/devbox-transfer-check-scenarios.mjs` focuses on batched blob
framing (including binary plists), generated-lockfile/JSON false-positive and
shape checks, clean-OID cache hits, repeated findings, incremental-base/full-
history ranges and the cached no-`cat-file` timing path.
Set `DEVBOX_TEST_CASE=credentials|packed-module|receipt|res-progress|cpu|auto|units|prewarm|bundle|ownership|baseline`
to rerun one focused case under local load.
`baseline` runs the original runner scenarios without the new performance/gate
cases, including bundle recovery and process ownership.
For a loaded mini, bounded test-only allowances are available:
`DEVBOX_TEST_TIMEOUT_MIN=3 DEVBOX_TEST_WATCHDOG_MS=240000 node
scripts/test/devbox-run-scenarios.mjs`. Default fixture budgets remain one
minute and a 90-second outer watchdog (maximum configurable watchdog 10
minutes). The explicit production-timeout and cancellation scenarios retain
their own short deadlines. Report a normal-budget failure and rerun its named
case alone before using longer startup allowances.

For isolated tests, `RES_DIR` selects registry/state and `RES_COMMAND` selects
the controller. Production defaults to the shared public entry; do not use a
private controller against live state.
