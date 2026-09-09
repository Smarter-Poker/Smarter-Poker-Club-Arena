#!/usr/bin/env bash
set -euo pipefail

# Render the one-time fractional tournament-stack migration from exactly one
# locked, stopped-engine database observation.  This script never applies the
# migration and the observation transaction always rolls back.  Its only
# durable outputs are a mode-0600 rendered SQL file and a receipt containing
# the nine migration literals plus the rendered artifact digest.

usage() {
  cat >&2 <<'USAGE'
Usage:
  render-tournament-fractional-stack-cutover.sh ENGINE_SHA8 OUTPUT.sql

Connection:
  Use libpq's ordinary PGHOST/PGPORT/PGUSER/PGDATABASE variables, or
  PGSERVICE, with credentials in a mode-0600 PGPASSFILE. DATABASE_URL is
  deliberately refused because a URI argument exposes credentials via argv.

Optional:
  PSQL_BIN                           psql executable (default: psql)
  CUTOVER_MIN_REMAINING_SECONDS      210..899 (default: 210)

The engine must already be stopped, its leases older than 30 seconds, and the
exact build must own an enforced counting_down maintenance break.
USAGE
  exit 64
}

[[ "$#" -eq 2 ]] || usage

engine_sha8="$1"
output="$2"
min_remaining="${CUTOVER_MIN_REMAINING_SECONDS:-210}"
psql_bin="${PSQL_BIN:-psql}"

[[ "$engine_sha8" =~ ^[0-9a-f]{8}$ ]] || {
  echo 'ENGINE_SHA8 must be exactly eight lowercase hexadecimal characters.' >&2
  exit 64
}
if [[ ! "$min_remaining" =~ ^[0-9]+$ ]] \
  || (( min_remaining < 210 || min_remaining >= 900 )); then
  echo 'CUTOVER_MIN_REMAINING_SECONDS must be an integer from 210 through 899.' >&2
  exit 64
fi
[[ -n "$output" && "$output" != */ && "$output" != -* ]] || usage
[[ -z "${DATABASE_URL:-}" ]] || {
  echo 'DATABASE_URL is not accepted; use PGSERVICE/PGPASSFILE or ordinary PG* variables so credentials never enter process argv.' >&2
  exit 64
}
command -v "$psql_bin" >/dev/null 2>&1 || {
  echo "psql executable not found: $psql_bin" >&2
  exit 69
}

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
private_directory_helper="$repo_dir/scripts/ops/lib/require-private-cutover-directory.sh"
migration_resolver="$repo_dir/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"
measurement="$repo_dir/scripts/ops/measure-tournament-fractional-stack-cutover.sql"
materializer="$repo_dir/scripts/ops/materialize-tournament-fractional-stack-cutover.awk"
[[ -r "$migration_resolver" ]] || {
  echo 'Staged-or-promoted migration resolver is unreadable.' >&2
  exit 66
}
# shellcheck source=lib/resolve-staged-or-promoted-migration.sh
# shellcheck disable=SC1091
source "$migration_resolver"
migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  tournament_fractional_stacks_are_normalized_once)"
[[ -r "$private_directory_helper" && -r "$measurement" \
   && -r "$materializer" && -r "$migration" ]] || {
  echo 'Cutover measurement, materializer, or migration template is unreadable.' >&2
  exit 66
}

umask 077
output_dir="$(dirname "$output")"
# shellcheck source=lib/require-private-cutover-directory.sh
# shellcheck disable=SC1091
source "$private_directory_helper"
require_private_cutover_directory "$output_dir"
output_name="$(basename "$output")"
[[ "$output_name" != '.' && "$output_name" != '..' ]] || usage
output="$CUTOVER_PRIVATE_DIRECTORY/$output_name"
[[ ! -e "$output" && ! -L "$output" \
   && ! -e "${output}.receipt" && ! -L "${output}.receipt" ]] || {
  echo "Refusing to overwrite $output or ${output}.receipt." >&2
  exit 73
}
render_tmp="$(mktemp "${output}.render.XXXXXX")"
receipt_tmp="$(mktemp "${output}.receipt.XXXXXX")"
cleanup() {
  rm -f "$render_tmp" "$receipt_tmp"
}
trap cleanup EXIT

observed="$($psql_bin -X -qAt -v ON_ERROR_STOP=1 \
  -v expected_engine_sha8="$engine_sha8" \
  -v min_remaining_seconds="$min_remaining" \
  -f "$measurement")"

if [[ -z "$observed" || "$observed" == *$'\n'* ]]; then
  echo 'The locked observation did not emit exactly one row.' >&2
  exit 65
fi

IFS='|' read -r observed_engine tournament_ids tournament_count table_count \
  active_seat_count fractional_seat_count total_chips preimage_sha \
  postimage_sha unexpected <<<"$observed"

[[ -z "${unexpected:-}" && "$observed_engine" == "$engine_sha8" ]] || {
  echo 'The locked observation did not emit exactly the expected nine fields.' >&2
  exit 65
}
for value in "$tournament_count" "$table_count" "$active_seat_count" \
  "$fractional_seat_count"; do
  [[ "$value" =~ ^[0-9]+$ ]] || {
    echo "Invalid cutover count: $value" >&2
    exit 65
  }
done
zero_cohort=false
if (( tournament_count == 0 && table_count == 0 \
      && active_seat_count == 0 && fractional_seat_count == 0 )); then
  zero_cohort=true
elif (( tournament_count == 0 || table_count == 0 \
        || active_seat_count == 0 \
        || fractional_seat_count > active_seat_count )); then
  echo 'Cutover counts must describe either one positive rewrite cohort or the exact zero cohort.' >&2
  exit 65
fi
[[ "$total_chips" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  echo "Invalid aggregate chip literal: $total_chips" >&2
  exit 65
}
empty_sha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
[[ "$preimage_sha" =~ ^[0-9a-f]{64}$ \
   && "$postimage_sha" =~ ^[0-9a-f]{64}$ ]] || {
  echo 'Invalid or unchanged pre/postimage hash.' >&2
  exit 65
}
if [[ "$zero_cohort" == true ]]; then
  [[ -z "$tournament_ids" \
     && "$total_chips" =~ ^0+([.]0+)?$ \
     && "$preimage_sha" == "$empty_sha" \
     && "$postimage_sha" == "$empty_sha" ]] || {
    echo 'Zero-cohort evidence must have empty IDs, zero chips, and the canonical empty pre/postimage.' >&2
    exit 65
  }
else
  [[ "$preimage_sha" != "$postimage_sha" ]] || {
    echo 'A positive rewrite cohort must change its exact row image.' >&2
    exit 65
  }
  IFS=',' read -r -a ids <<<"$tournament_ids"
  (( ${#ids[@]} == tournament_count )) || {
    echo 'Tournament CSV cardinality does not equal tournament_count.' >&2
    exit 65
  }
  previous=''
  for id in "${ids[@]}"; do
    [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
      echo "Invalid tournament UUID in observation: $id" >&2
      exit 65
    }
    [[ -z "$previous" || "$previous" < "$id" ]] || {
      echo 'Tournament UUIDs are not unique canonical ascending CSV.' >&2
      exit 65
    }
    previous="$id"
  done
fi

awk \
  -v engine_sha8="$engine_sha8" \
  -v tournament_ids="$tournament_ids" \
  -v tournament_count="$tournament_count" \
  -v table_count="$table_count" \
  -v active_seat_count="$active_seat_count" \
  -v fractional_seat_count="$fractional_seat_count" \
  -v total_chips="$total_chips" \
  -v preimage_sha="$preimage_sha" \
  -v postimage_sha="$postimage_sha" \
  -f "$materializer" "$migration" >"$render_tmp" || {
    echo 'Migration declarations drifted; all nine replacements were not unique.' >&2
    exit 65
  }

if grep -Eq '^  c_(engine_sha8|tournament_ids_csv|preimage_sha256|postimage_sha256) constant text := .__CUTOVER_|^  c_(tournament_count|table_count|active_seat_count|fractional_seat_count) constant integer := -1;|^  c_total_chips constant numeric := -1;' "$render_tmp"; then
  echo 'Rendered migration still contains a cutover sentinel.' >&2
  exit 65
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
rendered_sha="$(sha256_file "$render_tmp")"

{
  printf 'CUTOVER_ENGINE_SHA8=%s\n' "$engine_sha8"
  printf 'CUTOVER_TOURNAMENT_IDS_CSV=%s\n' "$tournament_ids"
  printf 'CUTOVER_TOURNAMENT_COUNT=%s\n' "$tournament_count"
  printf 'CUTOVER_TABLE_COUNT=%s\n' "$table_count"
  printf 'CUTOVER_ACTIVE_SEAT_COUNT=%s\n' "$active_seat_count"
  printf 'CUTOVER_FRACTIONAL_SEAT_COUNT=%s\n' "$fractional_seat_count"
  printf 'CUTOVER_TOTAL_CHIPS=%s\n' "$total_chips"
  printf 'CUTOVER_PREIMAGE_SHA256=%s\n' "$preimage_sha"
  printf 'CUTOVER_POSTIMAGE_SHA256=%s\n' "$postimage_sha"
  printf 'RENDERED_MIGRATION_SHA256=%s\n' "$rendered_sha"
} >"$receipt_tmp"

chmod 600 "$render_tmp" "$receipt_tmp"

# This controlled delay is reachable only from the adversarial PG17 harness.
# It creates a deterministic race point after observation/rendering and before
# installation; it cannot bypass any database guard.
install_delay="${CUTOVER_TEST_INSTALL_DELAY_SECONDS:-0}"
if [[ "$install_delay" != '0' ]]; then
  [[ "${CUTOVER_TEST_MODE:-}" == '1' \
     && "$install_delay" =~ ^[1-5]$ ]] || {
    echo 'CUTOVER_TEST_INSTALL_DELAY_SECONDS is test-only and must be 1..5.' >&2
    exit 64
  }
  echo 'CUTOVER_TEST_INSTALL_READY' >&2
  sleep "$install_delay"
fi

# Install with create-if-absent hard links. Unlike mv, link(2) fails with
# EEXIST if either evidence path appeared after the early convenience check.
# Keep the temp links until both final links exist. If the receipt path loses a
# race, leave the mode-0600 SQL artifact in the private directory: unlinking a
# pathname after a separate identity check has its own check/unlink race. A
# partial pair is unusable because the verifier requires both files.
if ! ln "$render_tmp" "$output" 2>/dev/null; then
  echo "Refusing to overwrite $output or ${output}.receipt at atomic install." >&2
  exit 73
fi
if ! ln "$receipt_tmp" "${output}.receipt" 2>/dev/null; then
  echo "Refusing to overwrite $output or ${output}.receipt at atomic install; the private unverified SQL artifact was left in place." >&2
  exit 73
fi
if [[ ! "$output" -ef "$render_tmp" \
   || ! "${output}.receipt" -ef "$receipt_tmp" ]]; then
  echo 'Installed evidence inode changed before publication completed.' >&2
  exit 73
fi
rm -f "$render_tmp" "$receipt_tmp"
trap - EXIT

cat "${output}.receipt"
