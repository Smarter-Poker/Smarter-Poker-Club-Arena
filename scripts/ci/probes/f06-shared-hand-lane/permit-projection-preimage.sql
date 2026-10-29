CREATE OR REPLACE FUNCTION public.fn_f06_hand_number_state(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE life bigint; used bigint; pending jsonb; blocked text;
BEGIN
 /* A TABLE'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (2026-10-03): the
    tournament lane T(id) shared, then this table and its seats FOR
    UPDATE. See fn_ca_f06_share_table_lane. */
 PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id,p_lease_generation,p_table_id);
 SELECT tb.f06_lifecycle,CASE WHEN upper(t.status)<>'RUNNING' THEN 'tournament_not_running'
 WHEN lower(tb.status)='closed' OR COALESCE(tb.is_deleted,false) THEN 'table_closed' END INTO life,blocked
 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','table_not_found'); END IF;
 SELECT GREATEST(0,
 COALESCE((SELECT max(hand_number) FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id),0),
 COALESCE((SELECT max(hand_number) FROM public.hand_atomic_commits WHERE table_id=p_table_id),0),
 COALESCE((SELECT max(hand_number) FROM public.hand_history WHERE table_id=p_table_id),0)) INTO used;
 SELECT jsonb_build_object('permit_id',h.permit_id,'tournament_id',h.tournament_id,'table_id',h.table_id,
 'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text,'custody_id',h.custody_id,'generation',h.generation,'state',h.state)
 INTO pending FROM smarter_private.f06_hand_permits h WHERE h.table_id=p_table_id AND h.state='reserved';
 IF pending IS NOT NULL THEN blocked:='hand_permit_unresolved';
 ELSIF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN blocked:='source_excluded';
 ELSIF used=9223372036854775807 THEN blocked:='hand_number_exhausted'; END IF;
 RETURN jsonb_build_object('ok',true,'table_id',p_table_id,'lifecycle',life::text,
 'used_hand_number_max',used::text,'next_hand_number_candidate',CASE WHEN blocked IS NULL THEN (used+1)::text ELSE NULL END,
 'can_reserve',blocked IS NULL,'blocked_reason',blocked,'unresolved_permit',pending);
END $function$

