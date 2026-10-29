#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG_BIN:-${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}}"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/Volumes/SmarterWork/agent-work}}/roster-join.XXXXXX")"
cleanup() { "$pgbin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/socket"
"$pgbin/initdb" -D "$work/data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h '' -k '$work/socket' -p 57647" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57647 -U fixture_admin -d postgres)
fixture="$repo/tests/fixtures/stats-club-scope/roster-join-sort"
migration="$repo/supabase/migrations/20261021174637_roster_club_join_date_sorting.sql"
"${psql[@]}" -f "$fixture/bootstrap.sql" -f "$fixture/page-before.sql" -f "$fixture/export-before.sql"
if "${psql[@]}" -f "$fixture/assertions.sql" > "$work/before.log" 2>&1; then echo 'Join-order regression unexpectedly passed before repair'; exit 1; fi
if ! grep -q 'Club join ordering regression' "$work/before.log"; then cat "$work/before.log"; exit 1; fi
"${psql[@]}" -f "$migration" -f "$fixture/assertions.sql"
if "${psql[@]}" -f "$migration" > "$work/replay.log" 2>&1; then echo 'Migration replay unexpectedly accepted'; exit 1; fi
if ! grep -q 'Roster join sort source preimage changed' "$work/replay.log"; then cat "$work/replay.log"; exit 1; fi
search_migration="$repo/supabase/migrations/20261029064232_player_name_search_ranks_direct_matches_before_upline.sql"
if "${psql[@]}" -f "$fixture/search-assertions.sql" > "$work/search-before.log" 2>&1; then echo 'Name-search regression unexpectedly passed before repair'; exit 1; fi
if ! grep -q 'Player name search regression' "$work/search-before.log"; then cat "$work/search-before.log"; exit 1; fi
"${psql[@]}" -f "$search_migration" -f "$fixture/search-assertions.sql" -f "$fixture/assertions.sql"
if "${psql[@]}" -f "$search_migration" > "$work/search-replay.log" 2>&1; then echo 'Search migration replay unexpectedly accepted'; exit 1; fi
if ! grep -q 'Roster name search source preimage changed' "$work/search-replay.log"; then cat "$work/search-replay.log"; exit 1; fi
echo 'ROSTER_JOIN_SORT PASS: regression, both directions, equal/null dates, three pages, search, scope, malformed/mismatched cursors, export and replay refusal'
