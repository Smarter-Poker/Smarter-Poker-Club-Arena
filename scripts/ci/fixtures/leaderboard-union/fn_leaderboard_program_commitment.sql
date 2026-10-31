CREATE OR REPLACE FUNCTION public.fn_leaderboard_program_commitment(p_rewards_enabled boolean, p_weekly_prizes jsonb, p_monthly_prizes jsonb)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN COALESCE(p_rewards_enabled, false) THEN
    COALESCE((
      SELECT sum((prize ->> 'amount')::numeric)
      FROM jsonb_array_elements(COALESCE(p_weekly_prizes, '[]'::jsonb)) prize
    ), 0)
    + COALESCE((
      SELECT sum((prize ->> 'amount')::numeric)
      FROM jsonb_array_elements(COALESCE(p_monthly_prizes, '[]'::jsonb)) prize
    ), 0)
  ELSE 0 END;
$function$
