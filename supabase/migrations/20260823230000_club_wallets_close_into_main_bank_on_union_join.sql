-- ============================================================================
-- EVERY CLUB WALLET CLOSES INTO THE MAIN BANK WHEN THE CLUB JOINS A UNION
--
-- Dan, 2026-08-23: "IF A CLUB HAS SPINS, BBJ, BACK UP BBJ OR PROMO FUNDS, ALL
-- CHIPS IN THE WALLETS GO TO THE 'MAIN BANK' AND CLOSED WHEN A CLUB JOINS A
-- UNION. ALL THOSE FUNDS ARE GIVEN TO THE CLUB TO KEEP OR DISBURSE AT THEIR
-- OWN DISCRETION."
--
-- THIS CORRECTS A DECISION MADE AN HOUR EARLIER. 20260823220000 sent the Spins
-- SEED back to the club but the remaining FLOAT to the union, reasoning the
-- float was player money and the union now runs Spins for those players.
-- Overruled: the club funded the wallet, the club carried the variance, the
-- club keeps the balance. All of it goes to the main bank.
--
-- THE FOUR WALLETS, AND WHERE THE MONEY ACTUALLY LIVES
--   Spins        spin_bonus_pools.balance        (seed and float alike)
--   BBJ          bbj_pools.main_balance
--   Backup BBJ   bbj_pools.backup_balance
--   Promo        bbj_pools.promo_balance AND clubs.promo_balance
--
-- Promo lives in TWO places and both are swept. bbj_pools.promo_balance is the
-- jackpot's own promo slice; clubs.promo_balance is the club's separate promo
-- float. Sweeping one and not the other would look like it worked.
--
-- THE INVARIANT THIS HAD TO BE CAREFUL WITH
--
-- fn_bbj_conservation_check computes gap = inflow - outflow - balances. Moving
-- money OUT of bbj_pools shrinks `balances` and would push the gap up by the
-- exact amount swept, turning a correct transfer into a money alarm. The check
-- already counts `bbj_promo_sweep` rows in chip_transactions as OUTFLOW, which
-- is exactly what this is, so booking it that way leaves the gap untouched.
--
-- The applied migration proved that by measuring the gap before and after the
-- backfill in the same transaction and refusing to commit if it moved. It
-- deliberately does NOT require the check to be globally `healthy`, because it
-- already is not: measured with nothing of this work applied, the drift from
-- the 2026-08-19 baseline was -226.65 against a tolerance of 1.00. That is a
-- pre-existing discrepancy and a separate investigation. Blocking a correct
-- transfer on an unrelated fault would be the wrong call; adding to it would
-- be worse, and the assertion is what tells the two apart.
--
-- PLAY MOVES, MONEY DOES NOT FOLLOW IT. The club's BBJ pool is retired and
-- pointed at the union's via merged_into_pool_id, because that is where its
-- players now play. The balance still goes to the club. Two different facts,
-- and the ledger note says so, so nobody later reads the merge pointer as a
-- money movement.
--
-- Applied via the Supabase MCP, with a backfill that closed Club JAQK's
-- 28,742.48 promo float into its main bank. Verified by a rolled-back probe:
-- a club holding all four wallets (2,600 Spins including a 2,000 seed, 1,200
-- BBJ, 300 backup, 90 jackpot promo, 750 club promo) joined a union and its
-- main bank went 8,000 -> 12,940, the union received nothing, and the BBJ gap
-- did not move.
-- ============================================================================

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_close_club_wallets_on_union_join') THEN
    RAISE EXCEPTION 'fn_close_club_wallets_on_union_join is missing - apply 20260823230000 via the Supabase MCP';
  END IF;

  IF NOT (SELECT pg_get_functiondef(oid) ILIKE '%fn_close_club_wallets_on_union_join%'
            FROM pg_proc WHERE proname='fn_spin_pool_follows_union_membership') THEN
    RAISE EXCEPTION 'the union-join trigger does not close every wallet';
  END IF;

  -- The Spins wallet must pay the club, not the union.
  IF (SELECT pg_get_functiondef(oid) ILIKE '%absorbed the Spin float of club%'
        FROM pg_proc WHERE proname='fn_spin_absorb_club_pool_into_union') THEN
    RAISE EXCEPTION 'the Spins wallet still hands its float to the union';
  END IF;

  -- BBJ money must leave as a counted OUTFLOW or the conservation gap moves.
  IF NOT (SELECT pg_get_functiondef(oid) ILIKE '%bbj_promo_sweep%'
            FROM pg_proc WHERE proname='fn_close_club_wallets_on_union_join') THEN
    RAISE EXCEPTION 'BBJ sweeps are not booked as bbj_promo_sweep - the conservation gap will move';
  END IF;

  -- Both promo homes must be swept, not just one.
  IF NOT (SELECT pg_get_functiondef(oid) ILIKE '%promo_closed_on_union_join%'
            FROM pg_proc WHERE proname='fn_close_club_wallets_on_union_join') THEN
    RAISE EXCEPTION 'the club promo float is not swept';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.union_id IS NOT NULL AND c.union_id <> c.id
       AND (COALESCE(c.promo_balance,0) <> 0
            OR EXISTS (SELECT 1 FROM public.bbj_pools b
                        WHERE b.club_id = c.id AND b.union_id IS NULL
                          AND COALESCE(b.main_balance,0)+COALESCE(b.backup_balance,0)+COALESCE(b.promo_balance,0) <> 0)
            OR EXISTS (SELECT 1 FROM public.spin_bonus_pools s
                        WHERE s.club_id = c.id
                          AND (s.balance <> 0 OR s.seeded_amount <> 0 OR s.is_active)))) THEN
    RAISE EXCEPTION 'a club inside a union still holds wallet money';
  END IF;
END $check$;
