-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift round 2).
-- Byte-exact mirror of the applied migration.
-- ZERO-DRIFT round 2c: the supply snapshot ignored in-flight tournament
-- prize/bounty/fee liabilities, so every open tournament's buy-ins looked
-- like unexplained supply loss (first reading: 20,606 chips "unexplained",
-- almost entirely REGISTERING/RUNNING/COMPLETING pools). Count them.
ALTER TABLE public.ca_supply_snapshots
  ADD COLUMN IF NOT EXISTS tournament_liability numeric;

CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric; v_total numeric;
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
    -- in-flight tournament value: buy-ins parked in prize/bounty pools and
    -- unsettled fees, released back at payout/rake-settlement time
    (SELECT COALESCE(sum(COALESCE(prize_pool,0) + COALESCE(bounty_pool,0)
                         - COALESCE(bounty_pool_paid,0) + COALESCE(total_rake,0)),0)
       FROM tournaments
      WHERE status NOT IN ('COMPLETED','CANCELLED'))                    AS tourn_liab
  INTO s;

  v_total := s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
           + s.union_wallets + s.agent_wallets + s.bbj + s.spin + s.tourn_liab;

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
     union_wallets, agent_wallets, bbj_pools, spin_pools, tournament_liability, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab, v_total,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     CASE WHEN prev.id IS NULL THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END)
  RETURNING unexplained INTO v_unexplained;

  RETURN v_unexplained;
END $$;
-- ---------------------------------------------------------------------------
-- AND THE GRANT (added by the agent landing this bundle).
-- fn_ca_supply_snapshot is SECURITY DEFINER and writes a chip-supply snapshot;
-- its callers are fn_ca_quick_reconcile and the cron ticks, all service_role,
-- and nothing in either repo calls it from a browser. Revoked here as well as
-- in 20260831161047 so that at NO point during a replay is it open - a later
-- migration closing it still leaves a window in between.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;
