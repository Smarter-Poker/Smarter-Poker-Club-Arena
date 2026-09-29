-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725162508 "fix_health_views_security_definer"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 40a5a3bbfc43b61a01a27bb134a01b46 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- [2026-07-25] signup_health_view / auth_health_view were security_invoker=true,
-- so the service-role caller (via /api/health/signup and the admin dashboards)
-- hit "permission denied for table users" on auth.users and the endpoint 500'd
-- every call — a monitoring blind spot that helped signup outages stay invisible.
-- Both views expose ONLY aggregate counts + max-timestamps (no PII rows) and are
-- already gated behind the service role / admin, so running them as their
-- postgres owner (which can read auth.users) is safe and correct.
ALTER VIEW public.signup_health_view SET (security_invoker = false);
ALTER VIEW public.auth_health_view SET (security_invoker = false);
