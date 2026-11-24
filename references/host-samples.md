# Shared host samples

The sampler writes schema 1 to `host-samples/latest.json` below the shared resource directory. The top-level object has `schema` and `hosts`. Host identifiers match the capacity report (local hostname, mini2 cable hostname, devbox registry target hostname or IP). Each entry contains `schema: 1`, `host`, `at` (Unix seconds at probe start) and boolean `ok`. Successful observations contain cores, load1, load5, load15, totalGiB, memAvailableGiB and freeGiB. Darwin adds arch, pressure, freeInactiveGiB, compressorGiB, compressedLogicalGiB and swapGiB. Linux supplies io_some_avg10, io_some_avg60 and io_full_avg10 when available, in percent. Failed entries carry errorClass (auth, timeout, refused or other) and lastGood (previous success or null). Its timestamp retains its original meaning.

Readers may read latest.json during a sweep. Each host replacement is atomic. History files at `history/<host>/<UTC YYYY-MM-DD>.ndjson` contain one observation per line with the same fields, excluding lastGood. Today's file and the previous six UTC dates are retained. Failure retries are five minutes apart. The sampler prints host, outcome, history bytes and elapsed seconds per attempted observation.

## Shared admission readings

An installed machine.conf enables the reader by default. SHARED_SAMPLES=0 disables it for all hosts. SAMPLE_TTL defaults to 180 seconds. A failed, missing, stale, future, malformed or foreign observation uses the existing metric path. The allocator continues to check local memory policy, mini2 link and facts, and devbox I/O hysteresis.

From the shared directory, roll back with the following command (macOS sed). These settings take effect on the next evaluation.

    sed -i '' '/^[[:space:]]*SHARED_SAMPLES[[:space:]]*=/d' machine.conf && echo SHARED_SAMPLES=0 >> machine.conf

## Windowed admission

ADMISSION_WINDOW_SECONDS defaults to 600. Admission requires a fresh shared observation and at least three distinct valid history timestamps from matching hardware within the trailing window. The earliest and latest must span at least half the configured interval. The gate includes the current observation in the extrema. Insufficient coverage uses instantaneous load plus declared CPU, and instantaneous available memory minus declared memory. The same calculation feeds placement and capacity estimates for migrated hosts.

Let W be the configured window, L the largest observed load5, A the lowest available GiB, T physical memory and R the memory floor. A live claim is young when acquired less than W seconds ago; missing, invalid or future acquisition times also count as young. Claims acquired at least W seconds ago are old. Use the original hold acquisition time even when its reservation observation is refreshed. C_young and C_old are the two groups' declared cores; M_young and M_all are young and all declared memory GiB.

Charge max(L,C_old)+C_young cores. Before admitting a request (c,m), require max(L,C_old)+C_young+c ≤ load limit and min(A−M_young,T−M_all)−m ≥ R. Equivalently the memory headroom for new work is min(A−M_young−R,T−M_all−R). Old declarations overlap observed usage in aggregate; young declarations are fully added to the window extrema because their demand may not have ramped yet. With no young claims this equals max(L,C_all) and min(A,T−M_all), the original window formula. Disk still subtracts all reserved and requested disk from current free space. Pressure and I/O policy apply independently.

* On a quiet 14-core, 64 GiB host with an 8 GiB floor, a fresh 4-core/16 GiB lease, L=0.4 and A=60 yield C_old=0 and C_young=4. The charge is 4.4 cores, leaving 9.6 cores and min(60−16,64−16)−8=36 GiB for new work. The declaration counts in full before the build ramps.
* On the same host, two ramped 4-core/12 GiB builds acquired at least W seconds ago plus untracked work yield L=11 and A=26. C_old=8 and C_young=0 charge 11 cores and leave min(26,64−24)−8=18 GiB above the floor. Another 2-core/8 GiB claim fits. With instantaneous load 11 and available memory 26, additive accounting would charge 19 cores and leave −6 GiB above the floor.
* On a 14-core host, untracked load L=8 plus a 4-core claim acquired one minute ago (W=600) charge max(8,0)+4=12. Only 2 more cores fit. The original max(8,4)=8 charge would admit 6 more cores, letting total demand reach 18.

Young claims that have already ramped can conservatively overlap the observed peak until they age out of W; aggregate samples do not identify each claim's usage. Set the window to zero to restore additive accounting while retaining shared observations. From the shared directory run:

    sed -i '' '/^[[:space:]]*ADMISSION_WINDOW_SECONDS[[:space:]]*=/d' machine.conf && echo ADMISSION_WINDOW_SECONDS=0 >> machine.conf

## Decision and claim records

The allocators append schema-1 JSON to host-samples/admission.ndjson and claims.ndjson. Each is a hard link to the current UTC date's file (for example admission.2026-11-23.ndjson). Consume either the dated series or the current alias. Writers keep 14 UTC dates on rollover. The report reads each dated file once. Local filesystem failures can leave gaps. Allocation does not wait on the rotation lock. Resource observations and status queries do not count as requests.

Each admission record gives Unix time, host, project/task, profile, cost [cores, memory GiB, disk GiB], outcome, gate, source, readings, and available decision evidence. Reserved weights use the same order; limits are CPU ceiling, memory floor and disk floor. Window statistics include sample count, coverage in seconds, peak and trough when used, plus youngCores, oldCores, youngGiB and oldGiB for the live declarations. These age totals are also recorded when coverage falls back to additive accounting. Gates checked before capacity can have missing measurements. A polling waiter can produce multiple refusals. Records omit purpose, command lines and remote error text. Identifiers that cannot be safely recorded appear as [masked].

Each completed claim includes declared weights, duration, and host peak load5 and lowest available memory observed during its lifetime. Baseline means the last valid sample strictly before the start, within five minutes. CPU delta = max(0, peak − baseline load5); memory delta = max(0, baseline available − minimum available). Missing either side yields null. The seven-day sample retention bounds coverage. With concurrent claims the host-wide delta is a shared upper-bound estimate for attribution; overlapping claims may report the same change. Sparse sampling and five-minute load averaging can miss short peaks.

Run `res capacity-report --days 7` for JSON grouped by project and profile. The default is 14 days. Counts include completed and measured claims plus refusals by gate. Percentiles use nearest rank (p50, p90, max); null is missing evidence. Declared disk is reported in GiB. Calibration remains manual.
