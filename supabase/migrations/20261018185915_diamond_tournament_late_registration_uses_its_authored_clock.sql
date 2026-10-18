-- The Diamond creator stored the literal 8 in a minutes column regardless of
-- its authored level cutoff. A 12 x 10-minute Sunday event therefore closed
-- entry after 8 minutes. Derive the clock using the same indexed ladder rule
-- as the engine creators. Existing earliest-deadline admission remains intact.
-- Only legacy unfinalized Diamond MTT windows are corrected; terminal/finalized
-- events, deliberate zero windows, satellite/SNG formats and financial rows stay intact.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $guard$ BEGIN
 IF to_regprocedure('public.fn_ca_mtt_late_registration_minutes(jsonb,integer)') IS NOT NULL THEN
  RAISE EXCEPTION 'diamond_late_clock_migration_already_installed'; END IF;
 IF md5(pg_get_functiondef('public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure))
    <> 'd0202381846547fd841d4184d023404b' THEN RAISE EXCEPTION 'diamond_late_clock_preimage_changed'; END IF;
END $guard$;
CREATE FUNCTION public.fn_ca_mtt_late_registration_minutes(p_structure jsonb,p_levels integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $clock$
DECLARE r jsonb; idx integer:=0; mins numeric; secs numeric; duration_ms numeric;
 total_ms numeric:=0; last_ms numeric:=0; result numeric;
BEGIN
 IF p_levels IS NULL OR p_levels<0 THEN RAISE EXCEPTION 'Invalid tournament late-registration level count' USING ERRCODE='22023'; END IF;
 IF p_levels=0 THEN RETURN 0; END IF;
 IF p_structure IS NULL OR jsonb_typeof(p_structure)<>'array' THEN RAISE EXCEPTION 'Missing tournament late-registration clock' USING ERRCODE='22023'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_structure) LOOP
  idx:=idx+1;
  IF r->'isBreak'='true'::jsonb THEN CONTINUE; END IF;
  mins:=public.fn_ca_blind_contract_number(COALESCE(NULLIF(r->'durationMinutes','null'::jsonb),r->'duration_minutes'));
  secs:=public.fn_ca_blind_contract_number(r->'duration');
  duration_ms:=CASE WHEN mins>0 THEN mins*60000 ELSE secs*1000 END;
  IF duration_ms IS NULL OR duration_ms<=0 THEN RAISE EXCEPTION 'Invalid tournament late-registration clock' USING ERRCODE='22023'; END IF;
  last_ms:=duration_ms;
  IF idx<=p_levels THEN total_ms:=total_ms+duration_ms; END IF;
 END LOOP;
 IF last_ms<=0 THEN RAISE EXCEPTION 'Missing tournament late-registration clock' USING ERRCODE='22023'; END IF;
 IF p_levels>idx THEN total_ms:=total_ms+(p_levels-idx)*last_ms; END IF;
 result:=ceil(total_ms/60000);
 IF result>2147483647 THEN RAISE EXCEPTION 'Tournament late-registration minutes exceed the database range' USING ERRCODE='22023'; END IF;
 RETURN result::integer;
END $clock$;
ALTER FUNCTION public.fn_ca_mtt_late_registration_minutes(jsonb,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_mtt_late_registration_minutes(jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE before_def text; after_def text; before_meta jsonb; after_meta jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig)
 INTO before_def,before_meta FROM pg_proc WHERE oid='public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure;
 IF md5(before_def)<>'d0202381846547fd841d4184d023404b' THEN RAISE EXCEPTION 'diamond_late_clock_preimage_changed'; END IF;
 after_def:=replace(replace(before_def,$oldlevels$CASE WHEN v_satellite THEN 0 ELSE COALESCE((v_cfg->>'lateRegLevels')::int,$oldlevels$,$newlevels$CASE WHEN v_satellite OR v_type='sng' THEN 0 ELSE COALESCE((v_cfg->>'lateRegLevels')::int,$newlevels$),$oldclock$CASE WHEN v_satellite THEN 0 ELSE 8 END,$oldclock$,$newclock$CASE WHEN v_satellite OR v_type='sng' THEN 0 ELSE
      public.fn_ca_mtt_late_registration_minutes(v_blinds,
        COALESCE((v_cfg->>'lateRegLevels')::int,
          CASE WHEN v_door='schedule' THEN (v_cfg->>'lateRegistrationLevels')::int END,8)) END,$newclock$);
 IF md5(after_def)<>'df0299322b55f04207f82f396af73cb3' THEN RAISE EXCEPTION 'diamond_late_clock_postimage_changed'; END IF;
 EXECUTE after_def;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig)
 INTO after_meta FROM pg_proc WHERE oid='public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef('public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure))<>'df0299322b55f04207f82f396af73cb3' THEN
  RAISE EXCEPTION 'diamond_late_clock_authority_changed'; END IF;
END $patch$;
DO $guard_patch$
DECLARE before_def text;after_def text;before_meta jsonb;after_meta jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig)
 INTO before_def,before_meta FROM pg_proc WHERE oid='public.fn_guard_managed_game_lifecycle()'::regprocedure;
 IF md5(before_def)<>'d223c76125333604fde0fc88afb372ad' THEN RAISE EXCEPTION 'diamond_late_lifecycle_preimage_changed'; END IF;
 after_def:=replace(before_def,$old$        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN$old$,$new$        -- Root may correct only the known literal-eight Diamond clock to its
        -- authored indexed ladder. Every other protected field still runs below.
        CONTINUE WHEN v_key='late_reg_mins' AND current_user='postgres'
          AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
          AND OLD.tournament_type='MTT' AND OLD.late_reg_mins=8
          AND OLD.late_reg_levels>0 AND NOT COALESCE(OLD.prize_pool_finalized,false)
          AND (OLD.status IN ('ANNOUNCED','REGISTERING') OR
               (OLD.status='RUNNING' AND COALESCE(OLD.current_level,0)<OLD.late_reg_levels))
          AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=OLD.club_id AND c.asset='diamonds' AND c.is_platform IS TRUE)
          AND NEW.late_reg_mins=public.fn_ca_mtt_late_registration_minutes(OLD.blind_structure::jsonb,OLD.late_reg_levels);
        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN$new$);
 IF md5(after_def)<>'aee3ce7c8c280acbb274556ff8997c84' THEN RAISE EXCEPTION 'diamond_late_lifecycle_postimage_changed'; END IF;
 EXECUTE after_def;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl::text,'security_definer',prosecdef,'config',proconfig)
 INTO after_meta FROM pg_proc WHERE oid='public.fn_guard_managed_game_lifecycle()'::regprocedure;
 IF after_meta IS DISTINCT FROM before_meta OR md5(pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure))<>'aee3ce7c8c280acbb274556ff8997c84' THEN
  RAISE EXCEPTION 'diamond_late_lifecycle_authority_changed'; END IF;
END $guard_patch$;
-- Correct only the demonstrated literal-eight postimage while its authored
-- level window is still eligible. Never reopen a finalized prize pool.
UPDATE public.tournaments t SET late_reg_mins=public.fn_ca_mtt_late_registration_minutes(t.blind_structure::jsonb,t.late_reg_levels),updated_at=now()
FROM public.clubs c WHERE c.id=t.club_id AND c.asset='diamonds' AND c.is_platform IS TRUE
 AND t.tournament_type='MTT' AND t.late_reg_mins=8 AND t.late_reg_levels>0
 AND NOT COALESCE(t.prize_pool_finalized,false)
 AND (t.status IN ('ANNOUNCED','REGISTERING') OR
      (t.status='RUNNING' AND COALESCE(t.current_level,0)<t.late_reg_levels))
 AND public.fn_ca_mtt_late_registration_minutes(t.blind_structure::jsonb,t.late_reg_levels)<>8;
COMMIT;
