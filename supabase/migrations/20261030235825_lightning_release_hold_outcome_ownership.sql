-- Resolve an uncertain release hold from its committed request, never by replaying pause.
-- Scope resume to the original pause owner under the existing Cluster row lock.
-- Exact current catalog preimage includes request identity, template, size and variant guards.
-- @live-proof: (SELECT md5(pg_get_functiondef(oid)) = '8ee8d46e5e8045ca727ea7684a3474c3' FROM pg_proc WHERE oid='public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='2s';
DO $migration$
DECLARE p regprocedure := 'public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure;
 d text; old text; new text;
BEGIN
 IF NOT (SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner)='postgres'
  AND proacl @> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[]
  AND proacl <@ '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN
  RAISE EXCEPTION 'Unexpected Lightning operator security configuration';
 END IF;
 SELECT pg_get_functiondef(p) INTO d;
 IF md5(d)='8ee8d46e5e8045ca727ea7684a3474c3' THEN RETURN; END IF;
 IF md5(d)<>'e99c43433703d45dac01948de8ef77d8' THEN RAISE EXCEPTION 'Unexpected Lightning operator preimage: %',md5(d); END IF;
 old := $old$'set_integrity_telemetry'];$old$;
 new := $new$'set_integrity_telemetry', 'resolve_release_hold'];$new$;
 IF (length(d)-length(replace(d,old,'')))/length(old) <> 1 THEN RAISE EXCEPTION 'Lightning hold anchor occurrence mismatch'; END IF;
 d:=replace(d,old,new);
 old := $old$  v_prior    record;$old$;
 new := $new$  v_prior    record;
  v_expected_action text;
  v_expected_pause uuid;$new$;
 IF (length(d)-length(replace(d,old,'')))/length(old) <> 1 THEN RAISE EXCEPTION 'Lightning hold anchor occurrence mismatch'; END IF;
 d:=replace(d,old,new);
 old := $old$  -- THE UNFREEZE IS THE PLATFORM'S: a frozen Cluster is evidence.$old$;
 new := $new$  IF v_action = 'resolve_release_hold' THEN
    IF NOT v_service THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED', 'reason', 'NOT_AUTHORIZED');
    END IF;
    IF jsonb_typeof(v_args -> 'expected_action') IS DISTINCT FROM 'string'
       OR (v_args ->> 'expected_action') NOT IN ('pause', 'resume') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'expected_action_required');
    END IF;
    v_expected_action := v_args ->> 'expected_action';
  END IF;
  IF v_args ? 'expected_pause_request_id' THEN
    IF (v_action <> 'resume' AND NOT (v_action = 'resolve_release_hold' AND v_expected_action = 'resume'))
       OR jsonb_typeof(v_args -> 'expected_pause_request_id') IS DISTINCT FROM 'string'
       OR NOT ((v_args ->> 'expected_pause_request_id') ~ c_uuid) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'expected_pause_request_id_invalid');
    END IF;
    v_expected_pause := (v_args ->> 'expected_pause_request_id')::uuid;
  END IF;
  -- THE UNFREEZE IS THE PLATFORM'S: a frozen Cluster is evidence.$new$;
 IF (length(d)-length(replace(d,old,'')))/length(old) <> 1 THEN RAISE EXCEPTION 'Lightning hold anchor occurrence mismatch'; END IF;
 d:=replace(d,old,new);
 old := $old$'actor_id', v_args -> 'actor_id'));$old$;
 new := $new$'actor_id', v_args -> 'actor_id',
                                                 'expected_pause_request_id', to_jsonb(v_expected_pause)));$new$;
 IF (length(d)-length(replace(d,old,'')))/length(old) <> 1 THEN RAISE EXCEPTION 'Lightning hold anchor occurrence mismatch'; END IF;
 d:=replace(d,old,new);
 old := $old$  -- A REPEATED REQUEST IS ANSWERED, NOT DONE AGAIN.$old$;
 new := $new$  -- Resolve only the committed original answer under its original request lock.
  -- Absence is UNKNOWN: never create a request, event, pause or resume here.
  IF v_action = 'resolve_release_hold' THEN
    SELECT r.cluster_id, r.action, r.args, r.answer INTO v_prior
      FROM public.lightning_operator_request r WHERE r.request_id = v_req;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'resolved', false, 'code', 'REQUEST_OUTCOME_UNKNOWN',
        'request_id', v_req, 'cluster_id', p_cluster_id, 'action', v_expected_action);
    END IF;
    IF v_prior.cluster_id IS DISTINCT FROM p_cluster_id
       OR v_prior.action IS DISTINCT FROM v_expected_action
       OR (v_prior.args -> 'expected_pause_request_id') IS DISTINCT FROM (v_safe -> 'expected_pause_request_id') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'request_id_belongs_to_another_request');
    END IF;
    RETURN jsonb_build_object('ok', true, 'resolved', true, 'request_id', v_req,
      'cluster_id', p_cluster_id, 'action', v_expected_action, 'answer', v_prior.answer);
  END IF;

  -- A REPEATED REQUEST IS ANSWERED, NOT DONE AGAIN.$new$;
 IF (length(d)-length(replace(d,old,'')))/length(old) <> 1 THEN RAISE EXCEPTION 'Lightning hold anchor occurrence mismatch'; END IF;
 d:=replace(d,old,new);
 old := $old$SELECT r.cluster_id, r.action, r.answer INTO v_prior$old$;
 new := $new$SELECT r.cluster_id, r.action, r.args, r.answer INTO v_prior$new$;
 IF (length(d)-length(replace(d,old,'')))/length(old) <> 2 THEN RAISE EXCEPTION 'Lightning hold anchor occurrence mismatch'; END IF;
 d:=replace(d,old,new);
 old := $old$IF v_prior.cluster_id IS DISTINCT FROM p_cluster_id OR v_prior.action IS DISTINCT FROM v_action THEN$old$;
 new := $new$IF v_prior.cluster_id IS DISTINCT FROM p_cluster_id OR v_prior.action IS DISTINCT FROM v_action
       OR (v_prior.args -> 'expected_pause_request_id') IS DISTINCT FROM (v_safe -> 'expected_pause_request_id') THEN$new$;
 IF (length(d)-length(replace(d,old,'')))/length(old) <> 2 THEN RAISE EXCEPTION 'Lightning hold anchor occurrence mismatch'; END IF;
 d:=replace(d,old,new);
 old := $old$      UPDATE public.cash_games SET cluster_mode = v_from, updated_at = now() WHERE id = g.id;$old$;
 new := $new$      -- cash_games is already locked FOR UPDATE: compare the exact hold owner
      -- before any resume write. A newer foreign pause must remain paused.
      IF v_expected_pause IS NOT NULL AND v_ctl.paused_request_id IS DISTINCT FROM v_expected_pause THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'HOLD_OWNERSHIP_CHANGED', 'reason', 'HOLD_OWNERSHIP_CHANGED');
        EXIT act;
      END IF;
      UPDATE public.cash_games SET cluster_mode = v_from, updated_at = now() WHERE id = g.id;$new$;
 IF (length(d)-length(replace(d,old,'')))/length(old) <> 1 THEN RAISE EXCEPTION 'Lightning hold anchor occurrence mismatch'; END IF;
 d:=replace(d,old,new);
 IF md5(d)<>'8ee8d46e5e8045ca727ea7684a3474c3' THEN RAISE EXCEPTION 'Unexpected Lightning operator transformed image'; END IF;
 EXECUTE d;
 IF NOT (SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner)='postgres'
  AND proacl @> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[]
  AND proacl <@ '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN
  RAISE EXCEPTION 'Unexpected Lightning operator security configuration';
 END IF;
 IF md5(pg_get_functiondef(p))<>'8ee8d46e5e8045ca727ea7684a3474c3' THEN RAISE EXCEPTION 'Unexpected Lightning operator postimage'; END IF;
END $migration$;
COMMIT;
