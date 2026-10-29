#!/usr/bin/env bash
# Verify the ACME webroot path really serves, then retry issuance.
set -uo pipefail

DOMAIN=race-ops-broker.mmw-team.icu
WEBROOT=/var/www/certbot
PROBE_DIR="$WEBROOT/.well-known/acme-challenge"

echo "== prepare webroot =="
mkdir -p "$PROBE_DIR"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true
echo "probe-ok" > "$PROBE_DIR/probe"
chmod 0644 "$PROBE_DIR/probe"
ls -l "$PROBE_DIR/probe"

echo "== local (Host header) =="
curl -sS -o /dev/null -w "  via 127.0.0.1 -> %{http_code}\n" --max-time 8 \
  -H "Host: $DOMAIN" "http://127.0.0.1/.well-known/acme-challenge/probe"

echo "== public (real DNS) =="
body=$(curl -sS --max-time 10 "http://$DOMAIN/.well-known/acme-challenge/probe")
echo "  body: ${body:-<empty>}"
curl -sS -o /dev/null -w "  status -> %{http_code}\n" --max-time 10 \
  "http://$DOMAIN/.well-known/acme-challenge/probe"

rm -f "$PROBE_DIR/probe"

if [[ "$body" != "probe-ok" ]]; then
  echo "ACME PATH BROKEN — not attempting issuance"
  exit 1
fi

echo "== retry issuance =="
bash /tmp/finish-tls.sh
