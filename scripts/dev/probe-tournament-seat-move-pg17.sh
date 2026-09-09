#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration_matches=(
  "${repo_dir}"/supabase/migrations/*_tournament_seat_moves_are_one_atomic_receipt.sql
)
if [[ ${#migration_matches[@]} -ne 1 || ! -f "${migration_matches[0]}" ]]; then
  echo 'Expected exactly one tournament-seat-move migration by stable suffix.' >&2
  exit 2
fi
migration="${migration_matches[0]}"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
   || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-tournament-move-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
mkdir -p "$socket_dir"
port="$((47432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-tournament-move-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" -U postgres --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" -o "-k ${socket_dir} -p ${port}" -w start >/dev/null

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -U postgres -h "$socket_dir" -p "$port" -d postgres
)

# A same-named but structurally wrong partial index must abort the migration.
# IF NOT EXISTS alone would otherwise turn this into a silent false guarantee.
"${pg17_bin}/createdb" -U postgres -h "$socket_dir" -p "$port" wrong_index
wrong_index_psql=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -U postgres -h "$socket_dir" -p "$port" -d wrong_index
)
"${wrong_index_psql[@]}" -f \
  "$repo_dir/scripts/dev/fixtures/tournament-seat-move-pg17-bootstrap.sql" >/dev/null
"${wrong_index_psql[@]}" -c "
  CREATE UNIQUE INDEX idx_tournament_players_one_active_destination_pointer
    ON public.tournament_players (tournament_id, user_id, seat_number)
   WHERE status IN ('registered', 'playing')
     AND table_id IS NOT NULL
     AND seat_number IS NOT NULL;
" >/dev/null
if "${wrong_index_psql[@]}" -f "$migration" \
  >"${probe_root}/wrong-index.log" 2>&1; then
  echo 'Atomic move migration accepted a wrong same-named pointer index.' >&2
  exit 1
fi
if ! grep -q 'Atomic tournament move uniqueness guards are missing' \
  "${probe_root}/wrong-index.log"; then
  cat "${probe_root}/wrong-index.log" >&2
  echo 'Wrong-index rehearsal failed outside the exact invariant.' >&2
  exit 1
fi
"${pg17_bin}/dropdb" -U postgres -h "$socket_dir" -p "$port" wrong_index

"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/fixtures/tournament-seat-move-pg17-bootstrap.sql" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-tournament-seat-move-pg17.sql" >/dev/null

authority_sql="
select set_config('app.smarter_data_actor','tournament-manager',false);
select set_config('app.smarter_tournament_id','10000000-0000-4000-8000-000000000001',false);
select set_config('app.smarter_tournament_lease_generation','90000000-0000-4000-8000-000000000001',false);
select set_config('app.smarter_manager_request_fenced','protocol-2',false);
"

# The same advisory key as hand settlement owns the source. The move must
# return busy immediately and leave its exact generation untouched.
"${psql_cmd[@]}" -c "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('atomic-table:20000000-0000-4000-8000-000000000001',0)); SELECT pg_sleep(2); COMMIT;" \
  >"${probe_root}/hand-lock-owner.log" 2>&1 &
hand_lock_pid=$!
sleep 0.2
hand_busy="$(${psql_cmd[@]} -Atc "${authority_sql}
select fn_move_tournament_player_atomic(
 '60000000-0000-4000-8000-000000000008',
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000008',
 '20000000-0000-4000-8000-000000000001',8,
 '50000000-0000-4000-8000-000000000008','2026-09-08T10:00:08Z',110,
 '20000000-0000-4000-8000-000000000002',8)->>'reason';")"
wait "$hand_lock_pid"
if [[ "$(printf '%s\n' "$hand_busy" | tail -n 1)" != 'table_hand_boundary_busy' ]]; then
  echo "Hand advisory boundary was not respected: ${hand_busy}" >&2
  exit 1
fi

# A concurrent destination writer owns the physical chair. The move's NOWAIT
# seat lock must refuse without ever closing its source.
"${psql_cmd[@]}" -c "BEGIN;
UPDATE public.table_seats SET user_id='40000000-0000-4000-8000-000000000098', stack=1, left_at=NULL
 WHERE table_id='20000000-0000-4000-8000-000000000002' AND seat_number=6;
SELECT pg_sleep(2); ROLLBACK;" >"${probe_root}/destination-owner.log" 2>&1 &
destination_pid=$!
sleep 0.2
destination_busy="$(${psql_cmd[@]} -Atc "${authority_sql}
select fn_move_tournament_player_atomic(
 '60000000-0000-4000-8000-000000000009',
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000009',
 '20000000-0000-4000-8000-000000000001',9,
 '50000000-0000-4000-8000-000000000009','2026-09-08T10:00:09Z',120,
 '20000000-0000-4000-8000-000000000002',6)->>'reason';")"
wait "$destination_pid"
if [[ "$(printf '%s\n' "$destination_busy" | tail -n 1)" != 'seat_busy' ]]; then
  echo "Concurrent destination race was not refused: ${destination_busy}" >&2
  exit 1
fi

# Two simultaneous identical invocations serialize on the operation id. The
# first commits once; the second returns the immutable replay after commit.
concurrent_sql="${authority_sql}
select fn_move_tournament_player_atomic(
 '60000000-0000-4000-8000-000000000010',
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000008',
 '20000000-0000-4000-8000-000000000001',8,
 '50000000-0000-4000-8000-000000000008','2026-09-08T10:00:08Z',110,
 '20000000-0000-4000-8000-000000000002',8);"
"${psql_cmd[@]}" -Atc "BEGIN; ${concurrent_sql} SELECT pg_sleep(2); COMMIT;" \
  >"${probe_root}/concurrent-first.log" 2>&1 &
first_pid=$!
sleep 0.2
"${psql_cmd[@]}" -Atc "$concurrent_sql" >"${probe_root}/concurrent-replay.log"
wait "$first_pid"
if ! grep -Eq '"replayed"[[:space:]]*:[[:space:]]*true' \
  "${probe_root}/concurrent-replay.log"; then
  cat "${probe_root}/concurrent-replay.log" >&2
  echo 'Concurrent identical operation did not return the durable replay.' >&2
  exit 1
fi
if [[ "$("${psql_cmd[@]}" -Atc "select count(*) from public.tournament_seat_move_receipts where operation_id='60000000-0000-4000-8000-000000000010';")" != '1' ]]; then
  echo 'Concurrent identical operation wrote more than one receipt.' >&2
  exit 1
fi

# The receipt remains readable by the RPC after a later platform freeze, while
# a brand-new move is refused. This is the ambiguous-response cutover edge.
freeze_replay="$(${psql_cmd[@]} -Atc "${authority_sql}
select set_config('probe.platform_frozen','on',false);
select fn_move_tournament_player_atomic(
 '60000000-0000-4000-8000-000000000010',
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000008',
 '20000000-0000-4000-8000-000000000001',8,
 '50000000-0000-4000-8000-000000000008','2026-09-08T10:00:08Z',110,
 '20000000-0000-4000-8000-000000000002',8)->>'replayed';")"
if [[ "$(printf '%s\n' "$freeze_replay" | tail -n 1)" != 'true' ]]; then
  echo "Frozen exact replay lost its committed proof: ${freeze_replay}" >&2
  exit 1
fi

# Production installs this authority while tournament_players.chips is still
# integer. The later one-shot normalization widens that column to bigint. Prove
# the same function and its pre-cutover receipt survive that exact catalog
# transition, then commit a genuinely >INT32 stack through the unchanged door.
"${psql_cmd[@]}" -c "
  ALTER TABLE public.tournament_players
    ALTER COLUMN chips TYPE bigint USING chips::bigint;
" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null

if [[ "$("${psql_cmd[@]}" -Atc "
  SELECT format_type(a.atttypid, a.atttypmod)
    FROM pg_attribute a
   WHERE a.attrelid='public.tournament_players'::regclass
     AND a.attname='chips' AND NOT a.attisdropped;
")" != 'bigint' ]]; then
  echo 'Atomic move rehearsal did not reach the post-normalization bigint roster shape.' >&2
  exit 1
fi

post_alter_replay="$("${psql_cmd[@]}" -Atc "${authority_sql}
select fn_move_tournament_player_atomic(
 '60000000-0000-4000-8000-000000000001',
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000001',
 '20000000-0000-4000-8000-000000000001',1,
 '50000000-0000-4000-8000-000000000001','2026-09-08T10:00:01Z',2147483647,
 '20000000-0000-4000-8000-000000000002',2)->>'replayed';")"
if [[ "$(printf '%s\n' "$post_alter_replay" | tail -n 1)" != 'true' ]]; then
  echo "Integer-era receipt did not replay after bigint normalization: ${post_alter_replay}" >&2
  exit 1
fi

"${psql_cmd[@]}" -c "
  INSERT INTO public.tournament_players(
    id,tournament_id,user_id,status,table_id,seat_number,chips
  ) VALUES (
    '30000000-0000-4000-8000-000000000010',
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000010','playing',
    '20000000-0000-4000-8000-000000000003',9,2147483648
  );
  INSERT INTO public.table_seats(
    id,table_id,seat_number,user_id,stack,joined_at
  ) VALUES (
    '50000000-0000-4000-8000-000000000010',
    '20000000-0000-4000-8000-000000000003',9,
    '40000000-0000-4000-8000-000000000010',2147483648,
    '2026-09-08T10:00:10Z'
  );
" >/dev/null

post_alter_move="$("${psql_cmd[@]}" -Atc "${authority_sql}
select fn_move_tournament_player_atomic(
 '60000000-0000-4000-8000-000000000011',
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000010',
 '20000000-0000-4000-8000-000000000003',9,
 '50000000-0000-4000-8000-000000000010','2026-09-08T10:00:10Z',2147483648,
 '20000000-0000-4000-8000-000000000002',9);")"
if ! grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$post_alter_move" \
   || ! grep -Eq '"stack"[[:space:]]*:[[:space:]]*2147483648' <<<"$post_alter_move"; then
  echo "Post-normalization bigint move failed: ${post_alter_move}" >&2
  exit 1
fi

echo 'PostgreSQL 17 atomic tournament seat-move integer-to-bigint, replay, hand-lock, concurrency, destination-race, generation, whole-chip, and rollback probes passed.'
