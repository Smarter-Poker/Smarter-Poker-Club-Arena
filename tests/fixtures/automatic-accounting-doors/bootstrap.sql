\set ON_ERROR_STOP on
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.role',true),'')$$;
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,auth AS $$SELECT COALESCE(auth.role(),'service_role')='service_role'$$;
CREATE FUNCTION fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT auth.uid()='00000000-0000-4000-8000-000000000099'::uuid$$;
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
CREATE FUNCTION fn_union_week_start(t timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT date_trunc('week',t AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles'$$;
CREATE FUNCTION fn_union_prev_week_start(t timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT fn_union_week_start(t-interval '7 days')$$;
CREATE TABLE unions(id uuid PRIMARY KEY,owner_id uuid);
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,is_union boolean,chip_treasury numeric);
CREATE TABLE club_members(club_id uuid,user_id uuid,status text,role text,chip_balance numeric);
CREATE TABLE agents(id uuid,club_id uuid,user_id uuid,agent_wallet_balance numeric);
CREATE TABLE agent_commissions(id uuid,club_id uuid,user_id uuid,amount numeric,settled_at timestamptz);
CREATE TABLE rakeback_periods(id uuid,club_id uuid,user_id uuid,rakeback_amount numeric,status text);
CREATE TABLE wallets(user_id uuid,balance numeric);
CREATE TABLE settlement_invoices(id uuid);
CREATE TABLE notifications(id uuid);
CREATE TABLE assertion_count(id int);
CREATE FUNCTION u(i int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid$$;
CREATE FUNCTION assert_true(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %',message;END IF;INSERT INTO assertion_count VALUES(1);RAISE NOTICE 'PASS: %',message;END$$;
CREATE FUNCTION set_actor(actor uuid,actor_role text) RETURNS void LANGUAGE plpgsql AS $$BEGIN PERFORM set_config('request.jwt.claim.sub',COALESCE(actor::text,''),false);PERFORM set_config('request.jwt.claim.role',actor_role,false);END$$;
CREATE FUNCTION books() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object(
 'clubs',(SELECT jsonb_agg(c ORDER BY id) FROM clubs c),
 'members',(SELECT jsonb_agg(m ORDER BY club_id,user_id) FROM club_members m),
 'agents',(SELECT jsonb_agg(a ORDER BY id) FROM agents a),
 'commission',(SELECT jsonb_agg(a ORDER BY id) FROM agent_commissions a),
 'rakeback',(SELECT jsonb_agg(r ORDER BY id) FROM rakeback_periods r),
 'wallets',(SELECT jsonb_agg(w ORDER BY user_id) FROM wallets w),
 'invoices',(SELECT jsonb_agg(i ORDER BY id) FROM settlement_invoices i),
 'notifications',(SELECT jsonb_agg(n ORDER BY id) FROM notifications n))$$;
INSERT INTO unions VALUES(u(1),u(11)),(u(2),u(22));
INSERT INTO clubs VALUES(u(3),u(11),false,1000),(u(4),u(22),false,2000),(u(1),u(11),true,3000);
INSERT INTO club_members VALUES(u(3),u(10),'active','agent',10),(u(4),u(20),'approved','player',20),(u(3),u(30),'banned','agent',30);
INSERT INTO agents VALUES(u(110),u(3),u(10),10);
INSERT INTO agent_commissions VALUES(u(210),u(3),u(10),123.45,NULL);
INSERT INTO rakeback_periods VALUES(u(310),u(3),u(10),67.89,'pending');
INSERT INTO wallets VALUES(u(10),44.55);
INSERT INTO settlement_invoices VALUES(u(410));INSERT INTO notifications VALUES(u(510));
CREATE TABLE before_books AS SELECT books() AS snapshot;
