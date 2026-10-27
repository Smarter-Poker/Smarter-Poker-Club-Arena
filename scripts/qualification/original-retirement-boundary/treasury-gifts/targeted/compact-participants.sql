CREATE OR REPLACE FUNCTION public.fn_union_pnl_compact_participants(p_participants jsonb)
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
$function$
