#!/bin/bash
# Full-package build wrapper. Do not nest it or reuse an already-held heavy lock.
set -u
set -m
res="${RES_COMMAND:-$HOME/.claude/orchestrator/_shared/res}"
by="${HEAVY_BUILD_BY:?set HEAVY_BUILD_BY to a unique session holder name}"
project="${HEAVY_BUILD_PROJECT:?set HEAVY_BUILD_PROJECT}"
task="${HEAVY_BUILD_TASK:?set HEAVY_BUILD_TASK}"
timeout="${HEAVY_BUILD_TIMEOUT:-60}"
lane="${HEAVY_BUILD_LANE:-heavy-lane-1}"
if [ "$#" -eq 0 ] || ! [[ "$timeout" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
   ! [[ "$lane" =~ ^heavy-lane-[12]$ ]]; then
  printf '%s\n' 'usage: heavy-build.sh <command...>; finite timeout minutes, lane heavy-lane-1 or heavy-lane-2' >&2
  exit 2
fi
build_held=0
lane_held=0
child=''
acquiring=''
spawning=0
cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM HUP
  # Bash has already published $! if interrupted before the child assignment.
  if { [ -n "$acquiring" ] || [ "$spawning" -eq 1 ]; } && [ -z "$child" ]; then child="${!:-}"; fi
  if [ -n "$child" ]; then
    kill -TERM -- "-$child" 2>/dev/null || true
    sleep 0.2
    kill -KILL -- "-$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  # A signal can arrive after res acquires but before the held flag is set.
  if [ -n "$acquiring" ] &&
     ! { [ "$acquiring" = heavy-build ] && [ "$build_held" -eq 1 ]; } &&
     ! { [ "$acquiring" = "$lane" ] && [ "$lane_held" -eq 1 ]; }; then
    "$res" return "$acquiring" --by "$by" 2>/dev/null || true
  fi
  if [ "$lane_held" -eq 1 ]; then "$res" return "$lane" --by "$by" || status=1; fi
  if [ "$build_held" -eq 1 ]; then "$res" return heavy-build --by "$by" || status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
take_lock() {
  local status
  acquiring="$1"
  spawning=1
  "$res" wait "$1" --by "$by" --project "$project" --for "full-package build" \
    --task "$task" --pid "$$" --timeout "$timeout" &
  child=$!
  spawning=0
  wait "$child"
  status=$?
  child=''
  if [ "$status" -ne 0 ]; then acquiring=''; fi
  return "$status"
}
take_lock heavy-build || exit $?
build_held=1
acquiring=''
take_lock "$lane" || exit $?
lane_held=1
acquiring=''
spawning=1
"$@" &
child=$!
spawning=0
wait "$child"
status=$?
# Kill any remaining descendants of this command before returning its locks.
exit "$status"
