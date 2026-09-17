CREATE OR REPLACE FUNCTION public.apply_rakeback_player_stats(p_rake_record_id uuid, p_user_id uuid, p_club_id uuid, p_hands integer, p_rake numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer;
BEGIN
  IF p_rake_record_id IS NULL OR p_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.rakeback_stats_applied (rake_record_id, user_id, hands, rake)
  VALUES (p_rake_record_id, p_user_id, p_hands, p_rake)
  ON CONFLICT (rake_record_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.player_stats (
    user_id, club_id, hands_played, total_rake,
    total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won
  ) VALUES (
    p_user_id, p_club_id, COALESCE(p_hands, 0), COALESCE(p_rake, 0),
    0, 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, club_id) DO UPDATE SET
    hands_played = public.player_stats.hands_played + EXCLUDED.hands_played,
    total_rake   = ROUND((public.player_stats.total_rake + EXCLUDED.total_rake) * 100) / 100,
    updated_at   = NOW();

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  it jsonb;
  v_ok integer := 0;
  v_failed integer := 0;
  v_first_error text := NULL;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', 0, 'failed', 0, 'error', 'p_items must be a jsonb array');
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      PERFORM public.credit_agent_commission_from_rake(
        (it->>'user_id')::uuid,
        (it->>'club_id')::uuid,
        COALESCE((it->>'rake_credit')::numeric, 0),
        it->>'source_type',
        NULLIF(it->>'source_id', '')::uuid,
        it->>'notes'
      );
      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF v_first_error IS NULL THEN v_first_error := SQLERRM; END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', v_ok, 'failed', v_failed, 'first_error', v_first_error);
END $function$;

;
