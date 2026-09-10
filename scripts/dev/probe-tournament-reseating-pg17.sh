#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/initdb" ]] || ! "${pg17_bin}/postgres" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 tools are required. Set PG17_BINDIR to their bin directory.' >&2
  exit 2
fi

# PostgreSQL caps Unix-domain socket paths at roughly 100 bytes. macOS TMPDIR
# values are long enough that nesting a socket directory under them can exceed
# that limit, so keep this disposable cluster under a short, explicit prefix.
probe_root="$(mktemp -d "/tmp/ca-reseat-pg17.XXXXXX")"
cluster_dir="${probe_root}/cluster"
socket_dir="${probe_root}/socket"
mkdir -p "$socket_dir"
port="$((37432 + ($$ % 10000)))"

cleanup() {
  if [[ -d "$cluster_dir" ]]; then
    "${pg17_bin}/pg_ctl" -D "$cluster_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [[ "$probe_root" == "/tmp/ca-reseat-pg17."* ]]; then
    rm -rf "$probe_root"
  fi
}
trap cleanup EXIT

"${pg17_bin}/initdb" -D "$cluster_dir" --auth=trust --no-locale >/dev/null
"${pg17_bin}/pg_ctl" -D "$cluster_dir" \
  -o "-k ${socket_dir} -p ${port} -c listen_addresses=" -w start >/dev/null
psql_cmd=("${pg17_bin}/psql" -X -v ON_ERROR_STOP=1 -h "$socket_dir" -p "$port" -d postgres)

"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/fixtures/tournament-reseating-pg17-bootstrap.sql" >/dev/null
"${psql_cmd[@]}" -f \
  "$repo_dir/supabase/migrations/20260909222020_tournament_reseating_uses_one_database_chosen_legal_chair.sql" >/dev/null
"${psql_cmd[@]}" -f \
  "$repo_dir/scripts/dev/probe-tournament-reseating-pg17.sql"
