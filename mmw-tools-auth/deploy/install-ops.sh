#!/usr/bin/env bash
# Install the operational layer around mmw-tools-auth: verified SQLite
# snapshots, a two-minute health probe with a bounded restart, and a journald
# size cap. Idempotent; run after server-install.sh has the service running.
#
#   sudo bash deploy/install-ops.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "install-ops: run as root (sudo)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE_BIN:-/usr/local/bin/node}"
APP_DIR="${MMW_APP_DIR:-/opt/mmw-tools-auth}"
LIB_DIR=/usr/local/lib/mmw-tools-auth
BACKUP_DIR="${MMW_BACKUP_DIR:-/var/backups/mmw-tools-auth}"

if [ ! -x "$NODE" ]; then
  echo "install-ops: $NODE is not executable" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/src/main.mjs" ]; then
  echo "install-ops: $APP_DIR/src/main.mjs is missing; run server-install.sh first" >&2
  exit 1
fi

install -d -m 0755 "$LIB_DIR"
install -m 0644 "$HERE/backup.mjs" "$LIB_DIR/backup.mjs"
install -m 0644 "$HERE/restore.mjs" "$LIB_DIR/restore.mjs"
install -m 0755 "$HERE/healthcheck.sh" /usr/local/sbin/mmw-auth-healthcheck

install -d -m 0700 -o ubuntu -g ubuntu "$BACKUP_DIR"

install -m 0644 "$HERE/systemd/mmw-tools-auth-backup.service" /etc/systemd/system/
install -m 0644 "$HERE/systemd/mmw-tools-auth-backup.timer" /etc/systemd/system/
install -m 0644 "$HERE/systemd/mmw-tools-auth-healthcheck.service" /etc/systemd/system/
install -m 0644 "$HERE/systemd/mmw-tools-auth-healthcheck.timer" /etc/systemd/system/
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$HERE/systemd/60-mmw-tools-auth.conf" /etc/systemd/journald.conf.d/

systemctl daemon-reload
systemctl enable --now mmw-tools-auth-backup.timer mmw-tools-auth-healthcheck.timer
systemctl restart systemd-journald

# Prove the backup path works now rather than discovering it at 03:20.
if [ -f "$APP_DIR/data/auth.sqlite" ]; then
  runuser -u ubuntu -- "$NODE" "$LIB_DIR/backup.mjs" \
    --data-dir "$APP_DIR/data" \
    --out-dir "$BACKUP_DIR" \
    --keep 7
else
  echo "install-ops: no auth.sqlite yet; the first snapshot runs after the database exists" >&2
fi

# One probe without --restart: installation must not bounce a running service.
if /usr/local/sbin/mmw-auth-healthcheck; then
  echo "install-ops: health probe OK"
else
  echo "install-ops: health probe failed; inspect: journalctl -u mmw-tools-auth -n 50" >&2
  exit 1
fi

echo "install-ops: backup timer and health timer enabled"
echo "install-ops: backups in $BACKUP_DIR (seven daily snapshots)"
