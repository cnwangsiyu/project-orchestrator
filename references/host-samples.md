# Shared host samples

The sampler writes schema 1 to `host-samples/latest.json` below the shared resource directory. The top-level object has `schema` and `hosts`. Host identifiers match the capacity report (local hostname, mini2 cable hostname, devbox registry target hostname or IP). Each entry contains `schema: 1`, `host`, `at` (Unix seconds at probe start) and boolean `ok`. Successful observations contain cores, load1, load5, load15, totalGiB, memAvailableGiB and freeGiB. Darwin adds arch, pressure, freeInactiveGiB, compressorGiB, compressedLogicalGiB and swapGiB. Linux supplies io_some_avg10, io_some_avg60 and io_full_avg10 when available, in percent. Failed entries carry errorClass (auth, timeout, refused or other) and lastGood (previous success or null). Its timestamp retains its original meaning.

Readers may read latest.json during a sweep. Each host replacement is atomic. History files at `history/<host>/<UTC YYYY-MM-DD>.ndjson` contain one observation per line with the same fields, excluding lastGood. Today's file and the previous six UTC dates are retained. Failure retries are five minutes apart. The sampler prints host, outcome, history bytes and elapsed seconds per attempted observation.

## Shared admission readings

An installed machine.conf enables the reader by default. SHARED_SAMPLES=0 disables it for all hosts. SAMPLE_TTL defaults to 180 seconds. A failed, missing, stale, future, malformed or foreign observation uses the existing metric path. The allocator continues to check local memory policy, mini2 link and facts, and devbox I/O hysteresis.

From the shared directory, roll back with the following command (macOS sed). These settings take effect on the next evaluation.

    sed -i '' '/^[[:space:]]*SHARED_SAMPLES[[:space:]]*=/d' machine.conf && echo SHARED_SAMPLES=0 >> machine.conf
