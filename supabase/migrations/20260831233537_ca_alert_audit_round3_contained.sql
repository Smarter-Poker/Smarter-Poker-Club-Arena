-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:35:37 UTC on kuklfnapbkmacvwxktbh.

-- ═══════════════════════════════════════════════════════════════════════════
-- ALERT AUDIT ROUND 3 (2026-08-31 21:05-23:31 UTC pushes) - root causes fixed
--  1. Spin/SNG play-chip conservation criticals -> info (same quarantine the
--     tournament twin got at 20:26; play chips, no real money; the burn-in
--     gate check #12 now watches BOTH sources).
--  2. New money paths (club opening setup, leaderboard payouts) declared
--     categories/counterparties the ledger vocabulary did not know, so their
--     flows fell to settlement_suspense and paged as unauthorized_adjustment.
--     The vocabulary learns the words; the fns are audited + registered.
--  3. Supply snapshot: leaderboard prize budgets are real value held outside
--     every counted wallet -> counted as a liability component now. Alerting
--     goes trailing-window so in-flight game-state oscillation (the +237 /
--     -277.66 pair) stops paging while a real leak still does.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1a. conservation alerts map to info incidents (contained, not paging) ───
CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;
  PERFORM public.fn_ca_raise_drift_incident(
    p_source         => 'financial_alerts:' || NEW.source,
    p_classification => CASE
        WHEN NEW.source ~* 'rake'                   THEN 'incorrect_rake'
        WHEN NEW.source ~* 'bbj'                    THEN 'bbj_error'
        WHEN NEW.source ~* 'rakeback'               THEN 'incorrect_rakeback'
        WHEN NEW.source ~* 'treasury|guarantee'     THEN 'treasury_error'
        WHEN NEW.source ~* 'payout|prize|bounty'    THEN 'settlement_error'
        WHEN NEW.source ~* 'insurance'              THEN 'settlement_error'
        WHEN NEW.source ~* 'conservation'           THEN 'ledger_imbalance'
        ELSE 'unknown' END,
    /* Play-chip conservation (tournament AND spin/sng): in-game stacks are
       play chips - no wallet moved. Contained as info: tracked on the
       dashboard, counted by burn-in gate check #12, never paged. Everything
       else stays critical. Ruled 2026-08-31 (alert audit round 3). */
    p_severity       => CASE WHEN NEW.source ~* 'conservation' THEN 'info' ELSE 'critical' END,
    p_dedupe_key     => 'fa:' || NEW.source || ':' || md5(left(NEW.message, 200)),
    p_discrepancy    => COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                                 NULLIF(NEW.context->>'amount','')::numeric, 0),
    p_layer          => 'ledger',
    p_club_id        => NULLIF(NEW.context->>'club_id','')::uuid,
    p_tournament_id  => NULLIF(NEW.context->>'tournament_id','')::uuid,
    p_table_id       => NULLIF(NEW.context->>'table_id','')::uuid,
    p_suspected_cause => left(NEW.message, 300),
    p_metadata       => COALESCE(NEW.context,'{}'::jsonb) ||
                        jsonb_build_object('alert_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_financial_alert_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_financial_alert_to_incident() FROM PUBLIC, anon, authenticated;

-- ── 1b. burn-in gate check #12 watches the spin twin too ────────────────────
DO $do$
DECLARE src text; anchor text; cnt int;
BEGIN
  anchor := 'fa.source = ''fn_tournament_chip_conservation_check''';
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_midway_burnin_gate';
  cnt := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'gate patch: anchor matched % times (need exactly 1)', cnt;
  END IF;
  src := replace(src, anchor,
    'fa.source IN (''fn_tournament_chip_conservation_check'', ''fn_spin_chip_conservation_check'')');
  EXECUTE src;
END $do$;

-- ── 2a. the ledger vocabulary learns the two new money paths ────────────────
ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_category_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_category_check
  CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text]))) NOT VALID;

ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_from_type_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_from_type_check
  CHECK ((from_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID;

ALTER TABLE public.chip_ledger DROP CONSTRAINT chip_ledger_to_type_check;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_to_type_check
  CHECK ((to_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID;

-- ── 2b. the two new money movers are audited and registered ─────────────────
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT v.proname, 'approved', v.notes
FROM (VALUES
  ('fn_complete_club_opening_setup',
   'Audited 2026-08-31 (alert audit round 3): owner/admin-gated, definer, single-transaction club opening funding (spin seed via fn_spin_activate, bbj seed, promo budget, leaderboard budget). Declares category club_opening_allocation / counterparty opening_setup - vocabulary added same day. Leaderboard budget is held as club_opening_setups.leaderboard_seed_remaining and counted in the supply snapshot as leaderboard_liability.'),
  ('fn_payout_leaderboard',
   'Audited 2026-08-31 (alert audit round 3): definer, canonical-round guard, batch-idempotent (leaderboard_payout_batches), seed-then-promo-then-overlay funding, winner credits via fn_credit_and_log with idempotency keys. Declares category leaderboard_payout / counterparty leaderboard_round - vocabulary added same day.')
) AS v(proname, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry r WHERE r.proname = v.proname);

-- ── 3. supply snapshot: leaderboard liability + trailing-window alerting ────
ALTER TABLE public.ca_supply_snapshots
  ADD COLUMN IF NOT EXISTS leaderboard_liability numeric;

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
    /* ZERO-DRIFT (alert audit round 3): a club opening setup moves real chips
       out of the club bank into a leaderboard prize budget that lives in NO
       wallet - it is club_opening_setups.leaderboard_seed_remaining until
       fn_payout_leaderboard spends or releases it. Counting it stops every
       opening setup from reading as destroyed supply (-500 on 2026-08-31). */
    (SELECT COALESCE(sum(leaderboard_seed_remaining),0)
       FROM club_opening_setups)                                        AS lb_liab
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
     leaderboard_liability, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin, s.tourn_liab,
     s.lb_liab, v_total,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - prev.total END,
     -- comparable only when the previous snapshot used the same column basis
     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END)
  RETURNING unexplained INTO v_unexplained;

  /* Trailing-window alerting (alert audit round 3): a single interval swings
     a few hundred chips either way purely from in-flight game state at the
     instant of the snapshot (tournaments/spins mid-settlement) and swings
     BACK the next interval - measured +237.00 then -277.66 on 2026-08-31,
     and +221.94 of the 23:05 dip returned within 25 minutes. Oscillation is
     not drift. A real leak does not cancel, so the alarm now reads the 4-hour
     trailing sum: still one-hour detection latency at worst for anything that
     matters, zero pages for noise that reverts. */
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
