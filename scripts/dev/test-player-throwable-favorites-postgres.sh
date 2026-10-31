#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:?Set TMPDIR to owned scratch}}/n.XXXXXX")"
cleanup() { "$pgbin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/s"
"$pgbin/initdb" -D "$work/data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h '' -k '$work/s' -p 57648" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/s" -p 57648 -U fixture_admin -d postgres)
"${psql[@]}" -f "$repo/tests/fixtures/player-throwable-favorites/bootstrap.sql" \
  -f "$repo/supabase/migrations/20261031003808_player_throwable_favorites_ranking.sql" \
  -f "$repo/tests/fixtures/player-throwable-favorites/assertions.sql"
echo 'PASS: personal ranking, popular defaults, ten unique valid items, anonymous refusal, private usage protected'
