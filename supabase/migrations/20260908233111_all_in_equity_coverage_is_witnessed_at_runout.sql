-- 20260908230007_all_in_equity_coverage_is_witnessed_at_runout
--
-- Root cause: ca_stats_witness_audit reconstructed an all-in obligation by
-- reopening seven days of hand_history JSON. At current horse volume that
-- scan competes with live hand settlement, and action-name reconstruction
-- misses calling, forced-bet, and covering-stack all-ins.
--
-- Stage 1 adds the durable fact shape only. The engine writes the witness it
-- froze into hand_history.actions at ALL_IN_RUNOUT. The covering index is
-- intentionally built by scripts/ops/build-stats-equity-witness-index-
-- concurrently.sql after this transaction commits; the audit function is
-- switched only by the later exact-source migration after that index is valid.

BEGIN;

DO $equity_witness_prerequisite$
BEGIN
  IF to_regclass('public.ca_hand_facts') IS NULL THEN
    RAISE EXCEPTION 'ALL_IN_EQUITY_WITNESS_PREREQUISITE_MISSING';
  END IF;
END;
$equity_witness_prerequisite$;

ALTER TABLE public.ca_hand_facts
  ADD COLUMN IF NOT EXISTS all_in_equity_owed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ca_hand_facts.all_in_equity_owed IS
  'True only when the atomic hand action record witnessed this seat in a cards-to-come ALL_IN_RUNOUT. NULL all_in_equity on an owed row is an explicit recording gap.';

DO $equity_witness_constraint$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid, true)
    INTO v_definition
    FROM pg_constraint
   WHERE conrelid = 'public.ca_hand_facts'::regclass
     AND conname = 'ca_hand_facts_equity_owed_shape';

  IF v_definition IS NULL THEN
    ALTER TABLE public.ca_hand_facts
      ADD CONSTRAINT ca_hand_facts_equity_owed_shape
      CHECK (
        all_in_equity_owed IS NOT TRUE
        OR (
          was_all_in IS TRUE
          AND went_to_showdown IS TRUE
          AND COALESCE(all_in_street, '') <> 'river'
        )
      ) NOT VALID;
  ELSIF position('all_in_equity_owed IS NOT TRUE' IN v_definition) = 0
        OR position('was_all_in IS TRUE' IN v_definition) = 0
        OR position('went_to_showdown IS TRUE' IN v_definition) = 0
        OR position('all_in_street' IN v_definition) = 0
        OR position('river' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'ALL_IN_EQUITY_WITNESS_CONSTRAINT_DRIFT: %', v_definition;
  END IF;
END;
$equity_witness_constraint$;

DO $equity_witness_postcondition$
DECLARE
  v_type regtype;
  v_not_null boolean;
  v_default text;
BEGIN
  SELECT a.atttypid::regtype, a.attnotnull,
         pg_get_expr(d.adbin, d.adrelid)
    INTO v_type, v_not_null, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.ca_hand_facts'::regclass
     AND a.attname = 'all_in_equity_owed'
     AND NOT a.attisdropped;

  IF v_type IS DISTINCT FROM 'boolean'::regtype
     OR v_not_null IS DISTINCT FROM true
     OR v_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION
      'ALL_IN_EQUITY_WITNESS_COLUMN_DRIFT: type %, not_null %, default %',
      v_type, v_not_null, v_default;
  END IF;
END;
$equity_witness_postcondition$;

COMMIT;
