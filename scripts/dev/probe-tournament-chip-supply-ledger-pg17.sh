#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration_resolver="$repo_dir/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"
[[ -r "$migration_resolver" ]] || {
  echo 'Staged-or-promoted migration resolver is unreadable.' >&2
  exit 1
}
# shellcheck source=../ops/lib/resolve-staged-or-promoted-migration.sh
# shellcheck disable=SC1091
source "$migration_resolver"
migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  tournament_chip_supply_is_an_immutable_conserved_ledger)"
seal_migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  tournament_chip_supply_rpc_names_are_sealed_until_activation)"
fixture="$repo_dir/scripts/dev/fixtures/tournament-chip-supply-ledger-pg17-bootstrap.sql"
runtime_probe="$repo_dir/scripts/dev/probe-tournament-chip-supply-ledger-pg17.sql"
if [[ ! -f "$seal_migration" ]] || [[ ! -f "$migration" ]] || [[ ! -f "$fixture" ]] \
   || [[ ! -f "$runtime_probe" ]]; then
  echo 'Tournament chip-supply PG17 probe inputs are incomplete.' >&2
  exit 1
fi

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
   || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "/tmp/ca-chip-supply-pg17.XXXXXX")"
probe_root="$(CDPATH='' cd -- "$probe_root" && pwd -P)"
probe_root_name="$(basename "$probe_root")"
cluster_dir="$probe_root/cluster"
socket_dir="$probe_root/socket"
result_log="$probe_root/result.log"
positive_first_log="$probe_root/positive-first.log"
cancel_first_log="$probe_root/cancel-first.log"
rejected_append_log="$probe_root/rejected-append.log"
parent_first_cancel_log="$probe_root/parent-first-cancel.log"
seat_writer_log="$probe_root/seat-writer.log"
race_result_log="$probe_root/race-result.log"
mkdir -p "$socket_dir"
port=5432

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop \
      >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root_name" == ca-chip-supply-pg17.* \
     && -d "$probe_root" && ! -L "$probe_root" ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" -U postgres \
  --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-c listen_addresses='' -k ${socket_dir} -p ${port}" -w start >/dev/null
"${pg17_bin}/createdb" -U postgres -h "$socket_dir" -p "$port" chip_supply

pg_exec() {
  "${pg17_bin}/psql" -X -q -v ON_ERROR_STOP=1 \
    -U postgres -h "$socket_dir" -p "$port" -d chip_supply "$@"
}

pg_exec -f "$fixture" >/dev/null
pg_exec -f "$seal_migration" >/dev/null
pg_exec -f "$migration" >/dev/null
pg_exec -f "$runtime_probe" >"$result_log"
if ! grep -Fq 'TOURNAMENT_CHIP_SUPPLY_LEDGER_PG17_OK' "$result_log"; then
  echo 'Tournament chip-supply runtime probe did not emit its success receipt.' >&2
  cat "$result_log" >&2
  exit 1
fi
if ! grep -Fq 'TOURNAMENT_CHIP_SUPPLY_LEDGER_RACE_SETUP_PG17_OK' "$result_log"; then
  echo 'Tournament chip-supply runtime probe did not prepare the race fixtures.' >&2
  cat "$result_log" >&2
  exit 1
fi

wait_for_backend_marker() {
  local marker="$1"
  local attempt
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if [[ "$(pg_exec -Atc "
      SELECT EXISTS (
        SELECT 1
          FROM pg_stat_activity
         WHERE datname = 'chip_supply'
           AND pid <> pg_backend_pid()
           AND state = 'active'
           AND wait_event_type = 'Timeout'
           AND query LIKE '%${marker}%'
      )
    ")" == 't' ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Timed out waiting for PostgreSQL race marker ${marker}." >&2
  pg_exec -x -c "
    SELECT pid, state, wait_event_type, wait_event, query
      FROM pg_stat_activity
     WHERE datname = 'chip_supply'
  " >&2 || true
  return 1
}

wait_for_backend_lock_marker() {
  local marker="$1"
  local attempt
  for ((attempt = 0; attempt < 100; attempt += 1)); do
    if [[ "$(pg_exec -Atc "
      SELECT EXISTS (
        SELECT 1
          FROM pg_stat_activity
         WHERE datname = 'chip_supply'
           AND pid <> pg_backend_pid()
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND query LIKE '%${marker}%'
      )
    ")" == 't' ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Timed out waiting for PostgreSQL lock marker ${marker}." >&2
  pg_exec -x -c "
    SELECT pid, state, wait_event_type, wait_event, query
      FROM pg_stat_activity
     WHERE datname = 'chip_supply'
  " >&2 || true
  return 1
}

run_positive_first() {
  pg_exec <<'SQL'
BEGIN;
SELECT public.fn_append_tournament_chip_supply_event(
  'a1000000-0000-4000-8000-000000000001',
  (SELECT id FROM public.tournament_players
    WHERE tournament_id='a1000000-0000-4000-8000-000000000001'),
  'a2000000-0000-4000-8000-000000000001',
  (SELECT chip_supply_generation FROM public.tournament_players
    WHERE tournament_id='a1000000-0000-4000-8000-000000000001'),
  'rebuy', 500,
  'race-probe-positive-first-rebuy', 'pg17_race', '{}'::jsonb
);
SELECT pg_sleep(2) /* CHIP_SUPPLY_RACE_POSITIVE_FIRST */;
COMMIT;
SQL
}

run_cancel_first() {
  pg_exec <<'SQL'
BEGIN;
UPDATE public.tournaments SET status='CANCELLED'
 WHERE id='b1000000-0000-4000-8000-000000000001';
SELECT pg_sleep(2) /* CHIP_SUPPLY_RACE_CANCEL_FIRST */;
COMMIT;
SQL
}

run_parent_first_cancel() {
  pg_exec <<'SQL'
BEGIN;
UPDATE public.tournaments SET status='CANCELLED'
 WHERE id='d1000000-0000-4000-8000-000000000001';
SELECT pg_sleep(2) /* CHIP_SUPPLY_PARENT_FIRST_CANCEL */;
COMMIT;
SQL
}

run_seat_writer() {
  pg_exec <<'SQL'
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"d2000000-0000-4000-8000-000000000001"}',
  false
);
SELECT public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(
  'd3000000-0000-4000-8000-000000000001', 1
) /* CHIP_SUPPLY_PARENT_FIRST_SEAT_WRITER */;
SQL
}

# If issuance owns the lock first, cancellation waits and must include that
# committed delta in its exact close rather than snapshotting around it.
run_positive_first >"$positive_first_log" 2>&1 &
positive_first_pid=$!
wait_for_backend_marker 'CHIP_SUPPLY_RACE_POSITIVE_FIRST'
pg_exec -c "
  UPDATE public.tournaments SET status='CANCELLED'
   WHERE id='a1000000-0000-4000-8000-000000000001'
" >/dev/null
if ! wait "$positive_first_pid"; then
  echo 'Positive-first race session failed.' >&2
  cat "$positive_first_log" >&2
  exit 1
fi

# If cancellation owns the lock first, a later positive append waits for the
# terminal commit and is then refused at the immutable table boundary.
run_cancel_first >"$cancel_first_log" 2>&1 &
cancel_first_pid=$!
wait_for_backend_marker 'CHIP_SUPPLY_RACE_CANCEL_FIRST'
if pg_exec -c "
  SELECT public.fn_append_tournament_chip_supply_event(
    'b1000000-0000-4000-8000-000000000001',
    (SELECT id FROM public.tournament_players
      WHERE tournament_id='b1000000-0000-4000-8000-000000000001'),
    'b2000000-0000-4000-8000-000000000001',
    (SELECT chip_supply_generation FROM public.tournament_players
      WHERE tournament_id='b1000000-0000-4000-8000-000000000001'),
    'rebuy', 500,
    'race-probe-cancel-first-rebuy', 'pg17_race', '{}'::jsonb
  )
" >"$rejected_append_log" 2>&1; then
  echo 'Cancel-first race admitted a post-close positive supply event.' >&2
  cat "$rejected_append_log" >&2
  exit 1
fi
if ! grep -Eq \
  'TOURNAMENT_CHIP_SUPPLY_EVENT_AFTER_CLOSE|TOURNAMENT_CHIP_SUPPLY_EVENT_AFTER_CANCEL' \
  "$rejected_append_log"; then
  echo 'Cancel-first race failed without the immutable terminal marker.' >&2
  cat "$rejected_append_log" >&2
  exit 1
fi
if ! wait "$cancel_first_pid"; then
  echo 'Cancel-first race session failed.' >&2
  cat "$cancel_first_log" >&2
  exit 1
fi

# The formerly inverted human seat-first path must wait on the tournament
# before it owns the child table. While cancellation holds the parent, a third
# session can still lock the table NOWAIT; after cancel commits, the seat
# attempt is rejected without ever mutating the player or issuing a stack.
run_parent_first_cancel >"$parent_first_cancel_log" 2>&1 &
parent_first_cancel_pid=$!
wait_for_backend_marker 'CHIP_SUPPLY_PARENT_FIRST_CANCEL'
run_seat_writer >"$seat_writer_log" 2>&1 &
seat_writer_pid=$!
wait_for_backend_lock_marker 'CHIP_SUPPLY_PARENT_FIRST_SEAT_WRITER'
pg_exec <<'SQL' >/dev/null
BEGIN;
SELECT 1 FROM public.tables
 WHERE id='d3000000-0000-4000-8000-000000000001'
 FOR UPDATE NOWAIT;
ROLLBACK;
SQL
if ! wait "$parent_first_cancel_pid"; then
  echo 'Parent-first cancellation race session failed.' >&2
  cat "$parent_first_cancel_log" >&2
  exit 1
fi
if wait "$seat_writer_pid"; then
  echo 'A seat-first writer crossed a committed cancellation.' >&2
  cat "$seat_writer_log" >&2
  exit 1
fi
if ! grep -Eq \
  'TOURNAMENT_CHIP_SUPPLY_EVENT_AFTER_CLOSE|TOURNAMENT_CHIP_SUPPLY_EVENT_AFTER_CANCEL' \
  "$seat_writer_log"; then
  echo 'The blocked seat-first writer failed without a terminal supply marker.' >&2
  cat "$seat_writer_log" >&2
  exit 1
fi

pg_exec -At >"$race_result_log" <<'SQL'
DO $race_assertions$
BEGIN
  IF (SELECT status FROM public.tournaments
       WHERE id='a1000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 'CANCELLED'
     OR COALESCE((
          SELECT sum(amount_delta)::bigint
            FROM public.tournament_chip_supply_events
           WHERE tournament_id='a1000000-0000-4000-8000-000000000001'
        ), 0) <> 0
     OR (SELECT count(*) FROM public.tournament_chip_supply_events
          WHERE tournament_id='a1000000-0000-4000-8000-000000000001'
            AND event_kind='rebuy'
            AND amount_delta=500) IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM public.tournament_chip_supply_events
          WHERE tournament_id='a1000000-0000-4000-8000-000000000001'
            AND event_kind='entry_closed'
            AND amount_delta=-1500) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION
      'positive-first cancellation did not close the committed issuance exactly';
  END IF;

  IF (SELECT status FROM public.tournaments
       WHERE id='b1000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 'CANCELLED'
     OR COALESCE((
          SELECT sum(amount_delta)::bigint
            FROM public.tournament_chip_supply_events
           WHERE tournament_id='b1000000-0000-4000-8000-000000000001'
        ), 0) <> 0
     OR EXISTS (
          SELECT 1 FROM public.tournament_chip_supply_events
           WHERE tournament_id='b1000000-0000-4000-8000-000000000001'
             AND semantic_key='race-probe-cancel-first-rebuy'
        )
     OR (SELECT count(*) FROM public.tournament_chip_supply_events
          WHERE tournament_id='b1000000-0000-4000-8000-000000000001'
            AND event_kind='entry_closed'
            AND amount_delta=-1000) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION
      'cancel-first race admitted or stranded post-close issuance';
  END IF;

  IF (SELECT status FROM public.tournaments
       WHERE id='d1000000-0000-4000-8000-000000000001')
       IS DISTINCT FROM 'CANCELLED'
     OR EXISTS (
          SELECT 1 FROM public.tournament_players
           WHERE tournament_id='d1000000-0000-4000-8000-000000000001'
             AND (status IS DISTINCT FROM 'registered' OR chips <> 0)
        )
     OR EXISTS (
          SELECT 1 FROM public.tournament_chip_supply_events
           WHERE tournament_id='d1000000-0000-4000-8000-000000000001'
             AND event_kind='initial_stack'
        )
     OR COALESCE((
          SELECT sum(amount_delta)::bigint
            FROM public.tournament_chip_supply_events
           WHERE tournament_id='d1000000-0000-4000-8000-000000000001'
        ), 0) <> 0 THEN
    RAISE EXCEPTION
      'parent-first seat writer mutated a child or supply after cancellation';
  END IF;
END;
$race_assertions$;
SELECT 'TOURNAMENT_CHIP_SUPPLY_LEDGER_RACE_PG17_OK';
SQL
if ! grep -Fq 'TOURNAMENT_CHIP_SUPPLY_LEDGER_RACE_PG17_OK' "$race_result_log"; then
  echo 'Tournament chip-supply race probe did not emit its success receipt.' >&2
  cat "$race_result_log" >&2
  exit 1
fi

echo 'TOURNAMENT_CHIP_SUPPLY_LEDGER_PG17_VERIFIED'
