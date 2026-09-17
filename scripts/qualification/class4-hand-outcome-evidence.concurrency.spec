# SOURCE ONLY / UNRUN. PostgreSQL isolationtester input.
# The native owner must install the guarded exact candidate in an EMPTY
# disposable catalog first and bind app.class4_execution_uuid on all sessions.
setup
{
  SET statement_timeout='20s';
  SET lock_timeout='15s';
  DO $$BEGIN
    IF current_user<>'postgres' OR current_database() IS DISTINCT FROM
      'class4_native_'||replace(current_setting('app.class4_execution_uuid',true),'-','')
      OR current_setting('app.class4_execution_uuid',true) !~
      ('^'||repeat('[0-9a-f]',8)||'-'||repeat('[0-9a-f]',4)||'-'||repeat('[0-9a-f]',4)||'-'||repeat('[0-9a-f]',4)||'-'||repeat('[0-9a-f]',12)||'$')
      OR md5(pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure))
         IS DISTINCT FROM 'edd4397b2daeadade433cd01a26a1c70'
      OR EXISTS(SELECT 1 FROM public.financial_alerts)
      OR EXISTS(SELECT 1 FROM public.hand_atomic_commits) THEN
      RAISE EXCEPTION 'exact isolated native Class4 candidate required';
    END IF;
  END$$;
  SET session_replication_role=replica;
  INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,
    stack_result,post_commit_payload,post_commit_request_hash,post_commit_payload_hash,
    post_commit_completed_at,post_commit_result)
  VALUES('71000000-0000-4000-8000-000000000001',7100001,
    '71000000-0000-4000-8000-000000000002',repeat('a',64),jsonb_build_object(),
    jsonb_build_object('version',1),repeat('b',64),
    encode(extensions.digest(convert_to(jsonb_build_object('version',1)::text,'UTF8'),'sha256'),'hex'),
    '2026-09-15T04:32:28.138880Z',
    jsonb_build_object('ok',true,'hand_id','71000000-0000-4000-8000-000000000002','hand_number',7100001));
  INSERT INTO public.financial_alerts(id,severity,source,message,context)
  VALUES('71000000-0000-4000-8000-000000000003','critical',
    'ServerTableEngine.authoritative_hand_semantic_refusal','Native Class4 concurrency',
    jsonb_build_object('channel','server_rpc','table_id','71000000-0000-4000-8000-000000000001',
      'hand_number',7100001,'hand_request_identity_v1',jsonb_build_object(
        'version',1,'table_id','71000000-0000-4000-8000-000000000001','hand_number',7100001,
        'hand_id','71000000-0000-4000-8000-000000000002','post_commit_required',true)));
  SET session_replication_role=origin;
}

teardown
{
  DELETE FROM public.financial_alerts WHERE id='71000000-0000-4000-8000-000000000003';
  DELETE FROM public.hand_atomic_commits WHERE hand_id='71000000-0000-4000-8000-000000000002';
}

session "mutator"
setup { SET statement_timeout='20s'; SET lock_timeout='15s'; }
step "change_begin" { BEGIN; }
step "change_identity" {
  UPDATE public.financial_alerts SET context=jsonb_set(context,
    ARRAY['hand_request_identity_v1','hand_id'],'"71000000-0000-4000-8000-000000000099"')
  WHERE id='71000000-0000-4000-8000-000000000003';
}
step "change_commit" { COMMIT; }
step "assert_unknown" {
  DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM public.financial_alerts
    WHERE id='71000000-0000-4000-8000-000000000003' AND resolved IS FALSE
      AND context->'hand_request_identity_v1'->>'hand_id'='71000000-0000-4000-8000-000000000099'
      AND NOT(context ? 'hand_outcome_resolution_v1')) THEN
    RAISE EXCEPTION 'concurrently changed original must remain unknown'; END IF;END$$;
}
step "assert_once" {
  DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM public.financial_alerts
    WHERE id='71000000-0000-4000-8000-000000000003' AND resolved IS TRUE
      AND context->'hand_outcome_resolution_v1'->>'hand_id'='71000000-0000-4000-8000-000000000002'
      AND resolution=context->>'resolution') THEN
    RAISE EXCEPTION 'one exact completion receipt required'; END IF;END$$;
}

session "resolver_a"
setup { SET statement_timeout='20s'; SET lock_timeout='15s'; SET ROLE service_role; }
step "a_begin" { BEGIN; }
step "a_resolve_one" {
  DO $$BEGIN IF (public.fn_resolve_settled_financial_alerts(true,5000)->>'refused_hand_released')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'first resolver must update one exact original'; END IF;END$$;
}
step "a_resolve_unknown" {
  DO $$BEGIN IF (public.fn_resolve_settled_financial_alerts(true,5000)->>'refused_hand_released')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'changed identity must not consume preview authority'; END IF;END$$;
}
step "a_commit" { COMMIT; }

session "resolver_b"
setup { SET statement_timeout='20s'; SET lock_timeout='15s'; SET ROLE service_role; }
step "b_begin" { BEGIN; }
step "b_resolve_zero" {
  DO $$BEGIN IF (public.fn_resolve_settled_financial_alerts(true,5000)->>'refused_hand_released')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'concurrent resolver must not report another update'; END IF;END$$;
}
step "b_commit" { COMMIT; }

permutation "change_begin" "change_identity" "a_begin" "a_resolve_unknown" "change_commit" "a_commit" "assert_unknown"
permutation "a_begin" "a_resolve_one" "b_begin" "b_resolve_zero" "a_commit" "b_commit" "assert_once"
