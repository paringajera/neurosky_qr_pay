#!/usr/bin/env bash
# Pull the latest code from origin, reinstall dependencies and restart NeuroSky Pay.
# Run as root:  bash /opt/neurosky-pay/deploy/hostinger-vps/update.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/neurosky-pay}"
APP_USER="${APP_USER:-neurosky}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo -i first)." >&2; exit 1; }
[ -d "$APP_DIR/.git" ] || { echo "$APP_DIR is not a git checkout; upload the new files and run: systemctl restart neurosky-pay" >&2; exit 1; }

echo "==> Backing up the database first"
APP_DIR="$APP_DIR" "$APP_DIR/deploy/hostinger-vps/backup.sh"

echo "==> Fetching the latest code"
sudo -u "$APP_USER" -H git -C "$APP_DIR" fetch --prune --all
sudo -u "$APP_USER" -H git -C "$APP_DIR" pull --ff-only

echo "==> Installing dependencies"
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund"

echo "==> Restarting the service"
systemctl restart neurosky-pay
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:6100/health >/dev/null 2>&1; then
    echo "Payment API is UP after ${i}s"
    systemctl --no-pager --lines=0 status neurosky-pay | head -5
    exit 0
  fi
  sleep 1
done
echo "Payment API did not come up in 60s. Inspect: journalctl -u neurosky-pay -n 100 --no-pager" >&2
exit 1
