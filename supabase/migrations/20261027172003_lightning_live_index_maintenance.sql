-- Lightning's tiny live-state indexes must not wait for the full historical
-- table's default 20% dead-tuple threshold. On 2026-10-27, 98,570 dead rows
-- remained below that ~139k threshold. A live lookup returned eight instances
-- after 7,125 buffers; online VACUUM reduced the same query 268.415 ->12.592ms
-- (7,181 ->767 total hits), with no logical row or money changes.
-- After that vacuum, 7,776 dead tuples accumulated in 21.6 minutes (~360/min).
-- A fixed 1,000-dead threshold makes PostgreSQL's existing worker eligible
-- around three minutes at that measured rate instead of ~6.4 hours at 139k.
-- Eligibility is not a guaranteed execution time. Keep cost, freeze, retention,
-- insert thresholds, ACLs and all financial definitions unchanged. No new job.
-- @live-proof: (SELECT count(*)=2 FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.lightning_instance'::regclass)) WHERE (option_name='autovacuum_vacuum_scale_factor' AND option_value='0') OR (option_name='autovacuum_vacuum_threshold' AND option_value='1000'))
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $maintain$
DECLARE before_options jsonb; after_options jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(option_name,option_value),'{}'::jsonb)
  INTO before_options FROM pg_options_to_table(
    (SELECT reloptions FROM pg_class WHERE oid='public.lightning_instance'::regclass));
  IF before_options ? 'autovacuum_vacuum_scale_factor'
     OR before_options ? 'autovacuum_vacuum_threshold'
     OR before_options->>'autovacuum_enabled' = 'false' THEN
    RAISE EXCEPTION 'LIGHTNING_MAINTENANCE_PREIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
  ALTER TABLE public.lightning_instance SET (
    autovacuum_vacuum_scale_factor=0,
    autovacuum_vacuum_threshold=1000
  );
  SELECT jsonb_object_agg(option_name,option_value) INTO after_options
  FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid='public.lightning_instance'::regclass));
  IF after_options IS DISTINCT FROM before_options ||
    '{"autovacuum_vacuum_scale_factor":"0","autovacuum_vacuum_threshold":"1000"}'::jsonb THEN
    RAISE EXCEPTION 'LIGHTNING_MAINTENANCE_POSTIMAGE_CHANGED';
  END IF;
END
$maintain$;
COMMIT;
