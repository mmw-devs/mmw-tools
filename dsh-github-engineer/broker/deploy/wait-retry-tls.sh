#!/usr/bin/env bash
# The authoritative NS answers uniformly with our IP, so LE's failure is a
# stale cached answer (TTL 600s). Wait it out, then retry.
set -uo pipefail

echo "== what is 43.174.224.202 =="
curl -sS -o /dev/null -w "  GET / -> %{http_code} (server: %{content_type})\n" --max-time 8 \
  -H 'Host: race-ops-broker.mmw-team.icu' http://43.174.224.202/ 2>/dev/null || echo "  unreachable"
curl -sS -o /dev/null -w "  acme path -> %{http_code}\n" --max-time 8 \
  -H 'Host: race-ops-broker.mmw-team.icu' http://43.174.224.202/.well-known/acme-challenge/probe 2>/dev/null || true

echo "== waiting 200s for resolver caches (TTL 600, SOA min 180) =="
sleep 200

echo "== still correct at the authority? =="
dig +short +time=4 A race-ops-broker.mmw-team.icu @bancroft.dnspod.net

echo "== retry =="
bash /tmp/finish-tls.sh
