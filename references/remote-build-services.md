# Company remote build services (RemoteX, Kross, AirBuild)

Status 2026-11-18: experimental. Nothing here is a verified end-to-end path yet. Orchestrators add their
workers' findings to the matching section (dated, with the task id); keep it factual and short.

## Policy (rules 2026-11-18.15, user decision)

Company remote build services count as company CI.

- Tracked repository content may sync as is. Do not sanitize it (the devbox sanitizer is for devbox transfers only).
- Never upload machine-only material: keystores and signing files (`*.jks`, `*.keystore`, `*.p12`,
  `*.mobileprovision`), `local.properties` beyond `sdk.dir`, `~/.gradle/gradle.properties`, `.env` files,
  `.remoteX` config values, cookie/session/token files, `~/.claude`, task directories.
- Build the upload list from an explicit allowlist of build inputs (source dirs, build files, required submodules and
  LFS objects), not from "everything tracked minus ignores": repositories track task reports and other non-inputs.
- Before each sync write the upload list into the task record: file count, size, top-level directories, and the
  result of matching the patterns above (must be none).
- Use a fresh export of a pushed commit (clean clone or `git archive`, submodules included, LFS resolved). Never
  the user's working tree, never unpushed commits.
- Tool-managed CLI auth only. No logins, no `kinit`, no copying credentials from the mini to the remote machine.
  If a dependency source on the remote side asks for credentials it does not have, stop and report.
- Stop and ask through the secretary on any payment, quota request, account or permission application, approval
  ticket, or terms. `airb init` (AirBuild) is such a step: it applies for a workspace and uploads the local SSH key.
- Signing, device installs and device tests stay on the mini.
- Deleting old remote checkouts or backups is a separate user decision.
- These runs take no `res` lock and no devbox slot. Release remote resources at the end and confirm none remain.

## Kross (remote Mac, iOS)

- Entry: `bytedcli --no-auto-upgrade --json kross ...` with the user's existing access; no checkout or account
  setup needed. `kross workspace list`; `kross template list --workspace test-public-workspace` (workspace 130,
  cluster 8) shows the `ios-dev` Mac template. Lifecycle: `workload create --workspace W --name N --template-id T`,
  `workload list`, `workload exec`, `workload upload`, `workload download`, `workload delete`.
- Image (measured 2026-11-18): macOS 26.3 arm64, Xcode 26.3 (17C529), iOS SDK 26.2, only `/Applications/Xcode.app`.
  No Xcode 27.x template; the image version is locked. CocoaPods is not on PATH. Public CDN reachable.
- Readiness is unreliable: phase 1 reached a shell 249 s after create (with retries); phase 2 never did in 640 s
  (every exec returned HTTP 409 `no suitable pod with container`). Create and delete take about 3 s.
- `workload exec` JSON can contain temporary webshell credentials: mask it before reading (the standard masker
  missed the webshell URL parameter; mask that too).
- Source reaches the machine by `workload upload` of an archive from the mini, or by cloning on the remote side if
  it has repository access (not verified). vesdk: commit `d0e184d46ce` exported to 22,394 files / 34.6 MiB
  compressed but had 2,966 unresolved LFS pointers, so resolve LFS before uploading.
- Not yet known: pinned internal pod/binary access, build time limits, cost per run, whether Xcode 26.3 builds
  vesdk. No vesdk build has run there yet.
- 2026-11-18 VAK W424 (first builds on Kross): two sequential `ios-dev` workloads reached a usable shell in about
  40 s each, each after one HTTP 409 (so retry exec for at least a minute before giving up). Guest: 4 CPUs / 8 GiB
  with 2 CPU / 8192 MB requested; Xcode 26.3, Swift 6.2.4, Ruby 2.6.10.
- A 143 MB archive (4,972 files) uploaded in 29 s; hash and extraction 9 s. SPM graph resolved in 11 s.
- Ruby 2.6.10 cannot `gem install cocoapods` from public sources (`public_suffix` needs Ruby >= 3.2). Install
  through the project's `Gemfile.lock` with Bundler (Bundler 2.3.27 installs in about 23 s).
- Internal Ruby, npm and iOS CDN roots answer 200 from the remote side; pinned internal artifacts are untested.
- VAK results on Xcode 26.3: XCTest build-for-testing passed (13 s and 11 s); the app's simulator build failed after
  79 s on one Swift type-check timeout that Xcode 27.1 tolerates, so the code needs a small change before 26.3 builds it.
- `kross workload exec` corrupts long multi-line commands on the Mac guest (text dropped mid-token, `exit_code` null
  although the shell failed): upload a script and run it with a short one-line command (VAK W436).
- `kross workload exec` can exit 0 while `data.exit_code` is 1: read the remote exit payload and the build log, not
  the CLI status.
- Workspace quota shows 100 CPU / 400 GiB RAM / 1000 GiB storage. Not shown anywhere: Mac concurrency limits,
  larger guest sizes, cache or snapshot persistence between workloads, the quota-increase path, billing.
- One orchestrator's pilot at a time until readiness is understood; keep each pilot to one workload.
- VAK task record: `~/code/.claude-data/orchestrator/video-agent/tasks/W424-ios-kross-build/report.md`.
- Task records: `~/.claude/jobs/9850afbb/tmp/task-remote-ios-pilot/` (`report.md`, `phase2-runbook.md`),
  `task-remote-ios-xcode27/report.md`, `task-remote-ios-phase2/report.md`.

## AirBuild (remote Mac Studio pool, iOS)

- CLI `airb` 0.1.149 installs task-locally. Existing access connects but the account has no workspace.
- `airb init` applies for a workspace and uploads the local SSH key: not run; needs the user's decision.
- Documentation describes Xcode 26; live versions unknown.

## BITS (pipelines)

- `bits client package trigger --app-id ... --source job --config-id ... --branch ...` builds from a branch without
  an MR. The `iOS:4.1` image has no Xcode of its own; the public pool documentation lists Xcode up to 26.0.
- No ready config exists for the three projects' demo apps. See skills `bits-package-validation` and
  `tiktok-ios-appstore-package` for the supported SDK/host packaging paths.

## RemoteX (Android)

Owner of the working recipe: Webview (vesdk-mainline task T192, continuing T126). Ask Webview for the wrapper
path before reuse.

- Entry: the repository's own `proj/android/start.sh` (vesdk). It reuses a checkout on the remote build machine
  and rsyncs the local worktree over it.
- `start.sh` uploads `.remoteX/code/config.json` regardless of ignore rules and has no option to skip it. Upload a
  task-local copy that keeps only the keys the remote side reads (`main.gitUrl`, `filePath`, `branch`, `commitId`,
  `branchForCid`, `commitTimestamp`, `userName`, `userEmail`, `repo`); leave the original untouched.
- Known hang and fix: CMake/Clang block when the AGP runner's stderr pipe fills. Redirect stderr to a file and
  keep stdin open (the CMake 3.10 server protocol needs it; `</dev/null` breaks it).
- Measured 2026-11-18 (Webview T192, vesdk vemo debug unsigned, commit a5e78a51539): cold 762 s, one-file change
  426 s, no change 579 s; sync 34-56 s; APK hash identical across the three runs. The "warm" runs are not warm: the
  sync deletes remote generated headers and metadata, so 1,111 native steps rebuild. Protecting generated files from
  the sync is under test (T195). The cold package lacked 4 BMF runtime libraries (first-configure input discovery):
  configure once first, or use the second build's package. Devbox 8 for comparison: cold about 30 min, warm 50-169 s.
- True warm build after the sync filter fix (Webview T195, official client): no-change rebuild 179 s total (sync
  35 s, 0 compiles, 0 links, same APK hash); one-line change 266 s remote phase (1 compile, 7 links); cold 721 s
  remote phase including toolchain bootstrap. The filter syncs every tracked file except keystores and protects
  remote generated headers, metadata, `.cxx`, `.gradle` and dependency caches. Use: cold builds, parallel packaging
  and overflow; daily incremental work stays on the devboxes (50-169 s warm). Remote runners differ in toolchain
  (one had no Java 11): bootstrap JDK 11, ccache and git-lfs in every run. The cold package still lacks 4 BMF
  libraries: deliver the second build's package. Report: `vesdk-mainline/tasks/T195/report.md`.
- The only supported entry (2026-11-19): `~/code/.claude-data/orchestrator/vesdk-mainline/tasks/T213/` `entry.sh`
  (hashes in `recipe-sha256s.json`, onboarding text in `onboarding-patch.md`), modes `--probe` and build. It assumes
  nothing on the runner (a new workspace can land on a fresh runner with no checkout, no client directory and no
  toolchain): bootstraps JDK 11, ccache and git-lfs (about 28 s fresh, under 1 s reused), sources the system profile
  before enabling `set -u`, passes the command through a file, and creates an empty `git init` when needed.
- Source handoff for pushed commits: the runner fetches the exact commit, submodules and LFS objects itself with its
  own access; we sync only the delta between the local tree and that commit (0 bytes in the verified run) and check a
  strict manifest. Full rsync of a tree is only for unpushed commits (a first full sync of 21,000 files plus LFS was
  reset by the peer twice). LFS: keep the object store in the reused workspace (749 s on a fresh runner, 25 s
  reused); pass include lists through a config file (a 350 KB list exceeds the argv limit).
- BMF libraries: run the dependency step the build script declares for `copyBmfSo` before assembling (shared
  `bmf.py` helper, also used on devbox 8) and gate on the 4 libraries; one assemble is then complete.
- Verified end to end on a5e78a51539 (T213): fetch 9.6 s, LFS 25 s, delta sync 1 s, dependencies 12.8 s, BMF step
  67.5 s, cold build 633.7 s, second pass 113.5 s, download 93 s, client total 1,033 s; 49 libraries, identical APK
  hash for cold, second pass, remote and downloaded copies; dependencies fetched with the runner's own access.
- Onboarding notes for another project: `~/code/.claude-data/orchestrator/vesdk-mainline/tasks/T192/remotex-onboarding.md`.
- The generic RemoteX client ships helper scripts with embedded credentials (`ws_client.sh` holds a private key;
  `remote_revert_repo.py`, `rsync_opt.sh` hold credential literals) and its `start.sh` uploads some helpers itself
  (VAK W438). Never read, print or copy these files; search them by name only. Ruling (BC-158, 2026-11-19): a client whose `start.sh` and helpers are
  byte-identical to the official package (compare sha256 only) may be used: the vendor's own credential going to its
  own service is the tool's designed behaviour. `start.sh` uploads `remote_revert_repo.py`, `upload_apk.sh` and
  `gen_apk_link.sh` itself, apart from the source sync. A client copy that does not match the official package is
  quarantined (moved, not deleted) and not used. Hash table: `vesdk-mainline/tasks/T198/hashes.md`.
- VAK Android: not pursued. Its builds already run warm on devboxes (assemble 59 s, JVM tests 16 s), below
  RemoteX's sync time alone.
