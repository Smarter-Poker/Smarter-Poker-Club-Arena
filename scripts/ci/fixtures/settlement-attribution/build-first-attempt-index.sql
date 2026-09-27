-- Single top-level online build through the maintained TLS session route.
-- PostgreSQL forbids CONCURRENTLY inside a transaction. Do not send through
-- the bounded Management API, wrap in BEGIN, or automatically retry.
-- Check the current DDL/freeze guard, function preimage and index absence first.
-- A valid exact index is reused. Unknown/invalid outcomes must be read back
-- against the original session before deliberate qualified recovery.
SET lock_timeout='180s';
SET statement_timeout='6min';
CREATE INDEX CONCURRENTLY idx_settlement_idem_first_attempt
  ON public.settlement_idempotency_keys USING btree (first_attempt_at);
