-- The jackpot facts query scanned the307MB contribution heap and exceeded an
-- 8s production read budget on2026-09-27. Verify the separately installed online
-- covering index; retain both RPC bodies, ACLs, accounting, rows and RLS.
-- INSTALL scripts/ops/build-bbj-contribution-cover-concurrently.sql ONCE via
-- the maintained session route before this short verification transaction.
-- Never fall back to a blocking index build or replay an unknown operation.
-- @live-proof: select indisvalid,indisready,indislive from pg_index where indexrelid='public.idx_bbj_contrib_pool_facts'::regclass;
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='8s';
DO $verify$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
  JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
  WHERE i.indexrelid=to_regclass('public.idx_bbj_contrib_pool_facts')
  AND i.indrelid='public.bbj_contributions'::regclass
  AND ix.relkind='i' AND t.relkind='r' AND am.amname='btree'
  AND pg_get_userbyid(ix.relowner)='postgres' AND pg_get_userbyid(t.relowner)='postgres'
  AND i.indisvalid AND i.indisready AND i.indislive
  AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
  AND i.indnkeyatts=2 AND i.indnatts=5 AND i.indexprs IS NULL AND i.indpred IS NULL
  AND i.indoption::text='0 0'
  AND ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true) FROM generate_series(1,5)n)
      =ARRAY['pool_id','created_at','amount','backup_portion','promo_portion']
  AND i.indcollation::text='0 0'
  AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='uuid_ops' AND opcmethod=ix.relam)
  AND i.indclass[1]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='timestamptz_ops' AND opcmethod=ix.relam)
 ) THEN RAISE EXCEPTION 'BBJ_CONTRIBUTION_INDEX_NOT_QUALIFIED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES ('amount','numeric(14,2)'),('backup_portion','numeric(10,4)'),('promo_portion','numeric(10,4)')) e(col,typ)
   LEFT JOIN pg_attribute a ON a.attrelid='public.bbj_contributions'::regclass AND a.attname=e.col
   WHERE a.attnum IS NULL OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM e.typ)
 THEN RAISE EXCEPTION 'BBJ_CONTRIBUTION_COLUMN_CONTRACT_CHANGED' USING ERRCODE='55000'; END IF;
 IF md5(pg_get_functiondef('public.fn_bbj_pool_facts(uuid)'::regprocedure)) IS DISTINCT FROM 'cbaccc1e155abb94d44e956185f7c296'
 OR md5(pg_get_functiondef('public.fn_bbj_promo_facts(uuid)'::regprocedure)) IS DISTINCT FROM '91d4875621299c2af678081bfa3c84e7'
 THEN RAISE EXCEPTION 'BBJ_FACTS_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
END $verify$;
COMMIT;
