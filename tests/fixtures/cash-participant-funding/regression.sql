-- The actor is deliberately synthetic and all rows live only in a private cluster.
CREATE FUNCTION pg_temp.assert(p_truth boolean,p_message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_truth IS DISTINCT FROM true THEN RAISE EXCEPTION '%',p_message; END IF; END $$;
INSERT INTO clubs(id,chip_treasury) VALUES('10000000-0000-4000-8000-000000000001',1000),('10000000-0000-4000-8000-000000000002',1000);
INSERT INTO tables(id,club_id,min_buy_in,max_buy_in) VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,1000);
INSERT INTO club_members(id,user_id,club_id,chip_balance) VALUES
 ('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',500),
 ('30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',500),
 ('30000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',500);
INSERT INTO profiles(id,is_horse) VALUES('40000000-0000-4000-8000-000000000001',false),('40000000-0000-4000-8000-000000000002',true),('40000000-0000-4000-8000-000000000003',true);
-- Actual original private buy-in cores, actual wallet debit trigger, actual journals.
SELECT atomic_table_buyin_before_maintenance_announcement_gate('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',1,100,false,'10000000-0000-4000-8000-000000000002',NULL);
SELECT atomic_table_buyin_before_maintenance_announcement_gate('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',2,100,false,'10000000-0000-4000-8000-000000000001',NULL);
SELECT atomic_table_buyin_before_maintenance_announcement_gate('40000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001',3,100,false,'10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003');
SELECT pg_temp.assert((SELECT count(*)=3 AND count(DISTINCT source_ledger_id)=3 FROM cash_participant_funding_receipts),'Every original admission including unkeyed must capture exactly one actual ledger');
SELECT pg_temp.assert((SELECT amount=100 AND balance_before=500 AND balance_after=400 AND account_type='player_wallet' AND funding_club_id='10000000-0000-4000-8000-000000000002' FROM cash_participant_funding_receipts WHERE user_id='40000000-0000-4000-8000-000000000001'),'Cross-club funding must retain actual debit club');
SELECT pg_temp.assert((SELECT count(*)=2 FROM cash_participant_funding_receipts f JOIN profiles p ON p.id=f.user_id WHERE p.is_horse AND f.account_type='player_wallet'),'Horses entering through wallet door are wallet funded');
SELECT atomic_table_buyin_before_maintenance_announcement_gate('40000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001',3,100,false,'10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003');
SELECT pg_temp.assert((SELECT count(*)=3 FROM cash_participant_funding_receipts),'Keyed core replay cannot create a new receipt or debit');
-- A failed journal still aborts the debit, seat and evidence together.
DO $$ DECLARE caught boolean:=false; before_state jsonb; BEGIN
 SELECT jsonb_agg(to_jsonb(c) ORDER BY id) INTO before_state FROM club_members c;
 PERFORM set_config('test.journal_sqlstate','23514',true);
 BEGIN PERFORM atomic_table_addon_before_maintenance_announcement_gate('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',10,true,NULL);
 EXCEPTION WHEN check_violation THEN caught:=true; END;
 PERFORM set_config('test.journal_sqlstate','',true);
 PERFORM pg_temp.assert(caught AND before_state=(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM club_members c),'Journal failure must roll back original debit');
END $$;
SELECT atomic_table_addon_before_maintenance_announcement_gate('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',10,true,NULL);
SELECT atomic_table_rebuy_before_maintenance_announcement_gate('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',12,'50000000-0000-4000-8000-000000000004');
SELECT pg_temp.assert((SELECT count(*)=1 FROM cash_participant_funding_receipts f JOIN table_pending_addons a ON a.id=f.pending_addon_id WHERE f.operation_kind='rebuy' AND f.amount=a.amount),'Rebuy must retain exact original pending identity');
SELECT * FROM resolve_pending_addon((SELECT pending_addon_id FROM cash_participant_funding_receipts WHERE operation_kind='rebuy'),1000);
SELECT pg_temp.assert((SELECT count(*)=1 AND bool_and(original_occupancy_id=applied_occupancy_id AND applied=12 AND refunded=0) FROM cash_funding_application_receipts),'Pending rebuy lands on its original occupancy with a retained delivery receipt');
INSERT INTO engine_table_leases VALUES('20000000-0000-4000-8000-000000000001','fixture','60000000-0000-4000-8000-000000000001',2,clock_timestamp());
CREATE FUNCTION pg_temp.roster() RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'occupancy_id',s.occupancy_id,'seat_joined_at',s.joined_at,'stack_before',s.stack,'is_horse',p.is_horse) ORDER BY s.user_id) FROM table_seats s JOIN profiles p ON p.id=s.user_id $$;
CREATE TEMP TABLE observed_manifest AS SELECT fn_cash_capture_hand_manifest('20000000-0000-4000-8000-000000000001',1000001,pg_temp.roster(),'fixture','60000000-0000-4000-8000-000000000001') AS result;
SELECT pg_temp.assert((SELECT result->>'funding_provenance_complete'='true' FROM observed_manifest),'Original complete funded roster should capture');
SELECT pg_temp.assert((SELECT result=fn_cash_capture_hand_manifest('20000000-0000-4000-8000-000000000001',1000001,pg_temp.roster(),'fixture','60000000-0000-4000-8000-000000000001') FROM observed_manifest),'Manifest retry must return identical evidence');
CREATE FUNCTION pg_temp.stacks(p_change numeric DEFAULT 0,p_number bigint DEFAULT 1000001) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_agg(jsonb_build_object('user_id',x->'user_id','seat_id',x->'seat_id','seat_joined_at',x->'seat_joined_at','occupancy_id',x->'occupancy_id','funding_manifest_id',m.id,'stack_before',x->'stack_before','stack',(x->>'stack_before')::numeric+CASE WHEN x->>'user_id'='40000000-0000-4000-8000-000000000001' THEN p_change ELSE 0 END)) FROM cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) x WHERE m.hand_number=p_number $$;
-- Invoke the original accepted-hand owner, real stack writer and history writer.
CREATE FUNCTION pg_temp.commit_hand(n bigint,s jsonb,r numeric DEFAULT 0,b numeric DEFAULT 0,i numeric DEFAULT 0) RETURNS jsonb LANGUAGE sql AS $$
 SELECT fn_ca_commit_hand_settlement_before_lease_generation('20000000-0000-4000-8000-000000000001',n,s,r,b,NULL,i,
  jsonb_build_object('table_id','20000000-0000-4000-8000-000000000001','hand_number',n),'[]') $$;
-- Zero-rake, zero-delta participant completeness is independent of money totals.
DO $$ DECLARE result jsonb; before_seats jsonb; BEGIN
 SELECT jsonb_agg(to_jsonb(s) ORDER BY s.user_id) INTO before_seats FROM table_seats s;
 result:=pg_temp.commit_hand(1000001,pg_temp.stacks()-0);
 PERFORM pg_temp.assert(result->>'success'='false' AND result->>'error'='Cash manifest participant set mismatch'
  AND NOT EXISTS(SELECT 1 FROM cash_hand_provenance_receipts)
  AND NOT EXISTS(SELECT 1 FROM hand_atomic_commits)
  AND NOT EXISTS(SELECT 1 FROM hand_history)
  AND NOT EXISTS(SELECT 1 FROM settlement_idempotency_keys)
  AND before_seats=(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.user_id) FROM table_seats s),
  'Omitted zero-delta participant must roll back original whole accepted hand');
END $$;
-- Membership and live seat may change after deal; original data remains the basis.
UPDATE club_members SET club_id='10000000-0000-4000-8000-000000000001' WHERE user_id='40000000-0000-4000-8000-000000000001';
UPDATE table_seats SET left_at=clock_timestamp() WHERE user_id='40000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert(pg_temp.commit_hand(1000001,pg_temp.stacks())->>'success'='true','Real original accepted-hand transaction must succeed');
SELECT pg_temp.assert(pg_temp.commit_hand(1000001,pg_temp.stacks())->>'replay'='true','Real original hand replay retains one immutable receipt');
SELECT pg_temp.assert((SELECT p.payload_hash=a.payload_hash AND p.hand_id=a.hand_id AND encode(extensions.digest(convert_to(p.accepted_request::text,'UTF8'),'sha256'),'hex')=a.payload_hash AND p.accepted_request->'stacks'->0->>'funding_manifest_id'=p.manifest_id::text FROM cash_hand_provenance_receipts p JOIN hand_atomic_commits a USING(table_id,hand_number)),'Provenance is bound to the exact original accepted payload hash');
SELECT pg_temp.assert((SELECT all_players_included AND funding_provenance_complete AND jsonb_array_length(participants)=3 AND status='captured' FROM cash_hand_provenance_receipts),'Zero-rake exact roster, departed player and horses must remain enumerable');
SELECT pg_temp.assert((SELECT participants->0->'funding_receipts'->0->>'funding_club_id'='10000000-0000-4000-8000-000000000002' FROM cash_hand_provenance_receipts),'Original funding must not follow latest membership');
-- Signed external outflow must be conserved without claiming external-bank proof.
DO $$ DECLARE m uuid; request jsonb; BEGIN
 UPDATE table_seats SET left_at=NULL;
 request:=pg_temp.roster();
 m:=(fn_cash_capture_hand_manifest('20000000-0000-4000-8000-000000000001',1000002,request,'fixture','60000000-0000-4000-8000-000000000001')->>'manifest_id')::uuid;
 request:=(SELECT jsonb_agg(value||jsonb_build_object('funding_manifest_id',m)) FROM jsonb_array_elements(pg_temp.stacks(-2)));
 PERFORM pg_temp.assert(pg_temp.commit_hand(1000002,request,1,0,-1)->>'success'='true','Signed negative external net remains accepted by the actual owner');
 PERFORM pg_temp.assert((SELECT signed_external_net=-1 AND all_players_included AND issues ? 'external_bank_receipt_not_certified' FROM cash_hand_provenance_receipts WHERE hand_number=1000002),'Signed outflow conservation is valid but not a proved external bank receipt');
END $$;
-- All-horse and zero-rake hands still produce a complete accepted population.
UPDATE profiles SET is_horse=true;
SELECT fn_cash_capture_hand_manifest('20000000-0000-4000-8000-000000000001',1000006,pg_temp.roster(),'fixture','60000000-0000-4000-8000-000000000001');
SELECT pg_temp.assert(pg_temp.commit_hand(1000006,pg_temp.stacks(0,1000006))->>'success'='true','All-horse zero-rake hand must be accepted');
SELECT pg_temp.assert((SELECT all_players_included AND jsonb_array_length(participants)=3 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(participants) x WHERE x->>'is_horse'<>'true') FROM cash_hand_provenance_receipts WHERE hand_number=1000006),'Every all-horse zero-delta participant must remain enumerable');
-- A horse treasury top-up is a different actual debit account, not a player flag.
SELECT fn_horse_fund_from_treasury_before_maintenance_gate('20000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',10,NULL);
SELECT pg_temp.assert((SELECT count(*)=1 FROM cash_participant_funding_receipts WHERE operation_kind='horse_funding' AND account_type='club_treasury' AND operation_key IS NULL),'Unkeyed treasury funding has original ledger identity');
SELECT pg_temp.assert(fn_cash_capture_hand_manifest('20000000-0000-4000-8000-000000000001',1000003,pg_temp.roster(),'fixture','60000000-0000-4000-8000-000000000001')->>'funding_provenance_complete'='false','Mixed wallet/treasury account ownership cannot invent a policy');
-- Legacy hands keep their gameplay protocol but cannot claim complete ownership.
SELECT pg_temp.assert(pg_temp.commit_hand(1000004,'[{"user_id":"40000000-0000-4000-8000-000000000001","stack_before":1,"stack":1}]')->>'success'='true','Rolling legacy accepted hand remains playable');
SELECT pg_temp.assert((SELECT NOT all_players_included AND NOT funding_provenance_complete AND status='uncertified' FROM cash_hand_provenance_receipts WHERE hand_number=1000004),'Legacy submitted roster is not complete dealt roster');
DO $$ DECLARE caught boolean:=false; BEGIN
 BEGIN UPDATE cash_participant_funding_receipts SET amount=amount+1; EXCEPTION WHEN SQLSTATE '55000' THEN caught:=true; END;
 PERFORM pg_temp.assert(caught,'Original funding evidence is immutable');
 caught:=false;
 BEGIN TRUNCATE cash_hand_participant_manifests; EXCEPTION WHEN SQLSTATE '55000' THEN caught:=true; END;
 PERFORM pg_temp.assert(caught,'Original manifests cannot be truncated');
 caught:=false;
 BEGIN PERFORM fn_cash_capture_hand_manifest('20000000-0000-4000-8000-000000000001',1000005,pg_temp.roster(),'stale','60000000-0000-4000-8000-000000000001'); EXCEPTION WHEN SQLSTATE '55000' THEN caught:=true; END;
 PERFORM pg_temp.assert(caught,'A stale dealer may not freeze provenance');
END $$;
SELECT pg_temp.assert(NOT has_function_privilege('service_role','fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)','EXECUTE') AND NOT has_table_privilege('service_role','cash_participant_funding_receipts','INSERT'),'External callers cannot fabricate funding');
SELECT 'PASS original funding, original roster, zero-delta completeness, signed net and legacy refusal';
