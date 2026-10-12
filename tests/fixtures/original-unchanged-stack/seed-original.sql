SELECT pg_temp.seed_race('10000000-0000-0000-0000-000000000001',200,'2026-10-06 15:33:07+00',139.55,139.55,0,'addon',-0.5,139.05,NULL);
DELETE FROM cash_participant_funding_receipts WHERE amount=0;
DELETE FROM chip_ledger WHERE amount=0;
UPDATE cash_participant_funding_receipts f SET account_type=l.from_type,account_entity_id=l.from_entity_id,
 balance_before=f.amount+1000,balance_after=1000 FROM chip_ledger l WHERE l.id=f.source_ledger_id;
UPDATE cash_hand_participant_manifests m SET participants=(SELECT jsonb_agg(z.v||jsonb_build_object('funding_lineage',lin.v,'funding_receipts',lin.v->'funding_receipts'))
 FROM jsonb_array_elements(m.participants)z(v) CROSS JOIN LATERAL(SELECT fn_cash_original_funding_lineage((z.v->>'user_id')::uuid,m.table_id,(z.v->>'seat_id')::uuid,(z.v->>'occupancy_id')::uuid,(z.v->>'seat_joined_at')::timestamptz,m.captured_at,false) v)lin);
UPDATE cash_hand_provenance_receipts p SET participants=(SELECT jsonb_agg(z.v||mp.v-'stack_before'||jsonb_build_object('stack_before',z.v->'stack_before','stack_after',z.v->'stack_after')) FROM jsonb_array_elements(p.participants)z(v) JOIN cash_hand_participant_manifests m ON m.id=p.manifest_id CROSS JOIN LATERAL jsonb_array_elements(m.participants)mp(v) WHERE mp.v->>'user_id'=z.v->>'user_id'),rake=0,bbj=0,signed_external_net=0;
UPDATE cash_hand_provenance_receipts p SET accepted_request=jsonb_build_object('table_id',p.table_id,'hand_number',p.hand_number,'rake',0,'bbj',0,'inflow',0,'stacks',(SELECT jsonb_agg(z.v||jsonb_build_object('stack',z.v->'stack_after')) FROM jsonb_array_elements(p.participants)z(v)));
UPDATE cash_hand_provenance_receipts SET payload_hash=encode(extensions.digest(convert_to(accepted_request::text,'UTF8'),'sha256'),'hex');
UPDATE cash_hand_provenance_receipts p SET atomic_receipt=jsonb_build_object('table_id',p.table_id,'hand_number',p.hand_number,'hand_id',p.hand_id,'payload_hash',p.payload_hash,'stack_result',jsonb_build_object('hand_id',p.hand_id,'table_id',p.table_id,'success',true,'mode','delta','conservation_checked',true,'request',p.accepted_request));
UPDATE cash_hand_provenance_receipts p SET stack_claim=jsonb_build_object('table_id',p.table_id,'hand_id',p.hand_id,'status','succeeded','result',p.atomic_receipt->'stack_result'),stack_settlement=jsonb_build_object('table_id',p.table_id,'hand_id',p.hand_id,'state','final');
ALTER TABLE union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
UPDATE union_pnl_cash_outcomes o SET payload_hash=p.payload_hash,evidence=jsonb_set(o.evidence,'{participants}',(SELECT jsonb_agg(z.v||jsonb_build_object('ownership_scope','original_chip_funding_club')) FROM jsonb_array_elements(o.evidence->'participants')z(v))) FROM cash_hand_provenance_receipts p WHERE p.table_id=o.table_id AND p.hand_number=o.hand_number;
ALTER TABLE union_pnl_cash_outcomes ENABLE TRIGGER original_pnl_immutable;
