#!/usr/bin/env bash
# One-time setup (and code updates) on the home server. Run with sudo.
set -eu
SRC="${1:-$HOME/greenplate-crew}"
id crew >/dev/null 2>&1 || useradd --system --home /opt/greenplate-crew --shell /usr/sbin/nologin crew
mkdir -p /opt/greenplate-crew
rsync -a --delete --exclude node_modules --exclude ios --exclude design "$SRC"/ /opt/greenplate-crew/
cd /opt/greenplate-crew && npm ci --no-audit --no-fund >/dev/null
chown -R crew:crew /opt/greenplate-crew
cp deploy/dell/crew.service /etc/systemd/system/crew.service
systemctl daemon-reload && systemctl enable crew >/dev/null 2>&1 && systemctl restart crew
sleep 4; systemctl is-active crew; curl -s http://127.0.0.1:8787/health; echo
