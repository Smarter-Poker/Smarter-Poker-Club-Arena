#!/usr/bin/env bash
#
# collect-monitoring-health.sh - emits the money, settlement and cron gauges
# that fifteen alert rules were already written against.
#
# On 2026-09-04 three incidents produced fifteen rules across alert-rules.yml
# and slo-rules.yml: settlement failure rate, the money-alert backlog, the
# undeclared-trigger register, and pg_cron/Open Claw liveness. Every one of
# them was written as `metric > threshold`. None of the metrics had a producer.
# An absent metric compared against a threshold yields an empty vector in
# PromQL, which is indistinguishable from healthy: the rules loaded, showed
# green, and could not fire. They stayed that way for seven days while four of
# the conditions they describe were true.
#
# This script is that producer. It runs OUTSIDE the engine container on
# purpose. The engine's own /metrics would be the shorter path, but a collector
# that dies with the process it watches cannot report on it, and every gauge
# here describes database state that matters whether or not the engine is up.
# It also keeps this work off the authoritative event loop, which is single
# threaded and already the scarcest resource on the box.
#
# Output is a node_exporter textfile, the same mechanism verify-recovery-stack.sh
# already uses. Writes are atomic (write to $OUT.$$, then mv).
#
# FAIL CLOSED: on any error this exits non-zero and LEAVES THE OLD FILE ALONE.
# The file's embedded collection timestamp then ages, the *_stale_seconds
# recording rules climb, and CronMetricsBlind / MoneyHealthBlind /
# SettlementMetricsBlind fire. A collector that cannot read the database must
# never publish a zero: a zero here is an all-clear it has not earned.
#
# Credentials are read from the engine's existing environment file. This script
# does not create, rotate, or embed any credential.
#
# Usage:  collect-monitoring-health.sh        # write the textfile, or fail
#         DRY_RUN=1 collect-monitoring-health.sh   # print, write nothing

set -uo pipefail

ENV_FILE="${ENGINE_ENV_FILE:-/opt/club-arena/server/.env}"
TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node-exporter-textfile}"
OUT="${OUT:-$TEXTFILE_DIR/club_arena_money_health.prom}"
TIMEOUT_SEC="${TIMEOUT_SEC:-25}"
SETTLEMENT_WINDOW_MINUTES="${SETTLEMENT_WINDOW_MINUTES:-5}"

die() { printf 'collect-monitoring-health: %s\n' "$1" >&2; exit 1; }

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (set ENGINE_ENV_FILE)"

# Read only the two keys needed, without sourcing the file: the engine env
# carries values with characters that a `source` would execute.
read_key() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" \
    | tail -n 1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" -e 's/[[:space:]]*$//'
}

SUPABASE_URL="$(read_key SUPABASE_URL)"
SERVICE_KEY="$(read_key SUPABASE_SERVICE_ROLE_KEY)"
[ -n "$SUPABASE_URL" ] || die "SUPABASE_URL is not set in $ENV_FILE"
[ -n "$SERVICE_KEY" ] || die "SUPABASE_SERVICE_ROLE_KEY is not set in $ENV_FILE"
SUPABASE_URL="${SUPABASE_URL%/}"

BODY=$(curl -sS --max-time "$TIMEOUT_SEC" \
  -X POST "$SUPABASE_URL/rest/v1/rpc/fn_monitoring_health_snapshot" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d "{\"p_window_minutes\": $SETTLEMENT_WINDOW_MINUTES}" 2>&1) \
  || die "RPC call failed: $BODY"

RENDERED=$(COLLECTED_AT="$(date +%s)" python3 - "$BODY" <<'PY'
import json, os, sys

raw = sys.argv[1]
try:
    payload = json.loads(raw)
except Exception as exc:
    sys.stderr.write(f"response was not JSON: {exc}: {raw[:300]}\n")
    sys.exit(1)

if isinstance(payload, dict) and payload.get("message"):
    sys.stderr.write(f"PostgREST error: {payload.get('message')}\n")
    sys.exit(1)
if isinstance(payload, list):
    if not payload:
        sys.stderr.write("snapshot returned no rows\n")
        sys.exit(1)
    row = payload[0]
elif isinstance(payload, dict):
    row = payload
else:
    sys.stderr.write(f"unexpected snapshot shape: {type(payload).__name__}\n")
    sys.exit(1)

# name -> (column, help, prometheus type)
GAUGES = [
    ("poker_settlement_failure_rate", "settlement_failure_rate",
     "Share of terminal settlements in the window that ended failed (0 to 1)."),
    ("poker_settlement_window_hands", "settlement_window_hands",
     "Settlements that reached final in the window."),
    ("poker_settlement_stuck", "settlement_stuck",
     "Settlements in the window that are neither final nor failed."),
    ("poker_money_undeclared_triggers", "money_undeclared_triggers",
     "Live triggers on money or seat tables with no row in ca_declared_money_triggers."),
    ("poker_financial_alerts_unresolved", "financial_alerts_unresolved",
     "Unresolved rows in financial_alerts."),
    ("poker_financial_alerts_stale_critical", "financial_alerts_stale_critical",
     "Unresolved critical financial alerts older than 24 hours."),
    ("poker_financial_alerts_distinct_conditions", "financial_alerts_distinct_conditions",
     "Distinct sources among unresolved financial alerts."),
    ("poker_cron_pg_runs", "cron_pg_runs",
     "pg_cron job runs started in the last hour."),
    ("poker_cron_pg_failures", "cron_pg_failures",
     "pg_cron job runs in the last hour that did not succeed."),
    ("poker_cron_openclaw_stale", "cron_openclaw_stale",
     "Open Claw jobs past their own staleness threshold."),
    ("poker_cron_openclaw_worst_silence_minutes", "cron_openclaw_worst_silence_minutes",
     "Minutes since the last success of the most silent STALE Open Claw job."),
]

lines = []
missing = []
for metric, column, help_text in GAUGES:
    if column not in row or row[column] is None:
        # failure_rate is NULL when nothing settled at all; that is a real
        # reading, not a gap, and 0 failures out of 0 is a 0 rate.
        if column == "settlement_failure_rate":
            value = 0.0
        else:
            missing.append(column)
            continue
    else:
        value = row[column]
    try:
        value = float(value)
    except (TypeError, ValueError):
        missing.append(column)
        continue
    lines.append(f"# HELP {metric} {help_text}")
    lines.append(f"# TYPE {metric} gauge")
    lines.append(f"{metric} {value:g}")

if missing:
    sys.stderr.write("snapshot is missing column(s): " + ", ".join(missing) + "\n")
    sys.exit(1)

collected = int(os.environ["COLLECTED_AT"])
lines.append("# HELP poker_health_collected_timestamp_seconds Unix time of the last successful money, settlement and cron health collection.")
lines.append("# TYPE poker_health_collected_timestamp_seconds gauge")
lines.append(f"poker_health_collected_timestamp_seconds {collected}")
print("\n".join(lines))
PY
) || die "could not render the snapshot"

if [ -n "${DRY_RUN:-}" ]; then
  printf '%s\n' "$RENDERED"
  exit 0
fi

mkdir -p "$TEXTFILE_DIR" || die "cannot create $TEXTFILE_DIR"
TMP="$OUT.$$"
printf '%s\n' "$RENDERED" > "$TMP" || { rm -f "$TMP"; die "cannot write $TMP"; }
mv -f "$TMP" "$OUT" || { rm -f "$TMP"; die "cannot move $TMP to $OUT"; }
