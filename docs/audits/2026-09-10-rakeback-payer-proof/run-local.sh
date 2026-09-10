#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PAYER_MODE=before
if [ "$#" -gt 0 ]; then PAYER_MODE="$1"; fi
PAYER_BIN="/opt/homebrew/opt/postgresql@17/bin"
PAYER_TMP="$(mktemp -d /tmp/ca-rakeback-payer.XXXXXX)"
cleanup(){ "$PAYER_BIN/pg_ctl" -D "$PAYER_TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$PAYER_TMP"; }
trap cleanup EXIT
export PGHOST="$PAYER_TMP" PGPORT=55473 PGUSER=postgres PGDATABASE=payer_test
"$PAYER_BIN/initdb" -D "$PAYER_TMP/data" -U postgres -A trust >/dev/null
"$PAYER_BIN/pg_ctl" -D "$PAYER_TMP/data" -l "$PAYER_TMP/server.log" -o "-k $PAYER_TMP -p 55473 -h ''" -w start >/dev/null
"$PAYER_BIN/createdb" payer_test
"$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/fixture.sql"
if [ "$PAYER_MODE" = guards ] || [ "$PAYER_MODE" = source ] || [ "$PAYER_MODE" = cascade ]; then "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/money-guards.sql"; fi
if [ "$PAYER_MODE" = after ]; then "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/correction.sql"; fi
if [ "$PAYER_MODE" = source ] || [ "$PAYER_MODE" = cascade ]; then
 "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/source-facts-schema-fixture.sql"
 "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/source-payer-proposal.sql"
 "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/source-payer-wrappers.sql"
 "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/union-auth-fixture.sql"
fi
if [ "$PAYER_MODE" = cascade ]; then
 "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/union-cascade-control-fixture.sql"
 "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/union-cascade-installed.sql"
 "$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/union-cascade-source-boundary.sql"
fi
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
if [ "$PAYER_MODE" = cascade ]; then node "$HERE/union-cascade-control-probe.mjs"; elif [ "$PAYER_MODE" = source ]; then node "$HERE/source-payer-probe.mjs"; elif [ "$PAYER_MODE" = retirement ]; then node "$HERE/retirement-probe.mjs"; else node "$HERE/probe.mjs" "$PAYER_MODE"; fi
