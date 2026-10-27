#!/usr/bin/env bash
# Save one key into deploy/.env without it showing on screen or in shell history.
# Usage (from your own terminal): ssh -t i2-ci-1 ~/greenplate-crew/deploy/set-key.sh ELEVENLABS_API_KEY
set -euo pipefail
NAME="${1:?which key, e.g. ELEVENLABS_API_KEY}"
FILE="$(dirname "$0")/.env"
case "$NAME" in CREW_APP_TOKEN|ELEVENLABS_API_KEY|ELEVENLABS_VOICE_ID|MODEL_API_KEY|GREENPLATE_MCP_TOKEN|CREW_CAN_WRITE) ;; *) echo "unknown key $NAME"; exit 1;; esac
read -r -s -p "Paste $NAME and press Enter: " VALUE; echo
[ -n "$VALUE" ] || { echo "nothing pasted, left unchanged"; exit 1; }
TMP="$(mktemp)"; grep -v "^$NAME=" "$FILE" > "$TMP" || true; printf '%s=%s\n' "$NAME" "$VALUE" >> "$TMP"
cat "$TMP" > "$FILE"; rm -f "$TMP"; chmod 600 "$FILE"
echo "Saved $NAME (${#VALUE} characters). It is only in $FILE on this machine."
