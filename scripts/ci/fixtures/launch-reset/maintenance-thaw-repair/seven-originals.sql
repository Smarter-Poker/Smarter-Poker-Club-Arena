SET check_function_bodies=false;
CREATE OR REPLACE FUNCTION public.fn_ca_engine_operator_command(p_actor_id uuid, p_operation_id uuid, p_domain text, p_action text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v public.ca_engine_operator_commands; v_permissions jsonb; v_announcement timestamptz; v_before jsonb; v_close_targets uuid[];
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 v_permissions := public.fn_ca_operator_permissions(p_actor_id)->'permissions';
 IF jsonb_typeof(v_permissions) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'engine_operator_authority_unknown' USING ERRCODE='58000'; END IF;
 IF NOT coalesce(v_permissions ? CASE WHEN p_domain='floor' THEN 'clubs.write' ELSE 'settings.write' END,false) THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 IF p_operation_id IS NULL OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500 OR p_domain NOT IN ('floor','maintenance') THEN RAISE EXCEPTION 'invalid_operator_command'; END IF;
 PERFORM pg_advisory_xact_lock(530093);
 SELECT * INTO v FROM public.ca_engine_operator_commands WHERE id=p_operation_id FOR UPDATE;
 IF FOUND THEN
  IF v.actor_id<>p_actor_id OR v.domain<>p_domain THEN RAISE EXCEPTION 'operation_identity_conflict'; END IF;
  v_before:=to_jsonb(v);
  IF p_action IN ('cancel','end') AND p_domain='maintenance' THEN
   IF p_action='cancel' AND v.status='queued' AND clock_timestamp()<v.announced_at THEN
    UPDATE public.ca_engine_operator_commands SET status='cancelled',updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
    PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.maintenance.cancel','engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason),v_before,to_jsonb(v),NULL,NULL,v.id::text||':cancel');
   ELSIF p_action='cancel' AND v.status<>'cancelled' THEN RAISE EXCEPTION 'maintenance_already_applied';
   ELSIF p_action='end' AND v.status NOT IN ('applying','active','completed') THEN RAISE EXCEPTION 'maintenance_request_not_applied';
   ELSIF p_action='end' AND clock_timestamp()<v.announced_at+interval '7 minutes' THEN RAISE EXCEPTION 'maintenance_deadline_not_reached';
   ELSIF p_action='end' AND v.end_requested_at IS NULL THEN
    UPDATE public.ca_engine_operator_commands SET end_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
    PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.maintenance.end','engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason),v_before,to_jsonb(v),NULL,NULL,v.id::text||':end');
   END IF;
  ELSIF v.action<>p_action OR v.reason<>p_reason THEN RAISE EXCEPTION 'operation_identity_conflict'; END IF;
  RETURN to_jsonb(v);
 END IF;
 IF p_domain='maintenance' AND p_action='start' THEN
  v_announcement:=date_trunc('hour',clock_timestamp())+interval '53 minutes';
  IF v_announcement<=clock_timestamp() THEN v_announcement:=v_announcement+interval '1 hour'; END IF;
  IF EXISTS(SELECT 1 FROM public.ca_engine_operator_commands WHERE domain='maintenance' AND status='queued') THEN RAISE EXCEPTION 'maintenance_request_already_queued'; END IF;
  INSERT INTO public.ca_engine_operator_commands(id,actor_id,domain,action,reason,status,announced_at,result,created_at,updated_at) VALUES(p_operation_id,p_actor_id,p_domain,p_action,p_reason,'queued',v_announcement,NULL,clock_timestamp(),clock_timestamp()) RETURNING * INTO v;
 ELSIF p_domain='floor' AND p_action IN ('pause','park','resume','close_cash') THEN
  IF p_action='close_cash' THEN
   -- Capture and lock the original full target set; never silently omit custody.
   SELECT coalesce(array_agg(t.id ORDER BY t.id),ARRAY[]::uuid[]) INTO v_close_targets
   FROM (SELECT id FROM public.tables st WHERE tournament_id IS NULL AND status IN ('running','active','waiting') AND (NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=p_operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=p_operation_id AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids)))) ORDER BY id FOR UPDATE) t;
   IF EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(v_close_targets) AND
      (is_deleted IS DISTINCT FROM false OR game_type IS DISTINCT FROM 'cash')) THEN
    RAISE EXCEPTION 'cash_floor_close_target_not_executable' USING ERRCODE='22023';
   END IF;
  END IF;
  INSERT INTO public.ca_engine_operator_commands(id,actor_id,domain,action,reason,status) VALUES(p_operation_id,p_actor_id,p_domain,p_action,p_reason,'accepted') RETURNING * INTO v;
  IF p_action='resume' THEN DELETE FROM public.ca_operator_floor_hold WHERE id=true;
  ELSIF p_action IN ('pause','park') THEN
   INSERT INTO public.ca_operator_floor_hold VALUES(true,p_operation_id,p_action,p_reason) ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,mode=excluded.mode,reason=excluded.reason;
  ELSE
   IF EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE status='pending') THEN RAISE EXCEPTION 'cash_floor_close_in_progress'; END IF;
   INSERT INTO public.ca_operator_table_closes(table_id,operation_id,actor_id,reason)
    SELECT id,p_operation_id,p_actor_id,p_reason FROM public.tables WHERE id=ANY(v_close_targets)
    ON CONFLICT(table_id) DO UPDATE SET operation_id=excluded.operation_id,actor_id=excluded.actor_id,reason=excluded.reason,status='pending' WHERE public.ca_operator_table_closes.status='closed';
   UPDATE public.ca_engine_operator_commands SET status=CASE WHEN EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id) THEN 'accepted' ELSE 'completed' END,result=jsonb_build_object('targetedTables',(SELECT count(*) FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id),'scope','cash_tables_only') WHERE id=p_operation_id RETURNING * INTO v;
  END IF;
 ELSE RAISE EXCEPTION 'invalid_operator_command'; END IF;
 PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.'||p_domain||'.'||p_action,'engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason,'operation_id',v.id),NULL,to_jsonb(v),NULL,NULL,v.id::text||':'||p_action);
 RETURN to_jsonb(v);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_engine_operator_observe(p_operation_id uuid, p_status text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 IF p_status NOT IN ('active','completed','accepted') THEN RAISE EXCEPTION 'invalid_operator_status'; END IF;
 UPDATE public.ca_engine_operator_commands SET status=p_status,result=p_result,updated_at=clock_timestamp()
 WHERE id=p_operation_id AND status<>'cancelled';
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_engine_operator_observe(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_operator_observe(uuid,text,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_launch_operator_command(p_actor uuid, p_operation uuid, p_action text, p_reason text, p_owned_park uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE existing public.ca_launch_operator_scopes; current_hold public.ca_operator_floor_hold;
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' OR p_operation IS NULL OR p_actor IS NULL OR p_action NOT IN('park','close_cash','resume') THEN RAISE EXCEPTION 'launch_operator_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(530093);
 SELECT * INTO existing FROM public.ca_launch_operator_scopes WHERE operation_id=p_operation;
 IF FOUND AND existing.actor_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'launch_operator_identity_conflict'; END IF;
 IF p_action='resume' AND EXISTS(SELECT 1 FROM public.ca_engine_operator_commands c WHERE c.id=p_operation AND c.actor_id=p_actor AND c.domain='floor' AND c.action='resume') THEN RETURN public.fn_ca_engine_operator_command(p_actor,p_operation,'floor',p_action,p_reason); END IF;
 SELECT * INTO current_hold FROM public.ca_operator_floor_hold;
 IF p_action='park' AND current_hold.operation_id IS NOT NULL AND current_hold.operation_id IS DISTINCT FROM p_operation THEN RAISE EXCEPTION 'launch_operator_other_hold_active'; END IF;
 IF p_action IN('close_cash','resume') AND (p_owned_park IS NULL OR current_hold.operation_id IS DISTINCT FROM p_owned_park OR NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=p_owned_park AND m.actor_id=p_actor)) THEN RAISE EXCEPTION 'launch_operator_own_park_required'; END IF;
 INSERT INTO public.ca_launch_operator_scopes(operation_id,actor_id,club_ids) VALUES(p_operation,p_actor,ARRAY['a0000000-0000-0000-0000-000000000001','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','fade0000-0000-0000-0000-000000000001']::uuid[]) ON CONFLICT(operation_id) DO NOTHING;
 IF p_action='resume' THEN
  IF EXISTS(SELECT 1 FROM public.ca_operator_table_closes c JOIN public.ca_launch_operator_scopes m ON m.operation_id=c.operation_id JOIN public.ca_engine_operator_commands cmd ON cmd.id=c.operation_id JOIN public.ca_engine_operator_commands parkcmd ON parkcmd.id=p_owned_park WHERE m.actor_id=p_actor AND c.actor_id=p_actor AND cmd.created_at>=parkcmd.created_at AND c.status='pending') THEN RAISE EXCEPTION 'launch_operator_pending_closes'; END IF;
  INSERT INTO public.ca_launch_floor_resume_receipts(table_id,close_operation_id,park_operation_id,resume_operation_id,actor_id)
  SELECT c.table_id,c.operation_id,p_owned_park,p_operation,p_actor FROM public.ca_operator_table_closes c
  JOIN public.ca_launch_operator_scopes m ON m.operation_id=c.operation_id AND m.actor_id=p_actor
  JOIN public.ca_engine_operator_commands cmd ON cmd.id=c.operation_id AND cmd.actor_id=p_actor AND cmd.domain='floor' AND cmd.action='close_cash' AND cmd.status='completed'
  JOIN public.ca_engine_operator_commands parkcmd ON parkcmd.id=p_owned_park
  JOIN public.tables t ON t.id=c.table_id AND t.tournament_id IS NULL AND (t.club_id=ANY(m.club_ids) OR t.union_id=ANY(m.club_ids))
  WHERE c.actor_id=p_actor AND c.status='closed' AND cmd.created_at>=parkcmd.created_at
  ON CONFLICT(table_id,close_operation_id) DO NOTHING;
 END IF;
 RETURN public.fn_ca_engine_operator_command(p_actor,p_operation,'floor',p_action,p_reason);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_launch_operator_command(uuid,uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_launch_operator_command(uuid,uuid,text,text,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_operator_finish_cash_close(p_table_id uuid, p_operation_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.tables WHERE id=p_table_id AND tournament_id IS NULL FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE table_id=p_table_id AND operation_id=p_operation_id AND status='pending') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table_id AND is_complete=false) THEN RETURN false; END IF;
 UPDATE public.tables SET status='closed' WHERE id=p_table_id;
 UPDATE public.ca_operator_table_closes SET status='closed' WHERE table_id=p_table_id AND operation_id=p_operation_id;
 IF NOT EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id AND status='pending') THEN
  UPDATE public.ca_engine_operator_commands SET status='completed',updated_at=clock_timestamp() WHERE id=p_operation_id;
 END IF;
 RETURN true;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_operator_finish_cash_close(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_finish_cash_close(uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_tournament_id uuid;
BEGIN
 IF TG_OP='INSERT' AND TG_TABLE_NAME='chip_ledger' AND NEW.metadata->>'entry_kind'='launch_closing_position' THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN
    v_old_tournament_id:=NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP<>'DELETE' THEN
    v_new_tournament_id:=NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
      USING ERRCODE='55000';
  END IF;
  v_tournament_id:=COALESCE(v_new_tournament_id,v_old_tournament_id);
  IF v_tournament_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='chip_ledger' AND TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=v_tournament_id) THEN
    RAISE EXCEPTION 'cancelled tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_cancelled_tournament_evidence_is_immutable() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.fn_satellite_transfer_ledger_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_target_id uuid;
  v_text text;
  v_row jsonb;
  v_status text;
BEGIN
 IF TG_OP='INSERT' AND TG_TABLE_NAME='chip_ledger' AND NEW.metadata->>'entry_kind'='launch_closing_position' THEN RETURN NEW; END IF;
  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.from_entity_id IS DISTINCT FROM OLD.from_entity_id
       OR NEW.to_entity_id IS DISTINCT FROM OLD.to_entity_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR (NEW.metadata->>'satellite_id') IS DISTINCT FROM
          (OLD.metadata->>'satellite_id')) THEN
    RAISE EXCEPTION 'satellite transfer journal ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_row IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  ] LOOP
    IF v_row IS NULL THEN CONTINUE; END IF;
    v_text := v_row->>'tournament_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    IF v_row->>'from_type' = 'prize_liability' THEN
      v_text := v_row->>'from_entity_id';
      IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_source_ids := array_append(v_source_ids,v_text::uuid);
      END IF;
    END IF;
    v_text := split_part(COALESCE(v_row->>'idempotency_key',''),':',2);
    IF COALESCE(v_row->>'idempotency_key','') LIKE 'tourney:%:seat:%:pool_transfer'
       AND v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    v_text := v_row->'metadata'->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
  END LOOP;
  IF TG_OP <> 'INSERT' AND cardinality(v_source_ids) > 0 THEN
    RAISE EXCEPTION 'satellite transfer journal is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.to_type = 'prize_liability' THEN
    SELECT t.id INTO v_target_id FROM public.tournaments t
     WHERE t.id = NEW.to_entity_id;
    IF v_target_id IS NOT NULL THEN
      -- The transfer's AFTER trigger writes target escrow, so own the target
      -- before any source root exactly as fn_settle_satellite_tournament does.
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_target_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'terminal target cannot accept a satellite transfer journal'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  FOR v_source_id IN
    SELECT DISTINCT source.id FROM unnest(v_source_ids) source(id)
     WHERE source.id IS NOT NULL ORDER BY source.id
  LOOP
    IF TG_OP = 'INSERT' AND v_source_id IS DISTINCT FROM v_target_id THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_source_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'completed satellite transfer journal is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF public.fn_ca_has_committed_tournament_receipt(v_source_id) THEN
      RAISE EXCEPTION 'completed satellite transfer journal is immutable'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_satellite_transfer_ledger_is_immutable() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_status text;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
 IF TG_OP='INSERT' AND TG_TABLE_NAME='chip_ledger' AND NEW.metadata->>'entry_kind'='launch_closing_position' THEN RETURN NEW; END IF;
  IF TG_OP<>'DELETE' AND public.fn_ca_legacy_fee_resolution_write_is_exact(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    v_tournament_id := NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid IS DISTINCT FROM
       NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid THEN
      RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  ELSE
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;

  IF v_tournament_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND to_jsonb(OLD) ? 'terminal_closed_at' THEN
    v_old_marker := NULLIF(to_jsonb(OLD)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP <> 'DELETE' AND to_jsonb(NEW) ? 'terminal_closed_at' THEN
    v_new_marker := NULLIF(to_jsonb(NEW)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION '% rows cannot supply a terminal marker',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% terminal marker transition is not canonical',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  -- A journal row is durable testimony from the instant it names a
  -- tournament. Refuse its UPDATE/DELETE without taking a child-to-parent
  -- lock; a row trigger already owns the child tuple at this point. INSERT is
  -- the only operation that takes the root lock, which preserves the
  -- parent-to-child order used by both terminal authorities.
  IF TG_TABLE_NAME = 'chip_ledger' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = v_tournament_id)
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION
      'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_terminal_tournament_evidence_is_immutable() FROM PUBLIC;
