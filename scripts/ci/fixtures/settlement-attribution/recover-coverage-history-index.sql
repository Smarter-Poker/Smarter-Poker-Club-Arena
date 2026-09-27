-- Only after exact same-target invalid-index and zero-active-builder readback.
-- One bounded explicit recovery, never a retry loop or a blocking fallback.
SET lock_timeout='180s';
SET statement_timeout='6min';
REINDEX INDEX CONCURRENTLY public.idx_hand_history_time_identity;
