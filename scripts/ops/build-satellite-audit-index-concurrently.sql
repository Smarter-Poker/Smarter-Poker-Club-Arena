-- One top-level statement through the maintained direct/session connection.
-- Preserve active DDL/maintenance guards and check absence/ownership first.
-- After an unknown acknowledgment inspect this operation and durable validity;
-- never blindly retry or replace an invalid index. The recording migration
-- requires exact shape/readiness and has no blocking fallback.
-- Only source is indexed: unbounded JSONB metadata stays in the heap so future
-- valid financial receipts cannot fail a new btree tuple-size restriction.
CREATE INDEX CONCURRENTLY idx_rake_records_satellite_seat_source
  ON public.rake_records USING btree (source)
  WHERE source = 'fn_award_satellite_seat';
