#!/bin/bash
# Lightweight contract/regression tests. All mutable state and probes are scratch.
set -euo pipefail
SOURCE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(mktemp -d "$SOURCE/check.XXXXXX")
RES=${T83_RES:-$SOURCE/stage/res}
BASELINE=$SOURCE/backup/res
export RES_DIR="$ROOT/scratch"
export PATH="$SOURCE/mocks:$PATH"
export FIXTURE_DIR="$ROOT/fixtures"
mkdir -p "$RES_DIR/locks" "$RES_DIR/notes" "$FIXTURE_DIR" "$ROOT/evidence"
cp "$SOURCE/stage/resources.tsv" "$RES_DIR/resources.tsv"
cp "$SOURCE/stage/heavy-build.md" "$RES_DIR/notes/heavy-build.md"
printf 'SCRATCH_ROOT=%s\n' "$ROOT"
COUNT=0
OUT="$ROOT/evidence/last-output.txt"
holder=''
releaser=''
starting_child=''
stop_child() {
  [ -n "$1" ] || return 0
  kill -TERM "$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}
cleanup_children() {
  trap - EXIT
  trap '' INT TERM HUP
  case "$starting_child" in
    holder) [ -n "$holder" ] || holder="${!:-}" ;;
    releaser) [ -n "$releaser" ] || releaser="${!:-}" ;;
  esac
  stop_child "$holder"; stop_child "$releaser"
}
trap cleanup_children EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
wait_for_retry() {
  local deadline=$((SECONDS + 10))
  until grep -Fq 'retry in 1s' "$OUT"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { COUNT=$((COUNT + 1)); printf 'PASS %02d: %s\n' "$COUNT" "$*"; }
expect() {
  local expected="$1" rc=0; shift
  "$@" >"$OUT" 2>&1 || rc=$?
  [ "$rc" = "$expected" ] || { sed -n '1,140p' "$OUT" >&2; fail "expected $expected, got $rc: $*"; }
  pass "exit $expected: $*"
}
contains() { grep -F -- "$1" "${2:-$OUT}" >/dev/null || fail "missing '$1'"; pass "contains '$1'"; }
absent() { if grep -F -- "$1" "${2:-$OUT}" >/dev/null; then fail "unexpected '$1'"; fi; pass "absent '$1'"; }
field() { awk -F '\t' -v k="$2" '$1 == k {print $2}' "$RES_DIR/locks/$1.d/info"; }
gate() {
  printf '%s\n' "$1" >"$FIXTURE_DIR/load"
  printf '%s\n' "$2" >"$FIXTURE_DIR/free"
  printf '%s\n' "${3:-16384}" >"$FIXTURE_DIR/page-size"
  printf '0\n' >"$FIXTURE_DIR/inactive"
  printf '0\n' >"$FIXTURE_DIR/speculative"
}
release() { expect 0 "$RES" return "$1" --by "${2:-owner}"; }
new_hold() {
  expect 0 "$RES" take "$1" --by owner --project test --for fixture --task T83 --pid "${2:-$$}"
}
change_info() {
  awk -F '\t' -v k="$2" -v v="$3" 'BEGIN {OFS="\t"} $1 == k {$2 = v} {print}' \
    "$RES_DIR/locks/$1.d/info" >"$FIXTURE_DIR/info.tmp"
  mv "$FIXTURE_DIR/info.tmp" "$RES_DIR/locks/$1.d/info"
}
epoch=1794564000
printf '%s\n' "$epoch" >"$FIXTURE_DIR/epoch"
# Use an out-of-range-for-this-host PID in stale fixtures: a real exited PID can
# be reused by unrelated work while the longer regression suite is still running.
dead=2147483647
host=$(hostname)

# Gate threshold comparisons use full precision, not the rounded display.
gate 12 1048576
expect 0 "$RES" heavy-check
contains 'load1m=12.00 limit=12 lanes_held=0 avail=16.00GiB (memorystatus unavailable; pages fallback) pages_headroom=16.00GiB'
gate 12.001 1048576
expect 5 "$RES" heavy-check
gate 1 1048575
expect 5 "$RES" heavy-check
gate 1 4194304 4096
expect 0 "$RES" heavy-check
gate 1 0
printf '1048500\n' >"$FIXTURE_DIR/inactive"
printf '76\n' >"$FIXTURE_DIR/speculative"
expect 0 "$RES" heavy-check
printf 'invalid\n' >"$FIXTURE_DIR/free"
expect 1 "$RES" heavy-check
gate bad 1048576
expect 1 "$RES" heavy-check
expect 1 "$RES" heavy-check --unknown

# Plain take stays ungated, nonblocking, and idempotent.
gate 99 0
new_hold heavy-build
[ "$(field heavy-build pid)" = "$$" ] || fail 'explicit PID not recorded'
[ "$(field heavy-build host)" = "$host" ] || fail 'host not recorded'
[ "$(field heavy-build start)" = "$epoch" ] || fail 'epoch start not recorded'
pass 'take recorded PID/host/start'
cp "$RES_DIR/locks/heavy-build.d/info" "$FIXTURE_DIR/original.info"
expect 0 "$RES" take heavy-build --by owner --project changed --for changed --pid "$dead"
cmp "$FIXTURE_DIR/original.info" "$RES_DIR/locks/heavy-build.d/info" || fail 'idempotent take rewrote hold'
pass 'idempotent take preserves metadata'
expect 2 "$RES" take heavy-build --by other --project test --for no --force
expect 0 "$RES" status heavy-build
absent 'STALE owner'
release heavy-build
expect 0 "$RES" take heavy-build --by owner --project test --for default
[ "$(field heavy-build pid)" = "$$" ] || fail 'take default is not caller PID'
pass 'take defaults to parent, not res PID'
release heavy-build
for pid in 0 -1 abc '' 00; do
  expect 1 "$RES" take heavy-build --by owner --project test --for invalid --pid "$pid"
  expect 1 "$RES" wait heavy-build --by owner --project test --for invalid --pid "$pid" --timeout 0
done
expect 1 "$RES" take heavy-build --by owner --project test --for invalid --pid
expect 1 "$RES" wait heavy-build --by owner --project test --for invalid --timeout
expect 1 "$RES" wait heavy-build --by owner --project test --for invalid --timeout -1
expect 1 "$RES" wait heavy-build --by owner --project test --for invalid --timeout nope
expect 1 "$RES" wait heavy-build --by owner --project test --for invalid
expect 1 "$RES" wait heavy-build --by owner --project test --for invalid --timeout 0 --timeout 1
expect 1 "$RES" wait unknown --by owner --project test --for invalid --timeout 0

# Every heavy slot waits rather than taking while overloaded.
for id in heavy-build heavy-lane-1 heavy-lane-2; do
  expect 2 "$RES" wait "$id" --by owner --project test --for gated --pid "$$" --timeout 0
  [ ! -d "$RES_DIR/locks/$id.d" ] || fail 'overloaded wait took a slot'
  pass "$id overload leaves FREE"
done
gate 1 1048575
expect 2 "$RES" wait heavy-build --by owner --project test --for gated --timeout 0
gate 1 1048576
expect 0 "$RES" wait heavy-build --by owner --project test --for default --timeout 0
[ "$(field heavy-build pid)" = "$$" ] || fail 'wait default is res PID'
pass 'wait defaults to caller even through its take subshell'
release heavy-build
gate bad 1048576
expect 1 "$RES" wait heavy-build --by owner --project test --for badmetric --timeout 1
gate 1 1048576
printf '1\n' >"$FIXTURE_DIR/recover-load"
expect 0 "$RES" wait heavy-build --by owner --project test --for recovery --pid "$$" --timeout 0.05
contains "retry in 1s"
[ "$(field heavy-build pid)" = "$$" ] || fail 'wait explicit PID lost'
pass 'overload recovery retries and preserves explicit PID'
release heavy-build

# A held slot is retried and can be returned by its real owner while waiting.
new_hold heavy-build
: >"$OUT"
starting_child=releaser
(wait_for_retry; "$RES" return heavy-build --by owner >"$ROOT/evidence/background-return.txt") & releaser=$!
starting_child=''
expect 0 "$RES" wait heavy-build --by waiter --project test --for retry --pid "$$" --timeout 0.1
wait "$releaser"
releaser=''
release heavy-build waiter
new_hold heavy-build
start=$SECONDS
expect 2 "$RES" wait heavy-build --by waiter --project test --for timeout --timeout 0.2
elapsed=$((SECONDS - start))
[ "$elapsed" -ge 12 ] && [ "$elapsed" -le 20 ] || fail "unexpected timeout duration $elapsed"
contains 'retry in 1s'
contains 'retry in 2s'
pass "bounded backoff timeout took ${elapsed}s"
release heavy-build

# status is read-only; strictly > 600 seconds, not >= 600, is reclaimable.
new_hold heavy-build "$dead"
cp "$RES_DIR/locks/heavy-build.d/info" "$FIXTURE_DIR/stale.info"
expect 0 "$RES" status heavy-build
contains 'STALE?(short-lived pid) owner'
cmp "$FIXTURE_DIR/stale.info" "$RES_DIR/locks/heavy-build.d/info" || fail 'status mutated hold'
pass 'status marks dead holder without mutation'
expect 2 "$RES" wait heavy-build --by waiter --project test --for young --pid "$$" --timeout 0
change_info heavy-build start "$((epoch - 600))"
expect 2 "$RES" wait heavy-build --by waiter --project test --for boundary --pid "$$" --timeout 0
change_info heavy-build start "$((epoch - 601))"
expect 0 "$RES" wait heavy-build --by waiter --project test --for stale --pid "$$" --timeout 0
contains 'auto-reclaimed STALE heavy-build'
contains 'auto-reclaim STALE heavy hold' "$RES_DIR/log.tsv"
[ "$(field heavy-build by)" = waiter ] || fail 'reclaim did not take for waiter'
pass 'old stale heavy hold reclaimed and logged'
release heavy-build waiter

# Lanes use exactly the same stale recovery path as the full-build slot.
for id in heavy-lane-1 heavy-lane-2; do
  new_hold "$id" "$dead"
  change_info "$id" start "$((epoch - 601))"
  expect 0 "$RES" wait "$id" --by waiter --project test --for stale-lane --pid "$$" --timeout 0
  contains "auto-reclaimed STALE $id"
  release "$id" waiter
done

# Even a crashed reclaim guard can be recovered by the system's PID dot lock.
new_hold heavy-build "$dead"
change_info heavy-build start "$((epoch - 601))"
printf '%s\n' "$dead" >"$RES_DIR/locks/heavy-build.d/.reclaim"
# shlock defers reclaiming a file changed in its own start second.
sleep 1
expect 0 "$RES" wait heavy-build --by waiter --project test --for guard-recovery --pid "$$" --timeout 0
release heavy-build waiter

new_hold heavy-build
change_info heavy-build start "$((epoch - 1000))"
expect 2 "$RES" wait heavy-build --by waiter --project test --for live --timeout 0
release heavy-build
new_hold heavy-build "$dead"
change_info heavy-build start "$((epoch - 1000))"
change_info heavy-build host remote-host.invalid
expect 0 "$RES" status heavy-build
absent 'STALE owner'
expect 2 "$RES" wait heavy-build --by waiter --project test --for remote --timeout 0
release heavy-build
new_hold heavy-build "$dead"
awk -F '\t' '$1 != "pid" && $1 != "host" && $1 != "start"' "$RES_DIR/locks/heavy-build.d/info" >"$FIXTURE_DIR/legacy.info"
cp "$FIXTURE_DIR/legacy.info" "$RES_DIR/locks/heavy-build.d/info"
expect 0 "$RES" status heavy-build
absent 'STALE owner'
expect 2 "$RES" wait heavy-build --by waiter --project test --for legacy --timeout 0
release heavy-build
new_hold heavy-build "$dead"
change_info heavy-build start malformed
expect 2 "$RES" wait heavy-build --by waiter --project test --for malformed --timeout 0
release heavy-build
new_hold tiktok_vesdk "$dead"
change_info tiktok_vesdk start "$((epoch - 1000))"
gate 99 0
expect 0 "$RES" status tiktok_vesdk
contains 'STALE?(short-lived pid) owner'
expect 2 "$RES" wait tiktok_vesdk --by waiter --project test --for nonheavy --timeout 0
absent 'headroom='
expect 0 "$RES" return tiktok_vesdk --by waiter --force --note 'test forced return'
expect 0 "$RES" wait tiktok_vesdk --by owner --project test --for nonheavy-free --timeout 0
absent 'headroom='
release tiktok_vesdk

# Long-lived explicit holder survives a separate invoking shell, for take and wait.
gate 1 1048576
: >"$FIXTURE_DIR/holder-alive"
for command in take wait; do
  starting_child=holder
  tail -f "$FIXTURE_DIR/holder-alive" >/dev/null & holder=$!
  starting_child=''
  export RES HOLDER_PID="$holder" COMMAND="$command" INVOKER_FILE="$FIXTURE_DIR/invoker-pid"
  expect 0 /bin/bash -c '
    printf "%s\n" "$$" >"$INVOKER_FILE"
    if [ "$COMMAND" = wait ]; then
      "$RES" wait heavy-build --by owner --project test --for handoff --pid "$HOLDER_PID" --timeout 0
    else
      "$RES" take heavy-build --by owner --project test --for handoff --pid "$HOLDER_PID"
    fi
    :'
  invoker=$(<"$INVOKER_FILE")
  [ -z "$(ps -p "$invoker" -o pid= 2>/dev/null || true)" ] || fail 'invoking shell still alive'
  [ "$(field heavy-build pid)" = "$holder" ] || fail 'holder handoff lost'
  expect 0 "$RES" status heavy-build
  absent 'STALE owner'
  change_info heavy-build start "$((epoch - 1000))"
  expect 2 "$RES" wait heavy-build --by waiter --project test --for live-handoff --timeout 0
  stop_child "$holder"
  holder=''
  expect 0 "$RES" status heavy-build
  contains 'STALE owner'
  pass "$command --pid $HOLDER_PID survived exited invoking shell $invoker; stale only after holder exit"
  release heavy-build
done

# Competing waiters cannot reclaim or delete a newly acquired hold.
for round in 1 2 3 4 5; do
  new_hold heavy-build "$dead"
  change_info heavy-build start "$((epoch - 1000))"
  before=$(awk -F '\t' '$2 == "reclaim" {n++} END {print n+0}' "$RES_DIR/log.tsv")
  contenders=()
  for n in 1 2 3 4; do
    (rc=0; "$RES" wait heavy-build --by "race-$n" --project test --for race --pid "$$" --timeout 0 \
      >"$ROOT/evidence/race-$round-$n.txt" 2>&1 || rc=$?
      printf '%s\n' "$rc" >"$ROOT/evidence/race-$round-$n.rc") & contenders+=("$!")
  done
  for contender in "${contenders[@]}"; do wait "$contender"; done
  wins=0; busy=0
  for n in 1 2 3 4; do
    rc=$(<"$ROOT/evidence/race-$round-$n.rc")
    case "$rc" in 0) wins=$((wins + 1)) ;; 2) busy=$((busy + 1)) ;; *) fail "race returned $rc" ;; esac
  done
  after=$(awk -F '\t' '$2 == "reclaim" {n++} END {print n+0}' "$RES_DIR/log.tsv")
  [ "$wins" = 1 ] && [ "$busy" = 3 ] && [ "$((after - before))" = 1 ] || fail "race $round: wins=$wins busy=$busy reclaims=$((after-before))"
  pass "race $round: one winner, three held, one reclaim"
  release heavy-build "$(field heavy-build by)"
done

# EXIT cleanup returns lane before build on failure; a lane timeout releases build.
export RES
expect 7 /bin/bash -c '
  build=0; lane=0
  cleanup() {
    if [ "$lane" = 1 ]; then "$RES" return heavy-lane-1 --by wrapper; fi
    if [ "$build" = 1 ]; then "$RES" return heavy-build --by wrapper; fi
  }
  trap cleanup EXIT
  "$RES" wait heavy-build --by wrapper --project test --for cleanup --pid $$ --timeout 0 || exit $?
  build=1
  "$RES" wait heavy-lane-1 --by wrapper --project test --for cleanup --pid $$ --timeout 0 || exit $?
  lane=1
  exit 7'
returns=$(awk -F '\t' '$2 == "return" && $4 == "wrapper" {print $3}' "$RES_DIR/log.tsv" | tail -2)
[ "$returns" = "$(printf 'heavy-lane-1\nheavy-build')" ] || fail 'cleanup did not return in reverse order'
pass 'wrapper failure released lane, then build'
new_hold heavy-lane-1
expect 2 /bin/bash -c '
  build=0
  trap '\''if [ "$build" = 1 ]; then "$RES" return heavy-build --by timeout-wrapper; fi'\'' EXIT
  "$RES" wait heavy-build --by timeout-wrapper --project test --for cleanup --pid $$ --timeout 0 || exit $?
  build=1
  "$RES" wait heavy-lane-1 --by timeout-wrapper --project test --for cleanup --pid $$ --timeout 0 || exit $?'
[ ! -d "$RES_DIR/locks/heavy-build.d" ] || fail 'lane timeout leaked build slot'
[ "$(field heavy-lane-1 by)" = owner ] || fail 'timeout changed existing lane owner'
pass 'lane timeout released acquired build, preserving busy lane'
release heavy-lane-1

# Regression sequence against the exact saved script, isolated in separate RES_DIRs.
regression() (
  local script="$1" target="$2" out="$3" rc
  export RES_DIR="$target"
  mkdir -p "$RES_DIR/notes" "$RES_DIR/locks"
  cp "$SOURCE/backup/resources.tsv" "$RES_DIR/resources.tsv"
  run() { rc=0; "$script" "$@" >>"$out" 2>&1 || rc=$?; printf 'exit=%s\n' "$rc" >>"$out"; }
  run add new-checkout --device - --for 'scratch checkout'
  run add open-checkout --device - --for 'open scratch' --policy open
  run add new-checkout --device - --for duplicate
  run add 'bad/id' --device - --for invalid
  run take new-checkout --by owner --project test --for policy
  run take new-checkout --by owner --project test --for approved --force
  run take new-checkout --by other --project test --for held --force
  run extend new-checkout --by other --until tomorrow
  run extend new-checkout --by owner --until tomorrow
  run return new-checkout --by other
  run return new-checkout --by other --force
  run return new-checkout --by other --force --note approved
  run return new-checkout --by owner
  run note open-checkout --by owner --note 'pitfall and workaround'
  run take open-checkout --by owner --project test --for 'take with note'
  run take open-checkout --by owner --project changed --for changed
  run status open-checkout
  head -6 "$RES_DIR/locks/open-checkout.d/info" >"$RES_DIR/original-fields.txt"
  run return open-checkout --by owner --note done
  run take iphone15pm --by owner --project test --for never --offline --force
  run take iphone11 --by owner --project test --for disconnected
  run take iphone11 --by owner --project test --for offline --offline
  run return iphone11 --by owner
  run add connected --device scratch-device --for 'connected fixture' --policy open
  run take connected --by owner --project test --for connected
  run return connected --by owner
  run log 3
)
regression "$BASELINE" "$ROOT/regression-before" "$ROOT/evidence/regression-before.txt"
regression "$RES" "$ROOT/regression-after" "$ROOT/evidence/regression-after.txt"
sed "s|$ROOT/regression-before|REGRESSION|g" "$ROOT/evidence/regression-before.txt" >"$ROOT/evidence/regression-before.normalized.txt"
sed "s|$ROOT/regression-after|REGRESSION|g" "$ROOT/evidence/regression-after.txt" >"$ROOT/evidence/regression-after.normalized.txt"
for file in resources.tsv log.tsv original-fields.txt notes/open-checkout.md; do
  cmp "$ROOT/regression-before/$file" "$ROOT/regression-after/$file" || fail "regression changed $file"
  pass "legacy $file unchanged"
done
diff -u "$ROOT/evidence/regression-before.normalized.txt" "$ROOT/evidence/regression-after.normalized.txt" || fail 'legacy output/exit behavior changed'
pass '27-command legacy transcript (stdout/stderr/exits) unchanged'
expect 3 "$RES" wait iphone15pm --by owner --project test --for never --offline --timeout 0
expect 4 "$RES" wait iphone11 --by owner --project test --for disconnected --timeout 0
expect 1 "$RES" return heavy-build --by owner --pid "$$"
for id in heavy-build heavy-lane-1 heavy-lane-2; do
  new_hold "$id"
  contains 'ORDER: acquire `heavy-build` FIRST'
  contains 'Wrappers should pass `--pid $$`'
  release "$id"
done
[ -z "$(find "$RES_DIR/locks" -mindepth 1 -print -quit)" ] || fail 'scratch holds or retired dirs leaked'
pass 'scratch locks empty; no live RES_DIR used'
printf '\nALL %s ASSERTIONS PASSED\n' "$COUNT"
