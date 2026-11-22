# Staged second Mac mini runner

`mini2-run.mjs` is a Darwin sibling of `devbox-run.mjs`. It reuses the tracked-source snapshot, content/history transfer gate and Git bundle protocol. One `mini2-exec-1` remote resource belongs to pool `mini2`; it remains `never` with `enabled:false` during qualification. Remote compute does not acquire a main-mini build or lane resource. Mini2 runs build commands only, never model workers.

## Transport and source boundary

Every operation resolves `Bytedances-Mac-mini.local` again, preserves the IPv6 zone, verifies the actual route uses the direct USB NCM interface discovered through IOKit, and uses the existing trusted host alias with strict host-key checking. There is no fixed address, alternate network route, key enrollment, agent forwarding or signing support. Thunderbolt is not used.

FileVault is **Off**, and decryption is complete. Mini2's disk is unencrypted: it must never receive signing material, keychains, tokens, keys, sessions or any other secrets. `--allowlist` is mandatory and contains exact regular tracked source paths. The runner rejects secret-looking names, symlinks, unlisted paths, submodules and untracked inputs before source-content reads or packaging. Every historical path in the bundle must also be allowed. The existing content/history gate then checks the approved snapshot. Repositories containing excluded files must be materialized into a new, reviewed source-only snapshot; adding an excluded path to the list cannot override the path check. Machine configuration, credentials and local application data are never copied.

## Admission and lifetime

The shared controller serializes config, FIFO admission and one-slot acquisition under a host guard. Both direct and pool routes check the default-off switch, registry capability, manual maintenance, link health, fresh metrics (under 5 minutes), fresh tool facts (under 1 hour), load5 <= 6, available memory >= 16 GiB, normal memory pressure, and >= 20 GiB disk remaining after the requested reservation. Unknown or stale evidence closes admission. The remote supervisor checks memory, load and disk again before execution. Qualification is limited to a mode-0600, two-hour grant for task `mini2-enable` and its named holder; it bypasses only the default-off switch and unqualified registry capability.

Builds use four workers. Every run owns a UUID directory under `~/mac-build-runner`. The controller uploads only the listed, hashed Git bundle/patch, verifies named regular artifacts, masks downloaded logs and requires a matching clean receipt before returning the resource. The Darwin supervisor records boot identity, PID/start identity, original-parent generations, process group, metrics and sampled process-tree RSS. It watches its SSH parent through connection termination, handles timeout/signals, and signals only recorded unchanged owned identities. Independent browser/indexing activity is ignored and counted; unknown attribution or any process with the workspace open retains the slot. No personal processes are terminated.

Clean completion removes the run's source workspace, uploaded bundle and cache while retaining receipts/logs. Transport loss, surviving descendants, unreadable attribution or incomplete artifact retention fail closed. The resource is not reclaimed merely because its local PID died. `reconcile` rechecks unchanged identities and open files, verifies retained artifacts, removes only owned scratch, and returns the matching lease. A changed boot or missing evidence requires investigation; do not manually delete the hold.

## Alarm and power recovery

The user measured real power-loss recovery on 2026-11-20: kernel boot at 14:39:48 PT, SSH by `.local` at 14:40:03, whole outage about 30 seconds, same host key, no local login, and intact tools/APFS. SSH should return by itself after reboot or power restoration.

The main mini's user LaunchAgent probes every 300 seconds. Two consecutive failed probes spanning at least 300 seconds close automatic admission and append one durable, deduplicated `[mini2-down]` owner alert: an outage lasting at least five minutes is a real problem and someone should check the machine. Two successes clear automatic maintenance and emit `[mini2-up]`. Manual maintenance suppresses delivery and cannot be cleared by successful probes. Config changes during a probe discard that observation. The outbox survives delivery failures. `res status` and `res audit` read stored evidence without SSH; facts refresh hourly through the monitor.

## Operation

Run from this checkout with Node 22.17.0 and Python 3. The installed LaunchAgent points at this checkout, which must remain present until the owner migrates it to the landed checkout.

```sh
# Read-only status and alarm simulation (simulation sends no alerts).
scripts/res/res mini2 status --json
python3 -B scripts/res/mini2_monitor.py --dry-run

# Before planned reboot or cable work; restore only after verification.
scripts/res/res mini2 configure --maintenance on
scripts/res/res mini2 configure --maintenance off
python3 -B scripts/res/mini2_monitor.py --once
python3 -B scripts/res/mini2_monitor.py --once

# Standard unsigned source-only run; allowlist is a JSON array of exact paths.
node scripts/mini2-run.mjs --repo /absolute/source-snapshot --allowlist /absolute/allowlist.json \
  --project example --task compile --by unique-wrapper --out /absolute/run-evidence \
  --need cmake-native --disk-gib 8 --timeout 20 --artifact build/result \
  -- cmake --build build --parallel 4

# Retry cleanup for this exact holder and retained run only.
node scripts/mini2-run.mjs reconcile --out /absolute/run-evidence --by unique-wrapper

# After an interrupted controller, preserve the build log and artifacts, inspect the
# remote run and reconcile it. For a dead PID the controller accepts a clean receipt
# bound to the exact lease generation, holder, and local PID.
scripts/res/res release-dead mini2-exec-1 --by "$holder" --pid "$dead_pid" --receipt "$clean_receipt"

# Disable new admission; existing owned execution must still complete/clean.
scripts/res/res mini2 configure --disable

# Remove this task's alarm if rolling back the installation.
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.bytedance.orchestrator.mini2-link.plist"
```

Enabling is a separate owner action after reviewed evidence and cleanup. The controller requires a successful measured summary with retained artifacts. Add `--ios-receipt` with a clean simulator build summary to admit unsigned iOS simulator compiles alongside CMake. Add `--ios-device-receipt` with a clean unsigned `iphoneos` arm64 app build summary to grant `xcode-ios-device-compile-unsigned` on mini2 with SDK 27.1. The exact command is recorded in the task report. No installation, energy/network/system setting or security change on mini2 is part of the runner.
