-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908161356; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908161356   (the stamp IS the apply time, UTC: 2026-09-08 16:13:56)
--   name        training_attempt_decision_delivery_authority_phase6_pr_a
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 84096 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908161356 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        training_attempt_decision_slots_immutable_v1, training_delivery_authority_cutover_immutable_v1, training_delivery_authority_attestations_immutable_v1, training_answers_00_lock_attempt_delivery_v1
--     FUNCTION       public.fn_training_reject_decision_slot_update_v1, public.fn_training_reject_delivery_cutover_mutation_v1, public.fn_training_lock_answer_attempt_v1, public.fn_training_register_continuation_slot_v1, public.fn_training_authorize_attempt_decision_v1, public.fn_training_promote_legacy_signed_decision_v1, public.fn_training_attempt_record_served_batch_v1, public.fn_training_grade_delivered_policy_v1
--     TABLE          public.training_attempt_decision_slots, public.training_delivery_authority_cutover, public.training_delivery_authority_attestations
--     INDEX          training_attempt_decision_slots_snapshot_idx
--     DROP           TRIGGER training_attempt_decision_slots_immutable_v1, TRIGGER training_delivery_authority_cutover_immutable_v1, TRIGGER training_delivery_authority_attestations_immutable_v1, TRIGGER training_answers_00_lock_attempt_delivery_v1
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Seal every delivered decision to one attempt/hand/decision slot. Initial
-- decisions are owned by training_attempt_hands; later streets use the
-- continuation table below. Stable served receipts keep those immutable
-- snapshots answerable after the mutable cache is refreshed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.training_attempt_decision_slots (
  attempt_id uuid NOT NULL REFERENCES public.training_attempts(id) ON DELETE CASCADE,
  hand_ordinal smallint NOT NULL,
  decision_ordinal smallint NOT NULL,
  snapshot_key text NOT NULL REFERENCES public.training_question_snapshots(snapshot_key) ON DELETE RESTRICT,
  parent_snapshot_key text NOT NULL REFERENCES public.training_question_snapshots(snapshot_key) ON DELETE RESTRICT,
  parent_submission_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, hand_ordinal, decision_ordinal),
  FOREIGN KEY (attempt_id, hand_ordinal)
    REFERENCES public.training_attempt_hands(attempt_id, hand_ordinal) ON DELETE CASCADE,
  CONSTRAINT training_attempt_decision_slots_decision_check CHECK (decision_ordinal BETWEEN 2 AND 8),
  CONSTRAINT training_attempt_decision_slots_parent_submission_check
    CHECK (char_length(parent_submission_id) BETWEEN 1 AND 180),
  CONSTRAINT training_attempt_decision_slots_child_parent_check
    CHECK (snapshot_key <> parent_snapshot_key)
);

CREATE INDEX IF NOT EXISTS training_attempt_decision_slots_snapshot_idx
  ON public.training_attempt_decision_slots(snapshot_key);

ALTER TABLE public.training_attempt_decision_slots ENABLE ROW LEVEL SECURITY;
-- Supabase production grants service_role broad default privileges on new
-- public tables. Remove that deployment-time ACL before restoring read-only
-- access to the immutable continuation registry.
REVOKE ALL ON public.training_attempt_decision_slots
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.training_attempt_decision_slots TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.training_attempt_decision_slots FROM service_role;

CREATE OR REPLACE FUNCTION public.fn_training_reject_decision_slot_update_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_CONTINUATION_SLOT_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS training_attempt_decision_slots_immutable_v1
  ON public.training_attempt_decision_slots;
CREATE TRIGGER training_attempt_decision_slots_immutable_v1
  BEFORE UPDATE ON public.training_attempt_decision_slots
  FOR EACH ROW EXECUTE FUNCTION public.fn_training_reject_decision_slot_update_v1();

-- The predecessor release wrote a random request key before it created the
-- attempt, so there is no truthful migration-time join from that event to an
-- attempt slot. Preserve rolling-deploy sessions through a deliberately
-- bounded compatibility window instead. The service may promote a legacy
-- event only after the API has verified the still-live HMAC receipt; the RPC
-- independently requires the exact old random-key event, manifest snapshot,
-- owner, checksum, receipt timestamps, and (for continuations) prior answer.
CREATE TABLE IF NOT EXISTS public.training_delivery_authority_cutover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  applied_at timestamptz NOT NULL,
  legacy_accept_until timestamptz NOT NULL,
  CONSTRAINT training_delivery_authority_cutover_window_check
    CHECK (legacy_accept_until > applied_at)
);

ALTER TABLE public.training_delivery_authority_cutover ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_delivery_authority_cutover FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_training_reject_delivery_cutover_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_DELIVERY_AUTHORITY_CUTOVER_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS training_delivery_authority_cutover_immutable_v1
  ON public.training_delivery_authority_cutover;
CREATE TRIGGER training_delivery_authority_cutover_immutable_v1
  BEFORE UPDATE OR DELETE ON public.training_delivery_authority_cutover
  FOR EACH ROW EXECUTE FUNCTION public.fn_training_reject_delivery_cutover_mutation_v1();

-- This expansion remains rollback-compatible indefinitely: it does not change
-- the answer validator. The first new attempt-scoped served event records an
-- append-only deployment attestation for the later protected contract PR's
-- production gate. Legacy promotion deliberately cannot write this proof.
CREATE TABLE IF NOT EXISTS public.training_delivery_authority_attestations (
  contract_version text PRIMARY KEY,
  first_attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence_event_key text NOT NULL,
  evidence_kind text NOT NULL,
  CONSTRAINT training_delivery_authority_attestation_version_check
    CHECK (contract_version = 'training-attempt-decision-authority-v1'),
  CONSTRAINT training_delivery_authority_attestation_event_check
    CHECK (char_length(evidence_event_key) BETWEEN 1 AND 260),
  CONSTRAINT training_delivery_authority_attestation_kind_check
    CHECK (evidence_kind = 'attempt_scoped_serve')
);

-- CREATE TABLE/INDEX IF NOT EXISTS must never accept a same-named object with
-- weaker authority semantics. Check the complete physical contract before any
-- serving function is installed or any table is treated as immutable.
DO $assert_delivery_authority_shapes$
DECLARE
  slots_oid pg_catalog.oid := pg_catalog.to_regclass(
    'public.training_attempt_decision_slots'
  );
  cutover_oid pg_catalog.oid := pg_catalog.to_regclass(
    'public.training_delivery_authority_cutover'
  );
  attestations_oid pg_catalog.oid := pg_catalog.to_regclass(
    'public.training_delivery_authority_attestations'
  );
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class
       WHERE oid = slots_oid AND relkind = 'r'
     )
     OR (
       SELECT count(*) FROM pg_catalog.pg_attribute
       WHERE attrelid = slots_oid AND attnum > 0 AND NOT attisdropped
     ) <> 7
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('attempt_id', 1, 'uuid', true, NULL::text),
         ('hand_ordinal', 2, 'smallint', true, NULL::text),
         ('decision_ordinal', 3, 'smallint', true, NULL::text),
         ('snapshot_key', 4, 'text', true, NULL::text),
         ('parent_snapshot_key', 5, 'text', true, NULL::text),
         ('parent_submission_id', 6, 'text', true, NULL::text),
         ('created_at', 7, 'timestamp with time zone', true, 'now()'::text)
       ) expected(attname, attnum, type_name, not_null, default_expr)
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = slots_oid
        AND actual.attname = expected.attname
        AND actual.attnum = expected.attnum
        AND NOT actual.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef default_row
         ON default_row.adrelid = actual.attrelid
        AND default_row.adnum = actual.attnum
       WHERE actual.attname IS NULL
          OR pg_catalog.format_type(actual.atttypid, actual.atttypmod)
             IS DISTINCT FROM expected.type_name
          OR actual.attnotnull IS DISTINCT FROM expected.not_null
          OR pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
             IS DISTINCT FROM expected.default_expr
     )
     OR (SELECT count(*) FROM pg_catalog.pg_constraint
         WHERE conrelid = slots_oid) <> 8
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = slots_oid AND contype = 'p' AND convalidated
         AND NOT condeferrable AND NOT condeferred
         AND conkey = ARRAY[1, 2, 3]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = slots_oid AND contype = 'f' AND convalidated
         AND conkey = ARRAY[1]::smallint[]
         AND confrelid = 'public.training_attempts'::pg_catalog.regclass
         AND confkey = ARRAY[
           (SELECT attnum FROM pg_catalog.pg_attribute
            WHERE attrelid = 'public.training_attempts'::pg_catalog.regclass
              AND attname = 'id')
         ]::smallint[]
         AND confupdtype = 'a' AND confdeltype = 'c' AND confmatchtype = 's'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = slots_oid AND contype = 'f' AND convalidated
         AND conkey = ARRAY[4]::smallint[]
         AND confrelid = 'public.training_question_snapshots'::pg_catalog.regclass
         AND confkey = ARRAY[
           (SELECT attnum FROM pg_catalog.pg_attribute
            WHERE attrelid = 'public.training_question_snapshots'::pg_catalog.regclass
              AND attname = 'snapshot_key')
         ]::smallint[]
         AND confupdtype = 'a' AND confdeltype = 'r' AND confmatchtype = 's'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = slots_oid AND contype = 'f' AND convalidated
         AND conkey = ARRAY[5]::smallint[]
         AND confrelid = 'public.training_question_snapshots'::pg_catalog.regclass
         AND confkey = ARRAY[
           (SELECT attnum FROM pg_catalog.pg_attribute
            WHERE attrelid = 'public.training_question_snapshots'::pg_catalog.regclass
              AND attname = 'snapshot_key')
         ]::smallint[]
         AND confupdtype = 'a' AND confdeltype = 'r' AND confmatchtype = 's'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = slots_oid AND contype = 'f' AND convalidated
         AND conkey = ARRAY[1, 2]::smallint[]
         AND confrelid = 'public.training_attempt_hands'::pg_catalog.regclass
         AND confkey = ARRAY[
           (SELECT attnum FROM pg_catalog.pg_attribute
            WHERE attrelid = 'public.training_attempt_hands'::pg_catalog.regclass
              AND attname = 'attempt_id'),
           (SELECT attnum FROM pg_catalog.pg_attribute
            WHERE attrelid = 'public.training_attempt_hands'::pg_catalog.regclass
              AND attname = 'hand_ordinal')
         ]::smallint[]
         AND confupdtype = 'a' AND confdeltype = 'c' AND confmatchtype = 's'
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('training_attempt_decision_slots_decision_check',
          '((decision_ordinal >= 2) AND (decision_ordinal <= 8))'),
         ('training_attempt_decision_slots_parent_submission_check',
          '((char_length(parent_submission_id) >= 1) AND (char_length(parent_submission_id) <= 180))'),
         ('training_attempt_decision_slots_child_parent_check',
          '(snapshot_key <> parent_snapshot_key)')
       ) expected(conname, expression)
       LEFT JOIN pg_catalog.pg_constraint actual
         ON actual.conrelid = slots_oid
        AND actual.conname = expected.conname
        AND actual.contype = 'c'
       WHERE actual.oid IS NULL
          OR NOT actual.convalidated
          OR pg_catalog.pg_get_expr(actual.conbin, actual.conrelid)
             IS DISTINCT FROM expected.expression
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_index index_row
       JOIN pg_catalog.pg_class index_class
         ON index_class.oid = index_row.indexrelid
       JOIN pg_catalog.pg_am access_method
         ON access_method.oid = index_class.relam
       WHERE index_row.indexrelid = pg_catalog.to_regclass(
               'public.training_attempt_decision_slots_snapshot_idx'
             )
         AND index_row.indrelid = slots_oid
         AND access_method.amname = 'btree'
         AND index_row.indisvalid AND index_row.indisready
         AND NOT index_row.indisunique
         AND index_row.indpred IS NULL AND index_row.indexprs IS NULL
         AND index_row.indnkeyatts = 1 AND index_row.indnatts = 1
         -- int2vector values use a zero lower array bound, so direct array
         -- equality with ARRAY[4] (whose lower bound is one) is false even
         -- when the indexed attribute is correct.
         AND index_row.indkey[0] = 4
     ) THEN
    RAISE EXCEPTION 'TRAINING_CONTINUATION_SLOT_TABLE_SHAPE_INVALID';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class
       WHERE oid = cutover_oid AND relkind = 'r'
     )
     OR (
       SELECT count(*) FROM pg_catalog.pg_attribute
       WHERE attrelid = cutover_oid AND attnum > 0 AND NOT attisdropped
     ) <> 3
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('singleton', 1, 'boolean', true, 'true'::text),
         ('applied_at', 2, 'timestamp with time zone', true, NULL::text),
         ('legacy_accept_until', 3, 'timestamp with time zone', true, NULL::text)
       ) expected(attname, attnum, type_name, not_null, default_expr)
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = cutover_oid
        AND actual.attname = expected.attname
        AND actual.attnum = expected.attnum
        AND NOT actual.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef default_row
         ON default_row.adrelid = actual.attrelid
        AND default_row.adnum = actual.attnum
       WHERE actual.attname IS NULL
          OR pg_catalog.format_type(actual.atttypid, actual.atttypmod)
             IS DISTINCT FROM expected.type_name
          OR actual.attnotnull IS DISTINCT FROM expected.not_null
          OR pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
             IS DISTINCT FROM expected.default_expr
     )
     OR (SELECT count(*) FROM pg_catalog.pg_constraint
         WHERE conrelid = cutover_oid) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = cutover_oid AND contype = 'p' AND convalidated
         AND NOT condeferrable AND NOT condeferred
         AND conkey = ARRAY[1]::smallint[]
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('training_delivery_authority_cutover_singleton_check', 'singleton'),
         ('training_delivery_authority_cutover_window_check',
          '(legacy_accept_until > applied_at)')
       ) expected(conname, expression)
       LEFT JOIN pg_catalog.pg_constraint actual
         ON actual.conrelid = cutover_oid
        AND actual.conname = expected.conname
        AND actual.contype = 'c'
       WHERE actual.oid IS NULL
          OR NOT actual.convalidated
          OR pg_catalog.pg_get_expr(actual.conbin, actual.conrelid)
             IS DISTINCT FROM expected.expression
     ) THEN
    RAISE EXCEPTION 'TRAINING_DELIVERY_AUTHORITY_CUTOVER_TABLE_SHAPE_INVALID';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class
       WHERE oid = attestations_oid AND relkind = 'r'
     )
     OR (
       SELECT count(*) FROM pg_catalog.pg_attribute
       WHERE attrelid = attestations_oid AND attnum > 0 AND NOT attisdropped
     ) <> 4
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('contract_version', 1, 'text', true, NULL::text),
         ('first_attested_at', 2, 'timestamp with time zone', true,
          'clock_timestamp()'::text),
         ('evidence_event_key', 3, 'text', true, NULL::text),
         ('evidence_kind', 4, 'text', true, NULL::text)
       ) expected(attname, attnum, type_name, not_null, default_expr)
       LEFT JOIN pg_catalog.pg_attribute actual
         ON actual.attrelid = attestations_oid
        AND actual.attname = expected.attname
        AND actual.attnum = expected.attnum
        AND NOT actual.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef default_row
         ON default_row.adrelid = actual.attrelid
        AND default_row.adnum = actual.attnum
       WHERE actual.attname IS NULL
          OR pg_catalog.format_type(actual.atttypid, actual.atttypmod)
             IS DISTINCT FROM expected.type_name
          OR actual.attnotnull IS DISTINCT FROM expected.not_null
          OR pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
             IS DISTINCT FROM expected.default_expr
     )
     OR (SELECT count(*) FROM pg_catalog.pg_constraint
         WHERE conrelid = attestations_oid) <> 4
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = attestations_oid AND contype = 'p' AND convalidated
         AND NOT condeferrable AND NOT condeferred
         AND conkey = ARRAY[1]::smallint[]
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('training_delivery_authority_attestation_version_check',
          '(contract_version = ''training-attempt-decision-authority-v1''::text)'),
         ('training_delivery_authority_attestation_event_check',
          '((char_length(evidence_event_key) >= 1) AND (char_length(evidence_event_key) <= 260))'),
         ('training_delivery_authority_attestation_kind_check',
          '(evidence_kind = ''attempt_scoped_serve''::text)')
       ) expected(conname, expression)
       LEFT JOIN pg_catalog.pg_constraint actual
         ON actual.conrelid = attestations_oid
        AND actual.conname = expected.conname
        AND actual.contype = 'c'
       WHERE actual.oid IS NULL
          OR NOT actual.convalidated
          OR pg_catalog.pg_get_expr(actual.conbin, actual.conrelid)
             IS DISTINCT FROM expected.expression
     ) THEN
    RAISE EXCEPTION 'TRAINING_DELIVERY_AUTHORITY_ATTESTATION_TABLE_SHAPE_INVALID';
  END IF;
END;
$assert_delivery_authority_shapes$;

-- ON CONFLICT cannot use DEFERRABLE primary/unique constraints. Validate the
-- cutover singleton before its first idempotent insert, then validate the
-- predecessor event arbiter used by both serve paths before installing them.
INSERT INTO public.training_delivery_authority_cutover (
  singleton, applied_at, legacy_accept_until
) VALUES (
  true, clock_timestamp(), clock_timestamp() + interval '7 days'
)
ON CONFLICT (singleton) DO NOTHING;

DO $assert_training_question_event_arbiter$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid =
          'public.training_question_events'::pg_catalog.regclass
      AND constraint_row.contype IN ('p', 'u')
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (SELECT attribute_row.attnum
         FROM pg_catalog.pg_attribute attribute_row
         WHERE attribute_row.attrelid =
               'public.training_question_events'::pg_catalog.regclass
           AND attribute_row.attname = 'event_type'
           AND NOT attribute_row.attisdropped),
        (SELECT attribute_row.attnum
         FROM pg_catalog.pg_attribute attribute_row
         WHERE attribute_row.attrelid =
               'public.training_question_events'::pg_catalog.regclass
           AND attribute_row.attname = 'event_key'
           AND NOT attribute_row.attisdropped)
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'TRAINING_QUESTION_EVENT_CONFLICT_ARBITER_INVALID';
  END IF;
END;
$assert_training_question_event_arbiter$;

ALTER TABLE public.training_delivery_authority_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_delivery_authority_attestations
  FROM PUBLIC, anon, authenticated, service_role;

-- Table revokes do not remove independently granted column ACLs. Clear every
-- column grant as well so an idempotent deployment cannot inherit a partially
-- pre-created object's authority.
DO $revoke_delivery_authority_columns$
DECLARE
  table_name text;
  column_list text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'training_attempt_decision_slots',
    'training_delivery_authority_cutover',
    'training_delivery_authority_attestations'
  ]
  LOOP
    SELECT string_agg(quote_ident(attribute.attname), ',' ORDER BY attribute.attnum)
    INTO column_list
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format('public.%I', table_name)
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
    IF column_list IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',
        column_list,
        table_name
      );
    END IF;
  END LOOP;
END;
$revoke_delivery_authority_columns$;

DROP TRIGGER IF EXISTS training_delivery_authority_attestations_immutable_v1
  ON public.training_delivery_authority_attestations;
CREATE TRIGGER training_delivery_authority_attestations_immutable_v1
  BEFORE UPDATE OR DELETE ON public.training_delivery_authority_attestations
  FOR EACH ROW EXECUTE FUNCTION public.fn_training_reject_delivery_cutover_mutation_v1();

-- Serving and answering one attempt must share an incompatible lock. Without
-- this BEFORE INSERT boundary, the predecessor answer validator's FOR KEY
-- SHARE lock can interleave with a serve RPC's FOR SHARE lock after its
-- unanswered check but before its served-event insert. Trigger names of the
-- same timing/event fire lexically, so the 00 prefix guarantees this lock is
-- acquired before training_answers_validate_v2.
CREATE OR REPLACE FUNCTION public.fn_training_lock_answer_attempt_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.attempt_id IS NOT NULL THEN
    PERFORM 1
    FROM public.training_attempts attempts
    WHERE attempts.id = NEW.attempt_id
    FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS training_answers_00_lock_attempt_delivery_v1
  ON public.training_answers;
CREATE TRIGGER training_answers_00_lock_attempt_delivery_v1
  BEFORE INSERT ON public.training_answers
  FOR EACH ROW EXECUTE FUNCTION public.fn_training_lock_answer_attempt_v1();

CREATE OR REPLACE FUNCTION public.fn_training_register_continuation_slot_v1(
  p_attempt_id uuid,
  p_user_id uuid,
  p_hand_ordinal integer,
  p_decision_ordinal integer,
  p_snapshot_key text,
  p_parent_snapshot_key text,
  p_parent_submission_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt public.training_attempts%ROWTYPE;
  v_parent public.training_answers%ROWTYPE;
  v_candidate public.training_question_snapshots%ROWTYPE;
  v_winner public.training_attempt_decision_slots%ROWTYPE;
BEGIN
  IF p_attempt_id IS NULL
     OR p_user_id IS NULL
     OR coalesce(p_hand_ordinal, 0) NOT BETWEEN 1 AND 100
     OR coalesce(p_decision_ordinal, 0) NOT BETWEEN 2 AND 8
     OR nullif(btrim(p_snapshot_key), '') IS NULL
     OR nullif(btrim(p_parent_snapshot_key), '') IS NULL
     OR nullif(btrim(p_parent_submission_id), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TRAINING_CONTINUATION_SLOT_INPUT_INVALID';
  END IF;

  SELECT * INTO v_attempt FROM public.training_attempts
  WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_CONTINUATION_ATTEMPT_MISMATCH';
  END IF;
  IF v_attempt.status <> 'open' OR v_attempt.expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_ATTEMPT_NOT_OPEN';
  END IF;

  SELECT * INTO v_parent FROM public.training_answers
  WHERE user_id = p_user_id
    AND submission_id = p_parent_submission_id
    AND attempt_id = p_attempt_id
    AND hand_ordinal = p_hand_ordinal
    AND decision_ordinal = p_decision_ordinal - 1
    AND snapshot_key = p_parent_snapshot_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_CONTINUATION_PRECEDING_ANSWER_REQUIRED';
  END IF;

  SELECT * INTO v_candidate FROM public.training_question_snapshots
  WHERE snapshot_key = p_snapshot_key;
  IF NOT FOUND
     OR v_candidate.game_id <> v_attempt.game_id
     OR v_candidate.level <> v_attempt.level THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_CONTINUATION_SNAPSHOT_MISMATCH';
  END IF;

  INSERT INTO public.training_attempt_decision_slots (
    attempt_id, hand_ordinal, decision_ordinal, snapshot_key,
    parent_snapshot_key, parent_submission_id
  ) VALUES (
    p_attempt_id, p_hand_ordinal, p_decision_ordinal, p_snapshot_key,
    p_parent_snapshot_key, p_parent_submission_id
  ) ON CONFLICT (attempt_id, hand_ordinal, decision_ordinal) DO NOTHING;

  SELECT * INTO v_winner FROM public.training_attempt_decision_slots
  WHERE attempt_id = p_attempt_id
    AND hand_ordinal = p_hand_ordinal
    AND decision_ordinal = p_decision_ordinal;
  IF NOT FOUND OR v_winner.snapshot_key IS DISTINCT FROM p_snapshot_key THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_CONTINUATION_SLOT_SNAPSHOT_MISMATCH';
  END IF;
  IF v_winner.parent_snapshot_key IS DISTINCT FROM p_parent_snapshot_key
     OR v_winner.parent_submission_id <> p_parent_submission_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_CONTINUATION_SLOT_PARENT_MISMATCH';
  END IF;

  RETURN jsonb_build_object(
    'attemptId', v_winner.attempt_id,
    'handOrdinal', v_winner.hand_ordinal,
    'decisionOrdinal', v_winner.decision_ordinal,
    'snapshotKey', v_winner.snapshot_key,
    'parentSnapshotKey', v_winner.parent_snapshot_key,
    'parentSubmissionId', v_winner.parent_submission_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_training_authorize_attempt_decision_v1(
  p_attempt_id uuid,
  p_user_id uuid,
  p_hand_ordinal integer,
  p_decision_ordinal integer,
  p_snapshot_key text,
  p_question_id text,
  p_policy_checksum text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_expected_snapshot text;
  v_snapshot public.training_question_snapshots%ROWTYPE;
  v_event public.training_question_events%ROWTYPE;
  v_event_key text;
BEGIN
  IF p_attempt_id IS NULL
     OR p_user_id IS NULL
     OR coalesce(p_hand_ordinal, 0) NOT BETWEEN 1 AND 100
     OR coalesce(p_decision_ordinal, 0) NOT BETWEEN 1 AND 8
     OR coalesce(p_snapshot_key, '') !~ '^[0-9a-f]{64}$'
     OR nullif(btrim(p_question_id), '') IS NULL
     OR coalesce(p_policy_checksum, '') !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_DECISION_AUTHORITY_INPUT_INVALID');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.training_attempts a
    WHERE a.id = p_attempt_id
      AND a.user_id = p_user_id
      AND a.status = 'open'
      AND a.expires_at > now()
  ) THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_DECISION_ATTEMPT_MISMATCH');
  END IF;

  IF p_decision_ordinal = 1 THEN
    SELECT h.snapshot_key INTO v_expected_snapshot
    FROM public.training_attempt_hands h
    WHERE h.attempt_id = p_attempt_id AND h.hand_ordinal = p_hand_ordinal;
  ELSE
    SELECT s.snapshot_key INTO v_expected_snapshot
    FROM public.training_attempt_decision_slots s
    WHERE s.attempt_id = p_attempt_id
      AND s.hand_ordinal = p_hand_ordinal
      AND s.decision_ordinal = p_decision_ordinal;
  END IF;
  IF v_expected_snapshot IS NULL OR v_expected_snapshot <> p_snapshot_key THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_DECISION_SLOT_MISMATCH');
  END IF;

  SELECT * INTO v_snapshot FROM public.training_question_snapshots
  WHERE snapshot_key = p_snapshot_key;
  IF NOT FOUND
     OR v_snapshot.source_question_id <> p_question_id
     OR lower(coalesce(v_snapshot.question_data ->> 'policyChecksum', '')) <> lower(p_policy_checksum) THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_DECISION_SNAPSHOT_MISMATCH');
  END IF;

  v_event_key := 'training-attempt:' || p_attempt_id::text
    || ':hand:' || p_hand_ordinal::text || ':decision:' || p_decision_ordinal::text;
  SELECT * INTO v_event FROM public.training_question_events e
  WHERE e.event_type = 'served' AND e.event_key = v_event_key;
  IF NOT FOUND
     OR v_event.question_id <> p_question_id
     OR v_event.user_id IS DISTINCT FROM p_user_id
     OR v_event.policy_checksum <> lower(p_policy_checksum)
     OR v_event.metadata ->> 'snapshotKey' IS DISTINCT FROM p_snapshot_key
     OR v_event.metadata ->> 'attemptId' IS DISTINCT FROM p_attempt_id::text
     OR v_event.metadata ->> 'handOrdinal' IS DISTINCT FROM p_hand_ordinal::text
     OR v_event.metadata ->> 'decisionOrdinal' IS DISTINCT FROM p_decision_ordinal::text THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_DECISION_NOT_SERVED');
  END IF;
  RETURN jsonb_build_object('authorized', true, 'eventKey', v_event_key);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_training_promote_legacy_signed_decision_v1(
  p_attempt_id uuid,
  p_user_id uuid,
  p_hand_ordinal integer,
  p_decision_ordinal integer,
  p_snapshot_key text,
  p_question_id text,
  p_policy_checksum text,
  p_receipt_id text,
  p_receipt_issued_at bigint,
  p_receipt_expires_at bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_cutover public.training_delivery_authority_cutover%ROWTYPE;
  v_attempt public.training_attempts%ROWTYPE;
  v_hand public.training_attempt_hands%ROWTYPE;
  v_snapshot public.training_question_snapshots%ROWTYPE;
  v_parent public.training_answers%ROWTYPE;
  v_slot public.training_attempt_decision_slots%ROWTYPE;
  v_legacy_event public.training_question_events%ROWTYPE;
  v_replay_parent_answer public.training_answers%ROWTYPE;
  v_existing public.training_question_events%ROWTYPE;
  v_replay_parent_proof boolean := false;
  v_event_key text;
  v_issued_at timestamptz;
  v_expires_at timestamptz;
  v_inserted boolean := false;
BEGIN
  IF p_attempt_id IS NULL
     OR p_user_id IS NULL
     OR coalesce(p_hand_ordinal, 0) NOT BETWEEN 1 AND 100
     OR coalesce(p_decision_ordinal, 0) NOT BETWEEN 1 AND 8
     OR coalesce(p_snapshot_key, '') !~ '^[0-9a-f]{64}$'
     OR nullif(btrim(p_question_id), '') IS NULL
     OR coalesce(p_policy_checksum, '') !~ '^[0-9a-f]{64}$'
     -- Every predecessor receipt omitted receiptId and therefore used
     -- node:crypto randomUUID(). Stable training-attempt:* identifiers belong
     -- to the new delivery protocol and must never enter this compatibility
     -- path when their scoped serve receipt is absent.
     OR coalesce(p_receipt_id, '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR coalesce(p_receipt_issued_at, 0) <= 0
     OR coalesce(p_receipt_expires_at, 0) <= 0 THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_INPUT_INVALID');
  END IF;

  v_issued_at := to_timestamp(p_receipt_issued_at);
  v_expires_at := to_timestamp(p_receipt_expires_at);
  IF v_issued_at > clock_timestamp() + interval '60 seconds'
     OR v_expires_at <= clock_timestamp()
     OR v_expires_at < v_issued_at + interval '60 seconds'
     OR v_expires_at > v_issued_at + interval '24 hours' THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_RECEIPT_TIME_INVALID');
  END IF;

  SELECT * INTO v_cutover
  FROM public.training_delivery_authority_cutover
  WHERE singleton = true;
  IF NOT FOUND OR clock_timestamp() > v_cutover.legacy_accept_until THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_WINDOW_CLOSED');
  END IF;
  SELECT * INTO v_attempt
  FROM public.training_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_attempt.user_id IS DISTINCT FROM p_user_id
     OR v_attempt.status <> 'open'
     OR v_attempt.expires_at <= clock_timestamp()
     OR v_attempt.started_at > v_issued_at + interval '5 minutes' THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_ATTEMPT_MISMATCH');
  END IF;

  SELECT * INTO v_hand
  FROM public.training_attempt_hands
  WHERE attempt_id = p_attempt_id AND hand_ordinal = p_hand_ordinal;
  IF NOT FOUND OR v_hand.created_at > v_issued_at + interval '5 minutes' THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_HAND_MISMATCH');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.training_answers answer
    WHERE answer.attempt_id = p_attempt_id
      AND answer.hand_ordinal = p_hand_ordinal
      AND answer.decision_ordinal = p_decision_ordinal
  ) THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_ATTEMPT_DECISION_ALREADY_ANSWERED');
  END IF;

  SELECT * INTO v_snapshot
  FROM public.training_question_snapshots
  WHERE snapshot_key = p_snapshot_key;
  IF NOT FOUND
     OR v_snapshot.game_id IS DISTINCT FROM v_attempt.game_id
     OR v_snapshot.level IS DISTINCT FROM v_attempt.level
     OR v_snapshot.source_question_id IS DISTINCT FROM p_question_id
     OR lower(coalesce(v_snapshot.question_data ->> 'policyChecksum', ''))
       IS DISTINCT FROM lower(p_policy_checksum) THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_SNAPSHOT_MISMATCH');
  END IF;

  -- Direct predecessor routes used a bare randomUUID request key. The shared
  -- persistCanonicalTrainingQuestions helper appended :0 (and :1 for the
  -- second half of a 100-question batch). Accept only those exact historical
  -- shapes. Initial-decision recovery/reissue may sign the immutable manifest
  -- hours after its original event, so that event may correlate with either
  -- the signed receipt or the immutable hand registration. Continuations were
  -- always persisted immediately before signing and remain receipt-correlated.
  SELECT * INTO v_legacy_event
  FROM public.training_question_events e
  WHERE e.event_type = 'served'
    AND e.question_id = p_question_id
    AND e.user_id IS NOT DISTINCT FROM p_user_id
    AND e.policy_checksum = lower(p_policy_checksum)
    AND coalesce(e.metadata ->> 'requestKey', '')
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(:[01])?$'
    AND e.event_key = (e.metadata ->> 'requestKey') || ':'
      || encode(extensions.digest(e.question_id, 'sha256'), 'hex')
    AND (
      e.occurred_at BETWEEN v_issued_at - interval '15 minutes'
        AND v_issued_at + interval '15 minutes'
      OR (
        p_decision_ordinal = 1
        AND e.occurred_at BETWEEN v_hand.created_at - interval '15 minutes'
          AND v_hand.created_at + interval '15 minutes'
      )
    )
  ORDER BY least(
    abs(extract(epoch FROM (e.occurred_at - v_issued_at))),
    CASE WHEN p_decision_ordinal = 1
      THEN abs(extract(epoch FROM (e.occurred_at - v_hand.created_at)))
      ELSE 'Infinity'::double precision
    END
  ), e.event_key
  LIMIT 1;

  -- The predecessor replay branch created a new immutable replay attempt and
  -- signed it without writing a new served event. Do not fabricate one: the
  -- exact completed parent mistake is the durable replay eligibility proof.
  IF NOT FOUND
     AND p_decision_ordinal = 1
     AND v_attempt.session_kind = 'replay'
     AND v_attempt.practice_only IS TRUE
     AND v_attempt.parent_attempt_id IS NOT NULL THEN
    SELECT answer.* INTO v_replay_parent_answer
    FROM public.training_answers answer
    JOIN public.training_attempts parent ON parent.id = v_attempt.parent_attempt_id
    WHERE answer.attempt_id = parent.id
      AND answer.user_id = p_user_id
      AND answer.decision_ordinal = 1
      AND answer.snapshot_key = p_snapshot_key
      AND answer.question_id = p_question_id
      AND answer.is_correct IS FALSE
      AND parent.user_id = p_user_id
      AND parent.game_id = v_attempt.game_id
      AND parent.level = v_attempt.level
      AND parent.status = 'completed'
    ORDER BY answer.answered_at DESC, answer.id
    LIMIT 1;
    v_replay_parent_proof := FOUND;
  END IF;
  IF NOT FOUND AND v_replay_parent_proof IS NOT TRUE THEN
    RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_EVENT_MISSING');
  END IF;

  IF p_decision_ordinal = 1 THEN
    IF v_hand.snapshot_key IS DISTINCT FROM p_snapshot_key THEN
      RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_SLOT_MISMATCH');
    END IF;
  ELSE
    SELECT * INTO v_parent
    FROM public.training_answers
    WHERE attempt_id = p_attempt_id
      AND user_id = p_user_id
      AND hand_ordinal = p_hand_ordinal
      AND decision_ordinal = p_decision_ordinal - 1;
    IF NOT FOUND
       OR v_parent.snapshot_key IS NULL
       OR v_parent.snapshot_key = p_snapshot_key
       OR v_parent.submission_id IS NULL
       OR v_parent.answered_at > v_issued_at + interval '5 minutes' THEN
      RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_PARENT_MISMATCH');
    END IF;

    INSERT INTO public.training_attempt_decision_slots (
      attempt_id, hand_ordinal, decision_ordinal, snapshot_key,
      parent_snapshot_key, parent_submission_id, created_at
    ) VALUES (
      p_attempt_id, p_hand_ordinal, p_decision_ordinal, p_snapshot_key,
      v_parent.snapshot_key, v_parent.submission_id, v_issued_at
    ) ON CONFLICT (attempt_id, hand_ordinal, decision_ordinal) DO NOTHING;

    SELECT * INTO v_slot
    FROM public.training_attempt_decision_slots
    WHERE attempt_id = p_attempt_id
      AND hand_ordinal = p_hand_ordinal
      AND decision_ordinal = p_decision_ordinal;
    IF NOT FOUND
       OR v_slot.snapshot_key IS DISTINCT FROM p_snapshot_key
       OR v_slot.parent_snapshot_key IS DISTINCT FROM v_parent.snapshot_key
       OR v_slot.parent_submission_id IS DISTINCT FROM v_parent.submission_id THEN
      RETURN jsonb_build_object('authorized', false, 'code', 'TRAINING_LEGACY_PROMOTION_SLOT_MISMATCH');
    END IF;
  END IF;

  v_event_key := 'training-attempt:' || p_attempt_id::text
    || ':hand:' || p_hand_ordinal::text || ':decision:' || p_decision_ordinal::text;
  INSERT INTO public.training_question_events (
    event_type, event_key, question_id, user_id, is_correct,
    policy_checksum, metadata, occurred_at
  ) VALUES (
    'served', v_event_key, p_question_id, p_user_id, NULL,
    lower(p_policy_checksum),
    jsonb_strip_nulls(jsonb_build_object(
      'attemptId', p_attempt_id,
      'handOrdinal', p_hand_ordinal,
      'decisionOrdinal', p_decision_ordinal,
      'snapshotKey', p_snapshot_key,
      'legacySignedReceiptRecovery', true,
      'legacyReceiptId', p_receipt_id,
      'legacyReceiptIssuedAt', p_receipt_issued_at,
      'legacyReceiptExpiresAt', p_receipt_expires_at,
      'legacyProofKind', CASE WHEN v_replay_parent_proof
        THEN 'replay_parent_answer' ELSE 'predecessor_served_event' END,
      'migratedFromEventKey', CASE WHEN v_replay_parent_proof
        THEN NULL ELSE v_legacy_event.event_key END,
      'legacyReplayParentSubmissionId', CASE WHEN v_replay_parent_proof
        THEN v_replay_parent_answer.submission_id ELSE NULL END,
      'promotedAt', clock_timestamp()
    )),
    coalesce(v_legacy_event.occurred_at, v_hand.created_at)
  ) ON CONFLICT (event_type, event_key) DO NOTHING;
  v_inserted := FOUND;

  SELECT * INTO v_existing
  FROM public.training_question_events e
  WHERE e.event_type = 'served' AND e.event_key = v_event_key;
  IF NOT FOUND
     OR v_existing.question_id IS DISTINCT FROM p_question_id
     OR v_existing.user_id IS DISTINCT FROM p_user_id
     OR v_existing.policy_checksum IS DISTINCT FROM lower(p_policy_checksum)
     OR v_existing.metadata ->> 'snapshotKey' IS DISTINCT FROM p_snapshot_key
     OR v_existing.metadata ->> 'attemptId' IS DISTINCT FROM p_attempt_id::text
     OR v_existing.metadata ->> 'handOrdinal' IS DISTINCT FROM p_hand_ordinal::text
     OR v_existing.metadata ->> 'decisionOrdinal' IS DISTINCT FROM p_decision_ordinal::text THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_LEGACY_PROMOTION_EVENT_CONFLICT';
  END IF;

  RETURN jsonb_build_object(
    'authorized', true,
    'promoted', v_inserted,
    'eventKey', v_event_key
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_training_attempt_record_served_batch_v1(
  p_attempt_id uuid,
  p_user_id uuid,
  p_deliveries jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_delivery jsonb;
  v_attempt public.training_attempts%ROWTYPE;
  v_hand integer;
  v_decision integer;
  v_snapshot_key text;
  v_question_id text;
  v_checksum text;
  v_difficulty text;
  v_rng_rolls jsonb;
  v_expected_snapshot text;
  v_snapshot public.training_question_snapshots%ROWTYPE;
  v_existing public.training_question_events%ROWTYPE;
  v_event_key text;
  v_count integer := 0;
  v_slots text[] := ARRAY[]::text[];
BEGIN
  IF p_attempt_id IS NULL
     OR p_user_id IS NULL
     OR coalesce(jsonb_typeof(p_deliveries), '') <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TRAINING_ATTEMPT_SERVE_AUDIT_INVALID';
  END IF;
  IF jsonb_array_length(p_deliveries) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TRAINING_ATTEMPT_SERVE_AUDIT_INVALID';
  END IF;
  SELECT * INTO v_attempt FROM public.training_attempts a
  WHERE a.id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_ATTEMPT_SERVE_OWNER_MISMATCH';
  END IF;
  IF v_attempt.status <> 'open' OR v_attempt.expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_ATTEMPT_NOT_OPEN';
  END IF;

  FOR v_delivery IN SELECT value FROM jsonb_array_elements(p_deliveries)
  LOOP
    v_hand := (v_delivery ->> 'handOrdinal')::integer;
    v_decision := (v_delivery ->> 'decisionOrdinal')::integer;
    v_snapshot_key := v_delivery ->> 'snapshotKey';
    v_question_id := v_delivery ->> 'questionId';
    v_checksum := lower(v_delivery ->> 'policyChecksum');
    v_difficulty := lower(v_delivery ->> 'difficultyMode');
    v_rng_rolls := v_delivery -> 'rngRolls';
    IF coalesce(v_hand, 0) NOT BETWEEN 1 AND 100
       OR coalesce(v_decision, 0) NOT BETWEEN 1 AND 8
       OR coalesce(v_snapshot_key, '') !~ '^[0-9a-f]{64}$'
       OR nullif(btrim(v_question_id), '') IS NULL
       OR coalesce(v_checksum, '') !~ '^[0-9a-f]{64}$'
       OR v_difficulty IS DISTINCT FROM v_attempt.difficulty
       OR jsonb_typeof(v_rng_rolls) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(v_rng_rolls)) <> 2
       OR NOT (v_rng_rolls ?& ARRAY['low', 'high'])
       OR jsonb_typeof(v_rng_rolls -> 'low') <> 'number'
       OR jsonb_typeof(v_rng_rolls -> 'high') <> 'number'
       OR trunc((v_rng_rolls ->> 'low')::numeric) <> (v_rng_rolls ->> 'low')::numeric
       OR trunc((v_rng_rolls ->> 'high')::numeric) <> (v_rng_rolls ->> 'high')::numeric
       OR (v_rng_rolls ->> 'low')::integer NOT BETWEEN 1 AND 100
       OR (v_rng_rolls ->> 'high')::integer NOT BETWEEN 1 AND 100
       OR (v_hand::text || ':' || v_decision::text) = ANY(v_slots) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TRAINING_ATTEMPT_SERVE_AUDIT_INVALID';
    END IF;
    v_slots := array_append(v_slots, v_hand::text || ':' || v_decision::text);

    IF EXISTS (
      SELECT 1 FROM public.training_answers answer
      WHERE answer.attempt_id = p_attempt_id
        AND answer.hand_ordinal = v_hand
        AND answer.decision_ordinal = v_decision
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_ATTEMPT_DECISION_ALREADY_ANSWERED';
    END IF;

    IF v_decision = 1 THEN
      SELECT h.snapshot_key INTO v_expected_snapshot FROM public.training_attempt_hands h
      WHERE h.attempt_id = p_attempt_id AND h.hand_ordinal = v_hand;
    ELSE
      SELECT s.snapshot_key INTO v_expected_snapshot FROM public.training_attempt_decision_slots s
      WHERE s.attempt_id = p_attempt_id
        AND s.hand_ordinal = v_hand AND s.decision_ordinal = v_decision;
    END IF;
    IF v_expected_snapshot IS NULL OR v_expected_snapshot <> v_snapshot_key THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_ATTEMPT_SERVE_SLOT_MISMATCH';
    END IF;

    SELECT * INTO v_snapshot FROM public.training_question_snapshots
    WHERE snapshot_key = v_snapshot_key;
    IF NOT FOUND
       OR v_snapshot.source_question_id <> v_question_id
       OR lower(coalesce(v_snapshot.question_data ->> 'policyChecksum', '')) <> v_checksum THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_ATTEMPT_SERVE_SNAPSHOT_MISMATCH';
    END IF;

    v_event_key := 'training-attempt:' || p_attempt_id::text
      || ':hand:' || v_hand::text || ':decision:' || v_decision::text;
    SELECT * INTO v_existing FROM public.training_question_events e
    WHERE e.event_type = 'served' AND e.event_key = v_event_key;
    IF FOUND AND (
      v_existing.question_id <> v_question_id
      OR v_existing.user_id IS DISTINCT FROM p_user_id
      OR v_existing.policy_checksum <> v_checksum
      OR v_existing.metadata ->> 'snapshotKey' IS DISTINCT FROM v_snapshot_key
      OR v_existing.metadata ->> 'attemptId' IS DISTINCT FROM p_attempt_id::text
      OR v_existing.metadata ->> 'handOrdinal' IS DISTINCT FROM v_hand::text
      OR v_existing.metadata ->> 'decisionOrdinal' IS DISTINCT FROM v_decision::text
      OR (
        v_existing.metadata ? 'difficultyMode'
        AND v_existing.metadata ->> 'difficultyMode' IS DISTINCT FROM v_difficulty
      )
      OR (
        v_existing.metadata ? 'rngRolls'
        AND v_existing.metadata -> 'rngRolls' IS DISTINCT FROM v_rng_rolls
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'TRAINING_ATTEMPT_SERVE_EVENT_MISMATCH';
    END IF;

    -- A pre-upgrade stable receipt is already immutable. Return it without
    -- asking the later full-metadata event RPC to rewrite its shape. Such a
    -- receipt can grade ordinary decisions from attempt.difficulty, but it
    -- cannot authorize RNG grading because it has no pre-answer RNG rolls.
    IF FOUND THEN
      v_count := v_count + 1;
      CONTINUE;
    END IF;

    PERFORM public.fn_training_cache_record_event(
      'served', v_event_key, v_question_id, p_user_id, NULL,
      jsonb_build_object(
        'attemptId', p_attempt_id,
        'handOrdinal', v_hand,
        'decisionOrdinal', v_decision,
        'snapshotKey', v_snapshot_key,
        'difficultyMode', v_difficulty,
        'rngRolls', v_rng_rolls
      ),
      now(), v_checksum
    );
    v_count := v_count + 1;
  END LOOP;
  INSERT INTO public.training_delivery_authority_attestations (
    contract_version, first_attested_at, evidence_event_key, evidence_kind
  ) VALUES (
    'training-attempt-decision-authority-v1', clock_timestamp(),
    v_event_key, 'attempt_scoped_serve'
  ) ON CONFLICT (contract_version) DO NOTHING;
  RETURN jsonb_build_object('questionCount', v_count);
END;
$$;

-- Derive the exact action partition that the immutable question and the
-- authoritative attempt difficulty serve. The helper recomputes grouped
-- frequencies, measured group EV and RNG targets; caller metadata can never
-- nominate its own group members or RNG target.
CREATE OR REPLACE FUNCTION public.fn_training_grade_delivered_policy_v1(
  p_policy jsonb,
  p_question jsonb,
  p_answer_id text,
  p_difficulty text,
  p_rng jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_distribution jsonb := '{}'::jsonb;
  v_mapping jsonb := '{}'::jsonb;
  v_ordered_passthrough text[] := ARRAY[]::text[];
  v_ordered_raw text[] := ARRAY[]::text[];
  v_ordered_effective text[] := ARRAY[]::text[];
  v_selected_effective text[] := ARRAY[]::text[];
  v_ev_weighted jsonb := '{}'::jsonb;
  v_ev_max jsonb := '{}'::jsonb;
  v_ev_complete boolean := coalesce(
    p_policy #>> '{chipEv,measuredByAction}' = 'true',
    false
  );
  v_grouped_applied boolean := false;
  v_entry record;
  v_option jsonb;
  v_policy_action jsonb;
  v_option_ordinal bigint;
  v_raw_id text;
  v_family text;
  v_effective_id text;
  v_pct numeric;
  v_frequency numeric;
  v_raw_ev numeric;
  v_previous numeric;
  v_selected numeric;
  v_optimal numeric;
  v_optimal_action text;
  v_correct_effective text;
  v_nonzero integer;
  v_classification text;
  v_is_correct boolean;
  v_canonical_classification text;
  v_canonical_is_correct boolean;
  v_solver_verified boolean;
  v_selected_ev numeric;
  v_optimal_ev numeric;
  v_ev_loss numeric;
  v_rng_mode text;
  v_rng_roll integer;
  v_rng_target text;
  v_total numeric := 0;
  v_cumulative numeric := 0;
  v_previous_end integer := 0;
  v_range_end integer;
  v_range_start integer;
  v_id text;
BEGIN
  IF NOT public.fn_training_cache_policy_seal_is_valid(p_policy)
     OR jsonb_typeof(p_question) <> 'object'
     OR jsonb_typeof(p_question -> 'options') <> 'array'
     OR jsonb_typeof(p_policy -> 'actions') <> 'array'
     OR jsonb_typeof(p_policy -> 'distribution') <> 'object'
     OR p_difficulty NOT IN ('simple', 'grouped', 'exact')
     OR nullif(lower(btrim(p_answer_id)), '') IS NULL THEN
    RETURN jsonb_build_object('valid', false);
  END IF;

  FOR v_entry IN SELECT key, value FROM jsonb_each(p_policy -> 'distribution') LOOP
    v_raw_id := lower(v_entry.key);
    v_frequency := (v_entry.value #>> '{}')::numeric;
    SELECT option.value, option.ordinality
    INTO v_option, v_option_ordinal
    FROM jsonb_array_elements(p_question -> 'options') WITH ORDINALITY AS option(value, ordinality)
    WHERE lower(coalesce(option.value ->> 'id', option.value #>> '{}')) = v_raw_id
    LIMIT 1;
    IF NOT FOUND OR v_raw_id = ANY(v_ordered_raw) THEN
      RETURN jsonb_build_object('valid', false);
    END IF;
    SELECT action.value INTO v_policy_action
    FROM jsonb_array_elements(p_policy -> 'actions') AS action(value)
    WHERE lower(action.value ->> 'id') = v_raw_id
    LIMIT 1;
    IF NOT FOUND OR v_policy_action ->> 'legal' <> 'true' THEN
      RETURN jsonb_build_object('valid', false);
    END IF;
    v_ordered_raw := array_append(v_ordered_raw, v_raw_id);
    v_family := lower(coalesce(v_policy_action ->> 'family', 'other'));
    v_effective_id := v_raw_id;
    IF p_difficulty IN ('simple', 'grouped') AND v_family IN ('bet', 'raise') THEN
      IF jsonb_typeof(v_policy_action #> '{size,potFraction}') = 'number' THEN
        v_pct := (v_policy_action #>> '{size,potFraction}')::numeric * 100;
        v_effective_id := CASE
          WHEN v_pct <= 40 THEN 'grouped_small'
          WHEN v_pct <= 80 THEN 'grouped_medium'
          WHEN v_pct <= 100 THEN 'grouped_large'
          ELSE 'grouped_overbet'
        END;
      END IF;
    END IF;
    v_mapping := v_mapping || jsonb_build_object(v_raw_id, v_effective_id);
    v_previous := coalesce((v_distribution ->> v_effective_id)::numeric, 0);
    v_distribution := v_distribution
      || jsonb_build_object(v_effective_id, v_previous + v_frequency);
    IF v_ev_complete THEN
      IF jsonb_typeof(p_policy #> ARRAY['chipEv', 'byAction', v_raw_id]) <> 'number' THEN
        v_ev_complete := false;
      ELSE
        v_raw_ev := (p_policy #>> ARRAY['chipEv', 'byAction', v_raw_id])::numeric;
        v_ev_weighted := v_ev_weighted || jsonb_build_object(
          v_effective_id,
          coalesce((v_ev_weighted ->> v_effective_id)::numeric, 0)
            + (v_raw_ev * v_frequency)
        );
        v_ev_max := v_ev_max || jsonb_build_object(
          v_effective_id,
          greatest(coalesce((v_ev_max ->> v_effective_id)::numeric, v_raw_ev), v_raw_ev)
        );
      END IF;
    END IF;
  END LOOP;

  SELECT array_agg(
    lower(coalesce(option.value ->> 'id', option.value #>> '{}'))
    ORDER BY option.ordinality
  )
  INTO v_ordered_raw
  FROM jsonb_array_elements(p_question -> 'options') WITH ORDINALITY AS option(value, ordinality)
  WHERE v_mapping ? lower(coalesce(option.value ->> 'id', option.value #>> '{}'));
  IF coalesce(cardinality(v_ordered_raw), 0)
       <> (SELECT count(*) FROM jsonb_object_keys(v_mapping)) THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  FOREACH v_raw_id IN ARRAY v_ordered_raw LOOP
    IF v_mapping ->> v_raw_id = v_raw_id THEN
      v_ordered_passthrough := array_append(v_ordered_passthrough, v_raw_id);
    END IF;
  END LOOP;

  -- applyDifficultyToQuestion deliberately falls back to the original exact
  -- options when grouping would provide fewer than the four-choice contract.
  IF p_difficulty IN ('simple', 'grouped')
     AND (SELECT count(*) FROM jsonb_object_keys(v_distribution)) < 4 THEN
    v_distribution := p_policy -> 'distribution';
    v_mapping := '{}'::jsonb;
    v_ev_weighted := '{}'::jsonb;
    v_ev_max := '{}'::jsonb;
    FOREACH v_raw_id IN ARRAY v_ordered_raw LOOP
      v_mapping := v_mapping || jsonb_build_object(v_raw_id, v_raw_id);
      IF v_ev_complete THEN
        v_raw_ev := (p_policy #>> ARRAY['chipEv', 'byAction', v_raw_id])::numeric;
        v_ev_weighted := v_ev_weighted || jsonb_build_object(
          v_raw_id, v_raw_ev * (v_distribution ->> v_raw_id)::numeric
        );
        v_ev_max := v_ev_max || jsonb_build_object(v_raw_id, v_raw_ev);
      END IF;
    END LOOP;
    v_ordered_effective := v_ordered_raw;
  ELSIF p_difficulty IN ('simple', 'grouped') THEN
    v_grouped_applied := true;
    v_ordered_effective := v_ordered_passthrough;
    FOREACH v_id IN ARRAY ARRAY['grouped_small','grouped_medium','grouped_large','grouped_overbet'] LOOP
      IF v_distribution ? v_id THEN
        v_ordered_effective := array_append(v_ordered_effective, v_id);
      END IF;
    END LOOP;
  ELSE
    v_ordered_effective := v_ordered_raw;
  END IF;

  v_correct_effective := v_mapping ->> lower(coalesce(p_question ->> 'correctAnswer', ''));

  -- enforceTrainingQuestionContract deterministically retains four options
  -- when a valid grouping produces more than the product's four-choice
  -- contract: the bucket containing the declared best action first, then the
  -- highest-frequency buckets, with the original simplified ordering as the
  -- stable tie-breaker. Reproduce that exact served subset in Postgres so an
  -- unserved fifth bucket cannot be persisted by a privileged caller.
  IF v_grouped_applied AND cardinality(v_ordered_effective) > 4 THEN
    SELECT array_agg(candidate.id ORDER BY candidate.ordinality)
    INTO v_selected_effective
    FROM (
      SELECT ordered.id, ordered.ordinality
      FROM unnest(v_ordered_effective) WITH ORDINALITY AS ordered(id, ordinality)
      ORDER BY
        (ordered.id = v_correct_effective) DESC,
        (v_distribution ->> ordered.id)::numeric DESC,
        ordered.ordinality ASC
      LIMIT 4
    ) AS candidate;
    v_ordered_effective := v_selected_effective;
    SELECT coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    INTO v_distribution
    FROM jsonb_each(v_distribution) AS entry(key, value)
    WHERE entry.key = ANY(v_ordered_effective);
    SELECT coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    INTO v_ev_weighted
    FROM jsonb_each(v_ev_weighted) AS entry(key, value)
    WHERE entry.key = ANY(v_ordered_effective);
    SELECT coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    INTO v_ev_max
    FROM jsonb_each(v_ev_max) AS entry(key, value)
    WHERE entry.key = ANY(v_ordered_effective);
  END IF;

  v_id := lower(btrim(p_answer_id));
  IF jsonb_typeof(v_distribution -> v_id) IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  v_selected := (v_distribution ->> v_id)::numeric;
  IF v_grouped_applied THEN
    SELECT (v_distribution ->> ordered.id)::numeric, ordered.id
    INTO v_optimal, v_optimal_action
    FROM unnest(v_ordered_effective) WITH ORDINALITY AS ordered(id, ordinality)
    ORDER BY (v_distribution ->> ordered.id)::numeric DESC, ordered.ordinality ASC
    LIMIT 1;
  ELSE
    SELECT (entry.value #>> '{}')::numeric, entry.key
    INTO v_optimal, v_optimal_action
    FROM jsonb_each(v_distribution) AS entry(key, value)
    ORDER BY (entry.value #>> '{}')::numeric DESC, entry.key ASC
    LIMIT 1;
  END IF;
  SELECT count(*)::integer INTO v_nonzero
  FROM jsonb_each(v_distribution) AS entry(key, value)
  WHERE (entry.value #>> '{}')::numeric > 0;
  v_classification := CASE
    -- Grouped grading takes the same fallback path as
    -- gradeSolverDecision(): the bucket containing the canonical declared
    -- answer remains Best (or Correct only for a zero-frequency anomaly).
    WHEN v_grouped_applied AND v_id = v_correct_effective
      THEN CASE WHEN v_selected = 0 AND v_optimal > 0 THEN 'correct' ELSE 'best' END
    WHEN v_selected >= v_optimal - 0.000000001 THEN 'best'
    WHEN v_selected >= 0.20 THEN 'best'
    WHEN v_selected >= 0.05 THEN 'correct'
    WHEN v_selected >= 0.01 THEN 'inaccuracy'
    WHEN v_optimal >= 0.80 OR v_nonzero <= 1 THEN 'blunder'
    ELSE 'wrong'
  END;
  v_is_correct := v_classification IN ('best', 'correct');
  v_canonical_classification := v_classification;
  v_canonical_is_correct := v_is_correct;
  v_solver_verified := upper(p_policy ->> 'qualitySeal') IN (
    'SOLVER_EXACT', 'SOLVER_AGGREGATED',
    'SOLVER_DERIVED_RESPONSE', 'CHART_AUDITED'
  );

  IF v_ev_complete THEN
    v_selected_ev := CASE WHEN (v_distribution ->> v_id)::numeric > 0
      THEN (v_ev_weighted ->> v_id)::numeric / (v_distribution ->> v_id)::numeric
      ELSE (v_ev_max ->> v_id)::numeric END;
    IF v_grouped_applied THEN
      -- difficultyQuestionContract rounds each aggregate action EV to two
      -- decimals, then the grouped fallback compares with the most-frequent
      -- action rather than silently inventing a maximum-EV solver claim.
      v_selected_ev := round(v_selected_ev, 2);
      v_optimal_ev := CASE WHEN (v_distribution ->> v_optimal_action)::numeric > 0
        THEN round(
          (v_ev_weighted ->> v_optimal_action)::numeric
            / (v_distribution ->> v_optimal_action)::numeric,
          2
        )
        ELSE round((v_ev_max ->> v_optimal_action)::numeric, 2) END;
    ELSE
      SELECT max(CASE WHEN (v_distribution ->> ev.key)::numeric > 0
        THEN (v_ev_weighted ->> ev.key)::numeric / (v_distribution ->> ev.key)::numeric
        ELSE (v_ev_max ->> ev.key)::numeric END)
      INTO v_optimal_ev
      FROM jsonb_each(v_distribution) AS ev(key, value);
    END IF;
    v_ev_loss := greatest(0, v_optimal_ev - v_selected_ev);
  END IF;

  IF p_rng IS NOT NULL AND jsonb_typeof(p_rng) <> 'null' THEN
    IF jsonb_typeof(p_rng) <> 'object'
       OR lower(coalesce(p_rng ->> 'mode', '')) NOT IN ('low', 'high')
       OR jsonb_typeof(p_rng -> 'roll') <> 'number'
       OR trunc((p_rng ->> 'roll')::numeric) <> (p_rng ->> 'roll')::numeric
       OR (p_rng ->> 'roll')::integer NOT BETWEEN 1 AND 100 THEN
      RETURN jsonb_build_object('valid', false);
    END IF;
    v_rng_mode := lower(p_rng ->> 'mode');
    v_rng_roll := (p_rng ->> 'roll')::integer;
    SELECT sum((entry.value #>> '{}')::numeric) INTO v_total
    FROM jsonb_each(v_distribution) AS entry(key, value)
    WHERE (entry.value #>> '{}')::numeric > 0;
    IF coalesce(v_total, 0) <= 0 THEN RETURN jsonb_build_object('valid', false); END IF;
    FOREACH v_effective_id IN ARRAY v_ordered_effective LOOP
      v_frequency := coalesce((v_distribution ->> v_effective_id)::numeric, 0);
      IF v_frequency <= 0 THEN CONTINUE; END IF;
      v_cumulative := v_cumulative + v_frequency;
      v_range_end := CASE
        WHEN v_cumulative >= v_total THEN 100
        ELSE greatest(v_previous_end, least(100, round(v_cumulative / v_total * 100)::integer))
      END;
      v_range_start := v_previous_end + 1;
      IF v_rng_mode = 'high' THEN
        IF v_rng_roll BETWEEN 101 - v_range_end AND 101 - v_range_start THEN
          v_rng_target := v_effective_id;
        END IF;
      ELSIF v_rng_roll BETWEEN v_range_start AND v_range_end THEN
        v_rng_target := v_effective_id;
      END IF;
      v_previous_end := v_range_end;
    END LOOP;
    IF v_rng_target IS NULL THEN RETURN jsonb_build_object('valid', false); END IF;
    v_is_correct := v_id = v_rng_target;
    v_classification := CASE WHEN v_is_correct THEN 'best' ELSE 'wrong' END;
  END IF;

  RETURN jsonb_build_object(
    'valid', true,
    'classification', v_classification,
    'isCorrect', v_is_correct,
    'canonicalClassification', v_canonical_classification,
    'canonicalIsCorrect', v_canonical_is_correct,
    'solverVerified', v_solver_verified,
    'selectedFrequency', round(v_selected * 100, 2),
    'optimalFrequency', round(v_optimal * 100, 2),
    'optimalAction', v_optimal_action,
    'evLossMeasured', v_ev_complete,
    'evLoss', CASE WHEN v_ev_complete THEN round(v_ev_loss, 3) ELSE NULL END,
    'policyVersion', p_policy ->> 'policyVersion',
    'solverSource', p_policy #>> '{sourceArtifact,system}',
    'sourceChecksum', p_policy #>> '{sourceArtifact,sourceArtifactChecksum}',
    'rngTargetAction', v_rng_target
  );
END;
$$;

-- Preserve the strict cache-truth grade contract while extending it to an
-- attempt-scoped policy that has legitimately left the mutable cache. Every
-- grade and lineage field is recomputed from either the matching active cache
-- policy or the immutable delivered snapshot; NEW is never grading authority.
-- Snapshot recovery records an action-bound event without incrementing the
-- counters of a replacement cache policy.
CREATE OR REPLACE FUNCTION public.fn_training_record_answer_cache_event_v1(
  p_answer public.training_answers
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_cache public.training_question_cache%ROWTYPE;
  v_snapshot public.training_question_snapshots%ROWTYPE;
  v_attempt public.training_attempts%ROWTYPE;
  v_delivery public.training_question_events%ROWTYPE;
  v_checksum text := lower(nullif(p_answer.evidence_metadata ->> 'policyChecksum', ''));
  v_policy jsonb;
  v_source_classification text;
  v_policy_version text;
  v_grade jsonb;
  v_expected_verified boolean;
  v_expected_ev_measured boolean;
  v_snapshot_recovery boolean := false;
  v_existing public.training_question_events%ROWTYPE;
  v_event_key text := 'training-answer:' || p_answer.id::text;
  v_event_metadata jsonb;
  v_delivery_key text;
  v_difficulty text;
  v_rng jsonb;
BEGIN
  IF v_checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'training_answer_missing_policy_checksum';
  END IF;

  SELECT * INTO v_cache
  FROM public.training_question_cache c
  WHERE c.question_id = p_answer.question_id
    AND c.quality_status IN ('active', 'active_fallback');

  IF p_answer.attempt_id IS NULL THEN
    IF v_cache.id IS NULL THEN
      RAISE EXCEPTION 'training_answer_question_not_active';
    END IF;
    IF v_cache.policy_checksum <> v_checksum THEN
      RAISE EXCEPTION 'training_answer_stale_policy';
    END IF;
    v_policy := v_cache.canonical_policy;
    v_source_classification := v_cache.source_classification;
    v_policy_version := v_cache.policy_version;
  ELSE
    IF p_answer.hand_ordinal IS NULL
       OR p_answer.decision_ordinal IS NULL
       OR p_answer.snapshot_key IS NULL THEN
      RAISE EXCEPTION 'training_answer_immutable_snapshot_mismatch';
    END IF;
    SELECT * INTO v_attempt
    FROM public.training_attempts attempt
    WHERE attempt.id = p_answer.attempt_id
      AND attempt.user_id = p_answer.user_id
      AND attempt.game_id = p_answer.game_id
      AND attempt.level = p_answer.level;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'training_answer_attempt_mismatch';
    END IF;

    SELECT * INTO v_snapshot
    FROM public.training_question_snapshots s
    WHERE s.snapshot_key = p_answer.snapshot_key
      AND s.game_id = p_answer.game_id
      AND s.level = p_answer.level
      AND (
        s.source_question_id = p_answer.question_id
        OR s.question_data ->> 'id' = p_answer.question_id
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'training_answer_immutable_snapshot_mismatch';
    END IF;

    v_policy := v_snapshot.question_data -> 'solverPolicy';
    v_source_classification := coalesce(
      nullif(v_snapshot.question_data ->> 'sourceClassification', ''),
      nullif(v_snapshot.question_data ->> 'dataQuality', '')
    );
    v_policy_version := v_policy ->> 'policyVersion';
    IF jsonb_typeof(v_policy) <> 'object'
       OR encode(extensions.digest(v_policy::text, 'sha256'), 'hex') <> v_checksum THEN
      RAISE EXCEPTION 'training_answer_immutable_policy_mismatch';
    END IF;

    v_delivery_key := 'training-attempt:' || p_answer.attempt_id::text
      || ':hand:' || p_answer.hand_ordinal::text
      || ':decision:' || p_answer.decision_ordinal::text;
    SELECT * INTO v_delivery
    FROM public.training_question_events delivered
    WHERE delivered.event_type = 'served'
      AND delivered.event_key = v_delivery_key
      AND delivered.question_id = p_answer.question_id
      AND delivered.user_id = p_answer.user_id
      AND delivered.policy_checksum = v_checksum
      AND delivered.metadata ->> 'attemptId' = p_answer.attempt_id::text
      AND delivered.metadata ->> 'handOrdinal' = p_answer.hand_ordinal::text
      AND delivered.metadata ->> 'decisionOrdinal' = p_answer.decision_ordinal::text
      AND delivered.metadata ->> 'snapshotKey' = p_answer.snapshot_key
      AND (
        NOT (to_jsonb(delivered) ? 'binding_status')
        OR to_jsonb(delivered) ->> 'binding_status' = 'CHECKSUM_BOUND'
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'training_answer_immutable_delivery_mismatch';
    END IF;
    v_difficulty := v_attempt.difficulty;
    IF coalesce(p_answer.evidence_metadata ->> 'difficultyMode', '') <> v_difficulty
       OR (
         v_delivery.metadata ? 'difficultyMode'
         AND v_delivery.metadata ->> 'difficultyMode' <> v_difficulty
       ) THEN
      RAISE EXCEPTION 'training_answer_difficulty_mismatch';
    END IF;
    IF jsonb_typeof(p_answer.evidence_metadata -> 'rng') = 'object' THEN
      IF p_answer.evidence_metadata ->> 'gradeMode' <> 'rng-adherence'
         OR lower(coalesce(p_answer.evidence_metadata #>> '{rng,mode}', '')) NOT IN ('low', 'high')
         OR jsonb_typeof(p_answer.evidence_metadata #> '{rng,roll}') <> 'number'
         OR jsonb_typeof(v_delivery.metadata -> 'rngRolls') <> 'object'
         OR jsonb_typeof(v_delivery.metadata #> ARRAY['rngRolls', lower(p_answer.evidence_metadata #>> '{rng,mode}')]) <> 'number'
         OR (p_answer.evidence_metadata #>> '{rng,roll}')::numeric
              <> (v_delivery.metadata #>> ARRAY['rngRolls', lower(p_answer.evidence_metadata #>> '{rng,mode}')])::numeric THEN
        RAISE EXCEPTION 'training_answer_rng_authority_mismatch';
      END IF;
      v_rng := jsonb_build_object(
        'mode', lower(p_answer.evidence_metadata #>> '{rng,mode}'),
        'roll', (v_delivery.metadata #>> ARRAY['rngRolls', lower(p_answer.evidence_metadata #>> '{rng,mode}')])::integer
      );
    ELSIF p_answer.evidence_metadata ->> 'gradeMode' IS DISTINCT FROM 'solver-decision' THEN
      RAISE EXCEPTION 'training_answer_rng_authority_mismatch';
    END IF;
    v_snapshot_recovery := v_cache.id IS NULL OR v_cache.policy_checksum <> v_checksum;
  END IF;

  v_grade := CASE WHEN p_answer.attempt_id IS NULL
    THEN public.fn_training_cache_grade(v_policy, p_answer.answer_id)
    ELSE public.fn_training_grade_delivered_policy_v1(
      v_policy, v_snapshot.question_data, p_answer.answer_id, v_difficulty, v_rng
    ) END;
  IF coalesce((v_grade ->> 'valid')::boolean, false) = false THEN
    RAISE EXCEPTION 'training_answer_not_in_canonical_policy';
  END IF;
  v_expected_verified := (v_grade ->> 'solverVerified')::boolean;
  v_expected_ev_measured := (v_grade ->> 'evLossMeasured')::boolean;
  IF v_rng IS NOT NULL AND NOT v_expected_verified THEN
    RAISE EXCEPTION 'training_answer_rng_requires_verified_solver';
  END IF;

  IF p_answer.is_correct IS DISTINCT FROM (v_grade ->> 'isCorrect')::boolean
     OR lower(coalesce(p_answer.classification, '')) <> v_grade ->> 'classification'
     OR p_answer.solver_verified IS DISTINCT FROM v_expected_verified THEN
    RAISE EXCEPTION 'training_answer_grade_mismatch';
  END IF;
  IF v_expected_verified THEN
    IF p_answer.selected_frequency IS NULL OR p_answer.optimal_frequency IS NULL
       OR abs(p_answer.selected_frequency - (v_grade ->> 'selectedFrequency')::numeric) > 0.000001
       OR abs(p_answer.optimal_frequency - (v_grade ->> 'optimalFrequency')::numeric) > 0.000001
       OR coalesce(p_answer.solver_source, '') <> coalesce(v_grade ->> 'solverSource', '') THEN
      RAISE EXCEPTION 'training_answer_solver_evidence_mismatch';
    END IF;
  ELSIF p_answer.selected_frequency IS NOT NULL
     OR p_answer.optimal_frequency IS NOT NULL
     OR p_answer.solver_source IS NOT NULL THEN
    RAISE EXCEPTION 'training_answer_fallback_claims_solver_evidence';
  END IF;
  IF p_answer.ev_loss_measured IS DISTINCT FROM v_expected_ev_measured
     OR (v_expected_ev_measured AND (
          p_answer.ev_loss IS NULL
          OR abs(p_answer.ev_loss - (v_grade ->> 'evLoss')::numeric) > 0.000001
     ))
     OR (NOT v_expected_ev_measured AND coalesce(p_answer.ev_loss, 0) <> 0) THEN
    RAISE EXCEPTION 'training_answer_ev_evidence_mismatch';
  END IF;
  IF coalesce(p_answer.evidence_metadata ->> 'policyVersion', '')
          <> coalesce(v_policy_version, '')
     OR coalesce(p_answer.evidence_metadata ->> 'dataQuality', '')
          <> coalesce(v_source_classification, '')
     OR (
          v_expected_verified
          AND coalesce(p_answer.evidence_metadata ->> 'sourceChecksum', '')
              <> coalesce(v_grade ->> 'sourceChecksum', '')
     ) THEN
    RAISE EXCEPTION 'training_answer_lineage_mismatch';
  END IF;
  IF p_answer.attempt_id IS NOT NULL AND (
       coalesce(p_answer.evidence_metadata ->> 'canonicalSolverClassification', '')
         <> coalesce(v_grade ->> 'canonicalClassification', '')
       OR jsonb_typeof(p_answer.evidence_metadata -> 'canonicalSolverIsCorrect') <> 'boolean'
       OR (p_answer.evidence_metadata ->> 'canonicalSolverIsCorrect')::boolean
         IS DISTINCT FROM (v_grade ->> 'canonicalIsCorrect')::boolean
       OR (
         v_rng IS NOT NULL
         AND coalesce(p_answer.evidence_metadata #>> '{rng,targetActionId}', '')
           <> coalesce(v_grade ->> 'rngTargetAction', '')
       )
     ) THEN
    RAISE EXCEPTION 'training_answer_attempt_grade_metadata_mismatch';
  END IF;

  v_event_metadata := jsonb_strip_nulls(jsonb_build_object(
    'answerId', p_answer.id,
    'selectedAnswer', p_answer.answer_id,
    'submissionId', p_answer.submission_id,
    'classification', v_grade ->> 'classification',
    'solverVerified', v_expected_verified,
    'selectedFrequency', v_grade -> 'selectedFrequency',
    'optimalFrequency', v_grade -> 'optimalFrequency',
    'evLossMeasured', v_expected_ev_measured,
    'evLoss', v_grade -> 'evLoss',
    'policyChecksum', v_checksum
  ));
  IF p_answer.attempt_id IS NOT NULL THEN
    v_event_metadata := v_event_metadata || jsonb_strip_nulls(jsonb_build_object(
      'gradeMode', CASE WHEN v_rng IS NULL THEN 'solver-decision' ELSE 'rng-adherence' END,
      'difficultyMode', v_difficulty,
      'canonicalSolverClassification', v_grade ->> 'canonicalClassification',
      'canonicalSolverIsCorrect', (v_grade ->> 'canonicalIsCorrect')::boolean,
      'rng', CASE WHEN v_rng IS NULL THEN NULL ELSE v_rng || jsonb_build_object(
        'targetActionId', v_grade ->> 'rngTargetAction'
      ) END
    ));
  END IF;
  IF v_snapshot_recovery THEN
    v_event_metadata := v_event_metadata || jsonb_build_object(
      'immutableSnapshotRecovery', true,
      'snapshotKey', p_answer.snapshot_key,
      'attemptId', p_answer.attempt_id,
      'handOrdinal', p_answer.hand_ordinal,
      'decisionOrdinal', p_answer.decision_ordinal
    );
  END IF;

  SELECT * INTO v_existing
  FROM public.training_question_events e
  WHERE e.event_type = 'answered' AND e.event_key = v_event_key;
  IF FOUND THEN
    IF v_existing.question_id <> p_answer.question_id
       OR v_existing.user_id IS DISTINCT FROM p_answer.user_id
       OR v_existing.is_correct IS DISTINCT FROM (v_grade ->> 'isCorrect')::boolean
       OR v_existing.policy_checksum <> v_checksum
       OR (
         to_jsonb(v_existing) ? 'binding_status'
         AND to_jsonb(v_existing) ->> 'binding_status' <> 'CHECKSUM_BOUND'
       )
       OR v_existing.metadata IS DISTINCT FROM v_event_metadata THEN
      RAISE EXCEPTION 'training_cache_event_binding_mismatch';
    END IF;
    RETURN;
  END IF;

  IF NOT v_snapshot_recovery THEN
    PERFORM public.fn_training_cache_record_event(
      'answered', v_event_key, p_answer.question_id, p_answer.user_id,
      (v_grade ->> 'isCorrect')::boolean, v_event_metadata,
      coalesce(p_answer.answered_at, now()), v_checksum
    );
    RETURN;
  END IF;

  INSERT INTO public.training_question_events (
    event_type, event_key, question_id, user_id, is_correct,
    policy_checksum, metadata, occurred_at
  ) VALUES (
    'answered', v_event_key, p_answer.question_id, p_answer.user_id,
    (v_grade ->> 'isCorrect')::boolean, v_checksum, v_event_metadata,
    coalesce(p_answer.answered_at, now())
  ) ON CONFLICT (event_type, event_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO v_existing FROM public.training_question_events e
    WHERE e.event_type = 'answered' AND e.event_key = v_event_key;
    IF NOT FOUND OR v_existing.question_id <> p_answer.question_id
       OR v_existing.user_id IS DISTINCT FROM p_answer.user_id
       OR v_existing.is_correct IS DISTINCT FROM (v_grade ->> 'isCorrect')::boolean
       OR v_existing.policy_checksum <> v_checksum
       OR (
         to_jsonb(v_existing) ? 'binding_status'
         AND to_jsonb(v_existing) ->> 'binding_status' <> 'CHECKSUM_BOUND'
       )
       OR v_existing.metadata IS DISTINCT FROM v_event_metadata THEN
      RAISE EXCEPTION 'training_cache_event_binding_mismatch';
    END IF;
  END IF;
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_training_answer_cache_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.fn_training_record_answer_cache_event_v1(NEW);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_training_register_continuation_slot_v1(uuid, uuid, integer, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_training_authorize_attempt_decision_v1(uuid, uuid, integer, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_training_promote_legacy_signed_decision_v1(uuid, uuid, integer, integer, text, text, text, text, bigint, bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_training_attempt_record_served_batch_v1(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_training_reject_decision_slot_update_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_reject_delivery_cutover_mutation_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_answer_cache_event()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_record_answer_cache_event_v1(public.training_answers)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_grade_delivered_policy_v1(jsonb, jsonb, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_lock_answer_attempt_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_training_register_continuation_slot_v1(uuid, uuid, integer, integer, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_training_authorize_attempt_decision_v1(uuid, uuid, integer, integer, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_training_promote_legacy_signed_decision_v1(uuid, uuid, integer, integer, text, text, text, text, bigint, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_training_attempt_record_served_batch_v1(uuid, uuid, jsonb)
  TO service_role;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.training_attempt_decision_slots', 'SELECT')
     OR has_table_privilege('anon', 'public.training_attempt_decision_slots', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_table_privilege('authenticated', 'public.training_attempt_decision_slots', 'SELECT')
     OR has_table_privilege('authenticated', 'public.training_attempt_decision_slots', 'INSERT')
     OR has_table_privilege('authenticated', 'public.training_attempt_decision_slots', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR NOT has_table_privilege('service_role', 'public.training_attempt_decision_slots', 'SELECT')
     OR has_table_privilege('service_role', 'public.training_attempt_decision_slots', 'INSERT')
     OR has_table_privilege('service_role', 'public.training_attempt_decision_slots', 'UPDATE')
     OR has_table_privilege('service_role', 'public.training_attempt_decision_slots', 'DELETE')
     OR has_table_privilege('service_role', 'public.training_attempt_decision_slots', 'TRUNCATE')
     OR has_table_privilege('service_role', 'public.training_attempt_decision_slots', 'REFERENCES')
     OR has_table_privilege('service_role', 'public.training_attempt_decision_slots', 'TRIGGER')
     OR has_table_privilege('service_role', 'public.training_attempt_decision_slots', 'MAINTAIN')
     OR has_any_column_privilege('service_role', 'public.training_attempt_decision_slots', 'INSERT')
     OR has_any_column_privilege('service_role', 'public.training_attempt_decision_slots', 'UPDATE')
     OR has_any_column_privilege('service_role', 'public.training_attempt_decision_slots', 'REFERENCES')
     OR has_any_column_privilege('anon', 'public.training_attempt_decision_slots', 'SELECT,INSERT,UPDATE,REFERENCES')
     OR has_any_column_privilege('authenticated', 'public.training_attempt_decision_slots', 'SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'TRAINING_CONTINUATION_SLOT_PRIVILEGE_DRIFT';
  END IF;
  IF has_table_privilege('anon', 'public.training_delivery_authority_cutover', 'SELECT')
     OR has_table_privilege('authenticated', 'public.training_delivery_authority_cutover', 'SELECT')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_cutover', 'SELECT')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_cutover', 'INSERT')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_cutover', 'UPDATE')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_cutover', 'DELETE')
     OR has_table_privilege('anon', 'public.training_delivery_authority_cutover', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_table_privilege('authenticated', 'public.training_delivery_authority_cutover', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_cutover', 'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_any_column_privilege('anon', 'public.training_delivery_authority_cutover', 'SELECT,INSERT,UPDATE,REFERENCES')
     OR has_any_column_privilege('authenticated', 'public.training_delivery_authority_cutover', 'SELECT,INSERT,UPDATE,REFERENCES')
     OR has_any_column_privilege('service_role', 'public.training_delivery_authority_cutover', 'SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'TRAINING_DELIVERY_AUTHORITY_CUTOVER_PRIVILEGE_DRIFT';
  END IF;
  IF has_table_privilege('anon', 'public.training_delivery_authority_attestations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.training_delivery_authority_attestations', 'SELECT')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_attestations', 'SELECT')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_attestations', 'INSERT')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_attestations', 'UPDATE')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_attestations', 'DELETE')
     OR has_table_privilege('anon', 'public.training_delivery_authority_attestations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_table_privilege('authenticated', 'public.training_delivery_authority_attestations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_table_privilege('service_role', 'public.training_delivery_authority_attestations', 'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
     OR has_any_column_privilege('anon', 'public.training_delivery_authority_attestations', 'SELECT,INSERT,UPDATE,REFERENCES')
     OR has_any_column_privilege('authenticated', 'public.training_delivery_authority_attestations', 'SELECT,INSERT,UPDATE,REFERENCES')
     OR has_any_column_privilege('service_role', 'public.training_delivery_authority_attestations', 'SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'TRAINING_DELIVERY_AUTHORITY_ATTESTATION_PRIVILEGE_DRIFT';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_training_register_continuation_slot_v1(uuid,uuid,integer,integer,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_training_authorize_attempt_decision_v1(uuid,uuid,integer,integer,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_training_promote_legacy_signed_decision_v1(uuid,uuid,integer,integer,text,text,text,text,bigint,bigint)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_training_attempt_record_served_batch_v1(uuid,uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_training_register_continuation_slot_v1(uuid,uuid,integer,integer,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_training_authorize_attempt_decision_v1(uuid,uuid,integer,integer,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_training_promote_legacy_signed_decision_v1(uuid,uuid,integer,integer,text,text,text,text,bigint,bigint)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_training_attempt_record_served_batch_v1(uuid,uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_training_register_continuation_slot_v1(uuid,uuid,integer,integer,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_training_authorize_attempt_decision_v1(uuid,uuid,integer,integer,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_training_promote_legacy_signed_decision_v1(uuid,uuid,integer,integer,text,text,text,text,bigint,bigint)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_training_attempt_record_served_batch_v1(uuid,uuid,jsonb)', 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
         AS role_under_test(role_name)
       CROSS JOIN (
         VALUES
           ('public.fn_training_reject_decision_slot_update_v1()'),
           ('public.fn_training_reject_delivery_cutover_mutation_v1()'),
           ('public.fn_training_answer_cache_event()'),
           ('public.fn_training_lock_answer_attempt_v1()')
       ) AS function_under_test(function_signature)
       WHERE has_function_privilege(
         role_under_test.role_name,
         function_under_test.function_signature,
         'EXECUTE'
       )
     ) THEN
    RAISE EXCEPTION 'TRAINING_DECISION_AUTHORITY_FUNCTION_PRIVILEGE_DRIFT';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.training_answers'::pg_catalog.regclass
      AND trigger_row.tgname = 'training_answers_00_lock_attempt_delivery_v1'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'TRAINING_DECISION_AUTHORITY_SERIALIZATION_TRIGGER_MISSING';
  END IF;
END;
$$;

COMMIT;
