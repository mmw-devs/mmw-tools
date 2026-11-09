#!/usr/bin/env bash
# Probe the auth core's loopback /health endpoint and restart it after a
# sustained failure. Intended to run from a systemd timer as root.
#
#   mmw-auth-healthcheck [--restart]
#
# Exit codes: 0 healthy or already handled, 1 one failed probe, 2 restart failed.
# The consecutive-failure counter lives in /run so a reboot starts clean.
set -euo pipefail

BASE="${MMW_HEALTH_URL:-http://127.0.0.1:4326}"
THRESHOLD="${MMW_HEALTH_THRESHOLD:-3}"
STATE_DIR="${MMW_HEALTH_STATE_DIR:-/run}"
STATE="$STATE_DIR/mmw-tools-auth-health.failures"
SERVICE="${MMW_HEALTH_SERVICE:-mmw-tools-auth.service}"
RESTART=0

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    *) echo "healthcheck: unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if ! mkdir -p "$STATE_DIR" 2>/dev/null || ! : >>"$STATE" 2>/dev/null; then
  STATE_DIR="${TMPDIR:-/tmp}"
  STATE="$STATE_DIR/mmw-tools-auth-health.failures"
  : >>"$STATE"
fi

failures=0
if [ -f "$STATE" ]; then
  failures=$(cat "$STATE" 2>/dev/null || echo 0)
  case "$failures" in
    ''|*[!0-9]*) failures=0 ;;
  esac
fi

if body=$(curl -fsS --max-time 5 "$BASE/health" 2>/dev/null); then
  if printf '%s' "$body" | node -e '
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      try {
        const h = JSON.parse(s);
        if (h.ok !== true) process.exit(10);
        if (h.contractVersion !== 2) process.exit(11);
      } catch {
        process.exit(12);
      }
    });
  '; then
    if [ "$failures" -ne 0 ]; then
      echo "healthcheck: recovered after $failures failed probe(s)"
    fi
    printf '0\n' >"$STATE"
    exit 0
  fi
  echo "healthcheck: /health answered with an unexpected body: $body" >&2
else
  echo "healthcheck: /health is not reachable at $BASE" >&2
fi

failures=$((failures + 1))
printf '%s\n' "$failures" >"$STATE"

if [ "$RESTART" -eq 1 ] && [ "$failures" -ge "$THRESHOLD" ]; then
  echo "healthcheck: $failures consecutive failures; restarting $SERVICE" >&2
  if systemctl restart "$SERVICE"; then
    printf '0\n' >"$STATE"
    exit 0
  fi
  echo "healthcheck: systemctl restart $SERVICE failed" >&2
  exit 2
fi

exit 1
