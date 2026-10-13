-- @live-proof: EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_class t ON t.oid=c.reltoastrelid WHERE c.oid=to_regclass('public.cash_hand_provenance_receipts') AND c.relkind='r' AND t.relkind='t' AND c.relowner='postgres'::regrole AND t.relowner=c.relowner AND c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee NOT IN (c.relowner,'service_role'::regrole) OR (a.grantee='service_role'::regrole AND a.privilege_type<>'SELECT')) AND c.reloptions @> ARRAY['autovacuum_vacuum_threshold=20000','autovacuum_vacuum_scale_factor=0.02'] AND t.reloptions @> ARRAY['autovacuum_vacuum_threshold=20000','autovacuum_vacuum_scale_factor=0.01'])
-- Measured original cash compaction vacuum admission, PostgreSQL 17.6.
-- 2026-10-13 16:46 UTC: parent4070100/dead146942; TOAST25818300/dead538658.
-- Default20% waits for814070/5163710 dead tuples. New20k+2% parent
-- admits101402; new20k+1% TOAST admits278183. Initial measured thresholds,
-- not optimal-I/O or filesystem-shrink promises. All other state is preserved.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $migration$
DECLARE
  prior pg_catalog.pg_class%ROWTYPE;
  toast_prior pg_catalog.pg_class%ROWTYPE;
  after_row pg_catalog.pg_class%ROWTYPE;
  toast_after pg_catalog.pg_class%ROWTYPE;
  prior_other text[]; after_other text[];
BEGIN
  IF to_regclass('public.cash_hand_provenance_receipts') IS NULL THEN
    RAISE EXCEPTION 'CASH_VACUUM_TARGET_CHANGED';
  END IF;
  -- PG17 storage-option lock mode; ordinary readers/writers remain compatible.
  LOCK TABLE public.cash_hand_provenance_receipts IN SHARE UPDATE EXCLUSIVE MODE;
  SELECT * INTO prior FROM pg_catalog.pg_class
    WHERE oid='public.cash_hand_provenance_receipts'::regclass;
  SELECT * INTO toast_prior FROM pg_catalog.pg_class WHERE oid=prior.reltoastrelid;
  IF prior.relkind<>'r' OR prior.relowner<>'postgres'::regrole
     OR toast_prior.oid IS NULL OR toast_prior.relkind<>'t'
     OR toast_prior.relowner<>prior.relowner
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=prior.oid
       AND attname='accepted_request' AND atttypid='jsonb'::regtype AND attnotnull AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=prior.oid
       AND attname='hand_id' AND atttypid='uuid'::regtype AND attnotnull AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=prior.oid
       AND attname='payload_hash' AND atttypid='text'::regtype AND attnotnull AND NOT attisdropped) THEN
    RAISE EXCEPTION 'CASH_VACUUM_TARGET_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_options_to_table(prior.reloptions)
       WHERE option_name IN ('autovacuum_vacuum_threshold','autovacuum_vacuum_scale_factor'))
     OR EXISTS (SELECT 1 FROM pg_options_to_table(toast_prior.reloptions)
       WHERE option_name IN ('autovacuum_vacuum_threshold','autovacuum_vacuum_scale_factor')) THEN
    RAISE EXCEPTION 'CASH_VACUUM_PREIMAGE_CHANGED_OR_REPLAY';
  END IF;
  ALTER TABLE public.cash_hand_provenance_receipts SET (
    autovacuum_vacuum_threshold=20000,autovacuum_vacuum_scale_factor=0.02,
    toast.autovacuum_vacuum_threshold=20000,toast.autovacuum_vacuum_scale_factor=0.01);
  SELECT * INTO after_row FROM pg_catalog.pg_class WHERE oid=prior.oid;
  SELECT * INTO toast_after FROM pg_catalog.pg_class WHERE oid=prior.reltoastrelid;
  FOR prior_other,after_other IN
    SELECT (SELECT array_agg(v ORDER BY v) FROM unnest(before_options) v),
      (SELECT array_agg(v ORDER BY v) FROM unnest(after_options) v
       WHERE split_part(v,'=',1) NOT IN ('autovacuum_vacuum_threshold','autovacuum_vacuum_scale_factor'))
    FROM (VALUES(prior.reloptions,after_row.reloptions),
      (toast_prior.reloptions,toast_after.reloptions)) s(before_options,after_options)
  LOOP
    IF prior_other IS DISTINCT FROM after_other THEN
      RAISE EXCEPTION 'CASH_VACUUM_OTHER_OPTIONS_CHANGED';
    END IF;
  END LOOP;
  IF (to_jsonb(prior)-'reloptions') IS DISTINCT FROM (to_jsonb(after_row)-'reloptions')
     OR (to_jsonb(toast_prior)-'reloptions') IS DISTINCT FROM (to_jsonb(toast_after)-'reloptions')
     OR NOT(after_row.reloptions @> ARRAY['autovacuum_vacuum_threshold=20000','autovacuum_vacuum_scale_factor=0.02'])
     OR NOT(toast_after.reloptions @> ARRAY['autovacuum_vacuum_threshold=20000','autovacuum_vacuum_scale_factor=0.01']) THEN
    RAISE EXCEPTION 'CASH_VACUUM_POSTIMAGE_CHANGED';
  END IF;
END;
$migration$;
COMMIT;
