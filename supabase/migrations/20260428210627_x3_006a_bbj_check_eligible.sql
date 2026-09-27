-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260428210627 "x3_006a_bbj_check_eligible"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cb679c63479914042a903b5ced5d1f08 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_bbj_check_eligible(
  p_hand_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_hand record;
  v_winner jsonb;
  v_loser jsonb;
  v_pool_id uuid;
BEGIN
  SELECT * INTO v_hand FROM public.hand_history WHERE id = p_hand_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT player INTO v_loser
    FROM jsonb_array_elements(COALESCE(v_hand.players, '[]'::jsonb)) AS player
   WHERE LOWER(COALESCE(player->>'best_hand_label', '')) LIKE '%four of a kind%aces%'
      OR LOWER(COALESCE(player->>'best_hand_label', '')) LIKE '%quads%aces%'
   LIMIT 1;

  IF v_loser IS NULL THEN RETURN NULL; END IF;

  SELECT player INTO v_winner
    FROM jsonb_array_elements(COALESCE(v_hand.winners, '[]'::jsonb)) AS player
   LIMIT 1;

  IF v_winner IS NULL THEN RETURN NULL; END IF;

  SELECT bp.id INTO v_pool_id
    FROM public.bbj_pools bp
    JOIN public.tables t ON t.club_id = bp.club_id
   WHERE t.id = v_hand.table_id AND bp.status = 'active'
   LIMIT 1;

  RETURN jsonb_build_object(
    'eligible', TRUE, 'hand_id', p_hand_id, 'table_id', v_hand.table_id,
    'hand_number', v_hand.hand_number,
    'winner_user_id', v_winner->>'user_id',
    'loser_user_id', v_loser->>'user_id',
    'pool_id', v_pool_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_check_eligible(uuid) TO service_role;
