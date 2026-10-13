CREATE FUNCTION native_original_assert.accepted_sets() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE n text;v jsonb;z jsonb:='{}';
BEGIN
 FOREACH n IN ARRAY ARRAY['public.hand_atomic_commits','public.hand_history','smarter_private.hand_submission_source_corrections','smarter_private.hand_submission_correction_claims','smarter_private.hand_submission_correction_results','smarter_private.hand_submission_handoffs','smarter_private.hand_submission_handoff_results','smarter_private.f06_hand_permits','public.table_seats','public.tournament_players','public.settlement_idempotency_keys','public.ca_settlements','public.ca_seat_stack_rebases','public.hand_projection_outbox'] LOOP
  EXECUTE format('SELECT jsonb_build_object(''count'',count(*),''md5'',md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb)::text)) FROM %s t',n) INTO v;
  z:=z||jsonb_build_object(n,v);
 END LOOP;RETURN z;
END $f$;
DO $replay$
DECLARE before_money jsonb:=native_original_assert.financial_sets();before_accept jsonb:=native_original_assert.accepted_sets();s record;l public.engine_tournament_leases;r jsonb;n integer:=0;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 FOR s IN SELECT j.*, (j.request#>>'{p_hand_row,tournament_id}')::uuid tour FROM smarter_private.hand_submissions j JOIN smarter_private.hand_submission_source_corrections c USING(submission_id) ORDER BY j.submission_id LOOP
  SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=s.tour;
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=s.tour;
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id',s.tour::text,true);
  PERFORM set_config('app.smarter_tournament_lease_generation',l.lease_generation::text,true);
  r:=public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);
  IF r->>'found' IS DISTINCT FROM 'false' AND r->>'completed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'REPLAY_RETURN_REFUSED';END IF;n:=n+1;
 END LOOP;
 IF n<>30 OR native_original_assert.financial_sets() IS DISTINCT FROM before_money OR native_original_assert.accepted_sets() IS DISTINCT FROM before_accept THEN RAISE EXCEPTION 'ALL18_REPLAY_CHANGED_DURABLE_OR_FINANCIAL_SET';END IF;
 RAISE NOTICE 'PASS all30 resume replay preserves every accepted financial set, claim/result, original failed witnesses, F06 permit, history and seat/roster row';
END $replay$;
