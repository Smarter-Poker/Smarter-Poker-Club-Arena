-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:57:35 UTC on kuklfnapbkmacvwxktbh.

-- Supply snapshot learns the cert breakout: cert-held chips are reported in
-- their own column. The total and unexplained formulas are UNCHANGED (cert
-- chips are real chips inside the economy) so comparability is untouched.
CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric;
  v_total numeric; v_trailing numeric;
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
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets)            AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
             +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0)
       FROM union_wallets)                                              AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
             +COALESCE(promo_wallet_balance,0)),0) FROM agents)         AS agent_wallets,
    (SELECT COALESCE(sum(main_balance+backup_balance+promo_balance),0)
       FROM bbj_pools)                                                  AS bbj,
    (SELECT COALESCE(sum(balance),0) FROM spin_bonus_pools)             AS spin,
    (SELECT COALESCE(sum(COALESCE(prize_pool,0) + COALESCE(bounty_pool,0)
                         - COALESCE(bounty_pool_paid,0) + COALESCE(total_rake,0)),0)
       FROM tournaments
      WHERE status NOT IN ('COMPLETED','CANCELLED'))                    AS tourn_liab,
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab,
    /* phase 4: cert-held chips, reported not excluded */
    (SELECT COALESCE(sum(cm.chip_balance),0)
       FROM club_members cm
      WHERE public.fn_ca_is_cert_account(cm.user_id))                   AS cert_w
  INTO s;

  v_total := s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
           + s.union_wallets + s.agent_wallets + s.bbj + s.spin + s.tourn_liab + s.lb_liab;

  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;

  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount) FILTER (WHERE from_type IN ('system_mint','issuance_reserve')),0),
           COALESCE(sum(amount) FILTER (WHERE to_type   IN ('system_burn','chip_retirement')),0)
      INTO v_mint, v_burn
      FROM public.chip_ledger
     WHERE created_at > prev.taken_at;
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability,
     leaderboard_liability, cert_wallets, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, s.cert_w, v_total,
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
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_supply_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_trailing) > 2000 THEN 'critical' ELSE 'warning' END,
      'supply-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained, prev.total + COALESCE(v_mint,0) - COALESCE(v_burn,0), v_total,
      'ledger', 'ca_supply_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'total chip supply changed by ' || round(v_unexplained,2)
        || ' beyond ledgered issuance/retirement this interval; trailing 4h net '
        || round(v_trailing,2) || ' (oscillation cancels, a leak does not)',
      false, jsonb_build_object('trailing_4h', round(v_trailing,2)));
  END IF;

  RETURN v_unexplained;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;;
