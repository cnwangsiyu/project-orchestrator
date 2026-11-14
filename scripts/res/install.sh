#!/bin/bash
# Owner-only code/registry switch. Notes, locks and journal are never changed here.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd -P)
shared="${RES_INSTALL_DIR:-$HOME/.claude/orchestrator/_shared}"
force=0
case "${1:-}" in
  --force) force=1; shift ;;
  '') ;;
  *) echo 'usage: install.sh [--force]' >&2; exit 1 ;;
esac
[ "$#" -eq 0 ] || { echo 'usage: install.sh [--force]' >&2; exit 1; }
[ -d "$shared" ] || { echo "BLOCKED: missing shared directory: $shared" >&2; exit 2; }
shared=$(cd "$shared" && pwd -P)
target="$root/scripts/res/res"
[ -x "$target" ] || { echo "BLOCKED: source is not executable: $target" >&2; exit 2; }
[ -L "$shared/res" ] && [ -f "$shared/res" ] || {
  echo 'BLOCKED: existing res must be a symlink to a regular script' >&2; exit 2;
}
registry="$shared/resources.tsv"
row_file="$root/scripts/res/resources-lane3.tsv"
[ -f "$registry" ] && [ ! -L "$registry" ] || {
  echo 'BLOCKED: resources.tsv must be a regular, non-symlink registry' >&2; exit 2;
}
awk -F '\t' 'NR != 1 || NF != 5 || $1 != "heavy-lane-3" || $2 != "slot" || $3 != "open" || $4 != "-" || $5 == "" {exit 1}
  END {if (NR != 1) exit 1}' "$row_file" || {
  echo 'BLOCKED: invalid reviewed lane-3 registry row' >&2; exit 2;
}
quiescent() {
  local lock processes waiters
  for lock in "$shared"/locks/heavy-*.d; do
    if [ -d "$lock" ] && [ "$force" -ne 1 ]; then
      echo "BLOCKED: heavy hold exists: ${lock##*/}; coordinate release or explicitly use --force" >&2
      return 2
    fi
  done
  processes=$(ps -axo pid=,args=) || { echo 'BLOCKED: cannot inspect res waiters' >&2; return 2; }
  waiters=$(printf '%s\n' "$processes" | awk '
    { gsub(/["\047]/, "")
      for (i=2; i<NF; i++) if ($i ~ /(^|\/)res$/ && $(i+1) ~ /^(wait|wait-build|wait-lane)$/) {print $1; break} }')
  if [ -n "$waiters" ] && [ "$force" -ne 1 ]; then
    echo 'BLOCKED: res wait is running; ask its owner to re-invoke it after the switch (or use --force)' >&2
    return 2
  fi
}
quiescent
node "$root/scripts/test/run-all.mjs"
# Recheck after the suites. The owner must keep callers quiescent during switch.
quiescent
backup=$(mktemp -d "$shared/res-backup.$(date '+%Y%m%d-%H%M%S').XXXXXX")
cp -p "$shared/res" "$backup/res"
cp -p "$registry" "$backup/resources.tsv"
previous_target=$(readlink "$shared/res")
printf '%s\n' "$previous_target" >"$backup/previous-target.txt"
tmp="$shared/.res-switch.$$"
registry_tmp=''
switched=0
installed=0
cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM HUP
  if [ "$installed" -eq 0 ] && [ "$switched" -eq 1 ]; then
    # Restore the registry before old code, which cannot gate a registered lane 3.
    if cp -p "$backup/resources.tsv" "$registry_tmp" && mv -f "$registry_tmp" "$registry"; then
      ln -sfn "$previous_target" "$tmp" && mv -f "$tmp" "$shared/res" || status=1
    else
      echo "BLOCKED: registry rollback failed; retain v1.3 code and restore $backup/resources.tsv before old code" >&2
      status=1
    fi
  fi
  rm -f "$tmp" ${registry_tmp:+"$registry_tmp"}
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
registry_tmp=$(mktemp "$shared/.resources-switch.XXXXXX")
cp -p "$registry" "$registry_tmp"
row=$(<"$row_file")
awk -F '\t' -v row="$row" '
  $1 == "heavy-lane-3" {
    if (++seen > 1 || NF != 5 || $2 != "slot" || $3 != "open" || $4 != "-" || $5 == "") {bad=1; exit 1}
  }
  {print}
  END {if (!seen && !bad) print row}
' "$registry" >"$registry_tmp" || {
  echo 'BLOCKED: conflicting or duplicate lane-3 registry row; registry left unchanged' >&2; exit 2;
}
# Both entries are staged under owner quiescence. Never expose lane 3 to old code.
switched=1
ln -sfn "$target" "$tmp"
mv -f "$tmp" "$shared/res"
if ! cmp -s "$registry_tmp" "$registry"; then mv -f "$registry_tmp" "$registry"; fi
installed=1
printf 'Installed: %s -> %s\nBackup: %s\n' "$shared/res" "$target" "$backup/res"
printf 'Registry backup: %s\n' "$backup/resources.tsv"
printf 'Rollback (coordinate quiescence first):\n'
printf 'cp -p %q %q && mv -f %q %q && ln -sfn %q %q && mv -f %q %q\n' \
  "$backup/resources.tsv" "$shared/.resources-rollback.$$" "$shared/.resources-rollback.$$" "$registry" \
  "$backup/res" "$shared/.res-rollback.$$" "$shared/.res-rollback.$$" "$shared/res"
printf '%s\n' 'Lane 3 registered (idempotent). Owner: install notes/heavy-build.md and notify callers via the rules digest.'
