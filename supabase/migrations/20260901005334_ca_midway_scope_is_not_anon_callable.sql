-- Byte-exact mirror of the applied production migration.

-- fn_ca_is_midway_scope was created with the default PUBLIC execute grant:
-- SECURITY DEFINER, past RLS, callable by a caller with no account. It only
-- answers a scope question, but an anon-probeable definer oracle over club
-- and union membership is still surface. Internal callers run as the owner
-- and need no grant.
REVOKE ALL ON FUNCTION public.fn_ca_is_midway_scope(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_midway_scope(uuid, uuid, uuid, uuid, jsonb) TO service_role;;
