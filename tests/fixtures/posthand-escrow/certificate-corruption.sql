-- Isolated native corruption simulation, rolled back; no production trigger mutation.
DO $test$ DECLARE candidate text;BEGIN
 FOREACH candidate IN ARRAY ARRAY['wrong_accounting_sha','NULL_roster_sha','duplicate_pending_id'] LOOP
 BEGIN
  ALTER TABLE smarter_private.posthand_escrow_certificates DISABLE TRIGGER posthand_escrow_certificate_immutable;
  IF candidate='wrong_accounting_sha' THEN UPDATE smarter_private.posthand_escrow_certificates SET original=jsonb_set(original,'{original_accounting_evidence_sha256}',to_jsonb(repeat('0',64)));
  ELSIF candidate='NULL_roster_sha' THEN UPDATE smarter_private.posthand_escrow_certificates SET original=jsonb_set(original,'{original_participant_roster_sha256}','null');
  ELSE UPDATE smarter_private.posthand_escrow_certificates SET original=jsonb_set(original,'{pending_ids}',(original->'pending_ids')||(original->'pending_ids'));END IF;
  UPDATE smarter_private.posthand_escrow_certificates SET original_sha256=encode(extensions.digest(convert_to(original::text,'UTF8'),'sha256'),'hex');
  ALTER TABLE smarter_private.posthand_escrow_certificates ENABLE TRIGGER posthand_escrow_certificate_immutable;
  DELETE FROM hand_atomic_commits WHERE hand_number=31008564;
  IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' OR (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'corrupt original certificate admitted: %',candidate;END IF;
  RAISE EXCEPTION 'native rollback corruption' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS raw-absent original certificate % refuses despite recomputed container hash',candidate;END;
 END LOOP;
END $test$;
