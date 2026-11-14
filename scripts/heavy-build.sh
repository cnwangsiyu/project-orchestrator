#!/bin/bash
# Acquire, run and return in ONE long-lived wrapper; never nest this wrapper.
set -u
set -m
res="${RES_COMMAND:-$HOME/.claude/orchestrator/_shared/res}"
by="${HEAVY_BUILD_BY:?set HEAVY_BUILD_BY to a unique session holder name}"
project="${HEAVY_BUILD_PROJECT:?set HEAVY_BUILD_PROJECT}"
task="${HEAVY_BUILD_TASK:?set HEAVY_BUILD_TASK}"
timeout="${HEAVY_BUILD_TIMEOUT:-60}"
preferred_lane="${HEAVY_BUILD_LANE:-}"
watch_pid=''
if [ "${1:-}" = --watch-pid ]; then
  [ "$#" -ge 2 ] || { echo 'heavy-build: --watch-pid needs a PID' >&2; exit 2; }
  watch_pid="$2"; shift 2
fi
[ "${1:-}" != -- ] || shift
if [ "$#" -eq 0 ] || ! [[ "$timeout" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
   { [ -n "$preferred_lane" ] && ! [[ "$preferred_lane" =~ ^heavy-lane-[123]$ ]]; } ||
   { [ -n "$watch_pid" ] && ! [[ "$watch_pid" =~ ^[1-9][0-9]*$ ]]; }; then
  echo 'usage: heavy-build.sh [--watch-pid <long-lived worker PID>] [--] <command...>; finite timeout minutes, optional HEAVY_BUILD_LANE=heavy-lane-1/2/3' >&2
  exit 2
fi
if [ -n "$watch_pid" ] && ! kill -0 "$watch_pid" 2>/dev/null; then
  echo "heavy-build: watched worker $watch_pid is gone" >&2; exit 143
fi
child='' watcher='' spawning=0 acquiring=0 acquiring_id='' output='' modern=1 build_held=0 lane_held=0 lane=''
stop_group() {
  [ -n "$1" ] || return 0
  kill -TERM -- "-$1" 2>/dev/null || true
  # Give an interrupted controller time to publish/return its owned directories.
  if [ "$acquiring" -eq 1 ] && [ "$1" = "$child" ]; then sleep 2; else sleep 0.2; fi
  kill -KILL -- "-$1" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}
cleanup() {
  local status=$?
  trap - EXIT; trap '' INT TERM HUP
  if [ "$spawning" -eq 1 ] && [ -z "$child" ]; then child="${!:-}"; fi
  stop_group "$watcher"
  stop_group "$child"
  # Return by ownership even if interrupted before acquisition reports success.
  if [ "$modern" -eq 1 ]; then
    "$res" return-build --by "$by" --pid "$$" || status=1
  elif [ "$acquiring" -eq 1 ] || [ "$build_held" -eq 1 ] || [ "$lane_held" -eq 1 ]; then
    if [ "$lane_held" -eq 1 ]; then "$res" return "$lane" --by "$by" || status=1
    elif [ "$acquiring" -eq 1 ] && [[ "$acquiring_id" = heavy-lane-* ]]; then
      "$res" return "$acquiring_id" --by "$by" 2>/dev/null || true
    fi
    if [ "$build_held" -eq 1 ]; then "$res" return heavy-build --by "$by" || status=1
    elif [ "$acquiring" -eq 1 ] && [ "$acquiring_id" = heavy-build ]; then
      "$res" return heavy-build --by "$by" 2>/dev/null || true
    fi
  fi
  [ -z "$output" ] || rm -f "$output" "$output.err"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
output=$(mktemp "${TMPDIR:-/tmp}/heavy-build-acquire.XXXXXX") || exit 1
# Feature detection preserves compatibility with a rolled-back v1.2 controller.
# Only its exact legacy help response selects the fallback; real errors propagate.
capability=$("$res" wait-build --help 2>&1); capability_rc=$?
if [ "$capability_rc" -ne 0 ]; then
  legacy_help=$("$res" --help 2>&1); help_rc=$?
  if [ "$capability_rc" -eq 1 ] && [ "$help_rc" -eq 0 ] && [ "$capability" = "$legacy_help" ]; then modern=0
  else printf '%s\n' "$capability" >&2; exit "$capability_rc"; fi
fi
if [ -n "$watch_pid" ]; then
  spawning=1
  (
    sleeper=''
    trap 'trap "" INT TERM HUP; [ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null; exit 0' INT TERM HUP
    while kill -0 "$watch_pid" 2>/dev/null; do sleep 1 & sleeper=$!; wait "$sleeper"; sleeper=''; done
    echo "heavy-build: watched worker $watch_pid disappeared; terminating build and returning locks" >&2
    kill -TERM "$$"
  ) &
  watcher=$!
  spawning=0
fi
run_wait() {
  local status
  acquiring_id="${2:-}"
  spawning=1
  "$res" "$@" --by "$by" --project "$project" --for 'full-package build' --task "$task" --pid "$$" >"$output" &
  child=$!; spawning=0
  wait "$child"; status=$?; child=''
  cat "$output"
  return "$status"
}
legacy_pair() {
  local duration deadline remaining delay=1 status candidate missing3=0
  duration=$(awk -v t="$timeout" 'BEGIN {s=t*60; printf "%.0f\n", int(s)+(s>int(s))}')
  deadline=$((SECONDS + duration))
  while :; do
    acquiring=1
    if run_wait wait heavy-build --timeout 0; then
      build_held=1
      acquiring=0
      for candidate in ${preferred_lane:-heavy-lane-1 heavy-lane-2 heavy-lane-3}; do
        [ "$candidate" != heavy-lane-3 ] || [ "$missing3" -eq 0 ] || continue
        lane="$candidate"
        acquiring=1
        # Capture the old missing-lane diagnostic without masking unrelated errors.
        if run_wait wait "$lane" --timeout 0 2>"$output.err"; then
          cat "$output.err" >&2; rm -f "$output.err"
          lane_held=1; acquiring=0; return 0
        else status=$?; fi
        cat "$output.err" >&2
        if [ "$status" -eq 1 ] && [ -z "$preferred_lane" ] &&
           [ "$lane" = heavy-lane-3 ] && grep -Fxq "res: unknown resource 'heavy-lane-3' (see: res status)" "$output.err"; then
          echo 'heavy-build: lane 3 is not registered; continuing bounded waits on lanes 1/2' >&2; missing3=1
        elif [ "$status" -ne 2 ]; then rm -f "$output.err"; return "$status"; fi
        rm -f "$output.err"
      done
      "$res" return heavy-build --by "$by" || return 1
      build_held=0
    else status=$?; [ "$status" -eq 2 ] || return "$status"; fi
    acquiring=0
    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || { echo 'heavy-build: timed out waiting for build pair' >&2; return 2; }
    [ "$delay" -le "$remaining" ] || delay="$remaining"
    echo "heavy-build: waiting for build pair; retry in ${delay}s" >&2
    spawning=1; sleep "$delay" & child=$!; spawning=0
    wait "$child"; child=''
    delay=$((delay * 2)); [ "$delay" -le 15 ] || delay=15
  done
}
if [ "$modern" -eq 1 ]; then
  args=(wait-build --timeout "$timeout")
  [ -z "$preferred_lane" ] || args+=(--lane "$preferred_lane")
  acquiring=1
  run_wait "${args[@]}" || exit $?
  lane=$(sed -n 's/^build-lane=\(heavy-lane-[123]\)$/\1/p' "$output")
  [[ "$lane" =~ ^heavy-lane-[123]$ ]] || { echo 'heavy-build: missing acquired lane result' >&2; exit 1; }
  acquiring=0
else
  legacy_pair || exit $?
fi
spawning=1
"$@" &
child=$!; spawning=0
wait "$child"; status=$?
# Cleanup terminates descendants before releasing the pair and reaps the watcher.
exit "$status"
