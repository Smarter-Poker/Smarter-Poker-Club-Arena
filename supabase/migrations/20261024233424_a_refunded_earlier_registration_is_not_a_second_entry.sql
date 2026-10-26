-- 20261024233030_a_refunded_earlier_registration_is_not_a_second_entry.sql
-- Changes ONE reader, smarter_private.f06_movement_never_dealt_prior: a
-- receipt observed before the current registration began belongs to an
-- earlier (refunded) registration and is not counted as a second entry.
-- Writes no row and moves no chip. Full rationale in the repository file.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $refunded_registration_is_not_a_second_entry$
DECLARE
  v_proc regprocedure := 'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure;
  v_pre text;
  v_post text;
  v_old text := E' OR (SELECT count(*) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament\n AND (f.registration_id=registration.id OR f.user_id=registration.user_id))<>1\n';
  v_new text := E' OR (SELECT count(*) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament\n AND (f.registration_id=registration.id OR (f.user_id=registration.user_id AND f.observed_at>=registration.registered_at)))<>1\n';
BEGIN
  v_pre := pg_get_functiondef(v_proc);
  IF md5(v_pre) IS DISTINCT FROM '1952ea35ef547fd1102a4eca7ae1427e' THEN
    RAISE EXCEPTION 'PREIMAGE_MISMATCH: f06_movement_never_dealt_prior is not the definition this migration was written against (md5 %)', md5(v_pre)
      USING ERRCODE = '55000';
  END IF;
  IF (length(v_pre) - length(replace(v_pre, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'PREIMAGE_PASSAGE: the receipt-count passage does not appear exactly once'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE replace(v_pre, v_old, v_new);

  v_post := pg_get_functiondef(v_proc);
  IF v_post IS DISTINCT FROM replace(v_pre, v_old, v_new) THEN
    RAISE EXCEPTION 'POSTIMAGE_MISMATCH: installed definition is not the pre-image with exactly this passage replaced'
      USING ERRCODE = '55000';
  END IF;
  IF replace(v_post, v_new, v_old) IS DISTINCT FROM v_pre THEN
    RAISE EXCEPTION 'POSTIMAGE_NOT_REVERSIBLE' USING ERRCODE = '55000';
  END IF;
END
$refunded_registration_is_not_a_second_entry$;

COMMIT;