-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260806175123 "fn_raise_financial_alert_revoke_anon"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 57c3e1b4ccff2581a256ad4029215b4f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions to
-- anon as well as authenticated, so the REVOKE ... FROM public in the previous
-- migration did not remove it. The function already refuses a NULL auth.uid(),
-- but an unauthenticated role should not hold the grant at all.
REVOKE EXECUTE ON FUNCTION public.fn_raise_financial_alert(text, text, text, jsonb) FROM anon;
