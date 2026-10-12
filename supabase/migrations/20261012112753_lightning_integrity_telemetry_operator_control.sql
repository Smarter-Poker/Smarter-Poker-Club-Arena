-- Phase 1: expose dark-Cluster setup values and add the missing audited
-- integrity telemetry configuration door. No estate configuration is changed.
-- @live-proof: (SELECT position('set_integrity_telemetry' in prosrc)>0 AND position('drain_and_stop_worker_before_integrity_telemetry' in prosrc)>0 FROM pg_proc WHERE oid='public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='2s';
DO $migration$
DECLARE p regprocedure; s text; d text; pre text; post text; old text; new text; acl aclitem[]; sd boolean;
BEGIN
 FOR p,pre,post,sd,acl IN SELECT * FROM (VALUES
 ('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure,'29c3eb25c70f5761ecdfc391406c10d1','5b667921b600c33b39d7b556627b0aab',true,'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::aclitem[]),
 ('public.fn_lightning_operator_state(uuid)'::regprocedure,'6958384c35470086fc804ec6b41abad3','2200537b76a00b16ec9c99796d43b037',false,'{postgres=X/postgres,service_role=X/postgres}'::aclitem[]),
 ('public.fn_lightning_operator_cluster_row(uuid,timestamp with time zone)'::regprocedure,'f890680d292ec3d5b2098899d5e5f657','a7af10abb64de5faa344c1e10e13458d',true,'{postgres=X/postgres,service_role=X/postgres}'::aclitem[])
 ) AS targets(p,pre,post,sd,acl) LOOP
 SELECT prosrc INTO s FROM pg_proc WHERE oid=p;
 IF NOT (SELECT prosecdef=sd AND proconfig=ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner)='postgres' AND proacl @> acl AND proacl <@ acl FROM pg_proc WHERE oid=p) THEN RAISE EXCEPTION 'Unexpected Lightning security configuration: %',p; END IF;
 IF md5(s)=post THEN CONTINUE; END IF;
 IF md5(s)<>pre THEN RAISE EXCEPTION 'Unexpected Lightning preimage %: %',p,md5(s); END IF;
 SELECT pg_get_functiondef(p) INTO d;
 IF p='public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure THEN
 old:=$old$'set_worker_mode', 'set_shadow_window'];$old$;
 new:=$new$'set_worker_mode', 'set_shadow_window', 'set_integrity_telemetry'];$new$;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Missing control action anchor'; END IF;
 d:=replace(d,old,new);
 old:=$old$    ELSIF v_op = 'set_worker_mode' THEN$old$;
 new:=$new$    ELSIF v_op = 'set_integrity_telemetry' THEN
      IF jsonb_typeof(v_args -> 'value') IS DISTINCT FROM 'boolean' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'INVALID_ARGS', 'reason', 'value_must_be_boolean'); EXIT act;
      END IF;
      IF g.cluster_mode <> 'must_move' OR v_drain.id IS NOT NULL
         OR v_cfg ->> 'worker_mode' <> 'off' THEN
        v_answer := jsonb_build_object('ok', false, 'code', 'CLUSTER_BUSY', 'reason', 'drain_and_stop_worker_before_integrity_telemetry'); EXIT act;
      END IF;
      v_value := (v_args ->> 'value')::boolean;
      IF (v_cfg ->> 'integrity_telemetry')::boolean IS NOT DISTINCT FROM v_value THEN
        v_answer := jsonb_build_object('ok', true, 'already', true); EXIT act;
      END IF;
      v_patch := jsonb_build_object('integrity_telemetry', v_value);
      v_detail := jsonb_build_object('integrity_telemetry', v_value, 'was', v_cfg -> 'integrity_telemetry');

    ELSIF v_op = 'set_worker_mode' THEN$new$;
 ELSE
 old:=$old$    'joins_enabled', coalesce((v_cfg ->> 'lightning_joins_enabled')::boolean, true),$old$;
 new:=old||E'\n    ''shadow_window_ms'', (v_cfg ->> ''shadow_window_ms'')::integer,';
 IF p='public.fn_lightning_operator_state(uuid)'::regprocedure THEN
 new:=new||E'\n    ''integrity_telemetry'', coalesce((v_cfg ->> ''integrity_telemetry'')::boolean, false),';
 END IF;
 END IF;
 IF position(old in d)=0 THEN RAISE EXCEPTION 'Missing Lightning rewrite anchor: %',p; END IF;
 d:=replace(d,old,new);
 EXECUTE d;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=p)<>post THEN RAISE EXCEPTION 'Unexpected Lightning postimage %: %',p,(SELECT md5(prosrc) FROM pg_proc WHERE oid=p); END IF;
 END LOOP;
END $migration$;
COMMIT;
