#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  THE BREAK'S WEEKLY SELF-REPORT (to-do #2563 item 16)
#
#  One command that answers "is the hourly restart regime healthy?" from the
#  numbers rather than vibes: how many freezes ran, how long they really
#  froze, what the thaw gave back, and the shape of the hourly dealing dip.
#
#  What to look for, reading it week over week:
#    * freezes.count      - should approach 24/day minus deploy-skipped hours.
#                           A shortfall beyond dropped cron ticks means end()
#                           or the thaw is failing.
#    * avg_frozen_seconds - healthy is ~300. Creeping up means countdowns are
#                           being adopted late or tables are parking slowly.
#    * over_360s          - should be 0. Each one names an hour to read the
#                           engine log for.
#    * dealing_by_minute  - break_55_59 should be ~0 once the freeze is armed
#                           (pre-arming baseline 2026-09-01: 127k hands, i.e.
#                           the fleet dealt straight through). after_00_04
#                           recovering to par with before_48_52 is the real
#                           invisibility metric: a widening gap means
#                           rehydration time is creeping.
#
#  Usage: bash scripts/dev/maintenance-week-report.sh [days]
#  Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in server/.env (the report
#  reads operational internals, so it is service_role only).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DAYS="${1:-7}"
ENV_FILE="$(dirname "$0")/../../server/.env"
[ -f "$ENV_FILE" ] || { echo "server/.env not found - run on a machine with engine credentials"; exit 1; }
SUPABASE_URL=$(grep -m1 '^SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')
KEY=$(grep -m1 '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')
[ -n "$SUPABASE_URL" ] && [ -n "$KEY" ] || { echo "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from server/.env"; exit 1; }

curl -fsS --max-time 20 "$SUPABASE_URL/rest/v1/rpc/fn_maintenance_week_report" \
  -X POST -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d "{\"p_days\": $DAYS}" | python3 -m json.tool
