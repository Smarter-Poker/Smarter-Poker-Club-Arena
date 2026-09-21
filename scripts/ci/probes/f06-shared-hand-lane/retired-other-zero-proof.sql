 -- The target-table financial scan cannot certify another original table.
 -- Lock and retain this accepted hand's independent succeeded key and exactly
 -- one final stack settlement. No amount, rank, occupancy or move is changed.
 SELECT * INTO zero_key FROM public.settlement_idempotency_keys
 WHERE table_id=a.table_id AND hand_id=(r->>'stack_hand_id')::uuid FOR SHARE;
 PERFORM 1 FROM public.ca_settlements
 WHERE table_id=a.table_id AND hand_id=(r->>'stack_hand_id')::uuid ORDER BY id FOR SHARE;
 SELECT * INTO zero_settlement FROM public.ca_settlements
 WHERE table_id=a.table_id AND hand_id=(r->>'stack_hand_id')::uuid;
 IF zero_key.hand_id IS NULL OR zero_key.status IS DISTINCT FROM 'succeeded'
 OR zero_key.result IS DISTINCT FROM a.stack_result OR zero_key.error IS NOT NULL
 OR zero_key.completed_at IS NULL OR NOT isfinite(zero_key.completed_at)
 OR (SELECT count(*) FROM public.ca_settlements
 WHERE table_id=a.table_id AND hand_id=(r->>'stack_hand_id')::uuid)<>1
 OR zero_settlement.settlement_type IS DISTINCT FROM 'hand_stacks'
 OR zero_settlement.state IS DISTINCT FROM 'final' OR zero_settlement.error_detail IS NOT NULL THEN
 RAISE EXCEPTION 'F06_RETAINED_ZERO_FINANCIAL_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
