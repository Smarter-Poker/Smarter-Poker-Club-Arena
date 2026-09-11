#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 1 && "$1" =~ ^[0-9a-f]{8}$ ]] || {
  echo 'Usage: verify-stage-b-zero-authority.sh ENGINE_SHA8' >&2
  exit 64
}
engine_sha8="$1"
[[ -z "${DATABASE_URL:-}" ]] || {
  echo 'DATABASE_URL is not accepted; use PGSERVICE/PGPASSFILE or ordinary PG* variables so credentials never enter process argv.' >&2
  exit 64
}
psql_bin="${PSQL_BIN:-psql}"
command -v "$psql_bin" >/dev/null 2>&1 || {
  echo "psql executable not found: $psql_bin" >&2
  exit 69
}
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
query="$repo_dir/scripts/ops/verify-stage-b-zero-authority.sql"
[[ -r "$query" ]] || {
  echo 'Read-only zero-authority query is unavailable.' >&2
  exit 69
}
observed="$($psql_bin -X -qAt -v ON_ERROR_STOP=1 -f "$query")"
[[ -n "$observed" && "$observed" != *$'\n'* ]] || {
  echo 'Zero-authority query did not return exactly one maintenance row.' >&2
  exit 65
}
IFS='|' read -r phase enforce_freeze break_started_at break_ends_at remaining_seconds \
  declared_by platform_frozen fresh_leaders fresh_tables fresh_tournaments \
  last_leader last_table last_tournament unexpected <<<"$observed"
[[ -z "${unexpected:-}" \
   && "$phase" == 'counting_down' \
   && "$enforce_freeze" == 't' \
   && -n "$break_started_at" \
   && -n "$break_ends_at" \
   && "$remaining_seconds" =~ ^[0-9]+$ \
   && "$remaining_seconds" -ge 210 \
   && "$remaining_seconds" -lt 900 \
   && "$declared_by" == "$engine_sha8" \
   && "$platform_frozen" == 't' \
   && "$fresh_leaders" == '0' \
   && "$fresh_tables" == '0' \
   && "$fresh_tournaments" == '0' ]] || {
  echo "Stopped exact-build authority proof failed: $observed" >&2
  exit 65
}
printf 'STAGE_B_ZERO_AUTHORITY_VERIFIED engine=%s remaining_seconds=%s last_heartbeats=%s,%s,%s\n' \
  "$engine_sha8" "$remaining_seconds" "${last_leader:-none}" \
  "${last_table:-none}" "${last_tournament:-none}"
