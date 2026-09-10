#!/usr/bin/env bash
set -euo pipefail
proposal_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
commission_tmp="$(mktemp -d "${TMPDIR:-/tmp}/ca-commission-proof.XXXXXX")"
commission_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$commission_share/postgres.bki" ]]; then commission_share="$PGBIN/../share/postgresql"; fi
cleanup() { "$PGBIN/pg_ctl" -D "$commission_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
mkdir "$commission_tmp/socket"
"$PGBIN/initdb" -L "$commission_share" -D "$commission_tmp/data" -U commission_test -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$commission_tmp/data" -l "$commission_tmp/postgres.log" -o "-h '' -k '$commission_tmp/socket' -p 55469" -w start >/dev/null
export PGHOST="$commission_tmp/socket" PGPORT=55469 PGUSER=commission_test PGDATABASE=postgres
export COMMISSION_PSQL="$PGBIN/psql"
commission_psql=("$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q)
"${commission_psql[@]}" -f "$proposal_dir/fixture.sql"
"${commission_psql[@]}" -f "$proposal_dir/live-resolver-and-calculator.sql"
"${commission_psql[@]}" -f "$proposal_dir/fixture-grants.sql"
"${commission_psql[@]}" -f "$proposal_dir/before.sql"
"${commission_psql[@]}" -f "$proposal_dir/01-schema.sql"
"${commission_psql[@]}" -f "$proposal_dir/02-online-index.sql"
"${commission_psql[@]}" -f "$proposal_dir/03-cutover.sql"
"${commission_psql[@]}" -f "$proposal_dir/assertions.sql"
python3 "$proposal_dir/parallel-probes.py"
printf 'Local PostgreSQL proposal proof complete. Cluster stopped on exit. Evidence directory: %s\n' "$commission_tmp"
