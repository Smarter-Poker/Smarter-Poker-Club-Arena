-- Isolated fixture: the exact historical event/permit/projection identities,
-- synthetic current dependencies and no snapshot row. Never production data.
CREATE FUNCTION fixture_seed_pruned_earlybird() RETURNS void LANGUAGE plpgsql AS $$
DECLARE witness jsonb:=$witness$__WITNESS_JSON__$witness$::jsonb;
 t uuid:=(witness#>>'{original_permit,tournament_id}')::uuid;
 tab uuid:=(witness#>>'{original_permit,table_id}')::uuid;
 paid_id uuid:=(witness->>'paid_receipt_id')::uuid;
 j integer; u uuid; st numeric; original jsonb;
BEGIN
 INSERT INTO tournaments VALUES(t,'RUNNING','mtt-v1',9,2);
 -- The real lifecycle trigger assigns the sequence value even when INSERT
 -- supplied one. Seed that isolated sequence instead of disabling the guard.
 PERFORM setval('smarter_private.f06_lifecycle_seq',(witness#>>'{original_permit,lifecycle}')::bigint-1,true);
 INSERT INTO tables(id,tournament_id,status,max_players,f06_lifecycle)
 VALUES(tab,t,'running',9,(witness#>>'{original_permit,lifecycle}')::bigint);
 INSERT INTO engine_tournament_leases VALUES(t,'cm-current','qualified',now(),now(),md5('eb-current')::uuid,2);
 FOR j IN 1..2 LOOP
 u:=(witness#>>ARRAY['snapshot','players',(j-1)::text,'user_id'])::uuid;
 st:=CASE j WHEN 1 THEN 2500 ELSE 320000 END;
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
 VALUES(md5('eb-seat'||j)::uuid,tab,u,j,st,md5('eb-occupancy'||j)::uuid,'2026-09-18 12:46:54+00');
 INSERT INTO tournament_players VALUES(md5('eb-registration'||j)::uuid,t,tab,u,j,st,'playing');
 END LOOP;
 SELECT jsonb_agg(to_jsonb(s) ORDER BY id) INTO original FROM table_seats s WHERE table_id=tab AND seat_number=2;
 INSERT INTO tournament_paid_stack_custody_receipts(id,tournament_id,user_id,candidate_id,entitlement_id,source_ledger_id,
 source_wallet_id,destination_table_id,destination_seat_number,grant_chips,live_chips_before,funded_supply,scoring_excess,expected,state,created_at)
 VALUES(paid_id,t,(witness#>>'{snapshot,players,0,user_id}')::uuid,md5('eb-candidate')::uuid,md5('eb-entitlement')::uuid,
 md5('eb-ledger')::uuid,md5('eb-wallet')::uuid,tab,1,2500,320000,317500,5000,
 jsonb_build_object('generation',witness#>>'{original_permit,generation}','live_seats',original),'reserved','2026-09-18 12:46:54+00');
 UPDATE tournament_paid_stack_custody_receipts SET state='seated',completed_at='2026-09-18 12:46:55+00',assignment=jsonb_build_object(
 'ok',true,'receipt_id',paid_id,'tournament_id',t,'user_id',user_id,'table_id',tab,'seat_number',1,'stack',2500,
 'seat_id',md5('eb-seat1')::uuid,'occupancy_id',(SELECT occupancy_id FROM table_seats WHERE table_id=tab AND seat_number=1),'assigned_at','2026-09-18 12:46:54+00',
 'original_ledger_id',source_ledger_id,'original_entitlement_id',entitlement_id) WHERE id=paid_id;
 INSERT INTO smarter_private.f06_hand_permits
 SELECT (jsonb_populate_record(NULL::smarter_private.f06_hand_permits,witness->'original_permit')).*;
 INSERT INTO table_hole_cards(id,table_id,hand_number,user_id,seat_number,cards)
 SELECT md5('eb-card'||seat_number)::uuid,tab,12636137,user_id,seat_number,'["Ac","Kd"]'::jsonb
 FROM table_seats WHERE table_id=tab;
END $$;

CREATE FUNCTION fixture_pruned_earlybird_expected() RETURNS jsonb LANGUAGE sql AS $$
 WITH w AS(SELECT $witness$__WITNESS_JSON__$witness$::jsonb x),
 e AS(SELECT fixture_expected_mixed((w.x#>>'{original_permit,tournament_id}')::uuid) x FROM w),
 p AS(SELECT paid.* FROM tournament_paid_stack_custody_receipts paid,w WHERE paid.id=(w.x->>'paid_receipt_id')::uuid)
 SELECT jsonb_set(e.x,'{hands,0}',(e.x#>'{hands,0}')||jsonb_build_object(
 'snapshot_id',w.x#>'{snapshot,id}','snapshot_hash',w.x#>'{snapshot,row_hash}','prior',NULL,
 'interruption',jsonb_build_object('kind','pruned_completed_unaccepted_mtt','snapshot_witness',w.x,
 'paid_receipt_id',p.id,'paid_receipt_hash',md5(to_jsonb(p)::text),
 'cards',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id)
 FROM table_hole_cards c WHERE c.table_id=p.destination_table_id AND c.hand_number=12636137),
 'registrations',(SELECT jsonb_agg(jsonb_build_object('id',r.id,'user_id',r.user_id,'row_hash',md5(to_jsonb(r)::text)) ORDER BY r.id) FROM tournament_players r WHERE r.tournament_id=p.tournament_id),
 'financial_receipts',jsonb_build_object(
 'settlements',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM ca_settlements c WHERE c.table_id=p.destination_table_id),
 'settlement_keys',(SELECT jsonb_agg(jsonb_build_object('hand_id',k.hand_id,'row_hash',md5(to_jsonb(k)::text)) ORDER BY k.hand_id) FROM settlement_idempotency_keys k WHERE k.table_id=p.destination_table_id),
 'atomic',(SELECT jsonb_agg(jsonb_build_object('hand_id',a.hand_id,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.hand_number) FROM hand_atomic_commits a WHERE a.table_id=p.destination_table_id),
 'history',(SELECT jsonb_agg(jsonb_build_object('hand_id',h.id,'row_hash',md5(to_jsonb(h)::text)) ORDER BY h.hand_number) FROM hand_history h WHERE h.table_id=p.destination_table_id))))) FROM e,w,p $$;
