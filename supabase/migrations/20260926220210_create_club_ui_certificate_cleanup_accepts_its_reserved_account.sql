-- THE CREATE-CLUB UI CERTIFICATE CAN RETIRE ITS OWN RESERVED CLUB.
--
-- The shared browser certificate intentionally uses the older, tightly-scoped
-- ca-customization-cert-postdeploy-* @example.invalid account namespace because
-- cleanup_reserved_certification_account only deletes that exact namespace.
-- fn_ca_retire_certification_club previously recognized only the newer
-- @smarter-poker.invalid certificate domain, so the UI-created club could not
-- be retired before its account cleanup. Admit only the exact shared fixture
-- namespace in addition to the existing certificate domain.
-- @live-proof: (SELECT position('ca-customization-cert-postdeploy-%@example.invalid' in pg_get_functiondef('public.fn_ca_retire_certification_club(uuid,text)'::regprocedure)) > 0 AND has_function_privilege('service_role', 'public.fn_ca_retire_certification_club(uuid,text)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fn_ca_retire_certification_club(uuid,text)', 'EXECUTE'))

DO $patch$
DECLARE
  v_fn regprocedure := 'public.fn_ca_retire_certification_club(uuid,text)'::regprocedure;
  v_old text := pg_get_functiondef(v_fn);
  v_new text;
BEGIN
  IF md5(v_old) <> 'a932ec8f2f18d186499f4118e2f582b4' THEN
    RAISE EXCEPTION 'CREATE_CLUB_CERT_RETIRE_PREIMAGE_CHANGED: %', md5(v_old)
      USING ERRCODE = '55000';
  END IF;

  v_new := replace(
    v_old,
    $$AND COALESCE(u.email, '') NOT LIKE '%@smarter-poker.invalid';$$,
    $$AND NOT (
       COALESCE(u.email, '') LIKE '%@smarter-poker.invalid'
       OR COALESCE(u.email, '') LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
     );$$
  );

  IF v_new = v_old
     OR length(v_new) - length(replace(v_new,
          'ca-customization-cert-postdeploy-%@example.invalid', ''))
        <> length('ca-customization-cert-postdeploy-%@example.invalid') THEN
    RAISE EXCEPTION 'CREATE_CLUB_CERT_RETIRE_PATCH_DID_NOT_PRODUCE_ONE_RESERVED_NAMESPACE'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE v_new;
END
$patch$;

REVOKE ALL ON FUNCTION public.fn_ca_retire_certification_club(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_retire_certification_club(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_retire_certification_club(uuid, text) IS
  'Service-only certification cleanup. Accepts only guarded Crest Cert clubs whose members use the dedicated smarter-poker.invalid domain or the exact shared UI postdeploy fixture namespace.';
