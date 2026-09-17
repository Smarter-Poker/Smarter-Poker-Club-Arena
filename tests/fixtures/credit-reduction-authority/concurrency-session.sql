\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Admission only: never authorizes a live connection.
DO $guard$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR to_regclass('public.credit_reduction_fixture_marker') IS NULL
 THEN RAISE EXCEPTION 'isolated marked credit concurrency fixture required';END IF;
 IF (SELECT count(*) FROM public.credit_reduction_fixture_marker)<>1
  OR NOT EXISTS(SELECT 1 FROM public.credit_reduction_fixture_marker
   WHERE singleton AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND postmaster_started_at=pg_postmaster_start_time())
 THEN RAISE EXCEPTION 'credit concurrency marker identity changed';END IF;
END$guard$;
CREATE FUNCTION pg_temp.cr_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('e6371000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.cr_actor(who integer DEFAULT 1,role_name text DEFAULT 'authenticated') RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM set_config('request.jwt.claim.sub',pg_temp.cr_id(who)::text,true);
 PERFORM set_config('request.jwt.claim.role',role_name,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.cr_id(who),'role',role_name)::text,true);
END$$;
CREATE FUNCTION pg_temp.cr_book() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE relation record;rows_json jsonb;result jsonb:='{}';BEGIN
 FOR relation IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN('public','smarter_private','auth') AND c.relkind IN('r','p') AND NOT c.relispartition
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t',relation.nspname,relation.relname) INTO rows_json;
  result:=result||jsonb_build_object(relation.nspname||'.'||relation.relname,rows_json);
 END LOOP;RETURN result;
END$$;
REVOKE ALL ON FUNCTION pg_temp.cr_book() FROM PUBLIC;
CREATE FUNCTION pg_temp.cr_apply(op integer,target integer,amount numeric,limit_before numeric,revision bigint,used_before numeric DEFAULT 0,who integer DEFAULT 1)
 RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_reduce_agent_credit_v1(pg_temp.cr_id(who),pg_temp.cr_id(op),pg_temp.cr_id(101),
  pg_temp.cr_id(200+target),pg_temp.cr_id(target),amount,limit_before,used_before,false,revision,'Concurrent original intent');
$$;
-- Capture a refusal as data only for the finite fixture oracle; actual RPC
-- success remains its unmodified envelope. SQL errors roll back their subblock.
CREATE FUNCTION pg_temp.cr_try_apply(op integer,target integer,amount numeric,limit_before numeric,revision bigint,used_before numeric DEFAULT 0,who integer DEFAULT 1)
 RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE result jsonb;s text;m text;BEGIN
 BEGIN result:=pg_temp.cr_apply(op,target,amount,limit_before,revision,used_before,who);
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE,m=MESSAGE_TEXT;
  RETURN jsonb_build_object('fixture_error_state',s,'fixture_error_message',m);END;
 RETURN result;
END$$;
DO $temp$ DECLARE n name;BEGIN SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated,service_role',n);END$temp$;
GRANT EXECUTE ON FUNCTION pg_temp.cr_id(integer),pg_temp.cr_actor(integer,text),pg_temp.cr_book(),pg_temp.cr_apply(integer,integer,numeric,numeric,bigint,numeric,integer),
 pg_temp.cr_try_apply(integer,integer,numeric,numeric,bigint,numeric,integer) TO authenticated,service_role;
