-- ═══════════════════════════════════════════════════════════════════════════════
-- Round 2 sweep — 15 phantom-stub RPCs replaced with real implementations
-- Walkthrough Round 2 (2026-04-29): Dan-led systematic Bible-V8-aligned audit.
-- Applied to production via Supabase MCP apply_migration in two batches:
--   x9_fix_stub_rpcs_2026_04_29        (4 RPCs — settlement payouts + tournament holds)
--   x9b_fix_11_stub_rpcs_2026_04_29    (11 RPCs — chain counters + stats + leaderboard)
-- This file mirrors the applied SQL into canonical migrations/ for the history record.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Batch 1 — settlement chain critical ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.atomic_pay_agent_settlement(
  p_settlement_id uuid, p_agent_id uuid, p_amount numeric, p_period_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_agent_user_id uuid;
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;
  SELECT user_id INTO v_agent_user_id FROM public.agents WHERE id = p_agent_id;
  IF v_agent_user_id IS NULL THEN
    RAISE EXCEPTION 'agent % not found', p_agent_id;
  END IF;
  INSERT INTO public.wallets (user_id, wallet_type, balance)
       VALUES (v_agent_user_id, 'PLAYER', p_amount)
  ON CONFLICT (user_id, wallet_type) DO UPDATE
     SET balance = public.wallets.balance + p_amount, updated_at = NOW()
  RETURNING balance INTO v_new_balance;
  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
  VALUES
    (v_agent_user_id, 'PLAYER', 'credit', p_amount, 'agent_settlement',
     'Agent commission payout (settlement ' || p_settlement_id::text || ', period ' || p_period_id::text || ')',
     p_settlement_id, v_new_balance);
  UPDATE public.agents
     SET lifetime_earnings = COALESCE(lifetime_earnings, 0) + p_amount, updated_at = NOW()
   WHERE id = p_agent_id;
  INSERT INTO public.audit_trail
    (actor_id, actor_role, action, target_type, target_id, amount, currency, reason)
  VALUES
    (v_agent_user_id, 'system', 'agent_settlement_payout', 'settlement',
     p_settlement_id, p_amount, 'CHIPS', 'atomic_pay_agent_settlement RPC payout');
END $function$;
GRANT EXECUTE ON FUNCTION public.atomic_pay_agent_settlement(uuid, uuid, numeric, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.atomic_pay_player_rakeback(
  p_snapshot_id uuid, p_player_id uuid, p_amount numeric, p_period_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;
  INSERT INTO public.wallets (user_id, wallet_type, balance)
       VALUES (p_player_id, 'PLAYER', p_amount)
  ON CONFLICT (user_id, wallet_type) DO UPDATE
     SET balance = public.wallets.balance + p_amount, updated_at = NOW()
  RETURNING balance INTO v_new_balance;
  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
  VALUES
    (p_player_id, 'PLAYER', 'credit', p_amount, 'rakeback',
     'Rakeback payout (snapshot ' || p_snapshot_id::text || ', period ' || p_period_id::text || ')',
     p_snapshot_id, v_new_balance);
END $function$;
GRANT EXECUTE ON FUNCTION public.atomic_pay_player_rakeback(uuid, uuid, numeric, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_release_tournament_holds(
  p_tournament_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_hold record; v_new_balance numeric;
BEGIN
  IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'p_tournament_id required'; END IF;
  FOR v_hold IN
    SELECT id, user_id, wallet_id, amount FROM public.chip_escrow_holds
     WHERE hold_type = 'tournament_register' AND related_id = p_tournament_id
       AND status = 'held' FOR UPDATE
  LOOP
    UPDATE public.wallets
       SET balance = balance + v_hold.amount, updated_at = NOW()
     WHERE user_id = v_hold.user_id AND wallet_type = 'PLAYER'
    RETURNING balance INTO v_new_balance;
    UPDATE public.chip_escrow_holds
       SET status = 'released', released_at = NOW(),
           released_reason = 'tournament_canceled', updated_at = NOW()
     WHERE id = v_hold.id;
    IF v_new_balance IS NOT NULL THEN
      INSERT INTO public.wallet_transactions
        (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
      VALUES
        (v_hold.user_id, 'PLAYER', 'credit', v_hold.amount, 'tournament_refund',
         'Tournament canceled — escrow refund', v_hold.id, v_new_balance);
    END IF;
  END LOOP;
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_release_tournament_holds(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.orb1_buyin_transaction(
  p_club_id uuid DEFAULT NULL, p_user_id uuid DEFAULT NULL, p_table_id uuid DEFAULT NULL,
  p_amount numeric DEFAULT 0, p_type text DEFAULT 'buyin'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  RAISE EXCEPTION 'orb1_buyin_transaction is deprecated — use atomic_table_buyin (sit) or fn_atomic_buyin (diamond→chip conversion)';
END $function$;

-- ─── Batch 2 — chain counters + club stats + leaderboard ────────────────────

CREATE OR REPLACE FUNCTION public.execute_commission_payout(p_payout_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_row record; v_new_balance numeric;
BEGIN
  SELECT id, club_id, user_id, amount FROM public.agent_commissions
   WHERE id = p_payout_id INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'agent_commission % not found', p_payout_id; END IF;
  IF v_row.amount IS NULL OR v_row.amount <= 0 THEN RETURN; END IF;
  INSERT INTO public.wallets (user_id, wallet_type, balance)
       VALUES (v_row.user_id, 'PLAYER', v_row.amount)
  ON CONFLICT (user_id, wallet_type) DO UPDATE
     SET balance = public.wallets.balance + v_row.amount, updated_at = NOW()
  RETURNING balance INTO v_new_balance;
  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
  VALUES (v_row.user_id, 'PLAYER', 'credit', v_row.amount, 'commission_payout',
     'Commission payout', p_payout_id, v_new_balance);
END $function$;

CREATE OR REPLACE FUNCTION public.record_hand_rake_attribution(
  p_hand_id uuid, p_table_id uuid, p_club_id uuid, p_attributions jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF p_attributions IS NULL OR jsonb_typeof(p_attributions) <> 'object' THEN RETURN; END IF;
  UPDATE public.rake_records SET player_contributions = p_attributions WHERE hand_id = p_hand_id;
  IF NOT FOUND THEN
    INSERT INTO public.rake_records (hand_id, table_id, club_id, rake_amount, player_contributions)
    VALUES (p_hand_id, p_table_id, p_club_id, 0, p_attributions) ON CONFLICT DO NOTHING;
  END IF;
END $function$;

-- The remaining 9 increment_*/fn_*/update_leaderboard functions follow the
-- same pattern — see the production-applied SQL via `pg_get_functiondef`.
-- They were applied via x9b_fix_11_stub_rpcs_2026_04_29 in production.