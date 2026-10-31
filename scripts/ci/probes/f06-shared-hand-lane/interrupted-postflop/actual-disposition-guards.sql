CREATE OR REPLACE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE t uuid;
BEGIN
 -- Resolve the table even before BEGIN is visible; an absent permit cannot
 -- let an already-started writer cross cancellation's exclusive lane.
 SELECT tournament_id INTO t FROM public.tables WHERE id=NEW.table_id;
 IF t IS NOT NULL THEN
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='55P03'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_prepared_hand_cancellations
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_no_start_continuations
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_CANCELLED_PREPARATION_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.hand_submission_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NOT NEW.is_complete THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=NEW.table_id
   AND a.hand_number=NEW.hand_number AND a.hand_id IS NOT NULL AND a.post_commit_payload IS NOT NULL) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
   WHERE dd.table_id=NEW.table_id AND dd.hand_number=NEW.hand_number) THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_REQUIRED_FOR_COMPLETION' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
CREATE FUNCTION smarter_private.f06_retained_submission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NEW.state NOT IN ('never_started','aborted_unsettled') THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,NEW.permit_id,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' OR (d.permit_id IS NOT NULL AND d.permit_id IS DISTINCT FROM NEW.permit_id) THEN
  RAISE EXCEPTION 'F06_RETAINED_HAND_SUBMISSION_REQUIRES_ACCEPTED_DISPOSITION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.f06_immutable_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'F06_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(OLD)->>'state')='withdrawn_before_manifest' THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND (to_jsonb(NEW)->>'state')='aborted_unsettled' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid
 AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(NEW)->>'state')='withdrawn_before_manifest' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_no_start_continuations a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.original_generation=(to_jsonb(NEW)->>'origin_generation')::uuid
 AND a.park=(to_jsonb(OLD))
 AND (to_jsonb(NEW)-'state'-'abort_receipt_id')=(to_jsonb(OLD)-'state'-'abort_receipt_id')) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND ((to_jsonb(OLD)-'state'-'evidence_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'evidence_id') OR to_jsonb(OLD)->>'state'<>'reserved') THEN
 RAISE EXCEPTION 'F06_HAND_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_members' OR
 (TG_TABLE_NAME='f06_attempts' AND ((to_jsonb(OLD)-'state'-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'receipt') OR to_jsonb(OLD)->>'state'<>'active')) OR
 (TG_TABLE_NAME='f06_operations' AND ((to_jsonb(OLD)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') OR (to_jsonb(OLD)->'manifest'<>'null'::jsonb AND to_jsonb(OLD)->'manifest' IS DISTINCT FROM to_jsonb(NEW)->'manifest') OR (to_jsonb(OLD)->'close_receipt'<>'null'::jsonb AND to_jsonb(OLD)->'close_receipt' IS DISTINCT FROM to_jsonb(NEW)->'close_receipt'))) THEN
 RAISE EXCEPTION 'F06_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
CREATE FUNCTION smarter_private.f06_mixed_preparation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
BEGIN
 IF NEW.state='reserved' AND EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers c
 WHERE c.tournament_id=NEW.tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions done WHERE done.transfer_id=c.transfer_id))
 THEN RAISE EXCEPTION 'F06_MIXED_CUSTODY_ONLY'; END IF;
 RETURN NEW;
END $$;
