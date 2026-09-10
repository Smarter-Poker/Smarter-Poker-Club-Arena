#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
canonical="${repo_dir}/supabase/migrations/20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql"
bootstrap="${repo_dir}/scripts/dev/fixtures/tournament-pending-zero-cutover-pg17-bootstrap.sql"
probe="${repo_dir}/scripts/dev/probe-tournament-pending-zero-cutover-pg17.sql"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | rg -q ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

for required in "$canonical" "$bootstrap" "$probe"; do
  if [[ ! -f "$required" ]]; then
    echo "Required probe input is missing: $required" >&2
    exit 1
  fi
done

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-pending-zero-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
cutover_sql="${probe_root}/pending-zero-cutover.sql"
mkdir -p "$socket_dir"
port="$((39432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-pending-zero-pg17."* ]]; then
    find "$probe_root" -depth -delete
  fi
}
trap cleanup EXIT

# Extract the exact receipt DDL, classification CTAS, and mutation block from
# M6. The harness therefore fails if the canonical migration and probe drift.
{
  printf '%s\n' 'BEGIN;'
  awk '
    /^CREATE TABLE public\.tournament_pending_zero_seat_cutover_receipts \(/ {
      capture=1
    }
    capture { print }
    capture && /^\);$/ { exit }
  ' "$canonical"
  awk '
    /^CREATE TEMP TABLE ca_cutover_candidate_windows ON COMMIT DROP AS/ {
      capture=1
    }
    /^-- The retired writer.s idempotency amount/ { exit }
    capture { print }
  ' "$canonical"
  printf '%s\n' \
    'CREATE TEMP TABLE ca_cutover_candidate_rebuy_payments (' \
    '  candidate_id uuid PRIMARY KEY' \
    ') ON COMMIT DROP;'
  awk '
    /^CREATE TEMP TABLE ca_cutover_pending_zero_seats ON COMMIT DROP AS/ {
      capture=1
    }
    /^-- The old process-start sweep/ { exit }
    capture { print }
  ' "$canonical"
  printf '%s\n' \
    "DO \$probe_pending_zero_repair\$" \
    'DECLARE' \
    '  v_pending_zero_candidate_ids uuid[]:=ARRAY[]::uuid[];' \
    '  v_pending_zero_seat_ids uuid[]:=ARRAY[]::uuid[];' \
    '  v_item record;' \
    '  v_vacated_at timestamptz;' \
    '  v_table_current_players_before integer;' \
    '  v_table_current_players_after integer;' \
    '  v_table_live_seats_before integer;' \
    '  v_table_live_seats_after integer;' \
    '  v_rows integer;' \
    'BEGIN'
  awk '
    /^  -- A playing zero roster is already committed/ { capture=1 }
    /^  -- Retire the minute reconciler/ { exit }
    capture { print }
  ' "$canonical"
  printf '%s\n' 'END;' "\$probe_pending_zero_repair\$;" 'COMMIT;'
} >"$cutover_sql"

for required_text in \
  'CREATE TABLE public.tournament_pending_zero_seat_cutover_receipts' \
  'CREATE TEMP TABLE ca_cutover_candidate_windows' \
  'CREATE TEMP TABLE ca_cutover_pending_zero_seats' \
  'without one exact unpaid pending-zero candidate' \
  'INSERT INTO public.tournament_pending_zero_seat_cutover_receipts'; do
  if ! rg -q "$required_text" "$cutover_sql"; then
    echo "Canonical pending-zero extraction is incomplete: $required_text" >&2
    exit 1
  fi
done

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-h '' -k '${socket_dir}' -p ${port}" -w start >/dev/null

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -h "$socket_dir" -p "$port" -d postgres
)

"${pg17_bin}/postgres" --version

run_bootstrap() {
  local scenario="$1"
  "${psql_cmd[@]}" -v "scenario=${scenario}" -f "$bootstrap" >/dev/null
}

run_expected_refusal() {
  local scenario="$1"
  local output
  local result
  set +e
  output="$("${psql_cmd[@]}" -f "$cutover_sql" 2>&1)"
  result=$?
  set -e
  if [[ $result -eq 0 ]] || ! rg -q \
    'zero-chip playing roster has a live seat without one exact unpaid pending-zero candidate' \
    <<<"$output"; then
    echo "${scenario} evidence did not fail closed as expected" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  "${psql_cmd[@]}" -v "scenario=${scenario}" -f "$probe"
}

run_bootstrap eligible
"${psql_cmd[@]}" -f "$cutover_sql" >/dev/null
"${psql_cmd[@]}" -v scenario=eligible -f "$probe"

run_bootstrap funding
run_expected_refusal funding

run_bootstrap later
run_expected_refusal later
