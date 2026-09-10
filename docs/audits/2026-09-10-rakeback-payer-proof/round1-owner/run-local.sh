#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
proof_tmp="$(mktemp -d /tmp/ca-source-funding.XXXXXX)"
proof_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$proof_share/postgres.bki" ]]; then proof_share="$PGBIN/../share/postgresql"; fi
cleanup(){ "$PGBIN/pg_ctl" -D "$proof_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
mkdir "$proof_tmp/socket"
cp -R "$HERE/vendor" "$proof_tmp/input"
fixture="$proof_tmp/input/source-authority/owner-composition"
cp "$HERE"/function-catalog-round1.json "$HERE"/table-catalog-round1.json "$fixture/"
if [[ -f "$HERE/table-catalog-capacity-extra.json" ]]; then cp "$HERE/table-catalog-capacity-extra.json" "$fixture/"; fi
if [[ -f "$HERE/function-catalog-capacity-extra.json" ]]; then cp "$HERE/function-catalog-capacity-extra.json" "$fixture/"; fi
if [[ -f "$HERE/trigger-catalog-capacity-extra.json" ]]; then cp "$HERE/trigger-catalog-capacity-extra.json" "$fixture/"; fi
"$PGBIN/initdb" -L "$proof_share" -D "$proof_tmp/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$proof_tmp/data" -l "$proof_tmp/postgres.log" -o "-h '' -k '$proof_tmp/socket' -p 55486" -w start >/dev/null
export PGHOST="$proof_tmp/socket" PGPORT=55486 PGUSER=postgres PGDATABASE=postgres COMMISSION_PSQL="$PGBIN/psql" ROUND1_INPUT="$proof_tmp/input" ROUND1_HERE="$HERE"
printf '%s\n' "$proof_tmp" > /tmp/ca-source-funding-latest
python3 "$fixture/build-fixture.py"
for stage in schema-tables schema-functions schema-defaults schema-constraints schema-foreign-keys seed; do
 "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$fixture/$stage.sql"
done
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/fixture-seed.sql"
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$fixture/schema-triggers.sql"
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$fixture/exercise.sql"
for phase in 01-schema 02-online-index 03-cutover; do "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$proof_tmp/input/$phase.sql"; done
for phase in 01-source-schema 02-capture; do "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$proof_tmp/input/source-authority/$phase.sql"; done
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$proof_tmp/input/source-authority/bank-owner/00-bank-legacy-index.sql"
python3 "$HERE/activate-fixture.py"
python3 "${ROUND1_PROBE:-$HERE/native-probe.py}"
