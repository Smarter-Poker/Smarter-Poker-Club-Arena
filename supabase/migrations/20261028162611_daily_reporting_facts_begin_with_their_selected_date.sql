CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_club_data_fact_day_idx
 ON public.ca_club_data_fact(stat_date);
-- Version reserved by the maintained generator.
-- The failed original reporting rollup materializes one stat_date before its
-- aggregates. Production planned a parallel full scan of 2.28m historical
-- facts: the existing primary key starts with club_id. Bound that input by
-- its actual date predicate, without changing any query or accounting rule.
-- Keep mutable amounts outside the index so amount-only updates remain HOT
-- eligible. Concurrent construction does not take a writer-blocking lock.
-- @live-proof: EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.ca_club_data_fact_day_idx') AND indisvalid AND indisready)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $index$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.ca_club_data_fact_day_idx') AND indisvalid AND indisready)
 OR pg_get_indexdef('public.ca_club_data_fact_day_idx'::regclass) IS DISTINCT FROM
 'CREATE INDEX ca_club_data_fact_day_idx ON public.ca_club_data_fact USING btree (stat_date)' THEN
 RAISE EXCEPTION 'daily fact read index differs from qualified definition';
 END IF;
END $index$;
COMMIT;
