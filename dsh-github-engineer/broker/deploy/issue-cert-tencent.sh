#!/usr/bin/env bash
# Issue the broker certificate via DNS-01 (Tencent Cloud DNS API) and wire
# it into nginx. Idempotent: re-running renews/reinstalls.
#
# Why DNS-01: this host's inbound port 80 is intercepted for the CA's
# vantage point (a 备案 block page), so http-01 can never validate. DNS-01
# proves control through a TXT record instead and needs no inbound access.
set -euo pipefail

DOMAIN=race-ops-broker.mmw-team.icu
ACME=/root/.acme.sh/acme.sh
CRED=/etc/acme/tencent.env
SSLDIR=/etc/nginx/ssl/race-ops-broker
SITE=/etc/nginx/sites-available/race-ops-broker

test -f "$CRED" || { echo "missing $CRED"; exit 1; }
# shellcheck disable=SC1090
. "$CRED"
test -n "${Tencent_SecretId:-}" || { echo "Tencent_SecretId empty"; exit 1; }
test -n "${Tencent_SecretKey:-}" || { echo "Tencent_SecretKey empty"; exit 1; }
export Tencent_SecretId Tencent_SecretKey

echo "== issue (dns_tencent, Let's Encrypt) =="
"$ACME" --issue --dns dns_tencent -d "$DOMAIN" \
  --server letsencrypt \
  --keylength 2048 2>&1 | tail -18

echo "== install =="
install -d -m 0755 "$SSLDIR"
"$ACME" --install-cert -d "$DOMAIN" \
  --key-file       "$SSLDIR/privkey.pem" \
  --fullchain-file "$SSLDIR/fullchain.pem" \
  --reloadcmd      "systemctl reload nginx" 2>&1 | tail -6

echo "== certificate =="
openssl x509 -in "$SSLDIR/fullchain.pem" -noout -subject -issuer -dates
echo -n "SAN: "; openssl x509 -in "$SSLDIR/fullchain.pem" -noout -ext subjectAltName 2>/dev/null | tail -1

echo "== 443 block =="
if grep -q "listen 443" "$SITE"; then
  echo "already present"
else
  cat >>"$SITE" <<BLOCK

server {
    listen 443 ssl http2;
    server_name $DOMAIN;
    server_tokens off;

    ssl_certificate     $SSLDIR/fullchain.pem;
    ssl_certificate_key $SSLDIR/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 16k;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 20s;
    }
}
BLOCK
  echo "appended"
fi

echo "== nginx =="
nginx -t
systemctl reload nginx

echo "== verify locally (bypasses DNS) =="
curl -sS --resolve "$DOMAIN:443:127.0.0.1" --max-time 10 \
  -o /dev/null -w "  https /health -> %{http_code}\n" "https://$DOMAIN/health"
curl -sS --resolve "$DOMAIN:443:127.0.0.1" --max-time 10 \
  "https://$DOMAIN/health"; echo
echo "== renewal =="
"$ACME" --list | head -3
echo "done"
