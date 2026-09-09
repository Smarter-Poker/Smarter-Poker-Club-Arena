-- 20260909072626_addon_money_is_finite_and_historical_receipts_balance_to_cents
--
-- Forward correction for 20260909062006. Numeric NaN compares equal to itself
-- in PostgreSQL, so `amount <> round(amount, 2)` does not reject it. Infinity
-- also survives that predicate. The earlier NOT VALID checks have the same
-- gap. In addition, the post-commit processor compares a historical dusty
-- amount byte-for-byte even though its already-resolved applied and refunded
-- receipt legs are authoritative cent amounts.
--
-- This migration does not rewrite or backfill a single historical row. It:
--
--   1. final-defines both request doors so NULL, NaN, either infinity, and a
--      fractional cent are refused before the idempotency receipt claim;
--   2. atomically replaces the four NOT VALID constraints with finite-cent
--      constraints. NOT VALID preserves settled history while enforcing every
--      future INSERT and UPDATE;
--   3. final-defines the post-commit receipt check so applied and refunded
--      must each be finite non-negative cents and must sum exactly to the
--      rounded historical amount.
--
-- The function sources are exact PG17 pg_get_functiondef anchors. Any drift
-- aborts the transaction instead of editing an unreviewed money function.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $rewrite_amount_doors$
DECLARE
  v_signature text;
  v_expected_md5 text;
  v_definition text;
  v_old text := $old$
  IF p_amount IS NULL OR p_amount <> round(p_amount, 2) THEN
$old$;
  v_new text := $new$
  IF p_amount IS NULL
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
$new$;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)',
    'public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'
  ]
  LOOP
    v_expected_md5 := CASE v_signature
      WHEN 'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)'
        THEN '40209effcdc068771dba81813157f286'
      WHEN 'public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'
        THEN '5369d22b611fc0a527b4439a21a3f178'
    END;
    v_definition := pg_get_functiondef(v_signature::regprocedure);

    IF md5(v_definition) <> v_expected_md5 THEN
      RAISE EXCEPTION '% changed after 20260909062006; re-audit before applying',
        v_signature;
    END IF;
    IF length(v_definition) - length(replace(v_definition, v_old, ''))
         <> length(v_old)
       OR position(v_old IN v_definition) <= 0
       OR position('fn_claim_entry_purchase_receipt' IN v_definition)
            <= position(v_old IN v_definition) THEN
      RAISE EXCEPTION '% does not have one pre-claim amount guard', v_signature;
    END IF;

    EXECUTE replace(v_definition, v_old, v_new);
  END LOOP;
END;
$rewrite_amount_doors$;

DO $rewrite_post_commit_receipt$
DECLARE
  v_definition text;
  v_old text := $old$
      IF v_addon.amount IS NULL OR v_addon.amount <= 0
         OR v_addon.amount::text IN ('NaN', 'Infinity', '-Infinity')
         OR (v_addon.resolved_at IS NOT NULL AND
             (v_addon.applied_to_stack IS NULL OR v_addon.refunded IS NULL))
         OR v_addon_result.applied IS NULL OR v_addon_result.applied < 0
         OR v_addon_result.refunded IS NULL OR v_addon_result.refunded < 0
         OR v_addon_result.applied + v_addon_result.refunded IS DISTINCT FROM v_addon.amount
      THEN
$old$;
  v_new text := $new$
      IF v_addon.amount IS NULL OR v_addon.amount <= 0
         OR v_addon.amount::text IN ('NaN', 'Infinity', '-Infinity')
         OR (v_addon.resolved_at IS NOT NULL AND
             (v_addon.applied_to_stack IS NULL OR v_addon.refunded IS NULL))
         OR v_addon_result.applied IS NULL OR v_addon_result.applied < 0
         OR v_addon_result.applied::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_addon_result.applied <> round(v_addon_result.applied, 2)
         OR v_addon_result.refunded IS NULL OR v_addon_result.refunded < 0
         OR v_addon_result.refunded::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_addon_result.refunded <> round(v_addon_result.refunded, 2)
         OR v_addon_result.applied + v_addon_result.refunded
              IS DISTINCT FROM round(v_addon.amount, 2)
      THEN
$new$;
BEGIN
  v_definition := pg_get_functiondef(
    'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure
  );
  IF md5(v_definition) <> '0f9656e8ece4172db2988376c287d10c' THEN
    RAISE EXCEPTION
      'fn_ca_process_hand_post_commit_obligations changed after 20260908175113; re-audit before applying';
  END IF;
  IF length(v_definition) - length(replace(v_definition, v_old, ''))
       <> length(v_old) THEN
    RAISE EXCEPTION
      'post-commit add-on receipt predicate is not the exact reviewed source';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END;
$rewrite_post_commit_receipt$;

DO $old_constraint_contract$
BEGIN
  IF (
    SELECT count(*)
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND c.convalidated IS FALSE
       AND (c.conrelid, c.conname) IN (
         ('public.table_pending_addons'::regclass,
          'table_pending_addons_amount_is_cents'),
         ('public.table_pending_addons'::regclass,
          'table_pending_addons_applied_is_cents'),
         ('public.table_pending_addons'::regclass,
          'table_pending_addons_refunded_is_cents'),
         ('public.table_addon_idempotency'::regclass,
          'table_addon_idempotency_amount_is_cents')
       )
  ) <> 4 THEN
    RAISE EXCEPTION
      '20260909062006 finite-cent predecessor constraints are not all present and NOT VALID';
  END IF;
END;
$old_constraint_contract$;

ALTER TABLE public.table_pending_addons
  DROP CONSTRAINT table_pending_addons_amount_is_cents;
ALTER TABLE public.table_pending_addons
  ADD CONSTRAINT table_pending_addons_amount_is_cents
  CHECK (
    amount IS NULL OR (
      amount::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND amount = round(amount, 2)
    )
  ) NOT VALID;

ALTER TABLE public.table_pending_addons
  DROP CONSTRAINT table_pending_addons_applied_is_cents;
ALTER TABLE public.table_pending_addons
  ADD CONSTRAINT table_pending_addons_applied_is_cents
  CHECK (
    applied_to_stack IS NULL OR (
      applied_to_stack::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND applied_to_stack = round(applied_to_stack, 2)
    )
  ) NOT VALID;

ALTER TABLE public.table_pending_addons
  DROP CONSTRAINT table_pending_addons_refunded_is_cents;
ALTER TABLE public.table_pending_addons
  ADD CONSTRAINT table_pending_addons_refunded_is_cents
  CHECK (
    refunded IS NULL OR (
      refunded::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND refunded = round(refunded, 2)
    )
  ) NOT VALID;

ALTER TABLE public.table_addon_idempotency
  DROP CONSTRAINT table_addon_idempotency_amount_is_cents;
ALTER TABLE public.table_addon_idempotency
  ADD CONSTRAINT table_addon_idempotency_amount_is_cents
  CHECK (
    amount IS NULL OR (
      amount::text NOT IN ('NaN', 'Infinity', '-Infinity')
      AND amount = round(amount, 2)
    )
  ) NOT VALID;

DO $final_contract$
DECLARE
  v_addon text := pg_get_functiondef(
    'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)'::regprocedure
  );
  v_buyin text := pg_get_functiondef(
    'public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure
  );
  v_processor text := pg_get_functiondef(
    'public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure
  );
  v_constraint record;
BEGIN
  IF md5(v_addon) <> 'a98dd67a40c077abb1b9937a955b086c'
     OR md5(v_buyin) <> 'b227e791ae7c17544c8ba02943fe53dc'
     OR md5(v_processor) <> '17c09aa5a76599032467d32740ec5b99' THEN
    RAISE EXCEPTION 'a final money function definition is not the reviewed PG17 source';
  END IF;

  IF position(
       'p_amount::text IN (''NaN'', ''Infinity'', ''-Infinity'')' IN v_addon
     ) <= 0
     OR position(
       'p_amount::text IN (''NaN'', ''Infinity'', ''-Infinity'')' IN v_buyin
     ) <= 0
     OR position('fn_claim_entry_purchase_receipt' IN v_addon)
          <= position('p_amount::text IN' IN v_addon)
     OR position('fn_claim_entry_purchase_receipt' IN v_buyin)
          <= position('p_amount::text IN' IN v_buyin) THEN
    RAISE EXCEPTION 'an amount door is not final-defined with its finite guard before claim';
  END IF;

  IF position(
       'v_addon_result.applied::text IN (''NaN'', ''Infinity'', ''-Infinity'')'
       IN v_processor
     ) <= 0
     OR position(
       'v_addon_result.refunded::text IN (''NaN'', ''Infinity'', ''-Infinity'')'
       IN v_processor
     ) <= 0
     OR position(
       'v_addon_result.applied <> round(v_addon_result.applied, 2)'
       IN v_processor
     ) <= 0
     OR position(
       'v_addon_result.refunded <> round(v_addon_result.refunded, 2)'
       IN v_processor
     ) <= 0
     OR position(
       'IS DISTINCT FROM round(v_addon.amount, 2)'
       IN v_processor
     ) <= 0 THEN
    RAISE EXCEPTION 'post-commit add-on receipt is not final-defined as finite cents';
  END IF;

  FOR v_constraint IN
    SELECT c.conname, c.convalidated,
           pg_get_constraintdef(c.oid, true) AS definition
      FROM pg_constraint c
     WHERE (c.conrelid, c.conname) IN (
       ('public.table_pending_addons'::regclass,
        'table_pending_addons_amount_is_cents'),
       ('public.table_pending_addons'::regclass,
        'table_pending_addons_applied_is_cents'),
       ('public.table_pending_addons'::regclass,
        'table_pending_addons_refunded_is_cents'),
       ('public.table_addon_idempotency'::regclass,
        'table_addon_idempotency_amount_is_cents')
     )
  LOOP
    IF v_constraint.convalidated IS NOT FALSE
       OR position('NaN' IN v_constraint.definition) <= 0
       OR position('Infinity' IN v_constraint.definition) <= 0
       OR position('-Infinity' IN v_constraint.definition) <= 0
       OR position('round(' IN v_constraint.definition) <= 0 THEN
      RAISE EXCEPTION '% is not a NOT VALID finite-cent check: %',
        v_constraint.conname, v_constraint.definition;
    END IF;
  END LOOP;

  IF NOT has_function_privilege(
       'service_role',
       'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_ca_process_hand_post_commit_obligations(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'money function ACLs changed during final definition';
  END IF;
END;
$final_contract$;

COMMIT;
