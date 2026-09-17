#!/usr/bin/env bash
# Diagnostic only: proves the current missing-predecessor defect, not a fix.
# Private Unix-socket fixture; no production connection or provider invocation.
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
BIN="${POKER_AUDIT_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ca-pko-causal.XXXXXX")"
cleanup() { "$BIN/pg_ctl" -D "$TMP/data" -m fast -w stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$BIN/postgres" --version | grep -q ' 17\.' || { echo 'PostgreSQL 17 required' >&2; exit 2; }
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust --locale=en_US.UTF-8 >"$TMP/initdb.log"
mkdir -p "$TMP/sock"
"$BIN/pg_ctl" -D "$TMP/data" -o "-k $TMP/sock -c listen_addresses='' -p 55441 -c fsync=off" -l "$TMP/pg.log" -w start >/dev/null
P() { "$BIN/psql" -h "$TMP/sock" -p 55441 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
P -f "$ROOT/scripts/dev/fixtures/independent-pko-tables/bootstrap.sql"
P -f "$ROOT/supabase/migrations/20260914123818_independent_pko_tables_preserve_head_order.sql"
P -f - <<'SQL'
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure)<>'7891b176cdfdf8d8088c10b59240cfe3'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure)<>'64474c90007dc5a91e253d02150dc94e' THEN
  RAISE EXCEPTION 'Current production claim/collector body not reproduced';
 END IF;
END $$;
SQL
P -f "$ROOT/scripts/dev/fixtures/causal-pko-predecessors/counterexample.sql"
echo 'COUNTEREXAMPLE VERIFIED: current SQL can skip an unclaimed PKO predecessor; repair remains open.'
