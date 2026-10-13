-- @live-proof: EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.horse_adaptive_observation_journal') AND c.relkind='r' AND c.relowner='postgres'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner) AND EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) WHERE option_name='autovacuum_vacuum_threshold' AND option_value='20000') AND EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) WHERE option_name='autovacuum_vacuum_scale_factor' AND option_value::numeric=0.02))
-- Table-only vacuum admission correction, measured on PostgreSQL 17.6.
-- 2026-10-13 15:24 UTC: 20,031,400 estimated rows, 472,600 dead tuples;
-- inherited 50 + 20% required 4,006,330 dead tuples before reclamation.
-- 20,000 + 2% admits at 420,628 for that measured size. This is an initial
-- measured trigger, not an optimal-cost or filesystem-shrink guarantee.
-- Preserve data, indexes, rights, all other storage/global settings and jobs.
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $migration$
DECLARE
  prior pg_catalog.pg_class%ROWTYPE;
  after_row pg_catalog.pg_class%ROWTYPE;
  prior_other text[];
  after_other text[];
BEGIN
  IF to_regclass('public.horse_adaptive_observation_journal') IS NULL THEN
    RAISE EXCEPTION 'HORSE_JOURNAL_VACUUM_TARGET_CHANGED';
  END IF;
  LOCK TABLE public.horse_adaptive_observation_journal IN ACCESS EXCLUSIVE MODE;
  SELECT * INTO prior FROM pg_catalog.pg_class
   WHERE oid='public.horse_adaptive_observation_journal'::regclass;
  IF prior.relkind <> 'r' OR prior.relowner <> 'postgres'::regrole
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid=prior.oid AND attname='observation_id'
         AND atttypid='text'::regtype AND attnotnull AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid=prior.oid AND attname='hand_id'
         AND atttypid='uuid'::regtype AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'HORSE_JOURNAL_VACUUM_TARGET_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_options_to_table(prior.reloptions)
    WHERE option_name IN ('autovacuum_vacuum_threshold','autovacuum_vacuum_scale_factor')) THEN
    RAISE EXCEPTION 'HORSE_JOURNAL_VACUUM_PREIMAGE_CHANGED_OR_REPLAY';
  END IF;
  SELECT array_agg(v ORDER BY v) INTO prior_other FROM unnest(prior.reloptions) v;
  ALTER TABLE public.horse_adaptive_observation_journal SET (
    autovacuum_vacuum_threshold=20000, autovacuum_vacuum_scale_factor=0.02);
  SELECT * INTO after_row FROM pg_catalog.pg_class WHERE oid=prior.oid;
  SELECT array_agg(v ORDER BY v) INTO after_other FROM unnest(after_row.reloptions) v
    WHERE split_part(v,'=',1) NOT IN ('autovacuum_vacuum_threshold','autovacuum_vacuum_scale_factor');
  IF prior_other IS DISTINCT FROM after_other
     OR prior.relowner IS DISTINCT FROM after_row.relowner
     OR prior.relacl IS DISTINCT FROM after_row.relacl
     OR prior.relrowsecurity IS DISTINCT FROM after_row.relrowsecurity
     OR prior.relforcerowsecurity IS DISTINCT FROM after_row.relforcerowsecurity
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_options_to_table(after_row.reloptions)
       WHERE option_name='autovacuum_vacuum_threshold' AND option_value='20000')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_options_to_table(after_row.reloptions)
       WHERE option_name='autovacuum_vacuum_scale_factor' AND option_value::numeric=0.02) THEN
    RAISE EXCEPTION 'HORSE_JOURNAL_VACUUM_POSTIMAGE_CHANGED';
  END IF;
END;
$migration$;
COMMIT;
