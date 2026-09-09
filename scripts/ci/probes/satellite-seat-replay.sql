DO $audit$
DECLARE
 v_definition text;
 v_result jsonb;
 v_case record;
 v_pass integer := 0;
 v_fail text[] := ARRAY[]::text[];
BEGIN
 CREATE TEMP TABLE tournaments (id uuid PRIMARY KEY,name text,club_id uuid,status text,buy_in_amount numeric,buy_in_fee numeric,bounty_amount numeric,is_bounty boolean,is_pko boolean,is_mystery_bounty boolean,max_players integer,current_players integer,current_level integer,late_reg_levels integer,rebuy_levels integer,prize_pool_finalized boolean) ON COMMIT DROP;
 CREATE TEMP TABLE tournament_players (id uuid DEFAULT gen_random_uuid(), tournament_id uuid,user_id uuid,username text,chips numeric,status text,is_satellite_qualifier boolean,source_satellite_id uuid, UNIQUE(tournament_id,user_id)) ON COMMIT DROP;
 CREATE TEMP TABLE profiles (id uuid,display_name text,username text) ON COMMIT DROP;
 SELECT pg_get_functiondef('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure) INTO v_definition;
 --DEFINITION_OVERRIDE--
 v_definition := replace(v_definition,'public.fn_award_satellite_seat','pg_temp.audit_satellite_seat');
 v_definition := replace(v_definition,'public.tournaments','pg_temp.tournaments');
 v_definition := replace(v_definition,'public.tournament_players','pg_temp.tournament_players');
 v_definition := replace(v_definition,'public.profiles','pg_temp.profiles');
 EXECUTE v_definition;
 FOR v_case IN SELECT * FROM (VALUES
 ('open_same','REGISTERING',false,0,'same',true,true,false),
 ('closed_same','COMPLETED',false,0,'same',true,true,false),
 ('full_same','REGISTERING',false,10,'same',true,true,false),
 ('final_same','REGISTERING',true,0,'same',true,true,false),
 ('open_other','REGISTERING',false,0,'other',true,false,false),
 ('closed_other','COMPLETED',false,0,'other',true,false,false),
 ('full_other','REGISTERING',false,10,'other',true,false,false),
 ('final_other','REGISTERING',true,0,'other',true,false,false),
 ('open_legacy','REGISTERING',false,0,'legacy',true,null,true),
 ('closed_legacy','COMPLETED',false,0,'legacy',true,null,true),
 ('full_legacy','REGISTERING',false,10,'legacy',true,null,true),
 ('final_legacy','REGISTERING',true,0,'legacy',true,null,true),
 ('open_cash','REGISTERING',false,0,'cash',true,false,false),
 ('closed_cash','COMPLETED',false,0,'cash',true,false,false),
 ('full_cash','REGISTERING',false,10,'cash',true,false,false),
 ('final_cash','REGISTERING',true,0,'cash',true,false,false),
 ('closed_empty','COMPLETED',false,0,'none',false,null,null),
 ('full_empty','REGISTERING',false,10,'none',false,null,null),
 ('final_empty','REGISTERING',true,0,'none',false,null,null)
 ) AS cases(label,status,finalized,players,origin,expected_ok,expected_held,expected_unknown)
 LOOP
 TRUNCATE pg_temp.tournaments,pg_temp.tournament_players;
 INSERT INTO pg_temp.tournaments VALUES('10000000-0000-0000-0000-000000000001','Target',null,v_case.status,10,0,0,false,false,false,10,v_case.players,1,5,0,v_case.finalized);
 IF v_case.origin<>'none' THEN
 INSERT INTO pg_temp.tournament_players(tournament_id,user_id,source_satellite_id,is_satellite_qualifier) VALUES('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001', CASE v_case.origin WHEN 'same' THEN '30000000-0000-0000-0000-000000000001'::uuid WHEN 'other' THEN '30000000-0000-0000-0000-000000000002'::uuid ELSE null END,v_case.origin<>'cash');
 END IF;
 -- Capacity is now derived from durable registration rows rather than the
 -- drift-prone current_players cache.  Build the full case with real rows.
 IF v_case.origin='none' AND v_case.players>0 THEN
 INSERT INTO pg_temp.tournament_players(tournament_id,user_id,is_satellite_qualifier)
 SELECT '10000000-0000-0000-0000-000000000001',
        md5('satellite-seat-capacity:'||g.i::text)::uuid,false
   FROM generate_series(1,v_case.players) g(i);
 END IF;
 v_result := pg_temp.audit_satellite_seat('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Winner',1);
 IF (v_result->>'ok')::boolean IS DISTINCT FROM v_case.expected_ok OR (v_case.expected_ok AND ((v_result->>'held_from_this_satellite')::boolean IS DISTINCT FROM v_case.expected_held OR (v_result->>'origin_unknown')::boolean IS DISTINCT FROM v_case.expected_unknown OR (v_result->>'awarded')::boolean IS DISTINCT FROM false)) THEN
 v_fail := array_append(v_fail,v_case.label||':'||v_result::text);
 ELSE v_pass := v_pass+1; END IF;
 END LOOP;
 IF cardinality(v_fail)>0 THEN RAISE EXCEPTION 'AUDIT_TEST_FAIL: % passed; failures: %; all fixtures rolled back',v_pass,v_fail; END IF;
 RAISE EXCEPTION 'AUDIT_TEST_PASS: % satellite replay cases; all fixtures rolled back',v_pass;
END $audit$;
