-- 20260904120601 re-created fn_ca_settle_hand_stacks_absolute from its live
-- definition without restating its ACL. Production kept the grants (CREATE OR
-- REPLACE preserves them), but check-definer-authorization reads the branch,
-- not the catalogue, and a SECURITY DEFINER writer with no stated ACL reads
-- as reachable from a browser. The ACL, stated: engine and service only.
REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric, text, numeric) TO service_role;
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric, text, numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric, text, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still execute fn_ca_settle_hand_stacks_absolute';
  END IF;
END $$;
