-- ═══════════════════════════════════════════════════════════════════════════
--  A DETECTED JACKPOT IS PAID OR QUEUED, NEVER DROPPED
--  BBJ full audit, 2026-09-05 (docs/changelog/2026-09-05-bbj-full-audit.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The engine's bbj_payout settlement step made ONE call to
-- bbj_atomic_payout_v2 and returned on any error. Its memory of the hit
-- (`snap.bbjHit`) lives for one hand, so a transient failure - a PostgREST
-- schema-cache reload (28 s on this database), a dropped socket, the :55
-- maintenance freeze refusing the write - meant a jackpot that had been
-- DETECTED from a witnessed showdown and ANNOUNCED to the table (`bbj_hit`
-- goes out before the payout) was never paid, never recorded and never
-- retried. There was no bbj_payouts row for any reconciler to notice.
--
-- The engine now retries (server/src/services/supabase/bbj.ts) and, when
-- every attempt fails, QUEUES the payout's full parameter set in
-- pending_fee_distributions - the same durable queue and 5-minute drain the
-- rake and BBJ-contribution fees already use (FeeReconciler.ts) - as a new
-- kind, 'bbj_payout'. This migration lets the table hold that kind. The
-- parameters ride in `contributions` (jsonb); rake/bbj/pot are 0 because no
-- fee is at stake - the pool's money is. The existing partial unique indexes
-- on (hand_id, kind) and (table_id, hand_number, kind) de-duplicate it
-- exactly as they do the fees, and bbj_atomic_payout_v2 is idempotent on
-- (pool, table, hand), so a re-drive after a lost response pays nobody twice.
--
-- A CHECK constraint change reloads the PostgREST schema cache once
-- (CLAUDE.md §2); one transaction, one statement.

BEGIN;

ALTER TABLE public.pending_fee_distributions
  DROP CONSTRAINT IF EXISTS pending_fee_distributions_kind_chk;
ALTER TABLE public.pending_fee_distributions
  ADD CONSTRAINT pending_fee_distributions_kind_chk
  CHECK (kind = ANY (ARRAY['rake'::text, 'bbj_contribution'::text, 'bbj_payout'::text]));

COMMENT ON CONSTRAINT pending_fee_distributions_kind_chk ON public.pending_fee_distributions IS
  'rake / bbj_contribution: a fee that left a pot and could not be banked. bbj_payout (2026-09-05): a jackpot the engine detected and could not pay; its parameters are in contributions and FeeReconciler re-drives bbj_atomic_payout_v2, which is idempotent.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.pending_fee_distributions'::regclass
       AND conname = 'pending_fee_distributions_kind_chk'
       AND pg_get_constraintdef(oid) LIKE '%bbj_payout%'
  ) THEN
    RAISE EXCEPTION 'pending_fee_distributions_kind_chk does not admit bbj_payout';
  END IF;
END $$;

COMMIT;
