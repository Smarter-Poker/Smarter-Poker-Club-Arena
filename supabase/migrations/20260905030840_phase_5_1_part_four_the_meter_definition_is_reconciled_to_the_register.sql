-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 5.1, PART FOUR - THE METER'S NEW DEFINITION IS RECONCILED TO THE
-- REGISTER (chip standard, 2026-09-05 03:10 UTC).
--
-- Part three made the supply meter read tournament_escrow for every event
-- with a row. Two things followed, both read at 03:05: (1) the meter's
-- total stepped DOWN by the amount the counters had overstated the live
-- liability - a change of definition, not a movement of chips - and the
-- hour read unexplained -3,305.68 (trial balance: -3,304.38 on
-- tournament_liability, every other account within 1.30); (2) spins were
-- being read from the escrow, whose row for a spin holds the entries net of
-- fee while the same chips sit in spin_reserve until the draw funds the
-- prize - a double count of ~2.76 per running spin, moving every second.
--
-- This migration: reads spins from the counters again (their escrow row is
-- tracked, not enforced, so `enforced` is the switch); measures, in the
-- same statement, the definitional step - the counters minus the escrow
-- banks over every live enforced event - and records it on the Mint
-- register as an OPENING BASELINE CORRECTION (a burn-signed row, holder
-- circulation, labelled; not a retirement, no chip moves), because the
-- 18:34 register baseline was sized to a meter that carried the counter
-- error; and teaches fn_ca_mint_register_vs_supply to count baseline
-- corrections alongside the snapshots' unexplained, so `difference` and
-- `unexplained_since_baseline` agree again and mean what they say. The
-- 03:05 supply incident is resolved with this migration as the correction;
-- the 04:05 snapshot is the first clean hour of the new definition.
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
       ESCROW BALANCE where the balance enforces the event (every non-spin
       event with a row since part two), and the old counters where it does
       not: an event with no row yet, and every SPIN, whose money sits in
       spin_reserve until the draw funds its prize and whose escrow row is
       tracked, not enforced (part four: reading spins from the escrow
       double-counted their entries against the reserve). */
    (SELECT COALESCE(sum(COALESCE(CASE WHEN e.enforced THEN e.prize_balance + e.bounty_balance + e.fee_balance END,
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

DROP FUNCTION IF EXISTS public.fn_ca_mint_register_vs_supply();
CREATE FUNCTION public.fn_ca_mint_register_vs_supply()
 RETURNS TABLE(register_net numeric, register_net_at_meter numeric, meter_total numeric, meter_taken_at timestamp with time zone, difference numeric, unexplained_since_baseline numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH s AS (SELECT total, taken_at FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1),
       r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net FROM public.ca_mint_ledger WHERE asset = 'chips'),
       ra AS (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) AS net
                FROM public.ca_mint_ledger m, s WHERE m.asset = 'chips' AND m.created_at <= s.taken_at),
       b AS (SELECT min(created_at) AS at FROM public.ca_mint_ledger WHERE op_id LIKE 'register-opening-baseline:%'),
       u AS (SELECT COALESCE(sum(unexplained), 0) AS drift FROM public.ca_supply_snapshots, b WHERE taken_at > b.at),
       -- A baseline correction re-sizes the register to a meter whose definition
       -- changed; it is neither issuance nor drift, so it is added back here.
       c AS (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN -m.amount ELSE m.amount END), 0) AS corr
               FROM public.ca_mint_ledger m, s WHERE m.asset = 'chips' AND m.op_id LIKE 'register-opening-baseline-correction:%' AND m.created_at <= s.taken_at)
  SELECT round(r.net, 2), round(ra.net, 2), round(s.total, 2), s.taken_at, round(s.total - ra.net, 2), round(u.drift + c.corr, 2) FROM r, ra, s, u, c;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_register_vs_supply() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_register_vs_supply() TO service_role;

DO $$
DECLARE v_delta numeric; v_n int; v_supply numeric;
BEGIN
  SELECT round(sum(COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0) - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0)
                   - (e.prize_balance + e.bounty_balance + e.fee_balance)), 2), count(*)
    INTO v_delta, v_n
    FROM public.tournaments t JOIN public.tournament_escrow e ON e.tournament_id = t.id
   WHERE t.status NOT IN ('COMPLETED','CANCELLED') AND e.enforced;
  IF v_delta IS NULL OR v_n < 100 THEN
    RAISE EXCEPTION 'expected a few hundred live enforced events, found % (delta %)', v_n, v_delta;
  END IF;
  IF v_delta < 1000 OR v_delta > 6000 THEN
    RAISE EXCEPTION 'the definitional step reads % over % events, outside the 2,898 read at 03:05 by more than the counters could have moved', v_delta, v_n;
  END IF;
  -- The register carries a labelled correction, burn-signed (the meter went
  -- DOWN by this amount when it stopped believing the counters).
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) - v_delta INTO v_supply
    FROM public.ca_mint_ledger WHERE asset = 'chips';
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason, performed_by_label)
  VALUES
    ('register-opening-baseline-correction:supply-meter-redefinition:2026-09-05', 'burn', 'chips', 'circulation',
     '00000000-0000-0000-0000-00000000c1c0', 'circulation', v_delta, v_delta, 0, v_supply,
     format('OPENING BASELINE CORRECTION, not a retirement: the 2026-09-04 18:34 baseline was sized to a supply meter whose tournament_liability summed counters (prize_pool, open bounty, total_rake) that overstated the live liability; since chip standard Phase 5.1 the meter reads tournament_escrow, and the counters exceeded the escrow banks by %s over %s live enforced events at 2026-09-05 03:10 UTC. No chip moved.', v_delta, v_n),
     'chip standard Phase 5.1 part four');
  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         correction_ref = 'migration phase_5_1_part_four_the_meter_definition_is_reconciled_to_the_register',
         root_cause = 'the supply meter changed definition at 02:56 (tournament_liability from counters to the escrow banks); the counters overstated the live liability, so the total stepped down by that amount in one hour',
         resolution = format('the definitional step (%s) is recorded on the Mint register as a labelled baseline correction; spins are read from the counters again; the next snapshot is the first clean hour', v_delta)
   WHERE dedupe_key = 'supply-unexplained:2026-09-05-03' AND status = 'open';
  RAISE NOTICE 'definitional step % over % events recorded as a baseline correction', v_delta, v_n;
END $$;
