-- ============================================================================
-- THE DIAMOND GUARDS ARE WATCHED
-- ============================================================================
--
-- The Phase 8 checklist ends with "cannot pay playing-stack units to wallets",
-- and the audit says to mirror the chip guard that was added after 46.4 million
-- chips were minted into horse wallets: atomic_table_cashout detects
-- tournament_id IS NOT NULL, raises a drift incident, closes the seat and
-- returns zero.
--
-- THAT GUARD ALREADY EXISTS ON THE DIAMOND SIDE, and this migration does not
-- pretend otherwise. Every Diamond path that could turn a stack into wallet
-- Diamonds already refuses a tournament-attached table AND refuses custody
-- that is not a cash seat:
--
--   fn_poker_diamond_cashout          t.tournament_id IS NULL, purpose='cash_seat'
--   fn_poker_diamond_settle_cash_hand t.tournament_id IS NULL, purpose='cash_seat'
--                                     AND state='active'
--   fn_poker_diamond_release          an ACTIVE row releases only for cash_seat;
--                                     a tournament entry mid-play raises
--                                     diamond_custody_requires_settlement
--   fn_poker_diamond_buyin            cash_games_enabled, plain cash table
--   fn_poker_diamond_top_up           cash_games_enabled
--   fn_poker_diamond_reserve          tournaments_enabled (20260912112311)
--
-- WHAT DOES NOT EXIST IS ANYTHING WATCHING THEM. fn_ca_guard_watchlist() names
-- 28 functions whose definitions are hashed hourly and compared, so that an
-- alarm cannot be quietly disarmed. Not one of the 28 is a Diamond function.
-- Every guard listed above could be redefined away and nothing in this estate
-- would notice, which is the same shape of silence the 28 exist to break.
--
-- The four arithmetic rules Phase 8 installed are added for the same reason.
-- They are pinned by laws that read MIGRATION SOURCE and by vectors compared
-- against generated output, and neither of those sees a live redefinition in
-- production. Redefine fn_ca_unit_floor_cents to stop flooring and the prize
-- ladder, the recovery fee, the chip chop and both bounty splits all silently
-- stop snapping, with every test still green.
--
-- fn_ca_guard_watchlist is added to its own list. A watchlist nobody watches
-- can be shortened as easily as the guards it names.
--
-- ADDING A NAME RAISES NOTHING, AND THAT IS PROVED RATHER THAN HOPED.
-- fn_ca_guard_defs_watch inserts a baseline for any watched function that has
-- none and only reports a hash that MOVES from an existing baseline. The
-- baselines for the thirteen are still seeded here, through the estate's own
-- declaration door (fn_ca_declare_guard_redefinition, 2026-09-10), in the same
-- transaction that widens the list: each one is recorded against this
-- migration's name, so the first scheduled run after this has nothing to say
-- rather than thirteen things, and the board shows who baselined them and why.
--
-- NOTHING ABOUT THE WATCHER CHANGES. fn_ca_guard_defs_watch is not touched,
-- not muted and not narrowed. Its grants are not touched either: the list is
-- replaced with CREATE OR REPLACE, which keeps the existing ACL, and the
-- migration checks that no caller without an account can execute it - the
-- prize ladder migration learned the hard way that a function recreated in
-- public arrives with default grants to anon.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Every name this migration is about to watch exists, once, in public.
--    A watched name that does not exist makes the watcher raise a warning on
--    every run, so this refuses before it widens anything.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_name text; v_n integer; v_missing text := ''; v_overloaded text := '';
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'fn_poker_diamond_reserve','fn_poker_diamond_release',
    'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
    'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
    'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
    'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
    'fn_ca_prize_ladder','fn_ca_recovery_fee_cents','fn_ca_guard_watchlist']
  LOOP
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_n = 0 THEN v_missing := v_missing || ' ' || v_name; END IF;
    IF v_n > 1 THEN v_overloaded := v_overloaded || ' ' || v_name; END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'these functions do not exist and would alarm on every run if watched:%', v_missing;
  END IF;
  IF v_overloaded <> '' THEN
    -- The watcher hashes every overload together, in oid order, so an
    -- overload is watchable; it is named here so nobody is surprised by it.
    RAISE NOTICE 'watched names with more than one overload:%', v_overloaded;
  END IF;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 1. Widen the list. The 28 are reproduced exactly; nothing is removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors. Each one is the only thing standing between a
      -- tournament stack and a wallet, and none of them was watched.
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules Phase 8 installed. A live redefinition of any of these
      -- un-snaps every divide in the tournament path with every test green.
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- And the list itself, because a watchlist nobody watches can be
      -- shortened as easily as the guards it names.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;

-- ---------------------------------------------------------------------------
-- 2. Baseline the thirteen through the declaration door, against this
--    migration's name, so the watcher's next run has nothing to report and the
--    board can see who baselined them. The door itself refuses a name that is
--    not on the list and a guard that does not exist, so it is also the second
--    check that step 1 did what it says.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_name text; v_declared integer := 0;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'fn_poker_diamond_reserve','fn_poker_diamond_release',
    'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
    'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
    'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
    'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
    'fn_ca_prize_ladder','fn_ca_recovery_fee_cents','fn_ca_guard_watchlist']
  LOOP
    -- None of the thirteen has a baseline yet, so this is a first record, not
    -- a moved one. If one somehow does, refuse: a baseline that already exists
    -- belongs to whoever set it, and overwriting it is exactly the silence
    -- this migration is here to end.
    IF EXISTS (SELECT 1 FROM public.ca_guard_defs WHERE proname = v_name) THEN
      RAISE EXCEPTION '% already has a baseline; this migration only records first baselines', v_name;
    END IF;
    PERFORM public.fn_ca_declare_guard_redefinition(v_name, 'migration the_diamond_guards_are_watched');
    v_declared := v_declared + 1;
  END LOOP;
  RAISE NOTICE 'guard watchlist: % first baseline(s) recorded', v_declared;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 3. THE LIST GREW, NOTHING LEFT IT, THE WATCHER HAS NOTHING TO SAY ABOUT THE
--    NEW NAMES, AND THE LIST IS STILL NOT CALLABLE WITHOUT AN ACCOUNT.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_list text[] := public.fn_ca_guard_watchlist();
  v_name text; v_lost text := ''; v_unbaselined text := ''; v_drifting text := '';
  v_undeclared text := ''; v_hash text;
  c_original constant text[] := ARRAY[
    'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
    'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
    'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
    'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
    'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
    'fn_ca_journal_append_only','fn_ca_is_midway_scope',
    'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
    'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
    'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
    'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
    'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
    'fn_ca_post_correction','fn_ca_repair_write_failure'];
  c_added constant text[] := ARRAY[
    'fn_poker_diamond_reserve','fn_poker_diamond_release',
    'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
    'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
    'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
    'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
    'fn_ca_prize_ladder','fn_ca_recovery_fee_cents','fn_ca_guard_watchlist'];
BEGIN
  -- Widening a list must never narrow it.
  FOREACH v_name IN ARRAY c_original LOOP
    IF NOT (v_name = ANY(v_list)) THEN v_lost := v_lost || ' ' || v_name; END IF;
  END LOOP;
  IF v_lost <> '' THEN
    RAISE EXCEPTION 'widening the watchlist dropped:%', v_lost;
  END IF;

  FOREACH v_name IN ARRAY c_added LOOP
    IF NOT (v_name = ANY(v_list)) THEN
      RAISE EXCEPTION 'the watchlist does not name %', v_name;
    END IF;
  END LOOP;

  IF array_length(v_list, 1) <> 41 THEN
    RAISE EXCEPTION 'the watchlist holds % names, expected 41', array_length(v_list, 1);
  END IF;

  -- Every watched name exists and is baselined. The thirteen this migration
  -- adds sit exactly on their baseline and carry this migration's name, so the
  -- next scheduled run reports nothing about them. An ORIGINAL that is already
  -- away from its baseline is somebody else's open notice, and this migration
  -- neither closes it nor asserts it away.
  FOREACH v_name IN ARRAY v_list LOOP
    SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
      INTO v_hash
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION 'watched function % does not exist', v_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ca_guard_defs WHERE proname = v_name) THEN
      v_unbaselined := v_unbaselined || ' ' || v_name;
    ELSIF v_name = ANY(c_added) THEN
      IF (SELECT def_hash FROM public.ca_guard_defs WHERE proname = v_name) <> v_hash THEN
        v_drifting := v_drifting || ' ' || v_name;
      END IF;
      IF (SELECT declared_ref FROM public.ca_guard_defs WHERE proname = v_name)
         IS DISTINCT FROM 'migration the_diamond_guards_are_watched' THEN
        v_undeclared := v_undeclared || ' ' || v_name;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.ca_guard_def_history
                      WHERE proname = v_name AND def_hash = v_hash) THEN
        RAISE EXCEPTION 'the text of % was not kept, so a later notice would have nothing to diff against', v_name;
      END IF;
    END IF;
  END LOOP;

  IF v_unbaselined <> '' THEN
    RAISE EXCEPTION 'these watched functions have no baseline:%', v_unbaselined;
  END IF;
  IF v_drifting <> '' THEN
    RAISE EXCEPTION 'these newly watched functions are already off their baseline:%', v_drifting;
  END IF;
  IF v_undeclared <> '' THEN
    RAISE EXCEPTION 'these newly watched functions were not baselined by this migration:%', v_undeclared;
  END IF;

  -- The list was replaced in place and its grants came with it: an account-less
  -- caller still cannot read which guards are watched, and neither can an
  -- ordinary signed-in one.
  IF has_function_privilege('anon', 'public.fn_ca_guard_watchlist()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_guard_watchlist()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_guard_watchlist became executable by anon or authenticated; CREATE OR REPLACE was expected to keep its grants';
  END IF;

  RAISE NOTICE 'guard watchlist: 41 names, all baselined, the 13 new ones quiet and declared';
END;
$do$;
