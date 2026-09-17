#!/usr/bin/env bash
# Private Unix-socket PostgreSQL 17 replay-only test. Accepts no database URL.
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
BIN="${POKER_AUDIT_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$ROOT/scripts/dev/fixtures/settled-bounty-replay"
MIG="$ROOT/supabase/migrations/20260914122903_settled_bounty_replay_precedes_pending_order.sql"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ca-bounty-replay.XXXXXX")"
cleanup() { "$BIN/pg_ctl" -D "$TMP/data" -m fast -w stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$BIN/postgres" --version | grep -q ' 17\.' || { echo "PostgreSQL 17 required" >&2; exit 2; }
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust --locale=en_US.UTF-8 >"$TMP/initdb.log"
mkdir -p "$TMP/sock"
"$BIN/pg_ctl" -D "$TMP/data" -o "-k $TMP/sock -c listen_addresses='' -p 55439 -c fsync=off" -l "$TMP/pg.log" -w start >/dev/null
P() { "$BIN/psql" -h "$TMP/sock" -p 55439 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
P -f "$FIX/bootstrap.sql"
P -c "SET fixture.expect_fixed=false" -f "$FIX/scenarios.sql"
P -f "$MIG"
P -c "SET fixture.expect_fixed=true" -f "$FIX/scenarios.sql"
P -f "$FIX/concurrent-setup.sql"
pids=()
for i in 1 2 3 4 5; do
  P -f "$FIX/concurrent-call.sql" >"$TMP/concurrent-$i.log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
cat "$TMP"/concurrent-*.log
P -c "SELECT fixture_assert(financial_snapshot=fixture_financial_snapshot(tournament_id),'concurrent replays preserve all financial rows') FROM fixture_concurrent_replay"
P -f "$MIG"
P -Atc "SELECT pg_get_functiondef('public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure)||';'" >"$TMP/postimage.sql"
P -c "GRANT EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb) TO authenticated"
if P -f "$MIG" >"$TMP/metadata-refusal.log" 2>&1; then
  echo 'FAIL: unreviewed privileges accepted' >&2; exit 1
fi
grep -q 'function privileges or metadata changed' "$TMP/metadata-refusal.log"
P -c "REVOKE EXECUTE ON FUNCTION public.fn_collect_bounty(uuid,uuid,uuid,jsonb) FROM authenticated"
P <<'SQL'
DO $probe$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure),
    '-- Ignore caller ordering/weights.', '-- Unreviewed source probe.');
END $probe$;
SQL
if P -f "$MIG" >"$TMP/source-refusal.log" 2>&1; then
  echo 'FAIL: unreviewed source accepted' >&2; exit 1
fi
grep -q 'unreviewed source' "$TMP/source-refusal.log"
P -f "$TMP/postimage.sql"
P -f "$MIG"
echo 'PASS: migration refuses unreviewed source and privileges'
echo "PASS: captured old failures, exact migration, repaired replay, retained refusals and migration replay"
