-- The isolated two-backend counterexample committed two configuration changes
-- and two events for one global request UUID, while ON CONFLICT hid the second
-- request record. Own that UUID before taking any Cluster lock or writing.
-- Preserve authorized cross-operator replay of the original receipt.
-- @live-proof: (SELECT position('pg_try_advisory_xact_lock' in prosrc)>0 AND position('request_id_in_progress_retry_same_id' in prosrc)>0 AND position('ON CONFLICT (request_id) DO NOTHING' in prosrc)=0 FROM pg_proc WHERE oid='public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='2s';
DO $migration$
DECLARE p regprocedure := 'public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure; s text; d text; old text; new text;
BEGIN
 SELECT prosrc INTO s FROM pg_proc WHERE oid=p;
 IF NOT (SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner)='postgres' AND proacl @> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] AND proacl <@ '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN RAISE EXCEPTION 'Unexpected Lightning operator security configuration'; END IF;
 IF md5(s)='cd61ff0d246c98605e88d1f4728e56d1' THEN RETURN; END IF;
 IF md5(s)<>'5b667921b600c33b39d7b556627b0aab' THEN RAISE EXCEPTION 'Unexpected Lightning operator preimage: %',md5(s); END IF;
 SELECT pg_get_functiondef(p) INTO d;
 old:=$old$  -- A REPEATED REQUEST IS ANSWERED, NOT DONE AGAIN.$old$;
 new:=$new$  -- Global operation identity precedes every Cluster lock and side effect.
  -- Contention is a bounded, explicit pending outcome, never a saved refusal.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('lightning_operator_request:' || v_req::text, 0)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REQUEST_IN_PROGRESS',
      'reason', 'request_id_in_progress_retry_same_id', 'request_id', v_req,
      'cluster_id', p_cluster_id, 'action', v_action);
  END IF;

  -- A REPEATED REQUEST IS ANSWERED, NOT DONE AGAIN.$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Missing request ownership anchor'; END IF;
 d:=replace(d,old,new);
 old:=$old$  VALUES (v_req, g.id, v_action, v_actor, v_kind, v_reason, v_safe, v_answer)
  ON CONFLICT (request_id) DO NOTHING;$old$;
 new:=$new$  VALUES (v_req, g.id, v_action, v_actor, v_kind, v_reason, v_safe, v_answer);$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Missing fail-closed request insert anchor'; END IF;
 d:=replace(d,old,new);
 EXECUTE d;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p)<>'cd61ff0d246c98605e88d1f4728e56d1' THEN RAISE EXCEPTION 'Unexpected Lightning operator postimage: %',(SELECT md5(prosrc) FROM pg_proc WHERE oid=p); END IF;
END $migration$;
COMMIT;
