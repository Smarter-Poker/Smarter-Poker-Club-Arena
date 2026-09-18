 -- A legacy returned refusal can leave its dispatch row committed while the
 -- nested financial subtransaction rolls back. Preserve that row. It is not
 -- evidence of accepted play, nor intrinsically linked to an alert transaction.
 SELECT * INTO v_dispatch FROM smarter_private.f06_hand_dispatch
 WHERE permit_id=h.permit_id FOR UPDATE;
 IF FOUND THEN
 IF event.format_contract IS DISTINCT FROM 'spin-v1'
 OR cardinality(reserved_ids)<>1 OR jsonb_array_length(event_roster) IS DISTINCT FROM 3
 OR txid_status(v_dispatch.xid) IS DISTINCT FROM 'committed'
 OR EXISTS(SELECT 1 FROM pg_stat_activity
   WHERE backend_xid::text::bigint=mod(v_dispatch.xid,4294967296::bigint))
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND NOT is_complete)
 OR NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id
   AND hand_number=h.hand_number AND is_complete)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;
 SELECT * INTO v_refusal FROM public.financial_alerts
 WHERE id=(expected_item#>>'{interruption,retired_dispatch,refusal,id}')::uuid FOR SHARE;
 IF NOT FOUND OR v_refusal.source IS DISTINCT FROM 'ServerTableEngine.authoritative_hand_semantic_refusal'
 OR v_refusal.context->>'channel' IS DISTINCT FROM 'server_rpc'
 OR v_refusal.context->>'table_id' IS DISTINCT FROM h.table_id::text
 OR v_refusal.context->>'hand_number' IS DISTINCT FROM h.hand_number::text
 OR v_refusal.context->>'error' IS DISTINCT FROM 'atomic hand commit refused (atomic_hand_rolled_back): cannot find parent statement on pldbgapi2 call stack'
 OR v_refusal.context#>>'{hand_request_identity_v1,version}' IS DISTINCT FROM '1'
 OR v_refusal.context#>>'{hand_request_identity_v1,table_id}' IS DISTINCT FROM h.table_id::text
 OR v_refusal.context#>>'{hand_request_identity_v1,hand_number}' IS DISTINCT FROM h.hand_number::text
 OR v_refusal.context#>'{hand_request_identity_v1,post_commit_required}' IS DISTINCT FROM 'true'::jsonb
 OR NOT COALESCE(pg_input_is_valid(v_refusal.context#>>'{hand_request_identity_v1,hand_id}','uuid'),false)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE hand_id=(v_refusal.context#>>'{hand_request_identity_v1,hand_id}')::uuid)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE id=(v_refusal.context#>>'{hand_request_identity_v1,hand_id}')::uuid)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE hand_id=(v_refusal.context#>>'{hand_request_identity_v1,hand_id}')::uuid) THEN
 RAISE EXCEPTION 'F06_SPIN_ORIGINAL_REFUSAL_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every retained financial receipt must belong to an already accepted hand.
 -- Join the actual stored stack receipt identity; never guess the missing ref.
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
 RAISE EXCEPTION 'F06_SPIN_FINANCIAL_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 retired_dispatch:=jsonb_build_object('dispatch',to_jsonb(v_dispatch),'dispatch_hash',md5(to_jsonb(v_dispatch)::text),
   'transaction_status','committed','refusal',to_jsonb(v_refusal),'refusal_hash',md5(to_jsonb(v_refusal)::text),
   'proof_kind','ended_dispatch_prior_canonical_stack_boundary','transaction_link_asserted',false,
   'financial_receipts',jsonb_build_object(
     'settlements',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'hand_id',c.hand_id,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM public.ca_settlements c WHERE c.table_id=h.table_id),
     'settlement_keys',(SELECT jsonb_agg(jsonb_build_object('hand_id',k.hand_id,'row_hash',md5(to_jsonb(k)::text)) ORDER BY k.hand_id) FROM public.settlement_idempotency_keys k WHERE k.table_id=h.table_id),
     'atomic',(SELECT jsonb_agg(jsonb_build_object('hand_id',a.hand_id,'hand_number',a.hand_number,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.hand_number) FROM public.hand_atomic_commits a WHERE a.table_id=h.table_id),
     'history',(SELECT jsonb_agg(jsonb_build_object('hand_id',x.id,'hand_number',x.hand_number,'row_hash',md5(to_jsonb(x)::text)) ORDER BY x.hand_number) FROM public.hand_history x WHERE x.table_id=h.table_id)));
 END IF;
