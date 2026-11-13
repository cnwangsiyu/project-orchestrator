#!/bin/bash
# Read-only: JSON on stdout, short human summary on stderr. No model, no files written.
set -euo pipefail
TASK_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec python3 -B "$TASK_DIR/inventory.py" "$@"
