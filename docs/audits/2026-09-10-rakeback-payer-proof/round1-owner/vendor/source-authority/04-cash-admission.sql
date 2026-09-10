-- PROPOSAL ONLY. Depends on stages 1-3 and source schema/capture.
-- Cash authority is prospective; tournament source authority remains a separate gate.
CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(
  p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric,
  p_source_type text DEFAULT 'rake_settlement', p_source_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $function$
DECLARE
  v_receipt public.ca_commission_contributor_receipts%ROWTYPE;
  v_fact record;
  v_legacy boolean:=false;
  v_inserted integer;
  v_book_club uuid;
  v_direct_user uuid;
  v_current uuid;
  v_parent uuid;
  v_agent record;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_allocations jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_floor numeric := 0;
  v_previous_rate numeric;
  v_entitlement numeric;
  v_paid numeric := 0;
  v_slice numeric;
  v_depth integer := 0;
  v_leg jsonb;
BEGIN
  IF p_agent_user_id IS NULL OR p_club_id IS NULL OR p_source_id IS NULL
     OR p_source_type NOT IN ('rake_settlement','tournament_rake_settlement')
     OR p_source_type IS NULL OR p_rake_credit IS NULL
     OR p_rake_credit < 0 OR p_rake_credit::text IN ('NaN','Infinity','-Infinity')
     OR p_rake_credit <> round(p_rake_credit,2) THEN
    RAISE EXCEPTION 'Invalid commission source, amount or identity' USING ERRCODE='22023';
  END IF;

  -- A cash RPC may only describe immutable accepted facts already banked.
  IF p_source_type='rake_settlement' THEN
    SELECT f.*,s.requested_club_id,s.table_id,s.rake_total,s.rake_method,s.contributions,s.returned_uncalled INTO v_fact
      FROM public.ca_cash_commission_facts f JOIN public.ca_cash_commission_sources s USING(hand_id)
     WHERE f.hand_id=p_source_id AND f.player_id=p_agent_user_id;
    IF FOUND THEN
      IF v_fact.requested_club_id IS DISTINCT FROM p_club_id
         OR v_fact.rake_credit IS DISTINCT FROM p_rake_credit THEN
        RAISE EXCEPTION 'Cash commission input contradicts accepted source facts' USING ERRCODE='22023';
      END IF;
      IF NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.hand_id=p_source_id
        AND r.table_id=v_fact.table_id AND r.club_id=v_fact.requested_club_id
        AND r.rake_amount=v_fact.rake_total AND r.is_tournament IS NOT TRUE
        AND r.tournament_id IS NULL AND r.source='atomic_distribute_rake'
        AND r.rake_method=v_fact.rake_method AND r.player_contributions=v_fact.contributions
        AND coalesce(r.returned_uncalled,'{}'::jsonb)=v_fact.returned_uncalled) THEN
        RAISE EXCEPTION 'Accepted cash commission source has not banked matching rake' USING ERRCODE='55000';
      END IF;
      IF jsonb_array_length(v_fact.errors)>0 OR v_fact.booked_club_id IS NULL THEN
        RAISE EXCEPTION 'Accepted cash commission source requires accounting review: %',v_fact.errors USING ERRCODE='55000';
      END IF;
    ELSE
      -- Absence is never interpreted as a new no-agent attempt. A known old
      -- hand is outside the prospective contract, even when it left zero rows.
      IF NOT EXISTS(SELECT 1 FROM public.rake_records r
          CROSS JOIN LATERAL public.fn_allocate_rake_credits(r.rake_amount,r.player_contributions,r.rake_method) a
        WHERE r.hand_id=p_source_id AND r.club_id=p_club_id
          AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
          AND a.user_id=p_agent_user_id AND a.credit=p_rake_credit)
        OR EXISTS(SELECT 1 FROM public.ca_cash_commission_sources WHERE hand_id=p_source_id) THEN
        RAISE EXCEPTION 'Unknown cash commission source or contributor' USING ERRCODE='22023';
      END IF;
      -- Old sources receive no new receipt or allocation and cannot be
      -- adopted later after an assignment changes. They remain out of scope.
      RETURN;
    END IF;
  END IF;

  -- The insert serializes the same contributor's concurrent/lost-response retry.
  INSERT INTO public.ca_commission_contributor_receipts
    (source_type,source_id,contributing_user_id,requested_club_id,rake_credit,state)
  VALUES(p_source_type,p_source_id,p_agent_user_id,p_club_id,p_rake_credit,'pending')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  SELECT * INTO v_receipt FROM public.ca_commission_contributor_receipts
   WHERE source_type=p_source_type AND source_id=p_source_id AND contributing_user_id=p_agent_user_id
   FOR UPDATE;
  IF v_receipt.requested_club_id IS DISTINCT FROM p_club_id
     OR v_receipt.rake_credit IS DISTINCT FROM p_rake_credit THEN
    RAISE EXCEPTION 'Commission source payload conflict' USING ERRCODE='22023';
  END IF;
  IF v_inserted=0 THEN
    IF v_receipt.state NOT IN ('applied','legacy_preserved') THEN
      RAISE EXCEPTION 'Incomplete commission source receipt' USING ERRCODE='55000';
    END IF;
    RETURN;
  END IF;

  -- Old rows do not say which contributors they contain. Never guess or backpay.
  IF v_legacy OR EXISTS(SELECT 1 FROM public.agent_commissions
       WHERE source_id=p_source_id AND source_type=p_source_type AND contributing_user_id IS NULL) THEN
    UPDATE public.ca_commission_contributor_receipts SET state='legacy_preserved'
     WHERE source_type=p_source_type AND source_id=p_source_id AND contributing_user_id=p_agent_user_id;
    RETURN;
  END IF;

  IF p_source_type='rake_settlement' THEN
    v_book_club:=v_fact.booked_club_id;
    v_current:=v_fact.direct_agent_id;
  ELSE
  v_book_club := public.fn_resolve_player_club_for_agent(p_agent_user_id,p_club_id,NULL);
  IF v_book_club IS NULL THEN RAISE EXCEPTION 'Missing commission booking club'; END IF;
  SELECT agent_id INTO v_direct_user FROM public.club_members
   WHERE user_id=p_agent_user_id AND club_id=v_book_club;
  -- An agent's own play uses only their row in the booking club.
  SELECT id INTO v_current FROM public.agents
   WHERE user_id=coalesce(v_direct_user,p_agent_user_id) AND club_id=v_book_club AND status='active';

  END IF;

  WHILE v_current IS NOT NULL LOOP
    IF v_current=ANY(v_seen) OR cardinality(v_seen)>=64 THEN
      RAISE EXCEPTION 'Commission hierarchy cycle or excessive depth' USING ERRCODE='23514';
    END IF;
    v_seen := array_append(v_seen,v_current);
    IF p_source_type='rake_settlement' THEN
      SELECT (j->>'agent_id')::uuid AS id,(j->>'user_id')::uuid AS user_id,
        (j->>'club_id')::uuid AS club_id,(j->>'contract_rate')::numeric AS commission_rate,
        (j->>'parent_agent_id')::uuid AS parent_agent_id,j->>'role' AS role,j->>'status' AS status
        INTO v_agent FROM jsonb_array_elements(v_fact.hierarchy) j
        WHERE (j->>'agent_id')::uuid=v_current;
    ELSE
    SELECT id,user_id,club_id,commission_rate,parent_agent_id,role,status INTO v_agent
      FROM public.agents WHERE id=v_current;
    END IF;
    IF NOT FOUND OR v_agent.club_id<>v_book_club OR v_agent.status<>'active' THEN
      RAISE EXCEPTION 'Commission hierarchy leaves its active booking club' USING ERRCODE='23514';
    END IF;
    IF v_agent.commission_rate IS NULL OR v_agent.commission_rate<0 OR v_agent.commission_rate>0.70 THEN
      RAISE EXCEPTION 'Invalid configured commission rate' USING ERRCODE='23514';
    END IF;
    v_depth := v_depth+1;
    IF v_previous_rate IS NOT NULL AND v_agent.commission_rate-v_previous_rate<0.10 THEN
      v_warnings := v_warnings || jsonb_build_object('agent_id',v_agent.id,'rate',v_agent.commission_rate,
        'downline_rate',v_previous_rate,'minimum_gap',0.10);
    END IF;
    -- Contract percentages share one gross rake basis. Difference cumulative
    -- rounded entitlements, so all tiers together conserve cents exactly.
    IF v_agent.commission_rate<v_floor THEN
      RAISE EXCEPTION 'Commission parent rate falls below its captured child' USING ERRCODE='23514';
    END IF;
    v_floor := v_agent.commission_rate;
    v_entitlement := round(p_rake_credit*v_floor,2);
    v_slice := v_entitlement-v_paid;
    v_paid := v_entitlement;
    v_allocations := v_allocations || (jsonb_build_object('agent_id',v_agent.id,'user_id',v_agent.user_id,
      'depth',v_depth,'role',v_agent.role,'parent_agent_id',v_agent.parent_agent_id,'contract_rate',v_agent.commission_rate,'amount',v_slice)
      || CASE WHEN p_source_type='rake_settlement' THEN jsonb_build_object(
        'exact_cumulative_entitlement',p_rake_credit*v_agent.commission_rate,
        'exact_entitlement',p_rake_credit*(v_agent.commission_rate-coalesce(v_previous_rate,0)),
        'downline_contract_rate',coalesce(v_previous_rate,0),
        'amount_authority','compatibility_projection_only') ELSE '{}'::jsonb END);
    v_previous_rate := v_agent.commission_rate;
    v_current := v_agent.parent_agent_id;
  END LOOP;

  IF v_paid<0 OR v_paid>p_rake_credit THEN RAISE EXCEPTION 'Commission allocation does not conserve'; END IF;
  -- Hold agent locks in recipient order before writes, avoiding opposite-order
  -- updates within one contribution. A deadlocked multi-source batch retries.
  PERFORM 1 FROM public.agents WHERE id=ANY(v_seen) ORDER BY id FOR UPDATE;
  IF p_source_type<>'rake_settlement' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_allocations) j
      LEFT JOIN public.agents a ON a.id=(j->>'agent_id')::uuid
      WHERE a.id IS NULL OR a.user_id IS DISTINCT FROM (j->>'user_id')::uuid
        OR a.club_id IS DISTINCT FROM v_book_club OR a.status IS DISTINCT FROM 'active'
        OR a.commission_rate IS DISTINCT FROM (j->>'contract_rate')::numeric
        OR a.parent_agent_id IS DISTINCT FROM (j->>'parent_agent_id')::uuid) THEN
    RAISE EXCEPTION 'Commission hierarchy changed during allocation; retry' USING ERRCODE='40001';
  END IF;
  FOR v_leg IN SELECT value FROM jsonb_array_elements(v_allocations) ORDER BY value->>'agent_id' LOOP
    IF (v_leg->>'amount')::numeric>0 THEN
      INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,notes,contributing_user_id)
      VALUES(v_book_club,(v_leg->>'user_id')::uuid,(v_leg->>'amount')::numeric,
        (v_leg->>'contract_rate')::numeric,p_source_type,p_source_id,
        coalesce(p_notes,'Commission accrual') || ' [differential tier ' || (v_leg->>'depth') || ']',p_agent_user_id);
    END IF;
    -- Gross attributed volume is a statistic, never a wallet credit.
    UPDATE public.agents SET weekly_rake_generated=coalesce(weekly_rake_generated,0)+p_rake_credit,
      lifetime_rake_generated=coalesce(lifetime_rake_generated,0)+p_rake_credit,
      last_active_at=now(),updated_at=now() WHERE id=(v_leg->>'agent_id')::uuid
        AND user_id=(v_leg->>'user_id')::uuid AND club_id=v_book_club;
  END LOOP;

  FOR v_leg IN SELECT value FROM jsonb_array_elements(v_warnings) LOOP
    PERFORM public.fn_raise_server_financial_alert('warning','commission_hierarchy_margin',
      'Assigned hierarchy rates do not retain the required ten percentage point margin',
      v_leg || jsonb_build_object('club_id',v_book_club),
      'commission-margin:' || (v_leg->>'agent_id') || ':' || (v_leg->>'rate') || ':' || (v_leg->>'downline_rate'));
  END LOOP;
  UPDATE public.ca_commission_contributor_receipts
    SET booked_club_id=v_book_club,state='applied',allocations=v_allocations,warnings=v_warnings
   WHERE source_type=p_source_type AND source_id=p_source_id AND contributing_user_id=p_agent_user_id;
END $function$;
REVOKE ALL ON FUNCTION public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text) TO service_role;


REVOKE ALL ON public.ca_commission_contributor_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_commission_contributor_receipts TO service_role;
