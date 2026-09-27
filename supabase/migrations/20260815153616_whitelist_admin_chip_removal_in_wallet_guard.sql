-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815153616 "whitelist_admin_chip_removal_in_wallet_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ae766815a97795c0b216fff5dddc8a92 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_admin_remove_player_chips returns the removed chips to clubs.chip_pool, which
-- is protected by the Phase 4.1.6a balance guard. It is a legitimate SECURITY
-- DEFINER money RPC (owner/admin-only, row-locked, writes chip_transactions), so
-- it is added to the guard whitelist rather than bypassing the guard.
CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack   TEXT;
  v_bypass  TEXT;
  v_allowed TEXT[] := ARRAY[
    'atomic_credit_wallet_and_log','atomic_deduct_wallet_and_log','atomic_wallet_transfer',
    'atomic_chip_transfer','fn_idempotent_credit_wallet','fn_idempotent_deduct_wallet',
    'fn_idempotent_wallet_transfer','atomic_table_buyin','atomic_table_cashout',
    'atomic_table_rebuy','atomic_seat_horse','player_leave_table','atomic_tournament_register',
    'atomic_tournament_unregister','atomic_cancel_tournament','distribute_tournament_prizes',
    'process_tournament_rebuy',
    'atomic_pay_agent_settlement','atomic_pay_player_rakeback','credit_agent_commission',
    'credit_player_rakeback','execute_commission_payout','fn_cancel_cashout','fn_reject_cashout',
    'fn_clawback_chips_atomic','distribute_chips','mint_club_chips','add_chips','add_to_promo_wallet',
    'credit_player_wallet','deduct_player_wallet','wallet_internal_transfer','wallet_user_transfer',
    'create_user_wallets','reconcile_ledger_nightly',
    -- added 2026-08-15 with the chip-removal authority policy
    'fn_admin_remove_player_chips','fn_approve_cashout_atomic','fn_cancel_cashout_atomic'
  ];
  v_fn TEXT;
BEGIN
  v_bypass := current_setting('app.bypass_wallet_guard', true);
  IF v_bypass = 'on' THEN RETURN NEW; END IF;
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  FOREACH v_fn IN ARRAY v_allowed LOOP
    IF v_stack ~ ('function (public\.)?' || v_fn || '\(') THEN
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION
    'Direct balance mutation on %.% is forbidden by Phase 4.1.6a guard. '
    'All balance changes must flow through the whitelisted SECURITY DEFINER '
    'RPCs (atomic_*, fn_idempotent_*, distribute_chips, mint_club_chips, etc.) '
    'that log to chip_ledger. Admin override: '
    'SELECT set_config(''app.bypass_wallet_guard'', ''on'', true);',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;
