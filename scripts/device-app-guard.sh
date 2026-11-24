#!/bin/bash
# Guard shared-device app operations using the res-owned app registry.  It does
# not probe devices: callers pass the identity they observed with their own
# read-only platform command before stopping, uninstalling, or installing.
set -euo pipefail

usage() {
  echo 'usage: device-app-guard.sh --device ID --bundle BID --project P --expect-name NAME --actual-name NAME|- --actual-version VERSION|-' >&2
  exit 2
}

device= bundle= project= expected= actual_name= actual_version=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --device) device="$2" ;;
    --bundle) bundle="$2" ;;
    --project) project="$2" ;;
    --expect-name) expected="$2" ;;
    --actual-name) actual_name="$2" ;;
    --actual-version) actual_version="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[ -n "$device" ] && [ -n "$bundle" ] && [ -n "$project" ] && [ -n "$expected" ] && [ -n "$actual_name" ] && [ -n "$actual_version" ] || usage
[ "$actual_name" != - ] || [ "$actual_version" = - ] || { echo 'DEVICE-APP-GUARD REFUSED: absent app must use actual-name/version -' >&2; exit 3; }
[ "$actual_version" != - ] || [ "$actual_name" = - ] || { echo 'DEVICE-APP-GUARD REFUSED: absent app must use actual-name/version -' >&2; exit 3; }

res="${DEVICE_APP_RES:-$(cd "$(dirname "$0")" && pwd)/res/res}"
check=$("$res" device-app check --device "$device" --bundle "$bundle" --project "$project" --expect-name "$expected" 2>&1) || true
case "$check" in
  OWNED-BY-YOU)
    # Check returns OUR ownership and the expected registered display name.
    # The registry is JSON so ask list for the last registered version only.
    registered=$("$res" device-app list --device "$device" 2>/dev/null | node -e '
const [bundle] = process.argv.slice(1); let rows; try { rows=JSON.parse(require("fs").readFileSync(0,"utf8")); } catch { process.exit(2); }
const row=rows.find(value=>value.bundle===bundle); if (!row) process.exit(3); process.stdout.write(`${row.name}\n${row.version}`);' "$bundle") || registered=
    registered_name=${registered%%$'\n'*}; registered_version=${registered#*$'\n'}
    if [ "$actual_name" = "$expected" ] && [ "$registered_name" = "$expected" ] && [ "$actual_version" = "$registered_version" ]; then
      echo "DEVICE-APP-GUARD PASS: $project owns $bundle ($actual_name $actual_version)"
      exit 0
    fi
    echo "DEVICE-APP-GUARD REFUSED: observed $actual_name $actual_version does not match registered $expected $registered_version" >&2
    exit 3
    ;;
  UNREGISTERED)
    if [ "$actual_name" = - ] && [ "$actual_version" = - ]; then
      echo "DEVICE-APP-GUARD PASS: $bundle is unregistered and not installed"
      exit 0
    fi
    echo "DEVICE-APP-GUARD REFUSED: $bundle is unregistered but installed as $actual_name $actual_version; stop and report ownership" >&2
    exit 3
    ;;
  OWNED-BY-OTHER*)
    echo "DEVICE-APP-GUARD REFUSED: $check; stop and report to both orchestrators" >&2
    exit 3
    ;;
  *)
    echo "DEVICE-APP-GUARD REFUSED: could not verify registry: $check" >&2
    exit 3
    ;;
esac
