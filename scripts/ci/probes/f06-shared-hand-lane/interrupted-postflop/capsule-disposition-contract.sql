-- Qualification-only exact capsule tables/assertion/guards from the owning continuation candidate.
CREATE TABLE smarter_private.hand_continuations (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL CHECK (hand_number > 0),
  tournament_id uuid NOT NULL,
  permit_id uuid NOT NULL UNIQUE,
  original_generation uuid NOT NULL,
  writer_generation uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  payload text NOT NULL CHECK (octet_length(payload) <= 1048576),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number)
);
ALTER TABLE smarter_private.hand_continuations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_continuations FROM PUBLIC, anon, authenticated, service_role;
CREATE UNIQUE INDEX hand_continuation_one_open ON smarter_private.hand_continuations (table_id);

-- A unique disposition fence, rather than an EXISTS-only trigger, also
-- refuses an abort/closer whose repeatable-read snapshot predates retention.
CREATE TABLE smarter_private.hand_continuation_dispositions (
  table_id uuid NOT NULL, hand_number bigint NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('retained', 'disposed')),
  PRIMARY KEY (table_id, hand_number)
);
ALTER TABLE smarter_private.hand_continuation_dispositions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_continuation_dispositions FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION smarter_private.assert_hand_continuation_disposition(tab uuid, hn bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE d text;
BEGIN
  INSERT INTO smarter_private.hand_continuation_dispositions(table_id, hand_number, disposition)
    VALUES(tab, hn, 'disposed') ON CONFLICT(table_id, hand_number) DO NOTHING;
  SELECT disposition INTO STRICT d FROM smarter_private.hand_continuation_dispositions
   WHERE table_id = tab AND hand_number = hn;
  IF d <> 'disposed' THEN RAISE EXCEPTION 'HAND_CONTINUATION_UNSETTLED' USING ERRCODE = '55000'; END IF;
END $body$;
CREATE OR REPLACE FUNCTION smarter_private.f06_retained_submission_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NEW.state = 'accepted' AND EXISTS (SELECT 1 FROM smarter_private.hand_continuations c WHERE c.permit_id = NEW.permit_id) THEN
  IF NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id = NEW.table_id
    AND a.hand_number = NEW.hand_number AND a.hand_id = NEW.evidence_id AND a.post_commit_completed_at IS NOT NULL) THEN
   RAISE EXCEPTION 'HAND_CONTINUATION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000';
  END IF;
  -- Positive atomic acceptance owns cleanup; no periodic private-deck retention.
  DELETE FROM smarter_private.hand_continuations WHERE permit_id = NEW.permit_id;
 END IF;
 IF NEW.state NOT IN ('never_started','aborted_unsettled') THEN RETURN NEW; END IF;
 PERFORM smarter_private.assert_hand_continuation_disposition(NEW.table_id, NEW.hand_number);
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,NEW.permit_id,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' OR (d.permit_id IS NOT NULL AND d.permit_id IS DISTINCT FROM NEW.permit_id) THEN
  RAISE EXCEPTION 'F06_RETAINED_HAND_SUBMISSION_REQUIRES_ACCEPTED_DISPOSITION' USING ERRCODE='55000';
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
 PERFORM smarter_private.assert_hand_continuation_disposition(NEW.table_id, NEW.hand_number);
 IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
   WHERE dd.table_id=NEW.table_id AND dd.hand_number=NEW.hand_number) THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_REQUIRED_FOR_COMPLETION' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.assert_hand_continuation_disposition(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.f06_retained_submission_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.hand_submission_snapshot_guard() FROM PUBLIC,anon,authenticated,service_role;
