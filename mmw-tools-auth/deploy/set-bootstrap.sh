#!/usr/bin/env bash
# Generate a one-time admin bootstrap token, put it in the service env, and
# write the login URL to a root-only file. Run as ubuntu:
#   bash /tmp/set-bootstrap.sh
set -euo pipefail

APP_DIR=/opt/mmw-tools-auth
TOKEN=$(/usr/local/bin/node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')

sudo -n sed -i "s|^MMW_BOOTSTRAP_TOKEN=.*|MMW_BOOTSTRAP_TOKEN=${TOKEN}|" "$APP_DIR/.env"
printf '%s\n' "$TOKEN" | sudo -n tee /root/mmw-tools-bootstrap.txt >/dev/null
printf 'https://mmw-tools.mmw-team.icu/auth/feishu/start?bootstrap=%s\n' "$TOKEN" \
  | sudo -n tee /root/mmw-tools-bootstrap-url.txt >/dev/null
sudo -n chmod 600 /root/mmw-tools-bootstrap.txt /root/mmw-tools-bootstrap-url.txt

sudo -n systemctl reset-failed mmw-tools-auth.service
sudo -n systemctl restart mmw-tools-auth.service
sleep 2
curl -fsS --max-time 5 http://127.0.0.1:4326/health
echo
echo "bootstrap URL: /root/mmw-tools-bootstrap-url.txt (root-only)"
