# Shared host samples

The sampler writes schema 1 to `host-samples/latest.json` below the shared resource directory. The top-level object has `schema` and `hosts`. Host identifiers match the capacity report (local hostname, mini2 cable hostname, devbox registry target hostname or IP). Each entry contains `schema: 1`, `host`, `at` (Unix seconds at probe start) and boolean `ok`. Successful observations contain cores, load1, load5, load15, totalGiB, memAvailableGiB and freeGiB. Darwin adds arch, pressure, freeInactiveGiB, compressorGiB, compressedLogicalGiB and swapGiB. Linux supplies io_some_avg10, io_some_avg60 and io_full_avg10 when available, in percent. Failed entries carry errorClass (auth, timeout, refused or other) and lastGood (previous success or null). Its timestamp retains its original meaning.

Readers may read latest.json during a sweep. Each host replacement is atomic. History files at `history/<host>/<UTC YYYY-MM-DD>.ndjson` contain one observation per line with the same fields, excluding lastGood. Today's file and the previous six UTC dates are retained. Failure retries are five minutes apart. The sampler prints host, outcome, history bytes and elapsed seconds per attempted observation.

## Shared admission readings

An installed machine.conf enables the reader by default. SHARED_SAMPLES=0 disables it for all hosts. SAMPLE_TTL defaults to 180 seconds. A failed, missing, stale, future, malformed or foreign observation uses the existing metric path. The allocator continues to check local memory policy, mini2 link and facts, and devbox I/O hysteresis.

From the shared directory, roll back with the following command (macOS sed). These settings take effect on the next evaluation.

    sed -i '' '/^[[:space:]]*SHARED_SAMPLES[[:space:]]*=/d' machine.conf && echo SHARED_SAMPLES=0 >> machine.conf

## Windowed admission

ADMISSION_WINDOW_SECONDS defaults to 600. Admission requires a fresh shared observation and at least three distinct valid history timestamps from matching hardware within the trailing window. The earliest and latest must span at least half the configured interval. The gate includes the current observation in the extrema. Insufficient coverage uses instantaneous load plus declared CPU, and instantaneous available memory minus declared memory. The same calculation feeds placement and capacity estimates for migrated hosts.

Let L be the largest observed load5, A the lowest available GiB, T physical memory, R the memory floor, C and M the outstanding declared CPU and memory. Charge max(L,C) cores. Before admitting a request (c,m), require max(L,C)+c ≤ load limit and min(A,T−M)−m ≥ R. Equivalently the memory headroom for new work is min(A−R,T−M−R). Disk still subtracts all reserved and requested disk from current free space. Pressure and I/O policy apply independently.

* On a quiet 14-core, 64 GiB host with an 8 GiB floor, a fresh 4-core/16 GiB lease, L=0.4 and A=60 leave 10 cores and 40 GiB for new work. The declaration counts before the build ramps.
* On the same host, two ramped 4-core/12 GiB builds plus untracked work yield L=11 and A=26. The scheduler charges 11 cores and leaves 18 GiB above the floor. Another 2-core/8 GiB claim fits. With instantaneous load 11 and available memory 26, the previous calculation would charge 19 cores and leave −6 GiB above the floor.

The host-wide maxima compare aggregate loads. They cannot distinguish a fresh claim from unrelated CPU use that already exceeds its declaration. Set the window to zero to restore additive accounting while retaining shared observations. From the shared directory run:

    sed -i '' '/^[[:space:]]*ADMISSION_WINDOW_SECONDS[[:space:]]*=/d' machine.conf && echo ADMISSION_WINDOW_SECONDS=0 >> machine.conf
