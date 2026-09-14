-- ============================================================================
-- THE DIAMOND TOURNAMENT MONEY DOORS ARE WATCHED
-- ============================================================================
--
-- Phase 8 added ten Diamond tournament money doors (an entry into custody, an
-- add to it, its refund, its unregistration and cancellation, the drain, the
-- prize, the fee, the close and the shadow) and taught two guards new names:
-- the profile wallet guard admits the tournament charge and refund on its
-- stack, and the arena structure guard admits a player's own session to the
-- play-state counters. It also routed two chip readers by asset (the bank cap
-- and the escrow reader). None of them was on the guard watchlist, so a live
-- redefinition of any of them - the wallet guard most of all - would move
-- with every test green. The 2026-09-12 rule: a Diamond money door is
-- watched, and a watched guard changes only by declaration.
--
-- This widens fn_ca_guard_watchlist by those fourteen names, reproducing the
-- forty-four it holds today exactly, and records each new name's first
-- baseline through the declaration door. Applied once to
-- kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

DO $do$
BEGIN
  IF cardinality(public.fn_ca_guard_watchlist()) <> 44 THEN
    RAISE EXCEPTION 'the watchlist holds % names, not the 44 this migration reproduces', cardinality(public.fn_ca_guard_watchlist());
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 1. Widen the list. The 44 are reproduced exactly; nothing is removed.
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
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;

-- ---------------------------------------------------------------------------
-- 2. First baselines for the fourteen, through the declaration door.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_name text; v_declared integer := 0;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
    'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
    'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
    'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
    'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
    'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
    'fn_ca_escrow_can_pay','fn_ca_tournament_escrow']
  LOOP
    IF EXISTS (SELECT 1 FROM public.ca_guard_defs WHERE proname = v_name) THEN
      RAISE EXCEPTION '% already has a baseline; this migration only records first baselines', v_name;
    END IF;
    PERFORM public.fn_ca_declare_guard_redefinition(v_name, 'migration the_diamond_tournament_money_doors_are_watched');
    v_declared := v_declared + 1;
  END LOOP;
  IF v_declared <> 14 THEN RAISE EXCEPTION 'expected 14 first baselines, recorded %', v_declared; END IF;
  -- The list itself is watched, and this migration redefined it: declare that
  -- move, as every widening must, so the watcher has nothing to report.
  PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_guard_watchlist', 'migration the_diamond_tournament_money_doors_are_watched');
  RAISE NOTICE 'guard watchlist: % first baseline(s) recorded, the list re-declared', v_declared;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 3. THE LIST GREW BY FOURTEEN, NOTHING LEFT IT, EVERY NAME HAS A BASELINE
--    THAT MATCHES ITS LIVE TEXT, AND THE LIST IS STILL NOT A BROWSER DOOR.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_list text[] := public.fn_ca_guard_watchlist(); v_name text; v_missing text[] := ARRAY[]::text[];
BEGIN
  IF cardinality(v_list) <> 58 THEN
    RAISE EXCEPTION 'the watchlist holds % names after widening, expected 58', cardinality(v_list);
  END IF;
  FOREACH v_name IN ARRAY ARRAY[
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
    'fn_poker_diamond_reserve','fn_poker_diamond_release',
    'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
    'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
    'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
    'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
    'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
    'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
    'fn_poker_diamond_entry_custody_is_the_entry','fn_ca_guard_watchlist']
  LOOP
    IF NOT (v_name = ANY (v_list)) THEN v_missing := v_missing || v_name; END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'widening the watchlist dropped: %', array_to_string(v_missing, ', ');
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_list) x
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ca_guard_defs g
        WHERE g.proname = x
          AND g.def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE n.nspname = 'public' AND p.proname = x))) THEN
    RAISE EXCEPTION 'a watched guard has no baseline matching its live text';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_guard_watchlist()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the watchlist is callable without an account';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  RAISE NOTICE 'the Diamond tournament money doors are watched: 58 names, 14 new baselines, nothing opened';
END $do$;
