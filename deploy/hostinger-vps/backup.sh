#!/usr/bin/env bash
# Nightly online backup of the NeuroSky Pay SQLite database (safe while services are running).
# Installed as a cron job by deploy/hostinger-vps/install.sh; run manually any time:
#   APP_DIR=/opt/neurosky-pay deploy/hostinger-vps/backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/neurosky-pay}"
OUT_DIR="${OUT_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

DB="${SQLITE_DB_PATH:-}"
if [ -z "$DB" ] && [ -f "$APP_DIR/.env" ]; then
  DB="$(grep -E '^SQLITE_DB_PATH=' "$APP_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'" || true)"
fi
[ -n "$DB" ] || DB="./data/neurosky_pay.sqlite"
case "$DB" in
  /*) ;;
  *) DB="$APP_DIR/${DB#./}" ;;
esac

if [ ! -f "$DB" ]; then
  echo "$(date -Is) no database at $DB, nothing to back up"
  exit 0
fi

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$OUT_DIR/neurosky_pay-$STAMP.sqlite"
sqlite3 "$DB" ".backup '$TARGET'"
gzip -f "$TARGET"
find "$OUT_DIR" -name 'neurosky_pay-*.sqlite.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $TARGET.gz"
