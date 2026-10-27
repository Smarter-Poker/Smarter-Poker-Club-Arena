-- Owner direction 2026-10-26: cash out without a minimum stay.
-- Same club + variant + blinds returns require the full positive departing
-- stack for two hours, across tables and above the normal buy-in cap.
-- Different games/stakes remain independent. No money moves in this migration.
-- Preserve custody, purchase receipts, VPIP bars and transaction locks.
-- @live-proof: (public.fn_cash_stay_remaining_ms(600000,false,now()) = 0)
-- @live-proof: ((public.fn_cash_leave_check(NULL,NULL)->>'allowed')::boolean)
-- @live-proof: (position('LEAST(v_eff, v_max)' in pg_get_functiondef('public.fn_cash_effective_buyin(uuid)'::regprocedure)) = 0)
-- @live-proof: (position('p_stack <= COALESCE(v_s.baseline' in pg_get_functiondef('public.fn_cash_session_close(uuid,uuid,numeric,text)'::regprocedure)) = 0)
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
-- Legacy signatures remain compatible with serving engines and clients.
CREATE OR REPLACE FUNCTION public.fn_cash_stay_remaining_ms(
 p_remaining integer, p_running boolean, p_last_tick timestamptz
) RETURNS integer LANGUAGE sql SET search_path TO 'public','pg_temp'
AS $$ SELECT 0; $$;
CREATE OR REPLACE FUNCTION public.fn_cash_leave_check(p_user_id uuid,p_table_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$ SELECT jsonb_build_object('allowed',true,'stay_remaining_ms',0); $$;
REVOKE ALL ON FUNCTION public.fn_cash_leave_check(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_leave_check(uuid,uuid) TO service_role;
-- Assert exact blocks; retain all newer financial/security changes and ACLs.
DO $patch$
DECLARE v_oid oid; v_def text; v_old text; v_new text;
BEGIN

 SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_cash_effective_buyin';
 v_def := pg_get_functiondef(v_oid);
 v_old := $old$IF v_max > 0 THEN v_eff := LEAST(v_eff, v_max); END IF;$old$;
 v_new := $new$v_max := GREATEST(v_max, v_eff);$new$;
 IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
   RAISE EXCEPTION 'Return-rule source drift: fn_cash_effective_buyin';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);

 SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_cash_session_close';
 v_def := pg_get_functiondef(v_oid);
 v_old := $old$IF FOUND THEN v_window := COALESCE(v_s.rejoin_window_ms, 7200000); END IF;$old$;
 v_new := $new$v_window := 7200000; -- Owner direction: two hours from this cashout.$new$;
 IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
   RAISE EXCEPTION 'Return-rule source drift: fn_cash_session_close';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);

 SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_cash_session_close';
 v_def := pg_get_functiondef(v_oid);
 v_old := $old$IF v_s.id IS NULL OR p_stack <= COALESCE(v_s.baseline, 0) THEN RETURN; END IF;$old$;
 v_new := $new$-- Every positive departing stack has the same return requirement.$new$;
 IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
   RAISE EXCEPTION 'Return-rule source drift: fn_cash_session_close';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);

 SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_horse_seat_from_treasury_before_maintenance_gate';
 v_def := pg_get_functiondef(v_oid);
 v_old := $old$IF v_max IS NOT NULL AND v_max > 0 THEN v_eff := LEAST(v_eff, v_max); END IF;$old$;
 v_new := $new$-- The return floor is never reduced to the ordinary maximum.$new$;
 IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
   RAISE EXCEPTION 'Return-rule source drift: fn_horse_seat_from_treasury_before_maintenance_gate';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);

 SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='atomic_table_buyin_before_maintenance_announcement_gate';
 v_def := pg_get_functiondef(v_oid);
 v_old := $old$IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 AND p_amount > v_max_buy_in THEN$old$;
 v_new := $new$IF v_tournament_id IS NULL THEN
    v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
  END IF;
  IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0
     AND p_amount > GREATEST(v_max_buy_in, COALESCE(v_floor, 0)) THEN$new$;
 IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
   RAISE EXCEPTION 'Return-rule source drift: atomic_table_buyin_before_maintenance_announcement_gate';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);

 SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='atomic_table_buyin_before_maintenance_announcement_gate';
 v_def := pg_get_functiondef(v_oid);
 v_old := $old$IF v_max_buy_in IS NOT NULL AND v_max_buy_in > 0 THEN
        v_effective_min := LEAST(v_effective_min, v_max_buy_in);
      END IF;$old$;
 v_new := $new$-- A full returning stack is allowed above the ordinary maximum.$new$;
 IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
   RAISE EXCEPTION 'Return-rule source drift: atomic_table_buyin_before_maintenance_announcement_gate';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);

 SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_poker_diamond_buyin';
 v_def := pg_get_functiondef(v_oid);
 v_old := $old$ v_custody:=public.fn_poker_diamond_reserve$old$;
 v_new := $new$ -- Same return requirement as every cash seat, under table_cap serialization.
 IF p_amount < GREATEST(coalesce(v_t.min_buy_in,0),
       coalesce(public.fn_cash_rejoin_floor(p_user_id,p_table_id),0)) THEN
   RAISE EXCEPTION 'BUYIN_BELOW_FLOOR: minimum buy-in for this game right now is %',
     GREATEST(coalesce(v_t.min_buy_in,0),
       coalesce(public.fn_cash_rejoin_floor(p_user_id,p_table_id),0))
     USING ERRCODE='23514';
 END IF;
 IF v_t.max_buy_in>0 AND p_amount>GREATEST(v_t.max_buy_in,
       coalesce(public.fn_cash_rejoin_floor(p_user_id,p_table_id),0)) THEN
   RAISE EXCEPTION 'Buy-in above table maximum';
 END IF;
 v_custody:=public.fn_poker_diamond_reserve$new$;
 IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
   RAISE EXCEPTION 'Return-rule source drift: fn_poker_diamond_buyin';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);


 SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='fn_horse_seat_from_treasury_before_maintenance_gate';
 v_def := pg_get_functiondef(v_oid);
 v_old := 'v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);';
 v_new := $new$PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
  v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
  IF v_max IS NOT NULL AND v_max > 0 AND p_amount > GREATEST(v_max, COALESCE(v_floor, 0)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'BUYIN_ABOVE_MAX');
  END IF;$new$;
 IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
   RAISE EXCEPTION 'Return-rule source drift: horse floor serialization';
 END IF;
 EXECUTE replace(v_def,v_old,v_new);

 SELECT pg_get_functiondef('public.fn_ca_cash_entry_need(uuid,uuid)'::regprocedure) INTO v_def;
 v_old := 'IF v_max IS NOT NULL AND v_max > 0 THEN';
 IF position(v_old in v_def)=0 OR position('v_need := LEAST(v_need, v_max);' in v_def)=0 THEN
   RAISE EXCEPTION 'Return-rule source drift: fn_ca_cash_entry_need';
 END IF;
 EXECUTE replace(v_def,v_old,'IF v_tournament IS NOT NULL AND v_max IS NOT NULL AND v_max > 0 THEN');
END $patch$;
COMMIT;
