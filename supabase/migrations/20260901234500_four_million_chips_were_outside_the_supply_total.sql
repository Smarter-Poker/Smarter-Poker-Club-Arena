-- ═══════════════════════════════════════════════════════════════════════════
-- club_wallets WAS MEASURED AND THEN LEFT OUT OF THE TOTAL
--
-- fn_ca_supply_snapshot SELECTs eleven balance stores into `s`, writes all of
-- them to ca_supply_snapshots (there is a club_wallets COLUMN, populated every
-- hour), and then computes
--
--   v_total := member_wallets + member_promo + felt + treasuries + chip_pools
--            + union_wallets + agent_wallets + bbj + spin + tourn_liab + lb_liab;
--
-- with no `club_wallets` term. The store is read, recorded, and excluded.
--
-- club_wallets holds 4,351,836.36 chips across four rows, and it is NOT a
-- duplicate of anything already counted: every club carries BOTH a
-- club_wallets.chip_balance and a separate clubs.chip_treasury (Midway Union
-- 1,360,555.87 wallet against 0.00 treasury; Deep Stack Society 4,087.98
-- against 2,468,178.63). It is not on fn_ca_noncirculating_chip_stores(),
-- so it is circulating money by the system's own definition.
--
-- Verified by arithmetic before changing anything: at 23:05 the component
-- deltas summed to 2,944.34 while `unexplained` recorded 1,102.07 - a
-- difference of exactly that interval's club_wallets movement, 1,842.27.
--
-- WHAT THIS DOES NOT DO IS FIX THE DRIFT. I expected the omission to be the
-- SOURCE of the hourly noise. It is the opposite: club_wallets is GROWING, so
-- counting it makes the measured drift larger, not smaller. Recomputed over
-- the last 25 intervals the corrected series is +31,133.15 chips, mean
-- +1,245/hour, 21 intervals positive against 4 negative. The 2026-09-01 23:05
-- critical that said "SAME-SIGN across consecutive intervals, a leak persists"
-- was RIGHT, and the old measure was hiding it by excluding the very store the
-- chips accumulate in.
--
-- The two routines that write club_wallets.chip_balance without declaring a
-- ledger counterparty are credit_club_wallet_rake and record_rake. That is
-- where the next phase starts.
--
-- THE REBASELINE. Adding the term makes the next delta jump by ~4.35M, which
-- is a change of DEFINITION, not a movement of money, and it would fire a
-- critical and poison the engine deploy gate's trailing-4h window - the way my
-- own corrections did earlier today (the_two_intervals_a_correction_made_
-- unmeasurable). So this migration writes the first snapshot under the new
-- definition itself, unexplained NULL, reason recorded.
-- ═══════════════════════════════════════════════════════════════════════════

DO $fix$
DECLARE
  v_def text;
  v_old text := 's.union_wallets + s.agent_wallets';
  v_new text := 's.club_wallets + s.union_wallets + s.agent_wallets';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_supply_snapshot';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_supply_snapshot not found';
  END IF;
  IF position('s.club_wallets +' in v_def) > 0 THEN
    RAISE NOTICE 'club_wallets already in the total; nothing to do';
    RETURN;
  END IF;
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'the total expression is not where this migration expects it; read the function before re-running';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $fix$;

WITH s AS (
  SELECT
    (SELECT COALESCE(sum(chip_balance),0) FROM club_members) AS member_wallets,
    (SELECT COALESCE(sum(promo_balance),0) FROM club_members) AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM tables t WHERE t.id = table_seats.table_id
          AND t.tournament_id IS NOT NULL)) AS felt,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs) AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs) AS chip_pools,
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets) AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
       +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0) FROM union_wallets) AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
       +COALESCE(promo_wallet_balance,0)),0) FROM agents) AS agent_wallets,
    (SELECT COALESCE(sum(main_balance+backup_balance+promo_balance),0) FROM bbj_pools) AS bbj,
    (SELECT COALESCE(sum(balance),0) FROM spin_bonus_pools) AS spin,
    (SELECT COALESCE(sum(COALESCE(prize_pool,0) + COALESCE(bounty_pool,0)
       - COALESCE(bounty_pool_paid,0) + COALESCE(total_rake,0)),0)
       FROM tournaments WHERE status NOT IN ('COMPLETED','CANCELLED')) AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0) FROM club_opening_setups) AS lb_liab,
    (SELECT COALESCE(sum(cm.chip_balance),0) FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id)) AS cert_w
)
INSERT INTO public.ca_supply_snapshots
  (taken_at, member_wallets, member_promo, felt, treasuries, chip_pools,
   club_wallets, union_wallets, agent_wallets, bbj_pools, spin_pools,
   total, mint_since_prev, burn_since_prev, delta_vs_prev, unexplained,
   tournament_liability, leaderboard_liability, cert_wallets)
SELECT now(), member_wallets, member_promo, felt, treasuries, chip_pools,
       club_wallets, union_wallets, agent_wallets, bbj, spin,
       member_wallets + member_promo + felt + treasuries + chip_pools
         + club_wallets + union_wallets + agent_wallets + bbj + spin
         + tourn_liab + lb_liab,
       0, 0, NULL, NULL, tourn_liab, lb_liab, cert_w
FROM s;

INSERT INTO public.ca_supply_snapshot_classifications
  (snapshot_id, original_unexplained, classification, evidence)
SELECT id, 0,
  'definition_change_not_a_movement',
  jsonb_build_object(
    'migration', 'four_million_chips_were_outside_the_supply_total_v2',
    'what', 'club_wallets joined the supply total; it was measured and stored but never added',
    'store_size_at_rebaseline', club_wallets,
    'unexplained_is_null_because', 'the jump is the definition changing, not chips moving, and a real value here would fire a critical and block engine deploys through the trailing 4h gate',
    'original_unexplained_is_zero_because', 'the column is NOT NULL; there was no prior unexplained value for this row, it was written by the migration')
FROM public.ca_supply_snapshots
ORDER BY taken_at DESC LIMIT 1;
