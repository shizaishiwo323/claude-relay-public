#!/usr/bin/env bash
# Runs Claude Relay in this terminal on macOS or Linux (foreground; Ctrl+C stops it):
# the relay server and, when data/tunnel.env exists (TUNNEL_TOKEN=eyJ...), the Cloudflare Tunnel.
# Needs Node 20+ and, for the tunnel, cloudflared (macOS: brew install cloudflared).
# On a Linux server use linux/setup.sh instead (systemd services that start on boot).
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules/@anthropic-ai/claude-agent-sdk ] || npm ci --no-audit --no-fund
node server.mjs & SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT INT TERM
if [ -f data/tunnel.env ]; then
  set -a; . data/tunnel.env; set +a
  cloudflared tunnel --no-autoupdate run
else
  echo "No data/tunnel.env: running on this computer only (see README to put it online)."
  wait $SERVER
fi
