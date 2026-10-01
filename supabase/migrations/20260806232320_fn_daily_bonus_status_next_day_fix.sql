-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260806232320 "fn_daily_bonus_status_next_day_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e583eba7d2dcd2eabc58252563c16cb7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_daily_bonus_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_row      public.user_bonuses%ROWTYPE;
  v_today    date := (now() AT TIME ZONE 'UTC')::date;
  v_last_day date;
  v_streak   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_daily_bonus_status requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM public.user_bonuses WHERE user_id = v_uid;

  v_streak   := COALESCE(v_row.daily_streak, 0);
  v_last_day := (v_row.last_daily_claim AT TIME ZONE 'UTC')::date;

  RETURN jsonb_build_object(
    'streak', v_streak,
    'last_claim', v_row.last_daily_claim,
    'can_claim', (v_last_day IS NULL OR v_last_day < v_today),
    'next_day', CASE
                  WHEN v_last_day IS NULL OR v_last_day < v_today - 1 THEN 1
                  ELSE (v_streak % 7) + 1
                END,
    'schedule', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', d.day, 'reward', d.reward, 'reward_type', d.reward_type)
             ORDER BY d.day), '[]'::jsonb)
      FROM public.daily_bonus_rewards d
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_daily_bonus_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_daily_bonus_status() FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_daily_bonus_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_daily_bonus_status() TO service_role;
