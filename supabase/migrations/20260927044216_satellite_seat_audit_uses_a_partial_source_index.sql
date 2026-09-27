-- Satellite conservation reads only its source receipts.
-- Read-only production EXPLAIN on September27 selected about2919 source rows
-- via a whole rake_records sequential scan (estimated cost261560, ~3.5M rows).
-- Preserve the complete financial audit and every record. The separate online
-- partial source index avoids this scan without indexing unbounded JSONB.
-- INSTALL once: scripts/ops/build-satellite-audit-index-concurrently.sql through
-- the maintained session route, inspect its durable outcome, then record here.
-- This transaction refuses absent/invalid/wrong indexes and never builds one.
-- Existing maintenance/DDL guards remain active. No grants, settings, function,
-- predicate, receipt or accounting outcome is changed.
-- @live-proof: select indexrelid::regclass,indisvalid,indisready,indislive from pg_index where indexrelid='public.idx_rake_records_satellite_seat_source'::regclass;
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = public, pg_temp;
DO $verify$
BEGIN
  IF to_regclass('public.idx_rake_records_satellite_seat_source') IS NULL THEN
    RAISE EXCEPTION 'SATELLITE_AUDIT_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
    WHERE i.indexrelid='public.idx_rake_records_satellite_seat_source'::regclass
      AND i.indrelid='public.rake_records'::regclass
      AND ix.relkind='i' AND tab.relkind='r' AND am.amname='btree'
      AND pg_get_userbyid(ix.relowner)='postgres' AND pg_get_userbyid(tab.relowner)='postgres'
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL
      AND pg_get_indexdef(i.indexrelid,1,true)='source' AND i.indoption::text='0'
      AND i.indcollation[0]=(SELECT attcollation FROM pg_attribute WHERE attrelid=i.indrelid AND attname='source')
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='text_ops' AND opcmethod=ix.relam)
      AND pg_get_expr(i.indpred,i.indrelid)='(source = ''fn_award_satellite_seat''::text)'
  ) THEN
    RAISE EXCEPTION 'SATELLITE_AUDIT_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_satellite_conservation_audit(integer)'))) IS DISTINCT FROM '462b1c631010e4bab0361967d2da2a75' THEN
    RAISE EXCEPTION 'SATELLITE_AUDIT_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
