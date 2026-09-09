-- THE SUPPLY METER COUNTS ESCROW UNTIL THE MONEY LEAVES (2026-09-09)
--
-- `fn_ca_supply_snapshot` counted tournament liability only
--   WHERE t.status NOT IN ('COMPLETED','CANCELLED')
-- while the matching chip_ledger prize_liability rows carry no status filter.
-- fn_settle_tournament_places_atomic sets COMPLETED in the same transaction
-- that drains escrow, and reconcile and back-pay legs land afterwards. So an
-- event's escrow left the counted total with no ledger row (a negative half),
-- and its payout rows then landed against an already-zero counted liability (a
-- positive half). The halves cancel - supply is conserved - but the meter
-- reports each as a separate hour, and when several events phase-align it
-- declares "SAME-SIGN across consecutive intervals (a leak persists)".
--
-- MEASURED over 30 hours: all 29 intervals decompose per counted pool and every
-- residual reconciles to the reported figure to the cent. Three of the four
-- flagged hours are ENTIRELY the tournament-liability term (885.27 = +883.44
-- liability; 1055.99 = +1269.80; 1553.60 = +1614.60). Correlation of
-- unexplained against post-completion prize flow is 0.771 over 95 intervals;
-- across 96h, 60,600.22 of prize flow landed after the status flip while net
-- unexplained was 4,905.53. Independently: fn_unaccounted_seat_exits() is empty
-- over 7 days, so no stack left the felt uncredited. No chips are leaking.
--
-- It also hid real money: 58 terminal tournaments were holding 1,198.52 in
-- escrow that no meter could see, because the status flip made them invisible.
--
-- THREE CHANGES
--
-- 1. Liability is the ESCROW while the escrow still holds anything, whatever
--    the status. An event with no escrow row keeps the old counter behaviour,
--    still gated on status. Liability now leaves the total exactly when the
--    ledger says the money left, and terminal residue stops being invisible.
--
-- 2. basis_version. Changing what a delta meter measures makes the very next
--    reading a false leak of the whole redefinition - which here would be a
--    step of about 1,100 chips and would trip the kill switch (threshold 1000)
--    on a change that moved nothing. The column records which basis produced a
--    row and `unexplained` is NULL whenever the previous row was taken under a
--    different one. This generalises the ad-hoc guard already in the code (it
--    suppresses when prev.tournament_liability IS NULL, i.e. a column added
--    later), and it is the same medicine prescribed for fn_ca_diamond_snapshot,
--    whose three open incidents were ALL definitional changes between samples.
--
-- 3. The ledger window gets an upper bound. `created_at > prev.taken_at` with
--    no ceiling counts a row committed between the balance read and the ledger
--    read in BOTH this interval and the next. taken_at is now the cut captured
--    before the balances, so consecutive windows abut exactly instead of
--    overlapping. This is the ±100-600 felt/bbj oscillation fn_ca_trial_balance_watch
--    independently reports.
--
-- DELIBERATELY NOT DONE: adding settlement_suspense to
-- fn_ca_noncirculating_chip_stores. That list is shared with
-- fn_ca_issuance_leg_is_registered, so every suspense leg would suddenly
-- require an issuance registration and live money paths would start refusing.
-- The suspense blind spot is real and is recorded, not fixed here.
--
-- ROLLBACK: restore fn_ca_supply_snapshot from ca_guard_def_history and drop
-- ca_supply_snapshots.basis_version. No balance is touched by this migration.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.ca_supply_snapshots
  ADD COLUMN IF NOT EXISTS basis_version text;

COMMENT ON COLUMN public.ca_supply_snapshots.basis_version IS
  'Which definition of the counted total produced this row. A delta against a row taken under a different basis is not a leak, it is a redefinition, and unexplained is NULL for it. Added 2026-09-09.';

DO $mig$
DECLARE
  v_def text;
  v_liab_old CONSTANT text := '    (SELECT COALESCE(sum(COALESCE(e.prize_balance + e.bounty_balance + e.fee_balance,
                                  COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0)
                                  - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0))),0)
       FROM tournaments t
       LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
      WHERE t.status NOT IN (''COMPLETED'',''CANCELLED''))                  AS tourn_liab,';
  v_liab_new CONSTANT text := '    /* THE ESCROW DECIDES, NOT THE STATUS (2026-09-09). A completed event whose
       banks still hold chips is still a liability; the status flip used to make
       it invisible, which is both a false leak and a hiding place (58 terminal
       events were holding 1,198.52). An event with no escrow row keeps the old
       counter behaviour. */
    (SELECT COALESCE(sum(
              CASE WHEN e.tournament_id IS NOT NULL
                   THEN COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                        + COALESCE(e.fee_balance,0)
                   ELSE COALESCE(t.prize_pool,0) + COALESCE(t.bounty_pool,0)
                        - COALESCE(t.bounty_pool_paid,0) + COALESCE(t.total_rake,0)
              END),0)
       FROM tournaments t
       LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
      WHERE (e.tournament_id IS NOT NULL
             AND COALESCE(e.prize_balance,0) + COALESCE(e.bounty_balance,0)
                 + COALESCE(e.fee_balance,0) <> 0)
         OR (e.tournament_id IS NULL
             AND t.status NOT IN (''COMPLETED'',''CANCELLED'')))            AS tourn_liab,';
  v_decl_old CONSTANT text := '  v_outside text[] := public.fn_ca_noncirculating_chip_stores();';
  v_decl_new CONSTANT text := '  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  /* The ledger window must not overlap the next one: captured BEFORE the
     balance reads, stored as taken_at, and used as the ceiling below. */
  v_cut timestamptz := clock_timestamp();
  v_basis CONSTANT text := ''escrow-liability-v2'';';
  v_where_old CONSTANT text := '     WHERE created_at > prev.taken_at';
  v_where_new CONSTANT text := '     WHERE created_at > prev.taken_at AND created_at <= v_cut';
  v_cols_old CONSTANT text := '     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)';
  v_cols_new CONSTANT text := '     leaderboard_liability, cert_wallets, club_promo, club_insurance, agent_promo, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained, taken_at, basis_version)';
  v_unex_old CONSTANT text := '     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END)';
  v_unex_new CONSTANT text := '     CASE WHEN prev.id IS NULL OR prev.tournament_liability IS NULL
            OR prev.leaderboard_liability IS NULL
            OR COALESCE(prev.basis_version,'''') <> v_basis THEN NULL
          ELSE v_total - prev.total - COALESCE(v_mint,0) + COALESCE(v_burn,0) END,
     v_cut, v_basis)';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_supply_snapshot';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_ca_supply_snapshot is missing'; END IF;

  IF position('escrow-liability-v2' in v_def) > 0 THEN
    RAISE NOTICE 'already applied';
  ELSE
    IF position(v_liab_old  in v_def) = 0 THEN RAISE EXCEPTION 'the tournament-liability term has moved'; END IF;
    IF position(v_decl_old  in v_def) = 0 THEN RAISE EXCEPTION 'the DECLARE block has moved'; END IF;
    IF position(v_where_old in v_def) = 0 THEN RAISE EXCEPTION 'the ledger window has moved'; END IF;
    IF position(v_cols_old  in v_def) = 0 THEN RAISE EXCEPTION 'the snapshot INSERT column list has moved'; END IF;
    IF position(v_unex_old  in v_def) = 0 THEN RAISE EXCEPTION 'the unexplained expression has moved'; END IF;

    v_def := replace(v_def, v_liab_old,  v_liab_new);
    v_def := replace(v_def, v_decl_old,  v_decl_new);
    v_def := replace(v_def, v_where_old, v_where_new);
    v_def := replace(v_def, v_cols_old,  v_cols_new);
    v_def := replace(v_def, v_unex_old,  v_unex_new);
    EXECUTE v_def;
  END IF;
END $mig$;

DO $post$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_supply_snapshot';
  IF position('escrow-liability-v2' in v_def) = 0
     OR position('THE ESCROW DECIDES, NOT THE STATUS' in v_def) = 0
     OR position('created_at <= v_cut' in v_def) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  -- the kill switch and its thresholds must survive the edit
  IF position('fn_ca_raise_drift_incident' in v_def) = 0
     OR position('supply-unexplained:' in v_def) = 0
     OR position('a_correction_is_not_a_mint' in v_def) = 0 THEN
    RAISE EXCEPTION 'a landmark of the supply meter went missing during replacement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='ca_supply_snapshots' AND column_name='basis_version') THEN
    RAISE EXCEPTION 'basis_version was not created';
  END IF;
END $post$;

COMMIT;
