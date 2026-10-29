#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
parent="${DATA_CONSOLE_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work/member-data-audit-20261018/tmp}"
work="$(mktemp -d "${MEMBER_RECORD_PG_PARENT:-${RUNNER_TEMP:-/Volumes/SmarterWork/agent-work}}/mr18.XXXXXX")"
cleanup() { "$pgbin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/socket"
"$pgbin/initdb" -D "$work/data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h '' -k '$work/socket' -p 57642" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57642 -U fixture_admin -d postgres)
fixture="$repo/tests/fixtures/stats-club-scope/member-record-live"
migration="$repo/supabase/migrations/20261018135655_member_records_follow_funded_hand_clubs_and_live_source_chan.sql"
"${psql[@]}" -f "$fixture/bootstrap.sql" -f "$fixture/readers.sql" -f "$fixture/before.sql" -f "$migration" -f "$repo/supabase/migrations/20261018140249_activate_funded_member_record_daily_facts_without_repeated_r.sql" -f "$fixture/authorization-before.sql" -f "$repo/supabase/migrations/20261018183507_member_record_private_joins_authorize_the_provider_probe.sql" -f "$fixture/authorization-after.sql" -f "$fixture/after.sql"
if "${psql[@]}" -f "$migration" > "$work/replay.log" 2>&1; then echo 'Replay unexpectedly accepted'; exit 1; fi
"${psql[@]}" -f "$fixture/global-before.sql" -f "$repo/supabase/migrations/20261018195412_member_record_all_field_source_events.sql" -f "$fixture/global-after.sql"
"${psql[@]}" -f "$fixture/roster-before.sql" -f "$repo/supabase/migrations/20261018230227_member_roster_funded_counts_and_private_source_events.sql" -f "$fixture/roster-after.sql"
"${psql[@]}" -f "$fixture/mtt-money-before.sql" -f "$repo/supabase/migrations/20261019095423_member_record_mtt_reads_tournament_money.sql" -f "$fixture/mtt-money-after.sql" -f "$repo/supabase/migrations/20261019021553_member_statistics_fees_read_fee_ledger.sql" -f "$fixture/mtt-money-baseline.sql" -f "$repo/supabase/migrations/20261019143456_member_statistics_net_reads_tournament_money.sql" -f "$fixture/mtt-money-stats-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261019143456_member_statistics_net_reads_tournament_money.sql" > "$work/mtt-replay.log" 2>&1; then echo 'Statistics net replay unexpectedly accepted'; exit 1; fi
"${psql[@]}" -f "$fixture/dedup-before.sql"
if "${psql[@]}" -f "$fixture/dedup-after.sql" > "$work/dedup-before-failure.log" 2>&1; then
  echo 'Dedup regression unexpectedly passed before the fix'; exit 1
fi
if ! grep -q 'Member topic transaction dedup failed' "$work/dedup-before-failure.log"; then
  cat "$work/dedup-before-failure.log"; exit 1
fi
"${psql[@]}" -f "$repo/supabase/migrations/20261019151807_member_record_private_signals_deduplicate_per_transaction.sql" -f "$fixture/dedup-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261019151807_member_record_private_signals_deduplicate_per_transaction.sql" > "$work/dedup-replay.log" 2>&1; then
  echo 'Dedup migration replay unexpectedly accepted'; exit 1
fi
if ! grep -q 'Member signal source preimage changed' "$work/dedup-replay.log"; then
  cat "$work/dedup-replay.log"; exit 1
fi
"${psql[@]}" -f "$repo/supabase/migrations/20261019152515_private_record_notifies_the_existing_engine_transport.sql" -f "$fixture/notify-after.sql" > "$work/notify-after.log" 2>&1
cat "$work/notify-after.log"
if [ "$(grep -c 'Asynchronous notification.*ca_private_record_changes' "$work/notify-after.log")" -ne 5 ] || grep -q '72000000-' "$work/notify-after.log"; then echo 'Committed notification coverage or rollback mismatch'; exit 1; fi
if "${psql[@]}" -f "$repo/supabase/migrations/20261019152515_private_record_notifies_the_existing_engine_transport.sql" > "$work/notify-replay.log" 2>&1; then echo 'Notify migration replay unexpectedly accepted'; exit 1; fi
if ! grep -q 'Private record transport preimage changed' "$work/notify-replay.log"; then cat "$work/notify-replay.log"; exit 1; fi
echo 'MEMBER_RECORD_POSTGRES PASS: regression, ranges, attribution, permissions, live signals, replay refusal'

"${psql[@]}" -c 'CREATE DATABASE member_record_concurrency'
"${psql[@]}" -d member_record_concurrency -f "$fixture/bootstrap.sql" -f "$fixture/readers.sql" -f "$fixture/before.sql" -f "$migration"
python3 -B "$fixture/concurrency.py" "$pgbin/psql" "$work/socket" 57642 "$repo/supabase/migrations/20261018140249_activate_funded_member_record_daily_facts_without_repeated_r.sql"

# Existing long SELECT snapshots must not prevent the metadata-only installation.
"${psql[@]}" -c 'CREATE DATABASE member_record_context_locks'
"${psql[@]}" -d member_record_context_locks -f "$fixture/bootstrap.sql" -f "$fixture/readers.sql" -f "$fixture/before.sql" -f "$migration" -f "$repo/supabase/migrations/20261018140249_activate_funded_member_record_daily_facts_without_repeated_r.sql" -f "$fixture/global-before.sql"
python3 -B "$fixture/trigger-locks.py" "$pgbin/psql" "$work/socket" 57642 "$repo/supabase/migrations/20261018195412_member_record_all_field_source_events.sql"

# Today is a Chicago calendar day in both funded member readers.
"${psql[@]}" -f "$fixture/chicago-today-before.sql"
if "${psql[@]}" -f "$fixture/chicago-today-after.sql" > "$work/chicago-before.log" 2>&1; then
  echo 'Chicago Today regression unexpectedly passed before the fix'; exit 1
fi
if ! grep -q 'Chicago Today boundary mismatch' "$work/chicago-before.log"; then
  cat "$work/chicago-before.log"; exit 1
fi
"${psql[@]}" -f "$repo/supabase/migrations/20261023213635_today_win_loss_resets_at_chicago_midnight.sql" -f "$fixture/chicago-today-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261023213635_today_win_loss_resets_at_chicago_midnight.sql" > "$work/chicago-replay.log" 2>&1; then
  echo 'Chicago Today migration replay unexpectedly accepted'; exit 1
fi
echo 'CHICAGO_TODAY_POSTGRES PASS: midnight, DST, funded attribution, accounting cutoff, access, both readers, unchanged longer periods, replay refusal'

# This Week and This Month are Chicago calendar ranges in both funded member readers.
if "${psql[@]}" -f "$fixture/chicago-week-month-after.sql" > "$work/chicago-week-before.log" 2>&1; then
  echo 'Chicago week/month regression unexpectedly passed before the fix'; exit 1
fi
if ! grep -q 'Chicago week/month boundary mismatch' "$work/chicago-week-before.log"; then
  cat "$work/chicago-week-before.log"; exit 1
fi
"${psql[@]}" -f "$repo/supabase/migrations/20261026011138_week_and_month_win_loss_reset_at_chicago_midnight.sql" -f "$fixture/chicago-week-month-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261026011138_week_and_month_win_loss_reset_at_chicago_midnight.sql" > "$work/chicago-week-replay.log" 2>&1; then
  echo 'Chicago week/month migration replay unexpectedly accepted'; exit 1
fi
if ! grep -q 'Chicago week and month reader preimage changed' "$work/chicago-week-replay.log"; then
  cat "$work/chicago-week-replay.log"; exit 1
fi
echo 'CHICAGO_WEEK_MONTH_POSTGRES PASS: Monday and 1st at Chicago midnight, DST, year rollover, accounting cutoff, access, both readers agree, replay refusal'

# The browser event log already specifies seven-day retention. Exercise its
# bounded daily owner on native PostgreSQL; financial tables are not involved.
"${psql[@]}" -f "$fixture/bus-retention-before.sql"
if "${psql[@]}" -f "$fixture/bus-retention-after.sql" > "$work/bus-before.log" 2>&1; then
  echo 'Bus retention unexpectedly passed without its owner'; exit 1
fi
if ! grep -q 'fn_prune_bus_event_log' "$work/bus-before.log"; then cat "$work/bus-before.log"; exit 1; fi
"${psql[@]}" -f "$repo/supabase/migrations/20261027190154_bus_event_logs_obey_their_existing_seven_day_retention.sql" -f "$fixture/bus-retention-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261027190154_bus_event_logs_obey_their_existing_seven_day_retention.sql" > "$work/bus-replay.log" 2>&1; then
  echo 'Bus retention migration replay unexpectedly accepted'; exit 1
fi
if ! grep -q 'already exists' "$work/bus-replay.log"; then cat "$work/bus-replay.log"; exit 1; fi

# Independent fallback: native committed signal, LISTEN, authorized WebSocket.
"$repo/server/node_modules/.bin/tsx" "$repo/server/scripts/privateRecordGatewayPostgres.mts" "$work/socket" 57642
