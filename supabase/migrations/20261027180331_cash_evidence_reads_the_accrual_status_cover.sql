-- The unchanged original cash assertion reads batch identity and status only.
-- Actual plan scans3.7m batch heap rows (~4GiB) to build the raw completeness
-- anti-join; no existing index includes both columns. Cover that exact read.
-- No function/source pin/cache, paid math, budget, data or assertion changes.
-- Maintained CCI preamble: one600s build,12minutes runway, original one body.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND pg_get_indexdef(i.indexrelid)='CREATE INDEX accounting_cash_batches_status_cover ON public.accounting_cash_accrual_batches USING btree (rake_record_id) INCLUDE (status)' AND md5(pg_get_functiondef('public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='0df1c3e9fe3e1a0e53a043baf57127d7' FROM pg_index i WHERE i.indexrelid=to_regclass('public.accounting_cash_batches_status_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_batches_status_cover
 ON public.accounting_cash_accrual_batches USING btree(rake_record_id) INCLUDE(status);
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $cash_status_cover$
DECLARE ix record;col record;j int;op oid;p pg_proc%ROWTYPE;
 names text[]:=ARRAY['rake_record_id','status'];
 types oid[]:=ARRAY['uuid'::regtype,'text'::regtype];
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'cash_status_cover_install_frozen';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='public.fn_assert_cash_commission_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM '0df1c3e9fe3e1a0e53a043baf57127d7'
 OR p.proowner<>'postgres'::regrole OR p.proacl::text<>'{postgres=X/postgres,service_role=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[] OR p.provolatile<>'s' OR NOT p.prosecdef OR p.proparallel<>'u' OR p.proisstrict
 THEN RAISE EXCEPTION 'cash_status_cover_original_owner_changed';END IF;
 SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.accounting_cash_batches_status_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'cash_status_cover_missing';END IF;
 IF ix.indrelid IS DISTINCT FROM to_regclass('public.accounting_cash_accrual_batches')
 OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
 OR ix.indnkeyatts<>1 OR ix.indnatts<>2 OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
 OR EXISTS(SELECT FROM pg_constraint c WHERE c.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'cash_status_cover_shape_changed';END IF;
 FOR j IN 1..2 LOOP
  SELECT a.attnum,a.atttypid,a.attcollation,a.attisdropped INTO col FROM pg_attribute a
   WHERE a.attrelid=ix.indrelid AND a.attname=names[j];
  IF col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM types[j]
   OR ix.indkey[j-1] IS DISTINCT FROM col.attnum
  THEN RAISE EXCEPTION 'cash_status_cover_column_changed:%',names[j];END IF;
  IF j=1 THEN
   SELECT o.oid INTO op FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace
    WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype=types[j]
     AND o.opcmethod=(SELECT oid FROM pg_am WHERE amname='btree');
   IF NOT FOUND OR ix.indclass[j-1] IS DISTINCT FROM op
    OR ix.indcollation[j-1] IS DISTINCT FROM col.attcollation OR ix.indoption[j-1] IS DISTINCT FROM 0::smallint
   THEN RAISE EXCEPTION 'cash_status_cover_key_changed';END IF;
  END IF;
 END LOOP;
END $cash_status_cover$;
COMMIT;
