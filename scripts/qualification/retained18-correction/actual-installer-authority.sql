-- Actual current installer authority guard definitions and typed watch registry, captured READONLY.
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
 RETURNS text[]
 LANGUAGE sql
 STABLE
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
      -- The Diamond satellite seat door (Phase 9, 2026-09-21): a satellite
      -- seat moved custody to custody, out of one prize bank into an entry.
      'fn_poker_diamond_tournament_seat_transfer',
      -- A balance never moves without its ledger row (2026-10-01): the tally,
      -- its two sides, the account key and the commit-time check.
      'fn_ca_ledger_tally_add','fn_ca_ledger_tally_key','fn_ca_felt_counts_table',
      'fn_ca_tally_balance_move','fn_ca_tally_ledger_leg','fn_ca_balance_has_its_ledger_row',
      -- Every chip store balances with its ledger row (2026-10-02): the store
      -- side of the tally, its pair helper and the Diamond-event scope.
      'fn_ca_tally_store_move','fn_ca_tally_pair','fn_ca_tournament_counts',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_registry_guard()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  obj record;
  v_name text;
  v_src  text;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.object_type <> 'function' OR obj.schema_name IS DISTINCT FROM 'public' THEN
      CONTINUE;
    END IF;

    SELECT p.proname, p.prosrc INTO v_name, v_src
      FROM pg_proc p WHERE p.oid = obj.objid AND p.prokind = 'f';
    IF v_name IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT public.fn_ca_money_rpc_writes_balances(v_src) THEN
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = v_name) THEN
      CONTINUE;
    END IF;

    RAISE EXCEPTION
      'REFUSED: % writes balance columns and is not in ca_money_rpc_registry', v_name
      USING ERRCODE = '42501',
            DETAIL  = 'A function that can move money is registered before it exists, not after. '
                   || 'This is the guard for the seven drift incidents of 2026-09-11.',
            HINT    = 'Put the registry row ABOVE the CREATE FUNCTION in this same migration: '
                   || 'INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES ('
                   || quote_literal(v_name)
                   || ', ''approved'', ''what it moves, what gates it, how it is journaled'');  '
                   || 'Use status ''system'' if it moves no money and only reads or locks.';
  END LOOP;
END;
$function$;

CREATE TABLE public.ca_guard_defs(
"proname" text NOT NULL,
"def_hash" text NOT NULL,
"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
"declared_ref" text,
"declared_at" timestamp with time zone
);
