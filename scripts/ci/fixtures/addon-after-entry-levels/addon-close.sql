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
  /* THE LANE BEFORE THE ROW (2026-10-25). G shared, then T(id) exclusive,
     then the tournaments row: the order of every other writer of this
     event. Finalizing the pool here fires the deferred payer, which asks
     for T(id) exclusive at COMMIT; holding the row without the lane made
     that a deadlock with any rebuy, add-on or hand that holds T(id) and
     waits for the row. Taken first, the payer's request is re-entrant. */
  IF p_tournament_id IS NOT NULL THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  END IF;
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
