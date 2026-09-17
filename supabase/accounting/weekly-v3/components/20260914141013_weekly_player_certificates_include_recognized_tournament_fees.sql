-- The durable weekly request wrapper stays intact. Its one private calculator
-- now certifies typed cash plus terminally recognized tournament fee sources.
-- Recognition chooses the week; charge-time immutable history chooses the rate
-- and payer. Open fee captures create no premature rebate; deferred/missing
-- terminal source proof blocks the real settlement week. No rate/formula change.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure))<>'9d22946c66028dbb44cdd01ab5fb25a9'
 OR md5(pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure))<>'dbeadf42b4143e11c6e7b76343fecf0a'
 THEN RAISE EXCEPTION 'weekly certificate calculator changed before mixed-source upgrade';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_calculate_cash_rakeback_periods' AND status='approved')
 THEN RAISE EXCEPTION 'weekly certificate writer registration missing';END IF;
END $guard$;

CREATE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE event record;scope_union uuid;actual_union uuid;related boolean;unknown_scope boolean;
 proof jsonb;active_ids uuid[];refunded_ids uuid[];checked int:=0;issue_count bigint;reason text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501';END IF;
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to
 THEN RAISE EXCEPTION 'invalid_accounting_tournament_week' USING ERRCODE='22023';END IF;
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023';END IF;
 FOR event IN
  WITH candidates AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  )
  SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
   b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
   FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
    LEFT JOIN public.tournament_rake_settlements b USING(tournament_id) ORDER BY c.tournament_id
 LOOP
  IF COALESCE(event.bank_at,event.recognized_at) IS NOT NULL
   AND NOT(COALESCE(event.bank_at,event.recognized_at)>=p_from AND COALESCE(event.bank_at,event.recognized_at)<p_to)
   AND (event.recognized_at IS NULL OR NOT(event.recognized_at>=p_from AND event.recognized_at<p_to)) THEN CONTINUE;END IF;
  actual_union:=COALESCE(event.union_id,event.bank_union,(SELECT min(s.union_id::text)::uuid
   FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
   HAVING count(DISTINCT COALESCE(s.union_id::text,'private'))=1));
  -- Current union membership only widens conflict detection. It never sets
  -- a payable source's historical coordinator or a player's payer.
  related:=COALESCE(actual_union=scope_union,false) OR COALESCE(event.bank_club_id=p_club_id,false)
   OR COALESCE(event.fee_bank_club=p_club_id,false)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
      AND (s.club_id=p_club_id OR (scope_union IS NOT NULL AND s.coordinator_union_id=scope_union)))
   OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements e WHERE e.tournament_id=event.tournament_id AND e.refund_wallet_club_id=p_club_id);
  -- A private legacy event with unproved coordinator history cannot be silently
  -- assigned to today's standalone/union scope. The affected week stays open.
  unknown_scope:=actual_union IS NULL AND (event.status IS NULL OR event.status='banked_accrual_deferred')
   AND (COALESCE(event.net_rake,event.bank_amount,0)>0
    OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount<>0))
   AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0)
    OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
     WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0
      AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
       OR r.rake_amount IS DISTINCT FROM(SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
     AND (NOT(s.contract ? 'coordinator_union_id') OR s.contract->'membership'->>'history_id' IS NULL
      OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text)));
  IF NOT related AND NOT unknown_scope THEN CONTINUE;END IF;
  checked:=checked+1;
  IF event.status IS NULL THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_terminal_recognition_missing','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  IF event.status='banked_accrual_deferred' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_deferred','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  -- An eventual normal/satellite terminal receipt may follow a banked fee in
  -- another week. Only original fee-bank/recognition time chooses its liability.
  IF event.bank_at IS NOT NULL AND (event.bank_at IS DISTINCT FROM event.recognized_at
    OR event.bank_amount IS DISTINCT FROM event.net_rake OR event.bank_union IS DISTINCT FROM event.union_id) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_bank_disagrees','tournament_id',event.tournament_id);
  END IF;
  BEGIN proof:=public.fn_accounting_tournament_fee_net_plan(event.tournament_id);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '55000' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_net_source_evidence_invalid','detail',SQLERRM,'tournament_id',event.tournament_id);
  END;
  IF proof->>'status' IS DISTINCT FROM 'proven' OR proof->>'source_fingerprint' IS DISTINCT FROM event.source_fingerprint
    OR (proof->>'net_fee')::numeric IS DISTINCT FROM event.net_rake OR NULLIF(proof->>'union_id','')::uuid IS DISTINCT FROM event.union_id
    OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
    OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
  END IF;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(proof->'active_source_ids');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(proof->'refunded_source_ids');
  SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_sources s
   LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
   WHERE s.tournament_id=event.tournament_id AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
    OR rs.recognized_at IS DISTINCT FROM event.recognized_at
    OR NOT(s.id=ANY(active_ids||refunded_ids))
    OR rs.disposition IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END
    OR rs.rake_credit IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
    OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
    OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at OR s.charged_at>event.recognized_at
    OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
    OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id);
  IF issue_count>0 OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources rs
   LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
   WHERE rs.tournament_id=event.tournament_id AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM event.tournament_id))
   OR (SELECT COALESCE(sum(rake_credit),0) FROM public.accounting_tournament_recognized_sources WHERE tournament_id=event.tournament_id AND disposition='earned') IS DISTINCT FROM event.net_rake THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','checked',checked);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_calculate_cash_rakeback_periods(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE
 tournament_quality jsonb;v_from timestamptz; v_to timestamptz; cutover timestamptz; receipt jsonb;
 scope_union uuid; issue_count bigint; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutover IS NULL OR v_from<cutover THEN RETURN receipt||jsonb_build_object('reason','historical_week_before_observed_source_cutover'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 -- Tournament fees are earned at terminal recognition. Open captured fees
 -- are excluded; deferred or missing terminal authority blocks its actual week.
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 WITH scoped_records AS (
  SELECT r.* FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
     AND (r.club_id=p_club_id
       OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)
       OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=r.club_id AND house.is_union IS TRUE
          AND scope_union IS NOT NULL AND (house.union_id=scope_union OR house.id=scope_union)))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS NOT TRUE)) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 )
 SELECT count(*) INTO issue_count FROM checks WHERE hand_id IS NULL OR attribution_count=0
  OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2);
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',issue_count); END IF;
 -- An old UTC or current-membership period remains an explicit conflict even
 -- when its numbers happen to match. Certificates establish the new writer.
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 SELECT count(*) INTO issue_count FROM public.rake_attributions a JOIN public.rake_records r ON r.id=a.rake_record_id
  LEFT JOIN public.accounting_cash_rake_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
  WHERE a.club_id=p_club_id AND r.created_at>=v_from AND r.created_at<v_to
    AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.rake_amount>0
    AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata)
    AND (s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
      OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
      OR s.contract->>'attribution_id' IS DISTINCT FROM a.id::text
      OR s.contract->>'player_id' IS DISTINCT FROM a.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM a.club_id::text);
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',issue_count); END IF;
 -- Bidirectional comparison also rejects an extra recorded source that no
 -- longer has an attribution. A matching subset is not a complete source set.
 SELECT count(*) INTO issue_count FROM public.accounting_cash_rake_sources s
  LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
  LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
  WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
   AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
    OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
    OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
    OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
    OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
    OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
    OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',issue_count); END IF;


 FOR player IN
  WITH receipts AS (
   SELECT s.*,CASE WHEN s.source_type='tournament_fee_accrual' THEN fee.charged_at ELSE s.earned_at END AS agreement_at,s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   LEFT JOIN public.accounting_tournament_fee_sources fee ON s.source_type='tournament_fee_accrual' AND fee.id=s.source_id
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,NULLIF(r.member->>'agent_id','')::uuid AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=(r.contract->'membership'->>'history_id')::bigint
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<>1 THEN RAISE EXCEPTION 'multiple_historical_payers_require_split_period' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=player.payer_user;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN receipt||jsonb_build_object('status','ready','written',written,'confirmed_players',confirmed);
EXCEPTION WHEN SQLSTATE '55000' THEN
 RETURN receipt||jsonb_build_object('reason',SQLERRM);
END $function$;
REVOKE ALL ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
