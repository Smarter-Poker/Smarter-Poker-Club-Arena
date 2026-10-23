-- Reserved by scripts/new-migration.mjs; retain this version.
-- Final retirement verification reads actual observation_id, hand_id and
-- observed_at_ms. No existing index covers all three, so it scans a bloated
-- 25.8GB journal heap inside a strictly bounded read-only snapshot.
-- Add only a non-unique metadata covering index; retain the primary key,
-- retention and scope indexes, rows, RLS, writers and all financial rules.
-- The maintained ingestion decoder and append RPC admit UUID:ordinal IDs
-- (ordinal0..4095, at most41 ASCII bytes). UUID and bigint payloads are fixed
-- width; no JSON/payload text is indexed and no new identity constraint is added.
-- Arbitrarily oversized direct IDs are not silently filtered: an index-build
-- failure must be inspected through its exact owning operation, never retried.
-- Index-only visibility and production runtime still require actual readback;
-- this migration does not claim a heap-free scan or a completed global proof.
-- The existing installer sends this concurrent preamble alone, checks VALID,
-- then records the exact guarded transaction. No new installation route.
-- @live-proof: EXISTS( SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=x.relam WHERE x.oid=to_regclass('public.horse_adaptive_journal_metadata_cover') AND i.indrelid='public.horse_adaptive_observation_journal'::regclass AND x.relowner='postgres'::regrole AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND am.amname='btree' AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnkeyatts=1 AND i.indnatts=3 AND i.indoption[0]=0 AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey::smallint[])WITH ORDINALITY k(attnum,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) IS NOT DISTINCT FROM ARRAY['observation_id','hand_id','observed_at_ms']::text[] AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=i.indrelid AND a.attname='observation_id' AND NOT a.attisdropped AND a.atttypid='text'::regtype AND a.attnotnull AND i.indcollation[0]=a.attcollation) AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=i.indrelid AND a.attname='hand_id' AND NOT a.attisdropped AND a.atttypid='uuid'::regtype AND a.attnotnull) AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=i.indrelid AND a.attname='observed_at_ms' AND NOT a.attisdropped AND a.atttypid='bigint'::regtype AND a.attnotnull) AND EXISTS(SELECT 1 FROM pg_catalog.pg_opclass op JOIN pg_catalog.pg_am method ON method.oid=op.opcmethod WHERE op.oid=i.indclass[0] AND op.opcnamespace='pg_catalog'::regnamespace AND op.opcname='text_ops' AND op.opcdefault AND op.opcintype='text'::regtype AND method.amname='btree') AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_index pk ON pk.indexrelid=c.conindid WHERE c.conrelid=i.indrelid AND c.contype='p' AND pk.indisvalid AND pk.indisready AND pk.indislive AND pk.indisunique AND pk.indnkeyatts=1 AND pk.indkey[0]=(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=i.indrelid AND attname='observation_id')) )
CREATE INDEX CONCURRENTLY IF NOT EXISTS horse_adaptive_journal_metadata_cover
 ON public.horse_adaptive_observation_journal USING btree(observation_id)
 INCLUDE(hand_id,observed_at_ms);
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=pg_catalog,public;
DO $guard$ BEGIN
 IF NOT EXISTS(
 SELECT 1 FROM pg_catalog.pg_index i
 JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
 JOIN pg_catalog.pg_am am ON am.oid=x.relam
 WHERE x.oid=to_regclass('public.horse_adaptive_journal_metadata_cover')
 AND i.indrelid='public.horse_adaptive_observation_journal'::regclass
 AND x.relowner='postgres'::regrole AND i.indisvalid AND i.indisready AND i.indislive
 AND NOT i.indisunique AND am.amname='btree'
 AND i.indexprs IS NULL AND i.indpred IS NULL
 AND i.indnkeyatts=1 AND i.indnatts=3 AND i.indoption[0]=0
 AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
  FROM unnest(i.indkey::smallint[])WITH ORDINALITY k(attnum,ord)
  JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)
  IS NOT DISTINCT FROM ARRAY['observation_id','hand_id','observed_at_ms']::text[]
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=i.indrelid AND a.attname='observation_id' AND NOT a.attisdropped
  AND a.atttypid='text'::regtype AND a.attnotnull AND i.indcollation[0]=a.attcollation)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=i.indrelid AND a.attname='hand_id' AND NOT a.attisdropped
  AND a.atttypid='uuid'::regtype AND a.attnotnull)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=i.indrelid AND a.attname='observed_at_ms' AND NOT a.attisdropped
  AND a.atttypid='bigint'::regtype AND a.attnotnull)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_opclass op
  JOIN pg_catalog.pg_am method ON method.oid=op.opcmethod
  WHERE op.oid=i.indclass[0] AND op.opcnamespace='pg_catalog'::regnamespace
  AND op.opcname='text_ops' AND op.opcdefault AND op.opcintype='text'::regtype AND method.amname='btree')
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_index pk ON pk.indexrelid=c.conindid
  WHERE c.conrelid=i.indrelid AND c.contype='p' AND pk.indisvalid AND pk.indisready AND pk.indislive
  AND pk.indisunique AND pk.indnkeyatts=1
  AND pk.indkey[0]=(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=i.indrelid AND attname='observation_id'))
) THEN
  RAISE EXCEPTION 'adaptive_journal_metadata_cover_shape_changed';
 END IF;
END $guard$;
COMMIT;
