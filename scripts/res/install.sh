#!/bin/bash
# Owner-only switch. Registry, notes, locks and journal are never changed here.
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
    { i=2; if ($i ~ /(^|\/)(bash|sh|zsh)$/) i++
      if ($i ~ /(^|\/)res$/ && $(i+1) == "wait") print $1 }')
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
readlink "$shared/res" >"$backup/previous-target.txt"
tmp="$shared/.res-switch.$$"
trap 'rm -f "$tmp"' EXIT
ln -sfn "$target" "$tmp"
mv -f "$tmp" "$shared/res"
printf 'Installed: %s -> %s\nBackup: %s\n' "$shared/res" "$target" "$backup/res"
printf 'Rollback (coordinate quiescence first):\n'
printf 'ln -sfn %q %q && mv -f %q %q\n' "$backup/res" "$shared/.res-rollback.$$" "$shared/.res-rollback.$$" "$shared/res"
printf '%s\n' 'Owner: add the reviewed resources.tsv row and install notes/heavy-build.md; notify callers via the rules digest.'
