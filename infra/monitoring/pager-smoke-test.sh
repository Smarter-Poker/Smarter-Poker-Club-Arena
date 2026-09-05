#!/usr/bin/env bash
# Fire one synthetic page=sms alert through the REAL path - Alertmanager ->
# World Hub /api/internal/alertmanager-page -> Twilio -> phone - and let it
# resolve so a RESOLVED text follows. Two texts, then silence.
#
# THE ALERT LIVES 7 MINUTES, NOT 2. The pager receiver has group_interval: 5m,
# so Alertmanager will not look at this group again for five minutes. The first
# version of this script used endsAt +2m: the [PAGE] text sent immediately and
# correctly, then the alert EXPIRED out of the pipeline before the next tick,
# so no RESOLVED notification was ever generated and the second half of the
# test silently proved nothing. Measured 2026-09-05 - webhook counter went 1 ->
# 2 for the page and stayed at 2. endsAt must outlive group_interval.
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
now=$(date -u +%Y-%m-%dT%H:%M:%SZ); end=$(date -u -d '+7 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+7M +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST "$AM/api/v2/alerts" -H 'Content-Type: application/json' -d "[{
  \"labels\": {\"alertname\":\"PagerSmokeTest\",\"severity\":\"critical\",\"page\":\"sms\",\"component\":\"test\"},
  \"annotations\": {\"summary\":\"synthetic page fired at $now - if you are reading this on your phone, the 3am pager works\"},
  \"startsAt\": \"$now\", \"endsAt\": \"$end\"
}]" && echo && echo "fired PagerSmokeTest; expect [PAGE] within ~15s and [RESOLVED] ~7-12 min later (group_interval 5m + expiry)"
sleep 20
echo "--- alertmanager notify log (errors only; silence here is not proof) ---"
docker logs sp-alertmanager --since 2m 2>&1 | grep -iE "pager-sms|alertmanager-page|notify" | tail -5 || true
echo
echo "--- POSITIVE evidence: the webhook counters must both move ---"
curl -s http://127.0.0.1:9093/metrics \
  | grep -E 'alertmanager_notifications(_failed)?_total\{integration="webhook"' \
  | grep -vE 'reason="(contextCanceled|contextDeadlineExceeded|other|serverError)"'
echo
echo "An empty log is NOT success - Alertmanager only logs failures. Confirm"
echo "alertmanager_notifications_total{webhook} incremented, and read the World"
echo "Hub log line '[alertmanager-page] paged' which only runs after Twilio"
echo "accepts. Re-run in ~10 min to see the counter move a second time for the"
echo "RESOLVED text."
