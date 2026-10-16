CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_win RECORD; v_unexplained numeric;
  v_total numeric; v_trailing numeric; v_prev_unexplained numeric; v_critical boolean;
  v_late_mint numeric := 0; v_late_burn numeric := 0;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_basis CONSTANT text := 'cashout-escrow-v5';
BEGIN
  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;
  v_prev_unexplained := CASE WHEN prev.id IS NULL OR prev.basis_version IS DISTINCT FROM v_basis
                            THEN NULL ELSE prev.unexplained END;

  /* ONE STATEMENT, ONE SNAPSHOT (20261002164500). Every balance, this
     window's ledger and the re-read of the previous windows see exactly the
     same committed transactions. The cut is clock_timestamp() taken inside
     the statement: later than its snapshot, so every leg it can see is
     stamped at or below the cut. A writer still open is invisible to all of
     it, balance and leg alike; when it commits, its leg is found by the
     re-read below in whichever window its stamp falls. */
  WITH c AS MATERIALIZED (SELECT clock_timestamp() AS cut),
  wins AS MATERIALIZED (
    SELECT r.id, lo.taken_at AS lo, r.taken_at AS hi,
           COALESCE(r.restated_mint, r.mint_since_prev, 0) AS rec_mint,
           COALESCE(r.restated_burn, r.burn_since_prev, 0) AS rec_burn
      FROM (SELECT id, taken_at, mint_since_prev, burn_since_prev,
                   restated_mint, restated_burn
              FROM public.ca_supply_snapshots
             ORDER BY taken_at DESC LIMIT 6) r
      JOIN LATERAL (SELECT p.taken_at FROM public.ca_supply_snapshots p
                     WHERE p.taken_at < r.taken_at
                     ORDER BY p.taken_at DESC LIMIT 1) lo ON true
  )
  SELECT
    c.cut AS cut,
    (SELECT COALESCE(sum(cm.chip_balance),0) FROM club_members cm
       JOIN clubs cl ON cl.id = cm.club_id WHERE NOT COALESCE(cl.is_platform, false)) AS member_wallets,
    (SELECT COALESCE(sum(cm.promo_balance),0) FROM club_members cm
       JOIN clubs cl ON cl.id = cm.club_id WHERE NOT COALESCE(cl.is_platform, false)) AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND (t.tournament_id IS NOT NULL
                                /* DIAMOND PHASE 9, STEP 0 (2026-09-29): a Diamond seat holds
                                   Diamonds that no chip_ledger row moves. */
                                OR EXISTS (SELECT 1 FROM public.clubs cl
                                            WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))            AS felt,
    /* THE FELT IS OWED WHAT A MID-HAND ADD-ON ALREADY PAID FOR (2026-09-12). */
    (SELECT COALESCE(sum(pa.amount),0) FROM public.table_pending_addons pa
      WHERE pa.resolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = pa.table_id
                           AND (t.tournament_id IS NOT NULL
                                OR EXISTS (SELECT 1 FROM public.clubs cl
                                            WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))            AS pending_addons,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS chip_pools,
    (SELECT COALESCE(sum(promo_balance),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS club_promo,
    (SELECT COALESCE(sum(insurance_balance),0) FROM clubs WHERE NOT COALESCE(is_platform, false)) AS club_insurance,
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
    (SELECT COALESCE(sum(
              CASE WHEN e.tournament_id IS NOT NULL
                   THEN COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                        + COALESCE(e.fee_balance,0)
                   ELSE COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0)
                        - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0)
              END),0)
       FROM tournaments t
       LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
      WHERE ((e.tournament_id IS NOT NULL
             AND COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                 + COALESCE(e.fee_balance,0) <> 0)
         OR (e.tournament_id IS NULL
             AND t.status NOT IN ('COMPLETED','CANCELLED')))
        /* DIAMOND PHASE 9, STEP 0: a Diamond event's pools are not a chip liability. */
        AND NOT EXISTS (SELECT 1 FROM public.clubs cl
                         WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))            AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab,
    (SELECT COALESCE(sum(amount),0) FROM public.chip_escrow WHERE released_at IS NULL) AS cashout_escrow,
    /* THE TICKET IS A CHIP LIABILITY (2026-09-11). */
    public.fn_ca_ticket_escrow_float()                                  AS ticket_escrow,
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w,
    /* This window's issuance and retirement. */
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE prev.id IS NOT NULL
        AND l.created_at > prev.taken_at AND l.created_at <= c.cut
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS mint,
    (SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = ANY(v_outside)),0)
       FROM public.chip_ledger l
      WHERE prev.id IS NOT NULL
        AND l.created_at > prev.taken_at AND l.created_at <= c.cut
        AND NOT (l.category = 'correction'
                 AND l.metadata->>'posted_via' = 'fn_ca_post_correction'))  AS burn,
    /* The previous six windows, read again under this same snapshot. */
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', w.id, 'mint', x.vm, 'burn', x.vb,
               'rec_mint', w.rec_mint, 'rec_burn', w.rec_burn)), '[]'::jsonb)
       FROM wins w
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type = ANY(v_outside)),0) AS vm,
                COALESCE(sum(l.amount) FILTER (WHERE l.to_type   = ANY(v_outside)),0) AS vb
           FROM public.chip_ledger l
          WHERE l.created_at > w.lo AND l.created_at <= w.hi
            AND NOT (l.category = 'correction'
                     AND l.metadata->>'posted_via' = 'fn_ca_post_correction')) x) AS windows
  INTO s
  FROM c;

  /* A leg visible now that its window did not see when it was read is late:
     its writer committed after that reading, so its balance appears in THIS
     reading. Count it here, once, and mark the window restated so the next
     reading does not count it again. */
  FOR v_win IN SELECT (e->>'id')::bigint AS id,
                  (e->>'mint')::numeric AS vm, (e->>'burn')::numeric AS vb,
                  (e->>'rec_mint')::numeric AS rm, (e->>'rec_burn')::numeric AS rb
             FROM jsonb_array_elements(s.windows) e
  LOOP
    IF v_win.vm <> v_win.rm OR v_win.vb <> v_win.rb THEN
      v_late_mint := v_late_mint + (v_win.vm - v_win.rm);
      v_late_burn := v_late_burn + (v_win.vb - v_win.rb);
      UPDATE public.ca_supply_snapshots
         SET restated_mint = v_win.vm, restated_burn = v_win.vb, restated_at = s.cut
       WHERE id = v_win.id;
    END IF;
  END LOOP;

  v_total := s.member_wallets + s.member_promo + s.felt + s.pending_addons
           + s.treasuries + s.chip_pools
           + s.club_promo + s.club_insurance
           + s.club_wallets + s.union_wallets + s.agent_wallets + s.bbj + s.spin
           + s.tourn_liab + s.lb_liab + s.ticket_escrow + s.cashout_escrow;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, pending_addons, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo,
     ticket_escrow, cashout_escrow, total,
     mint_since_prev, burn_since_prev, late_mint, late_burn,
     delta_vs_prev, unexplained, taken_at, basis_version)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.pending_addons, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, s.club_promo, s.club_insurance, s.agent_promo,
     s.ticket_escrow, s.cashout_escrow, v_total,
     CASE WHEN prev.id IS NULL THEN NULL ELSE s.mint END,
     CASE WHEN prev.id IS NULL THEN NULL ELSE s.burn END,
     v_late_mint, v_late_burn,
     CASE WHEN prev.id IS NULL OR prev.basis_version IS DISTINCT FROM v_basis
          THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL
            OR COALESCE(prev.basis_version,'') <> v_basis THEN NULL
          ELSE v_total - prev.total - s.mint + s.burn - v_late_mint + v_late_burn END,
     s.cut, v_basis)
  RETURNING unexplained INTO v_unexplained;

  SELECT COALESCE(sum(unexplained), 0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL
     AND basis_version = v_basis;

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
      v_unexplained, prev.total + s.mint - s.burn + v_late_mint - v_late_burn, v_total,
      'ledger', 'ca_supply_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'total chip supply changed by ' || round(v_unexplained,2)
        || ' beyond ledgered issuance/retirement this interval (late legs from earlier windows included: mint '
        || round(v_late_mint,2) || ', burn ' || round(v_late_burn,2) || '); trailing 4h net '
        || round(v_trailing,2)
        || CASE WHEN v_critical THEN ' - SAME-SIGN across consecutive intervals (a leak persists, oscillation flips)'
                ELSE ' (single-interval swing; previous interval did not agree in sign)' END,
      false, jsonb_build_object('trailing_4h', round(v_trailing,2),
                                 'prev_unexplained', round(COALESCE(v_prev_unexplained,0),2),
                                 'late_mint', round(v_late_mint,2),
                                 'late_burn', round(v_late_burn,2)));
  END IF;

  PERFORM public.fn_ca_kill_switch_trip('fn_ca_supply_snapshot', v_unexplained,
    format('the supply meter read %s unexplained in one hour (trailing 4h %s)', round(COALESCE(v_unexplained, 0), 2), round(COALESCE(v_trailing, 0), 2)));

  RETURN v_unexplained;
END
$function$;
