-- 2026-08-31 — MTT Phase 3: a clawback is a negative payout, and the record
-- has to be able to say so.
--
-- The back catalogue contains exactly one negative movement of tournament
-- money: a 20.00 clawback on 2026-08-15, under the key
-- `tourney:{id}:clawback:{user}:{place}`. The existing `amount >= 0` CHECK
-- would have refused to record it, and a payout record that silently drops the
-- one clawback in its history is not a record. The guard stays in force for
-- every other source.
--
-- TIER: 3. ROLLBACK at the bottom.

BEGIN;

SET LOCAL lock_timeout = '8s';

ALTER TABLE public.tournament_payouts
  DROP CONSTRAINT IF EXISTS tournament_payouts_amount_check;
ALTER TABLE public.tournament_payouts
  ADD CONSTRAINT tournament_payouts_amount_check
  CHECK (amount >= 0 OR source = 'clawback');

COMMIT;

-- ===========================================================================
-- ROLLBACK (note: this fails while the one clawback row exists, which is the
-- correct behaviour — the row would have to be removed first, through the
-- app.payout_record_correction path)
-- ===========================================================================
-- BEGIN;
-- ALTER TABLE public.tournament_payouts DROP CONSTRAINT tournament_payouts_amount_check;
-- ALTER TABLE public.tournament_payouts
--   ADD CONSTRAINT tournament_payouts_amount_check CHECK (amount >= 0);
-- COMMIT;
