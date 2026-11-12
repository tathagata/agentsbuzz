#!/usr/bin/env bash
# One line to a running feed:
#   curl -fsSL https://raw.githubusercontent.com/tathagata/agentsbuzz/main/install.sh | bash
# Clones next to your other projects (so they are found automatically), then runs ./buzz.
set -euo pipefail

if [ -n "${AGENTSBUZZ_DIR:-}" ]; then DEST="$AGENTSBUZZ_DIR"
elif [ -d "$HOME/projects" ]; then DEST="$HOME/projects/agentsbuzz"
else DEST="$HOME/agentsbuzz"; fi

command -v git >/dev/null 2>&1 || { echo "git is needed first." >&2; exit 1; }
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only --quiet || true
else
  git clone --quiet "${AGENTSBUZZ_REPO:-https://github.com/tathagata/agentsbuzz}" "$DEST"
fi
echo "agentsbuzz is in $DEST"
# when piped from curl, stdin is the script; give the launcher the keyboard back so it can ask questions
if [ ! -t 0 ] && [ -r /dev/tty ]; then exec "$DEST/buzz" "$@" < /dev/tty; fi
exec "$DEST/buzz" "$@"
