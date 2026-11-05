#!/usr/bin/env bash
# Install/refresh the mmw-tools-auth service on the Tencent host.
#
# Run as the ubuntu user (sudo is passwordless):
#   bash /tmp/server-install.sh
#
# Assumes the code is already extracted to /opt/mmw-tools-auth and the
# Feishu app env is at /tmp/mmw-tools-auth.env (or already at
# /opt/mmw-tools-auth/.env). The script never prints the app secret or
# tenant key.
set -euo pipefail

APP_DIR=/opt/mmw-tools-auth
ENV_FILE="$APP_DIR/.env"
SERVICE=/etc/systemd/system/mmw-tools-auth.service

if [ ! -f "$APP_DIR/src/main.mjs" ]; then
  echo "missing $APP_DIR/src/main.mjs; extract the archive first" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ -f /tmp/mmw-tools-auth.env ]; then
    sudo -n cp /tmp/mmw-tools-auth.env "$ENV_FILE"
  else
    echo "missing $ENV_FILE and /tmp/mmw-tools-auth.env" >&2
    exit 1
  fi
fi

# Reuse the tenant key already configured for the review service. Both apps
# belong to the same Feishu organization.
TENANT=$(sudo -n grep -m1 '^FEISHU_TENANT_KEY=' /opt/mmw-review-system/.env.local | cut -d= -f2-)
if [ -z "$TENANT" ]; then
  echo "could not read FEISHU_TENANT_KEY from the review service env" >&2
  exit 1
fi

sudo -n sed -i "s|^FEISHU_TENANT_KEY=.*|FEISHU_TENANT_KEY=${TENANT}|" "$ENV_FILE"
sudo -n sed -i 's|^MMW_CONTRACTS_DIR=.*|MMW_CONTRACTS_DIR=./contracts|' "$ENV_FILE"
sudo -n chown -R ubuntu:ubuntu "$APP_DIR"
sudo -n chmod 600 "$ENV_FILE"
sudo -n mkdir -p "$APP_DIR/data"
sudo -n chown ubuntu:ubuntu "$APP_DIR/data"
sudo -n chmod 700 "$APP_DIR/data"

sudo -n tee "$SERVICE" >/dev/null <<'UNIT'
[Unit]
Description=mmw-tools Feishu auth core
Documentation=file:///opt/mmw-tools-auth/README.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/mmw-tools-auth
EnvironmentFile=/opt/mmw-tools-auth/.env
ExecStart=/usr/local/bin/node src/main.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
ReadWritePaths=/opt/mmw-tools-auth/data
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT

sudo -n systemctl daemon-reload
sudo -n systemctl reset-failed mmw-tools-auth.service
sudo -n systemctl enable --now mmw-tools-auth.service
sleep 2

if ! curl -fsS --max-time 5 http://127.0.0.1:4326/health; then
  echo
  echo "health check failed; recent journal:" >&2
  sudo -n journalctl -u mmw-tools-auth.service -n 40 --no-pager >&2 || true
  exit 1
fi
echo
echo "mmw-tools-auth is running on 127.0.0.1:4326"
