DO $after$
DECLARE s record;l public.engine_tournament_leases;r jsonb;n integer:=0;
BEGIN
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 FOR s IN SELECT j.*, (j.request#>>'{p_hand_row,tournament_id}')::uuid tour FROM smarter_private.hand_submissions j JOIN smarter_private.hand_submission_source_corrections c USING(submission_id) ORDER BY j.submission_id LOOP
  IF EXISTS(SELECT FROM public.hand_atomic_commits a WHERE a.hand_id=s.submission_id AND a.post_commit_completed_at IS NOT NULL AND a.post_commit_result->>'ok'='true') THEN n:=n+1;CONTINUE;END IF;
  SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=s.tour;
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=s.tour;
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id',s.tour::text,true);
  PERFORM set_config('app.smarter_tournament_lease_generation',l.lease_generation::text,true);
  r:=public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);
  PERFORM native_original_assert.consumer_return(r,s.table_id,s.submission_id,s.hand_number,s.request_hash);
  IF r->>'completed' IS DISTINCT FROM 'true' OR r->>'post_commit_completed' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'ACTUAL30_CORRECTION_NOT_COMPLETED hand% reason% error%',s.hand_number,r->>'reason',coalesce(r->>'error',r#>>'{outcome,error}');END IF;n:=n+1;
 END LOOP;
 IF n IS DISTINCT FROM 30 OR (SELECT count(*) FROM smarter_private.hand_submission_correction_claims)<>30 OR (SELECT count(*) FROM smarter_private.hand_submission_correction_results WHERE result->>'success'='true')<>30 THEN RAISE EXCEPTION 'ACTUAL30_CORRECTION_CARDINALITY';END IF;
 IF EXISTS(SELECT FROM smarter_private.hand_submission_handoff_results WHERE result->>'error' IS DISTINCT FROM 'diamond_jackpot_wrong_hand_scope') THEN RAISE EXCEPTION 'ORIGINAL30_RESULT_CHANGED';END IF;
 RAISE NOTICE 'PASS actual30 original retained hand corrected once with accepted atomic and completed postcommit';
END $after$;
