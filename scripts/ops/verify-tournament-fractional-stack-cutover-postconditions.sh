#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: verify-tournament-fractional-stack-cutover-postconditions.sh RENDERED.sql' >&2
  exit 64
}

[[ "$#" -eq 1 ]] || usage
rendered="$1"
[[ -z "${DATABASE_URL:-}" ]] || {
  echo 'DATABASE_URL is not accepted; use PGSERVICE/PGPASSFILE or ordinary PG* variables so credentials never enter process argv.' >&2
  exit 64
}
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
private_directory_helper="$repo_dir/scripts/ops/lib/require-private-cutover-directory.sh"
artifact_verifier="$repo_dir/scripts/ops/verify-tournament-fractional-stack-cutover-artifact.sh"
query="$repo_dir/scripts/ops/verify-tournament-fractional-stack-cutover-postconditions.sql"
[[ -r "$private_directory_helper" && -x "$artifact_verifier" && -r "$query" ]] || {
  echo 'Postcondition verifier dependencies are unavailable.' >&2
  exit 69
}
# shellcheck source=lib/require-private-cutover-directory.sh
# shellcheck disable=SC1091
source "$private_directory_helper"
rendered_dir="$(dirname "$rendered")"
require_private_cutover_directory "$rendered_dir"
rendered="$CUTOVER_PRIVATE_DIRECTORY/$(basename "$rendered")"
receipt="${rendered}.receipt"
engine_sha8="$(sed -n 's/^CUTOVER_ENGINE_SHA8=//p' "$receipt")"
"$artifact_verifier" "$engine_sha8" "$rendered" >/dev/null

receipt_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$receipt"
}
tournament_ids="$(receipt_value CUTOVER_TOURNAMENT_IDS_CSV)"
tournament_count="$(receipt_value CUTOVER_TOURNAMENT_COUNT)"
table_count="$(receipt_value CUTOVER_TABLE_COUNT)"
active_seat_count="$(receipt_value CUTOVER_ACTIVE_SEAT_COUNT)"
total_chips="$(receipt_value CUTOVER_TOTAL_CHIPS)"

psql_bin="${PSQL_BIN:-psql}"
command -v "$psql_bin" >/dev/null 2>&1 || {
  echo "psql executable not found: $psql_bin" >&2
  exit 69
}
observed="$($psql_bin -X -qAt -v ON_ERROR_STOP=1 \
  -v tournament_ids_csv="$tournament_ids" -f "$query")"
[[ -n "$observed" && "$observed" != *$'\n'* ]] || {
  echo 'Postcondition query did not return exactly one row.' >&2
  exit 65
}
IFS='|' read -r player_type flight_type invalid_active roster_mismatch \
  reverse_mismatch triggers actual_tournaments actual_tables actual_seats \
  fractional_seats actual_total unexpected <<<"$observed"
[[ -z "${unexpected:-}" \
   && "$player_type" == 'bigint' \
   && ( "$flight_type" == 'absent' || "$flight_type" == 'bigint' ) \
   && "$invalid_active" == '0' \
   && "$roster_mismatch" == '0' \
   && "$reverse_mismatch" == '0' \
   && "$triggers" == '4' \
   && "$actual_tournaments" == "$tournament_count" \
   && "$actual_tables" == "$table_count" \
   && "$actual_seats" == "$active_seat_count" \
   && "$fractional_seats" == '0' \
   && "$actual_total" == "$total_chips" ]] || {
  echo "Tournament whole-chip postconditions failed: $observed" >&2
  exit 65
}
printf 'TOURNAMENT_WHOLE_CHIP_POSTCONDITIONS_VERIFIED tournaments=%s tables=%s seats=%s total=%s\n' \
  "$actual_tournaments" "$actual_tables" "$actual_seats" "$actual_total"
