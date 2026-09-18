-- Isolated retained legacy records. No replacement settlement or recovery RPC.
CREATE FUNCTION fixture_seed_completed_mtt(i integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t uuid:=md5('cm-event'||i)::uuid; tab uuid:=md5('cm-table'||i)::uuid;
 paid_id uuid:=md5('cm-paid'||i)::uuid; j integer; u uuid; st numeric; original jsonb;
BEGIN
 INSERT INTO tournaments VALUES(t,'RUNNING','mtt-v1',9,2);
 INSERT INTO tables(id,tournament_id,status,max_players) VALUES(tab,t,'running',9);
 INSERT INTO engine_tournament_leases VALUES(t,'cm-current','qualified',now(),now(),md5('cm-current'||i)::uuid,2);
 FOR j IN 1..2 LOOP
 u:=md5('cm-user'||i||':'||j)::uuid;st:=CASE j WHEN 1 THEN 2500 ELSE 320000 END;
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
 VALUES(md5('cm-seat'||i||':'||j)::uuid,tab,u,j,st,md5('cm-occupancy'||i||':'||j)::uuid,'2026-09-18 12:46:54+00');
 INSERT INTO tournament_players VALUES(md5('cm-registration'||i||':'||j)::uuid,t,tab,u,j,st,'playing');
 END LOOP;
 SELECT jsonb_agg(to_jsonb(s) ORDER BY id) INTO original FROM table_seats s WHERE table_id=tab AND seat_number=2;
 INSERT INTO tournament_paid_stack_custody_receipts(id,tournament_id,user_id,candidate_id,entitlement_id,source_ledger_id,
 source_wallet_id,destination_table_id,destination_seat_number,grant_chips,live_chips_before,funded_supply,scoring_excess,expected,state,created_at)
 VALUES(paid_id,t,md5('cm-user'||i||':1')::uuid,md5('cm-candidate'||i)::uuid,md5('cm-entitlement'||i)::uuid,
 md5('cm-ledger'||i)::uuid,md5('cm-wallet'||i)::uuid,tab,1,2500,320000,317500,5000,
 jsonb_build_object('generation',md5('cm-original'||i)::uuid,'live_seats',original),'reserved','2026-09-18 12:46:54+00');
 UPDATE tournament_paid_stack_custody_receipts SET state='seated',completed_at='2026-09-18 12:46:55+00',assignment=jsonb_build_object(
 'ok',true,'receipt_id',paid_id,'tournament_id',t,'user_id',user_id,'table_id',tab,'seat_number',1,'stack',2500,
 'seat_id',md5('cm-seat'||i||':1')::uuid,'occupancy_id',(SELECT occupancy_id FROM table_seats WHERE table_id=tab AND seat_number=1),'assigned_at','2026-09-18 12:46:54+00',
 'original_ledger_id',source_ledger_id,'original_entitlement_id',entitlement_id) WHERE id=paid_id;
 INSERT INTO smarter_private.f06_hand_permits SELECT md5('cm-permit'||i)::uuid,t,tab,f06_lifecycle,12636137,
 md5('cm-custody'||i)::uuid,md5('cm-original'||i)::uuid,'reserved',NULL FROM tables WHERE id=tab;
 -- The actual incident predates the journal snapshot guard. Only fixture
 -- loading suppresses that guard; it is restored before any assertion/RPC.
 ALTER TABLE hand_state_snapshots DISABLE TRIGGER hand_submission_snapshot_guard;
 INSERT INTO hand_state_snapshots(id,table_id,hand_number,is_complete,created_at,updated_at,state_json)
 SELECT md5('cm-snapshot'||i)::uuid,tab,12636137,true,'2026-09-18 12:47:33+00','2026-09-18 12:47:36+00',
 jsonb_build_object('stage','preflop','pot',26312,'actionHistory','[]'::jsonb,'players',jsonb_agg(jsonb_build_object(
 'user_id',user_id,'seat',seat_number,'stack',CASE seat_number WHEN 1 THEN 0 ELSE 296188 END,
 'totalInvested',CASE seat_number WHEN 1 THEN 2500 ELSE 23812 END,'deadInvested',CASE seat_number WHEN 1 THEN 2500 ELSE 15875 END,
 'individualAnteInvested',CASE seat_number WHEN 1 THEN 2500 ELSE 15875 END,'returnedUncalled',0) ORDER BY seat_number))
 FROM table_seats WHERE table_id=tab;
 ALTER TABLE hand_state_snapshots ENABLE TRIGGER hand_submission_snapshot_guard;
 INSERT INTO table_hole_cards(id,table_id,hand_number,user_id,seat_number,cards)
 SELECT md5('cm-card'||i||':'||seat_number)::uuid,tab,12636137,user_id,seat_number,'["Ac","Kd"]'::jsonb FROM table_seats WHERE table_id=tab;
END $$;

CREATE FUNCTION fixture_completed_mtt_expected(i integer) RETURNS jsonb LANGUAGE sql AS $$
 WITH e AS(SELECT fixture_expected_mixed(md5('cm-event'||i)::uuid) x),
 s AS(SELECT * FROM hand_state_snapshots WHERE id=md5('cm-snapshot'||i)::uuid),
 p AS(SELECT * FROM tournament_paid_stack_custody_receipts WHERE id=md5('cm-paid'||i)::uuid)
 SELECT jsonb_set(e.x,'{hands,0}',(e.x#>'{hands,0}')||jsonb_build_object('snapshot_id',s.id,'snapshot_hash',md5(to_jsonb(s)::text),'prior',NULL,
 'interruption',jsonb_build_object('kind','completed_unaccepted_mtt','paid_receipt_id',p.id,'paid_receipt_hash',md5(to_jsonb(p)::text),
 'cards',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id)
 FROM table_hole_cards c WHERE c.table_id=s.table_id AND c.hand_number=s.hand_number),
 'registrations',(SELECT jsonb_agg(jsonb_build_object('id',r.id,'user_id',r.user_id,'row_hash',md5(to_jsonb(r)::text)) ORDER BY r.id) FROM tournament_players r WHERE r.tournament_id=p.tournament_id),
 'financial_receipts',jsonb_build_object(
 'settlements',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM ca_settlements c WHERE c.table_id=s.table_id),
 'settlement_keys',(SELECT jsonb_agg(jsonb_build_object('hand_id',k.hand_id,'row_hash',md5(to_jsonb(k)::text)) ORDER BY k.hand_id) FROM settlement_idempotency_keys k WHERE k.table_id=s.table_id),
 'atomic',(SELECT jsonb_agg(jsonb_build_object('hand_id',a.hand_id,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.hand_number) FROM hand_atomic_commits a WHERE a.table_id=s.table_id),
 'history',(SELECT jsonb_agg(jsonb_build_object('hand_id',h.id,'row_hash',md5(to_jsonb(h)::text)) ORDER BY h.hand_number) FROM hand_history h WHERE h.table_id=s.table_id))))) FROM e,s,p $$;
