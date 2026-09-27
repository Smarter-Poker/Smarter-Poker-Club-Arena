-- LEGACY CREATE-CLUB CERTIFICATES USE THE GUARDED CLEANUP DOOR.
--
-- The original direct-RPC certificate used one dedicated namespace but tried
-- to delete Auth directly. Append-only evidence correctly refused that path,
-- leaving certification identities after their clubs had been retired. Admit
-- only that exact historical namespace to the existing guarded cleanup door;
-- all ordinary accounts remain refused and the platform-freeze guard remains.
-- @live-proof: (SELECT position('club-create-cert-%@smarter-poker.invalid' in pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) > 0 AND has_function_privilege('service_role', 'public.cleanup_reserved_certification_account(uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.cleanup_reserved_certification_account(uuid)', 'EXECUTE'))

DO $patch$
DECLARE
  v_fn regprocedure := 'public.cleanup_reserved_certification_account(uuid)'::regprocedure;
  v_old text := pg_get_functiondef(v_fn);
  v_new text;
BEGIN
  IF md5(v_old) <> '5097fd85191359890d70eb84c4ce507c' THEN
    RAISE EXCEPTION 'CERT_ACCOUNT_CLEANUP_PREIMAGE_CHANGED: %', md5(v_old)
      USING ERRCODE = '55000';
  END IF;

  v_new := replace(
    v_old,
    $$IF v_email NOT LIKE 'ca-customization-cert-%@example.invalid' THEN$$,
    $$IF v_email NOT LIKE 'ca-customization-cert-%@example.invalid'
       AND v_email NOT LIKE 'club-create-cert-%@smarter-poker.invalid' THEN$$
  );

  IF v_new = v_old
     OR length(v_new) - length(replace(
          v_new, 'club-create-cert-%@smarter-poker.invalid', ''))
        <> length('club-create-cert-%@smarter-poker.invalid') THEN
    RAISE EXCEPTION 'CERT_ACCOUNT_CLEANUP_PATCH_DID_NOT_ADD_ONE_LEGACY_NAMESPACE'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE v_new;
END
$patch$;

REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;

COMMENT ON FUNCTION public.cleanup_reserved_certification_account(uuid) IS
  'Service-only guarded removal for the exact UI and legacy direct certification namespaces. Refuses ordinary accounts and all cleanup while the platform is frozen.';
