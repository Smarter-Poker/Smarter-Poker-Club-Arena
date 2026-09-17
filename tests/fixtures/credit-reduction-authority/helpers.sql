\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Temporary fixture helpers, not economic substitutes.
-- Load inside a bounded fixture transaction against actual full36+successor.
DO $guard$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR to_regprocedure('public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text)') IS NULL
  OR to_regprocedure('public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('public.fn_accounting_credit_reduction_assert_document(uuid)') IS NULL
 THEN RAISE EXCEPTION 'isolated complete credit reduction authority required';END IF;
END$guard$;
CREATE FUNCTION pg_temp.cr_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('e6371000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.cr_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'credit reduction fixture failed: %',label;END IF;
 RAISE NOTICE 'credit reduction fixture passed: %',label;
END$$;
CREATE FUNCTION pg_temp.cr_actor(who uuid,role_name text DEFAULT 'authenticated') RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(who::text,''),true);
 PERFORM set_config('request.jwt.claim.role',role_name,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',who,'role',role_name)::text,true);
END$$;
CREATE FUNCTION pg_temp.cr_intent(snapshot jsonb,op uuid,amount numeric,reason text DEFAULT NULL)
 RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('actor_user_id',snapshot->'actor_user_id','operation_id',op,
  'club_id',snapshot->'club_id','agent_id',snapshot->'agent_id','target_user_id',snapshot->'target_user_id',
  'requested_reduction',amount,'expected_credit_limit',snapshot->'credit_limit',
  'expected_credit_used',snapshot->'credit_used','expected_is_prepaid',snapshot->'is_prepaid',
  'expected_revision',snapshot->'control_revision','reason',reason);
$$;
CREATE FUNCTION pg_temp.cr_apply(q jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_reduce_agent_credit_v1(
  (q->>'actor_user_id')::uuid,(q->>'operation_id')::uuid,(q->>'club_id')::uuid,
  (q->>'agent_id')::uuid,(q->>'target_user_id')::uuid,(q->>'requested_reduction')::numeric,
  (q->>'expected_credit_limit')::numeric,(q->>'expected_credit_used')::numeric,
  (q->>'expected_is_prepaid')::boolean,(q->>'expected_revision')::bigint,q->>'reason');
$$;
-- Include every ordinary public/private/auth base table, dynamically including
-- new operation/document/retirement tables. Sequence allocations are excluded.
-- This temporary fixture-only privileged snapshot must never be installed.
CREATE FUNCTION pg_temp.cr_book() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE relation record;rows_json jsonb;result jsonb:='{}';BEGIN
 FOR relation IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN('public','smarter_private','auth','operational_source_intake') AND c.relkind IN('r','p') AND NOT c.relispartition
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t',relation.nspname,relation.relname) INTO rows_json;
  result:=result||jsonb_build_object(relation.nspname||'.'||relation.relname,rows_json);
 END LOOP;RETURN result;
END$$;
REVOKE ALL ON FUNCTION pg_temp.cr_book() FROM PUBLIC;
DO $temp$ DECLARE n name;BEGIN SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated,service_role,anon',n);END$temp$;
GRANT EXECUTE ON FUNCTION pg_temp.cr_id(integer),pg_temp.cr_check(boolean,text),
 pg_temp.cr_actor(uuid,text),pg_temp.cr_intent(jsonb,uuid,numeric,text),pg_temp.cr_apply(jsonb),pg_temp.cr_book()
 TO authenticated,service_role,anon;
CREATE FUNCTION pg_temp.cr_recorded(e jsonb,q jsonb,applied numeric,after_limit numeric,
 after_prepaid boolean,replayed boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE x jsonb:=e->'receipt';ids uuid[];BEGIN
 PERFORM pg_temp.cr_check(e IS NOT NULL AND
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e)k)=
   ARRAY['actor_user_id','club_id','contract_version','operation_id','receipt','replayed','retirement','state']::text[]
  AND e->'contract_version'='1'::jsonb AND e->>'state'='recorded'
  AND e->'actor_user_id'=q->'actor_user_id' AND e->'club_id'=q->'club_id'
  AND e->'operation_id'=q->'operation_id' AND e->'replayed'=to_jsonb(replayed)
  AND e->'retirement'='null'::jsonb AND jsonb_typeof(x)='object','exact recorded envelope');
 PERFORM pg_temp.cr_check((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x)k)=
  ARRAY['action','actor_user_id','after_limit','after_prepaid','after_revision','agent_id','amount_due_claimed',
   'applied_reduction','assignment_id','assignment_reason','before_limit','before_prepaid','before_revision',
   'chip_movement_claimed','club_id','contract_version','credit_used','document_id','invoice_id','operation_id',
   'outcome','payment_proven','reason','receipt_id','recorded_at','requested_reduction','target_user_id']::text[],
  'recorded receipt exact whitelist');
 PERFORM pg_temp.cr_check(x->'contract_version'='1'::jsonb AND x->>'action'='reduce_credit_limit'
  AND x->'actor_user_id'=q->'actor_user_id' AND x->'club_id'=q->'club_id'
  AND x->'agent_id'=q->'agent_id' AND x->'target_user_id'=q->'target_user_id'
  AND x->'operation_id'=q->'operation_id' AND x->'reason'=q->'reason'
  AND x->>'assignment_reason'=COALESCE(NULLIF(q->>'reason',''),'Credit line reduced')
  AND x->'requested_reduction'=to_jsonb(round((q->>'requested_reduction')::numeric,2)::text)
  AND x->'before_limit'=to_jsonb(round((q->>'expected_credit_limit')::numeric,2)::text)
  AND x->'credit_used'=to_jsonb(round((q->>'expected_credit_used')::numeric,2)::text)
  AND x->'before_prepaid'=q->'expected_is_prepaid' AND x->>'before_revision'=q->>'expected_revision'
  AND x->'applied_reduction'=to_jsonb(round(applied,2)::text)
  AND x->'after_limit'=to_jsonb(round(after_limit,2)::text) AND x->'after_prepaid'=to_jsonb(after_prepaid)
  AND x->'payment_proven'='false'::jsonb AND x->'chip_movement_claimed'='false'::jsonb
  AND x->'amount_due_claimed'='false'::jsonb
  AND x->>'recorded_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
  AND isfinite((x->>'recorded_at')::timestamptz), 'exact original intent, amounts and nonpayment meaning');
 PERFORM pg_temp.cr_check(x->>'receipt_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND (x->>'receipt_id')::uuid<>'00000000-0000-0000-0000-000000000000'::uuid,'real operation receipt UUID');
 IF applied>0 THEN
  ids:=ARRAY[(x->>'assignment_id')::uuid,(x->>'document_id')::uuid,(x->>'invoice_id')::uuid];
  PERFORM pg_temp.cr_check(x->>'outcome'='applied'
   AND x->>'after_revision'=((q->>'expected_revision')::bigint+1)::text
   AND (SELECT count(DISTINCT u)=3 AND bool_and((u IS NOT NULL AND u<>'00000000-0000-0000-0000-000000000000'::uuid) IS TRUE) FROM unnest(ids)u),
   'applied result has three distinct persisted identities and next revision');
 ELSE
  PERFORM pg_temp.cr_check(x->>'outcome'='no_change' AND x->>'after_revision'=q->>'expected_revision'
   AND x->'assignment_id'='null'::jsonb AND x->'document_id'='null'::jsonb AND x->'invoice_id'='null'::jsonb
   AND x->'before_prepaid'='true'::jsonb AND x->'after_prepaid'='true'::jsonb
   AND x->>'before_limit'='0.00' AND x->>'after_limit'='0.00' AND x->>'credit_used'='0.00',
   'canonical no-change has no assignment or document claims');
 END IF;
END$$;
GRANT EXECUTE ON FUNCTION pg_temp.cr_recorded(jsonb,jsonb,numeric,numeric,boolean,boolean) TO authenticated,service_role;
