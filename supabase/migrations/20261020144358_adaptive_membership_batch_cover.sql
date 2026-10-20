-- Reserved by scripts/new-migration.mjs (the reserved version is unchanged).
-- Batch retention verification reads membership by batch. The existing
-- (hand_digest,batch_key) primary key requires thousands of scattered digest
-- probes per bounded payload page. A covering batch-first index supports the
-- same exact pair membership facts with contiguous, index-only batch ranges.
-- No rows, financial rules, grants, writer functions or deadlines change.
-- Install through apply-merged-migration.yml: its supported concurrent preamble
-- runs separately, verifies VALID, then records this guarded transaction.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive FROM pg_index i WHERE i.indexrelid=to_regclass('smarter_private.horse_adaptive_membership_batch_cover'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS horse_adaptive_membership_batch_cover ON smarter_private.horse_adaptive_batch_hand_membership (batch_key, hand_digest);
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
DECLARE ix record; cols text[];
BEGIN
 SELECT i.*,c.relowner,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('smarter_private.horse_adaptive_membership_batch_cover');
 IF NOT FOUND THEN RAISE EXCEPTION 'adaptive_membership_batch_cover_missing'; END IF;
 SELECT array_agg(a.attname::text ORDER BY k.ord) INTO cols
 FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY k(attnum,ord)
 JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum;
 IF ix.indrelid<>'smarter_private.horse_adaptive_batch_hand_membership'::regclass
 OR ix.relowner<>'postgres'::regrole OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.amname<>'btree' OR ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL
 OR ix.indnkeyatts<>2 OR ix.indnatts<>2
 OR cols IS DISTINCT FROM ARRAY['batch_key','hand_digest']::text[]
 OR EXISTS(
  SELECT 1 FROM unnest(ix.indclass::oid[]) WITH ORDINALITY k(opclass,ord)
  JOIN pg_opclass op ON op.oid=k.opclass JOIN pg_am method ON method.oid=op.opcmethod
  WHERE NOT op.opcdefault OR op.opcintype<>'text'::regtype OR method.amname<>'btree')
 OR EXISTS(
  SELECT 1 FROM unnest(ix.indkey::smallint[],ix.indcollation::oid[]) k(attnum,collation_oid)
  JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum
  WHERE k.collation_oid IS DISTINCT FROM a.attcollation)
 OR EXISTS(SELECT 1 FROM unnest(ix.indoption::smallint[]) option WHERE option<>0)
 THEN RAISE EXCEPTION 'adaptive_membership_batch_cover_shape_changed'; END IF;
END $guard$;
COMMIT;
