#!/usr/bin/env bash
# Query the authoritative nameserver directly, with and without ECS.
NS=bancroft.dnspod.net
DOMAIN=race-ops-broker.mmw-team.icu

echo "=== authoritative, no ECS ==="
dig +short +time=4 +tries=1 A "$DOMAIN" @"$NS"

echo "=== authoritative, ECS 中国电信 ==="
dig +short +time=4 +tries=1 A "$DOMAIN" @"$NS" +subnet=1.2.4.0/24

echo "=== authoritative, ECS 美国 ==="
dig +short +time=4 +tries=1 A "$DOMAIN" @"$NS" +subnet=45.33.32.0/24

echo "=== authoritative, ECS 欧洲 ==="
dig +short +time=4 +tries=1 A "$DOMAIN" @"$NS" +subnet=85.10.200.0/24

echo "=== apex for comparison (no ECS) ==="
dig +short +time=4 +tries=1 A mmw-team.icu @"$NS"

echo "=== wildcard check (no ECS) ==="
dig +short +time=4 +tries=1 A no-such-host-xyz.mmw-team.icu @"$NS"

echo "=== SOA (negative TTL) ==="
dig +time=4 +tries=1 SOA mmw-team.icu @"$NS" +short
