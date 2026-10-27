#!/usr/bin/env bash
# Save one key for the crew service, encrypted with this machine's TPM. Input is hidden.
# Usage (your own terminal): ssh -t i2-ci-1 sudo /opt/greenplate-crew/deploy/dell/set-key.sh ELEVENLABS_API_KEY
set -euo pipefail
NAME="${1:?which key, e.g. ELEVENLABS_API_KEY}"
case "$NAME" in CREW_APP_TOKEN|ELEVENLABS_API_KEY|ELEVENLABS_VOICE_ID|MODEL_API_KEY|GREENPLATE_MCP_TOKEN|CREW_CAN_WRITE) ;; *) echo "unknown key $NAME"; exit 1;; esac
if [ "$NAME" = CREW_APP_TOKEN ] && [ "${2:-}" = --generate ]; then VALUE=$(openssl rand -hex 24)
else read -r -s -p "Paste $NAME and press Enter: " VALUE; echo; fi
[ -n "$VALUE" ] || { echo "nothing pasted, left unchanged"; exit 1; }
mkdir -p /etc/credstore.encrypted && chmod 700 /etc/credstore.encrypted
printf '%s' "$VALUE" | systemd-creds encrypt --with-key=tpm2 --name="$NAME" - "/etc/credstore.encrypted/$NAME"
echo "Saved $NAME encrypted to this machine's TPM. Restart with: sudo systemctl restart crew"
