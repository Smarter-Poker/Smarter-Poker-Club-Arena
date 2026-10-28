-- Original immutable hand witnesses join outcome recognition time to the
-- resolution-owned Union. The exact window41 link count costs36625: its old
-- thin time index requires21502cost of wide outcome heap reads for two scalar
-- join keys. Ordinary counts already use IndexOnlyScan; escrow is tiny.
-- Add only those two scalar INCLUDE fields to a separate nonpartial time key.
-- Keep the installed thin220709index and ALL original query/source65/function/
-- generation/permission/payment contracts unchanged. No JSON is indexed.
-- Native/current-schema proof and actual live behavior are separate receipts.
-- Maintained one bounded concurrent preamble,12minrunway/:50..03/freeze guards.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND pg_get_indexdef(i.indexrelid)='CREATE INDEX union_pnl_cash_outcomes_recognition_join_cover ON public.union_pnl_cash_outcomes USING btree (recognized_at) INCLUDE (table_id, hand_number)' FROM pg_catalog.pg_index i WHERE i.indexrelid=to_regclass('public.union_pnl_cash_outcomes_recognition_join_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_cash_outcomes_recognition_join_cover
 ON public.union_pnl_cash_outcomes USING btree(recognized_at) INCLUDE(table_id,hand_number);
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $outcome_recognition_join_cover$
DECLARE ix record;col record;op oid;n bigint;j int;
 names text[]:=ARRAY['recognized_at','table_id','hand_number'];
 types oid[]:=ARRAY['timestamptz'::regtype,'uuid'::regtype,'bigint'::regtype];
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'outcome_recognition_join_cover_install_frozen';END IF;
 SELECT count(*) INTO n FROM(VALUES
  ('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)','0c3a826553e9ef65a03030c3ef78eaaf'),
  ('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)','a3b1c75ad2b122dc0b0fede8a66813c8'),
  ('smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)','97fc255997a2faeac593b5b1f5420d4c'),
  ('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)','d427fd27d163ba72a7dc3cd50866163d')
 )v(signature,hash)JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(v.signature)
 WHERE p.proowner='postgres'::regrole AND p.proacl::text='{postgres=X/postgres}'
 AND md5(pg_get_functiondef(p.oid))=v.hash;
 IF n<>4 THEN RAISE EXCEPTION 'outcome_recognition_join_cover_original_authority_changed';END IF;
 SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.union_pnl_cash_outcomes_recognition_join_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'outcome_recognition_join_cover_missing';END IF;
 IF ix.indrelid IS DISTINCT FROM to_regclass('public.union_pnl_cash_outcomes')
 OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
 OR ix.indnkeyatts<>1 OR ix.indnatts<>3 OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
 OR EXISTS(SELECT FROM pg_catalog.pg_constraint c WHERE c.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'outcome_recognition_join_cover_shape_changed';END IF;
 FOR j IN 1..3 LOOP
 SELECT a.attnum,a.atttypid,a.attcollation,a.attisdropped INTO col FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=ix.indrelid AND a.attname=names[j];
 IF col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM types[j]
 OR ix.indkey[j-1] IS DISTINCT FROM col.attnum THEN RAISE EXCEPTION 'outcome_recognition_join_cover_column_changed:%',names[j];END IF;
 IF j=1 THEN
 SELECT o.oid INTO op FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace
  WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype='timestamptz'::regtype
  AND o.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree');
 IF NOT FOUND OR ix.indclass[0] IS DISTINCT FROM op OR ix.indcollation[0] IS DISTINCT FROM col.attcollation
 OR ix.indoption[0] IS DISTINCT FROM 0::smallint THEN RAISE EXCEPTION 'outcome_recognition_join_cover_key_changed';END IF;
 END IF;
 END LOOP;
END $outcome_recognition_join_cover$;
COMMIT;
