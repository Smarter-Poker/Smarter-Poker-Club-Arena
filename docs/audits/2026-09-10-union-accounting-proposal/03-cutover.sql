-- Proposal only. Stage 3 requires the valid stage-2 index and live-body review.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.uq_agent_commissions_contributor') AND i.indisvalid AND i.indisready AND i.indisunique AND pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX uq_agent_commissions_contributor ON public.agent_commissions USING btree (user_id, source_id, source_type, contributing_user_id) NULLS NOT DISTINCT WHERE (source_id IS NOT NULL)') THEN
    RAISE EXCEPTION 'The contributor unique index is not ready';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)'::regprocedure) <> '1583ac138b7687091e7c5a049f0639e9' THEN
    RAISE EXCEPTION 'The live commission function changed; review before cutover';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)'::regprocedure) <> '7b9638f98b36f8f73e5ccb2b666830a0'
     OR pg_get_indexdef(to_regclass('public.uq_agent_commissions_source')) IS DISTINCT FROM
       'CREATE UNIQUE INDEX uq_agent_commissions_source ON public.agent_commissions USING btree (user_id, source_id, source_type) WHERE (source_id IS NOT NULL)'
     OR has_function_privilege('anon','public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)','execute')
     OR has_function_privilege('authenticated','public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)','execute')
     OR NOT has_function_privilege('service_role','public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)','execute')
     OR has_function_privilege('anon','public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)','execute')
     OR NOT has_function_privilege('authenticated','public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)','execute')
     OR NOT has_function_privilege('service_role','public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)','execute') THEN
    RAISE EXCEPTION 'Calculator, source index or execution grants changed; review before cutover';
  END IF;
END $preflight$;
DROP INDEX public.uq_agent_commissions_source;

CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(
  p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric,
  p_source_type text DEFAULT 'rake_settlement', p_source_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SET search_path TO public AS $function$
DECLARE
  v_receipt public.ca_commission_contributor_receipts%ROWTYPE;
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
  IF EXISTS(SELECT 1 FROM public.agent_commissions
       WHERE source_id=p_source_id AND source_type=p_source_type AND contributing_user_id IS NULL) THEN
    UPDATE public.ca_commission_contributor_receipts SET state='legacy_preserved'
     WHERE source_type=p_source_type AND source_id=p_source_id AND contributing_user_id=p_agent_user_id;
    RETURN;
  END IF;

  v_book_club := public.fn_resolve_player_club_for_agent(p_agent_user_id,p_club_id,NULL);
  IF v_book_club IS NULL THEN RAISE EXCEPTION 'Missing commission booking club'; END IF;
  SELECT agent_id INTO v_direct_user FROM public.club_members
   WHERE user_id=p_agent_user_id AND club_id=v_book_club;
  -- An agent's own play uses only their row in the booking club.
  SELECT id INTO v_current FROM public.agents
   WHERE user_id=coalesce(v_direct_user,p_agent_user_id) AND club_id=v_book_club AND status='active';

  WHILE v_current IS NOT NULL LOOP
    IF v_current=ANY(v_seen) OR cardinality(v_seen)>=64 THEN
      RAISE EXCEPTION 'Commission hierarchy cycle or excessive depth' USING ERRCODE='23514';
    END IF;
    v_seen := array_append(v_seen,v_current);
    SELECT id,user_id,club_id,commission_rate,parent_agent_id,role,status INTO v_agent
      FROM public.agents WHERE id=v_current;
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
    v_floor := greatest(v_floor,v_agent.commission_rate);
    v_entitlement := round(p_rake_credit*v_floor,2);
    v_slice := v_entitlement-v_paid;
    v_paid := v_entitlement;
    v_allocations := v_allocations || jsonb_build_object('agent_id',v_agent.id,'user_id',v_agent.user_id,
      'depth',v_depth,'role',v_agent.role,'parent_agent_id',v_agent.parent_agent_id,'contract_rate',v_agent.commission_rate,'amount',v_slice);
    v_previous_rate := v_agent.commission_rate;
    v_current := v_agent.parent_agent_id;
  END LOOP;

  IF v_paid<0 OR v_paid>p_rake_credit THEN RAISE EXCEPTION 'Commission allocation does not conserve'; END IF;
  -- Hold agent locks in recipient order before writes, avoiding opposite-order
  -- updates within one contribution. A deadlocked multi-source batch retries.
  PERFORM 1 FROM public.agents WHERE id=ANY(v_seen) ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_allocations) j
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
      last_active_at=now(),updated_at=now() WHERE id=(v_leg->>'agent_id')::uuid;
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

-- The unused alternate calculator accepted an independently chosen rake-record
-- or hand ID. Revoke it so one event cannot enter two identity domains.
REVOKE ALL ON FUNCTION public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
