#!/usr/bin/env bash
# Copy credential values from an existing .env (for example the one you already use on your
# workstation) into the production .env rendered by install.sh, so the server keeps the same
# admin token, Android enrollment secret and Gmail OAuth client instead of freshly generated ones.
#
# Only the keys listed in KEYS are copied. URLs, ports, mode and origin settings are never touched,
# so the production file keeps its domain configuration. Values are never printed.
#
# Usage (as root):
#   bash apply-env-credentials.sh <source-env> [target-env]      (target defaults to /opt/neurosky-pay/.env)
# install.sh runs this automatically when SEED_ENV_FILE=<source-env> is set.
set -euo pipefail
umask 077

SRC="${1:-}"
DST="${2:-/opt/neurosky-pay/.env}"
KEYS=(ADMIN_API_TOKEN ANDROID_ENROLLMENT_SECRET OBSERVER_API_TOKEN ENCRYPTION_MASTER_KEY JWT_SECRET GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET)

[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "Usage: bash $0 <source-env> [target-env]" >&2; exit 1; }
[ -f "$DST" ] || { echo "Target $DST does not exist; run install.sh first." >&2; exit 1; }
[ "$(readlink -f "$SRC")" != "$(readlink -f "$DST")" ] || { echo "Source and target are the same file." >&2; exit 1; }

owner="$(stat -c '%U:%G' "$DST" 2>/dev/null || true)"
copied=0
skipped=()
for key in "${KEYS[@]}"; do
  value="$(grep -m1 "^${key}=" "$SRC" | cut -d= -f2- | tr -d '\r' || true)"
  if [ -z "$value" ]; then
    skipped+=("$key")
    continue
  fi
  if grep -q "^${key}=" "$DST"; then
    # ENVIRON keeps the value byte-for-byte (awk -v would interpret backslash escapes).
    k="$key" v="$value" awk 'BEGIN { k = ENVIRON["k"]; v = ENVIRON["v"] } index($0, k "=") == 1 { print k "=" v; next } { print }' "$DST" > "$DST.tmp"
  else
    cp "$DST" "$DST.tmp"
    printf '%s=%s\n' "$key" "$value" >> "$DST.tmp"
  fi
  mv "$DST.tmp" "$DST"
  copied=$((copied + 1))
  echo "  $key: copied"
done
unset value

chmod 600 "$DST"
[ -n "$owner" ] && chown "$owner" "$DST" 2>/dev/null || true
echo "Copied $copied credential value(s) from $SRC into $DST (values not printed)."
[ "${#skipped[@]}" -eq 0 ] || echo "Not present in source, left as-is: ${skipped[*]}"
echo "Restart to apply: systemctl restart neurosky-pay"
