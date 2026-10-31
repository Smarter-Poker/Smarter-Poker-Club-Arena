CREATE OR REPLACE FUNCTION public.fn_get_leaderboard_reward_plan(p_club_id uuid, p_period text, p_period_start date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_period_start date := p_period_start;
  v_program public.leaderboard_reward_program_versions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'Only Weekly And Monthly Reward Programs Are Supported'
      USING ERRCODE = '22023';
  END IF;
  IF v_period_start IS NULL THEN
    SELECT bounds.start_date INTO v_period_start
      FROM public.fn_leaderboard_period_window(p_period, 0) bounds;
  END IF;
  IF (p_period = 'weekly' AND EXTRACT(DOW FROM v_period_start)::integer <> 0)
     OR (p_period = 'monthly' AND EXTRACT(DAY FROM v_period_start)::integer <> 1) THEN
    RAISE EXCEPTION 'Reward Programs Require A Canonical UTC Period Start'
      USING ERRCODE = '22023';
  END IF;

  SELECT program.* INTO v_program
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id
     AND CASE p_period
       WHEN 'weekly' THEN program.weekly_effective_from <= v_period_start
       ELSE program.monthly_effective_from <= v_period_start
     END
   ORDER BY program.version DESC
   LIMIT 1;

  IF v_program.id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'program_id', v_program.id,
    'program_version', v_program.version,
    'program_hash', v_program.program_hash,
    'status', v_program.status,
    'rewards_enabled', v_program.rewards_enabled,
    'period', p_period,
    'period_start', v_period_start,
    'payout_metric', v_program.payout_metric,
    'prizes', CASE p_period
      WHEN 'weekly' THEN v_program.weekly_prizes
      ELSE v_program.monthly_prizes
    END,
    'funding_owner_type', v_program.funding_owner_type,
    'funding_union_id', v_program.funding_union_id,
    'published_at', v_program.published_at
  );
END;
$function$
