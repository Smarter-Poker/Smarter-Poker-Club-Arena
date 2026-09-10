#!/usr/bin/env bash
set -euo pipefail
fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../owner-composition" && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
proof_tmp="$(mktemp -d "${TMPDIR:-/tmp}/ca-bank-owner-proof.XXXXXX")"
proof_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$proof_share/postgres.bki" ]]; then proof_share="$PGBIN/../share/postgresql"; fi
cleanup() { "$PGBIN/pg_ctl" -D "$proof_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true; if [[ -f "$proof_tmp/data/PG_VERSION" && ! -f "$proof_tmp/data/postmaster.pid" ]]; then rm -rf -- "$proof_tmp/data"; fi; }
trap cleanup EXIT
mkdir "$proof_tmp/socket"
"$PGBIN/initdb" -L "$proof_share" -D "$proof_tmp/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$proof_tmp/data" -l "$proof_tmp/postgres.log" -o "-h '' -k '$proof_tmp/socket' -p 55480" -w start >/dev/null
export PGHOST="$proof_tmp/socket" PGPORT=55480 PGUSER=postgres PGDATABASE=postgres COMMISSION_PSQL="$PGBIN/psql"
printf '%s\n' "$proof_tmp" > /tmp/ca-bank-owner-proof-latest
python3 "$fixture_dir/build-fixture.py"
for stage in schema-tables schema-functions schema-defaults schema-constraints schema-foreign-keys seed schema-triggers; do
 printf 'Loading %s\n' "$stage"
 "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$fixture_dir/$stage.sql"
done
if [[ -f "$fixture_dir/exercise.sql" ]]; then "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -f "$fixture_dir/exercise.sql"; fi
source_dir="$(dirname "$fixture_dir")"
proposal_dir="$(dirname "$source_dir")"
for phase in 01-schema 02-online-index 03-cutover; do
 "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$proposal_dir/$phase.sql"
done
for phase in 01-source-schema 02-capture; do
 "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$source_dir/$phase.sql"
done
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$fixture_dir/../bank-owner/00-bank-legacy-index.sql"
"$PGBIN/createdb" -T "$PGDATABASE" bank_overlap
"$PGBIN/createdb" -T "$PGDATABASE" bank_legacy_union
"$PGBIN/createdb" -T "$PGDATABASE" bank_legacy_club
python3 "$fixture_dir/../bank-owner/native-probe.py"
PGDATABASE=bank_overlap python3 "$fixture_dir/../bank-owner/overlap.py"
PGDATABASE=bank_legacy_union BANK_LEGACY_ROUTE=union_to_club python3 "$fixture_dir/../bank-owner/legacy-overlap.py"
PGDATABASE=bank_legacy_club BANK_LEGACY_ROUTE=club_to_union python3 "$fixture_dir/../bank-owner/legacy-overlap.py"
python3 "$fixture_dir/../bank-owner/build-proof-manifest.py"
printf 'Native Fixture Loaded: %s\n' "$proof_tmp"
