CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payload jsonb,event text,topic text,private boolean DEFAULT false,extension text);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA realtime TO authenticated,anon;
GRANT SELECT ON realtime.messages TO authenticated,anon;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('realtime.topic',true)$$;
CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('fixture.fail_send',true)='true' THEN RAISE EXCEPTION 'fixture transport down'; END IF;
  INSERT INTO realtime.messages(payload,event,topic,private,extension)
  VALUES(payload||jsonb_build_object('id',gen_random_uuid()),event,topic,private,'broadcast');
END$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE TABLE profiles(id uuid PRIMARY KEY, is_admin boolean, alias text);
CREATE TABLE clubs(id uuid PRIMARY KEY,owner_id uuid,is_union boolean,union_id uuid);
CREATE TABLE club_members(club_id uuid,user_id uuid,role text,status text);
CREATE TABLE tables(id uuid PRIMARY KEY);
GRANT SELECT ON profiles,club_members,tables TO authenticated;
CREATE TABLE audit_trail(id uuid PRIMARY KEY,actor_id uuid,actor_role text,action text,target_type text,target_id uuid,club_id uuid,before_state jsonb,after_state jsonb,reason text,ip_address inet,request_id text,created_at timestamptz);
CREATE FUNCTION fn_club_scope_ids(uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$SELECT array_agg(id) FROM clubs WHERE id=$1 OR union_id=$1$$;
CREATE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM clubs WHERE id=$1 AND is_union AND owner_id=$2)$$;
CREATE FUNCTION fn_union_oversees_club(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM clubs c JOIN clubs u ON u.id=c.union_id WHERE c.id=$1 AND u.owner_id=$2)$$;
-- Exact live SELECT-policy topic boundaries, read from pg_policies on 2026-10-12.
-- These coexist permissively; none may override player-history staff protection.
CREATE POLICY "club members receive roster wallet signals" ON realtime.messages FOR SELECT TO authenticated USING(extension='broadcast' AND EXISTS(
 SELECT 1 FROM(SELECT CASE WHEN realtime.topic()~'^club-roster-wallet:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(realtime.topic(),':',2)::uuid ELSE NULL END club_id) topic
 WHERE topic.club_id IS NOT NULL AND auth.uid() IS NOT NULL AND (
 EXISTS(SELECT 1 FROM club_members m WHERE m.club_id=topic.club_id AND m.user_id=auth.uid() AND coalesce(m.status,'approved') IN('active','approved'))
 OR EXISTS(SELECT 1 FROM profiles p WHERE p.id=auth.uid() AND p.is_admin)
 OR fn_union_oversees_club(topic.club_id,auth.uid()))));
CREATE POLICY "players receive their own account change signal" ON realtime.messages FOR SELECT TO authenticated USING(extension='broadcast' AND realtime.topic()='profile-account:'||auth.uid()::text);
CREATE POLICY "players receive their own appearance signal" ON realtime.messages FOR SELECT TO authenticated USING(extension='broadcast' AND realtime.topic()='profile-appearance:'||auth.uid()::text);
CREATE POLICY "readable tables receive appearance signals" ON realtime.messages FOR SELECT TO authenticated USING(extension='broadcast' AND EXISTS(SELECT 1 FROM tables t WHERE t.id=(CASE WHEN realtime.topic()~'^table-appearance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(realtime.topic(),':',2)::uuid ELSE NULL END)));
CREATE POLICY "users receive own daily mission completion broadcasts" ON realtime.messages FOR SELECT TO authenticated USING(extension='broadcast' AND realtime.topic()='daily-mission-completion:'||auth.uid()::text);
CREATE POLICY "users receive own daily mission revision broadcasts" ON realtime.messages FOR SELECT TO authenticated USING(extension='broadcast' AND realtime.topic()='daily-mission-revision:'||auth.uid()::text);
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
ALTER TABLE audit_trail ENABLE ROW LEVEL SECURITY;
INSERT INTO profiles VALUES('30000000-0000-4000-8000-000000000001',false,'AuditAlias'),('30000000-0000-4000-8000-000000000002',false,NULL),('30000000-0000-4000-8000-000000000003',true,NULL);
INSERT INTO clubs VALUES
('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',false,'10000000-0000-4000-8000-000000000003'),
('10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002',false,'10000000-0000-4000-8000-000000000003'),
('10000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000002',true,NULL);
INSERT INTO club_members VALUES('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','agent','active');
INSERT INTO audit_trail SELECT
('40000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'30000000-0000-4000-8000-000000000001','owner',
CASE n%5 WHEN 0 THEN 'set_member_role' WHEN 1 THEN 'role_change' WHEN 2 THEN 'set_member_status' WHEN 3 THEN 'update_member_notes' ELSE 'export_club_roster' END,
CASE n%5 WHEN 1 THEN 'member' WHEN 4 THEN 'club' ELSE 'club_member' END,
CASE n%5 WHEN 4 THEN '10000000-0000-4000-8000-000000000001'::uuid ELSE '20000000-0000-4000-8000-000000000001'::uuid END,
'10000000-0000-4000-8000-000000000001',
'{"role":"player","status":"active","nickname_present":false,"remark_present":false,"nickname_length":0,"remark_length":0,"secret":"PRIVATE"}',
'{"role":"agent","status":"suspended","nickname_present":true,"remark_present":false,"nickname_length":3,"remark_length":0,"row_count":5,"selected_only":false,"selected_count":0,"filter":"all","sort":"hierarchy","search_used":true,"notes":"PRIVATE","credit_limit":123456}',
'PRIVATE','127.0.0.1','PRIVATE','2026-10-12T12:00:00Z' FROM generate_series(1,61)n;
INSERT INTO audit_trail SELECT '40000000-0000-4000-8000-000000000099',actor_id,actor_role,action,target_type,target_id,'10000000-0000-4000-8000-000000000002',before_state,after_state,reason,ip_address,request_id,created_at FROM audit_trail LIMIT 1;
-- QUALIFICATION CHECKS
INSERT INTO audit_trail SELECT '40000000-0000-4000-8000-000000000100',actor_id,actor_role,'set_member_role','club_member',target_id,club_id,before_state,after_state,reason,ip_address,request_id,created_at FROM audit_trail WHERE id='40000000-0000-4000-8000-000000000001';
DO $$DECLARE v jsonb; BEGIN
  SELECT payload INTO STRICT v FROM realtime.messages;
  IF (SELECT count(*) FROM jsonb_object_keys(v))<>4 OR v->>'club_id'<>'10000000-0000-4000-8000-000000000001' OR v->>'target_id'<>'20000000-0000-4000-8000-000000000001' OR v->>'action'<>'set_member_role' OR NOT(v?'id') THEN RAISE EXCEPTION 'unsafe signal payload'; END IF;
  IF EXISTS(SELECT 1 FROM realtime.messages WHERE event<>'history_changed' OR topic<>'player-history:10000000-0000-4000-8000-000000000001' OR private IS NOT TRUE) THEN RAISE EXCEPTION 'signal envelope'; END IF;
END$$;
INSERT INTO audit_trail SELECT '40000000-0000-4000-8000-000000000101',actor_id,actor_role,'unrelated_financial_action',target_type,target_id,club_id,before_state,after_state,reason,ip_address,request_id,created_at FROM audit_trail LIMIT 1;
DO $$BEGIN IF (SELECT count(*) FROM realtime.messages)<>1 THEN RAISE EXCEPTION 'unrelated signal'; END IF; END$$;
SET fixture.fail_send='true';
INSERT INTO audit_trail SELECT '40000000-0000-4000-8000-000000000102',actor_id,actor_role,'set_member_role','club_member',target_id,club_id,before_state,after_state,reason,ip_address,request_id,created_at FROM audit_trail WHERE id='40000000-0000-4000-8000-000000000001';
RESET fixture.fail_send;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM audit_trail WHERE id='40000000-0000-4000-8000-000000000102') THEN RAISE EXCEPTION 'transport rolled back audit'; END IF; END$$;
-- Retire only isolated signal fixtures before the unchanged pagination oracle.
DELETE FROM audit_trail WHERE id IN ('40000000-0000-4000-8000-000000000100','40000000-0000-4000-8000-000000000101','40000000-0000-4000-8000-000000000102');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
SELECT set_config('realtime.topic','player-history:10000000-0000-4000-8000-000000000001',false);
DO $$BEGIN
  IF (SELECT count(*) FROM realtime.messages)<>1 THEN RAISE EXCEPTION 'staff private receive'; END IF;
  BEGIN INSERT INTO realtime.messages(payload,event,topic,private,extension)VALUES('{}','history_changed',realtime.topic(),true,'broadcast'); RAISE EXCEPTION 'client publish allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF jsonb_array_length(ca_club_player_history('10000000-0000-4000-8000-000000000001')->'rows')<>50 THEN RAISE EXCEPTION 'authenticated reader'; END IF;
  BEGIN PERFORM id FROM public.audit_trail; RAISE EXCEPTION 'raw journal allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',false);
DO $$BEGIN IF (SELECT count(*) FROM realtime.messages)<>1 THEN RAISE EXCEPTION 'union private receive'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
DO $$BEGIN IF (SELECT count(*) FROM realtime.messages)<>1 THEN RAISE EXCEPTION 'platform private receive'; END IF; END$$;
SELECT set_config('realtime.topic','player-history:not-a-uuid',false);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages) THEN RAISE EXCEPTION 'malformed private topic'; END IF; END$$;
SELECT set_config('realtime.topic','player-history:10000000-0000-4000-8000-000000000001',false);
RESET ROLE;
SET ROLE anon;
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages) THEN RAISE EXCEPTION 'anonymous receive'; END IF; END$$;
RESET ROLE;
DO $$DECLARE v jsonb; v2 jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false);
  v:=ca_club_player_history('10000000-0000-4000-8000-000000000001');
  IF jsonb_array_length(v->'rows')<>50 OR (v->>'has_more')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'page bound'; END IF;
  IF v::text LIKE '%PRIVATE%' OR v::text LIKE '%credit_limit%' OR v::text LIKE '%ip_address%' THEN RAISE EXCEPTION 'privacy projection'; END IF;
  v2:=ca_club_player_history('10000000-0000-4000-8000-000000000001',NULL,'all',NULL,NULL,v->'next_cursor');
  IF jsonb_array_length(v2->'rows')<>11 OR (v2->>'has_more')::boolean THEN RAISE EXCEPTION 'tie pagination'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows')a JOIN jsonb_array_elements(v2->'rows')b ON a->>'id'=b->>'id') THEN RAISE EXCEPTION 'duplicate pagination'; END IF;
  v:=ca_club_player_history('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001');
  IF jsonb_array_length(v->'rows')<>49 OR v::text LIKE '%exports%' THEN RAISE EXCEPTION 'inactive target or exports attached'; END IF;
  v:=ca_club_player_history('10000000-0000-4000-8000-000000000003');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows')r WHERE r->>'club_id'<>'10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'child staff scope'; END IF;
  v:=ca_club_player_history('10000000-0000-4000-8000-000000000001',NULL,'notes','2026-10-12','2026-10-12');
  IF jsonb_array_length(v->'rows')<>12 THEN RAISE EXCEPTION 'kind/date filter'; END IF;
  v:=ca_club_player_history('10000000-0000-4000-8000-000000000001',NULL,'all','2026-10-13','2026-10-13');
  IF v->'rows'<>'[]'::jsonb THEN RAISE EXCEPTION 'UTC date boundary'; END IF;
  BEGIN PERFORM ca_club_player_history('10000000-0000-4000-8000-000000000002'); RAISE EXCEPTION 'cross club allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM ca_club_player_history('10000000-0000-4000-8000-000000000001',NULL,'all',NULL,NULL,'{}'); RAISE EXCEPTION 'invalid cursor allowed'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM ca_club_player_history('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','exports'); RAISE EXCEPTION 'player export attribution allowed'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
  IF NOT ca_player_history_can_read('10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'platform receive authority'; END IF;
  v:=ca_club_player_history('10000000-0000-4000-8000-000000000003');
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows')r WHERE r->>'club_id'='10000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'platform authority'; END IF;
  PERFORM set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',false);
  IF NOT ca_player_history_can_read('10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'union receive authority'; END IF;
  v:=ca_club_player_history('10000000-0000-4000-8000-000000000003');
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows')r WHERE r->>'club_id'='10000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'union authority'; END IF;
  -- Agent in club A is not its staff, although owner of unrelated child B/union.
  DELETE FROM clubs WHERE id='10000000-0000-4000-8000-000000000003';
  IF ca_player_history_can_read('10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'agent receive authority'; END IF;
  BEGIN PERFORM ca_club_player_history('10000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'agent allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claim.sub','',false);
  BEGIN PERFORM ca_club_player_history('10000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'anonymous allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',false);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages) THEN RAISE EXCEPTION 'agent private receive'; END IF; END$$;
RESET ROLE;
INSERT INTO club_members VALUES('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000004','admin','active');
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',false);
DO $$BEGIN
  IF jsonb_array_length(ca_club_player_history('10000000-0000-4000-8000-000000000001')->'rows')<>50 THEN RAISE EXCEPTION 'active staff'; END IF;
  UPDATE club_members SET status='suspended' WHERE user_id='30000000-0000-4000-8000-000000000004';
  BEGIN PERFORM ca_club_player_history('10000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'revoked staff allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
SELECT 'PASS scope, inactive target, privacy, ties, dates, filters and explicit denial';
SELECT 'PASS sanitized private signal, staff/union/platform authority, anonymous/nonstaff/client-publish denial and transport rollback isolation';

-- REALTIME JOIN CHECKS
-- Mirror realtime.authorize: authorization probes omit private and payload.
-- Its private default is false; the channel itself still uses private:true.
BEGIN;
INSERT INTO realtime.messages(id,topic,extension)
VALUES ('50000000-0000-4000-8000-000000000001','player-history:10000000-0000-4000-8000-000000000001','broadcast');
INSERT INTO club_members VALUES('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000004','admin','active');
SET LOCAL ROLE authenticated;
SELECT set_config('realtime.topic','player-history:10000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',true);
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'staff join probe denied'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',true);
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'union join probe denied'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'platform join probe denied'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000004',true);
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'active admin join probe denied'; END IF;
 BEGIN INSERT INTO realtime.messages(topic,extension)VALUES(realtime.topic(),'broadcast'); RAISE EXCEPTION 'client publish allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
RESET ROLE;
UPDATE club_members SET status='suspended' WHERE user_id='30000000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'revoked join allowed'; END IF; END$$;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',true);
SELECT set_config('realtime.topic','player-history:10000000-0000-4000-8000-000000000002',true);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'wrong topic allowed'; END IF; END$$;
SELECT set_config('realtime.topic','player-history:invalid',true);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'malformed topic allowed'; END IF; END$$;
RESET ROLE;
UPDATE realtime.messages SET extension='presence' WHERE id='50000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('realtime.topic','player-history:10000000-0000-4000-8000-000000000001',true);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'presence allowed'; END IF; END$$;
RESET ROLE;
UPDATE realtime.messages SET extension='broadcast' WHERE id='50000000-0000-4000-8000-000000000001';
DELETE FROM clubs WHERE is_union;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000002',true);
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'agent join allowed'; END IF; END$$;
SET LOCAL ROLE anon;
DO $$BEGIN IF EXISTS(SELECT 1 FROM realtime.messages WHERE id='50000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'anonymous join allowed'; END IF; END$$;
ROLLBACK;
SELECT 'PASS actual Realtime join probe, staff/union/platform/admin, revocation, topic/extension boundaries and publish denial';
