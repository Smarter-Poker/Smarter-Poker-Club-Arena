BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $patch$
DECLARE v_oid regprocedure:=to_regprocedure('public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)'); v_source text; v_expected text;
BEGIN
 IF v_oid IS NULL THEN RAISE EXCEPTION 'close_cash_owner_missing'; END IF;
 v_source:=pg_get_functiondef(v_oid);
 IF position('cash_floor_close_target_not_executable' IN v_source)=0 THEN RAISE EXCEPTION 'close_cash_rollback_postimage_missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[]) OR has_function_privilege('anon',v_oid,'EXECUTE') OR has_function_privilege('authenticated',v_oid,'EXECUTE') OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN RAISE EXCEPTION 'close_cash_owner_security_changed'; END IF;
 IF (length(v_source)-length(replace(v_source,$old0$DECLARE v public.ca_engine_operator_commands; v_permissions jsonb; v_announcement timestamptz; v_before jsonb; v_close_targets uuid[];$old0$,'')))/length($old0$DECLARE v public.ca_engine_operator_commands; v_permissions jsonb; v_announcement timestamptz; v_before jsonb; v_close_targets uuid[];$old0$)<>1 THEN RAISE EXCEPTION 'close_cash_patch_anchor_0_changed'; END IF;
 v_source:=replace(v_source,$old0$DECLARE v public.ca_engine_operator_commands; v_permissions jsonb; v_announcement timestamptz; v_before jsonb; v_close_targets uuid[];$old0$,$new0$DECLARE v public.ca_engine_operator_commands; v_permissions jsonb; v_announcement timestamptz; v_before jsonb;$new0$);
 IF (length(v_source)-length(replace(v_source,$old1$ ELSIF p_domain='floor' AND p_action IN ('pause','park','resume','close_cash') THEN
  IF p_action='close_cash' THEN
   -- Capture and lock the original full target set; never silently omit custody.
   SELECT coalesce(array_agg(t.id ORDER BY t.id),ARRAY[]::uuid[]) INTO v_close_targets
   FROM (SELECT id FROM public.tables WHERE tournament_id IS NULL AND status IN ('running','active','waiting') ORDER BY id FOR UPDATE) t;
   IF EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(v_close_targets) AND
      (is_deleted IS DISTINCT FROM false OR game_type IS DISTINCT FROM 'cash')) THEN
    RAISE EXCEPTION 'cash_floor_close_target_not_executable' USING ERRCODE='22023';
   END IF;
  END IF;
  INSERT$old1$,'')))/length($old1$ ELSIF p_domain='floor' AND p_action IN ('pause','park','resume','close_cash') THEN
  IF p_action='close_cash' THEN
   -- Capture and lock the original full target set; never silently omit custody.
   SELECT coalesce(array_agg(t.id ORDER BY t.id),ARRAY[]::uuid[]) INTO v_close_targets
   FROM (SELECT id FROM public.tables WHERE tournament_id IS NULL AND status IN ('running','active','waiting') ORDER BY id FOR UPDATE) t;
   IF EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(v_close_targets) AND
      (is_deleted IS DISTINCT FROM false OR game_type IS DISTINCT FROM 'cash')) THEN
    RAISE EXCEPTION 'cash_floor_close_target_not_executable' USING ERRCODE='22023';
   END IF;
  END IF;
  INSERT$old1$)<>1 THEN RAISE EXCEPTION 'close_cash_patch_anchor_1_changed'; END IF;
 v_source:=replace(v_source,$old1$ ELSIF p_domain='floor' AND p_action IN ('pause','park','resume','close_cash') THEN
  IF p_action='close_cash' THEN
   -- Capture and lock the original full target set; never silently omit custody.
   SELECT coalesce(array_agg(t.id ORDER BY t.id),ARRAY[]::uuid[]) INTO v_close_targets
   FROM (SELECT id FROM public.tables WHERE tournament_id IS NULL AND status IN ('running','active','waiting') ORDER BY id FOR UPDATE) t;
   IF EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(v_close_targets) AND
      (is_deleted IS DISTINCT FROM false OR game_type IS DISTINCT FROM 'cash')) THEN
    RAISE EXCEPTION 'cash_floor_close_target_not_executable' USING ERRCODE='22023';
   END IF;
  END IF;
  INSERT$old1$,$new1$ ELSIF p_domain='floor' AND p_action IN ('pause','park','resume','close_cash') THEN
  INSERT$new1$);
 IF (length(v_source)-length(replace(v_source,$old2$SELECT id,p_operation_id,p_actor_id,p_reason FROM public.tables WHERE id=ANY(v_close_targets)$old2$,'')))/length($old2$SELECT id,p_operation_id,p_actor_id,p_reason FROM public.tables WHERE id=ANY(v_close_targets)$old2$)<>1 THEN RAISE EXCEPTION 'close_cash_patch_anchor_2_changed'; END IF;
 v_source:=replace(v_source,$old2$SELECT id,p_operation_id,p_actor_id,p_reason FROM public.tables WHERE id=ANY(v_close_targets)$old2$,$new2$SELECT id,p_operation_id,p_actor_id,p_reason FROM public.tables WHERE tournament_id IS NULL AND status IN ('running','active','waiting')$new2$);
 IF md5(v_source)<>'f6d78897576ce5a925ca454437cb9e91' THEN RAISE EXCEPTION 'close_cash_rollback_source_drift'; END IF;
 v_expected:=v_source; EXECUTE v_source;
 IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'close_cash_postimage_mismatch'; END IF;
END $patch$;
COMMIT;
