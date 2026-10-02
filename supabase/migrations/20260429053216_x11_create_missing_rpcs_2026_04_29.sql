-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429053216 "x11_create_missing_rpcs_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 72e95e18bc482f36b0a71aa668398f27 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 9 — Create the 4 most-critical missing RPCs that frontend code calls.
-- These were silent dispatch failures; calls returned errors that get logged
-- as console warnings but the user sees no result.

-- ───────────────────────────────────────────────────────────────────────────
-- bbj_promo_payout — pays out BBJ promo bank to a winner
-- (Triple-Bank: main 50% / backup 25% / promo 25% — promo pays the player
-- separately when the BBJ hits an eligible scenario)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bbj_promo_payout(
  p_pool_id uuid, p_user_id uuid, p_amount numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_pool record;
  v_new_pool_promo numeric;
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount');
  END IF;
  SELECT * INTO v_pool FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_pool.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'pool not found');
  END IF;
  IF COALESCE(v_pool.promo_balance, 0) < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient promo balance',
                              'available', v_pool.promo_balance, 'requested', p_amount);
  END IF;
  -- Drain promo balance
  UPDATE public.bbj_pools
     SET promo_balance = promo_balance - p_amount,
         pool_amount   = pool_amount   - p_amount,
         total_paid_out = COALESCE(total_paid_out, 0) + p_amount,
         updated_at = NOW()
   WHERE id = p_pool_id
  RETURNING promo_balance INTO v_new_pool_promo;
  -- Credit player wallet
  INSERT INTO public.wallets (user_id, wallet_type, balance)
       VALUES (p_user_id, 'PLAYER', p_amount)
  ON CONFLICT (user_id, wallet_type) DO UPDATE
     SET balance = public.wallets.balance + p_amount, updated_at = NOW()
  RETURNING balance INTO v_new_balance;
  -- Ledger row
  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
  VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'bbj_promo',
          'BBJ promo bank payout', p_pool_id, v_new_balance);
  RETURN jsonb_build_object('success', true, 'amount', p_amount,
                            'new_promo_balance', v_new_pool_promo,
                            'new_player_balance', v_new_balance);
END $function$;
GRANT EXECUTE ON FUNCTION public.bbj_promo_payout(uuid, uuid, numeric) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- force_close_table_and_refund — admin closes a table mid-hand
-- Refunds every seated player their current stack to PLAYER wallet,
-- marks the table closed, writes audit_trail.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.force_close_table_and_refund(
  p_table_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_seat record;
  v_total_refunded numeric := 0;
  v_count integer := 0;
  v_new_balance numeric;
BEGIN
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_table_id required');
  END IF;
  -- Refund every active seat
  FOR v_seat IN
    SELECT user_id, stack FROM public.table_seats
     WHERE table_id = p_table_id AND left_at IS NULL FOR UPDATE
  LOOP
    UPDATE public.wallets
       SET balance = balance + v_seat.stack, updated_at = NOW()
     WHERE user_id = v_seat.user_id AND wallet_type = 'PLAYER'
    RETURNING balance INTO v_new_balance;
    INSERT INTO public.wallet_transactions
      (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (v_seat.user_id, 'PLAYER', 'credit', v_seat.stack,
            'force_close_refund',
            'Table force-closed by admin' || COALESCE(' — ' || p_reason, ''),
            p_table_id, v_new_balance);
    v_total_refunded := v_total_refunded + v_seat.stack;
    v_count := v_count + 1;
  END LOOP;
  -- Mark all seats left
  UPDATE public.table_seats SET left_at = NOW() WHERE table_id = p_table_id AND left_at IS NULL;
  -- Mark table closed
  UPDATE public.tables SET status = 'closed' WHERE id = p_table_id;
  -- Audit
  INSERT INTO public.audit_trail
    (actor_id, actor_role, action, target_type, target_id, amount, reason)
  VALUES (p_actor_id, 'platform_admin', 'force_close_table', 'table',
          p_table_id, v_total_refunded, p_reason);
  RETURN jsonb_build_object('success', true,
    'players_refunded', v_count, 'total_refunded', v_total_refunded);
END $function$;
GRANT EXECUTE ON FUNCTION public.force_close_table_and_refund(uuid, uuid, text) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- fn_expire_stale_cashouts — expire unclaimed cashout requests older than N hours
-- Caller: probably a cron handler. Default TTL = 72 hours.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_expire_stale_cashouts(p_ttl_hours integer DEFAULT 72)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_expired integer;
BEGIN
  WITH stale AS (
    UPDATE public.cashout_requests
       SET status = 'expired', updated_at = NOW(),
           agent_note = COALESCE(agent_note,'') || ' [auto-expired after ' || p_ttl_hours::text || 'h]'
     WHERE status = 'pending'
       AND created_at < NOW() - make_interval(hours => p_ttl_hours)
    RETURNING id
  )
  SELECT COUNT(*) INTO v_expired FROM stale;
  RETURN COALESCE(v_expired, 0);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_expire_stale_cashouts(integer) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- settle_club_rakeback — closes all open rakeback_periods for a club
-- Loops every pending period and calls fn_close_settlement_period (existing)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_club_rakeback(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_period record;
  v_settled integer := 0;
  v_total_payout numeric := 0;
  v_close_result jsonb;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_club_id required');
  END IF;
  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE club_id = p_club_id AND status = 'pending'
  LOOP
    v_close_result := public.fn_close_settlement_period(v_period.id);
    IF (v_close_result->>'success')::boolean THEN
      v_settled := v_settled + 1;
      v_total_payout := v_total_payout + COALESCE((v_close_result->>'payout')::numeric, 0);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true,
    'club_id', p_club_id, 'periods_settled', v_settled, 'total_payout', v_total_payout);
END $function$;
GRANT EXECUTE ON FUNCTION public.settle_club_rakeback(uuid) TO service_role;
