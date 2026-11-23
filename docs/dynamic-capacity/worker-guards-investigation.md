# Worker guards flake investigation

The brief reported one `worker-guards-scenarios.mjs` failure in the parallel
2026-11-22 run, followed by two isolated passes. The failing assertion and its
masked log were not supplied. The suite and its transport remain unchanged from
the `5549bf2` baseline in this follow-up.

## Reproduction attempts

- Three concurrent, independent invocations: all three passed `56/56`.
- Five further invocations alongside the full fixture suite: all five passed
  `56/56`. The full runner and guards used independent scratch homes/directories.
- All eight dedicated runs exited zero. Named masked evidence is in the owner's
  task directory: `guards-baseline-1.log` through `guards-baseline-3.log` and
  `guards-with-suite-1.log` through `guards-with-suite-5.log`.

The full-suite command used for the overlap was:

```sh
env -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u RES_DIR -u RULES_SHARED node scripts/test/run-all.mjs --list-failing
```

## Dependency checks and disposition

The suite creates a unique `mkdtemp` root and resolves its native path before
building per-case homes and public state. Its WebSocket transport is in-memory;
the configured loopback URL is not a bound hub port. The setup fixture mocks its
catalog command. Short setup/control deadlines (180 ms) and the five-second
child watchdog are timing-sensitive candidates, not demonstrated causes.

No timing, port or temp-directory failure was reproduced in these runs. No
watchdog increase, transport delay or production change is justified by this
evidence. Preserve the named failing assertion and masked log if it recurs,
then test that specific dependency rather than changing unrelated timeouts.
