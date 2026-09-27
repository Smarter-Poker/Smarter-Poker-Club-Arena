-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260428210654 "x3_006b_bbj_payout"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7a8a77146f1f7f5a44b7b3af4be9bac8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_bbj_payout(
  p_pool_id uuid,
  p_hand_id uuid,
  p_table_id uuid,
  p_winner_user_id uuid,
  p_loser_user_id uuid,
  p_table_player_ids uuid[]
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_pool record;
  v_total numeric;
  v_winner_share numeric;
  v_loser_share  numeric;
  v_table_share  numeric;
  v_per_table_player numeric;
  v_payout_id uuid;
  v_player uuid;
  v_count int;
BEGIN
  SELECT * INTO v_pool FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND OR v_pool.pool_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_pool_or_zero_balance');
  END IF;

  v_total := v_pool.pool_amount;
  v_winner_share := ROUND(v_total * 0.50, 4);
  v_loser_share  := ROUND(v_total * 0.25, 4);
  v_table_share  := v_total - v_winner_share - v_loser_share;
  v_count        := COALESCE(array_length(p_table_player_ids, 1), 0);
  v_per_table_player := CASE WHEN v_count > 0 THEN ROUND(v_table_share / v_count, 4) ELSE 0 END;

  UPDATE public.bbj_pools
     SET pool_amount = 0, last_hit_at = NOW(), last_hit_amount = v_total,
         last_winner_id = p_winner_user_id, last_loser_id = p_loser_user_id,
         hit_count = COALESCE(hit_count, 0) + 1,
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         updated_at = NOW()
   WHERE id = p_pool_id;

  INSERT INTO public.bbj_payouts
    (pool_id, hand_id, table_id, winner_user_id, loser_user_id,
     total_amount, winner_share, loser_share, table_share, table_player_count)
  VALUES
    (p_pool_id, p_hand_id, p_table_id, p_winner_user_id, p_loser_user_id,
     v_total, v_winner_share, v_loser_share, v_table_share, v_count)
  RETURNING id INTO v_payout_id;

  UPDATE public.wallets SET balance = balance + v_winner_share, updated_at = NOW()
   WHERE user_id = p_winner_user_id AND wallet_type = 'main';

  UPDATE public.wallets SET balance = balance + v_loser_share, updated_at = NOW()
   WHERE user_id = p_loser_user_id AND wallet_type = 'main';

  IF v_count > 0 THEN
    FOREACH v_player IN ARRAY p_table_player_ids LOOP
      UPDATE public.wallets SET balance = balance + v_per_table_player, updated_at = NOW()
       WHERE user_id = v_player AND wallet_type = 'main';
      INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount)
      VALUES (v_payout_id, v_player, v_per_table_player);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'payout_id', v_payout_id, 'total_amount', v_total,
    'winner_share', v_winner_share, 'loser_share', v_loser_share,
    'table_share_each', v_per_table_player, 'table_player_count', v_count
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_payout(uuid, uuid, uuid, uuid, uuid, uuid[]) TO service_role;
