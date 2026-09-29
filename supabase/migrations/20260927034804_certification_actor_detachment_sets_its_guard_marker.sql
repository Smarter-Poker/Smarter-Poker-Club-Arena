-- THE ARCHIVED CERTIFICATION ACTOR DETACHMENT NAMES ITS MAINTENANCE REASON.
--
-- The archive migration moved the guarded detachment before the historical
-- retained-actor branch, but the older marker was still set later in the
-- function. Set the exact transaction-local reason immediately before the
-- actor-only update. The archive equality guard remains the authority; this
-- marker alone cannot admit an update.
-- @live-proof: (SELECT position('certification-cleanup:20260927034716:' in pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) > 0 AND position('ca_test_account_ledger_actor_archive' in pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) > 0 AND has_function_privilege('service_role', 'public.cleanup_reserved_certification_account(uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.cleanup_reserved_certification_account(uuid)', 'EXECUTE'))

BEGIN;

-- unqualified-write-ok: public.chip_ledger because these UPDATE tokens are inert exact function-definition string anchors; the installed function retains its existing WHERE performed_by = p_user_id predicate.
DO $patch$
DECLARE
  v_fn regprocedure := 'public.cleanup_reserved_certification_account(uuid)'::regprocedure;
  v_old text := pg_get_functiondef(v_fn);
  v_new text;
BEGIN
  IF md5(v_old) <> '3f4d071ce514645f1881c31856a92e72' THEN
    RAISE EXCEPTION 'CERT_ACCOUNT_ACTOR_MARKER_PREIMAGE_CHANGED: %', md5(v_old)
      USING ERRCODE = '55000';
  END IF;

  v_new := replace(
    v_old,
    $$  UPDATE public.chip_ledger
     SET performed_by = NULL$$,
    $$  PERFORM set_config(
    'app.ledger_maintenance',
    'certification-cleanup:20260927034716:' || p_user_id::text,
    true
  );

  UPDATE public.chip_ledger
     SET performed_by = NULL$$
  );

  IF v_new = v_old
     OR length(v_new) - length(replace(
          v_new, 'certification-cleanup:20260927034716:', ''))
        <> length('certification-cleanup:20260927034716:') THEN
    RAISE EXCEPTION 'CERT_ACCOUNT_ACTOR_MARKER_PATCH_DID_NOT_ADD_EXACT_REASON'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE v_new;
END
$patch$;

REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;

COMMENT ON FUNCTION public.cleanup_reserved_certification_account(uuid) IS
  'Service-only removal for exact reserved certification identities. Complete audit rows and chip-ledger actor testimony are archived before the disposable identity is deleted; the actor-only detachment sets its guarded transaction-local maintenance reason immediately before the update.';

COMMIT;
