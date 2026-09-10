-- Review proposal. Full cascade native rehearsal and source-finality authority remain required.
BEGIN;
DO $gate$
DECLARE
 v_oid oid:='public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure;
 v_definition text;
 v_lock_marker text:='  -- ROUND 1 - union rake treasury pays the clubs their 90%.';
 v_final_marker text:='  -- The period is an accounting object, not a by-product of invoicing.';
 v_partial_marker text:='  -- A round can post funded recipients while reporting others still unpaid.';
 v_fail2 text:=$returnblock$    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round2_contract_violated_or_failed: ' || COALESCE(v_r2->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'note', 'Rounds 3 and 4 were not run.');$returnblock$;
 v_fail3 text:=$returnblock$    RETURN jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round3_contract_violated_or_failed: ' || COALESCE(v_r3->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3,
      'note', 'Round 4 was not run; no statement is issued for a settlement '
              || 'that did not complete.');$returnblock$;
 v_assertion text:='  PERFORM public.fn_union_settlement_conservation_assert(
            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);';
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)<>'94de0d3c6af7fb39459b286089f4cf7d' THEN
  RAISE EXCEPTION 'Union cascade changed since source payer review';
 END IF;
 SELECT pg_get_functiondef(v_oid) INTO v_definition;
 IF strpos(v_definition,v_lock_marker)=0 OR strpos(v_definition,v_final_marker)=0
 OR strpos(v_definition,v_fail2)=0 OR strpos(v_definition,v_fail3)=0
 OR strpos(v_definition,v_partial_marker)=0 OR strpos(v_definition,v_assertion)=0 THEN
  RAISE EXCEPTION 'Union cascade insertion boundary not found';
 END IF;
 v_definition:=replace(v_definition,v_fail2, '    RAISE EXCEPTION ''round2_contract_violated_or_failed'' USING ERRCODE=''23514'';');
 v_definition:=replace(v_definition,v_fail3, '    RAISE EXCEPTION ''round3_contract_violated_or_failed'' USING ERRCODE=''23514'';');
 -- Keep existing cache warmup before scope admission; serialize before money.
 v_definition:=replace(v_definition,v_lock_marker,
  '  PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY(
    SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id ORDER BY club_id));

'||v_lock_marker);
 -- Assert executed movement on the partial-shortfall path as well.
 v_definition:=replace(v_definition,v_assertion,'');
 v_definition:=replace(v_definition,v_partial_marker,v_assertion||'

'||v_partial_marker);
 -- A source-provisional return runs only after the movement assertion above.
 v_definition:=replace(v_definition,v_final_marker,
  '  IF (v_r3->>''source_final'')::boolean IS DISTINCT FROM true THEN
    RETURN jsonb_build_object(''success'',false,''union_id'',p_union_id,
      ''error'',''source_finality_pending'',''period_start'',v_from,''period_end'',v_to,
      ''round1_union_to_clubs'',v_r1,''round2_club_to_agents'',v_r2,
      ''round3_agents_to_players'',v_r3);
  END IF;

'||v_final_marker);
 EXECUTE v_definition;
END $gate$;
COMMIT;
