SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
SELECT fixture.assert((fn_cash_capture_hand_manifest(fixture.u(1203),1013003,fixture.move_roster(1203),'move-native',fixture.u(1299))->>'funding_provenance_complete')::boolean,'GREEN exact two-hop original move funding is captured');
SELECT fixture.assert((fn_cash_capture_hand_manifest(fixture.u(1204),1013004,fixture.move_roster(1204),'move-native',fixture.u(1299))->>'funding_provenance_complete')::boolean,'GREEN same-club wallet and treasury are separately retained');
CREATE FUNCTION fixture.move_hand(t int,n bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE stacks jsonb;r jsonb;BEGIN
 SELECT jsonb_agg(jsonb_build_object('user_id',x->'user_id','seat_id',x->'seat_id','occupancy_id',x->'occupancy_id','seat_joined_at',x->'seat_joined_at',
 'funding_manifest_id',m.id,'stack_before',x->'stack_before','stack',(x->>'stack_before')::numeric+CASE x->>'user_id' WHEN fixture.u(1190)::text THEN 10 WHEN fixture.u(1191)::text THEN -10 ELSE 0 END)) INTO stacks
 FROM cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) x WHERE m.table_id=fixture.u(t) AND m.hand_number=n;
 r:=fn_ca_commit_hand_settlement_before_lease_generation(fixture.u(t),n,stacks,0,0,NULL,0,jsonb_build_object('table_id',fixture.u(t),'hand_number',n),'[]');
 PERFORM fixture.assert(r->>'success'='true','Actual zero-rake original hand acceptance: '||r::text);
 r:=fn_pnl_cash_hand_evidence(fixture.u(t),n);
 PERFORM fixture.assert(r->>'status'='ready','Accepted original hand P&L certified: '||r::text);RETURN r;
END $$;
SELECT fixture.move_hand(1203,1013003);
SELECT fixture.move_hand(1204,1013004);
SELECT fixture.assert((SELECT jsonb_array_length(p->'funding_lineage'->'moves')=2 FROM cash_hand_participant_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.participants) p WHERE hand_number=1013003 AND p->>'user_id'=fixture.u(1190)::text),'Two original immutable move receipts retained in accepted manifest');
SELECT fixture.assert((SELECT count(DISTINCT account_type)=2 AND count(DISTINCT source_ledger_id)=2 FROM cash_participant_funding_receipts WHERE user_id=fixture.u(1192)),'Same club retains distinct original wallet and treasury debits');
SELECT fixture.assert((SELECT bool_and(NOT funding_provenance_complete) FROM cash_hand_participant_manifests WHERE hand_number IN(1013001,1013002)),'Legacy uncertified manifests are never silently rewritten');
SELECT fixture.assert(fn_cash_seat_move_execute(fixture.u(1302))=(SELECT receipt FROM cash_seat_move_receipts WHERE move_id=fixture.u(1302)),'Original move replay returns exact retained result');
-- A new movement obtains its real original transaction frame atomically.
SELECT fixture.move(1304,1190,1203,1202);
SELECT fixture.assert((SELECT r.transaction_id IS NOT NULL AND f.transaction_id IS NOT NULL FROM cash_seat_move_receipts r LEFT JOIN union_pnl_transaction_frames f USING(transaction_id) WHERE move_id=fixture.u(1304)),'New original move records its own original book frame');
CREATE FUNCTION fixture.lineage(p int,b boolean DEFAULT false,a timestamptz DEFAULT clock_timestamp()) RETURNS jsonb LANGUAGE sql AS $$
 SELECT fn_cash_original_funding_lineage(s.user_id,s.table_id,s.id,s.occupancy_id,s.joined_at,a,b) FROM table_seats s WHERE user_id=fixture.u(p) AND left_at IS NULL
$$;
SELECT fixture.assert(fixture.lineage(1190)->'issues'='[]','Three-hop original custody chain remains exact');
SELECT fixture.assert(fixture.lineage(1190,true)->'issues' @> '["cash_move_original_transaction_frame_missing"]','Boundary refuses an old move without original book frame');
-- Exact original negative controls use rolled-back corruption in the private
-- database only. No legacy source is backfilled by the migration or test.
DO $$ DECLARE before_rows int; BEGIN
 FOR before_rows IN 1..3 LOOP
  BEGIN
   IF before_rows=1 THEN UPDATE cash_seat_move_receipts SET amount=amount+1 WHERE move_id=fixture.u(1304);
   ELSIF before_rows=2 THEN DELETE FROM cash_seat_move_receipts WHERE move_id=fixture.u(1304);
   ELSE TRUNCATE cash_seat_move_receipts; END IF;
   RAISE EXCEPTION 'immutable movement guard missing';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 END LOOP;
 PERFORM fixture.assert(true,'Original move receipt refuses update, delete and truncate');
END $$;
DO $$ DECLARE row public.cash_seat_move_receipts%ROWTYPE; r jsonb; BEGIN
 SELECT * INTO row FROM cash_seat_move_receipts WHERE move_id=fixture.u(1304);
 BEGIN
  ALTER TABLE cash_seat_move_receipts DISABLE TRIGGER cash_move_receipt_immutable;
  UPDATE cash_seat_move_receipts SET player_id=fixture.u(1191) WHERE move_id=row.move_id;
  PERFORM fixture.assert(fixture.lineage(1190)->'issues' @> '["cash_move_original_receipt_invalid"]','Different player cannot inherit original funding');
  RAISE SQLSTATE 'ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
 BEGIN
  ALTER TABLE cash_seat_move_receipts DISABLE TRIGGER cash_move_receipt_immutable;
  UPDATE cash_seat_move_receipts SET amount=amount+1 WHERE move_id=row.move_id;
  PERFORM fixture.assert(fixture.lineage(1190)->'issues' @> '["cash_move_original_receipt_invalid"]','Changed amount cannot inherit original funding');
  RAISE SQLSTATE 'ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
 BEGIN
  ALTER TABLE cash_seat_move_receipts DISABLE TRIGGER cash_move_receipt_immutable;
  UPDATE cash_seat_move_receipts SET source_occupancy_id=row.destination_occupancy_id,receipt=jsonb_set(receipt,'{source_occupancy_id}',to_jsonb(row.destination_occupancy_id)) WHERE move_id=fixture.u(1301);
  PERFORM fixture.assert(fixture.lineage(1190)->'issues'<>'[]','A receipt-consistent original custody cycle is refused');
  RAISE SQLSTATE 'ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
 BEGIN
  ALTER TABLE cash_seat_move_receipts DISABLE TRIGGER cash_move_receipt_immutable;
  UPDATE cash_seat_move_receipts SET amount=amount+1,receipt=jsonb_set(receipt,'{stack}',to_jsonb(amount+1)) WHERE move_id=fixture.u(1302);
  PERFORM fixture.assert(fn_pnl_cash_hand_evidence(fixture.u(1203),1013003)->>'status'='blocked','Accepted hand refuses changed original frozen move evidence');
  RAISE SQLSTATE 'ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
 BEGIN
  row.move_id:=fixture.u(1399);
  INSERT INTO cash_seat_move_receipts SELECT row.*;
  PERFORM fixture.assert(fixture.lineage(1190)->'issues' @> '["cash_move_destination_fork"]','Forked destination cannot choose a guessed original owner');
  RAISE SQLSTATE 'ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
 BEGIN
  UPDATE chip_ledger SET from_entity_id=fixture.u(1191) WHERE id=(SELECT source_ledger_id FROM cash_participant_funding_receipts WHERE user_id=fixture.u(1190) AND operation_kind='buyin');
  PERFORM fixture.assert(fixture.lineage(1190)->'issues' @> '["cash_lineage_original_debit_invalid"]','Mismatched exact original debit is refused');
  RAISE SQLSTATE 'ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
END $$;
-- Actual original buy-in and move in ONE transaction share their exact frame,
-- despite now() move creation preceding clock_timestamp() funding recording.
INSERT INTO auth.users(id) VALUES(fixture.u(1194));
INSERT INTO profiles(id,username,is_horse) VALUES(fixture.u(1194),'move_native_1194',false);
INSERT INTO club_members(user_id,club_id,chip_balance,role,status) VALUES(fixture.u(1194),fixture.u(101),500,'player','active');
DO $$ BEGIN
 PERFORM atomic_table_buyin_before_maintenance_announcement_gate(fixture.u(1194),fixture.u(1201),3,100,false,fixture.u(101),NULL);
 PERFORM fixture.move(1307,1194,1201,1202);
END $$;
SELECT fixture.assert(fixture.lineage(1194,true)->'issues'='[]','Same original transaction funding precedes custody by exact frame identity');
SELECT fixture.move(1305,1192,1204,1201);
SELECT fixture.move(1306,1193,1204,1201);
-- Same-account corruption must not be hidden by club-level attribution.
DO $$ BEGIN
 BEGIN
  ALTER TABLE cash_participant_funding_receipts DISABLE TRIGGER cash_funding_immutable;
  UPDATE cash_participant_funding_receipts SET funding_club_id=fixture.u(102) WHERE user_id=fixture.u(1192) AND account_type='club_treasury';
  PERFORM fixture.assert(fixture.lineage(1192)->'issues'<>'[]','Cross-club funding or account corruption stays unqualified');
  RAISE SQLSTATE 'ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
END $$;

DO $$ BEGIN
 BEGIN
  ALTER TABLE cash_participant_funding_receipts DISABLE TRIGGER cash_funding_immutable;
  UPDATE cash_participant_funding_receipts SET funding_union_id=fixture.u(203) WHERE user_id=fixture.u(1192) AND account_type='club_treasury';
  PERFORM fixture.assert((fn_cash_capture_hand_manifest(fixture.u(1201),1013010,fixture.move_roster(1201),'move-native',fixture.u(1299))->>'funding_provenance_complete')::boolean=false,'Different original funding Unions cannot qualify as same-club provenance');
  RAISE SQLSTATE 'ZX001';
 EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;END;
 PERFORM fixture.assert(NOT has_function_privilege('authenticated','fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)','EXECUTE') AND NOT has_function_privilege('service_role','fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)','EXECUTE'),'Original lineage primitive remains private');
END $$;
