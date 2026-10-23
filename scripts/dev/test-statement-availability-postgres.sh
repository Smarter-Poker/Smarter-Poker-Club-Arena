#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C
# Fixtures compare UTC report windows, independently of the host timezone.
export PGTZ=UTC

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${UNION_OPS_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}"

[[ -x "$pgbin/initdb" && -x "$pgbin/postgres" ]] || {
  echo 'PostgreSQL 17 tools unavailable; set PG17_BINDIR.' >&2; exit 2;
}
[[ -d "$scratch_parent" ]] || { echo "Statement PostgreSQL scratch parent is unavailable: $scratch_parent" >&2; exit 2; }
"$pgbin/postgres" --version | grep -Eq ' 17\.' || {
  echo 'PostgreSQL 17 is required.' >&2; exit 2;
}

work="$(mktemp -d "$scratch_parent/stmt.XXXXXX")"
data="$work/data"
socket="$work/socket"
port="$((56000 + ($$ % 7000)))"
mkdir -p "$socket"
cleanup() {
  "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  [[ "$work" == "$scratch_parent"/stmt.* ]] && find "$work" -depth -delete
}
trap cleanup EXIT

"$pgbin/initdb" -D "$data" -U postgres --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U postgres -d postgres)
"${psql[@]}" -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'
"${psql[@]}" -f "$repo/tests/fixtures/union-statement-availability/bootstrap.sql" -f "$repo/supabase/migrations/20260907212347_union_statement_reports_identify_missing_accounting_snapshots.sql" -f "$repo/tests/fixtures/union-statement-availability/before.sql" -f "$repo/supabase/migrations/20261018170308_union_statements_distinguish_missing_legacy_payment_details.sql" -f "$repo/tests/fixtures/union-statement-availability/after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261018170308_union_statements_distinguish_missing_legacy_payment_details.sql" >"$work/replay.log" 2>&1; then echo 'Replay was not refused' >&2; exit 1; fi
grep -q 'Statement availability already installed' "$work/replay.log"
"${psql[@]}" -f "$repo/tests/fixtures/union-statement-availability/bomb-bootstrap.sql" -f "$repo/tests/fixtures/union-statement-availability/bomb-readers-before.sql" -f "$repo/tests/fixtures/union-statement-availability/bomb-before.sql" -f "$repo/supabase/migrations/20261018171801_bomb_pot_reports_bound_their_hosted_club_scan_and_utc_calend.sql" -f "$repo/tests/fixtures/union-statement-availability/bomb-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261018171801_bomb_pot_reports_bound_their_hosted_club_scan_and_utc_calend.sql" >"$work/bomb-replay.log" 2>&1; then echo 'Bomb patch replay allowed' >&2; exit 1; fi
grep -q 'Bomb report source changed' "$work/bomb-replay.log"
"${psql[@]}" -f "$repo/tests/fixtures/union-statement-availability/rake-snapshot-before.sql" -f "$repo/supabase/migrations/20261018183243_report_reader_generic_plans_retain_bounded_bitmap_scans.sql" -f "$repo/tests/fixtures/union-statement-availability/reader-settings-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261018183243_report_reader_generic_plans_retain_bounded_bitmap_scans.sql" >"$work/settings-replay.log" 2>&1; then echo 'Reader settings replay allowed' >&2; exit 1; fi
grep -q 'Report reader source or settings changed' "$work/settings-replay.log"
"${psql[@]}" -f "$repo/tests/fixtures/union-statement-availability/bomb-real-rollup-before.sql"
"${psql[@]}" -f "$repo/tests/fixtures/union-statement-availability/bomb-concurrency-fixtures.sql"
# Native-only deterministic overlap: release the first producer only after the
# second is observed waiting on its actual transaction/advisory lock.
producer_race() {
  local club="$1" phase="$2" expected_wait="$3" ready="$work/$2-ready" release="$work/$2-release"
  local first second observed=0 second_ok=0
  PGAPPNAME="bomb-$phase-first" "${psql[@]}" -At >"$work/$phase-first.log" 2>&1 <<SQL &
BEGIN;
SELECT public.fn_ca_bomb_pot_rollup_day('$club',(now() AT TIME ZONE 'UTC')::date-2);
SELECT 'FIRST_SEAL='||md5(to_jsonb(c)::text) FROM ca_club_bomb_pot_complete c WHERE club_id='$club' AND day=(now() AT TIME ZONE 'UTC')::date-2;
\! touch "$ready"
\! while test ! -f "$release"; do sleep 0.025; done
COMMIT;
SQL
  first=$!
  for _ in $(seq 1 200); do [[ -f "$ready" ]] && break; sleep 0.025; done
  if [[ ! -f "$ready" ]]; then touch "$release"; wait "$first" || true; echo 'Real producer readiness failed' >&2; cat "$work/$phase-first.log" >&2; return 1; fi
  PGAPPNAME="bomb-$phase-second" "${psql[@]}" -c "SET DateStyle='German, DMY'; SELECT public.fn_ca_bomb_pot_rollup_day('$club',(now() AT TIME ZONE 'UTC')::date-2);" >"$work/$phase-second.log" 2>&1 &
  second=$!
  for _ in $(seq 1 200); do
    if [[ "$("${psql[@]}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE application_name='bomb-$phase-second' AND wait_event='$expected_wait';")" == 1 ]]; then observed=1; break; fi
    sleep 0.025
  done
  touch "$release"
  wait "$first"
  if wait "$second"; then second_ok=1; fi
  [[ "$observed" == 1 ]] || { echo "Expected producer lock not observed: $phase" >&2; return 1; }
  local first_seal final_seal
  first_seal="$(sed -n 's/^FIRST_SEAL=//p' "$work/$phase-first.log")"
  final_seal="$("${psql[@]}" -Atc "SELECT md5(to_jsonb(c)::text) FROM ca_club_bomb_pot_complete c WHERE club_id='$club' AND day=(now() AT TIME ZONE 'UTC')::date-2;")"
  echo "Producer seal $phase: first=$first_seal final=$final_seal"
  [[ -n "$first_seal" && -n "$final_seal" ]] || { echo 'Producer seal receipt missing' >&2; return 1; }
  if [[ "$phase" == before ]]; then
    if [[ "$second_ok" == 1 ]]; then
      [[ "$first_seal" != "$final_seal" ]] || { echo 'Old producer did not reproduce a sealed-state rewrite' >&2; return 1; }
      echo 'Old producer rewrote an already sealed day under observed transaction overlap.'
    else
      grep -q 'duplicate key value violates unique constraint' "$work/$phase-second.log"
    fi
  else
    [[ "$second_ok" == 1 ]] || { cat "$work/$phase-second.log" >&2; return 1; }
    [[ "$first_seal" == "$final_seal" ]] || { echo 'Concurrent duplicate rewrote the original seal' >&2; return 1; }
    [[ "$("${psql[@]}" -Atc "SELECT count(*)::text||':'||coalesce(sum(hands)::text,'missing')||':'||(SELECT hands_read::text FROM ca_club_bomb_pot_complete WHERE club_id='$club' AND day=(now() AT TIME ZONE 'UTC')::date-2) FROM ca_club_bomb_pot_daily WHERE club_id='$club';")" == '1:1:1' ]] || { echo 'Concurrent producer duplicated or lost source' >&2; return 1; }
  fi
  echo "Real producer concurrency $phase passed ($expected_wait observed)."
}
producer_race '00000000-0000-4000-8000-000000000007' before transactionid
if "${psql[@]}" -f "$repo/tests/fixtures/union-statement-availability/bomb-plan-cache-after.sql" >"$work/cache-before.log" 2>&1; then echo 'Old custom plan unexpectedly qualified' >&2; exit 1; fi
grep -q 'Bomb catchup qualified generic plan or source changed' "$work/cache-before.log"
"${psql[@]}" -f "$repo/supabase/migrations/20261018195533_bomb_catchup_retains_its_qualified_generic_bitmap_plan.sql" -f "$repo/tests/fixtures/union-statement-availability/bomb-plan-cache-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261018195533_bomb_catchup_retains_its_qualified_generic_bitmap_plan.sql" >"$work/cache-replay.log" 2>&1; then echo 'Bomb plan cache replay allowed' >&2; exit 1; fi
grep -q 'Bomb catchup qualified preimage changed' "$work/cache-replay.log"
producer_race '00000000-0000-4000-8000-000000000008' after advisory
echo 'Statement availability PostgreSQL17 fail-before/pass-after, source preservation, authorization and replay refusal passed.'
