\set ON_ERROR_STOP on
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE FUNCTION u(i int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid$$;
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid);
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text,PRIMARY KEY(club_id,user_id));
CREATE TABLE agents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid NOT NULL REFERENCES clubs(id),user_id uuid NOT NULL,membership_id uuid,role text NOT NULL,parent_agent_id uuid REFERENCES agents(id),commission_rate numeric(5,4) NOT NULL,player_rakeback_rate numeric(5,4) NOT NULL,credit_limit numeric(15,2) NOT NULL DEFAULT 0,credit_used numeric(15,2) NOT NULL DEFAULT 0,is_prepaid boolean NOT NULL DEFAULT false,status text NOT NULL DEFAULT 'active',updated_at timestamptz,UNIQUE(club_id,user_id));
CREATE TABLE credit_assignments(agent_id uuid,assigned_by uuid,old_limit numeric,new_limit numeric,reason text);
CREATE TABLE role_effects(user_id uuid,role text);
CREATE TABLE agent_commissions(club_id uuid,user_id uuid,amount numeric,settled_at timestamptz,created_at timestamptz);
CREATE FUNCTION fn_agent_commission_paid_by_period(uuid,uuid,timestamptz) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
-- Fault-injection callee deliberately writes before refusing. The production
-- wrapper must roll back all effects and return the original refusal payload.
CREATE FUNCTION fn_club_set_member_role(p_club uuid,p_user uuid,p_role text,p_actor uuid,p_comm numeric,p_rake numeric,p_prepaid boolean,p_credit numeric)
RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 UPDATE club_members SET role=p_role WHERE club_id=p_club AND user_id=p_user;
 INSERT INTO role_effects VALUES(p_user,p_role);
 IF current_setting('test.role_refusal',true)='true' THEN RETURN '{"success":false,"error":"role grant refused","code":"fixture-refusal","detail":{"preserve":true}}'::jsonb;END IF;
 RETURN jsonb_build_object('success',true);
END$$;
CREATE TABLE assertions(id int);
CREATE FUNCTION assert_true(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %',message;END IF;INSERT INTO assertions VALUES(1);RAISE NOTICE 'PASS: %',message;END$$;
CREATE FUNCTION assert_rejected(statement text,message text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 BEGIN EXECUTE statement;EXCEPTION WHEN check_violation OR foreign_key_violation THEN PERFORM assert_true(true,message);RETURN;END;
 RAISE EXCEPTION 'FAIL: accepted invalid agreement: %',message;
END$$;
CREATE FUNCTION create_agent_for(user_no int,club_no int,parent_no int,commission numeric DEFAULT .2,rakeback numeric DEFAULT .1,credit numeric DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RETURN fn_create_agent(u(user_no),u(club_no),'agent',CASE WHEN parent_no IS NULL THEN NULL ELSE u(parent_no) END,commission,rakeback,credit,false);END$$;
INSERT INTO clubs VALUES(u(3),u(11)),(u(4),u(22));
INSERT INTO club_members VALUES(u(3),u(11),'owner','inactive'),(u(3),u(33),'admin','banned'),(u(3),u(34),'co_owner','removed'),(u(3),u(35),'admin','approved'),(u(3),u(36),'admin','active'),(u(3),u(40),'player','active'),(u(3),u(41),'agent','active'),(u(3),u(42),'player','active');
INSERT INTO agents(id,club_id,user_id,role,parent_agent_id,commission_rate,player_rakeback_rate,credit_limit) VALUES
 (u(100),u(3),u(50),'super_agent',NULL,.6,.4,1000),
 (u(101),u(3),u(41),'agent',u(100),.3,.2,200),
 (u(150),u(3),u(51),'super_agent',NULL,.3,.2,1000),
 (u(151),u(3),u(52),'agent',u(150),.4,.3,200),
 (u(200),u(4),u(50),'super_agent',NULL,.6,.4,1000);
CREATE TABLE original_agreements AS SELECT id,commission_rate,player_rakeback_rate,credit_limit FROM agents;
