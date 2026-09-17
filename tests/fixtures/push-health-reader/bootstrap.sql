CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role',true),'') $$;
CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$function$;
CREATE TABLE profiles(id uuid PRIMARY KEY,username text,email text,role text);
CREATE TABLE push_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,is_active boolean,last_used_at timestamptz,last_receipt_at timestamptz,last_failure_reason text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE push_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text,status text,failure_reason text,created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz);
CREATE TABLE push_dispatch_runs(started_at timestamptz,finished_at timestamptz,claimed int,sent int,failed int,skipped int,note text,job text);
INSERT INTO profiles VALUES('00000000-0000-0000-0000-000000000001','admin','admin@example.test','admin'),('00000000-0000-0000-0000-000000000002','member','member@example.test','member'),('00000000-0000-0000-0000-000000000003','god','god@example.test','god');
CREATE FUNCTION assert_true(p_ok bool,p_label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',p_label; END IF; RAISE NOTICE 'PASS: %',p_label; END $$;
