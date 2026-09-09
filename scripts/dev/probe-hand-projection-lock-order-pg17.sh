#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

migration_by_suffix() {
  local suffix="$1"
  local matches=()
  while IFS= read -r match; do
    matches+=("$match")
  done < <(
    find "$repo_dir/supabase/migrations" -maxdepth 1 -type f \
      -name "*_${suffix}" -print | sort
  )
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one migration ending ${suffix}; found ${#matches[@]}." >&2
    exit 1
  fi
  printf '%s\n' "${matches[0]}"
}

post_commit_migration="$(
  migration_by_suffix post_commit_obligations_are_atomic_and_resumable.sql
)"
lock_order_migration="$(
  migration_by_suffix hand_projection_takes_post_commit_lock_first.sql
)"

if [[ ! "$lock_order_migration" > "$post_commit_migration" ]]; then
  echo 'The hand-projector lock-order migration must follow post-commit obligations.' >&2
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

# PostgreSQL limits Unix-socket paths to roughly one hundred bytes. macOS's
# TMPDIR is already long, so use the short system alias deliberately.
probe_root="$(mktemp -d "/tmp/ca-hp-lock-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
postgres_log="${probe_root}/postgres.log"
mkdir -p "$socket_dir"
port="$((37432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "/tmp/ca-hp-lock-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale \
  --username=postgres >/dev/null
if ! "${pg17_bin}/pg_ctl" -D "$cluster_dir" -l "$postgres_log" \
  -o "-k ${socket_dir} -p ${port} -c deadlock_timeout=100ms" \
  -w start >/dev/null; then
  cat "$postgres_log" >&2
  exit 1
fi

psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  -h "$socket_dir" -p "$port" -U postgres -d postgres
)
probe_sql="$repo_dir/scripts/dev/probe-hand-projection-lock-order-pg17.sql"

"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/fixtures/post-commit-obligations-pg17-bootstrap.sql" \
  >/dev/null
"${psql_cmd[@]}" -v BOOTSTRAP=1 -f "$probe_sql" >/dev/null
"${psql_cmd[@]}" -f "$post_commit_migration" >/dev/null

# First prove the reviewed pre-migration order forms the exact two-session
# cycle. The SQL catches and requires one 40P01, then drains that hand.
"${psql_cmd[@]}" -v ORIGINAL=1 -f "$probe_sql"

"${psql_cmd[@]}" -f "$lock_order_migration" >/dev/null
# A second application proves the forward migration is definition-idempotent.
"${psql_cmd[@]}" -f "$lock_order_migration" >/dev/null

# Re-run the same schedule. It must serialize at hand-post-commit, leave the
# outbox unclaimed while waiting, and finish both calls without a deadlock.
"${psql_cmd[@]}" -v FIXED=1 -f "$probe_sql"
