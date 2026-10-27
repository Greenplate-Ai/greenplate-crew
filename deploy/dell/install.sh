#!/usr/bin/env bash
# One-time setup on the home server (run with sudo). Re-run to update the code.
set -euo pipefail
SRC="${1:-$HOME/greenplate-crew}"
id crew >/dev/null 2>&1 || useradd --system --home /opt/greenplate-crew --shell /usr/sbin/nologin crew
mkdir -p /opt/greenplate-crew
rsync -a --delete --exclude node_modules --exclude ios --exclude design --exclude deploy/.env "$SRC"/ /opt/greenplate-crew/
cd /opt/greenplate-crew && npm ci --omit=optional --no-audit --no-fund >/dev/null
chmod +x deploy/dell/*.sh && chown -R crew:crew /opt/greenplate-crew
mkdir -p /etc/credstore.encrypted && chmod 700 /etc/credstore.encrypted
for k in CREW_APP_TOKEN ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID MODEL_API_KEY GREENPLATE_MCP_TOKEN CREW_CAN_WRITE; do
  [ -f "/etc/credstore.encrypted/$k" ] || printf '' | systemd-creds encrypt --with-key=tpm2 --name="$k" - "/etc/credstore.encrypted/$k"
done
[ -s /etc/credstore.encrypted/CREW_APP_TOKEN.set ] || { openssl rand -hex 24 | tr -d '\n' | systemd-creds encrypt --with-key=tpm2 --name=CREW_APP_TOKEN - /etc/credstore.encrypted/CREW_APP_TOKEN; touch /etc/credstore.encrypted/CREW_APP_TOKEN.set; }
cp deploy/dell/crew.service /etc/systemd/system/crew.service
systemctl daemon-reload && systemctl enable --now crew && systemctl restart crew
sleep 3; curl -s http://127.0.0.1:8787/health; echo
