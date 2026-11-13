#!/bin/bash
# launchd entry: default dry; no live job installed by this repository.
set -euo pipefail
BASE=$(cd -- "$(dirname -- "$0")" && pwd)
exec /bin/bash "$BASE/resource-cleanup/mini-nightly-cleanup.sh" "$@"
