#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mapfile_compat() {
  local suffix="$1"
  find "$repo_dir/supabase/migrations" -maxdepth 1 -type f \
    -name "*_${suffix}" -print | sort
}

migration_matches=()
while IFS= read -r match; do
  migration_matches+=("$match")
done < <(mapfile_compat post_commit_obligations_are_atomic_and_resumable.sql)
if [[ "${#migration_matches[@]}" -ne 1 ]]; then
  echo "Expected exactly one post-commit obligations migration; found ${#migration_matches[@]}." >&2
  exit 1
fi
migration="${migration_matches[0]}"

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ca-post-commit-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
mkdir -p "$socket_dir"
port="$((36432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "${TMPDIR:-/tmp}/ca-post-commit-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" -o "-k ${socket_dir} -p ${port}" -w start >/dev/null

psql_cmd=("${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 -h "$socket_dir" -p "$port" -d postgres)
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/fixtures/post-commit-obligations-pg17-bootstrap.sql" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-post-commit-obligations-pg17.sql"
