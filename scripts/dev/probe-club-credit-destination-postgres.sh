#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
test -x "$PGBIN/initdb"
credit_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$credit_share/postgres.bki" && -f "$PGBIN/../share/postgresql/postgres.bki" ]]; then
  credit_share="$PGBIN/../share/postgresql"
fi
test -f "$credit_share/postgres.bki"
credit_tmp="$(mktemp -d "${TMPDIR:-/tmp}/ca-credit-destination.XXXXXX")"
cleanup() {
  "$PGBIN/pg_ctl" -D "$credit_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$credit_tmp"
}
trap cleanup EXIT
mkdir "$credit_tmp/socket"
"$PGBIN/initdb" -L "$credit_share" -D "$credit_tmp/data" -U credit_test -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$credit_tmp/data" -l "$credit_tmp/postgres.log" \
  -o "-h '' -k '$credit_tmp/socket' -p 55444" -w start >/dev/null
credit_psql=("$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$credit_tmp/socket" -p 55444 -U credit_test -d postgres)
"${credit_psql[@]}" -f "$repo/scripts/dev/fixtures/departure-postgres.sql" >/dev/null
"${credit_psql[@]}" -f "$repo/scripts/dev/fixtures/departure-credit-function.sql" >/dev/null
for credit_apply in 1 2; do
  "${credit_psql[@]}" -f "$repo/supabase/migrations/20260909031958_club_credit_requires_an_actual_destination_wallet_write.sql" >/dev/null
done
"${credit_psql[@]}" -f "$repo/scripts/dev/fixtures/club-credit-destination-assertions.sql"
