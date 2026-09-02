-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901191323; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Found by the probe for a_pot_in_flight_is_not_a_missing_chip: the sample
-- table keys on (tournament_id, taken_at) with DEFAULT now(), and now() is
-- the TRANSACTION timestamp -- constant for every statement in the same
-- transaction. Two calls inside one transaction therefore collide on the
-- primary key and the function raises instead of sampling.
--
-- In production the cron calls it once per transaction, ten minutes apart, so
-- this would not have fired on the happy path. That is exactly why it is
-- worth fixing: a detector whose first unusual call raises an exception is a
-- detector that goes quiet at the moment someone is investigating something.
--
-- clock_timestamp() advances within a transaction; now() does not.

ALTER TABLE public.ca_tournament_conservation_samples
  ALTER COLUMN taken_at SET DEFAULT clock_timestamp();

COMMENT ON COLUMN public.ca_tournament_conservation_samples.taken_at IS
  'clock_timestamp(), not now(): two samples taken inside one transaction must be distinguishable, or the primary key rejects the second.';

