#!/bin/bash
# T86 checks: every mutable resource is in a fresh scratch RES_DIR.
set -euo pipefail
SOURCE=$(cd "$(dirname "$0")" && pwd)
RES=${T86_RES:-$SOURCE/stage/res}
ROOT=$(mktemp -d "$SOURCE/check.XXXXXX")
export RES_DIR="$ROOT/scratch"
mkdir -p "$RES_DIR/locks" "$RES_DIR/notes"
printf 'heavy-build\tslot\topen\t-\tscratch build\nheavy-lane-1\tslot\topen\t-\tscratch lane\nheavy-lane-2\tslot\topen\t-\tscratch lane\n' >"$RES_DIR/resources.tsv"
export RES_TEST_METRICS=1 RES_TEST_LOAD1M=8 RES_TEST_MEMORYSTATUS_LEVEL=37
export RES_TEST_MEMSIZE=68719476736
export RES_TEST_SWAPUSAGE='total = 36864.00M  used = 36273.62M  free = 590.38M  (encrypted)'
OUT="$ROOT/last-output.txt"
COUNT=0
pass() { COUNT=$((COUNT + 1)); printf 'PASS %03d: %s\n' "$COUNT" "$*"; }
fail() { sed -n '1,80p' "$OUT" >&2; printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() {
  local expected="$1" rc=0; shift
  "$@" >"$OUT" 2>&1 || rc=$?
  [ "$rc" = "$expected" ] || fail "expected exit $expected, got $rc: $*"
  pass "exit $expected: $*"
}
contains() { grep -F -- "$1" "$OUT" >/dev/null || fail "missing $1"; pass "$1"; }
pages() {
  printf -v RES_TEST_VM_STAT 'Mach Virtual Memory Statistics: (page size of %s bytes)\nPages free: %s.\nPages inactive: %s.\nPages speculative: %s.\nPages active: 3000000.\nPages wired down: 1000000.\nPages occupied by compressor: 2000000.\n' \
    "${4:-16384}" "$1" "${2:-0}" "${3:-0}"
  export RES_TEST_VM_STAT
}
free_slot() {
  [ ! -d "$RES_DIR/locks/$1.d" ] || fail "gate acquired $1"
  pass "$1 remains free"
}
release() { expect 0 "$RES" return "$1" --by T86; }
printf 'SCRATCH_ROOT=%s\nRES=%s\n' "$ROOT" "$RES"

# The reported disagreement: OS availability permits work despite low page headroom.
pages 763494
expect 0 "$RES" heavy-check
contains 'load1m=8.00 limit=12 lanes_held=0 avail=23.68GiB (memorystatus 37%) pages_headroom=11.65GiB swap_used=35.42GiB gate=OK'
pages 0
expect 0 "$RES" heavy-check
contains 'pages_headroom=0.00GiB'
RES_TEST_MEMORYSTATUS_LEVEL=24
pages 2097152
expect 5 "$RES" heavy-check
contains 'avail=15.36GiB (memorystatus 24%) pages_headroom=32.00GiB'

# Thresholds compare unrounded readings; load 12 and available 16 are allowed.
RES_TEST_MEMORYSTATUS_LEVEL=25 RES_TEST_LOAD1M=12
expect 0 "$RES" heavy-check
contains 'load1m=12.00 limit=12 lanes_held=0 avail=16.00GiB'
RES_TEST_LOAD1M=12.001
expect 5 "$RES" heavy-check
RES_TEST_LOAD1M=12 RES_TEST_MEMSIZE=68719476735
expect 5 "$RES" heavy-check
contains 'avail=16.00GiB'
RES_TEST_MEMSIZE=68719476736 RES_TEST_LOAD1M=8
for level in 0 100; do
  RES_TEST_MEMORYSTATUS_LEVEL="$level"
  expected=0; [ "$level" != 0 ] || expected=5
  expect "$expected" "$RES" heavy-check
done
RES_TEST_MEMORYSTATUS_LEVEL=50 RES_TEST_MEMSIZE=34359738368
expect 0 "$RES" heavy-check
contains 'avail=16.00GiB (memorystatus 50%)'
RES_TEST_MEMSIZE=68719476736

# Missing sysctl alone permits the old free+inactive+speculative fallback.
RES_TEST_MEMORYSTATUS_LEVEL=missing RES_TEST_LOAD1M=12
pages 1048576
expect 0 "$RES" heavy-check
contains 'avail=16.00GiB (memorystatus unavailable; pages fallback)'
pages 1048575
expect 5 "$RES" heavy-check
contains 'avail=16.00GiB'
pages 4194304 0 0 4096
expect 0 "$RES" heavy-check
pages 0 1048500 76
expect 0 "$RES" heavy-check
pages 0
expect 5 "$RES" heavy-check

# Invalid readings fail closed rather than silently falling back.
pages 2097152
for level in '' bad -1 101 37.5 '37%'; do
  RES_TEST_MEMORYSTATUS_LEVEL="$level"
  expect 1 "$RES" heavy-check
done
RES_TEST_MEMORYSTATUS_LEVEL=37
for load in '' bad -1; do
  RES_TEST_LOAD1M="$load"
  expect 1 "$RES" heavy-check
done
RES_TEST_LOAD1M=8
for ram in '' bad -1 0 68719476736.0; do
  RES_TEST_MEMSIZE="$ram"
  expect 1 "$RES" heavy-check
done
RES_TEST_MEMSIZE=68719476736
pages bad
expect 1 "$RES" heavy-check
pages 1048576 0 0 0
expect 1 "$RES" heavy-check
RES_TEST_VM_STAT='missing pages'
expect 1 "$RES" heavy-check
pages 763494
for swap in '' 'used = bad' 'used = -1M' 'free = 10M'; do
  RES_TEST_SWAPUSAGE="$swap"
  expect 1 "$RES" heavy-check
done
for swap in 'used = 1048576K' 'used = 1024M' 'used = 1G' 'used = 0.0009765625T'; do
  RES_TEST_SWAPUSAGE="$swap"
  expect 0 "$RES" heavy-check
  contains 'swap_used=1.00GiB'
done
RES_TEST_SWAPUSAGE='used = 0M'
expect 1 "$RES" heavy-check --unknown

# All heavy waits use OS availability; plain take remains ungated.
RES_TEST_MEMORYSTATUS_LEVEL=37
for id in heavy-build heavy-lane-1 heavy-lane-2; do
  expect 0 "$RES" wait "$id" --by T86 --project test --for available --pid "$$" --timeout 0
  [ -d "$RES_DIR/locks/$id.d" ] || fail "wait did not acquire $id"
  pass "$id acquired despite low pages"
  release "$id"
  RES_TEST_MEMORYSTATUS_LEVEL=24
  pages 2097152
  expect 2 "$RES" wait "$id" --by T86 --project test --for low --pid "$$" --timeout 0
  free_slot "$id"
  RES_TEST_MEMORYSTATUS_LEVEL=37 RES_TEST_LOAD1M=12.001
  expect 2 "$RES" wait "$id" --by T86 --project test --for load --pid "$$" --timeout 0
  free_slot "$id"
  RES_TEST_LOAD1M=8 RES_TEST_MEMORYSTATUS_LEVEL=bad
  expect 1 "$RES" wait "$id" --by T86 --project test --for invalid --pid "$$" --timeout 0
  free_slot "$id"
  RES_TEST_MEMORYSTATUS_LEVEL=37
  pages 763494
done
RES_TEST_MEMORYSTATUS_LEVEL=0 RES_TEST_LOAD1M=99
expect 0 "$RES" take heavy-build --by T86 --project test --for ungated --pid "$$"
release heavy-build

# Reject test overrides against the live directory and aliases without any hold command.
expect 1 env RES_DIR="$HOME/.claude/orchestrator/_shared" "$RES" heavy-check
contains 'test metrics require a scratch RES_DIR'
ln -s "$HOME/.claude/orchestrator/_shared" "$ROOT/live-alias"
expect 1 env RES_DIR="$ROOT/live-alias" "$RES" heavy-check
contains 'test metrics require a scratch RES_DIR'

# Exercise the production probes, including real sysctl failure discrimination.
RES_TEST_MEMORYSTATUS_LEVEL=37 RES_TEST_LOAD1M=8
export PATH="$SOURCE/mocks:$PATH"
export RES_TEST_METRICS=0 RES_TEST_SYSCTL_STATUS=ok
expect 0 "$RES" heavy-check
contains '(memorystatus 37%)'
RES_TEST_SYSCTL_STATUS=missing
pages 1048576
expect 0 "$RES" heavy-check
contains '(memorystatus unavailable; pages fallback)'
RES_TEST_SYSCTL_STATUS=error
expect 1 "$RES" heavy-check
contains 'cannot read macOS memorystatus level'
RES_TEST_SYSCTL_STATUS=ok RES_TEST_MEMORYSTATUS_LEVEL=bad
expect 1 "$RES" heavy-check
RES_TEST_MEMORYSTATUS_LEVEL=37
expect 1 env RES_TEST_MEMSIZE_FAILURE=1 "$RES" heavy-check
contains 'cannot read physical memory'
expect 1 env RES_TEST_SWAP_FAILURE=1 "$RES" heavy-check
contains 'cannot read swap usage'
expect 1 env RES_TEST_VM_STAT_FAILURE=1 "$RES" heavy-check
expect 1 env RES_TEST_LOAD_FAILURE=1 "$RES" heavy-check

# Linux retains MemAvailable and the existing headroom diagnostic.
expect 0 env RES_TEST_OS=Linux "$RES" heavy-check
contains 'headroom='
[ -z "$(find "$RES_DIR/locks" -mindepth 1 -print -quit)" ] || fail 'scratch hold leaked'
pass 'all scratch locks empty; no live hold commands'
printf '\nALL %s ASSERTIONS PASSED\n' "$COUNT"
