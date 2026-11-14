#!/bin/sh
# Keep the wrapper attached to the harness task; Node records all child exit paths.
exec node "$(dirname "$0")/run-tracked.mjs" "$@"
