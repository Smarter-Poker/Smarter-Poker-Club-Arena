-- The closed-week PNL ownership proof reads funding by tournament AND user.
-- Production EXPLAIN 2026-10-19: one original satellite lookup read 24 receipt
-- heap pages to return one row (120.548 ms). The repeated boundary proof timed
-- out in that unchanged owner reader. The existing (tournament,registration,
-- observed_at) index cannot seek its user predicate.
-- Add only the exact two UUID keys. Every funding row/status/rail remains
-- visible; no receipt, financial function, source seal, rate or deadline changes.
-- Installed through the existing concurrent-preamble provider, not a hot-table
-- SHARE lock. Recover any failed/unknown index build before retrying.
-- @live-proof: (SELECT count(*)=1 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indexprs IS NULL AND i.indpred IS NULL AND pg_get_indexdef(i.indexrelid,1,true)='tournament_id' AND pg_get_indexdef(i.indexrelid,2,true)='user_id' AND am.amname='btree' AND c.relowner='postgres'::regrole AND i.indrelid='public.tournament_participant_funding_receipts'::regclass) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE c.oid=to_regclass('public.idx_tournament_funding_tournament_user'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_funding_tournament_user
 ON public.tournament_participant_funding_receipts USING btree (tournament_id,user_id);

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE ix record;col record;pos integer:=0;key_name text;uuid_class oid;
BEGIN
 SELECT i.*,c.relowner,c.relkind,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.idx_tournament_funding_tournament_user');
 IF NOT FOUND THEN RAISE EXCEPTION 'satellite_funding_user_index_missing';END IF;
 IF ix.indrelid<>'public.tournament_participant_funding_receipts'::regclass
  OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i'
  OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
  OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion
  OR ix.indnkeyatts<>2 OR ix.indnatts<>2 OR ix.amname<>'btree'
  OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
  OR EXISTS(SELECT FROM pg_constraint con WHERE con.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'satellite_funding_user_index_shape_changed';END IF;
 SELECT o.oid INTO uuid_class FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace
 WHERE n.nspname='pg_catalog' AND o.opcname='uuid_ops' AND o.opcintype='uuid'::regtype
  AND o.opcdefault AND o.opcmethod=(SELECT oid FROM pg_am WHERE amname='btree');
 FOREACH key_name IN ARRAY ARRAY['tournament_id','user_id'] LOOP
  SELECT a.attnum,a.atttypid,a.attisdropped INTO col FROM pg_attribute a
  WHERE a.attrelid=ix.indrelid AND a.attname=key_name;
  IF NOT FOUND OR col.attisdropped OR col.atttypid<>'uuid'::regtype
   OR ix.indkey[pos] IS DISTINCT FROM col.attnum OR ix.indcollation[pos] IS DISTINCT FROM 0::oid
   OR ix.indoption[pos] IS DISTINCT FROM 0::smallint OR ix.indclass[pos] IS DISTINCT FROM uuid_class
  THEN RAISE EXCEPTION 'satellite_funding_user_index_shape_changed';END IF;
  pos:=pos+1;
 END LOOP;
END $guard$;
COMMIT;
