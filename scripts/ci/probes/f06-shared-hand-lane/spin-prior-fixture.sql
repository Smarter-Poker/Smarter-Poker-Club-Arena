-- Retained evidence shape only; no replacement business authority.
CREATE TABLE public.financial_alerts(id uuid PRIMARY KEY,source text,context jsonb,
 message text,resolved boolean DEFAULT false,severity text,created_at timestamptz DEFAULT now(),
 resolution text,resolved_at timestamptz,resolved_by uuid);
CREATE FUNCTION fixture_spin_prior_expected(t uuid) RETURNS jsonb LANGUAGE sql AS $$
 WITH e AS(SELECT fixture_expected_mixed(t) x),
 h AS(SELECT p.* FROM smarter_private.f06_hand_permits p WHERE p.tournament_id=t AND p.state='reserved')
 SELECT jsonb_set(e.x,'{hands,0,interruption}',jsonb_build_object(
 'registrations',(SELECT jsonb_agg(jsonb_build_object('registration_id',p.id,'user_id',p.user_id,
   'row_hash',md5(to_jsonb(p)::text)) ORDER BY p.id) FROM public.tournament_players p WHERE p.tournament_id=t),
 'completed_snapshots',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'hand_number',s.hand_number,
   'is_complete',s.is_complete,'row_hash',md5(to_jsonb(s)::text)) ORDER BY s.id),'[]')
   FROM public.hand_state_snapshots s WHERE s.table_id=h.table_id AND s.hand_number>=h.hand_number),
 'atomic_refusals',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.id),'[]')
   FROM public.financial_alerts a WHERE a.source='ServerTableEngine.authoritative_hand_semantic_refusal'
   AND a.context->>'table_id'=h.table_id::text AND a.context->>'hand_number'=h.hand_number::text))
 || COALESCE((SELECT jsonb_build_object('retired_dispatch',jsonb_build_object(
   'dispatch',to_jsonb(d),'dispatch_hash',md5(to_jsonb(d)::text),'transaction_status','committed',
   'refusal',to_jsonb(a),'refusal_hash',md5(to_jsonb(a)::text),
   'proof_kind','ended_dispatch_prior_canonical_stack_boundary','transaction_link_asserted',false,
   'financial_receipts',jsonb_build_object(
     'settlements',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'hand_id',c.hand_id,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM public.ca_settlements c WHERE c.table_id=h.table_id),
     'settlement_keys',(SELECT jsonb_agg(jsonb_build_object('hand_id',k.hand_id,'row_hash',md5(to_jsonb(k)::text)) ORDER BY k.hand_id) FROM public.settlement_idempotency_keys k WHERE k.table_id=h.table_id),
     'atomic',(SELECT jsonb_agg(jsonb_build_object('hand_id',ac.hand_id,'hand_number',ac.hand_number,'row_hash',md5(to_jsonb(ac)::text)) ORDER BY ac.hand_number) FROM public.hand_atomic_commits ac WHERE ac.table_id=h.table_id),
     'history',(SELECT jsonb_agg(jsonb_build_object('hand_id',hh.id,'hand_number',hh.hand_number,'row_hash',md5(to_jsonb(hh)::text)) ORDER BY hh.hand_number) FROM public.hand_history hh WHERE hh.table_id=h.table_id))))
   FROM smarter_private.f06_hand_dispatch d JOIN public.financial_alerts a
   ON a.source='ServerTableEngine.authoritative_hand_semantic_refusal'
   AND a.context->>'table_id'=h.table_id::text AND a.context->>'hand_number'=h.hand_number::text
   WHERE d.permit_id=h.permit_id),'{}'::jsonb))
 FROM e,h $$;
