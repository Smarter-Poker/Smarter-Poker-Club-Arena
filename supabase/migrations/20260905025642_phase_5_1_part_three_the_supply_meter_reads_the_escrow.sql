-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 5.1, PART THREE - THE SUPPLY METER READS THE ESCROW (chip standard,
-- 2026-09-05). Since part two every live event carries a tournament_escrow
-- row maintained in the same transaction as its operational rows. The supply
-- meter's tournament_liability term still summed the counters (prize_pool +
-- open bounty + total_rake), which nothing keeps true: the trial balance put
-- +696.14 on that account in the 20:05-21:05 hour and +326.40 in 01:05-02:05
-- while every other account read within a few chips. The meter now reads the
-- escrow banks where the balance knows the event, the counters only where it
-- does not (an event with no row yet). The trial balance reads the meter's
-- snapshots, so it follows. Everything else in the function is unchanged
-- (re-created from its live definition).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric;
  v_total numeric; v_trailing numeric; v_prev_unexplained numeric; v_critical boolean;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT
    (SELECT COALESCE(sum(chip_balance),0) FROM club_members)            AS member_wallets,
    (SELECT COALESCE(sum(promo_balance),0) FROM club_members)           AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND t.tournament_id IS NOT NULL))            AS felt,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs)                  AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs)                      AS chip_pools,
    /* CHIP STANDARD (2026-09-03): the club-held promo and insurance floats are
       chips like any other. They were outside the total, so every BBJ promo
       sweep into a standalone club read as chips leaving the world. */
    (SELECT COALESCE(sum(promo_balance),0) FROM clubs)                  AS club_promo,
    (SELECT COALESCE(sum(insurance_balance),0) FROM clubs)              AS club_insurance,
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets)            AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
             +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0)
       FROM union_wallets)                                              AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
             +COALESCE(promo_wallet_balance,0)),0) FROM agents)         AS agent_wallets,
    (SELECT COALESCE(sum(COALESCE(promo_wallet_balance,0)),0) FROM agents) AS agent_promo,
    (SELECT COALESCE(sum(main_balance+backup_balance+promo_balance),0)
       FROM bbj_pools)                                                  AS bbj,
    (SELECT COALESCE(sum(balance),0) FROM spin_bonus_pools)             AS spin,
    /* CHIP STANDARD PHASE 5.1 (2026-09-05): a tournament's liability is its
       ESCROW BALANCE where the balance knows the event (every event with a
       row since part two), and the old counters only where it does not. The
       counters were the source of the +300 to +700 an hour this account
       drifted by; the balance is maintained in the same transaction as every
       operational row. */
    (SELECT COALESCE(sum(COALESCE(e.prize_balance + e.bounty_balance + e.fee_balance,
                                  COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0)
                                  - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0))),0)
       FROM tournaments t
       LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
      WHERE t.status NOT IN ('COMPLETED','CANCELLED'))                  AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab,
    /* phase 4: cert-held chips, reported not excluded */
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w
  INTO s;

  v_total := s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
           + s.club_promo + s.club_insurance
           + s.club_wallets + s.union_wallets + s.agent_wallets + s.bbj + s.spin + s.tourn_liab + s.lb_liab;

  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL THEN NULL ELSE prev.unexplained END;

  IF prev.id IS NOT NULL THEN
    -- Symmetric: out of a non-circulating store is issuance, into one is
    -- retirement. A store-to-store row appears in each sum once and nets to
    -- zero, which is correct -- it never touched circulation.
    SELECT COALESCE(sum(amount) FILTER (WHERE from_type = ANY(v_outside)),0),
           COALESCE(sum(amount) FILTER (WHERE to_type   = ANY(v_outside)),0)
      INTO v_mint, v_burn
      FROM public.chip_ledger
     WHERE created_at > prev.taken_at
       /* A correction moves no balance (see a_correction_is_not_a_mint):
          counting it as issuance invents drift equal to itself. */
       AND NOT (category = 'correction'
                AND metadata->>'posted_via' = 'fn_ca_post_correction');
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, s.club_promo, s.club_insurance, s.agent_promo, v_total,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END)
  RETURNING unexplained INTO v_unexplained;

  SELECT COALESCE(sum(unexplained), 0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 100 AND abs(v_trailing) > 300 THEN
    v_critical := abs(v_unexplained) > 25000
               OR (abs(v_trailing) > 2000
                   AND v_prev_unexplained IS NOT NULL
                   AND abs(v_prev_unexplained) > 100
                   AND sign(v_prev_unexplained) = sign(v_unexplained));
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_supply_snapshot', 'ledger_imbalance',
      CASE WHEN v_critical THEN 'critical' ELSE 'warning' END,
      'supply-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained, prev.total + COALESCE(v_mint,0) - COALESCE(v_burn,0), v_total,
      'ledger', 'ca_supply_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'total chip supply changed by ' || round(v_unexplained,2)
        || ' beyond ledgered issuance/retirement this interval; trailing 4h net '
        || round(v_trailing,2)
        || CASE WHEN v_critical THEN ' - SAME-SIGN across consecutive intervals (a leak persists, oscillation flips)'
                ELSE ' (single-interval swing; previous interval did not agree in sign)' END,
      false, jsonb_build_object('trailing_4h', round(v_trailing,2),
                                 'prev_unexplained', round(COALESCE(v_prev_unexplained,0),2)));
  END IF;

  RETURN v_unexplained;
END
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_supply_snapshot() TO service_role;

-- The hourly supply incidents since Phase 4 landed were this account
-- (trial balance: tournament_liability +696.14 in 20:05-21:05, +326.40 in
-- 01:05-02:05, every other account within a few chips). Resolved with this
-- migration as the correction; the next snapshots say whether it held.
UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration phase_5_1_part_three_the_supply_meter_reads_the_escrow',
       root_cause = 'the supply meter summed tournament counters (prize_pool, open bounty, total_rake) that no path keeps true; the trial balance put the whole hourly residual on tournament_liability',
       resolution = 'the meter reads tournament_escrow (chip standard Phase 5.1) for every event the balance knows; counters only for an event with no row yet'
 WHERE source = 'fn_ca_supply_snapshot' AND status = 'open'
   AND dedupe_key LIKE 'supply-unexplained:%'
   AND detected_at >= '2026-09-04 21:00:00+00';
