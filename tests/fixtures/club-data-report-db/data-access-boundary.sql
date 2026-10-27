-- Isolated native fixture only; never execute against production.
INSERT INTO clubs(id,name,owner_id) VALUES(md5('boundary-club')::uuid,'Boundary Club',md5('owner')::uuid);
INSERT INTO profiles(id,username,is_admin)
SELECT md5(r)::uuid,r,false FROM unnest(ARRAY['owner','co_owner','admin','super_agent','agent','sub_agent','player','outsider']) r;
INSERT INTO club_members(club_id,user_id,role,status)
SELECT md5('boundary-club')::uuid,md5(r)::uuid,r,'active'
FROM unnest(ARRAY['owner','co_owner','admin','super_agent','agent','sub_agent','player']) r;
INSERT INTO club_members(club_id,user_id,role,status,agent_id)
SELECT md5('boundary-club')::uuid,md5('deep'||i)::uuid,'player','active',
       CASE WHEN i=1 THEN md5('super_agent')::uuid ELSE md5('deep'||(i-1))::uuid END
FROM generate_series(1,25) i;
-- Cyclic records must terminate and still contain only descendants.
UPDATE club_members SET agent_id=md5('deep25')::uuid WHERE club_id=md5('boundary-club')::uuid AND user_id=md5('super_agent')::uuid;
INSERT INTO ca_club_data_fact_ct(club_id,stat_date,kind,game_id,user_id,fee,buyins,cashouts,winnings,last_at)
SELECT md5('boundary-club')::uuid,DATE '@REPORT_DAY@','CASH','00000000-0000-0000-0000-0000000000c1',md5(u)::uuid,fee,0,0,0,now()
FROM (VALUES('super_agent',1),('deep25',2),('player',100)) x(u,fee);
INSERT INTO ca_club_data_game_ct(club_id,stat_date,kind,game_id,fee,buyins,cashouts,winnings,last_at)
VALUES(md5('boundary-club')::uuid,DATE '@REPORT_DAY@','CASH','00000000-0000-0000-0000-0000000000c1',103,0,0,0,now());
-- AFTER MIGRATION
SET ROLE authenticated;
SELECT set_config('test.role','authenticated',false);
DO $test$
DECLARE r text; result jsonb; scope text;
BEGIN
  FOREACH r IN ARRAY ARRAY['owner','co_owner','admin','super_agent','agent','sub_agent','player','outsider'] LOOP
    PERFORM set_config('test.uid',md5(r)::uuid::text,true);
    scope := fn_ca_club_data_scope(md5('boundary-club')::uuid);
    IF r IN ('owner','co_owner','admin') THEN
      IF scope IS DISTINCT FROM 'club' OR NOT ca_can_view_whole_club_report(md5('boundary-club')::uuid) THEN RAISE EXCEPTION 'operator refused: %',r; END IF;
      result := ca_club_data_screen(md5('boundary-club')::uuid,DATE '@REPORT_DAY@',DATE '@REPORT_DAY@');
      IF (result->'summary'->>'fee')::numeric<>103 THEN RAISE EXCEPTION 'operator totals wrong'; END IF;
    ELSIF r IN ('super_agent','agent','sub_agent') THEN
      IF scope IS DISTINCT FROM 'downline' OR ca_can_view_whole_club_report(md5('boundary-club')::uuid) THEN RAISE EXCEPTION 'agent granted whole report: %',r; END IF;
      result := ca_club_data_screen(md5('boundary-club')::uuid,DATE '@REPORT_DAY@',DATE '@REPORT_DAY@');
      IF result->>'scope'<>'downline' OR (result->'summary'->>'fee')::numeric <> (CASE WHEN r='super_agent' THEN 3 ELSE 0 END) THEN RAISE EXCEPTION 'agent totals leaked: % %',r,result; END IF;
      -- Filters must preserve the same private user set.
      result := ca_club_data_screen(md5('boundary-club')::uuid,DATE '@REPORT_DAY@',DATE '@REPORT_DAY@','HOLDEM');
      IF (result->'summary'->>'fee')::numeric <> (CASE WHEN r='super_agent' THEN 3 ELSE 0 END) THEN RAISE EXCEPTION 'filtered totals leaked'; END IF;
      BEGIN
        PERFORM ca_club_data_snapshot_v2(md5('boundary-club')::uuid,DATE '@REPORT_DAY@',DATE '@REPORT_DAY@');
        RAISE EXCEPTION 'agent opened advanced report';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      BEGIN
        PERFORM ca_club_data_screen('fade0000-0000-0000-0000-000000000001',DATE '@REPORT_DAY@',DATE '@REPORT_DAY@');
        RAISE EXCEPTION 'agent opened union';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      BEGIN
        PERFORM fn_ca_club_data_downline(md5('boundary-club')::uuid,md5('owner')::uuid);
        RAISE EXCEPTION 'agent called private downline helper';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    ELSE
      IF scope IS NOT NULL THEN RAISE EXCEPTION 'player granted data'; END IF;
      BEGIN
        PERFORM ca_club_data_screen(md5('boundary-club')::uuid,DATE '@REPORT_DAY@',DATE '@REPORT_DAY@');
        RAISE EXCEPTION 'player opened data';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END IF;
  END LOOP;
  RAISE NOTICE 'DATA ACCESS BOUNDARY PASSED';
END $test$;
