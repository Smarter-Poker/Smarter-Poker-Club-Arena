-- A/A calibration needs 30 nonempty windows within one hour. The installed
-- default is five minutes; creation ignores arbitrary Lightning overrides.
-- Add one bounded operation to the existing authenticated, locked, audited,
-- request-idempotent door. No estate config, mode or money is changed here.
-- @live-proof: (SELECT position('set_shadow_window' in prosrc)>0 AND position('drain_and_stop_worker_before_shadow_window' in prosrc)>0 FROM pg_proc WHERE oid='public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='2s';
DO $migration$
DECLARE p regprocedure := 'public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure; s text; d text;
BEGIN
 SELECT prosrc INTO s FROM pg_proc WHERE oid=p;
 IF NOT (SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner)='postgres' AND proacl @> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] AND proacl <@ '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[] FROM pg_proc WHERE oid=p) THEN RAISE EXCEPTION 'Unexpected Lightning operator security configuration'; END IF;
 IF md5(s)='29c3eb25c70f5761ecdfc391406c10d1' THEN RETURN; END IF;
 IF md5(s)<>'71d863c9348ce7e9aa47eac3a36815ab' THEN RAISE EXCEPTION 'Unexpected Lightning operator preimage: %',md5(s); END IF;
 SELECT pg_get_functiondef(p) INTO d;
 d:=replace(d,$old$'set_flag', 'set_worker_mode'];$old$,$new$'set_flag', 'set_worker_mode', 'set_shadow_window'];$new$);
 d:=replace(d,$old$'mode', v_args -> 'mode', 'actor_id'$old$,$new$'mode', v_args -> 'mode', 'shadow_window_ms', v_args -> 'shadow_window_ms', 'actor_id'$new$);
 d:=replace(d,$old$    ELSIF v_op = 'set_worker_mode' THEN$old$,$new$    ELSIF v_op = 'set_shadow_window' THEN
      -- Configure only a dark, drained Cluster: do not mix comparison windows.
      IF jsonb_typeof(v_args -> 'shadow_window_ms') IS DISTINCT FROM 'number' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'shadow_window_ms_must_be_integer_60000_to_3600000'); EXIT act;
      END IF;
      IF (v_args ->> 'shadow_window_ms')::numeric < 60000
         OR (v_args ->> 'shadow_window_ms')::numeric > 3600000
         OR trunc((v_args ->> 'shadow_window_ms')::numeric) <> (v_args ->> 'shadow_window_ms')::numeric THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'shadow_window_ms_must_be_integer_60000_to_3600000'); EXIT act;
      END IF;
      IF g.cluster_mode <> 'must_move' OR v_drain.id IS NOT NULL
         OR v_cfg ->> 'worker_mode' <> 'off' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY', 'reason', 'drain_and_stop_worker_before_shadow_window'); EXIT act;
      END IF;
      v_wait := (v_args ->> 'shadow_window_ms')::integer;
      IF (v_cfg ->> 'shadow_window_ms')::integer = v_wait THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('shadow_window_ms', v_wait);
      v_detail := jsonb_build_object('shadow_window_ms', v_wait, 'was', v_cfg -> 'shadow_window_ms');

    ELSIF v_op = 'set_worker_mode' THEN$new$);
 EXECUTE d;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p)<>'29c3eb25c70f5761ecdfc391406c10d1' THEN RAISE EXCEPTION 'Unexpected Lightning operator postimage'; END IF;
END $migration$;
COMMIT;
