INSERT INTO clubs(id,name,union_id) VALUES
 ('a0000000-0000-0000-0000-000000000001','Midway Member','fade0000-0000-0000-0000-000000000001'),
 ('a0000000-0000-0000-0000-000000000002','Standalone',NULL);
INSERT INTO tables(id,club_id,small_blind,big_blind,max_players,rake_cap_bb) VALUES
 ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001',.1,.2,9,20),
 ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002',5,10,6,-1);
DO $test$
DECLARE r record; snapshot jsonb := '{"cashPolicy":{"version":1,"scope":"midway"},"percent":10,"cap":0.5,"noFlopNoDrop":true,"playerCountCaps":[{"players":2,"cap":0.25},{"players":3,"cap":0.38},{"players":4,"cap":0.5}]}';
BEGIN
 SELECT * INTO r FROM fn_cash_rake_policy('b0000000-0000-0000-0000-000000000001');
 IF r.scope<>'midway' OR r.cap_bb<>2.5 OR r.percent<>10 THEN RAISE EXCEPTION 'Midway policy wrong'; END IF;
 IF (SELECT rake_cap_bb FROM tables WHERE id='b0000000-0000-0000-0000-000000000001')<>2.5 THEN RAISE EXCEPTION 'future table not bounded'; END IF;
 SELECT * INTO r FROM fn_cash_rake_policy('b0000000-0000-0000-0000-000000000002');
 IF r.scope<>'standalone' OR r.cap_bb<>2.5 THEN RAISE EXCEPTION 'default standard wrong'; END IF;
 UPDATE clubs SET default_rake_percent=15,rake_cap=20 WHERE id='a0000000-0000-0000-0000-000000000002';
 SELECT * INTO r FROM fn_cash_rake_policy('b0000000-0000-0000-0000-000000000002');
 IF r.percent<>15 OR r.cap_bb<>20 THEN RAISE EXCEPTION 'standalone custom discarded'; END IF;
 UPDATE tables SET rake_cap_bb=1,rake_percent=2 WHERE id='b0000000-0000-0000-0000-000000000002';
 SELECT * INTO r FROM fn_cash_rake_policy('b0000000-0000-0000-0000-000000000002');
 IF r.percent<>2 OR r.cap_bb<>1 THEN RAISE EXCEPTION 'table precedence wrong'; END IF;
 UPDATE clubs SET default_rake_percent=10,union_id='fade0000-0000-0000-0000-000000000001' WHERE id='a0000000-0000-0000-0000-000000000002';
 IF (SELECT rake_cap FROM clubs WHERE id='a0000000-0000-0000-0000-000000000002')<>2.5 THEN RAISE EXCEPTION 'joining Midway bypassed cap'; END IF;
 IF fn_cash_rake_from_snapshot(100,2,true,snapshot)<>.25 OR fn_cash_rake_from_snapshot(100,3,true,snapshot)<>.38
 OR fn_cash_rake_from_snapshot(100,6,true,snapshot)<>.5 OR fn_cash_rake_from_snapshot(100,6,false,snapshot)<>0
 THEN RAISE EXCEPTION 'snapshot recomputation wrong'; END IF;
 IF has_function_privilege('authenticated','fn_cash_rake_policy(uuid)','execute') OR has_function_privilege('anon','fn_cash_rake_from_snapshot(numeric,integer,boolean,jsonb)','execute') THEN RAISE EXCEPTION 'private helper exposed'; END IF;
END $test$;
-- One pre-rollout hand uses the retained old spec; one new hand uses its
-- frozen receipt. Later table edits cannot reprice either one.
INSERT INTO hand_history(id,table_id,hand_number,created_at,rake_amount,pot_size,players,community_cards,actions,cash_rake_policy)
 VALUES('c0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001',1,now()-interval '10 minutes',3,100,'[{},{},{},{}]',ARRAY['As','Kd','Qc'],'[]',NULL),
 ('c0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000001',2,now()-interval '10 minutes',.5,100,'[{},{},{},{}]',ARRAY['As','Kd','Qc'],'[]','{"cashPolicy":{"version":1,"scope":"midway"},"percent":10,"cap":0.5,"noFlopNoDrop":true,"playerCountCaps":[{"players":4,"cap":0.5}]}');
UPDATE tables SET rake_cap_bb=-1 WHERE id='b0000000-0000-0000-0000-000000000001';
DO $test$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM fn_ca_remeasure_entity('rake_law','b0000000-0000-0000-0000-000000000001') WHERE measurable AND severity='ok' AND ledger_balance=3.5 AND stored_balance=3.5) THEN RAISE EXCEPTION 'incident reader repriced a frozen hand'; END IF;
 IF EXISTS(SELECT 1 FROM fn_rake_law_violations(interval '1 hour') WHERE kind IN ('over_spec','under_spec')) THEN RAISE EXCEPTION 'rollout repriced history'; END IF;
END $test$;
SELECT 'midway-cash-rake-postgres-passed';
