#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  verify-migration-ledger-artifact.sh MIGRATION_NAME PREAPPLY
  verify-migration-ledger-artifact.sh MIGRATION_NAME MIGRATION_VERSION ARTIFACT.sql

PREAPPLY requires zero existing rows with MIGRATION_NAME. Applied mode requires
one globally unique name, the exact version, one statement, and a statement
SHA-256 equal to the local artifact. DATABASE_URL is refused; use libpq PG*
variables or PGSERVICE with a mode-0600 PGPASSFILE.
USAGE
  exit 64
}

[[ "$#" -eq 2 || "$#" -eq 3 ]] || usage
migration_name="$1"
mode="$2"
artifact="${3:-}"

[[ "$migration_name" =~ ^[a-z0-9_]+$ ]] || {
  echo 'MIGRATION_NAME must contain only lowercase letters, digits, and underscores.' >&2
  exit 64
}
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
count_query="$repo_dir/scripts/ops/verify-migration-ledger-name-count.sql"
artifact_query="$repo_dir/scripts/ops/verify-migration-ledger-artifact.sql"
[[ -r "$count_query" && -r "$artifact_query" ]] || {
  echo 'Read-only migration ledger verification queries are unavailable.' >&2
  exit 69
}

if [[ "$mode" == 'PREAPPLY' ]]; then
  [[ "$#" -eq 2 ]] || usage
  name_count="$($psql_bin -X -qAt -v ON_ERROR_STOP=1 \
    -v migration_name="$migration_name" -f "$count_query")"
  [[ "$name_count" == '0' ]] || {
    echo "Migration name is not pristine; found ${name_count:-an invalid count} ledger rows for $migration_name." >&2
    exit 65
  }
  printf 'MIGRATION_LEDGER_NAME_PRISTINE name=%s\n' "$migration_name"
  exit 0
fi

[[ "$#" -eq 3 && "$mode" =~ ^[0-9]{14}$ ]] || usage
[[ -f "$artifact" && ! -L "$artifact" ]] || {
  echo "Migration artifact must be a regular non-symlink file: $artifact" >&2
  exit 66
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
artifact_sha="$(sha256_file "$artifact")"
ledger_row="$($psql_bin -X -qAt -v ON_ERROR_STOP=1 \
  -v migration_name="$migration_name" -v migration_version="$mode" \
  -f "$artifact_query")"
[[ -n "$ledger_row" && "$ledger_row" != *$'\n'* ]] || {
  echo 'Migration ledger did not return exactly one matching row.' >&2
  exit 65
}
IFS='|' read -r ledger_version ledger_name statement_count statement_sha \
  global_name_count unexpected <<<"$ledger_row"
[[ -z "${unexpected:-}" \
   && "$ledger_version" == "$mode" \
   && "$ledger_name" == "$migration_name" \
   && "$statement_count" == '1' \
   && "$statement_sha" == "$artifact_sha" \
   && "$global_name_count" == '1' ]] || {
  echo 'Migration ledger name/version uniqueness, statement cardinality, or exact SQL digest differs from the artifact.' >&2
  exit 65
}
printf 'MIGRATION_LEDGER_ARTIFACT_VERIFIED name=%s version=%s sha256=%s\n' \
  "$ledger_name" "$ledger_version" "$statement_sha"
