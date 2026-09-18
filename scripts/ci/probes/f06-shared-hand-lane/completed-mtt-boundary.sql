 -- A legacy engine completed this preflop snapshot before settlement was
 -- accepted. Its exact persisted investment and original paid-custody receipt
 -- prove the unchanged committed roster, never a hand result or no-start.
 IF snap.is_complete THEN
 IF event.format_contract NOT IN ('mtt-v1','mtt-v2')
 OR cardinality(tab_ids)<>1 OR cardinality(reserved_ids)<>1
 OR expected_item#>>'{interruption,kind}' IS DISTINCT FROM 'completed_unaccepted_mtt'
 OR jsonb_typeof(snap.state_json->'actionHistory') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'actionHistory')<>0 THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO paid FROM public.tournament_paid_stack_custody_receipts
 WHERE id=(expected_item#>>'{interruption,paid_receipt_id}')::uuid FOR SHARE;
 IF NOT FOUND OR paid.state IS DISTINCT FROM 'seated'
 OR paid.tournament_id IS DISTINCT FROM t OR paid.destination_table_id IS DISTINCT FROM h.table_id
 OR paid.expected->>'generation' IS DISTINCT FROM h.generation::text
 OR paid.completed_at IS NULL OR paid.completed_at>snap.created_at
 OR paid.assignment->'ok' IS DISTINCT FROM 'true'::jsonb
 OR paid.assignment->>'receipt_id' IS DISTINCT FROM paid.id::text
 OR paid.assignment->>'original_ledger_id' IS DISTINCT FROM paid.source_ledger_id::text
 OR paid.assignment->>'original_entitlement_id' IS DISTINCT FROM paid.entitlement_id::text
 OR jsonb_typeof(paid.expected->'live_seats') IS DISTINCT FROM 'array'
 OR jsonb_array_length(paid.expected->'live_seats')<>jsonb_array_length(roster)-1
 OR (SELECT sum((x->>'stack')::numeric) FROM jsonb_array_elements(roster) x)
    IS DISTINCT FROM paid.live_chips_before+paid.grant_chips
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r
 WHERE r->>'user_id'=paid.user_id::text AND r->>'seat_id'=paid.assignment->>'seat_id'
 AND r->>'occupancy_id'=paid.assignment->>'occupancy_id'
 AND (r->>'joined_at')::timestamptz=(paid.assignment->>'assigned_at')::timestamptz
 AND (r->>'seat_number')::integer=paid.destination_seat_number
 AND (r->>'stack')::numeric=paid.grant_chips)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r WHERE r->>'user_id'<>paid.user_id::text
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(paid.expected->'live_seats') x
 WHERE x->>'id'=r->>'seat_id' AND x->>'occupancy_id'=r->>'occupancy_id'
 AND x->>'user_id'=r->>'user_id' AND x->>'table_id'=r->>'table_id'
 AND (x->>'joined_at')::timestamptz=(r->>'joined_at')::timestamptz
 AND (x->>'seat_number')::integer=(r->>'seat_number')::integer
 AND (x->>'stack')::numeric=(r->>'stack')::numeric)) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 -- Lease/lane admission above drains real writers; the retained-submission
 -- disposition fence also serializes a racing original payload retention.
 IF EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id
 AND (hand_number>h.hand_number OR (hand_number=h.hand_number AND id<>snap.id)))
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number>h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_LATER_CUSTODY' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r WHERE r->>'user_id'=c.user_id::text
 AND (r->>'seat_number')::integer=c.seat_number)) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_CARDS_CHANGED' USING ERRCODE='55000'; END IF;
 -- An orphan monetary receipt is not evidence of a safely unaccepted hand.
 -- Join actual recorded stack receipt identity, never a guessed hand ref.
 PERFORM 1 FROM public.ca_settlements WHERE table_id=h.table_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.settlement_idempotency_keys WHERE table_id=h.table_id ORDER BY hand_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k
 LEFT JOIN public.hand_atomic_commits a ON a.table_id=k.table_id AND a.stack_result->>'hand_id'=k.hand_id::text
 WHERE k.table_id=h.table_id AND (k.status IS DISTINCT FROM 'succeeded' OR a.hand_id IS NULL
 OR k.result IS DISTINCT FROM a.stack_result))
 OR EXISTS(SELECT 1 FROM public.ca_settlements c LEFT JOIN public.settlement_idempotency_keys k
 ON k.table_id=c.table_id AND k.hand_id=c.hand_id
 WHERE c.table_id=h.table_id AND (c.settlement_type IS DISTINCT FROM 'hand_stacks'
 OR c.state IS DISTINCT FROM 'final' OR k.hand_id IS NULL))
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=h.table_id AND (
 a.hand_number>=h.hand_number OR a.post_commit_completed_at IS NULL OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE x.id=a.hand_id AND x.table_id=a.table_id AND x.hand_number=a.hand_number)
 OR NOT EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=a.table_id AND k.hand_id::text=a.stack_result->>'hand_id')
 OR (SELECT count(*) FROM public.ca_settlements c WHERE c.table_id=a.table_id AND c.hand_id::text=a.stack_result->>'hand_id')<>1))
 OR EXISTS(SELECT 1 FROM public.hand_history x WHERE x.table_id=h.table_id
 AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=x.id AND a.table_id=x.table_id AND a.hand_number=x.hand_number)) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_FINANCIAL_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 historical:=jsonb_build_object('kind','completed_unaccepted_mtt','paid_receipt_id',paid.id,
 'paid_receipt_hash',md5(to_jsonb(paid)::text),
 'cards',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,
 'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number),
 'registrations',(SELECT jsonb_agg(jsonb_build_object('id',p.id,'user_id',p.user_id,'row_hash',md5(to_jsonb(p)::text)) ORDER BY p.id)
 FROM public.tournament_players p WHERE p.tournament_id=t),
 'financial_receipts',jsonb_build_object(
 'settlements',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM public.ca_settlements c WHERE c.table_id=h.table_id),
 'settlement_keys',(SELECT jsonb_agg(jsonb_build_object('hand_id',k.hand_id,'row_hash',md5(to_jsonb(k)::text)) ORDER BY k.hand_id) FROM public.settlement_idempotency_keys k WHERE k.table_id=h.table_id),
 'atomic',(SELECT jsonb_agg(jsonb_build_object('hand_id',a.hand_id,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.hand_number) FROM public.hand_atomic_commits a WHERE a.table_id=h.table_id),
 'history',(SELECT jsonb_agg(jsonb_build_object('hand_id',x.id,'row_hash',md5(to_jsonb(x)::text)) ORDER BY x.hand_number) FROM public.hand_history x WHERE x.table_id=h.table_id)));
 END IF;
