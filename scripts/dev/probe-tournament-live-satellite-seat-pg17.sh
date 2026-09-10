#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
  || ! "${pg17_bin}/postgres" --version | rg -q ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

reseat_bootstrap="${repo_dir}/scripts/dev/fixtures/tournament-reseating-pg17-bootstrap.sql"
satellite_bootstrap="${repo_dir}/scripts/dev/fixtures/tournament-live-satellite-seat-pg17-bootstrap.sql"
reseat_migration="${repo_dir}/supabase/migrations/20260909222020_tournament_reseating_uses_one_database_chosen_legal_chair.sql"
final_migration="${repo_dir}/supabase/migrations/20260910000905_final_tournament_roster_seat_authority_after_scheduler_fence.sql"
for required in \
  "$reseat_bootstrap" "$satellite_bootstrap" \
  "$reseat_migration" "$final_migration"; do
  if [[ ! -f "$required" ]]; then
    echo "Required probe input is missing: $required" >&2
    exit 1
  fi
done

probe_root="$(mktemp -d "/tmp/ca-live-satellite-seat-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
wrapper_sql="${probe_root}/wrapper.sql"
invariant_sql="${probe_root}/invariant.sql"
mkdir -p "$socket_dir"
port="$((45432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "/tmp/ca-live-satellite-seat-pg17."* ]]; then
    find "$probe_root" -depth -delete
  fi
}
trap cleanup EXIT

awk '
  /^CREATE OR REPLACE FUNCTION public\.fn_settle_satellite_tournament\(/ {
    capture=1; starts+=1
  }
  capture { print }
  capture && /^\$satellite_with_final_seat_authority\$;$/ {
    finishes+=1; exit
  }
  END { if (starts!=1 || finishes!=1) exit 42 }
' "$final_migration" >"$wrapper_sql"

awk '
  /^-- This verifier is read-only\./ { capture=1 }
  /^-- Re-emit the complete current conservation sweep/ { exit }
  capture { print }
' "$final_migration" >"$invariant_sql"
if [[ "$(rg -c '^CREATE CONSTRAINT TRIGGER ' "$invariant_sql" || true)" -ne 3 ]]; then
  echo 'Could not extract the exact reciprocal roster-seat invariant.' >&2
  exit 1
fi

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-h '' -k '${socket_dir}' -p ${port}" -w start >/dev/null
psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose
  -h "$socket_dir" -p "$port" -d postgres
)

"${psql_cmd[@]}" -f "$reseat_bootstrap" >/dev/null
"${psql_cmd[@]}" -f "$reseat_migration" >/dev/null
"${psql_cmd[@]}" -f "$satellite_bootstrap" >/dev/null
"${psql_cmd[@]}" -f "$wrapper_sql" >/dev/null
"${psql_cmd[@]}" -f "$invariant_sql" >/dev/null

"${psql_cmd[@]}" >/dev/null <<'SQL'
BEGIN;
SET LOCAL test.engine='true';
INSERT INTO public.tournaments(
  id,status,variant,tournament_type,game_type,max_players,table_size,
  starting_chips,satellite_target_id)
VALUES
  ('00000000-0000-0000-0000-000000001001','COMPLETING','satellite',
   'SATELLITE','nlh',9,9,1500,'00000000-0000-0000-0000-000000001002'),
  ('00000000-0000-0000-0000-000000001002','RUNNING','mtt',
   'MTT','nlh',9,9,1500,NULL);
INSERT INTO public.tables(
  id,tournament_id,status,max_players,current_players,is_deleted)
VALUES(
  '00000000-0000-0000-0000-000000001003',
  '00000000-0000-0000-0000-000000001002','running',9,0,false);
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips)
VALUES(
  '00000000-0000-0000-0000-000000001004',
  '00000000-0000-0000-0000-000000001001',
  '00000000-0000-0000-0000-000000001005','eliminated',0);
SELECT public.fn_settle_satellite_tournament(
  '00000000-0000-0000-0000-000000001001',
  '00000000-0000-0000-0000-000000001005');
COMMIT;

DO $assert_live_award$
BEGIN
  IF (SELECT count(*) FROM public.tournament_satellite_settlements
       WHERE tournament_id='00000000-0000-0000-0000-000000001001')<>1
     OR (SELECT count(*) FROM public.tournament_satellite_awards
          WHERE tournament_id='00000000-0000-0000-0000-000000001001'
            AND delivery_kind='seat')<>1
     OR (SELECT count(*) FROM public.tournament_players tp
          JOIN public.table_seats seat
            ON seat.table_id=tp.table_id AND seat.seat_number=tp.seat_number
           AND seat.user_id=tp.user_id AND seat.left_at IS NULL
         WHERE tp.tournament_id='00000000-0000-0000-0000-000000001002'
           AND tp.user_id='00000000-0000-0000-0000-000000001005'
           AND tp.status='playing' AND tp.chips=1500
           AND tp.is_satellite_qualifier
           AND tp.source_satellite_id=
                 '00000000-0000-0000-0000-000000001001'
           AND seat.stack=tp.chips)<>1 THEN
    RAISE EXCEPTION 'RUNNING target award did not commit one exact chair';
  END IF;
  PERFORM public.fn_ca_assert_running_tournament_roster_seat(
    '00000000-0000-0000-0000-000000001002',
    '00000000-0000-0000-0000-000000001005');
END;
$assert_live_award$;

BEGIN;
UPDATE public.table_seats seat
   SET left_at=clock_timestamp()
  FROM public.tables table_row
 WHERE table_row.id=seat.table_id
   AND table_row.tournament_id='00000000-0000-0000-0000-000000001002'
   AND seat.user_id='00000000-0000-0000-0000-000000001005'
   AND seat.left_at IS NULL;
UPDATE public.tournament_players
   SET status='eliminated',chips=0,table_id=NULL,seat_number=NULL
 WHERE tournament_id='00000000-0000-0000-0000-000000001002'
   AND user_id='00000000-0000-0000-0000-000000001005';
COMMIT;

BEGIN;
SET LOCAL test.engine='true';
SELECT public.fn_settle_satellite_tournament(
  '00000000-0000-0000-0000-000000001001',
  '00000000-0000-0000-0000-000000001005');
COMMIT;

DO $assert_later_lifecycle_replay$
BEGIN
  IF (SELECT count(*) FROM public.tournament_players
       WHERE tournament_id='00000000-0000-0000-0000-000000001002'
         AND user_id='00000000-0000-0000-0000-000000001005'
         AND status='eliminated' AND chips=0
         AND table_id IS NULL AND seat_number IS NULL)<>1
     OR (SELECT count(*) FROM public.table_seats seat
          JOIN public.tables table_row ON table_row.id=seat.table_id
         WHERE table_row.tournament_id=
                 '00000000-0000-0000-0000-000000001002'
           AND seat.user_id='00000000-0000-0000-0000-000000001005'
           AND seat.left_at IS NOT NULL)<>1
     OR EXISTS (
       SELECT 1 FROM public.table_seats seat
       JOIN public.tables table_row ON table_row.id=seat.table_id
         AND table_row.tournament_id=
               '00000000-0000-0000-0000-000000001002'
      WHERE seat.user_id='00000000-0000-0000-0000-000000001005'
        AND seat.left_at IS NULL) THEN
    RAISE EXCEPTION 'later-lifecycle replay reseated or rewrote the qualifier';
  END IF;
END;
$assert_later_lifecycle_replay$;

BEGIN;
SET LOCAL test.engine='true';
INSERT INTO public.tournaments(
  id,status,variant,tournament_type,game_type,max_players,table_size,
  starting_chips,satellite_target_id)
VALUES
  ('00000000-0000-0000-0000-000000001101','COMPLETING','satellite',
   'SATELLITE','nlh',9,9,1800,'00000000-0000-0000-0000-000000001102'),
  ('00000000-0000-0000-0000-000000001102','REGISTERING','mtt',
   'MTT','nlh',9,9,1800,NULL);
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips)
VALUES(
  '00000000-0000-0000-0000-000000001104',
  '00000000-0000-0000-0000-000000001101',
  '00000000-0000-0000-0000-000000001105','eliminated',0);
SELECT public.fn_settle_satellite_tournament(
  '00000000-0000-0000-0000-000000001101',
  '00000000-0000-0000-0000-000000001105');
COMMIT;

DO $assert_registering_award$
BEGIN
  IF (SELECT count(*) FROM public.tournament_players
       WHERE tournament_id='00000000-0000-0000-0000-000000001102'
         AND user_id='00000000-0000-0000-0000-000000001105'
         AND status='registered' AND chips=0
         AND table_id IS NULL AND seat_number IS NULL)<>1 THEN
    RAISE EXCEPTION 'REGISTERING target award changed launch ownership';
  END IF;
END;
$assert_registering_award$;
SQL

set +e
failure_output="$("${psql_cmd[@]}" 2>&1 <<'SQL'
SET test.engine='true';
INSERT INTO public.tournaments(
  id,status,variant,tournament_type,game_type,max_players,table_size,
  starting_chips,satellite_target_id)
VALUES
  ('00000000-0000-0000-0000-000000001201','COMPLETING','satellite',
   'SATELLITE','nlh',9,9,2100,'00000000-0000-0000-0000-000000001202'),
  ('00000000-0000-0000-0000-000000001202','RUNNING','mtt',
   'MTT','nlh',9,9,2100,NULL);
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips)
VALUES(
  '00000000-0000-0000-0000-000000001204',
  '00000000-0000-0000-0000-000000001201',
  '00000000-0000-0000-0000-000000001205','eliminated',0);
SELECT public.fn_settle_satellite_tournament(
  '00000000-0000-0000-0000-000000001201',
  '00000000-0000-0000-0000-000000001205');
SQL
)"
failure_status=$?
set -e
if [[ $failure_status -eq 0 ]] || ! rg -q 'ERROR:[[:space:]]+55000:' <<<"$failure_output"; then
  echo 'No-chair settlement did not fail atomically with SQLSTATE 55000.' >&2
  printf '%s\n' "$failure_output" >&2
  exit 1
fi

"${psql_cmd[@]}" >/dev/null <<'SQL'
DO $assert_failed_settlement_rolled_back$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournament_satellite_settlements
              WHERE tournament_id=
                    '00000000-0000-0000-0000-000000001201')
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_awards
                 WHERE tournament_id=
                       '00000000-0000-0000-0000-000000001201')
     OR EXISTS (SELECT 1 FROM public.tournament_players
                 WHERE tournament_id=
                       '00000000-0000-0000-0000-000000001202')
     OR (SELECT status FROM public.tournaments
          WHERE id='00000000-0000-0000-0000-000000001201')<>'COMPLETING' THEN
    RAISE EXCEPTION 'failed RUNNING-target settlement left partial state';
  END IF;
END;
$assert_failed_settlement_rolled_back$;
SQL

printf '%s\n' 'POSTGRESQL_17_LIVE_SATELLITE_SEAT_TRANSACTION_PASS'
