CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULLIF(current_setting('test.uid',true),'')::uuid$$;
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.engine',true),'false')='true'$$;
CREATE FUNCTION fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql AS $$SELECT '2026-09-07T07:00Z'::timestamptz$$;
CREATE TABLE profiles(id uuid PRIMARY KEY,username text);
CREATE TABLE clubs(id uuid PRIMARY KEY,name text,owner_id uuid);
CREATE TABLE unions(id uuid PRIMARY KEY,owner_id uuid);
CREATE TABLE union_clubs(union_id uuid,club_id uuid);
CREATE TABLE agents(id uuid PRIMARY KEY,user_id uuid,club_id uuid,parent_agent_id uuid,status text DEFAULT 'active',credit_used numeric DEFAULT 0);
CREATE TABLE club_members(user_id uuid,club_id uuid,agent_id uuid,chip_balance numeric,credit_used numeric);
CREATE TABLE chip_ledger(id uuid DEFAULT gen_random_uuid(),club_id uuid,from_entity_id uuid,to_entity_id uuid,from_type text,to_type text,category text,amount numeric,status text DEFAULT 'posted',created_at timestamptz DEFAULT '2026-09-10T07:00Z');
CREATE TABLE rake_attributions(player_id uuid,club_id uuid,rake_amount numeric,created_at timestamptz DEFAULT '2026-09-10T07:00Z');
CREATE TABLE agent_commissions(user_id uuid,club_id uuid,amount numeric,created_at timestamptz DEFAULT '2026-09-10T07:00Z');
CREATE TABLE table_seats(user_id uuid,club_id uuid,left_at timestamptz);
CREATE FUNCTION fn_is_club_admin_uid(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM clubs WHERE id=$1 AND owner_id=auth.uid())$$;
CREATE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM unions WHERE id=$1 AND owner_id=$2)$$;
CREATE FUNCTION fn_union_oversees_club(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM union_clubs c JOIN unions u ON u.id=c.union_id WHERE c.club_id=$1 AND u.owner_id=$2)$$;
CREATE FUNCTION assert_true(boolean,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1 IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',$2;END IF;RAISE NOTICE 'PASS: %',$2;END$$;
CREATE FUNCTION refuses(text,text) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN EXECUTE $1;RETURN false;EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE=$2;END$$;
CREATE FUNCTION u(int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-0000-0000-'||lpad($1::text,12,'0'))::uuid$$;
INSERT INTO profiles SELECT u(n),'User '||n FROM generate_series(1,30)n;
INSERT INTO clubs VALUES(u(100),'Club A',u(1)),(u(200),'Club B',u(2));
INSERT INTO unions VALUES(u(101),u(1)),(u(201),u(2));
INSERT INTO union_clubs VALUES(u(101),u(100)),(u(201),u(200));
INSERT INTO agents(id,user_id,club_id,parent_agent_id,credit_used) VALUES
 (u(11),u(10),u(100),u(15),2),(u(12),u(10),u(200),NULL,20),
 (u(13),u(11),u(100),u(11),0),(u(14),u(12),u(100),u(13),0),(u(15),u(13),u(100),u(14),0),
 (u(16),u(14),u(200),u(11),0);
INSERT INTO club_members VALUES(u(20),u(100),u(10),100,1),(u(21),u(100),u(13),200,2),(u(20),u(200),u(10),900,9),(u(22),u(200),u(14),9999,0);
INSERT INTO rake_attributions(player_id,club_id,rake_amount) VALUES(u(20),u(100),10),(u(21),u(100),5),(u(20),u(200),99),(u(22),u(200),777);
INSERT INTO agent_commissions(user_id,club_id,amount) VALUES(u(10),u(100),7),(u(10),u(200),70);
INSERT INTO chip_ledger(club_id,from_entity_id,to_entity_id,from_type,to_type,category,amount) VALUES
 (u(100),u(20),u(500),'player_wallet','table_stack','buyin',100),
 (u(100),u(500),u(20),'table_stack','player_wallet','cashout',120),
 (u(200),u(20),u(600),'player_wallet','table_stack','buyin',1000),
 (u(200),u(600),u(20),'table_stack','player_wallet','cashout',1001),
 (u(100),u(10),u(20),'player_wallet','player_wallet','rakeback',1),
 (u(100),u(100),u(20),'club_treasury','player_wallet','rakeback',50),
 (u(200),u(10),u(20),'player_wallet','player_wallet','rakeback',11);
INSERT INTO chip_ledger(club_id,from_entity_id,to_entity_id,from_type,to_type,category,amount,status) VALUES
 (u(100),u(10),u(20),'player_wallet','player_wallet','rakeback',999,'pending');
INSERT INTO table_seats VALUES(u(20),u(200),NULL);
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;

