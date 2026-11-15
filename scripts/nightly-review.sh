#!/bin/zsh -l
# launchd entrypoint; the deadline is a notification, never a worker timeout.
# Installation and deadline-check template: references/nightly-review.md, Schedule.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use default >/dev/null 2>&1 || true; fi
exec node "${0:A:h}/nightly-review.mjs" "$@"
