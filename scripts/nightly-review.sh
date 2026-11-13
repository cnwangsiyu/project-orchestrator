#!/bin/zsh -l
# nightly-review: the daily routing review (run by launchd at 03:07).
# Install: references/nightly-review.md, "Schedule". Log: ~/.claude/orchestrator/_shared/routing-review/launch.log
#
# The review follows the routing policy like any other task (user, 2026-11-09): route.mjs decides where it runs.
#   1. this script gathers the data (no model);
#   2. the review itself is routed as `analysis --stakes high`: company accounts first (TTADK, then TRAE CLI), as a
#      one-shot Codex worker that does the review, the changes, the tests, the commits and the report, and writes
#      <day>.notify.json (references/nightly-review.md, "Who does what"). A worker that fails or leaves no report is
#      re-routed without its account;
#   3. a short Claude session (route.mjs `claude-tools`) checks the result against the hard rules, notifies the
#      orchestrators and asks the user's decisions as Chinese cards.
# When the route lands on personal quota (a ChatGPT account, or a whole Claude review), a short Claude session first
# asks the user with a Chinese card: run it now on personal quota, or skip tonight. NIGHTLY_PERSONAL_OK=1 (set by that
# session after a yes) skips the question; NIGHTLY_EXCLUDE carries accounts already ruled out; NIGHTLY_MODE=claude forces
# a whole Claude review (it still asks first); NIGHTLY_MODE=dry runs the worker read-only; NIGHTLY_MODE=plan only prints
# the routing decisions (no data, no model, nothing logged to route-log).
set -u
# launchd starts with a bare environment: put the user's tools (claude/codex in ~/.local/bin, Homebrew, nvm's node) on PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use default >/dev/null 2>&1 || true; fi
SKILL="${0:A:h:h}"
SELF="${0:A}"
DIR="$HOME/.claude/orchestrator/_shared/routing-review"
mkdir -p "$DIR"
DAY=$(date +%F)
NOW=$(date "+%F %H:%M %Z")  # the window ends when the review starts (03:07 from launchd; later on a manual run)
MODE="${NIGHTLY_MODE:-auto}"
PERSONAL_OK="${NIGHTLY_PERSONAL_OK:-0}"
EXCLUDE="${NIGHTLY_EXCLUDE:-}"
exec >>"$DIR/launch.log" 2>&1
NOTE=""; [ -n "$EXCLUDE" ] && NOTE="$NOTE, excluding $EXCLUDE"; [ "$PERSONAL_OK" = 1 ] && NOTE="$NOTE, personal quota approved"
echo "== $(date '+%F %T') launching review for $DAY (mode $MODE$NOTE)"
# Earlier review sessions that are still around have finished their day: stop them (their conversations are kept).
claude agents --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let a = []; try { a = JSON.parse(s); } catch {}
    for (const x of a) if ((x.name || "").startsWith("routing-nightly-review-") && !x.name.startsWith("routing-nightly-review-" + process.argv[1])) console.log(x.id);
  });' "$DAY" | while read -r id; do claude stop "$id" && echo "stopped $id"; done
cd "$DIR" || exit 1
ROUTE="$SKILL/scripts/route.mjs"
W="$SKILL/scripts/codex-worker.mjs"
ACCOUNTS="$HOME/.claude/orchestrator/_shared/codex-accounts.json"

# route <category> [args…] → one line: deferred|ok vendor model effort account kind home bin needsOK(0/1)
route() {
  node "$ROUTE" "$@" --json --project routing --name "routing-nightly-review-$DAY" --cwd "$DIR" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let o = {}; try { o = JSON.parse(s); } catch { console.log("error"); return; }
      if (o.deferred || !o.pick) { console.log("deferred " + (o.deferred || "no pick").replace(/\s+/g, "_")); return; }
      let reg = {}; try { reg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
      const p = o.pick, a = reg[p.account] || {};
      const id = a.kind === "trae" ? (a.modelIds || {})[p.model] || p.model : p.model;
      console.log(["ok", p.vendor, id, p.effort, p.account || "-", a.kind || (p.vendor === "codex" ? "chatgpt" : "claude"), a.home || "-", a.bin || "-", (o.needsUserOK || []).length ? 1 : 0].join(" "));
    });' "$ACCOUNTS"
}

[ "$MODE" = plan ] && export ROUTE_LOG=0
# 1. Data (these scripts call the claude/codex CLIs, so they run here, before any worker).
D="$DIR/$DAY.data"; mkdir -p "$D"
if [ "$MODE" != plan ] && [ ! -s "$D/review-data-24h.txt" ]; then
  node "$SKILL/scripts/review-data.mjs" --hours 24 > "$D/review-data-24h.txt" 2>&1
  node "$SKILL/scripts/review-data.mjs" --hours 168 > "$D/review-data-168h.txt" 2>&1
  node "$SKILL/scripts/orch-usage.mjs" --hours 24 > "$D/orch-usage-24h.txt" 2>&1
  echo "data gathered in $D"
fi
if [ "$MODE" != plan ]; then
  node "$SKILL/scripts/resource-review.mjs" --hours 24 > "$D/resource-review-24h.txt" 2>&1
  node "$SKILL/scripts/resource-review.mjs" --hours 24 --json > "$D/resource-review-24h.json" 2> "$D/resource-review-24h.err"
  node "$SKILL/scripts/resource-review.mjs" --hours 96 --json > "$D/resource-review-96h.json" 2> "$D/resource-review-96h.err"
  node "$SKILL/scripts/resource-sample.mjs" --read-only --json > "$D/resource-now.json" 2> "$D/resource-now.err"
  echo "read-only resource evidence gathered; exit 2 / missing intervals means UNKNOWN, never permission to clean"
fi
DATA="The data is already gathered: $D/review-data-24h.txt, $D/review-data-168h.txt, $D/orch-usage-24h.txt. Machine resources: $D/resource-review-24h.txt, $D/resource-review-24h.json, $D/resource-review-96h.json (multi-day threshold evidence), $D/resource-now.json and adjacent .err files. Follow the Machine resources step; no process/file cleanup or agent installation in the review worker."

# Personal quota needs the user's OK first: a short Claude session asks with a Chinese card, then re-runs this script.
ask_personal() {  # $1 = what would run, in words
  local FIN; FIN=$(route claude-tools); set -- "$1" ${=FIN}
  echo "personal quota needed ($1): asking the user"
  [ "$MODE" = plan ] && { echo "plan: would ask with ${4:-sonnet} ${5:-medium}"; return; }
  claude --bg --remote-control --permission-mode bypassPermissions -n "routing-nightly-review-$DAY-ask" --model "${4:-sonnet}" --effort "${5:-medium}" \
    "今晚的路由夜间复盘：公司额度（TTADK、TRAE）现在都不可用，按路由策略要用个人额度才能跑（$1）。先发一条 PushNotification（中文：「夜间复盘需要你选择是否用个人额度」），再用 AskUserQuestion 卡片用中文问用户，选项：「现在用个人额度跑（推荐）」—— 会花个人额度完成今晚的复盘；「今晚跳过」—— 等明晚公司额度恢复后再复盘。用户选「现在跑」后，运行：NIGHTLY_PERSONAL_OK=1 NIGHTLY_EXCLUDE='$EXCLUDE' NIGHTLY_MODE='$MODE' nohup $SELF >/dev/null 2>&1 & 然后结束。选「跳过」就在 $DIR/launch.log 末尾追加一行「$DAY skipped by the user」后结束。不要做别的事。"
}

claude_review() {  # $1 model, $2 effort, $3 why — the whole review as one Claude session (personal quota, already approved)
  echo "full Claude review ($1 $2): $3"
  claude --bg --remote-control --permission-mode bypassPermissions -n "routing-nightly-review-$DAY" --model "$1" --effort "$2" \
    "Run the nightly routing review for the 24 hours ending now ($NOW): read $SKILL/references/nightly-review.md and follow it exactly, doing both the worker's and the finisher's parts (ask the user's decisions as Chinese AskUserQuestion cards). $DATA"
  echo "exit $?"
}

if [ "$MODE" = claude ]; then
  if [ "$PERSONAL_OK" != 1 ]; then ask_personal "NIGHTLY_MODE=claude: a whole Claude review"; exit 0; fi
  claude_review opus high "NIGHTLY_MODE=claude"; exit 0
fi

# 2. The review worker, routed. Up to three tries, each without the accounts that failed before.
SANDBOX="danger-full-access"; [ "$MODE" = dry ] && SANDBOX="read-only"
DRYNOTE=""; [ "$MODE" = dry ] && DRYNOTE=" DRY RUN: read-only; make no edits, commits or pushes; write nothing except your final answer, which is the report."
PROMPT="You are the worker of the nightly routing review for the 24 hours ending now ($NOW). Read $SKILL/references/nightly-review.md and follow it, doing the worker's part in its section \"Who does what\". $DATA$DRYNOTE"
done_ok=0
for try in 1 2 3; do
  RARGS=(analysis --stakes high); [ -n "$EXCLUDE" ] && RARGS+=(--exclude-account "$EXCLUDE"); [ "$PERSONAL_OK" = 1 ] && RARGS+=(--urgent)
  R=$(route "${RARGS[@]}")
  set -- ${=R}
  if [ "$1" != ok ]; then echo "review not routed: $*"; exit 0; fi
  VENDOR=$2 MODEL=$3 EFFORT=$4 ACCT=$5 KIND=$6 AHOME=$7 ABIN=$8
  echo "route: $VENDOR $MODEL $EFFORT on ${ACCT} (${KIND})"
  if [ "$MODE" = plan ]; then
    if [ "$KIND" != ttadk ] && [ "$KIND" != trae ] && [ "$PERSONAL_OK" != 1 ]; then ask_personal "$VENDOR $MODEL $EFFORT"; fi
    F=$(route claude-tools); echo "plan: finisher $F"; exit 0
  fi
  if [ "$KIND" != ttadk ] && [ "$KIND" != trae ] && [ "$PERSONAL_OK" != 1 ]; then
    WHAT="$VENDOR $MODEL $EFFORT"; [ "$ACCT" != - ] && WHAT="$WHAT on account $ACCT"
    ask_personal "$WHAT"; exit 0
  fi
  if [ "$VENDOR" = claude ]; then claude_review "$MODEL" "$EFFORT" "routed to Claude"; exit 0; fi
  rm -f "$DIR/$DAY.notify.json"
  s=$(date +%s)
  case $KIND in
    ttadk)
      node "$W" --account "$ACCT" proxy >/dev/null 2>&1 || { echo "TTADK proxy did not start"; EXCLUDE="${EXCLUDE:+$EXCLUDE,}$ACCT"; continue; }
      CODEX_HOME="$AHOME" perl -e 'alarm 2400; exec @ARGV' -- codex exec --skip-git-repo-check -C "$DIR" -s "$SANDBOX" -m "$MODEL" \
        -c "model_reasoning_effort=\"$EFFORT\"" --json -o "$DIR/$DAY.worker-final.md" "$PROMPT" < /dev/null > "$DIR/$DAY.worker.jsonl" 2>&1 ;;
    trae)
      perl -e 'alarm 2400; exec @ARGV' -- "$ABIN" exec --skip-git-repo-check -C "$DIR" -s "$SANDBOX" -m "$MODEL" \
        -c "model_reasoning_effort=\"$EFFORT\"" --json -o "$DIR/$DAY.worker-final.md" "$PROMPT" < /dev/null > "$DIR/$DAY.worker.jsonl" 2>&1 ;;
    *)
      CODEX_HOME="$AHOME" perl -e 'alarm 2400; exec @ARGV' -- codex exec --skip-git-repo-check -C "$DIR" -s "$SANDBOX" -m "$MODEL" \
        -c "model_reasoning_effort=\"$EFFORT\"" --json -o "$DIR/$DAY.worker-final.md" "$PROMPT" < /dev/null > "$DIR/$DAY.worker.jsonl" 2>&1 ;;
  esac
  rc=$?
  echo "worker ($KIND $ACCT) exit $rc after $(( $(date +%s) - s ))s"
  [ "$MODE" = dry ] && { echo "dry run: report in $DIR/$DAY.worker-final.md; no finisher"; exit 0; }
  if [ $rc -eq 0 ] && [ -s "$DIR/$DAY.md" ] && [ -s "$DIR/$DAY.notify.json" ]; then done_ok=1; break; fi
  echo "worker on $ACCT failed or left no report/notify file — re-routing without it"
  [ "$KIND" = trae ] && node "$W" --account "$ACCT" note-failure "nightly review worker exit $rc" >/dev/null 2>&1
  EXCLUDE="${EXCLUDE:+$EXCLUDE,}$ACCT"
done
[ $done_ok = 1 ] || { echo "no worker produced the review after 3 tries"; exit 0; }

# 3. The finisher: route.mjs claude-tools (Claude only: it messages sessions and asks the user's cards).
F=$(route claude-tools); set -- ${=F}
FMODEL=sonnet FEFFORT=medium; [ "$1" = ok ] && { FMODEL=$3; FEFFORT=$4; }
claude --bg --remote-control --permission-mode bypassPermissions -n "routing-nightly-review-$DAY-finish" --model "$FMODEL" --effort "$FEFFORT" \
  "Finish the nightly routing review for $DAY: read $SKILL/references/nightly-review.md, section \"Who does what\" (the finisher's part) and \"Decisions for the user\", then the worker's report $DIR/$DAY.md and $DIR/$DAY.notify.json, and follow it. Ask every entry of notify.json decisions with AskUserQuestion cards in Chinese."
echo "finisher ($FMODEL $FEFFORT) exit $?"
