-- 20261020170644_adaptive_legacy_digest_probe_index
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-20 17:06:44 UTC.
--
-- Reserved by scripts/reserve-migration-version.sh; retain this version.
-- Final retirement verification spends its bounded query budget on cold
-- negative probes into the wide UNIQUE digest index. A compact int8 equality
-- index supports a hash-only LATERAL probe, followed by an exact comparison
-- with the ACTUAL stored hand_digest. Hash collisions never establish a match.
-- Keep the existing UUID primary key and UNIQUE digest index unchanged.
-- No rows, writer functions, permissions, timeouts or retention rules change.
-- The maintained installer builds this preamble concurrently, verifies VALID,
-- then executes and records the exact guarded transaction below.
-- @live-proof: (SELECT i.indisvalid AND i.indisready AND i.indislive AND pg_get_expr(i.indexprs,i.indrelid)='hashtextextended(hand_digest, (0)::bigint)' FROM pg_index i WHERE i.indexrelid=to_regclass('smarter_private.horse_adaptive_legacy_digest_probe'))
CREATE INDEX CONCURRENTLY IF NOT EXISTS horse_adaptive_legacy_digest_probe ON smarter_private.horse_adaptive_legacy_learning_purges USING btree (pg_catalog.hashtextextended(hand_digest,0));
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=pg_catalog,public,smarter_private;
DO $guard$
DECLARE ix record;
BEGIN
 SELECT i.*,c.relowner,am.amname INTO ix
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
 WHERE c.oid=to_regclass('smarter_private.horse_adaptive_legacy_digest_probe');
 IF NOT FOUND THEN RAISE EXCEPTION 'adaptive_legacy_digest_probe_missing'; END IF;
 IF ix.indrelid<>'smarter_private.horse_adaptive_legacy_learning_purges'::regclass
 OR ix.relowner<>'postgres'::regrole OR NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive
 OR ix.indisunique OR ix.amname<>'btree' OR ix.indpred IS NOT NULL
 OR ix.indnkeyatts<>1 OR ix.indnatts<>1 OR ix.indkey[0]<>0
 OR pg_get_expr(ix.indexprs,ix.indrelid) IS DISTINCT FROM 'hashtextextended(hand_digest, (0)::bigint)'
 OR ix.indcollation[0]<>0 OR ix.indoption[0]<>0
 OR NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation
  WHERE a.attrelid=ix.indrelid AND a.attname='hand_digest' AND NOT a.attisdropped
  AND a.atttypid='text'::regtype AND a.attnotnull
  AND a.attcollation='pg_catalog."default"'::regcollation AND c.collisdeterministic)
 OR NOT EXISTS(SELECT 1 FROM pg_opclass op JOIN pg_am am ON am.oid=op.opcmethod
  WHERE op.oid=ix.indclass[0] AND op.opcnamespace='pg_catalog'::regnamespace
  AND op.opcdefault AND op.opcname='int8_ops' AND op.opcintype='bigint'::regtype AND am.amname='btree')
 THEN RAISE EXCEPTION 'adaptive_legacy_digest_probe_shape_changed'; END IF;
END $guard$;
COMMIT;
