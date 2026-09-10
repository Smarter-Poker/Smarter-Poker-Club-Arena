-- Executable source-aware wrapper proposal. Not a production migration.
BEGIN;
CREATE FUNCTION public.fn_ca_rakeback_fact_eligible(f public.ca_cash_commission_facts) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path TO public,pg_temp AS $f$
 SELECT coalesce(f.errors='[]'::jsonb AND coalesce(f.player_terms->'errors','[]'::jsonb)='[]'::jsonb
 AND f.player_rebate_entitlement IS NOT NULL AND f.player_rebate_rate IS NOT NULL
 AND f.player_rebate_entitlement=f.rake_credit*f.player_rebate_rate
 AND f.player_rebate_entitlement>=0
 AND ((f.assignment_state='assigned' AND f.payer_user_id IS NOT NULL AND f.payer_user_id<>f.player_id
 AND f.direct_commission_rate IS NOT NULL AND f.player_rebate_rate<=f.direct_commission_rate-.10)
 OR (f.assignment_state='self_agent' AND f.player_rebate_entitlement=0 AND f.player_rebate_rate=0)),false)
$f$;
REVOKE ALL ON FUNCTION public.fn_ca_rakeback_fact_eligible(public.ca_cash_commission_facts) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_discover_captured_rakeback_periods(p_clubs uuid[],p_user uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE v_count integer;
BEGIN
 -- Scope locks precede uniqueness/index locks taken by discovery itself.
 PERFORM public.fn_lock_rakeback_payer_clubs(p_clubs);
 INSERT INTO public.ca_rakeback_source_periods(club_id,user_id,period_start,period_end)
 SELECT DISTINCT f.booked_club_id,f.player_id,date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date,
 date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date+6
 FROM public.ca_cash_commission_facts f JOIN public.ca_cash_commission_sources s USING(hand_id)
 JOIN public.hand_atomic_commits receipt ON receipt.hand_id=s.hand_id
 AND receipt.commission_capture_version=1 AND receipt.post_commit_payload_hash=s.accepted_payload_hash
 JOIN public.ca_cash_commission_authority a ON a.singleton AND a.contract_version=1
 WHERE f.booked_club_id=ANY(p_clubs) AND (p_user IS NULL OR f.player_id=p_user)
 ON CONFLICT(club_id,user_id,period_start) DO NOTHING;
 GET DIAGNOSTICS v_count=ROW_COUNT; RETURN v_count;
END $f$;
REVOKE ALL ON FUNCTION public.fn_discover_captured_rakeback_periods(uuid[],uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.ca_rakeback_claim_requests(
 request_id uuid PRIMARY KEY,actor_id uuid NOT NULL,club_id uuid,period_ids uuid[] NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ca_rakeback_claim_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_rakeback_claim_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_rakeback_claim_requests TO service_role;
CREATE TRIGGER rakeback_claim_immutable BEFORE UPDATE OR DELETE ON public.ca_rakeback_claim_requests
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_rakeback_source_evidence_immutable();
CREATE TRIGGER rakeback_claim_no_truncate BEFORE TRUNCATE ON public.ca_rakeback_claim_requests
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_rakeback_source_evidence_immutable();

CREATE FUNCTION public.fn_claim_captured_rakeback(p_request_id uuid,p_expected_user_id uuid,p_club_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_actor uuid:=auth.uid();v_old record;v_clubs uuid[];v_periods uuid[];v_id uuid;
 v_res jsonb;v_results jsonb:='[]';v_result jsonb;v_total numeric:=0;v_count integer:=0;
BEGIN
 IF v_actor IS NULL OR p_request_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'authentication_and_request_required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-request'),hashtext(p_request_id::text));
 SELECT * INTO v_old FROM public.ca_rakeback_claim_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_old.actor_id<>v_actor OR v_old.club_id IS DISTINCT FROM p_club_id THEN
   RAISE EXCEPTION 'claim_request_scope_conflict' USING ERRCODE='23514';
  END IF;
  RETURN v_old.result;
 END IF;
 SELECT array_agg(DISTINCT f.booked_club_id ORDER BY f.booked_club_id) INTO v_clubs
 FROM public.ca_cash_commission_facts f JOIN public.ca_cash_commission_sources s USING(hand_id)
 JOIN public.hand_atomic_commits receipt ON receipt.hand_id=s.hand_id
 AND receipt.commission_capture_version=1 AND receipt.post_commit_payload_hash=s.accepted_payload_hash
 JOIN public.ca_cash_commission_authority a ON a.singleton AND a.contract_version=1
 WHERE f.player_id=v_actor AND (p_club_id IS NULL OR f.booked_club_id=p_club_id);
 PERFORM public.fn_lock_rakeback_payer_clubs(v_clubs);
 PERFORM public.fn_discover_captured_rakeback_periods(v_clubs,v_actor);
 SELECT coalesce(array_agg(id ORDER BY club_id,period_start,id),'{}') INTO v_periods
 FROM public.ca_rakeback_source_periods
 WHERE user_id=v_actor AND club_id=ANY(v_clubs) AND period_end<(now() AT TIME ZONE 'UTC')::date;
 FOREACH v_id IN ARRAY v_periods LOOP
  v_res:=public.fn_pay_captured_rakeback_period(v_id);
  v_results:=v_results||jsonb_build_array(v_res);
  v_total:=v_total+coalesce((v_res->>'new_payout')::numeric,0);
  IF coalesce((v_res->>'new_payout')::numeric,0)>0 THEN v_count:=v_count+1; END IF;
 END LOOP;
 v_result:=jsonb_build_object('success',true,'request_id',p_request_id,'periods_claimed',v_count,
 'total_payout',v_total,'periods',v_results,'source_final',false);
 INSERT INTO public.ca_rakeback_claim_requests(request_id,actor_id,club_id,period_ids,result)
 VALUES(p_request_id,v_actor,p_club_id,v_periods,v_result);
 RETURN v_result;
END $f$;
REVOKE ALL ON FUNCTION public.fn_claim_captured_rakeback(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_claim_captured_rakeback(uuid,uuid,uuid) TO authenticated,service_role;

-- The atomic source cutover retires the legacy browser mutation without a durable request UUID.
CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE='42501'; END IF;
 RAISE EXCEPTION 'captured_claim_request_required' USING ERRCODE='55000';
END $f$;
REVOKE ALL ON FUNCTION public.fn_claim_rakeback(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_claim_rakeback(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_period record;v_id uuid;v_res jsonb;
BEGIN
 SELECT * INTO v_period FROM public.ca_rakeback_source_periods WHERE id=p_period_id;
 IF NOT FOUND THEN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id=p_period_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','period_not_found'); END IF;
 END IF;
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR (
 auth.uid()<>v_period.user_id AND NOT public.fn_is_platform_admin()
 AND NOT EXISTS(SELECT 1 FROM clubs WHERE id=v_period.club_id AND owner_id=auth.uid())
 AND NOT EXISTS(SELECT 1 FROM union_clubs uc WHERE uc.club_id=v_period.club_id
 AND public.fn_is_union_overseer(uc.union_id,auth.uid())))) THEN
 RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[v_period.club_id]);
 PERFORM public.fn_discover_captured_rakeback_periods(ARRAY[v_period.club_id],v_period.user_id);
 SELECT id INTO v_id FROM public.ca_rakeback_source_periods WHERE club_id=v_period.club_id
 AND user_id=v_period.user_id AND period_start=v_period.period_start AND period_end=v_period.period_end;
 IF v_id IS NULL THEN RETURN jsonb_build_object('success',false,'deferred','no_prospective_source'); END IF;
 v_res:=public.fn_pay_captured_rakeback_period(v_id);
 RETURN v_res||jsonb_build_object('payout',coalesce((v_res->>'new_payout')::numeric,0));
END $f$;
REVOKE ALL ON FUNCTION public.fn_close_settlement_period(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_settlement_period(uuid) TO service_role;


CREATE TABLE public.ca_rakeback_source_attempts(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 period_id uuid NOT NULL REFERENCES public.ca_rakeback_source_periods(id),
 attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ca_rakeback_source_attempt_period_time ON public.ca_rakeback_source_attempts(period_id,attempted_at DESC);
ALTER TABLE public.ca_rakeback_source_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_rakeback_source_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ca_rakeback_source_attempts TO service_role;
CREATE TRIGGER rakeback_attempt_immutable BEFORE UPDATE OR DELETE ON public.ca_rakeback_source_attempts
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_rakeback_source_evidence_immutable();
CREATE TRIGGER rakeback_attempt_no_truncate BEFORE TRUNCATE ON public.ca_rakeback_source_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_rakeback_source_evidence_immutable();

CREATE FUNCTION public.fn_captured_rakeback_due_periods(p_club uuid)
RETURNS TABLE(id uuid,period_start date,last_attempt timestamptz)
LANGUAGE sql STABLE SET search_path TO public,pg_temp AS $f$
 WITH earned AS (
 SELECT f.booked_club_id club_id,f.player_id,f.payer_user_id,
 date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date week,
 floor(sum(f.player_rebate_entitlement)*100)/100 amount
 FROM public.ca_cash_commission_facts f JOIN public.ca_cash_commission_sources s USING(hand_id)
 JOIN public.hand_atomic_commits receipt ON receipt.hand_id=s.hand_id
 AND receipt.commission_capture_version=1 AND receipt.post_commit_payload_hash=s.accepted_payload_hash
 JOIN public.ca_cash_commission_authority a ON a.singleton AND a.contract_version=1
 WHERE f.booked_club_id=p_club AND public.fn_ca_rakeback_fact_eligible(f)
 GROUP BY f.booked_club_id,f.player_id,f.payer_user_id,date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date
 ), paid AS(
 SELECT p.club_id,p.player_id,p.payer_user_id,p.period_start,sum(p.amount) amount
 FROM public.ca_rakeback_source_payments p WHERE p.club_id=p_club GROUP BY 1,2,3,4
 )
 SELECT DISTINCT rp.id,rp.period_start,
 (SELECT max(t.attempted_at) FROM public.ca_rakeback_source_attempts t WHERE t.period_id=rp.id)
 FROM earned e JOIN public.ca_rakeback_source_periods rp ON rp.club_id=e.club_id
 AND rp.user_id=e.player_id AND rp.period_start=e.week
 LEFT JOIN paid p ON p.club_id=e.club_id AND p.player_id=e.player_id
 AND p.payer_user_id=e.payer_user_id AND p.period_start=e.week
 WHERE e.amount>coalesce(p.amount,0) AND rp.period_end<(now() AT TIME ZONE 'UTC')::date
$f$;
REVOKE ALL ON FUNCTION public.fn_captured_rakeback_due_periods(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_club_rakeback_batch(p_club_id uuid,p_max_periods integer DEFAULT 40,
 p_budget_seconds numeric DEFAULT 4.0,p_max_warm_days integer DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE r record;v_res jsonb;v_total numeric:=0;v_count integer:=0;v_deferred integer:=0;
 v_started timestamptz:=clock_timestamp();v_results jsonb:='[]';v_attempts integer:=0;
BEGIN
 IF p_club_id IS NULL THEN RAISE EXCEPTION 'club_required' USING ERRCODE='22023'; END IF;
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR
 (NOT public.fn_is_platform_admin() AND NOT EXISTS(SELECT 1 FROM clubs WHERE id=p_club_id AND owner_id=auth.uid())
 AND NOT EXISTS(SELECT 1 FROM union_clubs uc WHERE uc.club_id=p_club_id
 AND public.fn_is_union_overseer(uc.union_id,auth.uid())))) THEN
 RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[p_club_id]);
 v_started:=clock_timestamp();
 PERFORM public.fn_discover_captured_rakeback_periods(ARRAY[p_club_id],NULL);
 FOR r IN SELECT id FROM public.fn_captured_rakeback_due_periods(p_club_id)
 ORDER BY last_attempt NULLS FIRST,period_start,id
 LIMIT greatest(1,least(coalesce(p_max_periods,40),1000)) LOOP
  EXIT WHEN v_attempts>0 AND extract(epoch FROM clock_timestamp()-v_started)>greatest(.5,least(coalesce(p_budget_seconds,4),30));
  v_res:=public.fn_pay_captured_rakeback_period(r.id);
  INSERT INTO public.ca_rakeback_source_attempts(period_id) VALUES(r.id);
  v_attempts:=v_attempts+1;
  v_total:=v_total+coalesce((v_res->>'new_payout')::numeric,0);
  IF coalesce((v_res->>'new_payout')::numeric,0)>0 THEN v_count:=v_count+1; END IF;
  IF coalesce(v_res->'deferred','[]')<>'[]'::jsonb THEN v_deferred:=v_deferred+1; END IF;
  v_results:=v_results||jsonb_build_array(v_res);
 END LOOP;
 RETURN jsonb_build_object('success',true,'club_id',p_club_id,'periods_settled',v_count,
 'total_payout',v_total,'deferred',v_deferred,'errors',0,'periods',v_results,'source_final',false);
END $f$;
REVOKE ALL ON FUNCTION public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_club_rakeback_batch(uuid,integer,numeric,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid,
 p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_clubs uuid[];r record;v_res jsonb;v_total numeric:=0;v_count integer:=0;v_short integer:=0;v_detail jsonb:='[]';
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR
 NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN
 RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<=p_period_start THEN
 RAISE EXCEPTION 'invalid_settlement_window' USING ERRCODE='22023'; END IF;
 SELECT array_agg(club_id ORDER BY club_id) INTO v_clubs FROM public.union_clubs WHERE union_id=p_union_id;
 PERFORM public.fn_lock_rakeback_payer_clubs(v_clubs);
 PERFORM public.fn_discover_captured_rakeback_periods(v_clubs,NULL);
 -- A partial or overlapping window cannot retag a source to another earning week.
 FOR r IN SELECT id FROM public.ca_rakeback_source_periods WHERE club_id=ANY(v_clubs)
 AND period_start::timestamp AT TIME ZONE 'UTC'>=p_period_start
 AND (period_end+1)::timestamp AT TIME ZONE 'UTC'<=p_period_end
 AND period_end<(now() AT TIME ZONE 'UTC')::date ORDER BY club_id,period_start,id LOOP
  v_res:=public.fn_pay_captured_rakeback_period(r.id);
  v_total:=v_total+coalesce((v_res->>'new_payout')::numeric,0);
  IF coalesce((v_res->>'new_payout')::numeric,0)>0 THEN v_count:=v_count+1; END IF;
  IF coalesce(v_res->'deferred','[]')<>'[]'::jsonb THEN v_short:=v_short+1; END IF;
  v_detail:=v_detail||jsonb_build_array(v_res);
 END LOOP;
 RETURN jsonb_build_object('round',3,'name','agents_to_players','success',true,
 'payees',v_count,'amount',v_total,'shortfalls',v_short,'detail',v_detail,'source_final',false);
END $f$;
REVOKE ALL ON FUNCTION public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz) TO authenticated,service_role;

CREATE FUNCTION public.fn_get_captured_rakeback() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_actor uuid:=auth.uid();v_rows jsonb;
BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE='42501'; END IF;
 WITH facts AS(
  SELECT f.*,date_trunc('week',s.settled_at AT TIME ZONE 'UTC')::date week,
  public.fn_ca_rakeback_fact_eligible(f) eligible
  FROM public.ca_cash_commission_facts f JOIN public.ca_cash_commission_sources s USING(hand_id)
  JOIN public.hand_atomic_commits receipt ON receipt.hand_id=s.hand_id
 AND receipt.commission_capture_version=1 AND receipt.post_commit_payload_hash=s.accepted_payload_hash
 JOIN public.ca_cash_commission_authority a ON a.singleton AND a.contract_version=1
  WHERE f.player_id=v_actor
 ), groups AS(
  SELECT booked_club_id club_id,week,payer_user_id,
  sum(rake_credit) rake_generated,
  coalesce(sum(player_rebate_entitlement) FILTER(WHERE eligible),0) exact_earned,
  count(*) FILTER(WHERE NOT eligible) unresolved_sources
  FROM facts GROUP BY booked_club_id,week,payer_user_id
 ), net AS(
  SELECT g.*,coalesce(paid.amount,0) paid_amount,
  greatest(0,floor(g.exact_earned*100)/100-coalesce(paid.amount,0)) pending_amount,
  floor(g.exact_earned*100)/100 earned_amount
  FROM groups g LEFT JOIN LATERAL(
   SELECT sum(p.amount) amount FROM public.ca_rakeback_source_payments p
   WHERE p.club_id=g.club_id AND p.player_id=v_actor AND p.payer_user_id=g.payer_user_id
   AND p.period_start=g.week) paid ON true
 ), periods AS(
 SELECT club_id,week period_start,week+6 period_end,sum(rake_generated) rake_generated,
 sum(earned_amount) rakeback_earned,sum(paid_amount) paid_amount,sum(pending_amount) pending_amount,
 sum(unresolved_sources) unresolved_sources,sum(exact_earned) exact_entitlement,
 sum(exact_earned-paid_amount) unpaid_exact_entitlement,
 coalesce(sum(exact_earned)/nullif(sum(rake_generated),0),0) rakeback_rate,
 CASE WHEN week+6>=(now() AT TIME ZONE 'UTC')::date THEN 'open'
 WHEN sum(unresolved_sources)>0 THEN 'needs_review'
 WHEN sum(pending_amount)>0 THEN 'pending'
 WHEN sum(exact_earned-paid_amount)>0 THEN 'fraction_pending' ELSE 'settled_so_far' END status
 FROM net GROUP BY club_id,week)
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY period_start DESC,club_id),'[]') INTO v_rows FROM periods p;
 RETURN jsonb_build_object('periods',v_rows,'source_final',false,
 'source_active',EXISTS(SELECT 1 FROM public.ca_cash_commission_authority WHERE singleton));
END $f$;
REVOKE ALL ON FUNCTION public.fn_get_captured_rakeback() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_get_captured_rakeback() TO authenticated,service_role;
COMMIT;
