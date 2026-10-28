-- Original linked hand books timed out240s scanning the complete resolution
-- relation and hashing proofs before the original recognition-window predicate.
-- A nonpartial time key permits the unchanged outcome/resolution join to start
-- from that window. It does not filter by outcome-owned Union or cover JSON.
-- ALL original full proof/evidence hashes and immutable source65 remain unchanged.
-- One maintained concurrent preamble, no new function/cache/admission/payer.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND pg_get_indexdef(i.indexrelid)='CREATE INDEX union_pnl_cash_outcomes_recognition_window ON public.union_pnl_cash_outcomes USING btree (recognized_at)' FROM pg_catalog.pg_index i WHERE i.indexrelid=to_regclass('public.union_pnl_cash_outcomes_recognition_window'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_cash_outcomes_recognition_window
 ON public.union_pnl_cash_outcomes USING btree(recognized_at);
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $linked_outcome_window_index$
DECLARE ix record;col record;op oid;n bigint;
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'linked_outcome_window_index_install_frozen';END IF;
 SELECT count(*) INTO n FROM(VALUES
  ('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)','0c3a826553e9ef65a03030c3ef78eaaf'),
  ('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)','a3b1c75ad2b122dc0b0fede8a66813c8'),
  ('smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)','97fc255997a2faeac593b5b1f5420d4c'),
  ('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)','d427fd27d163ba72a7dc3cd50866163d')
 )v(signature,hash)JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(v.signature)
 WHERE p.proowner='postgres'::regrole AND p.proacl::text='{postgres=X/postgres}'
 AND md5(pg_get_functiondef(p.oid))=v.hash;
 IF n<>4 THEN RAISE EXCEPTION 'linked_outcome_window_index_original_authority_changed';END IF;
 SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.union_pnl_cash_outcomes_recognition_window');
 IF NOT FOUND THEN RAISE EXCEPTION 'linked_outcome_window_index_missing';END IF;
 IF ix.indrelid IS DISTINCT FROM to_regclass('public.union_pnl_cash_outcomes')
 OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
 OR ix.indnkeyatts<>1 OR ix.indnatts<>1 OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
 OR EXISTS(SELECT FROM pg_catalog.pg_constraint c WHERE c.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'linked_outcome_window_index_shape_changed';END IF;
 SELECT a.attnum,a.atttypid,a.attcollation,a.attisdropped INTO col FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=ix.indrelid AND a.attname='recognized_at';
 IF col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM 'timestamptz'::regtype
 OR ix.indkey[0] IS DISTINCT FROM col.attnum THEN RAISE EXCEPTION 'linked_outcome_window_index_column_changed';END IF;
 SELECT o.oid INTO op FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace
  WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype='timestamptz'::regtype
  AND o.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree');
 IF NOT FOUND OR ix.indclass[0] IS DISTINCT FROM op OR ix.indcollation[0] IS DISTINCT FROM col.attcollation
 OR ix.indoption[0] IS DISTINCT FROM 0::smallint THEN RAISE EXCEPTION 'linked_outcome_window_index_key_changed';END IF;
END $linked_outcome_window_index$;
COMMIT;
