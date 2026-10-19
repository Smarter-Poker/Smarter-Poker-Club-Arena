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
"${psql[@]}" -f "$fixture/mtt-money-before.sql" -f "$repo/supabase/migrations/20261019095423_member_record_mtt_reads_tournament_money.sql" -f "$fixture/mtt-money-after.sql"
echo 'MEMBER_RECORD_POSTGRES PASS: regression, ranges, attribution, permissions, live signals, replay refusal'

"${psql[@]}" -c 'CREATE DATABASE member_record_concurrency'
"${psql[@]}" -d member_record_concurrency -f "$fixture/bootstrap.sql" -f "$fixture/readers.sql" -f "$fixture/before.sql" -f "$migration"
python3 -B "$fixture/concurrency.py" "$pgbin/psql" "$work/socket" 57642 "$repo/supabase/migrations/20261018140249_activate_funded_member_record_daily_facts_without_repeated_r.sql"

# Existing long SELECT snapshots must not prevent the metadata-only installation.
"${psql[@]}" -c 'CREATE DATABASE member_record_context_locks'
"${psql[@]}" -d member_record_context_locks -f "$fixture/bootstrap.sql" -f "$fixture/readers.sql" -f "$fixture/before.sql" -f "$migration" -f "$repo/supabase/migrations/20261018140249_activate_funded_member_record_daily_facts_without_repeated_r.sql" -f "$fixture/global-before.sql"
python3 -B "$fixture/trigger-locks.py" "$pgbin/psql" "$work/socket" 57642 "$repo/supabase/migrations/20261018195412_member_record_all_field_source_events.sql"
