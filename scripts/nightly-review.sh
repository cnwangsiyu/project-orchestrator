#!/bin/zsh -l
# nightly-review: the daily routing review (run by launchd at 03:07).
# Install: references/nightly-review.md, "Schedule". Log: ~/.claude/orchestrator/_shared/routing-review/launch.log
#
# With a healthy TTADK account (user, 2026-11-07: burn company quota, not personal), the review itself runs on TTADK:
#   1. this script gathers the data (no model);
#   2. a TTADK Codex worker (Sol xhigh) does the review, the changes, the tests, the commits and the report, and writes
#      <day>.notify.json (references/nightly-review.md, "Who does what");
#   3. a short Claude session (Sonnet medium) checks the result against the hard rules and notifies the orchestrators.
# Without TTADK, or when the worker fails or produces no report, the whole review runs as a Claude session (Opus high),
# as before. NIGHTLY_MODE=claude forces that.
set -u
# launchd starts with a bare environment: put the user's tools (claude/codex in ~/.local/bin, Homebrew, nvm's node) on PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use default >/dev/null 2>&1 || true; fi
SKILL="${0:A:h:h}"
DIR="$HOME/.claude/orchestrator/_shared/routing-review"
mkdir -p "$DIR"
DAY=$(date +%F)
NOW=$(date "+%F %H:%M %Z")  # the window ends when the review starts (03:07 from launchd; later on a manual run)
MODE="${NIGHTLY_MODE:-auto}"
exec >>"$DIR/launch.log" 2>&1
echo "== $(date '+%F %T') launching review for $DAY (mode $MODE)"
# Earlier review sessions that are still around have finished their day: stop them (their conversations are kept).
claude agents --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let a = []; try { a = JSON.parse(s); } catch {}
    for (const x of a) if ((x.name || "").startsWith("routing-nightly-review-") && !x.name.startsWith("routing-nightly-review-" + process.argv[1])) console.log(x.id);
  });' "$DAY" | while read -r id; do claude stop "$id" && echo "stopped $id"; done
cd "$DIR" || exit 1

claude_review() {
  # Opus high: a design/trade-off review (route.mjs `design`); bypass, as the orchestrators run.
  echo "full Claude review: $1"
  claude --bg --permission-mode bypassPermissions -n "routing-nightly-review-$DAY" --model opus --effort high \
    "Run the nightly routing review for the 24 hours ending now ($NOW): read $SKILL/references/nightly-review.md and follow it exactly."
  echo "exit $?"
}

W="$SKILL/scripts/codex-worker.mjs"
TT_HOME=$(node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.env.HOME + "/.claude/orchestrator/_shared/codex-accounts.json", "utf8")); const t = Object.entries(r).find(([, a]) => a.kind === "ttadk"); if (t) console.log(t[0] + " " + t[1].home); } catch {}')
TT_NAME="${TT_HOME%% *}"; TT_HOME="${TT_HOME#* }"
if [ "$MODE" = claude ] || [ -z "$TT_NAME" ]; then claude_review "no TTADK account or NIGHTLY_MODE=claude"; exit 0; fi
if ! node "$SKILL/scripts/quota.mjs" --fresh 2>/dev/null | grep -q "(TTADK gateway): healthy"; then claude_review "TTADK not healthy"; exit 0; fi
if ! node "$W" --account "$TT_NAME" proxy >/dev/null 2>&1; then claude_review "TTADK proxy did not start"; exit 0; fi

# 1. Data (these scripts call the claude/codex CLIs, so they run here, before the worker).
D="$DIR/$DAY.data"; mkdir -p "$D"
node "$SKILL/scripts/review-data.mjs" --hours 24 > "$D/review-data-24h.txt" 2>&1
node "$SKILL/scripts/review-data.mjs" --hours 168 > "$D/review-data-168h.txt" 2>&1
node "$SKILL/scripts/orch-usage.mjs" --hours 24 > "$D/orch-usage-24h.txt" 2>&1
echo "data gathered in $D"

# 2. The TTADK worker: full access (it commits and pushes, as the Claude review runs in bypass), network on.
rm -f "$DIR/$DAY.notify.json"
SANDBOX="danger-full-access"; [ "$MODE" = dry ] && SANDBOX="read-only"
DRYNOTE=""; [ "$MODE" = dry ] && DRYNOTE=" DRY RUN: read-only; make no edits, commits or pushes; write nothing except your final answer, which is the report."
s=$(date +%s)
CODEX_HOME="$TT_HOME" perl -e 'alarm 2400; exec @ARGV' -- codex exec --skip-git-repo-check -C "$DIR" -s "$SANDBOX" -m gpt-6.1-sol \
  -c model_reasoning_effort='"xhigh"' --json -o "$DIR/$DAY.worker-final.md" \
  "You are the TTADK worker of the nightly routing review for the 24 hours ending now ($NOW). Read $SKILL/references/nightly-review.md and follow it, doing the worker's part in its section \"Who does what\". The data is already gathered: $D/review-data-24h.txt, $D/review-data-168h.txt, $D/orch-usage-24h.txt.$DRYNOTE" \
  < /dev/null > "$DIR/$DAY.worker.jsonl" 2>&1
rc=$?
echo "worker exit $rc after $(( $(date +%s) - s ))s"
[ "$MODE" = dry ] && { echo "dry run: report in $DIR/$DAY.worker-final.md; no finisher"; exit 0; }
if [ $rc -ne 0 ] || [ ! -s "$DIR/$DAY.md" ] || [ ! -s "$DIR/$DAY.notify.json" ]; then
  claude_review "the TTADK worker failed (exit $rc) or left no report/notify file — see $DIR/$DAY.worker.jsonl"; exit 0
fi

# 3. The Claude finisher: check, notify, push notification.
claude --bg --permission-mode bypassPermissions -n "routing-nightly-review-$DAY-finish" --model sonnet --effort medium \
  "Finish the nightly routing review for $DAY: read $SKILL/references/nightly-review.md, section \"Who does what\" (the finisher's part) and \"Decisions for the user\", then the worker's report $DIR/$DAY.md and $DIR/$DAY.notify.json, and follow it. Ask every entry of notify.json decisions with AskUserQuestion cards in Chinese."
echo "finisher exit $?"
