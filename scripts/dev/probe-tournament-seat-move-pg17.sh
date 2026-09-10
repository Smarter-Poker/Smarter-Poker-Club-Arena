#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration_matches=(
  "${repo_dir}"/supabase/migrations/*_tournament_seat_moves_are_one_atomic_receipt.sql
)
if [[ ${#migration_matches[@]} -ne 1 || ! -f "${migration_matches[0]}" ]]; then
  echo 'Expected exactly one tournament-seat-move contraction by stable suffix.' >&2
  exit 2
fi
migration="${migration_matches[0]}"
fixture="${repo_dir}/scripts/dev/fixtures/tournament-seat-move-pg17-bootstrap.sql"
postconditions="${repo_dir}/scripts/dev/probe-tournament-seat-move-pg17.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] \
   || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d /tmp/ca-move-pg17.XXXXXX)"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
mkdir -p "$socket_dir"
port="$((47432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == /tmp/ca-move-pg17.* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" -U postgres --auth=trust --no-locale >/dev/null
if ! "${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -l "${probe_root}/postgres.log" \
  -o "-c listen_addresses= -k ${socket_dir} -p ${port}" -w start >/dev/null; then
  cat "${probe_root}/postgres.log" >&2
  exit 1
fi

create_scenario() {
  local database="$1"
  "${pg17_bin}/createdb" -U postgres -h "$socket_dir" -p "$port" "$database"
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 \
    -U postgres -h "$socket_dir" -p "$port" -d "$database" \
    -f "$fixture" >/dev/null
}

apply_migration() {
  local database="$1"
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 \
    -U postgres -h "$socket_dir" -p "$port" -d "$database" \
    -f "$migration"
}

create_scenario canonical
apply_migration canonical >/dev/null
apply_migration canonical >/dev/null
"${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 \
  -U postgres -h "$socket_dir" -p "$port" -d canonical \
  -f "$postconditions" >/dev/null

create_scenario wrong_index
"${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 \
  -U postgres -h "$socket_dir" -p "$port" -d wrong_index -c "
    CREATE UNIQUE INDEX idx_tournament_players_one_active_destination_pointer
      ON public.tournament_players(tournament_id,user_id,seat_number)
     WHERE status IN ('registered','playing')
       AND table_id IS NOT NULL
       AND seat_number IS NOT NULL;
  " >/dev/null
if apply_migration wrong_index >"${probe_root}/wrong-index.log" 2>&1; then
  echo 'Move contraction accepted a wrong same-named pointer index.' >&2
  exit 1
fi
if ! grep -q \
  'Tournament move receipt immutability or active destination uniqueness is missing' \
  "${probe_root}/wrong-index.log"; then
  cat "${probe_root}/wrong-index.log" >&2
  echo 'Wrong-index scenario failed outside the exact invariant.' >&2
  exit 1
fi

create_scenario mutating_resolver
"${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 \
  -U postgres -h "$socket_dir" -p "$port" -d mutating_resolver -c "
    CREATE OR REPLACE FUNCTION public.fn_resolve_committed_tournament_seat_move(
      p_request_id uuid,p_tournament_id uuid,p_user_id uuid,
      p_source_table_id uuid,p_destination_table_id uuid,
      p_destination_seat_number integer,p_source_mode text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public','pg_temp'
    AS \$resolver\$
    BEGIN
      PERFORM current_setting('app.smarter_data_actor',true);
      PERFORM pg_advisory_xact_lock(
        hashtextextended('ca:tournament-terminal-settlement:v1',0));
      UPDATE public.tournament_players SET status=status WHERE false;
      RETURN public.fn_ca_tournament_seat_move_receipt(p_request_id);
    END;
    \$resolver\$;
    REVOKE ALL ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
      uuid,uuid,uuid,uuid,uuid,integer,text)
      FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
      uuid,uuid,uuid,uuid,uuid,integer,text)
      TO service_role;
  " >/dev/null
if apply_migration mutating_resolver >"${probe_root}/mutating-resolver.log" 2>&1; then
  echo 'Move contraction accepted a mutating receipt resolver.' >&2
  exit 1
fi
if ! grep -q 'Tournament move lease-loss resolver is not receipt-only' \
  "${probe_root}/mutating-resolver.log"; then
  cat "${probe_root}/mutating-resolver.log" >&2
  echo 'Mutating-resolver scenario failed outside the exact invariant.' >&2
  exit 1
fi

create_scenario second_writer
"${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 \
  -U postgres -h "$socket_dir" -p "$port" -d second_writer -c "
    CREATE FUNCTION public.fn_move_tournament_player(uuid)
    RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
    REVOKE ALL ON FUNCTION public.fn_move_tournament_player(uuid)
      FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION public.fn_move_tournament_player(uuid)
      TO service_role;
  " >/dev/null
if apply_migration second_writer >"${probe_root}/second-writer.log" 2>&1; then
  echo 'Move contraction accepted a second service-callable writer.' >&2
  exit 1
fi
if ! grep -q 'Tournament move mutation authority is not singular' \
  "${probe_root}/second-writer.log"; then
  cat "${probe_root}/second-writer.log" >&2
  echo 'Second-writer scenario failed outside the exact invariant.' >&2
  exit 1
fi

echo 'PostgreSQL 17 tournament move contraction passed: canonical replay, wrong-index refusal, read-only resolver enforcement, and one-writer enforcement.'
