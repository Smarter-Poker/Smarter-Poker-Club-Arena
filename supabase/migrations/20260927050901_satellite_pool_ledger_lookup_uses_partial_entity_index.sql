-- Qualify the existing satellite pool-transfer lookup through a partial UUID index.
-- The installed full audit body, financial predicates and receipts are unchanged.
-- Fresh read-only internal EXPLAIN after the receipt index still costs 152927
-- in sats, with repeated scans of 71133 idempotency entries for 114 estimates.
-- Install scripts/ops/build-satellite-ledger-audit-index-concurrently.sql once
-- through the qualified session route; retain all DDL/maintenance guards and
-- inspect its durable outcome before this read-only recording transaction.
-- @live-proof: select indexrelid::regclass,indisvalid,indisready,indislive from pg_index where indexrelid='public.idx_chip_ledger_satellite_pool_from'::regclass;
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = public, pg_temp;
DO $verify$
BEGIN
  IF to_regclass('public.idx_chip_ledger_satellite_pool_from') IS NULL THEN
    RAISE EXCEPTION 'SATELLITE_LEDGER_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
    WHERE i.indexrelid='public.idx_chip_ledger_satellite_pool_from'::regclass
      AND i.indrelid='public.chip_ledger'::regclass
      AND ix.relkind='i' AND tab.relkind='r' AND am.amname='btree'
      AND pg_get_userbyid(ix.relowner)='postgres' AND pg_get_userbyid(tab.relowner)='postgres'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL
      AND pg_get_indexdef(i.indexrelid,1,true)='from_entity_id' AND i.indoption::text='0'
      AND i.indcollation[0]=(SELECT attcollation FROM pg_attribute WHERE attrelid=i.indrelid AND attname='from_entity_id')
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='uuid_ops' AND opcmethod=ix.relam)
      AND pg_get_expr(i.indpred,i.indrelid)='((from_type = ''prize_liability''::text) AND (category = ''tournament_buyin''::text))'
  ) THEN
    RAISE EXCEPTION 'SATELLITE_LEDGER_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_satellite_conservation_audit(integer)'))) IS DISTINCT FROM '462b1c631010e4bab0361967d2da2a75' THEN
    RAISE EXCEPTION 'SATELLITE_AUDIT_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
