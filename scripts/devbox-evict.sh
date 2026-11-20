#!/bin/zsh
# Standing rule (user, 2026-11-19): on a devbox at the disk floor, delete ONLY tool-created,
# rebuildable test-run data (`.data` directories inside runner slot worktrees), least recently
# used first, until free space reaches the target. Never anything else. Every deletion is logged.
# Usage: devbox-evict.sh USER@HOST RUNNER_ROOT [TARGET_FREE_GIB=73]
set -u
target=${1:?user@host}; root=${2:?runner root}; want=${3:-73}
# Opt-in whole-tree eviction uses per-slot public maintenance leases. Disabled
# configuration leaves the legacy SSH command and .data-only behavior unchanged.
mode=$(node ${0:A:h}/devbox-evict.mjs --enabled "$target") || exit $?
if [ "$mode" = enabled ]; then
  exec node ${0:A:h}/devbox-evict.mjs "$target" "$root" "$want"
fi
host=${target#*@}
shared=~/.claude/orchestrator/_shared
log=$shared/reports/devbox-evictions/evictions.tsv
mkdir -p ${log:h}
[ -s $log ] || printf 'time\thost\tpath\tsize_mb\tdir_mtime\tfree_before_gib\tfree_after_gib\n' > $log
held=$($shared/res status 2>/dev/null | grep "Host $host" | grep -o 'heldSlots=[0-9]*')
[ "$held" = "heldSlots=0" ] || { echo "$host: $held (need heldSlots=0); nothing deleted"; exit 3; }
ssh -o BatchMode=yes -o ConnectTimeout=10 $target "R='$root'; TARGET=$want; "'
free(){ df -BG --output=avail "$R" | tail -1 | tr -dc 0-9; }
find "$R/wt" -maxdepth 5 -type d -name .data -printf "%T@\t%p\n" 2>/dev/null | sort -n | while IFS="	" read t d; do
  f=$(free); [ "$f" -ge "$TARGET" ] && break
  case "$d" in "$R"/wt/*/id-*/devbox-cn-*/.data) ;; *) continue;; esac
  [ -L "$d" ] && continue
  slot=$(dirname "$d"); busy=0
  for p in $(pgrep -u "$USER"); do c=$(readlink /proc/$p/cwd 2>/dev/null); case "$c" in "$slot"*) busy=1;; esac; done
  [ $busy = 1 ] && continue
  [ -n "$(find "$d" -mmin -30 -print -quit 2>/dev/null)" ] && continue
  s=$(du -s -BM "$d" | cut -f1 | tr -dc 0-9); m=$(stat -c %y "$d" | cut -c1-16)
  rm -rf -- "$d" && printf "%s\t%s\t%s\t%s\t%s\n" "${d#$R/}" "$s" "$m" "$f" "$(free)"
done; echo "FINAL free=$(free)G"' 2>&1 | while IFS= read -r line; do
  case "$line" in
    FINAL*) echo "$host $line" ;;
    *"	"*) printf '%s\t%s\t%s\n' "$(date '+%F %H:%M')" "$host" "$line" >> $log; echo "$host deleted ${line%%	*}" ;;
    *) echo "$host ?? $line" ;;
  esac
done
