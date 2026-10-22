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
[[ -x $NODE ]] || { echo "node not found at $NODE" >&2; exit 1; }

# The agent's environment: written into the plist and validated by `proxy.mjs --check` as is.
AGENT_ENV=(CACHE_PROXY_UPSTREAM "$CACHE_PROXY_UPSTREAM" CACHE_PROXY_STATE_DIR "$STATE")
for name in $OPTIONAL; do
  if [[ -n ${(P)name:-} ]]; then AGENT_ENV+=("$name" "${(P)name}"); fi
done

# The proxy's own rules (URL, port, not pointing to itself) on exactly that environment, as launchd will
# start it: nothing is written or stopped if they fail.
CHECK_ENV=()
for name value in "${AGENT_ENV[@]}"; do CHECK_ENV+=("$name=$value"); done
env -i HOME="$HOME" PATH=/usr/bin:/bin "${CHECK_ENV[@]}" "$NODE" "$DIR/proxy.mjs" --check

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
  local name value
  for name value in "${AGENT_ENV[@]}"; do
    print -r -- "    <key>$name</key><string>$(xml "$value")</string>"
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
