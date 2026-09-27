-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260428210509 "x3_004_settle_hand_atomically"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2ba318f8869bcb83a3afc030afed97fa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.settle_hand_atomically(
  p_table_id uuid,
  p_hand_id  uuid,
  p_payload  jsonb
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.settlement_idempotency_keys%ROWTYPE;
  v_rake_result jsonb;
  v_commission_results jsonb := '[]'::jsonb;
  v_player record;
  v_individual_result jsonb;
  v_final_result jsonb;
BEGIN
  SELECT * INTO v_existing
    FROM public.settlement_idempotency_keys
   WHERE table_id = p_table_id AND hand_id = p_hand_id;

  IF FOUND THEN
    IF v_existing.status = 'succeeded' THEN
      RETURN v_existing.result;
    ELSIF v_existing.status = 'in_flight' THEN
      UPDATE public.settlement_idempotency_keys
         SET attempt_count = attempt_count + 1,
             last_attempt_at = NOW()
       WHERE table_id = p_table_id AND hand_id = p_hand_id;
      RAISE EXCEPTION 'settlement already in flight for table=% hand=%', p_table_id, p_hand_id;
    END IF;
  ELSE
    INSERT INTO public.settlement_idempotency_keys
      (table_id, hand_id, status)
    VALUES (p_table_id, p_hand_id, 'in_flight');
  END IF;

  BEGIN
    v_rake_result := public.record_rake(
      p_hand_id        := p_hand_id,
      p_club_id        := (p_payload->>'club_id')::uuid,
      p_table_id       := p_table_id,
      p_rake_amount    := COALESCE((p_payload->>'rake')::numeric, 0),
      p_pot_size       := COALESCE((p_payload->>'pot')::numeric, 0),
      p_num_players    := COALESCE((p_payload->>'num_players')::int, 0),
      p_player_contributions := p_payload->'player_contributions',
      p_is_tournament  := COALESCE((p_payload->>'is_tournament')::boolean, FALSE),
      p_tournament_id  := NULLIF(p_payload->>'tournament_id','')::uuid,
      p_bbj_pct        := COALESCE((p_payload->>'bbj_pct')::numeric, 0.05)
    );

    FOR v_player IN
      SELECT key::uuid AS user_id, value::numeric AS rake_share
        FROM jsonb_each_text(COALESCE(p_payload->'player_contributions', '{}'::jsonb))
       WHERE value::numeric > 0
    LOOP
      v_individual_result := public.calculate_cascading_commission(
        p_hand_id        := p_hand_id,
        p_club_id        := (p_payload->>'club_id')::uuid,
        p_player_user_id := v_player.user_id,
        p_rake_amount    := v_player.rake_share,
        p_rake_record_id := (v_rake_result->>'rake_record_id')::uuid
      );
      v_commission_results := v_commission_results || jsonb_build_array(v_individual_result);
    END LOOP;

    v_final_result := jsonb_build_object(
      'success', true,
      'table_id', p_table_id,
      'hand_id', p_hand_id,
      'rake', v_rake_result,
      'commissions', v_commission_results
    );

    UPDATE public.settlement_idempotency_keys
       SET status = 'succeeded',
           result = v_final_result,
           completed_at = NOW(),
           last_attempt_at = NOW()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;

    RETURN v_final_result;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.settlement_idempotency_keys
       SET status = 'failed',
           error  = SQLERRM,
           last_attempt_at = NOW()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;
    RAISE;
  END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.settle_hand_atomically(uuid, uuid, jsonb) TO service_role;
