#!/usr/bin/env bash
set -euo pipefail

# A degraded engine legitimately answers /health with 503. During the
# maintenance break that response can still carry the complete, durable
# certificate which authorizes a restart. curl --fail used to discard that
# body and made the deploy incapable of installing the fix for the degradation.

URL="${1:-}"
[ -n "$URL" ] || { echo 'restart certificate URL is required' >&2; exit 64; }

BODY_FILE="$(mktemp)"
cleanup() { rm -f -- "$BODY_FILE"; }
trap cleanup EXIT

set +e
HTTP_STATUS="$(
  curl --silent --show-error --max-time 10 \
    --output "$BODY_FILE" \
    --write-out '%{http_code}' \
    "$URL"
)"
CURL_STATUS=$?
set -e

if [ "$CURL_STATUS" -ne 0 ]; then
  echo "restart certificate health request failed (curl exit $CURL_STATUS)" >&2
  exit 69
fi

case "$HTTP_STATUS" in
  200|503) ;;
  *)
    echo "restart certificate health request returned HTTP ${HTTP_STATUS:-unknown}" >&2
    exit 69
    ;;
esac

python3 - "$BODY_FILE" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as source:
        payload = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    print(f"restart certificate health body is not valid JSON: {error}", file=sys.stderr)
    raise SystemExit(65)

if not isinstance(payload, dict):
    print("restart certificate health body is not a JSON object", file=sys.stderr)
    raise SystemExit(65)

maintenance = payload.get("maintenance")
if not isinstance(maintenance, dict):
    print("restart certificate is missing maintenance state", file=sys.stderr)
    raise SystemExit(75)

try:
    remaining_ms = int(maintenance.get("remainingMs") or 0)
except (TypeError, ValueError):
    remaining_ms = 0

ready = (
    payload.get("running") is True
    and maintenance.get("active") is True
    and maintenance.get("phase") == "counting_down"
    and maintenance.get("durableConfirmed") is True
    and maintenance.get("readyForRestart") is True
    and maintenance.get("unparkedTables") == 0
    and remaining_ms >= 180_000
)

if not ready:
    print(
        "incomplete restart certificate: "
        f"running={payload.get('running')} "
        f"active={maintenance.get('active')} "
        f"phase={maintenance.get('phase')} "
        f"durable={maintenance.get('durableConfirmed')} "
        f"remaining={remaining_ms // 1000}s "
        f"unparked={maintenance.get('unparkedTables')} "
        f"ready={maintenance.get('readyForRestart')}",
        file=sys.stderr,
    )
    raise SystemExit(75)

print("READY")
PY
