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

tournament_lease_migration="$(migration_by_suffix tournament_leases_have_fencing_generations.sql)"
launch_child_migration="$(migration_by_suffix tournament_launch_children_share_the_transition_lock.sql)"
table_lease_migration="$(migration_by_suffix table_leases_and_hand_commits_have_generations.sql)"
stage_a_request_migration="$(migration_by_suffix tournament_manager_requests_carry_lease_authority.sql)"
seat_first_atomic_migration="$(migration_by_suffix seat_first_board_creation_is_one_transaction.sql)"
post_commit_migration="$(migration_by_suffix post_commit_obligations_are_atomic_and_resumable.sql)"
stage_b_migration="$(migration_by_suffix tournament_manager_request_fencing_is_strict.sql)"

if [[ "$stage_a_request_migration" > "$seat_first_atomic_migration" ]] ||
  [[ "$seat_first_atomic_migration" > "$post_commit_migration" ]] ||
  [[ "$post_commit_migration" > "$stage_b_migration" ]]; then
  echo 'Migration order must be Stage A request authority, atomic seat-first creation, post-commit obligations, then Stage B.' >&2
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
# The post-commit migration has a full money-path rehearsal of its own. This
# minimal authority fixture declares its exact 12-argument settlement and
# processor catalog doors; the ordering check above prevents Stage B from ever
# sorting before the real DB-first expand migration.
"${psql_cmd[@]}" -f \
  "$stage_b_migration" >/dev/null

"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-tournament-manager-stage-b.sql"

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
