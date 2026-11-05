#!/usr/bin/env bash
# Issue and install the certificate for the auth subdomain, reusing the
# existing Tencent DNS-01 setup. Run as root:
#   sudo bash /tmp/issue-cert.sh
set -euo pipefail

DOMAIN=mmw-tools.mmw-team.icu
CERT_DIR=/etc/nginx/ssl/mmw-tools
ACME_HOME=/root/.acme.sh

set -a
. /etc/acme/tencent.env
set +a

"$ACME_HOME/acme.sh" --issue --dns dns_tencent -d "$DOMAIN" --home "$ACME_HOME"

mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"
"$ACME_HOME/acme.sh" --install-cert -d "$DOMAIN" \
  --key-file "$CERT_DIR/privkey.pem" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --reloadcmd "systemctl reload nginx" \
  --home "$ACME_HOME"

chmod 600 "$CERT_DIR/privkey.pem"
chmod 644 "$CERT_DIR/fullchain.pem"

echo "installed $CERT_DIR/fullchain.pem"
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null || true
