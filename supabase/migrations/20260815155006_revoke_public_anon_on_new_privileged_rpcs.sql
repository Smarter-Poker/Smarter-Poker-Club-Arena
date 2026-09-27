-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815155006 "revoke_public_anon_on_new_privileged_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f7bc55d4e65045cdb886c5923d93115c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Least privilege for the RPCs added on 2026-08-15.
-- New functions inherit an EXECUTE grant to PUBLIC (and this project's default
-- privileges also grant anon), so both were reachable by unauthenticated
-- callers. Neither is exploitable -- each derives its actor from auth.uid() and
-- refuses when it is NULL -- but an anonymous caller has no business reaching a
-- chip-removal or conversation-creation RPC at all.
REVOKE EXECUTE ON FUNCTION public.fn_admin_remove_player_chips(uuid, uuid, numeric, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_admin_remove_player_chips(uuid, uuid, numeric, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_admin_remove_player_chips(uuid, uuid, numeric, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fn_get_or_create_conversation(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_get_or_create_conversation(uuid, uuid, uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_get_or_create_conversation(uuid, uuid, uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fn_get_user_conversations(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_get_user_conversations(uuid, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_get_user_conversations(uuid, uuid) TO authenticated, service_role;
