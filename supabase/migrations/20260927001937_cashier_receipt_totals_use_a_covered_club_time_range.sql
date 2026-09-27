-- Cashier receipt totals use a covered club/time range.
-- The September26 read-only default-week receipt aggregate needed 11,714 heap
-- visits and 2,087 read blocks, taking 3,237ms. The current index covers only
-- club/time. The new index adds only amount and directional user IDs; no
-- receipt, movement, authorization, deduplication or total semantics change.
--
-- Covering alone is insufficient: last vacuum was September18, before the
-- requested week. Native 910k-row qualification showed roughly unchanged
-- recent-page heap work before visibility maintenance, then 128 buffers vs
-- 4,248 once visible. The added index was 78.2MB in that synthetic fixture,
-- not a production size or latency promise.
--
-- Preserve PostgreSQL's existing maintenance mechanism. At measurement,
-- 118,145 inserts accumulated over 8.13days (~14.5k/day); a constant 4,000
-- insert threshold targets roughly four passes/day without racing table size.
-- 61,902 changes accumulated over 5.62days; analyze at 3,000 changes follows
-- the same measured quarter-day convention. Existing freeze/dead-tuple
-- settings, roles, money triggers and every RPC body are retained.
--
-- INSTALLATION: first complete the single online statement in
-- scripts/ops/build-cashier-totals-index-concurrently.sql through the maintained
-- direct/session route. Read back its durable catalog outcome before applying
-- this short transaction; no missing/invalid index gets a blocking fallback.
-- PostgreSQL forbids CONCURRENTLY inside BEGIN. This follows the maintained
-- snapshot-index/build-online.sql plus 20260918130650 verifying-migration route.
-- Existing hourly and entry-freeze DDL guards remain active; no override.
-- https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = public, pg_temp;
DO $preflight$
BEGIN
  IF to_regclass('public.idx_chip_tx_club_time_totals') IS NULL THEN
    RAISE EXCEPTION 'CASHIER_TOTALS_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
    WHERE i.indexrelid='public.idx_chip_tx_club_time_totals'::regclass
      AND i.indrelid='public.chip_transactions'::regclass
      AND ix.relkind='i' AND tab.relkind='r' AND am.amname='btree'
      AND pg_get_userbyid(ix.relowner)='postgres' AND pg_get_userbyid(tab.relowner)='postgres'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=2 AND i.indnatts=5
      AND pg_get_indexdef(i.indexrelid,1,true)='club_id'
      AND pg_get_indexdef(i.indexrelid,2,true)='created_at'
      AND pg_get_indexdef(i.indexrelid,3,true)='amount'
      AND pg_get_indexdef(i.indexrelid,4,true)='from_user_id'
      AND pg_get_indexdef(i.indexrelid,5,true)='to_user_id'
      AND i.indoption::text='0 3' AND i.indcollation::text='0 0'
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='uuid_ops' AND opcmethod=ix.relam)
      AND i.indclass[1]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='timestamptz_ops' AND opcmethod=ix.relam)
  ) THEN
    RAISE EXCEPTION 'CASHIER_TOTALS_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef((SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_cashier_statement_rows'))) IS DISTINCT FROM 'd6152f4bb944489aa4e1dfaf5417fc00' THEN
    RAISE EXCEPTION 'cashier read source drift: fn_cashier_statement_rows';
  END IF;
  IF md5(pg_get_functiondef((SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_cashier_statement_totals'))) IS DISTINCT FROM '5e50033127ded658f0bb4de87e0a10e6' THEN
    RAISE EXCEPTION 'cashier read source drift: fn_cashier_statement_totals';
  END IF;
  IF md5(pg_get_functiondef((SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_cashier_statement_scope'))) IS DISTINCT FROM '5c3180605b76db07957f261b39914f8d' THEN
    RAISE EXCEPTION 'cashier read source drift: fn_cashier_statement_scope';
  END IF;
END
$preflight$;
ALTER TABLE public.chip_transactions SET (
  autovacuum_vacuum_insert_scale_factor = 0,
  autovacuum_vacuum_insert_threshold = 4000,
  autovacuum_analyze_scale_factor = 0,
  autovacuum_analyze_threshold = 3000
);
-- The exact index was verified before the only ALTER. This does not change
-- function definitions, privileges, policies, triggers or financial records.
COMMIT;
