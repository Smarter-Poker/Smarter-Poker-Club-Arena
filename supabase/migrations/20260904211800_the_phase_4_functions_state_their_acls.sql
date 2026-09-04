-- The Phase 4 migrations (20260904210917, 20260904211714) re-created three
-- SECURITY DEFINER functions from their live definitions without restating
-- their ACLs: fn_ca_is_midway_scope, fn_rake_bbj_audit and
-- fn_bbj_conservation_check. Production kept the grants (service_role only;
-- CREATE OR REPLACE preserves them), but check-definer-authorization reads
-- the branch, not the catalogue. The ACLs, stated: service only.
REVOKE ALL ON FUNCTION public.fn_ca_is_midway_scope(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_midway_scope(uuid, uuid, uuid, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_rake_bbj_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rake_bbj_audit(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_conservation_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_conservation_check() TO service_role;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['public.fn_ca_is_midway_scope(uuid, uuid, uuid, uuid, jsonb)', 'public.fn_rake_bbj_audit(integer)', 'public.fn_bbj_conservation_check()']) f LOOP
    IF has_function_privilege('anon', r.f, 'EXECUTE') OR has_function_privilege('authenticated', r.f, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can still execute %', r.f;
    END IF;
  END LOOP;
END $$;
