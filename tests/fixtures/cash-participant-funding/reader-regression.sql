-- The original accepted hand, including departed and zero-delta players, is read.
DO $$ DECLARE r jsonb; BEGIN
 r:=fn_pnl_cash_hand_evidence('20000000-0000-4000-8000-000000000001',1000001);
 PERFORM pg_temp.assert(r->>'status'='ready' AND r->>'basis_certified'='true' AND r->>'all_players_included'='true'
  AND jsonb_array_length(r->'participants')=3 AND (r->>'observed_delta_total')::numeric=0, 'Original complete accepted zero-rake hand must qualify: '||r::text);
 PERFORM pg_temp.assert(r->'participants'->0->>'earning_club_id'='10000000-0000-4000-8000-000000000002'
  AND r->>'payment_authorized'='false', 'Retain original cross-club funding without payment authorization');
 r:=fn_pnl_cash_hand_evidence('20000000-0000-4000-8000-000000000001',1000006);
 PERFORM pg_temp.assert(r->>'status'='ready' AND jsonb_array_length(r->'participants')=3,
  'All-horse zero-rake accepted hand must qualify: '||r::text);
 r:=fn_pnl_cash_hand_evidence('20000000-0000-4000-8000-000000000001',1000002);
 PERFORM pg_temp.assert(r->>'status'='blocked' AND r->'issues' ? 'external_bank_receipt_not_certified',
  'Signed net alone cannot certify original external bank source');
END $$;
-- A nonzero real accepted hand has +9, -10 and zero original participant deltas.
SELECT fn_cash_capture_hand_manifest('20000000-0000-4000-8000-000000000001',1000007,pg_temp.roster(),'fixture','60000000-0000-4000-8000-000000000001');
DO $$ DECLARE s jsonb; r jsonb; BEGIN
 SELECT jsonb_agg(value||jsonb_build_object('stack',(value->>'stack_before')::numeric+
  CASE value->>'user_id' WHEN '40000000-0000-4000-8000-000000000001' THEN 9
  WHEN '40000000-0000-4000-8000-000000000002' THEN -10 ELSE 0 END)) INTO s
 FROM jsonb_array_elements(pg_temp.stacks(0,1000007));
 PERFORM pg_temp.assert(pg_temp.commit_hand(1000007,s,1,0,0)->>'success'='true','Original nonzero accepted hand must commit');
 r:=fn_pnl_cash_hand_evidence('20000000-0000-4000-8000-000000000001',1000007);
 PERFORM pg_temp.assert(r->>'status'='ready' AND (r->>'observed_delta_total')::numeric=-1
  AND (r->'participants'->0->>'observed_stack_delta')::numeric=9
  AND (r->'participants'->1->>'observed_stack_delta')::numeric=-10
  AND (r->'participants'->2->>'observed_stack_delta')::numeric=0,
  'Cash PNL must retain exact signed deltas and zero participant: '||r::text);
END $$;
-- Private-cluster tampering exercises fail-closed linkage; each subtransaction rolls back.
DO $$ DECLARE r jsonb; kind text; BEGIN
 FOREACH kind IN ARRAY ARRAY['payload','population','ledger','claim'] LOOP
  BEGIN
   IF kind='payload' THEN
    ALTER TABLE cash_hand_provenance_receipts DISABLE TRIGGER cash_hand_provenance_immutable;
    UPDATE cash_hand_provenance_receipts SET accepted_request=accepted_request||'{"inflow":2}' WHERE hand_number=1000001;
   ELSIF kind='population' THEN
    ALTER TABLE cash_hand_participant_manifests DISABLE TRIGGER cash_manifest_immutable;
    UPDATE cash_hand_participant_manifests SET participants=participants-2 WHERE hand_number=1000001;
   ELSIF kind='ledger' THEN
    UPDATE chip_ledger SET club_id='10000000-0000-4000-8000-000000000001'
     WHERE id=(SELECT source_ledger_id FROM cash_participant_funding_receipts WHERE user_id='40000000-0000-4000-8000-000000000001' AND operation_kind='buyin');
   ELSE
    UPDATE settlement_idempotency_keys SET status='failed' WHERE hand_id=(SELECT (stack_result->>'hand_id')::uuid FROM hand_atomic_commits WHERE hand_number=1000001);
   END IF;
   r:=fn_pnl_cash_hand_evidence('20000000-0000-4000-8000-000000000001',1000001);
   PERFORM pg_temp.assert(r->>'status'='blocked' AND r->>'basis_certified'='false','Damaged '||kind||' linkage must refuse: '||r::text);
   RAISE EXCEPTION 'rollback_reader_mutation' USING ERRCODE='P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
 END LOOP;
END $$;

-- Original accounting evidence survives ordinary pruning of game history and stack claims.
DO $$ BEGIN
 BEGIN
  DELETE FROM hand_atomic_commits;
  DELETE FROM settlement_idempotency_keys;
  DELETE FROM ca_settlements;
  PERFORM pg_temp.assert(fn_pnl_cash_hand_evidence('20000000-0000-4000-8000-000000000001',1000007)->>'status'='ready',
   'Game retention cannot erase complete immutable financial proof');
  RAISE EXCEPTION 'rollback_reader_pruning' USING ERRCODE='P0099';
 EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
 END;
END $$;
