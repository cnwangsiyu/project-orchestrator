#!/bin/sh
exec python3 "$(dirname "$0")/lib/ios_split_build.py" "$@"
