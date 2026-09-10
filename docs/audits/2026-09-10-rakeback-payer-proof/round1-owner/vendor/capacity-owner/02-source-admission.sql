-- Owner-only source discovery. No money moves and no date alone admits funding.
CREATE FUNCTION public.fn_ca_admit_source_funding(p_hand_id uuid,p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE s public.ca_cash_commission_sources%ROWTYPE;b public.ca_cash_bank_receipts%ROWTYPE;
 f public.ca_cash_commission_facts%ROWTYPE;r public.ca_commission_contributor_receipts%ROWTYPE;
 v_pool uuid;v_week date;v_start timestamptz;v_end timestamptz;v_hierarchy numeric;
 v_state text;v_top numeric;v_lot_count integer:=0;v_recipient_count integer:=0;v_deferred integer:=0;v_retained integer:=0;
 a jsonb;h jsonb;v_previous numeric;v_exact numeric;
BEGIN
 IF p_hand_id IS NULL OR p_club_id IS NULL THEN RAISE EXCEPTION 'Source and booked club are required' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[p_club_id]);
 SELECT * INTO STRICT s FROM public.ca_cash_commission_sources WHERE hand_id=p_hand_id;
 SELECT * INTO STRICT b FROM public.ca_cash_bank_receipts WHERE hand_id=p_hand_id;
 PERFORM public.fn_ca_assert_cash_bank_receipt(p_hand_id);
 IF b.contract_version<>1 OR b.accepted_payload_hash<>s.accepted_payload_hash THEN
  RAISE EXCEPTION 'Unsupported source bank authority' USING ERRCODE='23514'; END IF;
 v_week:=date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date;
 v_start:=public.fn_union_week_start(b.bank_credit_at);
 v_end:=((v_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 FOR f IN SELECT * FROM public.ca_cash_commission_facts
  WHERE hand_id=p_hand_id AND booked_club_id=p_club_id ORDER BY player_id LOOP
  -- Bad/missing funding terms remain explicit in immutable source facts. They
  -- never receive an invented rate or a club-right lot.
  IF f.funding_state='union_self_retained' THEN v_retained:=v_retained+1;CONTINUE;END IF;
  IF f.funding_state IS NULL OR f.funding_state NOT IN ('union_member','club_treasury_owner')
   OR f.funding_club_rate IS NULL OR f.funding_club_rate<0 OR f.funding_club_rate>1
   OR f.funding_club_rate::text IN ('NaN','Infinity','-Infinity')
   OR f.funding_union_id IS DISTINCT FROM s.funding_union_id THEN
   v_deferred:=v_deferred+1;CONTINUE;
  END IF;
  INSERT INTO public.ca_source_funding_pools(club_id,funding_union_id,funding_route,contract_version)
  VALUES(p_club_id,s.funding_union_id,s.funding_route,1) ON CONFLICT DO NOTHING;
  SELECT id INTO STRICT v_pool FROM public.ca_source_funding_pools
  WHERE club_id=p_club_id AND funding_union_id IS NOT DISTINCT FROM s.funding_union_id
   AND funding_route=s.funding_route AND contract_version=1;
  v_hierarchy:=NULL;v_state:='terms_unresolved';
  IF jsonb_typeof(f.hierarchy)='array' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(f.hierarchy) j WHERE j->>'contract_rate' IS NULL
    OR j->>'contract_rate' IN ('NaN','Infinity','-Infinity')
    OR (j->>'contract_rate')::numeric<0 OR (j->>'contract_rate')::numeric>.70) THEN
   SELECT coalesce(max((j->>'contract_rate')::numeric),0) INTO v_top FROM jsonb_array_elements(f.hierarchy) j;
   v_hierarchy:=f.rake_credit*v_top;
   IF f.errors='[]'::jsonb THEN
    v_state:=CASE WHEN v_hierarchy>f.rake_credit*f.funding_club_rate THEN 'overpromised' ELSE 'eligible' END;
   END IF;
  END IF;
  INSERT INTO public.ca_source_funding_lots(hand_id,contributor_id,pool_id,accepted_payload_hash,
   earning_week,bank_period_start,bank_period_end,rake_credit,captured_club_rate,
   exact_club_entitlement,exact_hierarchy_entitlement,contract_state)
  VALUES(p_hand_id,f.player_id,v_pool,s.accepted_payload_hash,v_week,v_start,v_end,f.rake_credit,
   f.funding_club_rate,f.rake_credit*f.funding_club_rate,v_hierarchy,v_state)
  ON CONFLICT(hand_id,contributor_id) DO NOTHING;
  IF FOUND THEN v_lot_count:=v_lot_count+1; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.ca_source_funding_lots l
   WHERE l.hand_id=p_hand_id AND l.contributor_id=f.player_id AND l.pool_id=v_pool
    AND l.accepted_payload_hash=s.accepted_payload_hash AND l.earning_week=v_week
    AND l.bank_period_start=v_start AND l.bank_period_end=v_end
    AND l.rake_credit=f.rake_credit AND l.captured_club_rate=f.funding_club_rate
    AND l.exact_club_entitlement=f.rake_credit*f.funding_club_rate
    AND l.exact_hierarchy_entitlement IS NOT DISTINCT FROM v_hierarchy AND l.contract_state=v_state) THEN
   RAISE EXCEPTION 'Source funding lot conflicts with immutable capture' USING ERRCODE='23514'; END IF;
  IF v_state<>'eligible' THEN v_deferred:=v_deferred+1;CONTINUE; END IF;
  -- Applied contributor evidence proves commission admission, independently of
  -- the valid club right above. It can arrive later without changing the lot.
  SELECT * INTO r FROM public.ca_commission_contributor_receipts
  WHERE source_type='rake_settlement' AND source_id=p_hand_id AND contributing_user_id=f.player_id
   AND state='applied' AND requested_club_id=s.requested_club_id
   AND booked_club_id=p_club_id AND rake_credit=f.rake_credit;
  IF NOT FOUND THEN v_deferred:=v_deferred+1;CONTINUE; END IF;
  IF jsonb_array_length(r.allocations)<>jsonb_array_length(f.hierarchy) THEN
   RAISE EXCEPTION 'Applied commission hierarchy does not cover captured source' USING ERRCODE='23514'; END IF;
  v_previous:=0;
  FOR h IN SELECT value FROM jsonb_array_elements(f.hierarchy) ORDER BY (value->>'depth')::integer LOOP
   IF (h->>'depth')::integer>1 AND (h->>'contract_rate')::numeric-v_previous<.10 THEN
    RAISE EXCEPTION 'Captured upline margin is invalid' USING ERRCODE='23514'; END IF;
   SELECT value INTO STRICT a FROM jsonb_array_elements(r.allocations)
    WHERE value->>'agent_id'=h->>'agent_id';
   v_exact:=f.rake_credit*((h->>'contract_rate')::numeric-v_previous);
   IF a->>'amount_authority' IS DISTINCT FROM 'compatibility_projection_only'
    OR a->>'user_id' IS DISTINCT FROM h->>'user_id'
    OR (a->>'contract_rate')::numeric IS DISTINCT FROM (h->>'contract_rate')::numeric
    OR (a->>'downline_contract_rate')::numeric IS DISTINCT FROM v_previous
    OR (a->>'exact_entitlement')::numeric IS DISTINCT FROM v_exact
    OR (a->>'exact_cumulative_entitlement')::numeric IS DISTINCT FROM f.rake_credit*(h->>'contract_rate')::numeric THEN
    RAISE EXCEPTION 'Applied allocation contradicts exact captured hierarchy' USING ERRCODE='23514'; END IF;
   INSERT INTO public.ca_source_recipient_accruals(hand_id,contributor_id,agent_id,pool_id,recipient_id,
    earning_week,contract_rate,downline_rate,exact_entitlement,is_direct_payer)
   VALUES(p_hand_id,f.player_id,(h->>'agent_id')::uuid,v_pool,(h->>'user_id')::uuid,v_week,
    (h->>'contract_rate')::numeric,v_previous,v_exact,(h->>'agent_id')::uuid=f.direct_agent_id)
   ON CONFLICT(hand_id,contributor_id,agent_id) DO NOTHING;
   IF FOUND THEN v_recipient_count:=v_recipient_count+1; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.ca_source_recipient_accruals x WHERE x.hand_id=p_hand_id
    AND x.contributor_id=f.player_id AND x.agent_id=(h->>'agent_id')::uuid AND x.pool_id=v_pool
    AND x.recipient_id=(h->>'user_id')::uuid AND x.earning_week=v_week
    AND x.contract_rate=(h->>'contract_rate')::numeric AND x.downline_rate=v_previous
    AND x.exact_entitlement=v_exact AND x.is_direct_payer=((h->>'agent_id')::uuid=f.direct_agent_id)) THEN
    RAISE EXCEPTION 'Recipient accrual conflicts with immutable source' USING ERRCODE='23514'; END IF;
   v_previous:=(h->>'contract_rate')::numeric;
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('lots_added',v_lot_count,'recipient_accruals_added',v_recipient_count,
  'deferred_contributors',v_deferred,'retained_contributors',v_retained,'source_final',false);
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_admit_source_funding(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
