-- Isolated native Data fixture only. Never execute against production.
CREATE TABLE agents(id uuid PRIMARY KEY,user_id uuid,club_id uuid,role text,status text,parent_agent_id uuid,commission_rate numeric);
CREATE TABLE club_rake_rollup_complete(club_id uuid,day date);
CREATE TABLE club_rake_daily_user(club_id uuid,user_id uuid,day date,rake_amount numeric,hands bigint);
ALTER TABLE rake_attributions ADD COLUMN IF NOT EXISTS created_at timestamptz, ADD COLUMN IF NOT EXISTS rake_amount numeric;
CREATE FUNCTION fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql AS $$SELECT date_trunc('week',$1)$$;
CREATE OR REPLACE FUNCTION fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_is_agent_ancestor(p_ancestor_user_id uuid,p_descendant_user_id uuid,p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
 WITH RECURSIVE up AS (
 SELECT a.id,a.user_id,a.parent_agent_id FROM agents a
 WHERE a.user_id=p_descendant_user_id AND (p_club_id IS NULL OR a.club_id=p_club_id)
 UNION ALL SELECT p.id,p.user_id,p.parent_agent_id FROM agents p JOIN up ON up.parent_agent_id=p.id
 ) SELECT EXISTS(SELECT 1 FROM up WHERE user_id=p_ancestor_user_id AND user_id<>p_descendant_user_id)
$$;
CREATE OR REPLACE FUNCTION fn_is_club_admin_uid(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT ca_can_view_whole_club_report($1)$$;
INSERT INTO clubs(id,name,owner_id) VALUES
 (md5('legacy-a')::uuid,'Legacy A',md5('legacy-owner')::uuid),
 (md5('legacy-b')::uuid,'Legacy B',md5('legacy-other-owner')::uuid);
INSERT INTO profiles(id,username,is_admin)
SELECT md5(x)::uuid,x,false FROM unnest(ARRAY['legacy-owner','legacy-co_owner','legacy-admin','legacy-x','legacy-y','legacy-z','legacy-leaf','legacy-foreign','legacy-sibling','legacy-player']) x;
INSERT INTO club_members(club_id,user_id,role,status,agent_id)
SELECT md5('legacy-a')::uuid,md5(x)::uuid,r,'active',CASE WHEN parent IS NULL THEN NULL ELSE md5(parent)::uuid END
FROM (VALUES ('legacy-owner','owner',NULL),('legacy-co_owner','co_owner',NULL),('legacy-admin','admin',NULL),
 ('legacy-x','super_agent',NULL),('legacy-y','agent','legacy-x'),('legacy-leaf','player','legacy-y'),
 ('legacy-sibling','agent',NULL),('legacy-player','player',NULL)) v(x,r,parent);
INSERT INTO club_members(club_id,user_id,role,status,agent_id) VALUES
 (md5('legacy-b')::uuid,md5('legacy-y')::uuid,'agent','active',md5('legacy-z')::uuid),
 (md5('legacy-b')::uuid,md5('legacy-z')::uuid,'super_agent','active',NULL),
 (md5('legacy-b')::uuid,md5('legacy-foreign')::uuid,'player','active',md5('legacy-y')::uuid);
INSERT INTO agents(id,user_id,club_id,role,status,parent_agent_id,commission_rate) VALUES
 (md5('legacy-x-agent')::uuid,md5('legacy-x')::uuid,md5('legacy-a')::uuid,'super_agent','active',NULL,.2),
 (md5('legacy-ya-agent')::uuid,md5('legacy-y')::uuid,md5('legacy-a')::uuid,'agent','active',md5('legacy-x-agent')::uuid,.1),
 (md5('legacy-yb-agent')::uuid,md5('legacy-y')::uuid,md5('legacy-b')::uuid,'agent','active',md5('legacy-z-agent')::uuid,.9),
 (md5('legacy-z-agent')::uuid,md5('legacy-z')::uuid,md5('legacy-b')::uuid,'super_agent','active',NULL,.2),
 (md5('legacy-sibling-agent')::uuid,md5('legacy-sibling')::uuid,md5('legacy-a')::uuid,'agent','active',NULL,.1);
-- Every rank must retain descendants beyond the old twenty-level cutoff.
INSERT INTO profiles(id,username,is_admin) SELECT md5('legacy-deep'||i)::uuid,'Deep '||i,false FROM generate_series(1,25) i;
INSERT INTO club_members(club_id,user_id,role,status,agent_id)
SELECT md5('legacy-a')::uuid,md5('legacy-deep'||i)::uuid,'sub_agent','active',
 CASE WHEN i=1 THEN md5('legacy-y')::uuid ELSE md5('legacy-deep'||(i-1))::uuid END FROM generate_series(1,25) i;
INSERT INTO agents(id,user_id,club_id,role,status,parent_agent_id,commission_rate)
SELECT md5('legacy-deep-agent'||i)::uuid,md5('legacy-deep'||i)::uuid,md5('legacy-a')::uuid,'sub_agent','active',
 CASE WHEN i=1 THEN md5('legacy-ya-agent')::uuid ELSE md5('legacy-deep-agent'||(i-1))::uuid END,.1 FROM generate_series(1,25) i;
INSERT INTO rake_records(id,created_at,rake_amount) VALUES(md5('legacy-rake')::uuid,now()-interval '20 minutes',103);
INSERT INTO rake_attributions(rake_record_id,player_id,club_id,created_at,rake_amount) VALUES
 (md5('legacy-rake')::uuid,md5('legacy-leaf')::uuid,md5('legacy-a')::uuid,now()-interval '20 minutes',1),
 (md5('legacy-rake')::uuid,md5('legacy-deep25')::uuid,md5('legacy-a')::uuid,now()-interval '20 minutes',2),
 (md5('legacy-rake')::uuid,md5('legacy-foreign')::uuid,md5('legacy-b')::uuid,now()-interval '20 minutes',100);
-- The live definitions' ACLs, including the revoked anonymous door.
REVOKE ALL ON FUNCTION fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION fn_agent_downline_rake_summary(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION fn_agent_downline_rake_summary(uuid,uuid,timestamptz,timestamptz) TO authenticated,service_role;
-- AFTER MIGRATION
SET ROLE authenticated;
SELECT set_config('test.role','authenticated',false);
DO $test$
DECLARE r text; result jsonb; total numeric;
BEGIN
 FOREACH r IN ARRAY ARRAY['@RANK@'] LOOP
  -- The native harness changes this rank as the fixture owner, then reconnects
  -- as authenticator/authenticated before running these exact reader calls.
  PERFORM set_config('test.uid',md5('legacy-x')::uuid::text,true);
  SELECT coalesce(sum(d.rake_generated),0) INTO total
  FROM fn_agent_downline_rake(md5('legacy-y')::uuid,NULL,now()-interval '1 hour',now(),NULL,100000) d;
  IF total<>3 THEN RAISE EXCEPTION 'missing-club legacy rows leaked: % %',r,total; END IF;
  result:=fn_agent_downline_rake_summary(md5('legacy-y')::uuid,NULL,now()-interval '1 hour',now());
  IF (result->>'rake_generated')::numeric<>3 OR (result->>'commission_rate')::numeric<>.1 THEN
   RAISE EXCEPTION 'missing-club summary leaked: % %',r,result;
  END IF;
  SELECT coalesce(sum(d.rake_generated),0) INTO total FROM fn_agent_downline_rake(NULL,NULL,now()-interval '1 hour',now(),NULL,100000) d;
  IF total<>3 THEN RAISE EXCEPTION 'self default lost descendants'; END IF;
  BEGIN
   PERFORM fn_agent_downline_rake(md5('legacy-y')::uuid,md5('legacy-b')::uuid);
   RAISE EXCEPTION 'explicit unrelated club granted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
   PERFORM fn_agent_downline_rake_summary(md5('legacy-sibling')::uuid,md5('legacy-a')::uuid);
   RAISE EXCEPTION 'sibling root granted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
   PERFORM fn_ca_authorized_agent_data_clubs(md5('legacy-y')::uuid,NULL);
   RAISE EXCEPTION 'private scope helper was browser callable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 END LOOP;
 PERFORM set_config('test.uid',md5('legacy-player')::uuid::text,true);
 BEGIN
  PERFORM fn_agent_downline_rake(md5('legacy-y')::uuid,NULL);
  RAISE EXCEPTION 'regular player opened legacy Data';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 FOREACH r IN ARRAY ARRAY['legacy-owner','legacy-co_owner','legacy-admin'] LOOP
  PERFORM set_config('test.uid',md5(r)::uuid::text,true);
  result:=fn_agent_downline_rake_summary(md5('legacy-y')::uuid,NULL,now()-interval '1 hour',now());
  IF (result->>'rake_generated')::numeric<>3 THEN RAISE EXCEPTION 'staff scope changed'; END IF;
 END LOOP;
 RAISE NOTICE 'LEGACY RAKE DATA BOUNDARY PASSED';
END $test$;
