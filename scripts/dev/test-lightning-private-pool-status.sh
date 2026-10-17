#!/usr/bin/env bash
# Actual metadata reader, isolated native PostgreSQL only; never a production probe.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ]; then
 case ${TMPDIR:-} in /Volumes/SmarterWork/agent-work/*) ;; *) echo 'SSD TMPDIR required'; exit 1;; esac
fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/private-pool-status.XXXXXX")
cleanup() { "$pgbin/pg_ctl" -D "$scratch/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$scratch/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$scratch/db" -l "$scratch/postgres.log" -o "-k $scratch -p 55589 -c listen_addresses=''" start >/dev/null
psql=("$pgbin/psql" -X -h "$scratch" -p 55589 -d postgres -v ON_ERROR_STOP=1)
migration="$root/supabase/migrations/20261016172602_private_lightning_pool_status_requires_approved_membership.sql"
"${psql[@]}" -f "$root/scripts/dev/fixtures/lightning-private-pool-status.sql" >/dev/null
before_exposed() {
 if "${psql[@]}" -c "SET ROLE authenticated; SELECT witness.expect_hidden($1);" >"$scratch/before-$1.log" 2>&1; then
  echo 'FAIL: predecessor did not reproduce private metadata leak'; exit 1
 fi
 grep -q 'PRIVATE_METADATA_EXPOSED' "$scratch/before-$1.log"
}
before_exposed 4
"${psql[@]}" -c "UPDATE cash_games SET ruleset_snapshot='{}';" >/dev/null
before_exposed 9
"${psql[@]}" -c "UPDATE clubs SET is_public=true; UPDATE cash_games SET ruleset_snapshot=jsonb_build_object('options',jsonb_build_object('is_private',true));" >/dev/null
before_exposed 4
"${psql[@]}" -c 'UPDATE clubs SET is_public=false;' >/dev/null
echo 'PASS before: full actual predecessor exposes pending/private-game and private-club-only outsider metadata'
# A wrong predecessor must fail atomically without changing even its volatility.
"${psql[@]}" -c 'ALTER FUNCTION fn_lightning_pool_status(uuid) IMMUTABLE;' >/dev/null
"${psql[@]}" -Atc "SELECT md5(pg_get_functiondef('fn_lightning_pool_status(uuid)'::regprocedure))" >"$scratch/wrong.md5"
if "${psql[@]}" -f "$migration" >"$scratch/wrong.log" 2>&1; then echo 'FAIL: wrong predecessor accepted'; exit 1; fi
grep -q 'predecessor mismatch' "$scratch/wrong.log"
"${psql[@]}" -Atc "SELECT md5(pg_get_functiondef('fn_lightning_pool_status(uuid)'::regprocedure))" >"$scratch/wrong-after.md5"
cmp "$scratch/wrong.md5" "$scratch/wrong-after.md5"
"${psql[@]}" -c 'ALTER FUNCTION fn_lightning_pool_status(uuid) STABLE;' >/dev/null
"${psql[@]}" -f "$migration" >/dev/null
for actor in 0 4 5 6 7 8 9; do "${psql[@]}" -c "SET ROLE authenticated; SELECT witness.expect_hidden($actor);" >/dev/null; done
for actor in 1 2 3; do "${psql[@]}" -c "SET ROLE authenticated; SELECT witness.expect_visible($actor);" >/dev/null; done
# Owner need not hold a membership; service caller need not hold a user identity.
"${psql[@]}" -c "SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false); SELECT witness.expect_visible(0);" >/dev/null
"${psql[@]}" -c "UPDATE cash_games SET ruleset_snapshot='{}';" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_hidden(9);' >/dev/null
"${psql[@]}" -c "UPDATE clubs SET is_public=true; UPDATE cash_games SET ruleset_snapshot=jsonb_build_object('options',jsonb_build_object('is_private',true));" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_hidden(4); SELECT witness.expect_hidden(9);' >/dev/null
"${psql[@]}" -c "UPDATE cash_games SET ruleset_snapshot='{}';" >/dev/null
"${psql[@]}" -c 'SET ROLE authenticated; SELECT witness.expect_visible(9); SELECT witness.expect_visible(4);' >/dev/null
"${psql[@]}" -c "DO \$\$ BEGIN IF EXISTS((SELECT proowner,proacl,prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='fn_lightning_pool_status(uuid)'::regprocedure) EXCEPT SELECT * FROM witness.catalog_before) THEN RAISE EXCEPTION 'owner ACL volatility security or search path changed'; END IF; END \$\$;" >/dev/null
"${psql[@]}" -Atc "SELECT md5(pg_get_functiondef('fn_lightning_pool_status(uuid)'::regprocedure))" >"$scratch/installed.md5"
if "${psql[@]}" -f "$migration" >"$scratch/replay.log" 2>&1; then echo 'FAIL: installed migration replay accepted'; exit 1; fi
grep -q 'predecessor mismatch' "$scratch/replay.log"
"${psql[@]}" -Atc "SELECT md5(pg_get_functiondef('fn_lightning_pool_status(uuid)'::regprocedure))" >"$scratch/replay-after.md5"
cmp "$scratch/installed.md5" "$scratch/replay-after.md5"
echo "PASS after: owner/active/approved/public/service; pending/removed/banned/suspended/null/outsider denied; all output/own-session fields and ACL preserved; wrong predecessor/replay refused atomically (definition $(cat "$scratch/installed.md5"))"
