#!/usr/bin/env bash
# Diagnose why Let's Encrypt resolved the broker hostname elsewhere.
echo "=== resolvers ==="
for resolver in 1.1.1.1 8.8.8.8 223.5.5.5 119.29.29.29; do
  printf '%-14s ' "@$resolver"
  answer=$(dig +short +time=3 +tries=1 A race-ops-broker.mmw-team.icu @"$resolver" 2>/dev/null | tr '\n' ' ')
  echo "${answer:-<no answer>}"
done

echo
echo "=== record types (via 1.1.1.1) ==="
for t in A AAAA CNAME; do
  printf '%-6s ' "$t"
  answer=$(dig +short race-ops-broker.mmw-team.icu "$t" @1.1.1.1 2>/dev/null | tr '\n' ' ')
  echo "${answer:-<none>}"
done

echo
echo "=== apex for comparison ==="
printf 'apex A @1.1.1.1  '; dig +short A mmw-team.icu @1.1.1.1 | tr '\n' ' '; echo

echo
echo "=== what does the hostname actually serve (from this host) ==="
getent hosts race-ops-broker.mmw-team.icu || echo "getent: no result"
curl -sS -o /dev/null -w "GET /health -> %{http_code} (ip %{remote_ip})\n" --max-time 8 http://race-ops-broker.mmw-team.icu/health || true
curl -sS -o /dev/null -w "GET acme probe -> %{http_code} (ip %{remote_ip})\n" --max-time 8 http://race-ops-broker.mmw-team.icu/.well-known/acme-challenge/probe || true

echo
echo "=== acme path locally ==="
echo "probe-ok" | sudo tee /var/www/certbot/probe >/dev/null
curl -sS -o /dev/null -w "direct nginx acme -> %{http_code}\n" --max-time 8 -H 'Host: race-ops-broker.mmw-team.icu' http://127.0.0.1/.well-known/acme-challenge/probe || true
sudo rm -f /var/www/certbot/probe
