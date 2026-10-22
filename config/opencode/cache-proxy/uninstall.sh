#!/bin/zsh
# Stops and removes the launchd agent. The journal and the log in the state directory are kept.
set -euo pipefail

LABEL=com.github.maxmaximov.opencode-cache-proxy
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "removed $LABEL"
