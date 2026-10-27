-- Whole-hand attribution proof must read every club and all six financial fields.
-- Actual86197 selected record keys use a non-covering record index and timed out
-- at30s after selection alone took13.187s. No club/horse filter is introduced.
-- Index only: no function, source pin, math, cache, permission or budget change.
-- Maintained CCI preamble: one600s build,12minutes runway, original one body.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND pg_get_indexdef(i.indexrelid)='CREATE INDEX rake_attributions_whole_hand_cover ON public.rake_attributions USING btree (rake_record_id) INCLUDE (id, hand_id, player_id, club_id, weighted_rake_credit)' FROM pg_index i WHERE i.indexrelid=to_regclass('public.rake_attributions_whole_hand_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS rake_attributions_whole_hand_cover
 ON public.rake_attributions USING btree(rake_record_id) INCLUDE(id,hand_id,player_id,club_id,weighted_rake_credit);
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $whole_hand_cover$
DECLARE ix record;col record;j int;op oid;
 names text[]:=ARRAY['rake_record_id','id','hand_id','player_id','club_id','weighted_rake_credit'];
 types oid[]:=ARRAY['uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'uuid'::regtype,'numeric'::regtype];
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'whole_hand_cover_install_frozen';END IF;
 SELECT i.*,c.relowner,c.relkind,c.relpersistence,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('public.rake_attributions_whole_hand_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'whole_hand_cover_missing';END IF;
 IF ix.indrelid IS DISTINCT FROM to_regclass('public.rake_attributions')
 OR ix.relowner<>'postgres'::regrole OR ix.relkind<>'i' OR ix.relpersistence<>'p'
 OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.indisprimary OR ix.indisexclusion OR ix.amname<>'btree'
 OR ix.indnkeyatts<>1 OR ix.indnatts<>6 OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
 OR EXISTS(SELECT FROM pg_constraint c WHERE c.conindid=ix.indexrelid)
 THEN RAISE EXCEPTION 'whole_hand_cover_shape_changed';END IF;
 FOR j IN 1..6 LOOP
  SELECT a.attnum,a.atttypid,a.attcollation,a.attisdropped INTO col FROM pg_attribute a
   WHERE a.attrelid=ix.indrelid AND a.attname=names[j];
  IF col.attnum IS NULL OR col.attisdropped OR col.atttypid IS DISTINCT FROM types[j]
   OR ix.indkey[j-1] IS DISTINCT FROM col.attnum
  THEN RAISE EXCEPTION 'whole_hand_cover_column_changed:%',names[j];END IF;
  IF j=1 THEN
   SELECT o.oid INTO op FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace
    WHERE n.nspname='pg_catalog' AND o.opcdefault AND o.opcintype=types[j]
     AND o.opcmethod=(SELECT oid FROM pg_am WHERE amname='btree');
   IF NOT FOUND OR ix.indclass[j-1] IS DISTINCT FROM op
    OR ix.indcollation[j-1] IS DISTINCT FROM col.attcollation OR ix.indoption[j-1] IS DISTINCT FROM 0::smallint
   THEN RAISE EXCEPTION 'whole_hand_cover_key_changed';END IF;
  END IF;
 END LOOP;
END $whole_hand_cover$;
COMMIT;
