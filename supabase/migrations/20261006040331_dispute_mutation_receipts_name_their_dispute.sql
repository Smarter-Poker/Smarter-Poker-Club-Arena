-- 20261006040331_dispute_mutation_receipts_name_their_dispute.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- The five dispute mutations returned anonymous JSON. A client could verify
-- neither that a successful outcome named the requested dispute nor that its
-- result matched the transition it then painted. Preserve each installed
-- implementation as an owner-only core and put a request-bound dispute_id on
-- every public receipt. The application still reads the row back and verifies
-- the exact resulting status before reporting success.
--
-- @live-proof: (SELECT count(*) = 5 AND bool_and(pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef AND p.provolatile = 'v' AND p.proparallel = 'u' AND pg_get_function_result(p.oid) = 'jsonb' AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' AND p.proconfig::text = CASE WHEN p.oid = 'public.fn_resolve_dispute(uuid,text,text,numeric)'::regprocedure THEN '{"search_path=public, extensions"}' ELSE '{search_path=public}' END AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND position('''dispute_id''' in p.prosrc) > 0) AND NOT EXISTS (SELECT 1 FROM pg_proc c WHERE c.oid = ANY(ARRAY['public.fn_dispute_submit_receipt_core_20261006(text,text,uuid,numeric,text)'::regprocedure,'public.fn_dispute_withdraw_receipt_core_20261006(uuid)'::regprocedure,'public.fn_dispute_start_review_receipt_core_20261006(uuid)'::regprocedure,'public.fn_resolve_dispute_receipt_core_20261006(uuid,text,text,numeric)'::regprocedure,'public.fn_dispute_escalate_receipt_core_20261006(uuid,text)'::regprocedure]) AND (has_function_privilege('authenticated', c.oid, 'EXECUTE') OR has_function_privilege('service_role', c.oid, 'EXECUTE') OR has_function_privilege('anon', c.oid, 'EXECUTE'))) AND EXISTS (SELECT 1 FROM public.ca_money_rpc_registry r WHERE r.proname = 'fn_resolve_dispute_receipt_core_20261006' AND r.status = 'approved') FROM pg_proc p WHERE p.oid = ANY(ARRAY['public.fn_dispute_submit(text,text,uuid,numeric,text)'::regprocedure,'public.fn_dispute_withdraw(uuid)'::regprocedure,'public.fn_dispute_start_review(uuid)'::regprocedure,'public.fn_resolve_dispute(uuid,text,text,numeric)'::regprocedure,'public.fn_dispute_escalate(uuid,text)'::regprocedure]))
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $dispute_receipt_preimage$
DECLARE
  v_signature regprocedure;
  v_body text;
  v_expected_prosrc_md5 text;
  v_expected_definition_md5 text;
BEGIN
  IF to_regprocedure('public.fn_dispute_submit_receipt_core_20261006(text,text,uuid,numeric,text)') IS NOT NULL
     OR to_regprocedure('public.fn_dispute_withdraw_receipt_core_20261006(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_dispute_start_review_receipt_core_20261006(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_resolve_dispute_receipt_core_20261006(uuid,text,text,numeric)') IS NOT NULL
     OR to_regprocedure('public.fn_dispute_escalate_receipt_core_20261006(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'DISPUTE_RECEIPT_CORE_NAME_COLLISION';
  END IF;

  FOR v_signature, v_expected_prosrc_md5, v_expected_definition_md5 IN
    SELECT *
      FROM (VALUES
        (
          'public.fn_dispute_submit(text,text,uuid,numeric,text)'::regprocedure,
          'ab840fc0effa6e0311edbfdb7fea80eb'::text,
          '8a452fbe914ff31573b150256ae8b627'::text
        ),
        (
          'public.fn_dispute_withdraw(uuid)'::regprocedure,
          '5ae9b29dd8aa017a2de491f00e4a57fd'::text,
          'dd43749c39a2a5ed7e47b1f76e94e519'::text
        ),
        (
          'public.fn_dispute_start_review(uuid)'::regprocedure,
          '83150bbcf8384879c5a5722a71157fa6'::text,
          'b8b36f4a2cb2d1d71ea325a27230c7ea'::text
        ),
        (
          'public.fn_resolve_dispute(uuid,text,text,numeric)'::regprocedure,
          'c3d4178a49d11c40289b4700bc523e4b'::text,
          'ce3e71513f10822e42517b3a7e816f67'::text
        ),
        (
          'public.fn_dispute_escalate(uuid,text)'::regprocedure,
          '7c9eb137108a2022f408d849d0070593'::text,
          '5b873bd9d3f55597bae19a0075a9bc8f'::text
        )
      ) AS expected(signature, prosrc_md5, definition_md5)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_proc p
       WHERE p.oid = v_signature
         AND md5(p.prosrc) = v_expected_prosrc_md5
         AND md5(pg_get_functiondef(p.oid)) = v_expected_definition_md5
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proparallel = 'u'
         AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
         AND pg_get_function_result(p.oid) = 'jsonb'
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION
        'DISPUTE_RECEIPT_PREIMAGE_DRIFT: % (prosrc %, definition %)',
        v_signature,
        (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_signature),
        (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid = v_signature);
    END IF;
  END LOOP;

  IF (SELECT p.proconfig::text FROM pg_proc p
       WHERE p.oid = 'public.fn_resolve_dispute(uuid,text,text,numeric)'::regprocedure)
       <> '{"search_path=public, extensions"}'
     OR EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = ANY(ARRAY[
          'public.fn_dispute_submit(text,text,uuid,numeric,text)'::regprocedure,
          'public.fn_dispute_withdraw(uuid)'::regprocedure,
          'public.fn_dispute_start_review(uuid)'::regprocedure,
          'public.fn_dispute_escalate(uuid,text)'::regprocedure
        ])
          AND p.proconfig::text <> '{search_path=public}'
     ) THEN
    RAISE EXCEPTION 'DISPUTE_RECEIPT_SEARCH_PATH_DRIFT';
  END IF;

  SELECT p.prosrc INTO STRICT v_body
    FROM pg_proc p
   WHERE p.oid = 'public.fn_dispute_submit(text,text,uuid,numeric,text)'::regprocedure;
  IF position('INSERT INTO public.disputes' in v_body) = 0
     OR position('''status'', ''open''' in v_body) = 0 THEN
    RAISE EXCEPTION 'DISPUTE_SUBMIT_BODY_DRIFT';
  END IF;

  SELECT p.prosrc INTO STRICT v_body
    FROM pg_proc p
   WHERE p.oid = 'public.fn_dispute_withdraw(uuid)'::regprocedure;
  IF position('status = ''withdrawn''' in v_body) = 0 THEN
    RAISE EXCEPTION 'DISPUTE_WITHDRAW_BODY_DRIFT';
  END IF;

  SELECT p.prosrc INTO STRICT v_body
    FROM pg_proc p
   WHERE p.oid = 'public.fn_dispute_start_review(uuid)'::regprocedure;
  IF position('status = ''under_review''' in v_body) = 0
     OR position('assigned_to = auth.uid()' in v_body) = 0 THEN
    RAISE EXCEPTION 'DISPUTE_START_REVIEW_BODY_DRIFT';
  END IF;

  SELECT p.prosrc INTO STRICT v_body
    FROM pg_proc p
   WHERE p.oid = 'public.fn_resolve_dispute(uuid,text,text,numeric)'::regprocedure;
  IF position('status = ''resolved''' in v_body) = 0
     OR position('atomic_credit_wallet_and_log' in v_body) = 0
     OR position('atomic_deduct_wallet_and_log' in v_body) = 0 THEN
    RAISE EXCEPTION 'DISPUTE_RESOLVE_BODY_DRIFT';
  END IF;

  SELECT p.prosrc INTO STRICT v_body
    FROM pg_proc p
   WHERE p.oid = 'public.fn_dispute_escalate(uuid,text)'::regprocedure;
  IF position('status = ''escalated''' in v_body) = 0 THEN
    RAISE EXCEPTION 'DISPUTE_ESCALATE_BODY_DRIFT';
  END IF;
END
$dispute_receipt_preimage$;

ALTER FUNCTION public.fn_dispute_submit(text,text,uuid,numeric,text)
  RENAME TO fn_dispute_submit_receipt_core_20261006;
ALTER FUNCTION public.fn_dispute_withdraw(uuid)
  RENAME TO fn_dispute_withdraw_receipt_core_20261006;
ALTER FUNCTION public.fn_dispute_start_review(uuid)
  RENAME TO fn_dispute_start_review_receipt_core_20261006;
ALTER FUNCTION public.fn_resolve_dispute(uuid,text,text,numeric)
  RENAME TO fn_resolve_dispute_receipt_core_20261006;
ALTER FUNCTION public.fn_dispute_escalate(uuid,text)
  RENAME TO fn_dispute_escalate_receipt_core_20261006;

REVOKE ALL ON FUNCTION public.fn_dispute_submit_receipt_core_20261006(text,text,uuid,numeric,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_dispute_withdraw_receipt_core_20261006(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_dispute_start_review_receipt_core_20261006(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_resolve_dispute_receipt_core_20261006(uuid,text,text,numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_dispute_escalate_receipt_core_20261006(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_dispute_submit(
  p_target_type text,
  p_target_id text,
  p_club_id uuid,
  p_amount numeric,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  v_out := public.fn_dispute_submit_receipt_core_20261006(
    p_target_type, p_target_id, p_club_id, p_amount, p_reason
  );
  IF jsonb_typeof(v_out) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'dispute submit core returned a malformed receipt';
  END IF;
  RETURN v_out || jsonb_build_object('dispute_id', coalesce(v_out->'dispute_id', 'null'::jsonb));
END;
$function$;

CREATE FUNCTION public.fn_dispute_withdraw(p_dispute_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  v_out := public.fn_dispute_withdraw_receipt_core_20261006(p_dispute_id);
  IF jsonb_typeof(v_out) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'dispute withdraw core returned a malformed receipt';
  END IF;
  RETURN v_out || jsonb_build_object('dispute_id', p_dispute_id);
END;
$function$;

CREATE FUNCTION public.fn_dispute_start_review(p_dispute_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  v_out := public.fn_dispute_start_review_receipt_core_20261006(p_dispute_id);
  IF jsonb_typeof(v_out) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'dispute review core returned a malformed receipt';
  END IF;
  RETURN v_out || jsonb_build_object('dispute_id', p_dispute_id);
END;
$function$;

CREATE FUNCTION public.fn_resolve_dispute(
  p_dispute_id uuid,
  p_resolution text,
  p_adjustment_type text DEFAULT 'none',
  p_adjustment_amount numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_out jsonb;
BEGIN
  v_out := public.fn_resolve_dispute_receipt_core_20261006(
    p_dispute_id, p_resolution, p_adjustment_type, p_adjustment_amount
  );
  IF jsonb_typeof(v_out) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'dispute resolver core returned a malformed receipt';
  END IF;
  IF v_out->'ok' = 'true'::jsonb THEN
    v_out := v_out || jsonb_build_object('status', 'resolved');
  END IF;
  RETURN v_out || jsonb_build_object('dispute_id', p_dispute_id);
END;
$function$;

CREATE FUNCTION public.fn_dispute_escalate(
  p_dispute_id uuid,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_out jsonb;
BEGIN
  v_out := public.fn_dispute_escalate_receipt_core_20261006(p_dispute_id, p_note);
  IF jsonb_typeof(v_out) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'dispute escalation core returned a malformed receipt';
  END IF;
  RETURN v_out || jsonb_build_object('dispute_id', p_dispute_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_dispute_submit(text,text,uuid,numeric,text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_dispute_withdraw(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_dispute_start_review(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_resolve_dispute(uuid,text,text,numeric)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_dispute_escalate(uuid,text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_dispute_submit(text,text,uuid,numeric,text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_dispute_withdraw(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_dispute_start_review(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_dispute(uuid,text,text,numeric)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_dispute_escalate(uuid,text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_dispute_submit(text,text,uuid,numeric,text) IS
  'Files a dispute for the signed-in submitter and returns a literal outcome bound to the new or existing dispute id.';
COMMENT ON FUNCTION public.fn_dispute_withdraw(uuid) IS
  'Withdraws the signed-in submitter dispute and returns a literal outcome bound to the requested dispute id.';
COMMENT ON FUNCTION public.fn_dispute_start_review(uuid) IS
  'Moves an authorized club dispute into review and returns a literal outcome bound to the requested dispute id.';
COMMENT ON FUNCTION public.fn_resolve_dispute(uuid,text,text,numeric) IS
  'Atomically resolves and optionally adjusts a club dispute, capped at its recorded amount, with a request-bound receipt.';
COMMENT ON FUNCTION public.fn_dispute_escalate(uuid,text) IS
  'Escalates an authorized club dispute and returns a literal outcome bound to the requested dispute id.';

INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES (
  'fn_resolve_dispute_receipt_core_20261006',
  'approved',
  'Private retained dispute-resolution money core renamed from fn_resolve_dispute by 20261006040331. Called only by the request-bound fn_resolve_dispute wrapper; it retains club-admin authority, disputed-amount cap, atomic wallet journal writes and all-or-nothing status transition. No API role has direct EXECUTE.'
) ON CONFLICT(proname) DO UPDATE
  SET status = EXCLUDED.status,
      notes = EXCLUDED.notes;

DO $dispute_receipt_postimage$
DECLARE
  v_signature regprocedure;
  v_body text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_dispute_submit(text,text,uuid,numeric,text)'::regprocedure,
    'public.fn_dispute_withdraw(uuid)'::regprocedure,
    'public.fn_dispute_start_review(uuid)'::regprocedure,
    'public.fn_resolve_dispute(uuid,text,text,numeric)'::regprocedure,
    'public.fn_dispute_escalate(uuid,text)'::regprocedure
  ] LOOP
    SELECT p.prosrc INTO STRICT v_body
      FROM pg_proc p
     WHERE p.oid = v_signature
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 'v'
       AND p.proparallel = 'u'
       AND pg_get_function_result(p.oid) = 'jsonb'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE');
    IF position('''dispute_id''' in v_body) = 0 THEN
      RAISE EXCEPTION 'DISPUTE_RECEIPT_POSTIMAGE_DRIFT: %', v_signature;
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated', 'public.fn_dispute_submit_receipt_core_20261006(text,text,uuid,numeric,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_dispute_submit_receipt_core_20261006(text,text,uuid,numeric,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_dispute_withdraw_receipt_core_20261006(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_dispute_withdraw_receipt_core_20261006(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_dispute_start_review_receipt_core_20261006(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_dispute_start_review_receipt_core_20261006(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_resolve_dispute_receipt_core_20261006(uuid,text,text,numeric)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_resolve_dispute_receipt_core_20261006(uuid,text,text,numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_dispute_escalate_receipt_core_20261006(uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_dispute_escalate_receipt_core_20261006(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'DISPUTE_RECEIPT_CORE_BYPASS';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.ca_money_rpc_registry
     WHERE proname = 'fn_resolve_dispute_receipt_core_20261006'
       AND status = 'approved'
  ) THEN
    RAISE EXCEPTION 'DISPUTE_RESOLUTION_CORE_UNREGISTERED';
  END IF;
END
$dispute_receipt_postimage$;

COMMIT;
