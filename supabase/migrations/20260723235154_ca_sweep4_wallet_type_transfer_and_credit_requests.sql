-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260723235154 "ca_sweep4_wallet_type_transfer_and_credit_requests"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c23b3e9d0a1f1464e0ee6544113c52a5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═════════════════════════════════════════════════════════════════════════════
-- CA sweep #4 — money-service backend fixes
--   F1: wallet-type-aware internal transfer RPC (BUSINESS/PLAYER/PROMO ↔).
--       The client WalletService.internalTransfer / agentSelfTransfer were calling
--       the PLAYER-only atomic_deduct/credit pair, so Business→Player moves were
--       silent no-ops (reported success). This single-transaction RPC moves between
--       wallet TYPES for one user, atomically, and logs both legs.
--   F3: create the credit_requests table (was never applied to prod; the client
--       CreditRequestWidget → CreditRequestService throws on every call).
-- ═════════════════════════════════════════════════════════════════════════════

-- ── F1a: whitelist the new RPC in the wallet-write guard ─────────────────────
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
    'fn_wallet_type_transfer'  -- SWEEP #4 F1
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

-- ── F1b: the wallet-type-aware transfer RPC ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wallet_type_transfer(
  p_user_id uuid,
  p_from_wallet text,
  p_to_wallet text,
  p_amount numeric,
  p_note text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_from_balance numeric;
  v_to_balance numeric;
  v_desc text;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'can only move your own funds');
  END IF;
  IF p_from_wallet NOT IN ('BUSINESS','PLAYER','PROMO')
     OR p_to_wallet NOT IN ('BUSINESS','PLAYER','PROMO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid wallet type');
  END IF;
  IF p_from_wallet = p_to_wallet THEN
    RETURN jsonb_build_object('success', false, 'error', 'source and destination wallets are the same');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be positive');
  END IF;

  -- Lock the source wallet row (serialize concurrent transfers for this user+type)
  SELECT balance INTO v_from_balance
    FROM wallets WHERE user_id = p_user_id AND wallet_type = p_from_wallet
    FOR UPDATE;
  IF v_from_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'source wallet not found');
  END IF;
  IF v_from_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient balance', 'balance', v_from_balance);
  END IF;

  v_desc := COALESCE(NULLIF(p_note, ''), 'Internal transfer ' || p_from_wallet || ' → ' || p_to_wallet);

  -- Debit source, credit destination (create dest wallet if missing) — same txn
  UPDATE wallets SET balance = balance - p_amount, updated_at = now()
   WHERE user_id = p_user_id AND wallet_type = p_from_wallet;

  INSERT INTO wallets (user_id, wallet_type, balance)
       VALUES (p_user_id, p_to_wallet, p_amount)
  ON CONFLICT (user_id, wallet_type)
  DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now()
  RETURNING balance INTO v_to_balance;

  -- Audit both legs
  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, balance_after)
  VALUES
    (p_user_id, p_from_wallet, 'debit',  p_amount, 'internal_transfer', v_desc, v_from_balance - p_amount),
    (p_user_id, p_to_wallet,   'credit', p_amount, 'internal_transfer', v_desc, v_to_balance);

  RETURN jsonb_build_object('success', true, 'from', p_from_wallet, 'to', p_to_wallet,
                            'amount', p_amount, 'from_balance', v_from_balance - p_amount,
                            'to_balance', v_to_balance);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_wallet_type_transfer(uuid, text, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wallet_type_transfer(uuid, text, text, numeric, text) TO authenticated, service_role;

-- ── F3: credit_requests table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL,        -- auth user id of the agent making the request
  approver_id uuid,                  -- auth user id of the club manager who acted
  club_id uuid NOT NULL,
  requested_amount numeric NOT NULL DEFAULT 0,
  approved_amount numeric,
  reason text,
  status text NOT NULL DEFAULT 'pending',   -- pending | approved | denied
  reviewer_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);
CREATE INDEX IF NOT EXISTS idx_credit_requests_club ON public.credit_requests (club_id, status);
CREATE INDEX IF NOT EXISTS idx_credit_requests_requester ON public.credit_requests (requester_id);
ALTER TABLE public.credit_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_requests_insert_own ON public.credit_requests;
CREATE POLICY credit_requests_insert_own ON public.credit_requests
  FOR INSERT TO authenticated WITH CHECK (requester_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS credit_requests_select ON public.credit_requests;
CREATE POLICY credit_requests_select ON public.credit_requests
  FOR SELECT TO authenticated USING (
    requester_id = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = credit_requests.club_id AND c.owner_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = credit_requests.club_id
                 AND cm.user_id = (SELECT auth.uid()) AND cm.role IN ('owner','co_owner','admin'))
  );

DROP POLICY IF EXISTS credit_requests_update_manager ON public.credit_requests;
CREATE POLICY credit_requests_update_manager ON public.credit_requests
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM clubs c WHERE c.id = credit_requests.club_id AND c.owner_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = credit_requests.club_id
                 AND cm.user_id = (SELECT auth.uid()) AND cm.role IN ('owner','co_owner','admin'))
  );
