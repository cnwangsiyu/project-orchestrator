#!/bin/bash
# T88: only scratch state is modified; holder processes are never signalled.
set -euo pipefail
SOURCE=$(cd "$(dirname "$0")" && pwd)
RES=${T88_RES:-$SOURCE/stage/res}
ROOT=$(mktemp -d "$SOURCE/check.XXXXXX")
export RES_DIR="$ROOT/scratch"
mkdir -p "$RES_DIR/locks" "$RES_DIR/notes" "$ROOT/snapshots"
printf 'heavy-build\tslot\topen\t-\tscratch build\nheavy-lane-1\tslot\topen\t-\tscratch lane\nheavy-lane-2\tslot\topen\t-\tscratch lane\n' >"$RES_DIR/resources.tsv"
export RES_TEST_METRICS=1 RES_TEST_LOAD1M=11 RES_TEST_MEMORYSTATUS_LEVEL=37
export RES_TEST_MEMSIZE=68719476736 RES_TEST_SWAPUSAGE='used = 0M'
export RES_TEST_VM_STAT=$'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1048576.\nPages inactive: 0.\nPages speculative: 0.'
OUT="$ROOT/last-output.txt"
COUNT=0
other_pid="$PPID"
dead=2147483647
host=$(hostname)
ps -p "$other_pid" -o pid= >/dev/null
[ "$other_pid" != "$$" ]
if ps -p "$dead" -o pid= >/dev/null 2>&1; then
  printf 'Dead-PID fixture is alive; refusing test\n' >&2
  exit 1
fi
pass() { COUNT=$((COUNT + 1)); printf 'PASS %03d: %s\n' "$COUNT" "$*"; }
fail() { sed -n '1,100p' "$OUT" >&2; printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() {
  local expected="$1" rc=0; shift
  "$@" >"$OUT" 2>&1 || rc=$?
  [ "$rc" = "$expected" ] || fail "expected exit $expected, got $rc: $*"
  pass "exit $expected: $*"
}
contains() { grep -F -- "$1" "$OUT" >/dev/null || fail "missing $1"; pass "$1"; }
hold() { expect 0 "$RES" take "$1" --by "fixture-$1" --project scratch --for fixture --pid "$2"; }
release() { expect 0 "$RES" return "$1" --by T88; }
clear_holds() {
  rm -rf "$RES_DIR/locks"
  mkdir "$RES_DIR/locks"
}
snapshot() {
  cp "$RES_DIR/resources.tsv" "$ROOT/snapshots/resources.tsv"
  cp "${RES_DIR}/log.tsv" "$ROOT/snapshots/log.tsv"
  cp -R "$RES_DIR/locks" "$ROOT/snapshots/locks"
}
unchanged() {
  cmp "$RES_DIR/resources.tsv" "$ROOT/snapshots/resources.tsv" || fail 'check changed registry'
  cmp "$RES_DIR/log.tsv" "$ROOT/snapshots/log.tsv" || fail 'check changed history'
  diff -r "$RES_DIR/locks" "$ROOT/snapshots/locks" || fail 'check changed holds'
  rm -rf "$ROOT/snapshots/locks"
  pass 'heavy-check is read-only'
}
touch "$RES_DIR/log.tsv"
printf 'SCRATCH_ROOT=%s\nRES=%s\n' "$ROOT" "$RES"

# 0/1/2 other lanes x load 11/15/21 x memory okay/low, through both interfaces.
for held in 0 1 2; do
  clear_holds
  [ "$held" -lt 1 ] || hold heavy-lane-1 "$other_pid"
  [ "$held" -lt 2 ] || hold heavy-lane-2 "$other_pid"
  limit=12
  [ "$held" -eq 0 ] || limit=20
  for load in 11 15 21; do
    RES_TEST_LOAD1M="$load"
    for memory in ok low; do
      RES_TEST_MEMORYSTATUS_LEVEL=37
      avail=23.68
      [ "$memory" != low ] || { RES_TEST_MEMORYSTATUS_LEVEL=24; avail=15.36; }
      gate_rc=0
      gate=OK
      if [ "$load" -gt "$limit" ] || [ "$memory" = low ]; then
        gate_rc=5
        gate=OVERLOADED
      fi
      printf '\nMATRIX lanes=%s load=%s memory=%s\n' "$held" "$load" "$memory"
      snapshot
      expect "$gate_rc" "$RES" heavy-check --pid "$$"
      contains "load1m=$load.00 limit=$limit lanes_held=$held avail=${avail}GiB"
      contains "gate=$gate"
      unchanged
      for id in heavy-build heavy-lane-1 heavy-lane-2; do
        occupied=0
        [ ! -d "$RES_DIR/locks/$id.d" ] || occupied=1
        expected=0
        if [ "$gate_rc" = 5 ] || [ "$occupied" = 1 ]; then expected=2; fi
        expect "$expected" "$RES" wait "$id" --by T88 --project scratch --for matrix --pid "$$" --timeout 0
        contains "load1m=$load.00 limit=$limit lanes_held=$held avail=${avail}GiB"
        contains "gate=$gate"
        if [ "$expected" = 0 ]; then
          [ -d "$RES_DIR/locks/$id.d" ] || fail "wait did not acquire $id"
          release "$id"
        elif [ "$occupied" = 0 ]; then
          [ ! -d "$RES_DIR/locks/$id.d" ] || fail "overloaded wait acquired $id"
        else
          [ "$(awk -F '\t' '$1=="pid" {print $2}' "$RES_DIR/locks/$id.d/info")" = "$other_pid" ] || fail 'wait changed other holder'
        fi
        pass "wait preserves busy/free ownership: $id"
      done
    done
  done
done

# Boundaries use unrounded values; two lanes never increase the limit beyond 20.
clear_holds
RES_TEST_MEMORYSTATUS_LEVEL=25 RES_TEST_LOAD1M=12
expect 0 "$RES" heavy-check
contains 'limit=12 lanes_held=0 avail=16.00GiB'
RES_TEST_LOAD1M=12.001
expect 5 "$RES" heavy-check
hold heavy-lane-1 "$other_pid"
RES_TEST_LOAD1M=20
expect 0 "$RES" heavy-check
contains 'limit=20 lanes_held=1'
RES_TEST_LOAD1M=20.001
expect 5 "$RES" heavy-check
hold heavy-lane-2 "$other_pid"
RES_TEST_LOAD1M=21
expect 5 "$RES" heavy-check
contains 'limit=20 lanes_held=2'
RES_TEST_LOAD1M=20 RES_TEST_MEMSIZE=68719476735
expect 5 "$RES" heavy-check
contains 'avail=16.00GiB'
RES_TEST_MEMSIZE=68719476736 RES_TEST_MEMORYSTATUS_LEVEL=37

# STALE is excluded immediately, not only when old enough to reclaim.
clear_holds
hold heavy-lane-1 "$dead"
RES_TEST_LOAD1M=15
snapshot
expect 5 "$RES" heavy-check
contains 'limit=12 lanes_held=0'
unchanged
RES_TEST_LOAD1M=11
expect 2 "$RES" wait heavy-lane-1 --by T88 --project scratch --for young-stale --pid "$$" --timeout 0
contains 'limit=12 lanes_held=0'
[ -d "$RES_DIR/locks/heavy-lane-1.d" ] || fail 'young stale hold was reclaimed'
pass 'young STALE is ignored by gate but not reclaimed'
hold heavy-lane-2 "$other_pid"
RES_TEST_LOAD1M=15
expect 0 "$RES" heavy-check
contains 'limit=20 lanes_held=1'

# Default and explicit caller PIDs exclude their own hold; wait must pass its PID.
clear_holds
hold heavy-lane-1 "$$"
expect 5 "$RES" heavy-check
contains 'limit=12 lanes_held=0'
expect 5 "$RES" heavy-check --pid "$$"
expect 0 "$RES" heavy-check --pid "$other_pid"
contains 'limit=20 lanes_held=1'
expect 2 "$RES" wait heavy-build --by T88 --project scratch --for own-default --timeout 0
contains 'limit=12 lanes_held=0'
clear_holds
hold heavy-lane-1 "$other_pid"
expect 2 "$RES" wait heavy-build --by T88 --project scratch --for own-explicit --pid "$other_pid" --timeout 0
contains 'limit=12 lanes_held=0'
hold heavy-lane-2 "$$"
expect 0 "$RES" wait heavy-build --by T88 --project scratch --for mixed-explicit --pid "$other_pid" --timeout 0
contains 'limit=20 lanes_held=1'
[ "$(awk -F '\t' '$1=="pid" {print $2}' "$RES_DIR/locks/heavy-build.d/info")" = "$other_pid" ] || fail 'gate changed wait PID'
pass 'wait keeps selected PID for acquisition'
release heavy-build

# Retry sampling tracks a new other lane, and lowers the limit when it leaves.
clear_holds
(
  sleep 1
  "$RES" take heavy-lane-1 --by retry-fixture --project scratch --for retry --pid "$other_pid" >"$ROOT/retry-take.txt" 2>&1
) & changer=$!
expect 0 "$RES" wait heavy-build --by T88 --project scratch --for retry-lane-enters --pid "$$" --timeout 0.1
contains 'load1m=15.00 limit=12 lanes_held=0'
contains 'load1m=15.00 limit=20 lanes_held=1'
wait "$changer"
release heavy-build
hold heavy-build "$other_pid"
(
  sleep 1
  "$RES" return heavy-lane-1 --by retry-fixture >"$ROOT/retry-return-lane.txt" 2>&1
  "$RES" return heavy-build --by fixture-heavy-build >"$ROOT/retry-return-build.txt" 2>&1
) & changer=$!
expect 2 "$RES" wait heavy-build --by T88 --project scratch --for retry-lane-leaves --pid "$$" --timeout 0.1
contains 'load1m=15.00 limit=20 lanes_held=1'
contains 'load1m=15.00 limit=12 lanes_held=0'
wait "$changer"
[ ! -d "$RES_DIR/locks/heavy-build.d" ] || fail 'retry acquired build after threshold dropped'
pass 'retry recalculates lane-aware limit before acquisition'

# The full-build mutex and non-heavy resources are not lanes.
clear_holds
hold heavy-build "$other_pid"
expect 5 "$RES" heavy-check
contains 'limit=12 lanes_held=0'
mkdir "$RES_DIR/locks/checkout.d"
printf 'pid\t%s\nhost\t%s\n' "$other_pid" "$host" >"$RES_DIR/locks/checkout.d/info"
expect 5 "$RES" heavy-check
contains 'limit=12 lanes_held=0'

# Unverifiable remote/legacy/incomplete holds count conservatively; all lane IDs count.
for fixture in remote legacy missing-host incomplete; do
  clear_holds
  mkdir "$RES_DIR/locks/heavy-lane-1.d"
  case "$fixture" in
    remote) printf 'pid\t%s\nhost\tremote-fixture\n' "$dead" >"$RES_DIR/locks/heavy-lane-1.d/info" ;;
    legacy) printf 'by\tlegacy-fixture\n' >"$RES_DIR/locks/heavy-lane-1.d/info" ;;
    missing-host) printf 'pid\t%s\n' "$dead" >"$RES_DIR/locks/heavy-lane-1.d/info" ;;
    incomplete) ;;
  esac
  snapshot
  expect 0 "$RES" heavy-check
  contains 'limit=20 lanes_held=1'
  unchanged
done
mkdir "$RES_DIR/locks/heavy-lane-extra.d" "$RES_DIR/locks/heavy-lane-third.d"
RES_TEST_LOAD1M=21
expect 5 "$RES" heavy-check
contains 'limit=20 lanes_held=3'

# Optional PID parsing preserves prior no-option usage and fails invalid input closed.
for pid in 0 00 -1 bad ''; do
  expect 1 "$RES" heavy-check --pid "$pid"
done
expect 1 "$RES" heavy-check --pid
expect 1 "$RES" heavy-check --unknown

# Verify Linux uses the same lane-count/limit math (proc readings mocked on macOS).
clear_holds
hold heavy-lane-1 "$other_pid"
RES_TEST_LOAD1M=15
expect 0 env PATH="$SOURCE/memory/mocks:$PATH" RES_TEST_OS=Linux "$RES" heavy-check --pid "$$"
contains 'load1m=8.00 limit=20 lanes_held=1 avail=16.00GiB headroom=16.00 GiB gate=OK'
clear_holds
pass 'scratch cleanup complete; no live hold commands'
printf '\nALL %s ASSERTIONS PASSED\n' "$COUNT"
