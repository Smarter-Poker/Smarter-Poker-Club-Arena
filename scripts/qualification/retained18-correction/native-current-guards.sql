DO $guards$
DECLARE s smarter_private.hand_submissions;l public.engine_tournament_leases;e uuid;x jsonb;denied boolean;n text;before_money jsonb:=native_original_assert.financial_sets();
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions ORDER BY submission_id LIMIT 1;e:=s.submission_id;
 SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id=(s.request#>>'{p_hand_row,tournament_id}')::uuid;
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 denied:=false;BEGIN INSERT INTO smarter_private.hand_submission_correction_claims VALUES(e,'wrong',l.instance_id,l.lease_generation,txid_current(),clock_timestamp());EXCEPTION WHEN SQLSTATE '55000' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'WRONG_REQUEST_CLAIM_ACCEPTED';END IF;
 denied:=false;BEGIN INSERT INTO smarter_private.hand_submission_correction_results VALUES(e,jsonb_build_object('source_correction',true,'success',true,'atomic_hand_commit',true),clock_timestamp());EXCEPTION WHEN SQLSTATE '55000' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'NO_CLAIM_RESULT_ACCEPTED';END IF;
 BEGIN
  x:=s.request->'p_stacks'->0;
  UPDATE public.table_seats SET stack=stack+1 WHERE id=(x->>'seat_id')::uuid;
  IF smarter_private.original_hand_source_correction_proof(e) IS NOT NULL THEN RAISE EXCEPTION 'WRONG_BEFORE_STACK_PROOF_ACCEPTED';END IF;
  RAISE EXCEPTION 'restore native changed seat' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
 IF smarter_private.original_hand_source_correction_proof(e) IS NULL THEN RAISE EXCEPTION 'ORIGINAL_SEAT_RESTORATION_UNPROVEN';END IF;
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 denied:=false;BEGIN PERFORM public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);EXCEPTION WHEN SQLSTATE '42501' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'NONENGINE_RESUME_ACCEPTED';END IF;
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 BEGIN
  INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,enforce_freeze,ownership_token,updated_at)
  VALUES(true,'counting_down',clock_timestamp()-interval '1 minute',clock_timestamp(),clock_timestamp()+interval '5 minutes','native scoped freeze',true,gen_random_uuid(),clock_timestamp())
  ON CONFLICT(id) DO UPDATE SET phase=EXCLUDED.phase,announced_at=EXCLUDED.announced_at,break_started_at=EXCLUDED.break_started_at,break_ends_at=EXCLUDED.break_ends_at,enforce_freeze=true;
  IF public.fn_platform_frozen() IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACTUAL_FREEZE_NOT_ACTIVE';END IF;
  denied:=false;BEGIN PERFORM smarter_private.certify_original_hand_source_correction(e);EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'HAND_SOURCE_CORRECTION_FROZEN' THEN RAISE;END IF;denied:=true;END;
  IF NOT denied THEN RAISE EXCEPTION 'FROZEN_CERT_ACCEPTED';END IF;
  denied:=false;BEGIN PERFORM public.fn_ca_resume_hand_submission(s.table_id,l.instance_id,l.lease_generation);EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'HAND_SUBMISSION_PLATFORM_FROZEN' THEN RAISE;END IF;denied:=true;END;
  IF NOT denied THEN RAISE EXCEPTION 'FROZEN_RESUME_ACCEPTED';END IF;
  RAISE EXCEPTION 'restore scoped native freeze' USING ERRCODE='P9001';
 EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;END;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'NATIVE_FREEZE_RESTORE';END IF;
 IF native_original_assert.financial_sets() IS DISTINCT FROM before_money OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims) OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_results) THEN RAISE EXCEPTION 'GUARD_REFUSAL_LEFT_EFFECT';END IF;
 RAISE NOTICE 'PASS wrong original stack, request claim, missing claim result and nonengine authority refuse without financial footprint';
END $guards$;
