 -- A completed snapshot records that this hand existed, not an accepted
 -- monetary outcome. The preceding canonical receipt remains the sole stack
 -- authority. Bind all retained original evidence without rewriting it.
 IF event.format_contract='spin-v1' THEN
 IF event.table_size IS DISTINCT FROM 3 OR cardinality(tab_ids)<>1
 OR cardinality(reserved_ids)<>1 OR jsonb_array_length(roster) NOT BETWEEN 2 AND 3
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=h.table_id AND max_players=3)
 OR (SELECT count(DISTINCT (x->>'seat_number')::integer) FROM jsonb_array_elements(roster) x)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(roster) x
 WHERE (x->>'seat_number')::integer NOT BETWEEN 1 AND 3 OR (x->>'stack')::numeric<=0)
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=t)<>3
 OR (SELECT count(DISTINCT user_id) FROM public.tournament_players WHERE tournament_id=t)<>3
 OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=t AND status IS DISTINCT FROM 'playing'
 AND (status IS DISTINCT FROM 'eliminated' OR chips IS DISTINCT FROM 0))
 OR expected_item#>>'{prior,kind}' IS NOT NULL THEN
 RAISE EXCEPTION 'F06_SPIN_PRIOR_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id
 AND hand_number>(prior_proof->>'hand_number')::bigint AND state='accepted')
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number>h.hand_number)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_SPIN_PRIOR_LATER_CUSTODY' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id
 AND hand_number>=h.hand_number ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.financial_alerts WHERE source='ServerTableEngine.authoritative_hand_semantic_refusal'
 AND context->>'table_id'=h.table_id::text AND context->>'hand_number'=h.hand_number::text
 ORDER BY id FOR SHARE;
 historical:=jsonb_build_object(
 'registrations',(SELECT jsonb_agg(jsonb_build_object('registration_id',p.id,'user_id',p.user_id,
   'row_hash',md5(to_jsonb(p)::text)) ORDER BY p.id) FROM public.tournament_players p WHERE p.tournament_id=t),
 'completed_snapshots',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'id',s.id,'hand_number',s.hand_number,'is_complete',s.is_complete,'row_hash',md5(to_jsonb(s)::text)) ORDER BY s.id),'[]')
   FROM public.hand_state_snapshots s WHERE s.table_id=h.table_id AND s.hand_number>=h.hand_number),
 'atomic_refusals',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'id',a.id,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.id),'[]')
   FROM public.financial_alerts a WHERE a.source='ServerTableEngine.authoritative_hand_semantic_refusal'
   AND a.context->>'table_id'=h.table_id::text AND a.context->>'hand_number'=h.hand_number::text))
   || CASE WHEN retired_dispatch IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retired_dispatch',retired_dispatch) END;
 END IF;
