CREATE OR REPLACE FUNCTION public.fn_close_tournament_entry_window(p_tournament_id uuid, p_source text DEFAULT 'engine.entry_window_close'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_deadline timestamptz;
  v_retry_ms bigint;
  v_mode text;
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
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  IF v_t.status<>'RUNNING' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_running','status',v_t.status);
  END IF;

  -- The admission predicate already owns the earliest level/clock cutoff.
  -- Report a clock-bounded hybrid as minutes so the serving engine arms its
  -- existing database-relative deadline timer as well as its level events.
  v_mode := CASE WHEN COALESCE(v_t.late_reg_mins,0)>0 THEN 'minutes'
    WHEN COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0)>0 THEN 'levels'
    ELSE 'immediate' END;
  IF v_mode='minutes' AND v_t.started_at IS NULL
     AND NOT COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object('ok',false,
      'reason','started_at_required_for_minutes_window','window_mode',v_mode);
  END IF;
  IF public.fn_tournament_late_registration_open(p_tournament_id) THEN
    IF v_mode='minutes' THEN
      v_deadline:=v_t.started_at+make_interval(mins=>v_t.late_reg_mins);
      v_retry_ms:=GREATEST(
        ceil(extract(epoch FROM (v_deadline-clock_timestamp()))*1000),0)::bigint;
    END IF;
    RETURN jsonb_build_object('ok',true,'entry_closed',false,
      'window_mode',v_mode,'retry_after_ms',v_retry_ms);
  END IF;

  -- Add-on chips can still change the final pool. Close entry now, but let the
  -- persisted add-on deadline own finalization and its receipt.
  IF COALESCE(v_t.add_on_available,false)
     AND NOT COALESCE(v_t.prize_pool_finalized,false) THEN
    RETURN jsonb_build_object(
      'ok',true,'entry_closed',true,'window_mode',v_mode,
      'finalized',false,'finalization_deferred',true,
      'reason','addon_required','retry_after_ms',NULL);
  END IF;

  RETURN public.fn_finalize_tournament_entry_pool_locked(
    p_tournament_id,p_source,v_mode);
END;
$function$

