-- The Supabase surface 20260927221335_push_prompt_events_record_the_enrolment_funnel.sql
-- touches: the client roles, auth.uid()/auth.role() read from the request
-- claims the way PostgREST sets them, fn_caller_is_engine and profiles.role.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role',true),'') $$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'pg_catalog','public','auth'
 AS $$ SELECT COALESCE(auth.role(),'service_role')='service_role' $$;
CREATE TABLE profiles(id uuid PRIMARY KEY,username text,role text);
INSERT INTO profiles VALUES('00000000-0000-0000-0000-000000000001','admin','admin'),('00000000-0000-0000-0000-000000000002','member','member'),('00000000-0000-0000-0000-000000000003','other','member');
CREATE FUNCTION assert_true(p_ok bool,p_label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',p_label; END IF; RAISE NOTICE 'PASS: %',p_label; END $$;
GRANT EXECUTE ON FUNCTION assert_true(bool,text) TO PUBLIC;
-- Runs a statement as a role with a JWT subject; returns the SQLSTATE or 'ok'.
CREATE FUNCTION as_user(p_role text,p_sub text,p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text:='ok';
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_sub,''),true);
 PERFORM set_config('request.jwt.claim.role',p_role,true);
 EXECUTE format('SET LOCAL ROLE %I',p_role);
 BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN r:=SQLSTATE; END;
 RESET ROLE;
 PERFORM set_config('request.jwt.claim.sub','',true);
 PERFORM set_config('request.jwt.claim.role','',true);
 RETURN r;
END $$;
