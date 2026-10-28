-- Original standalone foreign-certificate proof must read every original source.
-- The actual DSS zero-R3 close timed out285s in the unchanged strict helper;
-- its rawcash node scans1,328,676 required club/week heap rows, cost924648.
-- Exact original helper154b8 and both payable/effective views are UNCHANGED.
-- A natural native Index Only Scan covers all seven requested cash fields;
-- no coordinator, player, horse, positive-rake or own-source filter is added.
-- Index only: no function, source pin, math, certificate/cache/generation change.
-- Maintained CCI preamble: one600s build,12minutes runway, original one body.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND pg_get_indexdef(i.indexrelid)='CREATE INDEX accounting_cash_foreign_certificate_club_week_cover ON public.accounting_cash_rake_sources USING btree (club_id, earned_at) INCLUDE (id, player_id, rake_record_id, coordinator_union_id, rake_credit)' FROM pg_catalog.pg_index i WHERE i.indexrelid=to_regclass('public.accounting_cash_foreign_certificate_club_week_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_foreign_certificate_club_week_cover
 ON public.accounting_cash_rake_sources USING btree(club_id,earned_at) INCLUDE(id,player_id,rake_record_id,coordinator_union_id,rake_credit);
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $foreign_certificate_cash_cover$
DECLARE ix record;col record;j int;op oid;
 names text[]:=ARRAY['club_id','earned_at','id','player_id','rake_record_id','coordinator_union_id','rake_credit'];
 types oid[]:=ARRAY['uuid'::regtype,'timestamptz'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'numeric'::regtype];
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'foreign_certificate_cash_cover_install_frozen';END IF;
 SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.accounting_cash_foreign_certificate_club_week_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'foreign_certificate_cash_cover_missing';END IF;
 IF ix.indrelid IS DISTINCT FROM to_regclass('public.accounting_cash_rake_sources')
 OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
 OR ix.indnkeyatts<>2 OR ix.indnatts<>7 OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
 OR EXISTS(SELECT FROM pg_catalog.pg_constraint c WHERE c.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'foreign_certificate_cash_cover_shape_changed';END IF;
 FOR j IN 1..7 LOOP
  SELECT a.attnum,a.atttypid,a.attcollation,a.attisdropped INTO col FROM pg_catalog.pg_attribute a
   WHERE a.attrelid=ix.indrelid AND a.attname=names[j];
  IF col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM types[j]
   OR ix.indkey[j-1] IS DISTINCT FROM col.attnum
  THEN RAISE EXCEPTION 'foreign_certificate_cash_cover_column_changed:%',names[j];END IF;
  IF j<=2 THEN
   SELECT o.oid INTO op FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace
    WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype=types[j]
     AND o.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree');
   IF NOT FOUND OR ix.indclass[j-1] IS DISTINCT FROM op
    OR ix.indcollation[j-1] IS DISTINCT FROM col.attcollation OR ix.indoption[j-1] IS DISTINCT FROM 0::smallint
   THEN RAISE EXCEPTION 'foreign_certificate_cash_cover_key_changed';END IF;
  END IF;
 END LOOP;
END $foreign_certificate_cash_cover$;
COMMIT;
