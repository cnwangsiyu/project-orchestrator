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
| `--shards N` | 1–64 independent shard holders |
| `--timeout MIN` | Positive minutes, at most 120, default 120; bounds each shard's queue, transfer and command together |
| `--artifact GLOB` | Repeatable, workspace-relative files; fetched into one tar per shard attempt |
| `--out DIR` | Logs and summary; defaults to a unique directory in the local temporary directory; refuses to overwrite a previous run |
| `--env K=V` | Repeatable explicit command environment; credential-related and SSH/Git configuration variables are refused |
| `--affinity KEY` | Defaults to repository identity + branch/ref |
| `--prefer-host IP` | Preferred box, subject to availability and capabilities |
| `--need CAP[,CAP]` | Required registry capabilities |
| `--exclude-slot ID[,ID]`, `--exclude-host IP[,IP]` | Skip these slots or hosts even when preferred. Both options are repeatable. |
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

## Hard Pre-Transfer Gate

Every project completes a local, fail-closed configuration scan
before any SSH, lease acquisition, bundle upload, patch or untracked archive
transfer. Recursive module snapshots must pass too. The scanner checks the
selected commit's tree and all reachable configuration blobs in its history,
including merge-parent changes and later-deleted files. This deliberately
includes more history than an incremental warm transfer might need. Worktree
runs additionally check staged blobs, changed working files and nonignored
untracked files before constructing upload archives.

Patterns include `*.properties`, `.env*`, `*.gradle`, `*.gradle.kts`,
`*.yml`, `*.yaml`, `*.toml`, `*.ini`, `*.cfg`, `*.conf`, `*.json`, `*.plist`,
`*.xcconfig`, and Groovy/Kotlin `*.groovy`, `*.kt`, `*.kts` source/DSL files.
Binary plists are decoded locally. Configuration symlinks and unavailable
blobs/parsers fail closed; they are not followed to another file. Module scans
use the same ancestor-object fallback as export staging, without repairing
source repositories. Known private paths and their history are rejected by
filename before any configuration contents are read. The npm gates remain
in force, so an allow entry cannot authorize private files or npm credentials.

The transfer detector reuses the nightly audit's key/DSL detector and extends
it for admission. Nonblank literal values under names containing `ACCESS`,
`SECRET`, `SCRECT`, `KEY` (except `keyAlias`), `TOKEN`, `PASS`, `PWD`, `AUTH`,
`CREDENTIAL`, `NEXUS`, `MAGIC`, or `PRIVATE` are refused. PEM private-key
markers and AKIA-style access keys are also refused even without a matching
field name. Blank values, environment references such as `${ENV}`, source
variable/method references, booleans, nulls and public URLs are not credential
literals. Wildcard names are intentionally conservative; a nonblank numeric
credential literal is not automatically exempt.

On refusal, diagnostics contain only **path, key name and count**, never the
suspected value. Use a source-only export with these fields blanked. Blanking
only the current tree is insufficient if the source history still contains
credentials. Alternatively, the owner can document a proven non-secret with
an exact repo-level allow entry below: `repoId` is the normalized-origin (or
Git common-directory) identity from `storeIdentity(repo)` **without** a project
override, `path` and `key` are exact, and `reason` records the proof. There is no
CLI or environment bypass and no wildcard allow. Do not add credential values
to the entry. No exceptions are currently approved.

<!-- devbox-nonsecret-allow -->
```json
[]
```
<!-- /devbox-nonsecret-allow -->

Runner output additionally masks these credential assignment families,
multiline PEM private-key output and AKIA-style keys before streaming or
writing shard logs. Commands must still never deliberately emit credentials;
redaction cannot identify arbitrary unlabeled sensitive strings.

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

A tracked registry-only `.npmrc` is accepted. Historical npm configurations and
staged upload contents are checked for credential settings and token expansions
before leasing. Refusals identify the path and setting. Other private-file path
rules still apply. Set `DEVBOX_CACHE_DIR` to an existing private directory to
keep the runner's host, affinity and flaky records there while using public res
for leases.

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
pre-transfer credential admission, clean receipts and streamed lease progress.
Set `DEVBOX_TEST_CASE=credentials|packed-module|receipt|res-progress|bundle|ownership|baseline`
to rerun one focused case under local load.
`baseline` runs the original runner scenarios without the new fix
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
