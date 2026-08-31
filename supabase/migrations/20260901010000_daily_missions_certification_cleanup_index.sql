-- Daily Missions Phase 7 production certification found that a player-scoped
-- lookup/delete on wallet_credit_idempotency timed out because the table only
-- indexes its text receipt key. Account lifecycle, privacy erasure, incident
-- audit, and reserved certification cleanup all address rows by user_id.
--
-- CONCURRENTLY keeps the shared money receipt table readable and writable
-- while production builds the index. This migration must not be wrapped in an
-- explicit transaction.

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_credit_idempotency_user_id
  ON public.wallet_credit_idempotency (user_id);

COMMENT ON INDEX public.idx_wallet_credit_idempotency_user_id IS
  'Bounds player-scoped receipt audit and account-lifecycle cleanup; added after a production statement timeout in Daily Missions certification.';

-- ROLLBACK (online):
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_wallet_credit_idempotency_user_id;
