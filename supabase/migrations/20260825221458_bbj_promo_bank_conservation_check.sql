-- THE PROMO BANK IS SELF-CHECKING NOW (2026-08-25)
--
-- While attributing the BBJ conservation gap, the promo bank came out short:
--
--   promo_portion recorded on contributions   71,692.94
--   swept to a union wallet                   45,416.70
--   swept to a club wallet                    28,742.48
--   still held                                     4.25
--   ---------------------------------------------------
--   over-swept                                 2,470.49
--
-- fn_sweep_bbj_promo CANNOT do this. It reads promo_balance, moves exactly
-- that, and zeroes it - so the balance must have been credited beyond
-- promo_portion at some point. The likeliest source is the 41,096.65 of
-- PRE-TRIPLE-BANK contributions, which carry NULL portions and so count as zero
-- in the first line while their money was entirely real.
--
-- NOT REPAID, deliberately. There is no history of pool balance changes, so a
-- genuine over-sweep and a triple-bank migration artifact are indistinguishable
-- from the surviving data. Crediting 2,470.49 into a live jackpot on a
-- hypothesis would be inventing money, which is the same sin as losing it.
-- Confirmed HISTORICAL rather than ongoing: read an hour apart, over_swept held
-- at 2,470.49 while promo_contributed rose 71,692.94 -> 71,705.37 and
-- swept_to_union rose 45,416.70 -> 45,430.93, i.e. exactly in step.
--
-- What this migration adds is the check that would have caught it on day one,
-- so it can never accumulate silently again.
--
-- ROLLBACK: DROP FUNCTION public.fn_bbj_promo_bank_check();

CREATE OR REPLACE FUNCTION public.fn_bbj_promo_bank_check()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH t AS (
    SELECT
      (SELECT COALESCE(sum(promo_portion),0) FROM bbj_contributions)                                   AS contributed,
      (SELECT COALESCE(sum(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_promo_sweep')   AS swept_to_union,
      (SELECT COALESCE(sum(amount),0) FROM chip_transactions WHERE transaction_type='bbj_promo_sweep')  AS swept_to_club,
      (SELECT COALESCE(sum(promo_balance),0) FROM bbj_pools)                                           AS still_held,
      (SELECT COALESCE(sum(amount),0) FROM bbj_contributions
        WHERE main_portion IS NULL AND backup_portion IS NULL AND promo_portion IS NULL)               AS pre_triple_bank
  )
  SELECT jsonb_build_object(
    'promo_contributed', round(contributed,2),
    'swept_to_union',    round(swept_to_union,2),
    'swept_to_club',     round(swept_to_club,2),
    'still_held',        round(still_held,2),
    'over_swept',        round(swept_to_union + swept_to_club + still_held - contributed, 2),
    'pre_triple_bank_contributions', round(pre_triple_bank,2),
    'reconciles',        (round(swept_to_union + swept_to_club + still_held - contributed, 2) <= 0.01),
    'note', 'over_swept is how much more left the promo bank than promo_portion says entered it. It cannot come from fn_sweep_bbj_promo, which can only move the balance it reads. The likeliest source is pre-triple-bank contributions, which carry NULL portions and so count as zero here while their money was real. Investigate before moving any balance.'
  ) FROM t;
$fn$;

REVOKE ALL ON FUNCTION public.fn_bbj_promo_bank_check() FROM anon;
