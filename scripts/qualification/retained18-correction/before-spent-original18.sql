DO $before$
DECLARE s record;l public.engine_tournament_leases;r jsonb;n integer:=0;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 FOR s IN SELECT j.*, (j.request#>>'{p_hand_row,tournament_id}')::uuid tour FROM smarter_private.hand_submissions j JOIN smarter_private.hand_submission_handoff_results z USING(submission_id) WHERE z.result->>'error'='diamond_jackpot_wrong_hand_scope' ORDER BY j.submission_id LOOP
  SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=s.tour;
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=s.tour;
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id',s.tour::text,true);
  PERFORM set_config('app.smarter_tournament_lease_generation',l.lease_generation::text,true);
  r:=public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);
  IF r->>'reason' IS DISTINCT FROM 'successor_financial_claim_spent' THEN RAISE EXCEPTION 'ORIGINAL30_SPENT_BEFORE_REFUSAL_MISSING hand%',s.hand_number;END IF;n:=n+1;
 END LOOP;
 IF n IS DISTINCT FROM 30 THEN RAISE EXCEPTION 'ORIGINAL30_BEFORE_CARDINALITY actual=%',n;END IF;
 RAISE NOTICE 'PASS actual30 existing source refuses already-spent original successor claims';
END $before$;
