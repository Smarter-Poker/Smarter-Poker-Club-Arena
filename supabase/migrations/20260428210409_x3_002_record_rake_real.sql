-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260428210409 "x3_002_record_rake_real"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5326b49062a7dd55c4763692deca43d7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.record_rake(
  p_hand_id        uuid    DEFAULT NULL,
  p_club_id        uuid    DEFAULT NULL,
  p_table_id       uuid    DEFAULT NULL,
  p_rake_amount    numeric DEFAULT 0,
  p_pot_size       numeric DEFAULT 0,
  p_num_players    integer DEFAULT 0,
  p_player_contributions jsonb DEFAULT NULL,
  p_is_tournament  boolean DEFAULT FALSE,
  p_tournament_id  uuid    DEFAULT NULL,
  p_bbj_pct        numeric DEFAULT 0.05
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_bbj_amount   numeric := 0;
  v_rake_id      uuid;
  v_pool_id      uuid;
  v_new_balance  numeric;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_rake');
  END IF;

  v_bbj_amount := ROUND(p_rake_amount * COALESCE(p_bbj_pct, 0)::numeric, 4);

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution,
    pot_size, num_players, player_contributions,
    is_tournament, tournament_id, source, metadata
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake_amount, v_bbj_amount,
    p_pot_size, p_num_players, p_player_contributions,
    p_is_tournament, p_tournament_id,
    CASE WHEN p_is_tournament THEN 'tournament' ELSE 'cash_game' END,
    jsonb_build_object('bbj_pct_applied', p_bbj_pct)
  )
  RETURNING id INTO v_rake_id;

  IF p_club_id IS NOT NULL AND v_bbj_amount > 0 THEN
    INSERT INTO public.bbj_pools (club_id, pool_amount, hands_contributed, total_contributed)
    VALUES (p_club_id, v_bbj_amount, 1, v_bbj_amount)
    ON CONFLICT (club_id) DO UPDATE
      SET pool_amount       = public.bbj_pools.pool_amount + v_bbj_amount,
          hands_contributed = public.bbj_pools.hands_contributed + 1,
          total_contributed = public.bbj_pools.total_contributed + v_bbj_amount,
          updated_at        = NOW()
    RETURNING id INTO v_pool_id;
  END IF;

  IF p_club_id IS NOT NULL THEN
    UPDATE public.club_wallets
       SET period_rake_collected     = period_rake_collected     + p_rake_amount,
           period_bbj_contribution   = period_bbj_contribution   + v_bbj_amount,
           lifetime_rake_collected   = lifetime_rake_collected   + p_rake_amount,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj_amount,
           chip_balance              = chip_balance + (p_rake_amount - v_bbj_amount),
           updated_at                = NOW()
     WHERE club_id = p_club_id
    RETURNING chip_balance INTO v_new_balance;

    IF v_new_balance IS NOT NULL THEN
      INSERT INTO public.club_wallet_transactions (
        club_id, type, amount, balance_after, related_id, reason
      ) VALUES (
        p_club_id, 'rake_in', (p_rake_amount - v_bbj_amount), v_new_balance,
        v_rake_id, 'Rake collected (BBJ pct: ' || p_bbj_pct::text || ')'
      );
    END IF;
  END IF;

  IF p_club_id IS NOT NULL THEN
    UPDATE public.clubs
       SET total_rake = COALESCE(total_rake, 0) + p_rake_amount,
           updated_at = NOW()
     WHERE id = p_club_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'rake_record_id', v_rake_id,
    'bbj_pool_id', v_pool_id,
    'rake', p_rake_amount,
    'bbj_contribution', v_bbj_amount
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_rake(
  uuid, uuid, uuid, numeric, numeric, integer, jsonb, boolean, uuid, numeric
) TO service_role, authenticated;
