#!/usr/bin/env bash
# Install the race-ops broker on this host.
# Run with: sudo bash /tmp/broker-stage/install.sh
set -euo pipefail

STAGE=/tmp/broker-stage
DEST=/opt/race-ops-broker
SERVICE=race-ops-broker
NODE_BIN=/usr/local/bin/node

echo "== node =="
"$NODE_BIN" --version

echo "== user =="
if ! id raceops >/dev/null 2>&1; then
  useradd --system --home "$DEST" --shell /usr/sbin/nologin raceops
  echo "created user raceops"
else
  echo "user raceops exists"
fi

echo "== directories =="
mkdir -p "$DEST/broker" "$DEST/lib/auth"

echo "== files =="
install -m 0644 "$STAGE/core.mjs"        "$DEST/broker/core.mjs"
install -m 0644 "$STAGE/server.mjs"      "$DEST/broker/server.mjs"
install -m 0644 "$STAGE/github-app.js"   "$DEST/lib/auth/github-app.js"

# Private key and env: read-only for the service user only.
install -m 0400 "$STAGE"/*.pem           "$DEST/app.pem"
install -m 0400 "$STAGE/broker.env"      "$DEST/.env"

chown -R raceops:raceops "$DEST"
chmod 0755 "$DEST"
ls -l "$DEST" "$DEST/broker"

echo "== syntax check =="
"$NODE_BIN" --check "$DEST/broker/core.mjs"
"$NODE_BIN" --check "$DEST/broker/server.mjs"
echo "syntax ok"

echo "== systemd unit =="
cat >"/etc/systemd/system/${SERVICE}.service" <<'UNIT'
[Unit]
Description=race-ops GitHub App token broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=raceops
Group=raceops
WorkingDirectory=/opt/race-ops-broker
EnvironmentFile=/opt/race-ops-broker/.env
ExecStart=/usr/local/bin/node /opt/race-ops-broker/broker/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

sleep 2
echo "== status =="
systemctl is-active "$SERVICE"
echo "== health (loopback) =="
curl -sS --max-time 5 http://127.0.0.1:8787/health || echo "health request failed"
echo
echo "== recent log =="
journalctl -u "$SERVICE" -n 8 --no-pager || true

echo "== cleanup stage =="
rm -rf "$STAGE"
echo "done"
