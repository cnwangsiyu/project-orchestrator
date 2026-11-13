#!/bin/bash
# Design artifact: do not install/load without separate user authorization.
# dry = read-only inventory + proposed coordination TEXT; no model, messages or kills.
set -euo pipefail
TASK_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
MODE=${MINI_CLEANUP_MODE:-dry}
case "$MODE" in
  dry)
    result=0
    /bin/bash "$TASK_DIR/inventory.sh" "$@" || result=$?
    cat >&2 <<'TEXT'
DRY: would coordinate with every name in ~/.claude/orchestrator/_shared/orchestrators.txt
(excluding Orchestrator 主对话), using:
「夜间 mini 健康清理候选如下（PID、启动时间、父子树、CPU/RSS、保护理由）。claim anything you still need?
请在 20 分钟内逐项回复 claim 或 release；没有回复、离线或含糊回复会视为 claim。
Chrome 若放行，结束 GUI 树后会立即重启并核验 Native Host。headless 测试树单独判断。」
No sessions stopped/launched, no messages sent, no signals, no files written by dry mode.
TEXT
    exit "$result"
    ;;
  apply)
    [ "$#" -eq 0 ] || { echo "apply mode accepts no inventory flags" >&2; exit 2; }
    exec python3 -B "$TASK_DIR/launch-nightly.py"
    ;;
  *) echo "MINI_CLEANUP_MODE must be dry or apply" >&2; exit 2 ;;
esac
