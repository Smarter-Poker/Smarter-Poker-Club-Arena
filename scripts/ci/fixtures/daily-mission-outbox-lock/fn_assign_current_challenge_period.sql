CREATE OR REPLACE FUNCTION public.fn_assign_current_challenge_period(p_user_id uuid, p_tier text, p_period_key text, p_count integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.fn_lock_daily_mission_user(p_user_id);
  PERFORM public.fn_assign_current_challenge_period_serialized_body(
    p_user_id,
    p_tier,
    p_period_key,
    p_count
  );
END;
$function$
