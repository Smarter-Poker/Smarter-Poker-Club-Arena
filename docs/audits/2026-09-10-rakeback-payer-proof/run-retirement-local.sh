#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PAYER_BIN="/opt/homebrew/opt/postgresql@17/bin"
PAYER_TMP="$(mktemp -d /tmp/ca-rakeback-payer.XXXXXX)"
cleanup(){ "$PAYER_BIN/pg_ctl" -D "$PAYER_TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$PAYER_TMP"; }
trap cleanup EXIT
export PGHOST="$PAYER_TMP" PGPORT=55473 PGUSER=postgres PGDATABASE=payer_test
"$PAYER_BIN/initdb" -D "$PAYER_TMP/data" -U postgres -A trust >/dev/null
"$PAYER_BIN/pg_ctl" -D "$PAYER_TMP/data" -l "$PAYER_TMP/server.log" -o "-k $PAYER_TMP -p 55473 -h ''" -w start >/dev/null
"$PAYER_BIN/createdb" payer_test
"$PAYER_BIN/psql" -X -v ON_ERROR_STOP=1 -q -f "$HERE/retirement-fixture.sql"
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
node "$HERE/retirement-probe.mjs"
