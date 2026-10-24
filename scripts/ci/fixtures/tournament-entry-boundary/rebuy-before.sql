CREATE OR REPLACE FUNCTION public.fn_ca_tournament_rebuy_window(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_now timestamptz:=clock_timestamp();
  v_level_cap integer;
  v_timed_deadline timestamptz;
  v_level_open boolean:=false;
  v_timed_open boolean:=false;
  v_addon_open boolean:=false;
  v_prompt_until timestamptz;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'tournament is required for rebuy-window policy'
      USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;

  IF upper(COALESCE(v_t.status::text,''))<>'RUNNING'
     OR COALESCE(v_t.prize_pool_finalized,false)
     OR NOT (COALESCE(v_t.is_rebuy,false) OR COALESCE(v_t.is_reentry,false)) THEN
    RETURN jsonb_build_object(
      'open',false,'prompt_until',NULL,'reason','tournament_not_rebuyable');
  END IF;

  v_addon_open:=COALESCE(v_t.add_on_available,false)
    AND COALESCE(v_t.addon_period_triggered,false)
    AND v_t.addon_period_started_at IS NOT NULL
    AND v_t.addon_period_ends_at IS NOT NULL
    AND v_now>=v_t.addon_period_started_at
    AND v_now<v_t.addon_period_ends_at;
  v_level_cap:=COALESCE(
    NULLIF(v_t.rebuy_levels,0),NULLIF(v_t.late_reg_levels,0),0);
  v_level_open:=v_level_cap>0
    AND v_t.current_level IS NOT NULL
    AND v_t.current_level<v_level_cap;
  IF v_level_cap<=0 AND COALESCE(v_t.late_reg_mins,0)>0
     AND v_t.started_at IS NOT NULL THEN
    v_timed_deadline:=v_t.started_at+
      make_interval(mins=>v_t.late_reg_mins);
    v_timed_open:=v_now<v_timed_deadline;
  END IF;

  IF NOT (v_level_open OR v_timed_open OR v_addon_open) THEN
    RETURN jsonb_build_object(
      'open',false,'prompt_until',NULL,'reason','rebuy_window_closed',
      'level_cap',v_level_cap,'addon_open',v_addon_open);
  END IF;
  v_prompt_until:=LEAST(
    v_now+interval '30 seconds',
    GREATEST(
      CASE WHEN v_level_open THEN v_now+interval '30 seconds' END,
      CASE WHEN v_timed_open THEN v_timed_deadline END,
      CASE WHEN v_addon_open THEN v_t.addon_period_ends_at END));
  RETURN jsonb_build_object(
    'open',true,'prompt_until',v_prompt_until,'reason','open',
    'level_cap',v_level_cap,'level_open',v_level_open,
    'timed_open',v_timed_open,'addon_open',v_addon_open);
END;
$function$

