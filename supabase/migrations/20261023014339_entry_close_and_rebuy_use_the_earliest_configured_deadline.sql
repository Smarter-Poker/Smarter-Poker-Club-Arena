-- Align transition and rebuy eligibility with the installed earliest-deadline admission rule.
-- Nightly 10K closed admission at 01:30 UTC, but offered a rebuy at 01:32:21 and
-- opened add-ons only at the level edge, 01:36:47. Preserve already committed
-- purchase receipts, seat generations, add-on entitlements and pool finalization.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $preimage$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_rebuy_window(uuid)'::regprocedure AND md5(prosrc)='b9b7ba44728a4f9a72a0c8f77934dbc3' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'ENTRY_BOUNDARY_PREIMAGE_CHANGED: fn_ca_tournament_rebuy_window'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_close_tournament_entry_window(uuid,text)'::regprocedure AND md5(prosrc)='dc972f98fdd9931d012bb53b3a853ac9' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'ENTRY_BOUNDARY_PREIMAGE_CHANGED: fn_close_tournament_entry_window'; END IF;
END
$preimage$;
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
$function$;

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
  IF COALESCE(v_t.late_reg_mins,0)>0
     AND v_t.started_at IS NOT NULL THEN
    v_timed_deadline:=v_t.started_at+
      make_interval(mins=>v_t.late_reg_mins);
    v_timed_open:=v_now<v_timed_deadline;
  END IF;

  -- A configured wall clock also bounds level-based rebuys. The owner's
  -- existing persisted add-on-minute entitlement remains available.
  IF COALESCE(v_t.late_reg_mins,0)>0 THEN
    v_level_open:=v_level_open AND v_timed_open;
  END IF;
  IF v_level_cap>0 THEN
    v_timed_open:=v_level_open;
  END IF;
  IF NOT (v_level_open OR v_timed_open OR v_addon_open) THEN
    RETURN jsonb_build_object(
      'open',false,'prompt_until',NULL,'reason','rebuy_window_closed',
      'level_cap',v_level_cap,'addon_open',v_addon_open);
  END IF;
  v_prompt_until:=LEAST(
    v_now+interval '30 seconds',
    GREATEST(
      CASE WHEN v_level_open THEN LEAST(v_now+interval '30 seconds',v_timed_deadline) END,
      CASE WHEN v_timed_open THEN v_timed_deadline END,
      CASE WHEN v_addon_open THEN v_t.addon_period_ends_at END));
  RETURN jsonb_build_object(
    'open',true,'prompt_until',v_prompt_until,'reason','open',
    'level_cap',v_level_cap,'level_open',v_level_open,
    'timed_open',v_timed_open,'addon_open',v_addon_open);
END;
$function$;

COMMIT;
