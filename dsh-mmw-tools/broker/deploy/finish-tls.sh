#!/usr/bin/env bash
# Issue the certificate and add the 443 block.
# Idempotent: safe to re-run.
set -euo pipefail

DOMAIN=race-ops-broker.mmw-team.icu
LIVE=/etc/letsencrypt/live/$DOMAIN
SITE=/etc/nginx/sites-available/race-ops-broker
WEBROOT=/var/www/certbot

echo "== cert =="
if [[ -f "$LIVE/fullchain.pem" ]]; then
  echo "certificate already present"
else
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --keep-until-expiring
fi
test -f "$LIVE/fullchain.pem"
openssl x509 -in "$LIVE/fullchain.pem" -noout -subject -dates -ext subjectAltName | sed 's/^/  /'

echo "== 443 block =="
if grep -q "listen 443" "$SITE"; then
  echo "443 block already present"
else
  cat >>"$SITE" <<'BLOCK'

server {
    listen 443 ssl http2;
    server_name race-ops-broker.mmw-team.icu;
    server_tokens off;

    ssl_certificate     /etc/letsencrypt/live/race-ops-broker.mmw-team.icu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/race-ops-broker.mmw-team.icu/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 16k;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 20s;
    }
}
BLOCK
  echo "appended"
fi

echo "== nginx =="
nginx -t
systemctl reload nginx

echo "== renewal timer =="
systemctl list-timers certbot.timer --no-pager 2>/dev/null || echo "certbot.timer not present"
curl -sS -o /dev/null -w "public /health -> %{http_code}\n" --max-time 10 https://$DOMAIN/health
echo "done"
