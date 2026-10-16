#!/usr/bin/env bash
# Native actual-door fail-before/pass-after; isolated SSD database, no production writes.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/private-join.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/postgres.log" -o "-k $scratch -p 55588 -c listen_addresses=''" start >/dev/null
psql=("$pgbin/psql" -X -h "$scratch" -p 55588 -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-private-join.sql" >/dev/null
if "${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_denied(9);' >"$scratch/before.log" 2>&1; then
 echo 'FAIL: actual predecessor did not admit unrelated-wallet nonmember'; exit 1
fi
rg -q 'PRIVATE_JOIN_EXPOSED: seat' "$scratch/before.log"
echo 'PASS before: actual predecessor admits unrelated-wallet private nonmember (expected failure)'
"${psql[@]}" -f "$root/supabase/migrations/20261016155403_private_cash_join_requires_approved_membership.sql" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_denied(4); SELECT witness.expect_denied(9);' >/dev/null
"${psql[@]}" -c "DO \$\$ BEGIN IF EXISTS(SELECT 1 FROM table_waitlist) OR EXISTS(SELECT 1 FROM cash_game_waitlist) OR EXISTS(SELECT 1 FROM wallet_reads) THEN RAISE EXCEPTION 'denial touched a wallet or held a chair'; END IF; END \$\$;" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_allowed(1); SELECT witness.expect_allowed(2); SELECT witness.expect_allowed(3);' >/dev/null
"${psql[@]}" -c "UPDATE cash_games SET ruleset_snapshot='{}';" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_denied(9);' >/dev/null
"${psql[@]}" -c "UPDATE clubs SET is_public=true; UPDATE cash_games SET ruleset_snapshot='{\"options\":{\"is_private\":true}}';" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_denied(9);' >/dev/null
"${psql[@]}" -c "UPDATE cash_games SET ruleset_snapshot='{}';" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_allowed(9);' >/dev/null
# Replay refuses exact predecessor drift and preserves the installed definition.
"${psql[@]}" -Atc "SELECT md5(pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure))" >"$scratch/installed.md5"
if "${psql[@]}" -f "$root/supabase/migrations/20261016155403_private_cash_join_requires_approved_membership.sql" >"$scratch/replay.log" 2>&1; then
 echo 'FAIL: migration replay accepted'; exit 1
fi
rg -q 'predecessor mismatch' "$scratch/replay.log"
"${psql[@]}" -Atc "SELECT md5(pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure))" >"$scratch/after.md5"
cmp "$scratch/installed.md5" "$scratch/after.md5"
echo 'PASS after: pending/nonmember refused before wallet/hold; owner/active/approved and public accepted; replay refused unchanged'
