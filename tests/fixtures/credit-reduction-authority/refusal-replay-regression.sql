\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Actual RPCs; no substituted writer or fabricated receipt.
RESET ROLE;
CREATE FUNCTION pg_temp.cr_retired(e jsonb,actor uuid,op uuid,club uuid,replayed boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb:=e->'retirement';BEGIN
 PERFORM pg_temp.cr_check((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e)k)=
  ARRAY['actor_user_id','club_id','contract_version','operation_id','receipt','replayed','retirement','state']::text[]
  AND e->'contract_version'='1'::jsonb AND e->>'state'='retired' AND e->>'actor_user_id'=actor::text
  AND e->>'operation_id'=op::text AND e->>'club_id'=club::text AND e->'replayed'=to_jsonb(replayed)
  AND e->'receipt'='null'::jsonb AND jsonb_typeof(r)='object','exact retirement envelope');
 PERFORM pg_temp.cr_check((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r)k)=
  ARRAY['actor_user_id','club_id','contract_version','operation_id','retired_at','retirement_id','state']::text[]
  AND r->'contract_version'='1'::jsonb AND r->>'state'='retired' AND r->>'actor_user_id'=actor::text
  AND r->>'operation_id'=op::text AND r->>'club_id'=club::text
  AND r->>'retirement_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND (r->>'retirement_id')::uuid<>'00000000-0000-0000-0000-000000000000'::uuid
  AND r->>'retired_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
  AND isfinite((r->>'retired_at')::timestamptz),'retirement is identity-only durable evidence');
END$$;
GRANT EXECUTE ON FUNCTION pg_temp.cr_retired(jsonb,uuid,uuid,uuid,boolean) TO authenticated;
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));SET LOCAL ROLE authenticated;
DO $invalid$ DECLARE q jsonb;v jsonb;k text;BEGIN
 SELECT q0.q INTO STRICT q FROM cr_failure_intent q0;
 FOREACH k IN ARRAY ARRAY['agent_id','target_user_id','requested_reduction','expected_credit_limit',
  'expected_credit_used','expected_is_prepaid','expected_revision'] LOOP
  PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,ARRAY[k],'null'::jsonb),'22023','credit_reduction_invalid_intent');
 END LOOP;
 FOREACH v IN ARRAY ARRAY['0'::jsonb,'-1'::jsonb,'0.001'::jsonb,'1000000000.01'::jsonb,'"NaN"'::jsonb,'"Infinity"'::jsonb,'"-Infinity"'::jsonb] LOOP
  PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{requested_reduction}',v),'22023','credit_reduction_invalid_intent');
 END LOOP;
 FOREACH k IN ARRAY ARRAY['expected_credit_limit','expected_credit_used'] LOOP
  FOREACH v IN ARRAY ARRAY['-1'::jsonb,'0.001'::jsonb,'10000000000000'::jsonb,'"NaN"'::jsonb,'"Infinity"'::jsonb] LOOP
   PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,ARRAY[k],v),'22023','credit_reduction_invalid_intent');
  END LOOP;
 END LOOP;
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{expected_revision}','-1'::jsonb),'22023','credit_reduction_invalid_intent');
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{operation_id}','null'::jsonb),'22023','credit_reduction_invalid_identity');
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{club_id}','null'::jsonb),'22023','credit_reduction_invalid_identity');
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{actor_user_id}',to_jsonb(pg_temp.cr_id(3))),'42501','credit_reduction_actor_changed');
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{agent_id}',to_jsonb(pg_temp.cr_id(301))),'23514','credit_reduction_target_changed');
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{target_user_id}',to_jsonb(pg_temp.cr_id(2))),'23514','credit_reduction_target_changed');
END$invalid$;
DO $conflicts$ DECLARE q jsonb;k text;v jsonb;BEGIN
 SELECT intent INTO STRICT q FROM cr_saved WHERE label='main';
 FOREACH k IN ARRAY ARRAY['agent_id','target_user_id','requested_reduction','expected_credit_limit','expected_credit_used','expected_is_prepaid','expected_revision','reason'] LOOP
  v:=CASE k WHEN 'agent_id' THEN to_jsonb(pg_temp.cr_id(206)) WHEN 'target_user_id' THEN to_jsonb(pg_temp.cr_id(16))
   WHEN 'requested_reduction' THEN '21'::jsonb WHEN 'expected_credit_limit' THEN '101'::jsonb
   WHEN 'expected_credit_used' THEN '24'::jsonb WHEN 'expected_is_prepaid' THEN 'true'::jsonb
   WHEN 'expected_revision' THEN '1'::jsonb ELSE '"Changed original reason"'::jsonb END;
  PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,ARRAY[k],v),'23514','credit_reduction_operation_conflict');
 END LOOP;
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{club_id}',to_jsonb(pg_temp.cr_id(102))),'23514','credit_reduction_operation_scope_conflict');
 SELECT intent INTO STRICT q FROM cr_saved WHERE label='clamped';
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{reason}','""'::jsonb),'23514','credit_reduction_operation_conflict');
 SELECT intent INTO STRICT q FROM cr_saved WHERE label='no_change';
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{reason}','null'::jsonb),'23514','credit_reduction_operation_conflict');
END$conflicts$;
DO $stale_aba$ DECLARE s jsonb;q jsonb;a jsonb;fresh jsonb;BEGIN
 s:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(16));
 q:=pg_temp.cr_intent(s,pg_temp.cr_id(1301),5,'Original snapshot before ABA');
 a:=public.fn_admin_update_agent(pg_temp.cr_id(206),p_credit_limit=>120,p_credit_reason=>'First real absolute change');
 PERFORM pg_temp.cr_check(a->'success'='true'::jsonb,'actual writer changes original snapshot');
 PERFORM pg_temp.cr_expect_atomic_failure(q,'23514','credit_reduction_state_changed');
 a:=public.fn_admin_update_agent(pg_temp.cr_id(206),p_credit_limit=>100,p_credit_reason=>'Return to original amount');
 PERFORM pg_temp.cr_check(a->'success'='true'::jsonb,'actual writer returns amount to original');
 fresh:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(16));
 PERFORM pg_temp.cr_check(fresh->'credit_limit'=s->'credit_limit' AND fresh->'credit_used'=s->'credit_used'
  AND fresh->'is_prepaid'=s->'is_prepaid' AND (fresh->>'control_revision')::bigint=(s->>'control_revision')::bigint+2,
  'equal funding values retain intervening revision evidence');
 PERFORM pg_temp.cr_expect_atomic_failure(q,'23514','credit_reduction_state_changed');
 INSERT INTO cr_saved VALUES('stale_aba',q,'{}',NULL);
END$stale_aba$;
DO $debt_and_prior$ DECLARE s jsonb;q jsonb;before_book jsonb;state text;message text;BEGIN
 s:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(15));
 q:=pg_temp.cr_intent(s,pg_temp.cr_id(1302),20,'Cannot erase drawn debt');
 PERFORM pg_temp.cr_expect_atomic_failure(q,'23514','credit_reduction_writer_refused');
 PERFORM pg_temp.cr_expect_atomic_failure(jsonb_set(q,'{requested_reduction}','200'::jsonb),'23514','credit_reduction_writer_refused');
 before_book:=pg_temp.cr_book();
 BEGIN
  PERFORM public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(13));
  RAISE EXCEPTION 'legacy malformed funding pair accepted';
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  IF state IS DISTINCT FROM '23514' OR message IS DISTINCT FROM 'credit_reduction_invalid_prior_state' THEN RAISE;END IF;
 END;
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'invalid legacy funding state is retained without inferred correction');
 q:=jsonb_build_object('actor_user_id',pg_temp.cr_id(1),'operation_id',pg_temp.cr_id(1303),'club_id',pg_temp.cr_id(101),
  'agent_id',pg_temp.cr_id(203),'target_user_id',pg_temp.cr_id(13),'requested_reduction',1,
  'expected_credit_limit','0.00','expected_credit_used','0.00','expected_is_prepaid',false,'expected_revision','0','reason',NULL);
 PERFORM pg_temp.cr_expect_atomic_failure(q,'23514','credit_reduction_invalid_prior_state');
END$debt_and_prior$;
DO $retirement$ DECLARE q jsonb;e jsonb;first jsonb;before_book jsonb;after_book jsonb;BEGIN
 SELECT q0.q INTO STRICT q FROM cr_failure_intent q0;q:=jsonb_set(q,'{operation_id}',to_jsonb(pg_temp.cr_id(1304)));
 before_book:=pg_temp.cr_book();e:=public.fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(1),pg_temp.cr_id(1304),pg_temp.cr_id(101));
 PERFORM pg_temp.cr_check(e=jsonb_build_object('contract_version',1,'actor_user_id',pg_temp.cr_id(1),'operation_id',pg_temp.cr_id(1304),
  'club_id',pg_temp.cr_id(101),'state','absent','replayed',false,'receipt',NULL,'retirement',NULL)
  AND pg_temp.cr_book()=before_book,'absence is read-only and carries no retirement proof');
 first:=public.fn_retire_agent_credit_reduction_v1(pg_temp.cr_id(1),pg_temp.cr_id(1304),pg_temp.cr_id(101));
 PERFORM pg_temp.cr_retired(first,pg_temp.cr_id(1),pg_temp.cr_id(1304),pg_temp.cr_id(101),false);
 after_book:=pg_temp.cr_book();
 PERFORM pg_temp.cr_check(jsonb_array_length(after_book->'public.accounting_credit_reduction_retirements_v1')=
  jsonb_array_length(before_book->'public.accounting_credit_reduction_retirements_v1')+1,'retirement appends one durable identity');
 after_book:=jsonb_set(after_book,'{public.accounting_credit_reduction_retirements_v1}',
  (SELECT COALESCE(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) FROM jsonb_array_elements(after_book->'public.accounting_credit_reduction_retirements_v1')
   WHERE value->>'id' IS DISTINCT FROM first->'retirement'->>'retirement_id'));
 PERFORM pg_temp.cr_check(after_book=before_book,'retirement changes no financial, document or prior evidence row');
 before_book:=pg_temp.cr_book();
 e:=public.fn_retire_agent_credit_reduction_v1(pg_temp.cr_id(1),pg_temp.cr_id(1304),pg_temp.cr_id(101));
 PERFORM pg_temp.cr_check(e=jsonb_set(first,'{replayed}','true'::jsonb) AND pg_temp.cr_book()=before_book,'exact retirement replay is stable');
 e:=public.fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(1),pg_temp.cr_id(1304),pg_temp.cr_id(101));
 PERFORM pg_temp.cr_retired(e,pg_temp.cr_id(1),pg_temp.cr_id(1304),pg_temp.cr_id(101),true);
 PERFORM pg_temp.cr_check(e=jsonb_set(first,'{replayed}','true'::jsonb) AND pg_temp.cr_book()=before_book,'lookup returns original retirement');
 PERFORM pg_temp.cr_expect_atomic_failure(q,'23514','credit_reduction_operation_retired');
 SELECT response INTO STRICT first FROM cr_saved WHERE label='main';
 e:=public.fn_retire_agent_credit_reduction_v1(pg_temp.cr_id(1),pg_temp.cr_id(1001),pg_temp.cr_id(101));
 PERFORM pg_temp.cr_check(e=jsonb_set(first,'{replayed}','true'::jsonb) AND pg_temp.cr_book()=before_book,
  'retire after recorded returns recorded receipt and cannot cancel completed capacity change');
END$retirement$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
