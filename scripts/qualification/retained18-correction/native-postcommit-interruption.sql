CREATE FUNCTION native_original_assert.postcommit_fault() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
 IF NEW.post_commit_completed_at IS NOT NULL AND OLD.post_commit_completed_at IS NULL THEN RAISE EXCEPTION 'native postcommit response interrupted' USING ERRCODE='P7778';END IF;RETURN NEW;
END $f$;
DO $pending$
DECLARE s smarter_private.hand_submissions;l public.engine_tournament_leases;r jsonb;accepted_hash text;claim_hash text;before_money jsonb:=native_original_assert.financial_sets();
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions ORDER BY submission_id LIMIT 1;
 SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=(s.request#>>'{p_hand_row,tournament_id}')::uuid;
 BEGIN
  CREATE TRIGGER native_postcommit_fault BEFORE UPDATE OF post_commit_completed_at ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION native_original_assert.postcommit_fault();
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=l.tournament_id;
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id',l.tournament_id::text,true);
  PERFORM set_config('app.smarter_tournament_lease_generation',l.lease_generation::text,true);
  r:=public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);
  IF r->>'completed' IS DISTINCT FROM 'false' OR r->>'reason' IS DISTINCT FROM 'accepted_postcommit_pending'
   OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true'
   OR (SELECT count(*) FROM smarter_private.hand_submission_correction_claims WHERE submission_id=s.submission_id)<>1
   OR (SELECT count(*) FROM smarter_private.hand_submission_correction_results WHERE submission_id=s.submission_id AND result->>'success'='true')<>1
   OR (SELECT state FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number) IS DISTINCT FROM 'reserved'
   OR native_original_assert.financial_sets() IS DISTINCT FROM before_money THEN RAISE EXCEPTION 'ACCEPTED_POSTCOMMIT_INTERRUPTION_NOT_DURABLE';END IF;
  SELECT payload_hash INTO accepted_hash FROM public.hand_atomic_commits WHERE hand_id=s.submission_id AND post_commit_completed_at IS NULL;
  SELECT md5(to_jsonb(c)::text) INTO claim_hash FROM smarter_private.hand_submission_correction_claims c WHERE submission_id=s.submission_id;
  IF accepted_hash IS NULL THEN RAISE EXCEPTION 'ACCEPTED_ATOMIC_LOST';END IF;
  DROP TRIGGER native_postcommit_fault ON public.hand_atomic_commits;
  r:=public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);
  PERFORM native_original_assert.consumer_return(r,s.table_id,s.submission_id,s.hand_number,s.request_hash);
  IF r->>'financial_handoff' IS DISTINCT FROM 'false'
   OR (SELECT payload_hash FROM public.hand_atomic_commits WHERE hand_id=s.submission_id) IS DISTINCT FROM accepted_hash
   OR (SELECT md5(to_jsonb(c)::text) FROM smarter_private.hand_submission_correction_claims c WHERE submission_id=s.submission_id) IS DISTINCT FROM claim_hash
   OR (SELECT count(*) FROM smarter_private.hand_submission_correction_results WHERE submission_id=s.submission_id)<>1
   OR (SELECT state FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number) IS DISTINCT FROM 'accepted'
   OR native_original_assert.financial_sets() IS DISTINCT FROM before_money THEN RAISE EXCEPTION 'POSTCOMMIT_CONTINUATION_REEXECUTED_MONEY';END IF;
  RAISE EXCEPTION 'restore scoped interrupted postcommit fixture' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
 IF EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims) OR EXISTS(SELECT FROM public.hand_atomic_commits) OR native_original_assert.financial_sets() IS DISTINCT FROM before_money THEN RAISE EXCEPTION 'POSTCOMMIT_TRIAL_OUTER_RESTORE';END IF;
 RAISE NOTICE 'PASS interrupted postcommit keeps one accepted atomic/correction; existing accepted-receipt continuation completes F06/history/snapshot without another financial claim or money effect';
END $pending$;
