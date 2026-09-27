-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420050638 "phase40_grant_fn_send_message_to_authenticated"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ed24c9ecebffce832e81361e84b8882c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_send_message is SECURITY DEFINER with internal participant check — safe to grant.
-- Missing grant would break any frontend caller using RPC instead of direct INSERT.
GRANT EXECUTE ON FUNCTION public.fn_send_message(uuid, uuid, text, text, jsonb)
  TO authenticated;
