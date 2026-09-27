-- One top-level statement through the maintained session route, with exact
-- source/absence/build-owner checks and the current maintenance admission.
-- Budget statement_timeout=6min, lock_timeout=180s and preserve full runway.
-- Read back durable validity after an unknown result; never replay blindly.
-- Only fixed-width UUID/time and bounded numeric columns enter this index.
-- Existing index remains until the new read plan is measured independently.
CREATE INDEX CONCURRENTLY idx_bbj_contrib_pool_facts
  ON public.bbj_contributions (pool_id, created_at)
  INCLUDE (amount, backup_portion, promo_portion);
