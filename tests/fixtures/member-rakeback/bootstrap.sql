CREATE ROLE anon; CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
CREATE FUNCTION u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid);
CREATE TABLE profiles(id uuid PRIMARY KEY,is_admin boolean DEFAULT false);
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,is_active boolean DEFAULT true,agent_id uuid,
 parent_agent_id uuid,commission_rate numeric,rakeback_rate numeric,player_rakeback_pct numeric DEFAULT 0,
 updated_at timestamptz,PRIMARY KEY(club_id,user_id));
CREATE TABLE agents(id uuid PRIMARY KEY,club_id uuid,user_id uuid,role text,status text,
 parent_agent_id uuid,commission_rate numeric,player_rakeback_rate numeric,credit_limit numeric DEFAULT 0,updated_at timestamptz);
CREATE TABLE audit_trail(actor_id uuid,actor_role text,action text,target_type text,target_id uuid,club_id uuid,before_state jsonb,after_state jsonb,reason text);
CREATE TABLE ca_declared_money_triggers(table_name text,trigger_name text,note text);
CREATE TABLE accounting_agreement_history(entity_type text,entity_key text,club_id uuid,subject_user_id uuid,event_type text,actor_id uuid,before_terms jsonb,after_terms jsonb);
CREATE FUNCTION fn_ca_declare_guard_redefinition(text,text) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE FUNCTION assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;RAISE NOTICE 'PASS: %',label;END$$;
CREATE TABLE rakeback_periods(id uuid);
CREATE TABLE accounting_rakeback_period_calculations(id uuid);
CREATE TABLE accounting_rakeback_period_evidence_checkpoints(id uuid);
CREATE FUNCTION public.fn_club_active_cashier_edges(p_club uuid) RETURNS TABLE(child uuid,parent uuid)
 LANGUAGE sql STABLE AS $$SELECT user_id,agent_id FROM club_members WHERE club_id=p_club AND status IN ('active','approved') AND agent_id IS NOT NULL AND agent_id<>user_id$$;

CREATE FUNCTION fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql AS $$SELECT '{}'::text[]$$;
