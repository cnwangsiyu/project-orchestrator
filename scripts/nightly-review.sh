#!/bin/zsh -l
# nightly-review: launch the daily routing review as a fresh background Claude session (run by launchd at 03:07).
# Install: references/nightly-review.md, "Schedule". Log: ~/.claude/orchestrator/_shared/routing-review/launch.log
set -u
# launchd starts with a bare environment: put the user's tools (claude/codex in ~/.local/bin, Homebrew, nvm's node) on PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use default >/dev/null 2>&1 || true; fi
SKILL="${0:A:h:h}"
DIR="$HOME/.claude/orchestrator/_shared/routing-review"
mkdir -p "$DIR"
DAY=$(date +%F)
exec >>"$DIR/launch.log" 2>&1
echo "== $(date '+%F %T') launching review for $DAY"
# Earlier review sessions that are still around have finished their day: stop them (their conversations are kept).
claude agents --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let a = []; try { a = JSON.parse(s); } catch {}
    for (const x of a) if ((x.name || "").startsWith("routing-nightly-review-") && x.name !== "routing-nightly-review-" + process.argv[1]) console.log(x.id);
  });' "$DAY" | while read -r id; do claude stop "$id" && echo "stopped $id"; done
cd "$DIR" || exit 1
# Opus high: a design/trade-off review (route.mjs `design`); bypass, as the orchestrators run.
claude --bg --permission-mode bypassPermissions -n "routing-nightly-review-$DAY" --model opus --effort high \
  "Run the nightly routing review for the 24 hours ending now ($DAY 03:00 local): read $SKILL/references/nightly-review.md and follow it exactly."
echo "exit $?"
