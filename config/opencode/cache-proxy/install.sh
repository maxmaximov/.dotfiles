#!/bin/zsh
# Installs and starts the launchd agent of the opencode cache proxy.
#   CACHE_PROXY_UPSTREAM=<LiteLLM origin without /v1> ./install.sh           install and start
#   CACHE_PROXY_UPSTREAM=<LiteLLM origin without /v1> ./install.sh --print   print the plist only
# Optional variables are copied into the plist when set: CACHE_PROXY_PORT, CACHE_PROXY_PING_AFTER_SEC,
# CACHE_PROXY_LATE_AFTER_SEC, CACHE_PROXY_WINDOW_SEC, CACHE_PROXY_DAILY_CAP, CACHE_PROXY_PING_MAX_TOKENS.
set -euo pipefail

LABEL=com.github.maxmaximov.opencode-cache-proxy
DIR=${0:A:h}
NODE=${NODE:-/opt/homebrew/bin/node}
STATE=${CACHE_PROXY_STATE_DIR:-$HOME/.local/state/opencode-cache-proxy}
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
PORT=${CACHE_PROXY_PORT:-18765}
OPTIONAL=(CACHE_PROXY_PORT CACHE_PROXY_PING_AFTER_SEC CACHE_PROXY_LATE_AFTER_SEC CACHE_PROXY_WINDOW_SEC
  CACHE_PROXY_DAILY_CAP CACHE_PROXY_PING_MAX_TOKENS)

: ${CACHE_PROXY_UPSTREAM:?set CACHE_PROXY_UPSTREAM to the LiteLLM origin without /v1}
if [[ $CACHE_PROXY_UPSTREAM == *127.0.0.1* || $CACHE_PROXY_UPSTREAM == *localhost* ]]; then
  echo "CACHE_PROXY_UPSTREAM must point to LiteLLM, not to the proxy itself" >&2
  exit 1
fi
[[ -x $NODE ]] || { echo "node not found at $NODE" >&2; exit 1; }

xml() {
  local s=$1
  s=${s//&/&amp;}; s=${s//</&lt;}; s=${s//>/&gt;}
  print -r -- "$s"
}

plist() {
  print -r -- '<?xml version="1.0" encoding="UTF-8"?>'
  print -r -- '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  print -r -- '<plist version="1.0"><dict>'
  print -r -- "  <key>Label</key><string>$LABEL</string>"
  print -r -- "  <key>ProgramArguments</key><array><string>$(xml $NODE)</string><string>$(xml $DIR/proxy.mjs)</string></array>"
  print -r -- '  <key>EnvironmentVariables</key><dict>'
  print -r -- "    <key>CACHE_PROXY_UPSTREAM</key><string>$(xml $CACHE_PROXY_UPSTREAM)</string>"
  print -r -- "    <key>CACHE_PROXY_STATE_DIR</key><string>$(xml $STATE)</string>"
  local name
  for name in $OPTIONAL; do
    if [[ -n ${(P)name:-} ]]; then
      print -r -- "    <key>$name</key><string>$(xml ${(P)name})</string>"
    fi
  done
  print -r -- '  </dict>'
  print -r -- '  <key>RunAtLoad</key><true/>'
  print -r -- '  <key>KeepAlive</key><true/>'
  print -r -- '  <key>ProcessType</key><string>Interactive</string>'
  print -r -- "  <key>StandardOutPath</key><string>$(xml $STATE/proxy.log)</string>"
  print -r -- "  <key>StandardErrorPath</key><string>$(xml $STATE/proxy.log)</string>"
  print -r -- '</dict></plist>'
}

if [[ ${1:-} == --print ]]; then
  plist
  exit 0
fi

mkdir -p "$STATE" "${PLIST:h}"
plist > "$PLIST"
plutil -lint "$PLIST"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
for _ in {1..20}; do
  curl -fsS "http://127.0.0.1:$PORT/status" > /dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -fsS "http://127.0.0.1:$PORT/status" > /dev/null; then
  echo "the proxy does not answer on port $PORT; see $STATE/proxy.log" >&2
  exit 1
fi
echo "installed $LABEL, listening on 127.0.0.1:$PORT; journal and log in $STATE"
