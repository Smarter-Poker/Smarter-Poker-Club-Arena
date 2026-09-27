-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260808233212 "a5_pending_fee_distributions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8eb0a2fb61fe185fd21063bb2127260d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A5 [P1] Rake / BBJ fee destroyed on RPC failure.
--
-- The fee is removed from the pot inside the hand, then banked by
-- atomic_distribute_rake(). That call is atomic, idempotent and retried 3x, so
-- in practice it lands (a sample of the most recent 500 raked cash hands shows
-- 0 with no rake_records row). But when the retries DO exhaust — a sustained
-- Postgres outage, exactly when restarts and incidents happen — the chips are
-- already out of the pot and there is nothing on disk saying they were owed.
-- They are simply gone, recoverable only by a human reading logs.
--
-- This is the durable queue for that tail case: the engine records the exact
-- arguments it failed to distribute, and a reconciler re-drives them later.
-- atomic_distribute_rake is gated on the hand (uq_rake_records_hand_id), so
-- re-driving an entry that actually did land is a no-op, not a double-bank.

CREATE TABLE IF NOT EXISTS public.pending_fee_distributions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        uuid NOT NULL,
  club_id         uuid NOT NULL,
  hand_id         uuid,
  hand_number     bigint NOT NULL,
  rake            numeric NOT NULL DEFAULT 0,
  bbj             numeric NOT NULL DEFAULT 0,
  pot             numeric NOT NULL DEFAULT 0,
  num_players     integer NOT NULL DEFAULT 0,
  contributions   jsonb   NOT NULL DEFAULT '{}'::jsonb,
  tournament_id   uuid,
  big_blind       numeric,
  kind            text    NOT NULL DEFAULT 'rake',   -- 'rake' | 'bbj_contribution'
  created_at      timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error      text,
  resolved_at     timestamptz,
  CONSTRAINT pending_fee_distributions_kind_chk CHECK (kind IN ('rake','bbj_contribution'))
);

COMMENT ON TABLE public.pending_fee_distributions IS
  'A5: fees already removed from a pot whose banking RPC exhausted its retries. Drained by the FeeReconciler. Re-driving is safe because atomic_distribute_rake is hand-gated and idempotent.';

-- One open entry per (hand, kind). A retry of the engine-side insert must not
-- queue the same fee twice, or the reconciler would attempt it twice (harmless
-- but noisy) and the alerting would over-count what is at risk.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_fee_open_hand_kind
  ON public.pending_fee_distributions (hand_id, kind)
  WHERE resolved_at IS NULL AND hand_id IS NOT NULL;

-- Fallback identity for the (rare) case where the hand_history row itself never
-- got written, so hand_id is null.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_fee_open_table_hand_kind
  ON public.pending_fee_distributions (table_id, hand_number, kind)
  WHERE resolved_at IS NULL AND hand_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pending_fee_unresolved
  ON public.pending_fee_distributions (created_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.pending_fee_distributions ENABLE ROW LEVEL SECURITY;
-- No policies: engine service role only.
