#!/usr/bin/env bash
# Claude Relay - one-shot setup on a Linux server (Debian / Ubuntu; tested on Ubuntu 24.04).
# Clone the repo as the user that should run the relay, then run this as root:
#   git clone https://github.com/<you>/claude-relay.git && cd claude-relay
#   sudo bash linux/setup.sh
# Installs Node 22, cloudflared and Claude Code, asks for your addresses and the tunnel token, builds the
# "my computer" connector and installs two systemd services (relay + tunnel). Safe to run again.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="$(stat -c %U "$REPO")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
step() { printf '\n== %s\n' "$*"; }
as_user() { sudo -u "$RUN_USER" -H bash -c "cd '$REPO' && $*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash linux/setup.sh"; exit 1; }
[ "$RUN_USER" != root ] || echo "Note: the repo belongs to root, so the relay runs as root. A normal user is safer."

step 'Packages'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq curl git ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v cloudflared >/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null
fi
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null
echo "  node $(node -v), $(cloudflared --version | head -1), claude $(claude --version 2>/dev/null || echo '?')"

step 'npm dependencies'
as_user "npm ci --no-audit --no-fund"

step 'Your addresses and the Cloudflare tunnel token'
as_user "mkdir -p data"
CFG="$REPO/data/config.json"
PUB="$(node -e "try{console.log(require('$CFG').publicUrl||'')}catch{}")"
if [ -z "$PUB" ] || [[ "$PUB" == http://localhost* ]]; then
  echo 'The web address of your relay, e.g. https://claude.example.com (README, step 2).'
  read -rp 'Main address (Enter = only this computer): ' PUB </dev/tty || true
  PUB="${PUB%/}"
  if [ -n "$PUB" ]; then
    [[ "$PUB" =~ ^https?:// ]] || PUB="https://$PUB"
    HOST="${PUB#*://}"; DEF="https://preview.${HOST#*.}"
    read -rp "Preview address (Enter = $DEF): " PREV </dev/tty || true
    PREV="${PREV%/}"; PREV="${PREV:-$DEF}"; [[ "$PREV" =~ ^https?:// ]] || PREV="https://$PREV"
    as_user "node -e \"const f='$CFG',fs=require('fs');let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{};c.publicUrl='$PUB';c.previewUrl='$PREV';fs.writeFileSync(f,JSON.stringify(c,null,2))\""
  fi
else echo "  $PUB (edit data/config.json to change)"; fi
if [ -n "$PUB" ] && [ ! -f "$REPO/data/tunnel.env" ]; then
  read -rp 'Tunnel token (the long eyJ... string): ' TOK </dev/tty || true
  TOK="$(printf '%s' "$TOK" | sed 's/.*service install[[:space:]]*//' | tr -d '[:space:]')"
  if [ -n "$TOK" ]; then printf 'TUNNEL_TOKEN=%s\n' "$TOK" > "$REPO/data/tunnel.env"; chown "$RUN_USER" "$REPO/data/tunnel.env"; chmod 600 "$REPO/data/tunnel.env"; fi
fi

step 'Building the "my computer" connector'
as_user "node connector/build.mjs" || echo "  skipped - run 'node connector/build.mjs' later to enable My computer"

step 'systemd services'
for u in claude-relay.service claude-relay-tunnel.service; do
  sed -e "s#@USER@#$RUN_USER#g" -e "s#@REPO@#$REPO#g" -e "s#@HOME@#$RUN_HOME#g" -e "s#@NODE@#$(command -v node)#g" -e "s#@CLOUDFLARED@#$(command -v cloudflared)#g" \
    "$REPO/linux/systemd/$u" > "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl enable --now claude-relay.service
systemctl restart claude-relay.service
if [ -f "$REPO/data/tunnel.env" ]; then systemctl enable --now claude-relay-tunnel.service; systemctl restart claude-relay-tunnel.service
else echo "  no data/tunnel.env: running on this machine only"; fi

step 'Claude login'
if [ -f "$RUN_HOME/.claude/.credentials.json" ]; then echo '  logged in'
else echo "  not logged in yet: run   sudo -u $RUN_USER -H claude   then type /login, then /exit"; fi

sleep 4
node -e "const c=require('$CFG');console.log('\nManagement link (keep it to yourself, it is a password):\n  '+c.publicUrl+'/?k='+c.adminKey)"
