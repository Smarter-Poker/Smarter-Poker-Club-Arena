#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
test -x "$PGBIN/initdb"
evict_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$evict_share/postgres.bki" && -f "$PGBIN/../share/postgresql/postgres.bki" ]]; then
  evict_share="$PGBIN/../share/postgresql"
fi
evict_tmp="$(mktemp -d "${TMPDIR:-/tmp}/ca-evict-retirement.XXXXXX")"
cleanup() {
  "$PGBIN/pg_ctl" -D "$evict_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$evict_tmp"
}
trap cleanup EXIT
mkdir "$evict_tmp/socket"
"$PGBIN/initdb" -L "$evict_share" -D "$evict_tmp/data" -U evict_test -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$evict_tmp/data" -l "$evict_tmp/postgres.log" \
  -o "-h '' -k '$evict_tmp/socket' -p 55445" -w start >/dev/null
evict_sql() {
 "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$evict_tmp/socket" -p 55445 -U evict_test -d postgres "$@"
}
migration="$repo/supabase/migrations/20260909045227_retire_sql_eviction_that_bypasses_the_live_hand.sql"
evict_sql -f "$repo/scripts/dev/fixtures/legacy-sql-evictor-postgres.sql" >/dev/null
evict_sql -f "$repo/scripts/dev/fixtures/legacy-sql-evictor-function.sql" >/dev/null
evict_sql <<'SQL'
DO $$
BEGIN
 IF md5(pg_get_functiondef('public.fn_evict_sitting_out_cash_players()'::regprocedure))
  <> 'edade8a266655ff341bc97bbb4cf8f0b' THEN RAISE EXCEPTION 'Baseline does not match production'; END IF;
 PERFORM fn_evict_sitting_out_cash_players();
 IF (SELECT count(*) FROM attempted_legacy_departures) <> 1 THEN
  RAISE EXCEPTION 'Baseline did not dispatch the timed seat'; END IF;
END $$;
SQL
for evict_apply in 1 2; do evict_sql --single-transaction -f "$migration" >/dev/null; done
evict_sql <<'SQL'
DO $$
BEGIN
 IF (SELECT count(*) FROM cron.job) <> 1 OR NOT EXISTS(SELECT 1 FROM cron.job WHERE jobid=999 AND active) THEN
  RAISE EXCEPTION 'Retirement affected the wrong jobs'; END IF;
 BEGIN
  PERFORM fn_evict_sitting_out_cash_players();
  RAISE EXCEPTION 'Retired owner invocation was accepted';
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM <> 'SQL_EVICTOR_RETIRED_ENGINE_OWNS_DEPARTURE' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM attempted_legacy_departures) <> 1 THEN RAISE EXCEPTION 'Retired function dispatched a departure'; END IF;
 IF has_function_privilege('anon','fn_evict_sitting_out_cash_players()','EXECUTE')
  OR has_function_privilege('authenticated','fn_evict_sitting_out_cash_players()','EXECUTE')
  OR has_function_privilege('service_role','fn_evict_sitting_out_cash_players()','EXECUTE') THEN
  RAISE EXCEPTION 'Retired function remains callable by an app role'; END IF;
END $$;
SELECT md5(pg_get_functiondef('public.fn_evict_sitting_out_cash_players()'::regprocedure)) AS retired_definition_md5;
SQL
# The cron API fixture proves transactional job selection, not scheduler execution.
evict_sql -f "$repo/scripts/dev/fixtures/legacy-sql-evictor-function.sql" >/dev/null
evict_sql -c "INSERT INTO cron.job VALUES (152,'original','SELECT public.fn_evict_sitting_out_cash_players();',true),(153,'unexpected','SELECT public.fn_evict_sitting_out_cash_players(); SELECT 2;',true)" >/dev/null
if evict_sql --single-transaction -f "$migration" >"$evict_tmp/unexpected.log" 2>&1; then
 echo 'FAIL: unexpected job command was accepted' >&2; exit 1
fi
evict_sql <<'SQL'
DO $$
BEGIN
 IF (SELECT count(*) FROM cron.job) <> 3 THEN RAISE EXCEPTION 'Rejected migration changed jobs'; END IF;
 IF md5(pg_get_functiondef('fn_evict_sitting_out_cash_players()'::regprocedure)) <> 'edade8a266655ff341bc97bbb4cf8f0b' THEN
  RAISE EXCEPTION 'Rejected migration changed function'; END IF;
END $$;
DELETE FROM cron.job WHERE jobid=153;
CREATE FUNCTION another_legacy_caller() RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM fn_evict_sitting_out_cash_players(); END $$;
SQL
if evict_sql --single-transaction -f "$migration" >"$evict_tmp/caller.log" 2>&1; then
 echo 'FAIL: unexpected SQL caller was accepted' >&2; exit 1
fi
evict_sql -c "DO \$\$ BEGIN IF (SELECT count(*) FROM cron.job) <> 2 THEN RAISE EXCEPTION 'Caller guard changed jobs'; END IF; END \$\$; DROP FUNCTION another_legacy_caller()" >/dev/null
evict_sql --single-transaction -f "$migration" >/dev/null
evict_sql -c "SELECT 'PASS: pinned baseline, retirement replay, job isolation, role/owner refusal, unknown-command and caller guards' AS result"
