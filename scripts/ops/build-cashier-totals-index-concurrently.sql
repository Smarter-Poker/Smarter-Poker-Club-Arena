-- ONE top-level statement through the maintained direct/session connection.
-- Not a transaction, Management API batch, scheduler, or retry loop.
-- Read current guard, source hashes, absence and operation owner first.
-- A valid exact index means reuse; an invalid index or unknown acknowledgment
-- requires inspection of the SAME operation before any deliberate cleanup.
-- The short recording migration verifies exact shape/owner/readiness and never
-- falls back to a blocking build. No financial or authorization predicates change.
CREATE INDEX CONCURRENTLY idx_chip_tx_club_time_totals
  ON public.chip_transactions USING btree (club_id, created_at DESC)
  INCLUDE (amount, from_user_id, to_user_id);
