#!/usr/bin/env bash
set -euo pipefail

# Verify that a renderer output is a private, byte-exact materialization of the
# reviewed migration and its ten-field receipt. This script is read-only: it
# never connects to PostgreSQL and never applies the artifact.

usage() {
  cat >&2 <<'USAGE'
Usage:
  verify-tournament-fractional-stack-cutover-artifact.sh ENGINE_SHA8 RENDERED.sql [PREAPPLY|MIGRATION_VERSION]

The adjacent RENDERED.sql.receipt must be present. Both files must be regular,
non-symlink, single-link, mode-0600 files produced in a private directory.
PREAPPLY proves the one-shot migration name is absent before application. When
a 14-digit applied version is supplied, the script proves that apply_migration
recorded the exact artifact bytes as its sole globally named ledger statement.
USAGE
  exit 64
}

[[ "$#" -eq 2 || "$#" -eq 3 ]] || usage
engine_sha8="$1"
rendered="$2"
applied_version="${3:-}"

[[ "$engine_sha8" =~ ^[0-9a-f]{8}$ ]] || {
  echo 'ENGINE_SHA8 must be exactly eight lowercase hexadecimal characters.' >&2
  exit 64
}

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
private_directory_helper="$repo_dir/scripts/ops/lib/require-private-cutover-directory.sh"
[[ -r "$private_directory_helper" ]] || {
  echo 'Private cutover-directory validator is unavailable.' >&2
  exit 66
}
# shellcheck source=lib/require-private-cutover-directory.sh
# shellcheck disable=SC1091
source "$private_directory_helper"
rendered_dir="$(dirname "$rendered")"
require_private_cutover_directory "$rendered_dir"
rendered_name="$(basename "$rendered")"
[[ "$rendered_name" != '.' && "$rendered_name" != '..' ]] || usage
rendered="$CUTOVER_PRIVATE_DIRECTORY/$rendered_name"
receipt="${rendered}.receipt"
for evidence in "$rendered" "$receipt"; do
  [[ -f "$evidence" && ! -L "$evidence" ]] || {
    echo "Evidence must be a regular non-symlink file: $evidence" >&2
    exit 66
  }
done

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}
file_links() {
  if stat -f '%l' "$1" >/dev/null 2>&1; then
    stat -f '%l' "$1"
  else
    stat -c '%h' "$1"
  fi
}
for evidence in "$rendered" "$receipt"; do
  [[ "$(file_mode "$evidence")" == '600' ]] || {
    echo "Evidence must have mode 0600: $evidence" >&2
    exit 66
  }
  [[ "$(file_links "$evidence")" == '1' ]] || {
    echo "Evidence must have exactly one hard link: $evidence" >&2
    exit 66
  }
done

line_count="$(wc -l <"$receipt" | tr -d '[:space:]')"
last_byte="$(tail -c 1 "$receipt" | od -An -t u1 | tr -d '[:space:]')"
[[ "$line_count" == '10' && "$last_byte" == '10' ]] || {
  echo 'Receipt must contain exactly ten newline-terminated fields.' >&2
  exit 65
}
{
  IFS= read -r line_engine
  IFS= read -r line_ids
  IFS= read -r line_tournaments
  IFS= read -r line_tables
  IFS= read -r line_seats
  IFS= read -r line_fractional
  IFS= read -r line_total
  IFS= read -r line_pre
  IFS= read -r line_post
  IFS= read -r line_rendered
} <"$receipt"

[[ "$line_engine" == CUTOVER_ENGINE_SHA8=* \
   && "$line_ids" == CUTOVER_TOURNAMENT_IDS_CSV=* \
   && "$line_tournaments" == CUTOVER_TOURNAMENT_COUNT=* \
   && "$line_tables" == CUTOVER_TABLE_COUNT=* \
   && "$line_seats" == CUTOVER_ACTIVE_SEAT_COUNT=* \
   && "$line_fractional" == CUTOVER_FRACTIONAL_SEAT_COUNT=* \
   && "$line_total" == CUTOVER_TOTAL_CHIPS=* \
   && "$line_pre" == CUTOVER_PREIMAGE_SHA256=* \
   && "$line_post" == CUTOVER_POSTIMAGE_SHA256=* \
   && "$line_rendered" == RENDERED_MIGRATION_SHA256=* ]] || {
  echo 'Receipt keys or canonical key order changed.' >&2
  exit 65
}

receipt_engine="${line_engine#*=}"
tournament_ids="${line_ids#*=}"
tournament_count="${line_tournaments#*=}"
table_count="${line_tables#*=}"
active_seat_count="${line_seats#*=}"
fractional_seat_count="${line_fractional#*=}"
total_chips="${line_total#*=}"
preimage_sha="${line_pre#*=}"
postimage_sha="${line_post#*=}"
expected_rendered_sha="${line_rendered#*=}"

[[ "$receipt_engine" == "$engine_sha8" ]] || {
  echo 'Receipt engine SHA does not match the requested exact build.' >&2
  exit 65
}
for count in "$tournament_count" "$table_count" "$active_seat_count" \
  "$fractional_seat_count"; do
  [[ "$count" =~ ^[0-9]+$ ]] || {
    echo "Receipt has an invalid count: $count" >&2
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
  echo 'Receipt counts must describe either one positive rewrite cohort or the exact zero cohort.' >&2
  exit 65
fi
[[ "$total_chips" =~ ^[0-9]+([.][0-9]+)?$ \
   && "$preimage_sha" =~ ^[0-9a-f]{64}$ \
   && "$postimage_sha" =~ ^[0-9a-f]{64}$ \
   && "$expected_rendered_sha" =~ ^[0-9a-f]{64}$ ]] || {
  echo 'Receipt aggregate or SHA-256 fields are invalid.' >&2
  exit 65
}
empty_sha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
if [[ "$zero_cohort" == true ]]; then
  [[ -z "$tournament_ids" \
     && "$total_chips" =~ ^0+([.]0+)?$ \
     && "$preimage_sha" == "$empty_sha" \
     && "$postimage_sha" == "$empty_sha" ]] || {
    echo 'Zero-cohort receipt must contain empty IDs, zero chips, and the canonical empty pre/postimage.' >&2
    exit 65
  }
else
  [[ "$preimage_sha" != "$postimage_sha" ]] || {
    echo 'A positive rewrite cohort must change its exact row image.' >&2
    exit 65
  }
  IFS=',' read -r -a ids <<<"$tournament_ids"
  (( ${#ids[@]} == tournament_count )) || {
    echo 'Receipt tournament CSV cardinality does not match its count.' >&2
    exit 65
  }
  previous=''
  for id in "${ids[@]}"; do
    [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
       && ( -z "$previous" || "$previous" < "$id" ) ]] || {
      echo 'Receipt tournament IDs are not canonical, unique ascending UUIDs.' >&2
      exit 65
    }
    previous="$id"
  done
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
actual_rendered_sha="$(sha256_file "$rendered")"
[[ "$actual_rendered_sha" == "$expected_rendered_sha" ]] || {
  echo 'Rendered artifact SHA-256 does not match its receipt.' >&2
  exit 65
}

materializer="$repo_dir/scripts/ops/materialize-tournament-fractional-stack-cutover.awk"
migration_resolver="$repo_dir/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"
[[ -r "$migration_resolver" && -r "$materializer" ]] || {
  echo 'Expected a readable migration resolver and materializer.' >&2
  exit 66
}
# shellcheck source=lib/resolve-staged-or-promoted-migration.sh
# shellcheck disable=SC1091
source "$migration_resolver"
migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  tournament_fractional_stacks_are_normalized_once)"
verification_tmp="$(mktemp "${rendered}.verify.XXXXXX")"
cleanup() {
  rm -f "$verification_tmp"
}
trap cleanup EXIT

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
  -f "$materializer" "$migration" >"$verification_tmp" || {
  echo 'Canonical migration declarations drifted during verification.' >&2
  exit 65
}

cmp -s "$verification_tmp" "$rendered" || {
  echo 'Rendered artifact is not byte-exact with the canonical migration and receipt.' >&2
  exit 65
}

printf 'RENDERED_ARTIFACT_VERIFIED engine=%s sha256=%s\n' \
  "$engine_sha8" "$actual_rendered_sha"

if [[ -n "$applied_version" ]]; then
  [[ -z "${DATABASE_URL:-}" ]] || {
    echo 'DATABASE_URL is not accepted; use PGSERVICE/PGPASSFILE or ordinary PG* variables so credentials never enter process argv.' >&2
    exit 64
  }
  psql_bin="${PSQL_BIN:-psql}"
  ledger_query="$repo_dir/scripts/ops/verify-tournament-fractional-stack-cutover-ledger.sql"
  ledger_pristine_query="$repo_dir/scripts/ops/verify-tournament-fractional-stack-cutover-ledger-pristine.sql"
  command -v "$psql_bin" >/dev/null 2>&1 \
    && [[ -r "$ledger_query" && -r "$ledger_pristine_query" ]] || {
    echo 'psql or the read-only ledger query is unavailable.' >&2
    exit 69
  }
  if [[ "$applied_version" == 'PREAPPLY' ]]; then
    name_count="$($psql_bin -X -qAt -v ON_ERROR_STOP=1 \
      -f "$ledger_pristine_query")"
    [[ "$name_count" == '0' ]] || {
      echo "One-shot migration name is not pristine; found ${name_count:-an invalid count} ledger rows." >&2
      exit 65
    }
    printf 'LEDGER_NAME_PRISTINE name=%s\n' \
      'tournament_fractional_stacks_are_normalized_once'
    exit 0
  fi
  [[ "$applied_version" =~ ^[0-9]{14}$ ]] || {
    echo 'MIGRATION_VERSION must be PREAPPLY or exactly fourteen decimal digits.' >&2
    exit 64
  }
  ledger_row="$($psql_bin -X -qAt -v ON_ERROR_STOP=1 \
    -v migration_version="$applied_version" -f "$ledger_query")"
  if [[ -z "$ledger_row" || "$ledger_row" == *$'\n'* ]]; then
    echo 'Migration ledger did not return exactly one matching row.' >&2
    exit 65
  fi
  IFS='|' read -r ledger_version ledger_name ledger_statement_count \
    ledger_sha ledger_name_count unexpected <<<"$ledger_row"
  [[ -z "${unexpected:-}" \
     && "$ledger_version" == "$applied_version" \
     && "$ledger_name" == 'tournament_fractional_stacks_are_normalized_once' \
     && "$ledger_statement_count" == '1' \
     && "$ledger_sha" == "$expected_rendered_sha" \
     && "$ledger_name_count" == '1' ]] || {
    echo 'Migration ledger name/version uniqueness, statement cardinality, or exact SQL digest differs from the artifact.' >&2
    exit 65
  }
  printf 'LEDGER_ARTIFACT_VERIFIED version=%s sha256=%s\n' \
    "$ledger_version" "$ledger_sha"
fi
