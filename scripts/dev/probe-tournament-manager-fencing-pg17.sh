#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

migration_by_suffix() {
  local suffix="$1"
  local matches=()
  while IFS= read -r match; do
    matches+=("$match")
  done < <(find "$repo_dir/supabase/migrations" -maxdepth 1 -type f -name "*_${suffix}" -print)
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one migration ending in ${suffix}; found ${#matches[@]}." >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

optional_migration_by_suffix() {
  local suffix="$1"
  local matches=()
  while IFS= read -r match; do
    matches+=("$match")
  done < <(find "$repo_dir/supabase/migrations" -maxdepth 1 -type f -name "*_${suffix}" -print)
  if [[ "${#matches[@]}" -gt 1 ]]; then
    echo "Expected at most one migration ending in ${suffix}; found ${#matches[@]}." >&2
    return 1
  fi
  if [[ "${#matches[@]}" -eq 1 ]]; then
    printf '%s\n' "${matches[0]}"
  fi
}

tournament_lease_migration="$(migration_by_suffix tournament_leases_have_fencing_generations.sql)"
launch_child_migration="$(migration_by_suffix tournament_launch_children_share_the_transition_lock.sql)"
table_lease_migration="$(migration_by_suffix table_leases_and_hand_commits_have_generations.sql)"
stage_a_request_migration="$(migration_by_suffix tournament_manager_requests_carry_lease_authority.sql)"
seat_first_atomic_migration="$(migration_by_suffix seat_first_board_creation_is_one_transaction.sql)"
post_commit_migration="$(migration_by_suffix post_commit_obligations_are_atomic_and_resumable.sql)"
seat_first_retirement_migration="$(migration_by_suffix seat_first_inventory_is_created_atomically.sql)"
stage_b_migration="$(optional_migration_by_suffix tournament_manager_request_fencing_is_strict.sql)"

if [[ "$stage_a_request_migration" > "$seat_first_atomic_migration" ]] ||
  [[ "$seat_first_atomic_migration" > "$post_commit_migration" ]] ||
  [[ "$post_commit_migration" > "$seat_first_retirement_migration" ]] ||
  [[ -n "$stage_b_migration" && "$seat_first_retirement_migration" > "$stage_b_migration" ]]; then
  echo 'Migration order must be Stage A request authority, atomic seat-first creation, post-commit obligations, seat-first repair retirement, then Stage B.' >&2
  exit 1
fi

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ -z "$pg17_bin" ]] && command -v pg_config >/dev/null 2>&1; then
  candidate_bin="$(pg_config --bindir)"
  if "${candidate_bin}/postgres" --version | grep -Eq ' 17\.'; then
    pg17_bin="$candidate_bin"
  fi
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-stage-b-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
mkdir -p "$socket_dir"
port="$((35432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-stage-b-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" -o "-k ${socket_dir} -p ${port}" -w start >/dev/null

psql_cmd=("${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 -h "$socket_dir" -p "$port" -d postgres)

"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/fixtures/tournament-manager-fencing-pg17-bootstrap.sql" >/dev/null
"${psql_cmd[@]}" -f \
  "$tournament_lease_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$tournament_lease_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$launch_child_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$launch_child_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$table_lease_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$table_lease_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$stage_a_request_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$stage_a_request_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$seat_first_atomic_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$seat_first_atomic_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-seat-first-atomic.sql"

"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-stage-a-legacy-capacity.sql"

browser_capacity_log="${probe_root}/stage-a-browser-capacity.log"
if "${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-stage-a-browser-capacity-denied.sql" \
  >"$browser_capacity_log" 2>&1; then
  echo 'Stage A let an authenticated browser use the legacy capacity bridge.' >&2
  exit 1
fi
if ! grep -q 'TOURNAMENT_CAPACITY_RECEIPT_REQUIRED' "$browser_capacity_log"; then
  cat "$browser_capacity_log" >&2
  echo 'Stage-A browser capacity insert failed for an unexpected reason.' >&2
  exit 1
fi
if [[ "$("${psql_cmd[@]}" -Atc \
  "SELECT count(*) FROM public.tables WHERE id='20000000-0000-4000-8000-000000000004'")" != '0' ]]; then
  echo 'Rejected Stage-A browser table survived its failed transaction.' >&2
  exit 1
fi

"${psql_cmd[@]}" -f \
  "$seat_first_retirement_migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$seat_first_retirement_migration" >/dev/null
if [[ "$("${psql_cmd[@]}" -Atc \
  "SELECT to_regprocedure('public.fn_repair_seat_first_games(integer)') IS NULL AND to_regprocedure('public.fn_repair_seat_first_games_before_maintenance_gate(integer)') IS NULL")" != 't' ]]; then
  echo 'Stage A left a timer-driven seat-first repair function installed.' >&2
  exit 1
fi

if [[ -z "$stage_b_migration" ]]; then
  echo 'PostgreSQL 17 Stage-A authority, capacity and seat-first retirement probes passed.'
  exit 0
fi

legacy_session_log="${probe_root}/legacy-capacity-session-a.log"
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-stage-a-legacy-capacity-session-a.sql" \
  >"$legacy_session_log" 2>&1 &
legacy_session_pid=$!

legacy_ready='f'
for _ in {1..80}; do
  legacy_ready="$("${psql_cmd[@]}" -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=9080430 AND granted)")"
  [[ "$legacy_ready" == 't' ]] && break
  sleep 0.05
done
if [[ "$legacy_ready" != 't' ]]; then
  wait "$legacy_session_pid" || true
  cat "$legacy_session_log" >&2
  echo 'Legacy table writer did not reach the Stage-A cutover boundary.' >&2
  exit 1
fi

inflight_cutover_log="${probe_root}/inflight-legacy-cutover.log"
if "${psql_cmd[@]}" -f "$stage_b_migration" \
  >"$inflight_cutover_log" 2>&1; then
  echo 'Stage B crossed an in-flight legacy raw table writer.' >&2
  exit 1
fi
if ! grep -Eq 'could not obtain lock on relation "(public\.)?tables"' \
  "$inflight_cutover_log"; then
  cat "$inflight_cutover_log" >&2
  echo 'Stage B refused the in-flight writer for an unexpected reason.' >&2
  exit 1
fi
if [[ "$("${psql_cmd[@]}" -Atc \
  "SELECT to_regprocedure('public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)') IS NOT NULL")" != 't' ]]; then
  echo 'Failed Stage-B attempt partially retired the Stage-A capacity bridge.' >&2
  exit 1
fi

wait "$legacy_session_pid"
if [[ "$("${psql_cmd[@]}" -Atc \
  "SELECT count(*) FROM public.tournament_table_origins o JOIN public.tournament_capacity_table_receipts c USING (table_id,tournament_id) JOIN public.tournament_manager_wakes w ON w.id=c.manager_wake_id WHERE o.table_id='20000000-0000-4000-8000-000000000005' AND o.origin_kind='capacity' AND w.reason='late_registration'")" != '1' ]]; then
  cat "$legacy_session_log" >&2
  echo 'In-flight Stage-A table did not commit canonical capacity provenance.' >&2
  exit 1
fi

live_protocol_one_log="${probe_root}/live-protocol-one-cutover.log"
if "${psql_cmd[@]}" -f "$stage_b_migration" \
  >"$live_protocol_one_log" 2>&1; then
  echo 'Stage B retired the bridge while a fresh protocol-1 lease remained.' >&2
  exit 1
fi
if ! grep -q \
  'a fresh protocol-1 tournament manager still owns a lease' \
  "$live_protocol_one_log"; then
  cat "$live_protocol_one_log" >&2
  echo 'Stage B rejected a live protocol-1 manager for an unexpected reason.' >&2
  exit 1
fi
if [[ "$("${psql_cmd[@]}" -Atc \
  "SELECT to_regprocedure('public.fn_stage_a_bridge_legacy_capacity_receipt(uuid,uuid)') IS NOT NULL")" != 't' ]]; then
  echo 'Protocol-1 refusal partially retired the Stage-A capacity bridge.' >&2
  exit 1
fi

"${psql_cmd[@]}" -c \
  "DELETE FROM public.engine_tournament_leases WHERE protocol_version=1;" \
  >/dev/null
# The post-commit migration has a full money-path rehearsal of its own. This
# minimal authority fixture declares its exact 12-argument settlement and
# processor catalog doors; the ordering check above prevents Stage B from ever
# sorting before the real DB-first expand migration.
"${psql_cmd[@]}" -c \
  "INSERT INTO public.tournaments(id,name,status) VALUES ('10000000-0000-4000-8000-000000000099','Legacy Deal Carryover','RUNNING'); INSERT INTO public.tournament_final_table_deal_receipts(tournament_id) VALUES ('10000000-0000-4000-8000-000000000099');" \
  >/dev/null
carryover_log="${probe_root}/active-final-table-deal.log"
if "${psql_cmd[@]}" -f "$stage_b_migration" >"$carryover_log" 2>&1; then
  echo 'Stage B accepted an active final-table-deal receipt without a replayable terminal state.' >&2
  exit 1
fi
if ! grep -q 'active final-table deal has a batch or payment evidence that cannot replay' \
  "$carryover_log"; then
  cat "$carryover_log" >&2
  echo 'Stage B rejected the active final-table deal for an unexpected reason.' >&2
  exit 1
fi
"${psql_cmd[@]}" -c \
  "DELETE FROM public.tournament_final_table_deal_receipts WHERE tournament_id='10000000-0000-4000-8000-000000000099'; DELETE FROM public.tournaments WHERE id='10000000-0000-4000-8000-000000000099';" \
  >/dev/null

"${psql_cmd[@]}" -f \
  "$stage_b_migration" >/dev/null

"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-tournament-manager-stage-b.sql"

post_cutover_capacity_log="${probe_root}/stage-b-legacy-capacity.log"
if "${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-stage-b-legacy-capacity-denied.sql" \
  >"$post_cutover_capacity_log" 2>&1; then
  echo 'Stage B still admitted a raw legacy tournament table insert.' >&2
  exit 1
fi
if ! grep -q 'TOURNAMENT_CAPACITY_RECEIPT_REQUIRED' \
  "$post_cutover_capacity_log"; then
  cat "$post_cutover_capacity_log" >&2
  echo 'Post-cutover raw table insert failed for an unexpected reason.' >&2
  exit 1
fi
if [[ "$("${psql_cmd[@]}" -Atc \
  "SELECT count(*) FROM public.tables WHERE id='20000000-0000-4000-8000-000000000006'")" != '0' ]]; then
  echo 'Rejected post-cutover raw table survived its failed transaction.' >&2
  exit 1
fi

session_a_log="${probe_root}/session-a.log"
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-tournament-roster-lock-session-a.sql" \
  >"$session_a_log" 2>&1 &
session_a_pid=$!

ready='f'
for _ in {1..40}; do
  ready="$("${psql_cmd[@]}" -Atc \
    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 9080220 AND granted)")"
  [[ "$ready" == 't' ]] && break
  sleep 0.05
done
if [[ "$ready" != 't' ]]; then
  wait "$session_a_pid" || true
  cat "$session_a_log" >&2
  echo 'Session A did not reach the post-seat-insert lock boundary.' >&2
  exit 1
fi

blocked_log="${probe_root}/blocked-roster-update.log"
if "${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-tournament-roster-lock-session-b.sql" \
  >"$blocked_log" 2>&1; then
  echo 'Concurrent active-to-inactive roster update bypassed the seat parent lock.' >&2
  exit 1
fi
if ! grep -q 'TOURNAMENT_TRANSITION_BUSY' "$blocked_log"; then
  cat "$blocked_log" >&2
  echo 'Concurrent roster update failed for an unexpected reason.' >&2
  exit 1
fi
wait "$session_a_pid"

orphan_log="${probe_root}/orphan-roster-update.log"
if "${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-tournament-roster-lock-session-b.sql" \
  >"$orphan_log" 2>&1; then
  echo 'Roster update committed after a live seat existed.' >&2
  exit 1
fi
if ! grep -q 'TOURNAMENT_SEAT_ROSTER_REQUIRED' "$orphan_log"; then
  cat "$orphan_log" >&2
  echo 'Post-seat roster update failed for an unexpected reason.' >&2
  exit 1
fi

state="$("${psql_cmd[@]}" -Atc \
  "SELECT p.status || ':' || count(s.*)::text FROM public.tournament_players p LEFT JOIN public.table_seats s ON s.user_id = p.user_id AND s.left_at IS NULL WHERE p.tournament_id = '10000000-0000-4000-8000-000000000001' GROUP BY p.status")"
if [[ "$state" != 'registered:1' ]]; then
  echo "Invariant probe left unexpected state: ${state}" >&2
  exit 1
fi

"${psql_cmd[@]}" -f \
  "$stage_b_migration" >/dev/null

echo 'PostgreSQL 17 Stage-B + two-session roster fencing probes passed.'
