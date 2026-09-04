-- 20260904192338 re-created fn_ca_find_erased_seat_credits from its live
-- definition without restating its ACL. Production kept the grants (CREATE OR
-- REPLACE preserves them: service_role only, and the body refuses any caller
-- but postgres/service_role), but check-definer-authorization reads the
-- branch, not the catalogue. The ACL, stated: operator and service only.
REVOKE ALL ON FUNCTION public.fn_ca_find_erased_seat_credits(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_find_erased_seat_credits(timestamptz, timestamptz) TO service_role;
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_find_erased_seat_credits(timestamptz, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_find_erased_seat_credits(timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still execute fn_ca_find_erased_seat_credits';
  END IF;
END $$;
