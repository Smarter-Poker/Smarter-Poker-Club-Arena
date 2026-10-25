CREATE OR REPLACE FUNCTION public.fn_close_tournament_addon_period(p_tournament_id uuid, p_source text DEFAULT 'engine.addon_period_end'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_t
    FROM public.tournaments
   WHERE id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  IF v_t.addon_period_started_at IS NULL OR v_t.addon_period_ends_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','addon_period_not_started');
  END IF;
  IF clock_timestamp()<v_t.addon_period_ends_at
     AND NOT COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','addon_period_open','ends_at',v_t.addon_period_ends_at);
  END IF;

  v_result := public.fn_finalize_tournament_entry_pool_locked(
    p_tournament_id,p_source,'addon');
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Add-on close could not fund/finalize its prize pool: %',
      COALESCE(v_result->>'reason','unknown') USING ERRCODE='55000';
  END IF;
  RETURN v_result || jsonb_build_object(
    'closed',true,'ends_at',v_t.addon_period_ends_at);
END;
$function$
