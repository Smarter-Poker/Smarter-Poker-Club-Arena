-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3.3, FIRST CUT - THE LEGACY MONEY DOORS NOBODY CALLS ARE CLOSED
-- (chip standard, 2026-09-04). REVOKE now; DROP after the soak.
--
-- Roadmap 3.3 gates deletion on measured zero use. The measure that covers
-- every session (the engine's PostgREST pool included) is pg_stat_statements,
-- reset 2026-09-02 21:04 UTC: 46 hours of every statement the database ran.
-- Each function below: 0 calls in that window (the only matches were this
-- programme's own probes and migration text), no caller in the Club Arena
-- client or engine, none in the World Hub API, no other function's body
-- calls it, no cron names it, no trigger points at it. Verified 18:44 UTC.
--
-- Left OPEN, deliberately, because a caller exists and must be re-pointed
-- first (each is on the roadmap's 3.3 list; each is the next cut):
--   World Hub API routes call add_chips (5 routes), fn_credit_chips (6),
--   fn_debit_chips (3), record_rake, fn_union_close_club_tables_for_join,
--   fn_ca_fund_club, mint_club_chips, mint_club_promo;
--   the client calls fn_admin_kick_player, fn_leave_seat_and_refund,
--   increment_tournament_rake, mint_club_chips;
--   fn_pay_player_chips is called by the rakeback payers, atomic_table_cashout
--   by trg_auto_cashout_on_table_close, fn_atomic_buyin by
--   orb1_buyin_transaction, fn_credit_treasury_zd4core by fn_credit_treasury;
--   fn_mint_chips_from_diamonds is the live diamond mint (Phase 3.1 made it
--   declare the Mint).
--
-- CLOSED here: EXECUTE revoked from PUBLIC, anon, authenticated and
-- service_role (the owner keeps it, as any owner does), and the registry row
-- set to 'closed' so fn_ca_money_rpc_drift files an incident the moment any
-- role can execute one of them again. A caller that was missed fails loudly
-- with permission denied, which is the point of a soak; the GRANT is the
-- rollback. DROP follows in a later migration after seven days of the same
-- silence, per the roadmap.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('atomic_tournament_register', 'atomic_tournament_unregister', 'deduct_chip_balance',
                         'distribute_chips', 'fn_admin_close_table', 'fn_agent_approve_cashout',
                         'fn_ca_settle_hand_stacks', 'fn_mint_club_chips', 'fn_mint_club_chips_zd3core',
                         'fn_resolve_bbj_pool', 'fn_tournament_atomic_register', 'fn_tournament_unregister_counter',
                         'increment_rake_generated', 'increment_union_chip_balance', 'mass_fund_horses',
                         'spin_pool_deposit', 'spin_pool_draw')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated, service_role', r.proname, r.args);
    INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
    VALUES (r.proname, 'closed', 'chip std 3.3 (2026-09-04): 0 calls in 46h of pg_stat_statements, no caller in client, engine, World Hub, another function, cron or trigger; EXECUTE revoked from every role; DROP after the soak')
    ON CONFLICT (proname) DO UPDATE SET status = 'closed', notes = EXCLUDED.notes;
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 19 THEN
    RAISE EXCEPTION 'expected 19 overloads (17 names, increment_rake_generated x3), revoked %', v_n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ca_money_rpc_registry g JOIN pg_proc p ON p.proname = g.proname AND p.pronamespace = 'public'::regnamespace
     WHERE g.status = 'closed'
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'a closed door is still executable by a client role';
  END IF;
END $$;
