-- Dormant candidate. Read-only known-source completeness, never period finality.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='10s';
CREATE SCHEMA ca_accounting_readiness_private;
REVOKE ALL ON SCHEMA ca_accounting_readiness_private FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION ca_accounting_readiness_private.inspect_known_sources(
 p_union uuid,p_bank_from timestamptz,p_bank_to timestamptz,p_earning_to date,
 p_manifest jsonb,p_manifest_sha256 text,p_clubs uuid[])
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $f$
DECLARE m jsonb;s public.ca_cash_commission_sources%ROWTYPE;f public.ca_cash_commission_facts%ROWTYPE;
 b public.ca_cash_bank_receipts%ROWTYPE;l public.ca_source_funding_lots%ROWTYPE;
 a public.ca_source_recipient_accruals%ROWTYPE;cr public.ca_commission_contributor_receipts%ROWTYPE;h jsonb;r record;v_facts jsonb;v_gaps jsonb:='[]';
 v_hand uuid;v_agent uuid;v_week date;v_pool uuid;v_pools uuid[]:='{}';v_previous numeric;v_exact numeric;
 v_expected_club numeric:=0;v_expected_agent numeric:=0;v_expected_player numeric:=0;
 v_allocated_club numeric:=0;v_allocated_agent numeric:=0;v_allocated_player numeric:=0;v_alloc numeric;
 v_seen uuid[]:='{}';v_in_window integer:=0;v_outside integer:=0;v_retained integer:=0;v_future integer:=0;
 v_lot_exists boolean;v_accrual_exists boolean;v_eligible boolean;v_contributor_exists boolean;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Known-source inspection requires Read Committed' USING ERRCODE='25001';
 END IF;
 IF p_union IS NULL OR p_bank_from IS NULL OR p_bank_to IS NULL OR NOT isfinite(p_bank_from) OR NOT isfinite(p_bank_to)
  OR p_bank_from>=p_bank_to OR p_bank_from<>public.fn_union_week_start(p_bank_from)
  OR p_bank_to<>public.fn_union_week_start(p_bank_to) OR p_bank_to>public.fn_union_week_start(clock_timestamp())
  OR p_earning_to IS NULL OR NOT isfinite(p_earning_to) OR extract(isodow FROM p_earning_to)<>1
  OR p_earning_to>date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date THEN
  RAISE EXCEPTION 'Existing closed bank and earning boundaries are required' USING ERRCODE='22023';
 END IF;
 IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'array' OR p_manifest_sha256 IS NULL
  OR encode(extensions.digest(convert_to(p_manifest::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p_manifest_sha256 THEN
  RAISE EXCEPTION 'Known-source manifest hash or shape mismatch' USING ERRCODE='22023';
 END IF;
 PERFORM public.fn_ca_assert_union_captured_locks(p_union,p_clubs);
 FOR m IN SELECT value FROM jsonb_array_elements(p_manifest) LOOP
  v_hand:=(m->'source'->>'hand_id')::uuid;
  IF v_hand IS NULL OR v_hand=ANY(v_seen) THEN RAISE EXCEPTION 'Known-source manifest identity missing or duplicated' USING ERRCODE='22023'; END IF;
  v_seen:=array_append(v_seen,v_hand);
  SELECT * INTO s FROM public.ca_cash_commission_sources WHERE hand_id=v_hand;
  IF NOT FOUND OR s.funding_union_id IS DISTINCT FROM p_union OR s.funding_route<>'union_rake_wallet'
   OR to_jsonb(s) IS DISTINCT FROM m->'source' THEN
   RAISE EXCEPTION 'Known-source manifest original source or Union scope mismatch' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.player_id),'[]') INTO v_facts
   FROM public.ca_cash_commission_facts x WHERE x.hand_id=v_hand;
  IF v_facts IS DISTINCT FROM m->'facts' OR jsonb_array_length(v_facts)<>s.contributor_count
   OR s.rake_total IS DISTINCT FROM (SELECT coalesce(sum(x.rake_credit),0) FROM public.ca_cash_commission_facts x WHERE x.hand_id=v_hand)
   OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE x.hand_id=v_hand AND x.commission_capture_version=1
     AND x.post_commit_payload_hash=s.accepted_payload_hash AND x.committed_at=s.accepted_at) THEN
   RAISE EXCEPTION 'Known-source manifest captured facts or accepted authority mismatch' USING ERRCODE='23514';
  END IF;
  IF s.rake_total=0 THEN CONTINUE;END IF;
  SELECT * INTO b FROM public.ca_cash_bank_receipts WHERE hand_id=v_hand;
  IF NOT FOUND THEN
   v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','missing_bank_receipt','hand_id',v_hand));CONTINUE;
  END IF;
  PERFORM public.fn_ca_assert_cash_bank_receipt(v_hand);
  -- A half-open bank period is not the inclusive private prefix-seal cutoff.
  IF b.bank_credit_at<p_bank_from OR b.bank_credit_at>=p_bank_to THEN v_outside:=v_outside+1;CONTINUE;END IF;
  v_in_window:=v_in_window+1;v_week:=date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date;
  FOR f IN SELECT * FROM public.ca_cash_commission_facts WHERE hand_id=v_hand ORDER BY player_id LOOP
   IF f.funding_state='union_self_retained' THEN v_retained:=v_retained+1;CONTINUE;END IF;
   IF f.funding_state<>'union_member' OR f.funding_club_rate IS NULL OR f.funding_union_id IS DISTINCT FROM s.funding_union_id
    OR f.booked_club_id IS NULL OR f.funding_club_rate<0 OR f.funding_club_rate>1
    OR f.funding_club_rate::text IN ('NaN','Infinity','-Infinity') THEN
    v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','unresolved_original_funding_terms','hand_id',v_hand,'player_id',f.player_id));CONTINUE;
   END IF;
   v_expected_club:=v_expected_club+f.rake_credit*f.funding_club_rate;
   SELECT coalesce(sum(z.amount),0) INTO v_alloc FROM public.ca_source_club_release_slices z WHERE z.hand_id=v_hand AND z.contributor_id=f.player_id;
   v_allocated_club:=v_allocated_club+v_alloc;
   IF v_alloc>f.rake_credit*f.funding_club_rate THEN RAISE EXCEPTION 'Known-source club attribution exceeds exact captured right' USING ERRCODE='23514';END IF;
   SELECT * INTO l FROM public.ca_source_funding_lots WHERE hand_id=v_hand AND contributor_id=f.player_id;
   v_lot_exists:=FOUND;v_pool:=NULL;
   IF NOT v_lot_exists THEN
    v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','missing_funding_lot','hand_id',v_hand,'player_id',f.player_id));
   ELSE
    PERFORM public.fn_ca_assert_source_lot(v_hand,f.player_id);v_pool:=l.pool_id;
    IF NOT v_pool=ANY(v_pools) THEN v_pools:=array_append(v_pools,v_pool);END IF;
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.ca_source_club_funding_admissions x WHERE x.hand_id=v_hand AND x.contributor_id=f.player_id
     AND x.pool_id=v_pool AND l.bank_period_end<=x.bank_closed_through
     AND x.bank_closed_through=public.fn_union_week_start(x.bank_closed_through)
     AND x.bank_closed_through<=public.fn_union_week_start(x.admitted_at)) THEN
    v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','missing_club_funding_admission','hand_id',v_hand,'player_id',f.player_id));
   END IF;
   v_eligible:=f.errors='[]'::jsonb AND jsonb_typeof(f.hierarchy)='array'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.hierarchy) x WHERE x->>'contract_rate' IS NULL
      OR x->>'contract_rate' IN ('NaN','Infinity','-Infinity') OR (x->>'contract_rate')::numeric<0 OR (x->>'contract_rate')::numeric>.70)
    AND f.rake_credit*coalesce((SELECT max((x->>'contract_rate')::numeric) FROM jsonb_array_elements(f.hierarchy) x),0)<=f.rake_credit*f.funding_club_rate;
   IF NOT v_eligible THEN
    v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','unresolved_or_overpromised_original_rights','hand_id',v_hand,'player_id',f.player_id));CONTINUE;
   END IF;
   SELECT * INTO cr FROM public.ca_commission_contributor_receipts x WHERE x.source_type='rake_settlement'
     AND x.source_id=v_hand AND x.contributing_user_id=f.player_id AND x.state='applied'
     AND x.requested_club_id=s.requested_club_id AND x.booked_club_id=f.booked_club_id AND x.rake_credit=f.rake_credit;
   v_contributor_exists:=FOUND;
   IF NOT v_contributor_exists THEN
    v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','missing_contributor_receipt','hand_id',v_hand,'player_id',f.player_id));
   ELSIF jsonb_typeof(cr.allocations) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Applied contributor allocations have invalid shape' USING ERRCODE='23514';
   ELSIF jsonb_array_length(cr.allocations)<>jsonb_array_length(f.hierarchy) THEN
    RAISE EXCEPTION 'Applied contributor allocations do not exactly cover captured hierarchy' USING ERRCODE='23514';
   END IF;
   v_previous:=0;
   FOR h IN SELECT value FROM jsonb_array_elements(f.hierarchy) ORDER BY (value->>'depth')::integer LOOP
    v_agent:=(h->>'agent_id')::uuid;v_exact:=f.rake_credit*((h->>'contract_rate')::numeric-v_previous);
    IF v_exact<0 OR ((h->>'depth')::integer>1 AND (h->>'contract_rate')::numeric-v_previous<.10) THEN
     RAISE EXCEPTION 'Captured hierarchy margin contradicts original valid facts' USING ERRCODE='23514';END IF;
    v_previous:=(h->>'contract_rate')::numeric;
    SELECT * INTO a FROM public.ca_source_recipient_accruals x WHERE x.hand_id=v_hand AND x.contributor_id=f.player_id AND x.agent_id=v_agent;
    v_accrual_exists:=FOUND;
    IF NOT v_accrual_exists THEN
     v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','missing_recipient_accrual','hand_id',v_hand,'player_id',f.player_id,'agent_id',v_agent));
    ELSE PERFORM public.fn_ca_assert_source_accrual(v_hand,f.player_id,v_agent);END IF;
    IF v_week+7>p_earning_to THEN CONTINUE;END IF;
    v_expected_agent:=v_expected_agent+v_exact;
    SELECT coalesce(sum(z.amount),0) INTO v_alloc FROM public.ca_source_agent_payment_slices z
     WHERE z.hand_id=v_hand AND z.contributor_id=f.player_id AND z.agent_id=v_agent;
    v_allocated_agent:=v_allocated_agent+v_alloc;
    IF v_alloc>v_exact THEN RAISE EXCEPTION 'Known-source agent attribution exceeds exact captured right' USING ERRCODE='23514';END IF;
    IF NOT EXISTS(SELECT 1 FROM public.ca_source_recipient_funding_admissions x WHERE x.hand_id=v_hand
      AND x.contributor_id=f.player_id AND x.agent_id=v_agent AND x.pool_id=v_pool
      AND x.recipient_id=(h->>'user_id')::uuid AND v_week+7<=x.earning_closed_through
      AND x.earning_closed_through<=date_trunc('week',x.admitted_at AT TIME ZONE 'UTC')::date) THEN
     v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','missing_agent_funding_admission','hand_id',v_hand,'player_id',f.player_id,'agent_id',v_agent));
    END IF;
   END LOOP;
   IF v_week+7>p_earning_to THEN v_future:=v_future+1;CONTINUE;END IF;
   IF f.assignment_state='assigned' AND f.player_rebate_entitlement IS NOT NULL THEN
    v_expected_player:=v_expected_player+f.player_rebate_entitlement;
    SELECT coalesce(sum(z.amount),0) INTO v_alloc FROM public.ca_source_player_payment_slices z WHERE z.hand_id=v_hand AND z.player_id=f.player_id;
    v_allocated_player:=v_allocated_player+v_alloc;
    IF v_alloc>f.player_rebate_entitlement THEN RAISE EXCEPTION 'Known-source player attribution exceeds exact captured right' USING ERRCODE='23514';END IF;
    IF NOT EXISTS(SELECT 1 FROM public.ca_source_player_funding_admissions x WHERE x.hand_id=v_hand AND x.player_id=f.player_id
      AND x.agent_id=f.direct_agent_id AND x.pool_id=v_pool AND x.payer_user_id=f.payer_user_id) THEN
     v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','missing_player_funding_admission','hand_id',v_hand,'player_id',f.player_id));
    ELSE PERFORM public.fn_ca_assert_source_player_admission(v_hand,f.player_id);END IF;
   END IF;
  END LOOP;
 END LOOP;
 -- Reverse coverage catches a supplied manifest that quietly omitted a banked
 -- captured source. It is observed coverage, not a sealed global source stream.
 FOR r IN SELECT hand_id FROM public.ca_cash_bank_receipts WHERE funding_union_id=p_union
  AND funding_route='union_rake_wallet' AND bank_credit_at>=p_bank_from AND bank_credit_at<p_bank_to
  AND NOT hand_id=ANY(v_seen) ORDER BY hand_id LOOP
  v_gaps:=v_gaps||jsonb_build_array(jsonb_build_object('kind','bank_source_omitted_from_manifest','hand_id',r.hand_id));
 END LOOP;
 FOR r IN SELECT id FROM public.ca_source_club_cash_releases WHERE pool_id=ANY(v_pools) LOOP
  PERFORM public.fn_ca_assert_source_club_release(r.id);END LOOP;
 FOR r IN SELECT id FROM public.ca_source_agent_cash_payments WHERE pool_id=ANY(v_pools) LOOP
  PERFORM public.fn_ca_assert_source_agent_payment(r.id);END LOOP;
 FOR r IN SELECT id FROM public.ca_source_player_cash_payments WHERE pool_id=ANY(v_pools) LOOP
  PERFORM public.fn_ca_assert_source_player_payment(r.id);END LOOP;
 PERFORM public.fn_ca_assert_union_captured_locks(p_union,p_clubs);
 RETURN jsonb_build_object('scope','known_captured_sources_only','manifest_sha256',p_manifest_sha256,
  'union_id',p_union,'bank_from',p_bank_from,'bank_to_exclusive',p_bank_to,'earning_closed_through',p_earning_to,
  'sources_in_bank_window',v_in_window,'sources_outside_bank_window',v_outside,'retained_union_contributors',v_retained,
  'future_earning_contributors',v_future,'gaps',v_gaps,'known_rows_complete',jsonb_array_length(v_gaps)=0,
  'known_attribution',jsonb_build_object(
   'club',jsonb_build_object('exact',v_expected_club,'allocated',v_allocated_club,'remaining_exact',v_expected_club-v_allocated_club),
   'agent',jsonb_build_object('exact',v_expected_agent,'allocated',v_allocated_agent,'remaining_exact',v_expected_agent-v_allocated_agent),
   'player',jsonb_build_object('exact',v_expected_player,'allocated',v_allocated_player,'remaining_exact',v_expected_player-v_allocated_player)),
  'amounts_are_attribution_not_new_spendable_cash',true,'common_finality',false,'period_closed',false,
  'finality_reason','complete_producer_legacy_bank_and_period_authority_still_required');
END $f$;
REVOKE ALL ON FUNCTION ca_accounting_readiness_private.inspect_known_sources(uuid,timestamptz,timestamptz,date,jsonb,text,uuid[])
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
