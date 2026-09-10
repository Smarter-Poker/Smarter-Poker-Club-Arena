#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROUND2_BIN="/opt/homebrew/opt/postgresql@17/bin"
ROUND2_TMP="$(mktemp -d /tmp/ca-source-round2.XXXXXX)"
cleanup(){ "$ROUND2_BIN/pg_ctl" -D "$ROUND2_TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$ROUND2_TMP"; }
trap cleanup EXIT
export PGHOST="$ROUND2_TMP" PGPORT=55474 PGUSER=postgres PGDATABASE=round2_test
"$ROUND2_BIN/initdb" -D "$ROUND2_TMP/data" -U postgres -A trust >/dev/null
"$ROUND2_BIN/pg_ctl" -D "$ROUND2_TMP/data" -l "$ROUND2_TMP/server.log" -o "-k $ROUND2_TMP -p 55474 -h ''" -w start >/dev/null
"$ROUND2_BIN/createdb" round2_test
for file in fixture.sql money-guards.sql source-facts-schema-fixture.sql receipt-schema-fixture.sql union-auth-fixture.sql installed-treasury.sql source-payment-proposal.sql; do
 "$ROUND2_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/$file"
done
export PATH="/opt/homebrew/bin:$PATH"
node "$HERE/native-probe.mjs"
