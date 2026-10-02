-- Only after exact target invalid-index and no-active-builder verification.
-- One explicit bounded same-target recovery; no blocking fallback or loop.
SET lock_timeout='180s';
SET statement_timeout='6min';
REINDEX INDEX CONCURRENTLY public.idx_hand_atomic_commit_identity;
