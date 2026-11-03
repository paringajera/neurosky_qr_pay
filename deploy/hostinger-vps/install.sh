#!/usr/bin/env bash
# NeuroSky Pay — one-shot installer for a fresh Ubuntu 22.04 / 24.04 VPS (for example a Hostinger KVM plan).
#
# What it does (idempotent, safe to re-run):
#   1. Installs Node.js 24 LTS, Caddy (automatic HTTPS), git, sqlite3 and ufw
#   2. Creates the unprivileged system user "neurosky" and puts the code in /opt/neurosky-pay
#   3. Installs npm dependencies
#   4. Renders /opt/neurosky-pay/.env from env.production.template (secrets generated once, never printed)
#   5. Installs and starts the systemd service "neurosky-pay" (npm start = production supervisor)
#   6. Installs the Caddyfile that publishes the services over HTTPS on your domain
#   7. Opens only ports 22, 80 and 443 in ufw and schedules a nightly SQLite backup
#
# Usage (as root):
#   bash install.sh <base-domain> [prefix] [merchant-site-origin]
# Example:
#   bash install.sh example.com pay https://shop.example.com
#
# Public hostnames created from <base-domain> and [prefix] (default "pay"):
#   pay.example.com        -> Checkout portal + neurosky.js  (port 7000)
#   pay-api.example.com    -> Payment API                    (port 6100)
#   pay-admin.example.com  -> Merchant Admin                 (port 6001)
#   pay-gmail.example.com  -> Gmail OAuth callback/observer  (port 6003)
#   pay-store.example.com  -> Demo store (optional)          (port 5000)
# Create DNS A records for all of them pointing at this VPS before running the script.
#
# Overridable environment variables:
#   APP_DIR (default /opt/neurosky-pay)   APP_USER (default neurosky)
#   REPO_URL (default https://github.com/paringajera/neurosky_qr_pay.git)   BRANCH (default main)
#   NODE_MAJOR (default 24)               ACME_EMAIL (default admin@<base-domain>)
set -euo pipefail

DOMAIN="${1:-}"
PREFIX="${2:-pay}"
MERCHANT_ORIGIN="${3:-}"
APP_DIR="${APP_DIR:-/opt/neurosky-pay}"
APP_USER="${APP_USER:-neurosky}"
REPO_URL="${REPO_URL:-https://github.com/paringajera/neurosky_qr_pay.git}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-24}"
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$DOMAIN" ] || die "Usage: bash install.sh <base-domain> [prefix] [merchant-site-origin]"
[ "$(id -u)" -eq 0 ] || die "Run this script as root (sudo -i first)."
command -v apt-get >/dev/null || die "This installer supports Debian/Ubuntu (apt-get) only."

DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/+$##')"
PREFIX="$(printf '%s' "$PREFIX" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]//g')"
[ -n "$PREFIX" ] || PREFIX="pay"
ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"
STORE_ORIGIN="https://${PREFIX}-store.${DOMAIN}"
if [ -z "$MERCHANT_ORIGIN" ]; then
  MERCHANT_ORIGIN="$STORE_ORIGIN"
  echo "No merchant site origin given; using the demo store origin ($STORE_ORIGIN). Edit NEUROSKY_ALLOWED_ORIGINS,"
  echo "NEUROSKY_ALLOWED_RETURN_ORIGINS and CHECKOUT_FRAME_ANCESTORS in $APP_DIR/.env when you connect your real store."
fi
MERCHANT_ORIGIN="$(printf '%s' "$MERCHANT_ORIGIN" | sed -E 's#/+$##')"

export DEBIAN_FRONTEND=noninteractive

log "1/7 Installing base packages"
apt-get update -y
apt-get install -y curl git ufw sqlite3 ca-certificates gnupg apt-transport-https build-essential python3 \
  debian-keyring debian-archive-keyring

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy web server"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
caddy version

log "2/7 Creating service user and fetching the code"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/${APP_USER}" --shell /usr/sbin/nologin "$APP_USER"
fi
if [ -d "$APP_DIR/.git" ]; then
  echo "Existing checkout found in $APP_DIR; updating."
  git -C "$APP_DIR" fetch --prune --all
  git -C "$APP_DIR" checkout -q "$BRANCH"
  git -C "$APP_DIR" pull --ff-only
elif [ -f "$APP_DIR/package.json" ]; then
  echo "Using the uploaded copy already present in $APP_DIR."
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "3/7 Installing npm dependencies"
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund"

log "4/7 Writing production .env"
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists; leaving it untouched (delete it to regenerate)."
else
  ENCRYPTION_MASTER_KEY="$(openssl rand -hex 32)"
  JWT_SECRET="$(openssl rand -hex 32)"
  ADMIN_API_TOKEN="$(openssl rand -hex 32)"
  sed -e "s#__DOMAIN__#${DOMAIN}#g" \
      -e "s#__PREFIX__#${PREFIX}#g" \
      -e "s#__MERCHANT_ORIGIN__#${MERCHANT_ORIGIN}#g" \
      -e "s#__ENCRYPTION_MASTER_KEY__#${ENCRYPTION_MASTER_KEY}#g" \
      -e "s#__JWT_SECRET__#${JWT_SECRET}#g" \
      -e "s#__ADMIN_API_TOKEN__#${ADMIN_API_TOKEN}#g" \
      "$KIT_DIR/env.production.template" > "$ENV_FILE"
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  unset ENCRYPTION_MASTER_KEY JWT_SECRET ADMIN_API_TOKEN
  echo "Rendered $ENV_FILE with freshly generated secrets."
fi

log "5/7 Installing systemd service"
sed -e "s#__APP_DIR__#${APP_DIR}#g" -e "s#__APP_USER__#${APP_USER}#g" \
  "$KIT_DIR/neurosky-pay.service" > /etc/systemd/system/neurosky-pay.service
chmod +x "$KIT_DIR/backup.sh" "$KIT_DIR/update.sh" 2>/dev/null || true
systemctl daemon-reload
systemctl enable neurosky-pay >/dev/null
systemctl restart neurosky-pay

log "6/7 Publishing services with Caddy (automatic HTTPS)"
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "NeuroSky Pay" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
fi
sed -e "s#__DOMAIN__#${DOMAIN}#g" -e "s#__PREFIX__#${PREFIX}#g" -e "s#__ACME_EMAIL__#${ACME_EMAIL}#g" \
  "$KIT_DIR/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy >/dev/null
systemctl restart caddy

log "7/7 Firewall and nightly backup"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,8p'
cat > /etc/cron.d/neurosky-pay-backup <<EOF
# Nightly SQLite backup of NeuroSky Pay (keeps 14 days) — installed by deploy/hostinger-vps/install.sh
15 2 * * * ${APP_USER} APP_DIR=${APP_DIR} ${KIT_DIR}/backup.sh >> ${APP_DIR}/backups/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/neurosky-pay-backup

log "Waiting for the Payment API to report healthy"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:6100/health >/dev/null 2>&1; then echo "Payment API is UP after ${i}s"; break; fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    echo "Payment API did not come up in 60s. Inspect: journalctl -u neurosky-pay -n 100 --no-pager"
  fi
done

cat <<EOF

====================================================================
 NeuroSky Pay is installed.
====================================================================
 Checkout + neurosky.js : https://${PREFIX}.${DOMAIN}
 Payment API            : https://${PREFIX}-api.${DOMAIN}
 Merchant Admin         : https://${PREFIX}-admin.${DOMAIN}
 Gmail OAuth callback   : https://${PREFIX}-gmail.${DOMAIN}/oauth/callback
 Demo store (optional)  : https://${PREFIX}-store.${DOMAIN}

 Admin token (paste into the dashboard unlock box):
   grep '^ADMIN_API_TOKEN=' ${APP_DIR}/.env

 Next steps:
   1. Make sure the DNS A records above point at this server; Caddy fetches
      certificates automatically once they resolve.
   2. Open the Merchant Admin, add and activate your receiving UPI ID, then set
      RECEIVING_ACCOUNT_ID in ${APP_DIR}/.env and run: systemctl restart neurosky-pay
   3. Register the Gmail OAuth redirect URI above in Google Cloud Console.
   4. Developer Hub -> Android SMS Hub: download the APK, pair the bank-SIM phone.
   5. Logs: journalctl -u neurosky-pay -f    Update: bash ${KIT_DIR}/update.sh
====================================================================
EOF
