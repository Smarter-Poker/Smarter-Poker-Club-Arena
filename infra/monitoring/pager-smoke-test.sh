#!/usr/bin/env bash
# Fire one synthetic page=sms alert through the REAL path - Alertmanager ->
# World Hub /api/internal/alertmanager-page -> Twilio -> phone - and resolve it
# two minutes later so a RESOLVED text follows. Two texts, then silence.
#
# Run ON engine-01 (Alertmanager listens on 127.0.0.1:9093 only):
#     bash /opt/smarter-poker-monitoring/pager-smoke-test.sh
#
# Precondition: https://smarter.poker/api/internal/alertmanager-page answers
# 405 to a GET (deployed). While it answers 404 the page cannot land and
# Alertmanager will retry for a few minutes, then give up.
set -euo pipefail
AM="${AM_URL:-http://127.0.0.1:9093}"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://smarter.poker/api/internal/alertmanager-page || true)
if [[ "$code" != "405" ]]; then
  echo "refusing: the pager route answers $code, not 405 - it is not deployed yet" >&2; exit 1
fi
now=$(date -u +%Y-%m-%dT%H:%M:%SZ); end=$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+2M +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST "$AM/api/v2/alerts" -H 'Content-Type: application/json' -d "[{
  \"labels\": {\"alertname\":\"PagerSmokeTest\",\"severity\":\"critical\",\"page\":\"sms\",\"component\":\"test\"},
  \"annotations\": {\"summary\":\"synthetic page fired at $now - if you are reading this on your phone, the 3am pager works\"},
  \"startsAt\": \"$now\", \"endsAt\": \"$end\"
}]" && echo && echo "fired PagerSmokeTest; expect [PAGE] within ~15s and [RESOLVED] ~2 min later"
sleep 20
echo "--- alertmanager notify log ---"; docker logs sp-alertmanager --since 1m 2>&1 | grep -iE "pager-sms|alertmanager-page|notify" | tail -5 || true
