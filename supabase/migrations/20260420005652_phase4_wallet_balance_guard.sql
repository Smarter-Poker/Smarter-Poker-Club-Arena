-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260420005652 as "phase4_wallet_balance_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4.1.6a — Wallet balance write-protection trigger
-- ═══════════════════════════════════════════════════════════════════════════
-- Context: Phase 4.1.2 reconciliation surfaced $804.5M of legacy-seed drift
-- across 586 wallets/clubs. Root cause: ad-hoc `UPDATE wallets SET balance=…`
-- bypassing chip_ledger. Without a DB-level block, the same class of residue
-- can recur at any time (dashboard edit, migration, execute_sql).
--
-- Design:
--   1. A BEFORE INSERT/UPDATE trigger on wallets.balance and clubs.chip_pool
--      rejects direct mutations unless one of the following is true:
--        (a) The PL/pgSQL call stack (PG_CONTEXT) shows a whitelisted
--            SECURITY DEFINER function as an ancestor.
--        (b) The session GUC `app.bypass_wallet_guard` is 'on' (admin escape
--            hatch for legit migrations: `SELECT set_config('app.bypass_wallet_guard','on',true);`).
--
--   Why PG_CONTEXT instead of ALTER FUNCTION … SET:
--     Supabase's supautils extension blocks ALTER FUNCTION ... SET for the
--     `app.*` GUC prefix. PG_CONTEXT detection requires no per-function edits
--     and works immediately for every existing + future whitelisted RPC.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Trigger function
CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_stack   TEXT;
  v_bypass  TEXT;
  v_allowed TEXT[] := ARRAY[
    -- canonical atomic wrappers
    'atomic_credit_wallet_and_log',
    'atomic_deduct_wallet_and_log',
    'atomic_wallet_transfer',
    'atomic_chip_transfer',
    -- idempotent wrappers (Phase 4.1.3)
    'fn_idempotent_credit_wallet',
    'fn_idempotent_deduct_wallet',
    'fn_idempotent_wallet_transfer',
    -- table lifecycle
    'atomic_table_buyin',
    'atomic_table_cashout',
    'atomic_table_rebuy',
    'atomic_seat_horse',
    'player_leave_table',
    -- tournament lifecycle
    'atomic_tournament_register',
    'atomic_tournament_unregister',
    'atomic_cancel_tournament',
    'distribute_tournament_prizes',
    -- rakeback / commission
    'atomic_pay_agent_settlement',
    'atomic_pay_player_rakeback',
    'credit_agent_commission',
    'credit_player_rakeback',
    'execute_commission_payout',
    -- cashout flow
    'fn_cancel_cashout',
    'fn_reject_cashout',
    'fn_clawback_chips_atomic',
    -- club chip pool
    'distribute_chips',
    'mint_club_chips',
    -- misc wallet mutators
    'add_chips',
    'add_to_promo_wallet',
    'credit_player_wallet',
    'deduct_player_wallet',
    'wallet_internal_transfer',
    'wallet_user_transfer',
    -- user signup trigger
    'create_user_wallets',
    -- reconciliation cleanup path (future Phase 4.1.2 redo if ever needed)
    'reconcile_ledger_nightly'
  ];
  v_fn TEXT;
BEGIN
  -- 1) Admin escape hatch (session-level bypass)
  v_bypass := current_setting('app.bypass_wallet_guard', true);
  IF v_bypass = 'on' THEN
    RETURN NEW;
  END IF;

  -- 2) PL/pgSQL call-stack check
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  FOREACH v_fn IN ARRAY v_allowed LOOP
    -- PG_CONTEXT lines look like:
    --   "PL/pgSQL function public.atomic_credit_wallet_and_log(...) line N ..."
    IF v_stack ~ ('function public\.' || v_fn || '\(') THEN
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
$$;

COMMENT ON FUNCTION public.guard_wallet_balance_write IS
  'Phase 4.1.6a: rejects direct UPDATE/INSERT on wallets.balance & clubs.chip_pool '
  'unless the PL/pgSQL call stack contains a whitelisted RPC or '
  'app.bypass_wallet_guard=on is set in the session.';

-- 2) Install triggers
-- wallets.balance
DROP TRIGGER IF EXISTS trg_guard_wallets_balance_ins ON public.wallets;
DROP TRIGGER IF EXISTS trg_guard_wallets_balance_upd ON public.wallets;

CREATE TRIGGER trg_guard_wallets_balance_ins
  BEFORE INSERT ON public.wallets
  FOR EACH ROW
  WHEN (NEW.balance IS NOT NULL AND NEW.balance <> 0)
  EXECUTE FUNCTION public.guard_wallet_balance_write();

CREATE TRIGGER trg_guard_wallets_balance_upd
  BEFORE UPDATE OF balance ON public.wallets
  FOR EACH ROW
  WHEN (NEW.balance IS DISTINCT FROM OLD.balance)
  EXECUTE FUNCTION public.guard_wallet_balance_write();

-- clubs.chip_pool
DROP TRIGGER IF EXISTS trg_guard_clubs_chip_pool_ins ON public.clubs;
DROP TRIGGER IF EXISTS trg_guard_clubs_chip_pool_upd ON public.clubs;

CREATE TRIGGER trg_guard_clubs_chip_pool_ins
  BEFORE INSERT ON public.clubs
  FOR EACH ROW
  WHEN (NEW.chip_pool IS NOT NULL AND NEW.chip_pool <> 0)
  EXECUTE FUNCTION public.guard_wallet_balance_write();

CREATE TRIGGER trg_guard_clubs_chip_pool_upd
  BEFORE UPDATE OF chip_pool ON public.clubs
  FOR EACH ROW
  WHEN (NEW.chip_pool IS DISTINCT FROM OLD.chip_pool)
  EXECUTE FUNCTION public.guard_wallet_balance_write();

-- 3) Verification
DO $$
DECLARE
  v_trg_count INT;
BEGIN
  SELECT COUNT(*) INTO v_trg_count
  FROM pg_trigger
  WHERE tgname IN (
    'trg_guard_wallets_balance_ins',
    'trg_guard_wallets_balance_upd',
    'trg_guard_clubs_chip_pool_ins',
    'trg_guard_clubs_chip_pool_upd'
  );
  IF v_trg_count <> 4 THEN
    RAISE EXCEPTION 'Guard triggers: expected 4, found %', v_trg_count;
  END IF;
  RAISE NOTICE 'Phase 4.1.6a guard installed: triggers=%', v_trg_count;
END
$$;
