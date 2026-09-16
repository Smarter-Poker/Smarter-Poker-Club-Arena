#!/usr/bin/env bash
# Private Unix-socket PostgreSQL 17 independent table test. Accepts no database URL.
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
BIN="${POKER_AUDIT_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$ROOT/scripts/dev/fixtures/independent-pko-tables"
MIG="$ROOT/supabase/migrations/20260914123818_independent_pko_tables_preserve_head_order.sql"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ca-pko-independent.XXXXXX")"
cleanup() { "$BIN/pg_ctl" -D "$TMP/data" -m fast -w stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$BIN/postgres" --version | grep -q ' 17\.' || { echo "PostgreSQL 17 required" >&2; exit 2; }
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust --locale=en_US.UTF-8 >"$TMP/initdb.log"
mkdir -p "$TMP/sock"
"$BIN/pg_ctl" -D "$TMP/data" -o "-k $TMP/sock -c listen_addresses='' -p 55440 -c fsync=off" -l "$TMP/pg.log" -w start >/dev/null
P() { "$BIN/psql" -h "$TMP/sock" -p 55440 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
P -f "$FIX/bootstrap.sql"
P -c "SET fixture.expect_fixed=false" -f "$FIX/scenarios.sql"
P -c "SET fixture.expect_fixed=false" -f "$FIX/collector.sql"
P -f "$MIG"
P -c "SET fixture.expect_fixed=true" -f "$FIX/scenarios.sql"
P -c "SET fixture.expect_fixed=true" -f "$FIX/collector.sql"
P -f "$FIX/hostile.sql"
P -f "$FIX/concurrent-setup.sql"
pids=()
for i in 1 2 3 4 5; do
  P -f "$FIX/concurrent-call.sql" >"$TMP/concurrent-$i.log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
cat "$TMP"/concurrent-*.log
P -f "$FIX/concurrent-verify.sql"
P -f "$MIG"
P -Atc "SELECT pg_get_functiondef(oid)||';' FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fn_claim_bounty_legacy_candidate_20260907','fn_collect_bounty','fn_pko_hand_is_independent_of_later_settlements') ORDER BY proname" >"$TMP/postimages.sql"
for signature in \
  'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)' \
  'public.fn_collect_bounty(uuid,uuid,uuid,jsonb)' \
  'public.fn_pko_hand_is_independent_of_later_settlements(uuid,uuid,bigint,uuid,jsonb)'; do
  P -c "SET fixture.drift_target='$signature'" -f - <<'SQL'
DO $probe$ BEGIN
 EXECUTE replace(pg_get_functiondef(current_setting('fixture.drift_target')::regprocedure),
   'AS $function$','AS $function$'||chr(10)||'-- Unreviewed private test body'||chr(10));
END $probe$;
SQL
  if P -f "$MIG" >"$TMP/source-refusal.log" 2>&1; then
    echo 'FAIL: unreviewed source accepted' >&2; exit 1
  fi
  grep -q 'independent PKO tables refused: unreviewed' "$TMP/source-refusal.log"
  P -f "$TMP/postimages.sql"
done
P -c "GRANT EXECUTE ON FUNCTION public.fn_pko_hand_is_independent_of_later_settlements(uuid,uuid,bigint,uuid,jsonb) TO service_role"
if P -f "$MIG" >"$TMP/metadata-refusal.log" 2>&1; then
  echo 'FAIL: unreviewed predicate privileges accepted' >&2; exit 1
fi
grep -q 'unreviewed independence predicate' "$TMP/metadata-refusal.log"
P -c "REVOKE EXECUTE ON FUNCTION public.fn_pko_hand_is_independent_of_later_settlements(uuid,uuid,bigint,uuid,jsonb) FROM service_role"
P -f "$MIG"
if P -c "SET ROLE service_role" -c "SELECT public.fn_pko_hand_is_independent_of_later_settlements(NULL,NULL,NULL,NULL,NULL)" >"$TMP/private-access.log" 2>&1; then
  echo 'FAIL: service role directly invoked private predicate' >&2; exit 1
fi
grep -q 'permission denied' "$TMP/private-access.log"
echo 'PASS: all three source guards, predicate privilege guard and private execution boundary'
echo "PASS: independent-table counterexample and repaired claim/collection"
