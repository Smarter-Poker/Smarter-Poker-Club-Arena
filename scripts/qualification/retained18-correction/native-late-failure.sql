CREATE FUNCTION native_original_assert.late_atomic_fault() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
 IF NOT EXISTS(SELECT FROM smarter_private.hand_submissions s CROSS JOIN LATERAL jsonb_array_elements(s.request->'p_stacks') x JOIN public.table_seats t ON t.id=(x->>'seat_id')::uuid WHERE s.submission_id=NEW.hand_id AND t.stack IS DISTINCT FROM (x->>'stack_before')::numeric) THEN RAISE EXCEPTION 'FAULT_NOT_AFTER_REAL_STACK_WRITE';END IF;
 RAISE EXCEPTION 'native late failure after actual stack settlement' USING ERRCODE='P7777';
END $f$;
DO $failure$
DECLARE s smarter_private.hand_submissions;l public.engine_tournament_leases;r jsonb;before_money jsonb:=native_original_assert.financial_sets();old_hash text;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions ORDER BY submission_id LIMIT 1;
 SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=(s.request#>>'{p_hand_row,tournament_id}')::uuid;
 SELECT md5(to_jsonb(h)::text) INTO old_hash FROM smarter_private.hand_submission_handoff_results h WHERE h.submission_id=s.submission_id;
 BEGIN
  CREATE TRIGGER native_late_atomic_fault BEFORE INSERT ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION native_original_assert.late_atomic_fault();
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id=l.tournament_id;
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('app.smarter_data_actor','tournament-manager',true);
  PERFORM set_config('app.smarter_tournament_id',l.tournament_id::text,true);
  PERFORM set_config('app.smarter_tournament_lease_generation',l.lease_generation::text,true);
  r:=public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);
  IF r->>'completed' IS DISTINCT FROM 'false' OR r->>'reason' IS DISTINCT FROM 'successor_financial_refused'
   OR EXISTS(SELECT FROM public.hand_atomic_commits WHERE hand_id=s.submission_id)
   OR native_original_assert.financial_sets() IS DISTINCT FROM before_money
   OR (SELECT count(*) FROM smarter_private.hand_submission_correction_claims WHERE submission_id=s.submission_id)<>1
   OR (SELECT count(*) FROM smarter_private.hand_submission_correction_results WHERE submission_id=s.submission_id AND result->>'success'='false' AND result->>'atomic_hand_commit'='false')<>1
   OR (SELECT md5(to_jsonb(h)::text) FROM smarter_private.hand_submission_handoff_results h WHERE h.submission_id=s.submission_id) IS DISTINCT FROM old_hash THEN RAISE EXCEPTION 'REAL_LATE_FAILURE_NOT_ATOMIC';END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(s.request->'p_stacks') x JOIN public.table_seats t ON t.id=(x->>'seat_id')::uuid WHERE t.stack IS DISTINCT FROM (x->>'stack_before')::numeric) THEN RAISE EXCEPTION 'LATE_FAILURE_STACK_NOT_ROLLED_BACK';END IF;
  r:=public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);
  IF r->>'reason' IS DISTINCT FROM 'successor_financial_claim_spent' THEN RAISE EXCEPTION 'REFUSED_CORRECTION_RETRIED';END IF;
  RAISE EXCEPTION 'restore isolated late failure' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
 IF EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims) OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_results) OR native_original_assert.financial_sets() IS DISTINCT FROM before_money THEN RAISE EXCEPTION 'FAULT_TRIAL_OUTER_RESTORE';END IF;
 RAISE NOTICE 'PASS actual late stack-write fault rolls financial work back, retains one correction refusal, refuses another correction attempt and preserves original failed witness';
END $failure$;
