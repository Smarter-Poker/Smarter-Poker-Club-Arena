#!/usr/bin/env bash
# Read-only prerequisite. Never install packages or touch a database service
# on a shared CI host. Each accounting probe creates its own private cluster.
set -euo pipefail
if (( $# > 1 )); then
  echo 'Usage: verify-postgres17-tools.sh [PG_BIN]' >&2
  exit 64
fi
pg_ci_bin="${1:-/usr/lib/postgresql/17/bin}"
for pg_ci_tool in postgres initdb pg_ctl psql pg_config; do
  pg_ci_path="$pg_ci_bin/$pg_ci_tool"
  if [[ ! -f "$pg_ci_path" || ! -x "$pg_ci_path" ]]; then
    echo "Missing PostgreSQL 17 tool: $pg_ci_tool. Provision the qualified CI host; this job will not install it." >&2
    exit 1
  fi
  pg_ci_version=$("$pg_ci_path" --version)
  if [[ ! "$pg_ci_version" =~ PostgreSQL\)?[[:space:]]17\. ]]; then
    echo "Expected PostgreSQL 17 tool: $pg_ci_tool." >&2
    exit 1
  fi
done
echo 'PostgreSQL 17 tools verified; no host changes made.'
