-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429042057 "x9_fix_stub_rpcs_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b58a0326822de0d29e1bc1b594d0fc65 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Walkthrough Round 2 (systematic sweep) — 4 phantom-stub fixes:
--   atomic_pay_agent_settlement       (was: BEGIN RETURN; — settlement payouts silently skipped)
--   atomic_pay_player_rakeback (4-arg) (was: BEGIN RETURN; — rakeback overload silently skipped)
--   fn_release_tournament_holds       (was: BEGIN NULL; — escrow holds leak forever on tournament cancel)
--   orb1_buyin_transaction            (was: jsonb_build_object('success',true); — route still dead but stub now warns)

-- ───────────────────────────────────────────────────────────────────────────
-- 1. atomic_pay_agent_settlement — pay an agent their commission share
--    Caller: club-arena/src/services/SettlementService.ts:365
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_pay_agent_settlement(
  p_settlement_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_period_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_user_id uuid;
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  -- Resolve agent → user_id (agents.id ≠ user_id)
  SELECT user_id INTO v_agent_user_id FROM public.agents WHERE id = p_agent_id;
  IF v_agent_user_id IS NULL THEN
    RAISE EXCEPTION 'agent % not found', p_agent_id;
  END IF;

  -- Credit agent's main wallet (creates row if missing)
  INSERT INTO public.wallets (user_id, wallet_type, balance)
       VALUES (v_agent_user_id, 'PLAYER', p_amount)
  ON CONFLICT (user_id, wallet_type) DO UPDATE
     SET balance    = public.wallets.balance + p_amount,
         updated_at = NOW()
  RETURNING balance INTO v_new_balance;

  -- Append to wallet_transactions ledger with balance_after populated
  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, type, amount, category, description,
     related_entity_id, balance_after)
  VALUES
    (v_agent_user_id, 'PLAYER', 'credit', p_amount, 'agent_settlement',
     'Agent commission payout (settlement ' || p_settlement_id::text || ', period ' || p_period_id::text || ')',
     p_settlement_id, v_new_balance);

  -- Update agent's lifetime earnings counter
  UPDATE public.agents
     SET lifetime_earnings = COALESCE(lifetime_earnings, 0) + p_amount,
         updated_at        = NOW()
   WHERE id = p_agent_id;

  -- Audit trail (mirrors the dual-write helper pattern from Phase X7)
  INSERT INTO public.audit_trail
    (actor_id, actor_role, action, target_type, target_id,
     amount, currency, reason)
  VALUES
    (v_agent_user_id, 'system', 'agent_settlement_payout', 'settlement',
     p_settlement_id, p_amount, 'CHIPS',
     'atomic_pay_agent_settlement RPC payout');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.atomic_pay_agent_settlement(uuid, uuid, numeric, uuid) TO service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. atomic_pay_player_rakeback (4-arg overload) — pay rakeback from settlement
--    Caller: club-arena/src/services/SettlementService.ts:466
--    NOTE: The 2-arg overload (p_user_id, p_amount) is already real and stays.
--    This 4-arg version was a phantom; replaces with real impl that includes
--    the snapshot/period linkage the caller passes.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_pay_player_rakeback(
  p_snapshot_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_period_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  INSERT INTO public.wallets (user_id, wallet_type, balance)
       VALUES (p_player_id, 'PLAYER', p_amount)
  ON CONFLICT (user_id, wallet_type) DO UPDATE
     SET balance    = public.wallets.balance + p_amount,
         updated_at = NOW()
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, type, amount, category, description,
     related_entity_id, balance_after)
  VALUES
    (p_player_id, 'PLAYER', 'credit', p_amount, 'rakeback',
     'Rakeback payout (snapshot ' || p_snapshot_id::text || ', period ' || p_period_id::text || ')',
     p_snapshot_id, v_new_balance);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.atomic_pay_player_rakeback(uuid, uuid, numeric, uuid) TO service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. fn_release_tournament_holds — release chip_escrow_holds when tournament
--    is canceled. Without this, chips stay locked in escrow forever and the
--    user's wallet stays debited.
--    Caller: Smarter-Poker-World-Hub/src/lib/poker-engine/TournamentBridge.js:141
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_release_tournament_holds(
  p_tournament_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_hold record;
  v_new_balance numeric;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'p_tournament_id required';
  END IF;

  -- Find every active escrow hold for this tournament register flow
  FOR v_hold IN
    SELECT id, user_id, wallet_id, amount
      FROM public.chip_escrow_holds
     WHERE hold_type = 'tournament_register'
       AND related_id = p_tournament_id
       AND status     = 'held'
     FOR UPDATE
  LOOP
    -- Refund chips to user wallet
    UPDATE public.wallets
       SET balance    = balance + v_hold.amount,
           updated_at = NOW()
     WHERE user_id     = v_hold.user_id
       AND wallet_type = 'PLAYER'
    RETURNING balance INTO v_new_balance;

    -- Mark hold released
    UPDATE public.chip_escrow_holds
       SET status          = 'released',
           released_at     = NOW(),
           released_reason = 'tournament_canceled',
           updated_at      = NOW()
     WHERE id = v_hold.id;

    -- Ledger row
    IF v_new_balance IS NOT NULL THEN
      INSERT INTO public.wallet_transactions
        (user_id, wallet_type, type, amount, category, description,
         related_entity_id, balance_after)
      VALUES
        (v_hold.user_id, 'PLAYER', 'credit', v_hold.amount, 'tournament_refund',
         'Tournament canceled — escrow refund',
         v_hold.id, v_new_balance);
    END IF;
  END LOOP;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_release_tournament_holds(uuid) TO service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- 4. orb1_buyin_transaction — dead phantom that returns success=true to the
--    only caller (/api/club-arena/buyin.js, which itself has zero callers per
--    walkthrough Round 1 finding). Replace with hard-fail so any future
--    accidental call surfaces immediately.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.orb1_buyin_transaction(
  p_club_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_table_id uuid DEFAULT NULL,
  p_amount numeric DEFAULT 0,
  p_type text DEFAULT 'buyin'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  -- Walkthrough Round 2 (2026-04-29): this RPC was a phantom that silently
  -- returned success. Caller /api/club-arena/buyin.js has zero clients (the
  -- canonical sit-flow goes direct to atomic_table_buyin from the browser).
  -- Hard-fail so any regression that re-routes traffic here surfaces loudly
  -- in Sentry instead of silently swallowing a buy-in.
  RAISE EXCEPTION 'orb1_buyin_transaction is deprecated — use atomic_table_buyin (sit) or fn_atomic_buyin (diamond→chip conversion)';
END;
$function$;
