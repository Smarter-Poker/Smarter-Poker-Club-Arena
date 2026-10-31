CREATE FUNCTION public.fn_union_pnl_compact_participants(p_participants jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN jsonb_typeof(p_participants)='array' THEN
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('earning_club_id',e.x->'earning_club_id','user_id',e.x->'user_id',
      'observed_stack_delta',e.x->'observed_stack_delta') ORDER BY e.n),'[]'::jsonb)
    FROM jsonb_array_elements(p_participants) WITH ORDINALITY e(x,n))
  ELSE p_participants END
$function$;
CREATE FUNCTION public.fn_union_pnl_cash_outcome_touch_row(p_table_id uuid, p_hand_number bigint, p_recognized_at timestamptz,
  p_game_scope jsonb, p_evidence jsonb)
 RETURNS SETOF public.union_pnl_cash_outcome_touches
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT p_table_id,p_hand_number,p_recognized_at,p_game_scope->>'game_union_id',
  (p_evidence->>'status' IS DISTINCT FROM 'ready' OR p_evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR p_evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR p_evidence->'game_scope' IS DISTINCT FROM p_game_scope),
  p_evidence->>'accepted_rake',public.fn_union_pnl_compact_participants(p_evidence->'participants')
$function$;
CREATE FUNCTION public.fn_union_pnl_cash_outcome_touch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 INSERT INTO public.union_pnl_cash_outcome_touches
 SELECT * FROM public.fn_union_pnl_cash_outcome_touch_row(NEW.table_id,NEW.hand_number,NEW.recognized_at,NEW.game_scope,NEW.evidence)
 ON CONFLICT (table_id,hand_number) DO NOTHING;
 RETURN NULL;
END $function$;
