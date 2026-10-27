#!/usr/bin/env bash
# Reads each decrypted credential systemd provides (only to this service) into the environment.
set -euo pipefail
for f in "${CREDENTIALS_DIRECTORY:-/nonexistent}"/*; do
  [ -f "$f" ] && export "$(basename "$f")=$(cat "$f")"
done
exec /usr/bin/node node_modules/tsx/dist/cli.mjs src/kitchen/serve.ts
