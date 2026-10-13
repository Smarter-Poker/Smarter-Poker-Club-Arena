DO $negative$
DECLARE e uuid;v jsonb;denied boolean;
BEGIN
 SELECT submission_id INTO e FROM smarter_private.hand_submissions ORDER BY submission_id LIMIT 1;
 IF smarter_private.original_hand_source_correction_proof('ffffffff-ffff-ffff-ffff-ffffffffffff') IS NOT NULL THEN RAISE EXCEPTION 'EXTRA19_PROOF_ACCEPTED';END IF;
 denied:=false;BEGIN PERFORM smarter_private.certify_original_hand_source_correction('ffffffff-ffff-ffff-ffff-ffffffffffff');EXCEPTION WHEN SQLSTATE '55000' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'EXTRA19_CERT_ACCEPTED';END IF;
 v:=smarter_private.original_hand_source_correction_proof(e);
 denied:=false;BEGIN INSERT INTO smarter_private.hand_submission_source_corrections VALUES(e,v||jsonb_build_object('request_hash','forged'),clock_timestamp());EXCEPTION WHEN SQLSTATE '55000' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'FORGED_CANONICAL_CERT_ACCEPTED';END IF;
 ALTER TABLE public.hand_atomic_commits DISABLE TRIGGER poker_diamond_jackpot_accept_hand;
 IF smarter_private.original_hand_source_correction_proof(e) IS NOT NULL THEN RAISE EXCEPTION 'DISABLED_SOURCE_TRIGGER_ACCEPTED';END IF;
 ALTER TABLE public.hand_atomic_commits ENABLE TRIGGER poker_diamond_jackpot_accept_hand;
 IF smarter_private.original_hand_source_correction_proof(e) IS DISTINCT FROM v THEN RAISE EXCEPTION 'SOURCE_TRIGGER_RESTORATION_MISMATCH';END IF;
 RAISE NOTICE 'PASS closed18 extra19, forged certificate and disabled original trigger refusals';
END $negative$;
