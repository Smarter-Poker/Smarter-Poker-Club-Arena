#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/l5.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/log" -o "-k $scratch -p 55619 -c listen_addresses=''" start >/dev/null
psql=("$pgbin/psql" -X -q -h "$scratch" -p 55619 -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-five-ready-schema.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-five-ready-group-preimage.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-five-ready-preimages.sql"
# Reproduce the old short-handed fallback using the exact installed helper.
"${psql[@]}" -c "DO \$\$ BEGIN IF fn_lightning_formation_sizes(2,2,6,6,now()-interval '3 seconds',now())<>ARRAY[2] THEN RAISE EXCEPTION 'predecessor defect not reproduced'; END IF; END \$\$;"
"${psql[@]}" -f "$root/supabase/migrations/20261023230001_classic_and_lightning_five_ready_waits_three_seconds_for_six.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-five-ready-assert.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-five-ready-flow.sql"
echo 'PASS: source-bound Classic/Lightning transition; fifth-ready deadline; five/six dealing barrier; no under-five hands'
