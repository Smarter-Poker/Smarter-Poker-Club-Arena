-- One period writer reads immutable earned-club source receipts and the exact
-- Pacific book. Unknown history and existing liabilities are never rewritten.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure))<>'2078fb6e89f22704096974ecf933e385'
 THEN RAISE EXCEPTION 'rakeback period source changed since review'; END IF;
END $guard$;
CREATE TABLE public.accounting_rakeback_period_calculations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 period_id uuid NOT NULL REFERENCES public.rakeback_periods(id),
 accounting_version integer NOT NULL DEFAULT 2 CHECK(accounting_version=2),
 source_fingerprint text NOT NULL,
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 player_id uuid NOT NULL,
 coordinator_union_id uuid,
 period_start date NOT NULL,
 period_end date NOT NULL,
 rake_generated numeric NOT NULL CHECK(rake_generated::text NOT IN('NaN','Infinity','-Infinity') AND rake_generated>=0 AND rake_generated=round(rake_generated,2)),
 rakeback_amount numeric NOT NULL CHECK(rakeback_amount::text NOT IN('NaN','Infinity','-Infinity') AND rakeback_amount>=0 AND rakeback_amount=round(rakeback_amount,2)),
 display_rate numeric NOT NULL CHECK(display_rate>=0 AND display_rate<=1 AND display_rate=round(display_rate,4)),
 payer_kind text NOT NULL CHECK(payer_kind IN('club','agent')),
 payer_user_id uuid,
 source_allocations jsonb NOT NULL CHECK(jsonb_typeof(source_allocations)='array'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((payer_kind='agent')=(payer_user_id IS NOT NULL)),
 CHECK(rakeback_amount<=rake_generated),
 UNIQUE(period_id,source_fingerprint)
);
CREATE INDEX accounting_rakeback_period_calculations_latest ON public.accounting_rakeback_period_calculations(period_id,id DESC);
ALTER TABLE public.accounting_rakeback_period_calculations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_rakeback_period_calculations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_rakeback_period_calculations TO service_role;
CREATE TRIGGER accounting_rakeback_calculation_immutable BEFORE UPDATE OR DELETE ON public.accounting_rakeback_period_calculations
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_rakeback_calculation_no_truncate BEFORE TRUNCATE ON public.accounting_rakeback_period_calculations
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_calculate_cash_rakeback_periods','approved','Private period calculation called only through the durable request wrapper; source receipts and observed history produce append-only period certificates. No wallet movement and no direct role execution grant.');
CREATE TABLE public.accounting_period_recompute_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 period_start date NOT NULL,
 period_end date NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','blocked','complete')),
 reason text,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempted_at timestamptz,
 attempts bigint NOT NULL DEFAULT 0,
 last_result jsonb NOT NULL DEFAULT '{}',
 UNIQUE(club_id,period_start,period_end),
 CHECK(extract(isodow FROM period_start)=1 AND period_end=period_start+6)
);
ALTER TABLE public.accounting_period_recompute_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_period_recompute_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_period_recompute_requests TO service_role;
CREATE INDEX accounting_period_recompute_requests_pending ON public.accounting_period_recompute_requests(period_start,club_id) WHERE status<>'complete';

CREATE FUNCTION public.fn_calculate_cash_rakeback_periods(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE
 v_from timestamptz; v_to timestamptz; cutover timestamptz; receipt jsonb;
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
 -- Tournament entitlement has no immutable per-player earning-club receipt
 -- yet. It cannot be silently discarded from a weekly book containing cash.
 SELECT count(*) INTO issue_count FROM public.rake_records r
  WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
    AND (r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL)
    AND (r.club_id=p_club_id OR r.club_id=scope_union OR EXISTS(SELECT 1 FROM public.clubs h
      WHERE h.id=r.club_id AND h.is_union IS TRUE AND h.union_id=scope_union));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','tournament_earning_evidence_unavailable','source_count',issue_count); END IF;
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
   SELECT s.*,s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_cash_rake_sources s
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
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.earned_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.earned_at
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
   jsonb_agg(jsonb_build_object('source_id',e.id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.rake_record_id,e.id) AS allocations
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

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(p_club_id uuid,p_period_start date,p_period_end date,p_user_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='300s' AS $function$
DECLARE request public.accounting_period_recompute_requests%ROWTYPE; result jsonb; request_state text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 BEGIN
  result:=public.fn_calculate_cash_rakeback_periods(p_club_id,p_period_start,p_period_end,p_user_ids);
 EXCEPTION WHEN OTHERS THEN
  -- This subtransaction rolls back every period/certificate write before the
  -- durable request is marked blocked. The source cursor can keep accruing
  -- later hands; the weekly coordinator still refuses this unfinished book.
  result:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,
    'period_end',p_period_end,'status','blocked','written',0,'reason',SQLERRM);
 END;
 request_state:=CASE WHEN result->>'status'='ready' AND p_user_ids IS NULL THEN 'complete'
                     WHEN result->>'status'='ready' THEN 'pending' ELSE 'blocked' END;
 UPDATE public.accounting_period_recompute_requests SET status=request_state,reason=result->>'reason',
  attempted_at=clock_timestamp(),attempts=attempts+1,last_result=result WHERE id=request.id;
 RETURN result||jsonb_build_object('request_id',request.id,'requested_at',request.requested_at,
  'request_state',request_state,'request_recorded',true);
END $function$;
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid,date,date,uuid[]) TO service_role;
COMMIT;
