#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
phase_a="${repo_dir}/supabase/migrations/20260910000850_tournament_mutation_jobs_are_disabled_before_retirement.sql"
phase_b="${repo_dir}/supabase/migrations/20260910000905_final_tournament_roster_seat_authority_after_scheduler_fence.sql"
bootstrap="${repo_dir}/scripts/dev/fixtures/tournament-scheduler-fence-pg17-bootstrap.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | rg -q ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

for required in "$phase_a" "$phase_b" "$bootstrap"; do
  if [[ ! -f "$required" ]]; then
    echo "Required probe input is missing: $required" >&2
    exit 1
  fi
done

probe_root="$(mktemp -d "/tmp/ca-tournament-scheduler-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
phase_b_prologue_sql="${probe_root}/phase-b-prologue.sql"
drain_sql="${probe_root}/drain.sql"
unschedule_sql="${probe_root}/unschedule.sql"
invariant_sql="${probe_root}/invariant.sql"
mkdir -p "$socket_dir"
port="$((40432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "/tmp/ca-tournament-scheduler-pg17."* ]]; then
    find "$probe_root" -depth -delete
  fi
}
trap cleanup EXIT

extract_dollar_block() {
  local tag="$1"
  local destination="$2"
  awk -v tag="$tag" '
    $0 == "DO $" tag "$" { capture = 1; starts += 1 }
    capture { print }
    capture && $0 == "$" tag "$;" { finishes += 1; exit }
    END {
      if (starts != 1 || finishes != 1) {
        exit 42
      }
    }
  ' "$phase_b" >"$destination"
}

awk '
  /^BEGIN;$/ { capture = 1 }
  /^DO \$preflight\$$/ { exit }
  capture { print }
' "$phase_b" >"$phase_b_prologue_sql"
if [[ "$(rg -c '^SELECT pg_advisory_xact_lock\(' "$phase_b_prologue_sql")" -ne 3 ]] \
  || [[ "$(rg -c '^SELECT pg_advisory_xact_lock_shared' "$phase_b_prologue_sql")" -ne 1 ]]; then
  echo 'Could not extract the exact Phase B transaction and lock prologue.' >&2
  exit 1
fi

extract_dollar_block \
  'drain_pre_tombstone_tournament_mutator_invocations' "$drain_sql"
extract_dollar_block \
  'unschedule_disabled_tournament_mutator_jobs' "$unschedule_sql"

awk '
  /^-- This verifier is read-only\./ { capture = 1 }
  /^-- Re-emit the complete current conservation sweep/ { exit }
  capture { print }
' "$phase_b" >"$invariant_sql"
trigger_count="$(rg -c '^CREATE CONSTRAINT TRIGGER ' "$invariant_sql" || true)"
if [[ "$trigger_count" -ne 3 ]] \
  || ! rg -q '^\$running_roster_seat_invariant\$;$' "$invariant_sql" \
  || ! rg -q '^\$running_roster_seat_constraint_trigger\$;$' "$invariant_sql"; then
  echo 'Could not extract the exact deferred roster-seat invariant section.' >&2
  exit 1
fi

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-h '' -k '${socket_dir}' -p ${port}" -w start >/dev/null

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose
  -h "$socket_dir" -p "$port" -d postgres
)

expect_sqlstate() {
  local label="$1"
  local expected="$2"
  shift 2
  local output
  local result
  set +e
  output="$("$@" 2>&1)"
  result=$?
  set -e
  if [[ $result -eq 0 ]] || ! rg -q "ERROR:[[:space:]]+${expected}:" <<<"$output"; then
    echo "$label did not fail with SQLSTATE $expected as expected." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  printf '%s\n' "$label: PASS ($expected)"
}

run_drain_transaction() {
  {
    awk '1' "$phase_b_prologue_sql"
    awk '1' "$drain_sql"
    printf '%s\n' 'COMMIT;'
  } | "${psql_cmd[@]}" >/dev/null
}

run_drained_unschedule_transaction() {
  {
    awk '1' "$phase_b_prologue_sql"
    awk '1' "$drain_sql"
    awk '1' "$unschedule_sql"
    printf '%s\n' 'COMMIT;'
  } | "${psql_cmd[@]}" >/dev/null
}

run_zero_roster_with_live_seat() {
  "${psql_cmd[@]}" >/dev/null <<'SQL'
BEGIN;
INSERT INTO public.tournaments(id,status)
VALUES ('00000000-0000-0000-0000-000000000201','RUNNING');
INSERT INTO public.tables(id,tournament_id)
VALUES ('00000000-0000-0000-0000-000000000211',
        '00000000-0000-0000-0000-000000000201');
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips,table_id,seat_number)
VALUES ('00000000-0000-0000-0000-000000000221',
        '00000000-0000-0000-0000-000000000201',
        '00000000-0000-0000-0000-000000000231',
        'playing',0,
        '00000000-0000-0000-0000-000000000211',1);
INSERT INTO public.table_seats(
  id,table_id,user_id,seat_number,stack,left_at)
VALUES ('00000000-0000-0000-0000-000000000241',
        '00000000-0000-0000-0000-000000000211',
        '00000000-0000-0000-0000-000000000231',1,0,NULL);
COMMIT;
SQL
}

run_positive_roster_without_live_seat() {
  "${psql_cmd[@]}" >/dev/null <<'SQL'
BEGIN;
INSERT INTO public.tournaments(id,status)
VALUES ('00000000-0000-0000-0000-000000000301','RUNNING');
INSERT INTO public.tables(id,tournament_id)
VALUES ('00000000-0000-0000-0000-000000000311',
        '00000000-0000-0000-0000-000000000301');
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips,table_id,seat_number)
VALUES ('00000000-0000-0000-0000-000000000321',
        '00000000-0000-0000-0000-000000000301',
        '00000000-0000-0000-0000-000000000331',
        'playing',1500,
        '00000000-0000-0000-0000-000000000311',2);
COMMIT;
SQL
}

run_live_seat_without_positive_roster() {
  "${psql_cmd[@]}" >/dev/null <<'SQL'
BEGIN;
INSERT INTO public.tournaments(id,status)
VALUES ('00000000-0000-0000-0000-000000000401','RUNNING');
INSERT INTO public.tables(id,tournament_id)
VALUES ('00000000-0000-0000-0000-000000000411',
        '00000000-0000-0000-0000-000000000401');
INSERT INTO public.table_seats(
  id,table_id,user_id,seat_number,stack,left_at)
VALUES ('00000000-0000-0000-0000-000000000441',
        '00000000-0000-0000-0000-000000000411',
        '00000000-0000-0000-0000-000000000431',3,1800,NULL);
COMMIT;
SQL
}

"${pg17_bin}/postgres" --version
"${psql_cmd[@]}" -f "$bootstrap" >/dev/null
"${psql_cmd[@]}" -f "$phase_a" >/dev/null

"${psql_cmd[@]}" >/dev/null <<'SQL'
DO $assert_phase_a$
DECLARE
  v_receipt_count integer;
  v_metadata_matches integer;
BEGIN
  SELECT count(*) INTO v_receipt_count
    FROM public.tournament_mutator_scheduler_retirement_receipts;
  IF v_receipt_count<>1 OR EXISTS (
    SELECT 1
      FROM public.tournament_mutator_scheduler_retirement_receipts r
     WHERE cardinality(r.job_ids)<>2
        OR (SELECT count(DISTINCT x.jobid)
              FROM unnest(r.job_ids) AS x(jobid))<>2
        OR jsonb_array_length(r.jobs)<>2) THEN
    RAISE EXCEPTION 'Phase A did not preserve one exact two-job receipt';
  END IF;

  SELECT count(*) INTO v_metadata_matches
    FROM public.tournament_mutator_scheduler_retirement_receipts r
    CROSS JOIN LATERAL jsonb_array_elements(r.jobs) AS m(job)
    JOIN cron.job j ON j.jobid=(m.job->>'jobid')::bigint
   WHERE m.job->>'jobname'=j.jobname
     AND m.job->>'command'=j.command
     AND m.job->>'schedule'=j.schedule
     AND m.job->>'database'=j.database
     AND m.job->>'username'=j.username
     AND m.job->>'nodename'=j.nodename
     AND (m.job->>'nodeport')::integer=j.nodeport
     AND (m.job->>'active')::boolean IS TRUE
     AND j.active IS FALSE;
  IF v_metadata_matches<>2
     OR (SELECT count(*) FROM cron.job)<>2
     OR EXISTS (SELECT 1 FROM cron.job WHERE active) THEN
    RAISE EXCEPTION 'Phase A job metadata or disabled state is incomplete';
  END IF;
END;
$assert_phase_a$;
SQL
echo 'Phase A exact two-job receipt and disabled schedules: PASS'

expect_sqlstate 'absent-player tombstone' 55000 \
  "${psql_cmd[@]}" -c \
  'SELECT public.fn_ca_eliminate_absent_tournament_players()'
expect_sqlstate 'broke-seat tombstone' 55000 \
  "${psql_cmd[@]}" -c \
  'SELECT public.fn_ca_release_broke_seats()'

"${psql_cmd[@]}" >/dev/null <<'SQL'
INSERT INTO cron.job_run_details(
  jobid,job_pid,database,username,command,status,start_time,end_time)
SELECT r.job_ids[1],NULL,current_database(),current_user,
       'SELECT public.fn_ca_eliminate_absent_tournament_players()',
       'succeeded',clock_timestamp(),NULL
  FROM public.tournament_mutator_scheduler_retirement_receipts r
 WHERE r.migration_version='20260910000850';
SQL
expect_sqlstate 'non-running unfinished cron history drain' 55006 \
  run_drain_transaction

"${psql_cmd[@]}" -c 'DELETE FROM cron.job_run_details' >/dev/null
run_drained_unschedule_transaction
"${psql_cmd[@]}" >/dev/null <<'SQL'
DO $assert_unscheduled$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job) THEN
    RAISE EXCEPTION 'the exact Phase B unschedule block left a cron job';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.tournament_mutator_scheduler_retirement_receipts r
     WHERE r.migration_version='20260910000850'
       AND cardinality(r.job_ids)=2
       AND jsonb_array_length(r.jobs)=2) THEN
    RAISE EXCEPTION 'the durable scheduler receipt was not retained';
  END IF;
END;
$assert_unscheduled$;
SQL
echo 'Phase B exact drain and unschedule blocks: PASS'

"${psql_cmd[@]}" -f "$invariant_sql" >/dev/null
"${psql_cmd[@]}" >/dev/null <<'SQL'
DO $assert_deferred_triggers$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_trigger tg
   WHERE (tg.tgrelid,tg.tgname) IN (
     ('public.tournament_players'::regclass,
      'tournament_players_match_live_seat_at_commit'),
     ('public.table_seats'::regclass,
      'tournament_live_seats_match_roster_at_commit'),
     ('public.tournaments'::regclass,
      'running_tournament_roster_seat_match_at_commit'))
     AND tg.tgfoid=
       'public.trg_ca_assert_running_tournament_roster_seat()'::regprocedure
     AND tg.tgconstraint<>0
     AND tg.tgdeferrable
     AND tg.tginitdeferred
     AND NOT tg.tgisinternal
     AND tg.tgenabled='O';
  IF v_count<>3 THEN
    RAISE EXCEPTION 'expected three initially deferred invariant triggers, found %',
      v_count;
  END IF;
END;
$assert_deferred_triggers$;

BEGIN;
INSERT INTO public.tournaments(id,status)
VALUES ('00000000-0000-0000-0000-000000000101','ANNOUNCED');
INSERT INTO public.tables(id,tournament_id)
VALUES ('00000000-0000-0000-0000-000000000111',
        '00000000-0000-0000-0000-000000000101');
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips,table_id,seat_number)
VALUES ('00000000-0000-0000-0000-000000000121',
        '00000000-0000-0000-0000-000000000101',
        '00000000-0000-0000-0000-000000000131',
        'playing',1200,
        '00000000-0000-0000-0000-000000000111',1);
INSERT INTO public.table_seats(
  id,table_id,user_id,seat_number,stack,left_at)
VALUES ('00000000-0000-0000-0000-000000000141',
        '00000000-0000-0000-0000-000000000111',
        '00000000-0000-0000-0000-000000000131',1,1200,NULL);
UPDATE public.tournaments SET status='RUNNING'
 WHERE id='00000000-0000-0000-0000-000000000101';
COMMIT;
SQL
echo 'valid positive roster-seat pair and RUNNING transition: PASS'

expect_sqlstate 'zero roster with live seat at commit' 23514 \
  run_zero_roster_with_live_seat
expect_sqlstate 'positive roster without live seat at commit' 23514 \
  run_positive_roster_without_live_seat
expect_sqlstate 'live seat without positive roster at commit' 23514 \
  run_live_seat_without_positive_roster

"${psql_cmd[@]}" >/dev/null <<'SQL'
INSERT INTO public.tournaments(id,status)
VALUES ('00000000-0000-0000-0000-000000000501','RUNNING');
INSERT INTO public.tables(id,tournament_id)
VALUES ('00000000-0000-0000-0000-000000000511',
        '00000000-0000-0000-0000-000000000501');

BEGIN;
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,status,chips,table_id,seat_number)
VALUES ('00000000-0000-0000-0000-000000000521',
        '00000000-0000-0000-0000-000000000501',
        '00000000-0000-0000-0000-000000000531',
        'playing',2200,
        '00000000-0000-0000-0000-000000000511',4);
INSERT INTO public.table_seats(
  id,table_id,user_id,seat_number,stack,left_at)
VALUES ('00000000-0000-0000-0000-000000000541',
        '00000000-0000-0000-0000-000000000511',
        '00000000-0000-0000-0000-000000000531',4,2200,NULL);
COMMIT;

SELECT public.fn_ca_assert_running_tournament_roster_seat(
  '00000000-0000-0000-0000-000000000501',
  '00000000-0000-0000-0000-000000000531');
SQL
echo 'temporarily inconsistent multi-write becomes exact before commit: PASS'
echo 'TOURNAMENT_SCHEDULER_FENCE_PG17_PASS'
