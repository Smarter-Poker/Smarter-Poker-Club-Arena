#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 0 ]] || {
  echo 'Usage: verify-rakeback-source-accrual-preapply.sh' >&2
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
resolver="$repo_dir/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"
ledger_verifier="$repo_dir/scripts/ops/verify-migration-ledger-artifact.sh"
query="$repo_dir/scripts/ops/verify-rakeback-source-accrual-preapply.sql"
[[ -r "$resolver" && -x "$ledger_verifier" && -r "$query" ]] || {
  echo 'Rakeback source-accrual cutover tooling is incomplete.' >&2
  exit 69
}
# The path is derived from this checked-in script.
# shellcheck disable=SC1090,SC1091
source "$resolver"
migration="$(resolve_staged_or_promoted_migration \
  "$repo_dir/supabase/migrations" \
  rakeback_accrues_atomically_with_its_source)"
[[ -f "$migration" && ! -L "$migration" ]] || {
  echo 'Resolved rakeback migration must be a regular non-symlink file.' >&2
  exit 66
}

"$ledger_verifier" rakeback_accrues_atomically_with_its_source PREAPPLY
observed="$($psql_bin -X -qAt -v ON_ERROR_STOP=1 -f "$query")"
[[ "$observed" == RAKEBACK_SOURCE_ACCRUAL_PREAPPLY_OK\ * \
   && "$observed" != *$'\n'* ]] || {
  echo "Rakeback preapply did not return one canonical receipt: ${observed:-<empty>}" >&2
  exit 65
}
if command -v sha256sum >/dev/null 2>&1; then
  artifact_sha="$(sha256sum "$migration" | awk '{print $1}')"
else
  artifact_sha="$(shasum -a 256 "$migration" | awk '{print $1}')"
fi
printf '%s artifact_sha256=%s\n' "$observed" "$artifact_sha"
