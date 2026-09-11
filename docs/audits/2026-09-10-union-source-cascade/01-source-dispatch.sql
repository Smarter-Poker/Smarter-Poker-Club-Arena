-- Unactivated integration candidate. Requires the reviewed capture, bank,
-- club release, agent payment and player payment owners in one coordinated release.
-- The source progress returned here is deliberately not a period-close witness.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';

CREATE FUNCTION public.fn_ca_union_captured_scope_clubs(p_union uuid)
RETURNS uuid[] LANGUAGE sql STABLE SET search_path TO public,pg_temp AS $f$
 SELECT coalesce(array_agg(club_id ORDER BY club_id),'{}'::uuid[]) FROM (
  SELECT club_id FROM public.union_clubs WHERE union_id=p_union
  UNION
  SELECT requested_club_id FROM public.ca_cash_commission_sources WHERE funding_union_id=p_union
  UNION
  SELECT f.booked_club_id FROM public.ca_cash_commission_facts f
   JOIN public.ca_cash_commission_sources s USING(hand_id)
   WHERE s.funding_union_id=p_union AND f.booked_club_id IS NOT NULL
  UNION
  SELECT club_id FROM public.ca_source_funding_pools WHERE funding_union_id=p_union
 ) discovered;
$f$;
REVOKE ALL ON FUNCTION public.fn_ca_union_captured_scope_clubs(uuid)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_assert_union_captured_locks(p_union uuid,p_clubs uuid[])
RETURNS void LANGUAGE plpgsql SET search_path TO public,pg_temp AS $f$
DECLARE c uuid;
BEGIN
 IF p_union IS NULL OR p_clubs IS NULL OR EXISTS(
  SELECT 1 FROM unnest(public.fn_ca_union_captured_scope_clubs(p_union)) club_id
   WHERE NOT (club_id=ANY(p_clubs))) THEN
  RAISE EXCEPTION 'captured_union_scope_changed_retry' USING ERRCODE='40001';
 END IF;
 FOREACH c IN ARRAY p_clubs LOOP
  IF c IS NULL OR NOT EXISTS(SELECT 1 FROM pg_locks l
   WHERE l.pid=pg_backend_pid() AND l.locktype='advisory' AND l.granted
    AND l.mode='ExclusiveLock' AND l.objsubid=2
    AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND l.classid=(hashtext('club-arena:rakeback-payer')::bigint & 4294967295)::oid
    AND l.objid=(hashtext(c::text)::bigint & 4294967295)::oid) THEN
   RAISE EXCEPTION 'captured_union_club_lock_not_owned' USING ERRCODE='55000';
  END IF;
 END LOOP;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_assert_union_captured_locks(uuid,uuid[])
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_dispatch_union_captured_funding(
 p_union uuid,p_bank_closed_through timestamptz,p_earning_closed_through date,p_clubs uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE h record;p record;r record;v_result jsonb;v_one jsonb;v_pool_results jsonb:='[]';
 v_release numeric:=0;v_agent numeric:=0;v_player numeric:=0;
 v_pool_release numeric;v_pool_agent numeric;v_pool_player numeric;
 v_agent_seq bigint;v_player_seq bigint;v_shortfalls integer:=0;v_admission_deferred integer:=0;
 v_actor uuid:=auth.uid();v_diagnostics jsonb;
BEGIN
 IF p_union IS NULL OR p_bank_closed_through IS NULL OR NOT isfinite(p_bank_closed_through)
  OR p_bank_closed_through IS DISTINCT FROM public.fn_union_week_start(p_bank_closed_through)
  OR p_bank_closed_through>public.fn_union_week_start(clock_timestamp())
  OR p_earning_closed_through IS NULL OR NOT isfinite(p_earning_closed_through)
  OR extract(isodow FROM p_earning_closed_through)<>1
  OR p_earning_closed_through>date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date THEN
  RAISE EXCEPTION 'closed_original_funding_boundaries_required' USING ERRCODE='22023';
 END IF;
 IF NOT public.fn_caller_is_engine() AND (v_actor IS NULL OR NOT public.fn_is_union_overseer(p_union,v_actor)) THEN
  RAISE EXCEPTION 'not_authorised_for_original_union' USING ERRCODE='42501';
 END IF;
 IF v_actor IS NULL THEN RAISE EXCEPTION 'captured_union_actor_required' USING ERRCODE='42501';END IF;
 PERFORM public.fn_ca_assert_union_captured_locks(p_union,p_clubs);
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'platform_frozen' USING ERRCODE='55000';END IF;

 -- Admit every original booked club, including clubs that have since departed.
 -- Commission receipts may still be deferred by their real owner. Admission
 -- reports that state; it never substitutes a current agent or a legacy claim.
 FOR h IN SELECT DISTINCT b.hand_id,f.booked_club_id club_id
  FROM public.ca_cash_bank_receipts b
  JOIN public.ca_cash_commission_facts f USING(hand_id)
  WHERE b.funding_union_id=p_union AND b.funding_route='union_rake_wallet'
   AND b.contract_version=1 AND b.bank_credit_at<p_bank_closed_through
   AND f.booked_club_id IS NOT NULL ORDER BY f.booked_club_id,b.hand_id LOOP
  PERFORM public.fn_ca_assert_union_captured_locks(p_union,p_clubs);
  v_result:=public.fn_ca_admit_source_funding(h.hand_id,h.club_id);
  v_admission_deferred:=v_admission_deferred+coalesce((v_result->>'deferred_contributors')::integer,0);
 END LOOP;

 FOR p IN SELECT * FROM public.ca_source_funding_pools
  WHERE funding_union_id=p_union AND funding_route='union_rake_wallet' AND contract_version=1
  ORDER BY club_id,id LOOP
  PERFORM public.fn_ca_assert_union_captured_locks(p_union,p_clubs);
  v_pool_agent:=0;v_pool_player:=0;
  SELECT coalesce(max(payment_seq),0) INTO v_agent_seq FROM ca_source_agent_cash_payments WHERE pool_id=p.id;
  SELECT coalesce(max(payment_seq),0) INTO v_player_seq FROM ca_source_player_cash_payments WHERE pool_id=p.id;
  -- This outer API has no request UUID. Each attempt owns a new release request;
  -- the underlying source admissions and money receipts remain cumulative and
  -- idempotent. A previous zero/short request cannot permanently suppress retry.
  v_result:=public.fn_release_captured_club_funding(p.id,p_bank_closed_through,gen_random_uuid(),v_actor);
  IF v_result->>'success' IS DISTINCT FROM 'true'
   OR jsonb_typeof(v_result->'new_release') IS DISTINCT FROM 'number'
   OR jsonb_typeof(v_result->'release_ids') IS DISTINCT FROM 'array'
   OR jsonb_typeof(v_result->'deferred') IS DISTINCT FROM 'array'
   OR v_result->>'source_final' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'captured_union_release_contract_violated' USING ERRCODE='23514';
  END IF;
  v_pool_release:=(v_result->>'new_release')::numeric;
  IF v_pool_release<0 OR v_pool_release<>round(v_pool_release,2)
   OR v_pool_release::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'captured_union_release_amount_invalid' USING ERRCODE='23514';
  END IF;
  FOR r IN SELECT value::text::uuid id FROM jsonb_array_elements_text(v_result->'release_ids') LOOP
   IF NOT EXISTS(SELECT 1 FROM ca_source_club_cash_releases WHERE id=r.id AND pool_id=p.id) THEN
    RAISE EXCEPTION 'captured_union_release_scope_mismatch' USING ERRCODE='23514';
   END IF;
   PERFORM public.fn_ca_assert_source_club_release(r.id);
   PERFORM public.fn_ca_assert_source_club_release_money(r.id);
  END LOOP;
  IF v_pool_release IS DISTINCT FROM (SELECT coalesce(sum(x.amount),0)
    FROM ca_source_club_cash_releases x WHERE x.pool_id=p.id
     AND x.id IN(SELECT value::text::uuid FROM jsonb_array_elements_text(v_result->'release_ids'))) THEN
   RAISE EXCEPTION 'captured_union_release_total_mismatch' USING ERRCODE='23514';
  END IF;
  v_shortfalls:=v_shortfalls+jsonb_array_length(v_result->'deferred');

  FOR r IN SELECT DISTINCT recipient_id FROM public.ca_source_recipient_accruals
   WHERE pool_id=p.id ORDER BY recipient_id LOOP
   v_one:=public.fn_pay_captured_agent_funding(p.id,r.recipient_id,p_earning_closed_through);
   IF v_one->>'success' IS DISTINCT FROM 'true'
    OR jsonb_typeof(v_one->'new_payout') IS DISTINCT FROM 'number'
    OR v_one->>'source_final' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'captured_union_agent_contract_violated' USING ERRCODE='23514';
   END IF;
   IF (v_one->>'new_payout')::numeric<0 OR (v_one->>'new_payout')::numeric<>round((v_one->>'new_payout')::numeric,2)
    OR v_one->>'new_payout' IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'captured_union_agent_amount_invalid' USING ERRCODE='23514';
   END IF;
   v_pool_agent:=v_pool_agent+(v_one->>'new_payout')::numeric;
   IF v_one->>'deferred' IS NOT NULL THEN v_shortfalls:=v_shortfalls+1;END IF;
  END LOOP;

  -- Discover from admitted original direct-payer rights, even when this attempt
  -- generated zero new agent cash. Existing matched capacity may fund a cent.
  FOR r IN SELECT DISTINCT a.contributor_id player_id,a.recipient_id payer_id
   FROM public.ca_source_recipient_funding_admissions a
   JOIN public.ca_source_recipient_accruals x USING(hand_id,contributor_id,agent_id)
   WHERE a.pool_id=p.id AND x.is_direct_payer
   ORDER BY a.recipient_id,a.contributor_id LOOP
   v_one:=public.fn_pay_captured_player_funding(p.id,r.player_id,r.payer_id,p_earning_closed_through);
   IF v_one->>'success' IS DISTINCT FROM 'true'
    OR jsonb_typeof(v_one->'new_payout') IS DISTINCT FROM 'number'
    OR v_one->>'source_final' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'captured_union_player_contract_violated' USING ERRCODE='23514';
   END IF;
   IF (v_one->>'new_payout')::numeric<0 OR (v_one->>'new_payout')::numeric<>round((v_one->>'new_payout')::numeric,2)
    OR v_one->>'new_payout' IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'captured_union_player_amount_invalid' USING ERRCODE='23514';
   END IF;
   v_pool_player:=v_pool_player+(v_one->>'new_payout')::numeric;
   IF v_one->>'deferred' IS NOT NULL THEN v_shortfalls:=v_shortfalls+1;END IF;
  END LOOP;
  -- These assertions read actual immutable receipts and their linked wallet,
  -- treasury, ledger and exact source slices. Totals alone are not conservation.
  IF v_pool_agent IS DISTINCT FROM (SELECT coalesce(sum(amount),0) FROM ca_source_agent_cash_payments WHERE pool_id=p.id AND payment_seq>v_agent_seq)
   OR v_pool_player IS DISTINCT FROM (SELECT coalesce(sum(amount),0) FROM ca_source_player_cash_payments WHERE pool_id=p.id AND payment_seq>v_player_seq) THEN
   RAISE EXCEPTION 'captured_union_payment_total_mismatch' USING ERRCODE='23514';
  END IF;
  -- Sequence markers select this locked attempt's new receipts only. They are
  -- never a completeness or finality witness for the source stream.
  FOR r IN SELECT id FROM ca_source_agent_cash_payments WHERE pool_id=p.id AND payment_seq>v_agent_seq LOOP
   PERFORM public.fn_ca_assert_source_agent_payment(r.id);
  END LOOP;
  FOR r IN SELECT id FROM ca_source_player_cash_payments WHERE pool_id=p.id AND payment_seq>v_player_seq LOOP
   PERFORM public.fn_ca_assert_source_player_payment(r.id);
  END LOOP;
  v_release:=v_release+v_pool_release;v_agent:=v_agent+v_pool_agent;v_player:=v_player+v_pool_player;
  v_pool_results:=v_pool_results||jsonb_build_array(jsonb_build_object('pool_id',p.id,'club_id',p.club_id,
   'funding_union_id',p.funding_union_id,'new_release',v_pool_release,'new_agent_payout',v_pool_agent,
   'new_player_payout',v_pool_player));
 END LOOP;
 PERFORM public.fn_ca_assert_union_captured_locks(p_union,p_clubs);

 SELECT jsonb_build_object(
  'unbanked_captured_hands',(SELECT count(*) FROM ca_cash_commission_sources s
   WHERE s.funding_union_id=p_union AND s.rake_total>0 AND NOT EXISTS(SELECT 1 FROM ca_cash_bank_receipts b WHERE b.hand_id=s.hand_id)),
  'admission_deferred_contributors',v_admission_deferred,
  'producer_close_witness_available',false,
  'liability_policy','Exact fractions remain owed in their original compatible pool') INTO v_diagnostics;
 RETURN jsonb_build_object('success',true,'union_id',p_union,'bank_closed_through',p_bank_closed_through,
  'earning_closed_through',p_earning_closed_through,'new_club_release',v_release,'new_agent_payout',v_agent,
  'new_player_payout',v_player,'shortfalls',v_shortfalls,'pools',v_pool_results,
  'diagnostics',v_diagnostics,'source_final',false,'finality_reason','producer_and_funding_close_witness_unavailable');
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_dispatch_union_captured_funding(uuid,timestamptz,date,uuid[])
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
