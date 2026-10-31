-- @live-proof: strpos(pg_get_functiondef('public.fn_close_tournament_entry_window(uuid,text)'::regprocedure),'addon_waiting_for_late_entry_levels')>0 AND strpos(pg_get_functiondef('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure),'no early add-ons')>0
-- Owner 2026-10-31: add-ons start only after the final late-entry level.
-- Afternoon Deep Stack 8b33a780 opened after elapsed minute 80 before level 8
-- finished; 50 immutable purchases committed. Preserve receipts/finalized pools.
-- Definition-only change: no tournament, seat, balance or receipt is rewritten.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $patch$
DECLARE d text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_close_tournament_entry_window(uuid,text)'::regprocedure) IS DISTINCT FROM '508e59bc8d5be4439aac1e3054e7fe98' THEN
    RAISE EXCEPTION 'ADDON_ENTRY_LEVEL_PREIMAGE_CHANGED: public.fn_close_tournament_entry_window(uuid,text)';
  END IF;
  d:=pg_get_functiondef('public.fn_close_tournament_entry_window(uuid,text)'::regprocedure);
  IF strpos(d,$old$  IF public.fn_tournament_late_registration_open(p_tournament_id) THEN$old$)=0 THEN RAISE EXCEPTION 'ADDON_ENTRY_LEVEL_ANCHOR_MISSING'; END IF;
  d:=replace(d,$old$  IF public.fn_tournament_late_registration_open(p_tournament_id) THEN$old$,$new$  -- Owner 2026-10-31: elapsed minutes and a full field cannot start add-ons
  -- before the last configured late-entry level has completed. Admission
  -- retains its existing clock/cap rules; this is the add-on/pool transition.
  IF COALESCE(v_t.add_on_available,false)
     AND NOT COALESCE(v_t.prize_pool_finalized,false)
     AND COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0)>0
     AND (v_t.current_level IS NULL OR
          v_t.current_level<COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0)) THEN
    RETURN jsonb_build_object('ok',true,'entry_closed',false,
      'window_mode','levels','retry_after_ms',NULL,
      'reason','addon_waiting_for_late_entry_levels');
  END IF;
  IF public.fn_tournament_late_registration_open(p_tournament_id) THEN$new$);
  EXECUTE d;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure) IS DISTINCT FROM '1e44ecf0552411ff72487b5a69e45723' THEN
    RAISE EXCEPTION 'ADDON_ENTRY_LEVEL_PREIMAGE_CHANGED: public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)';
  END IF;
  d:=pg_get_functiondef('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure);
  IF strpos(d,$old$    IF COALESCE(v_t.prize_pool_finalized,false)
       OR upper(COALESCE(v_t.status::text,'')) NOT IN ('REGISTERING','RUNNING')$old$)=0 THEN RAISE EXCEPTION 'ADDON_ENTRY_LEVEL_ANCHOR_MISSING'; END IF;
  d:=replace(d,$old$    IF COALESCE(v_t.prize_pool_finalized,false)
       OR upper(COALESCE(v_t.status::text,'')) NOT IN ('REGISTERING','RUNNING')$old$,$new$    IF COALESCE(v_t.prize_pool_finalized,false)
       -- Owner 2026-10-31: no early add-ons, including legacy Free Buy offers.
       -- Historical receipts returned above remain replayable without charging.
       OR upper(COALESCE(v_t.status::text,'')) <> 'RUNNING'
       OR v_t.current_level IS NULL
       OR v_t.current_level<COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0)
       OR (COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0)<=0
           AND COALESCE(v_t.late_reg_mins,0)>0
           AND (v_t.started_at IS NULL OR
                clock_timestamp()<v_t.started_at+make_interval(mins=>v_t.late_reg_mins)))
       OR (COALESCE(v_t.addon_from_start,false)
           AND v_t.addon_period_ends_at-v_t.addon_period_started_at>interval '60 seconds')$new$);
  EXECUTE d;

END;
$patch$;
COMMIT;
