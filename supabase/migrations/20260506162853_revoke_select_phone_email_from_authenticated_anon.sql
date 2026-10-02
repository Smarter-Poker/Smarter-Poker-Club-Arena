-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506162853 "revoke_select_phone_email_from_authenticated_anon"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4d8593487ae1b06523557350f864afd4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Authenticated-side privacy hardening
-- ─────────────────────────────────────────────────────────────────────────
-- After centralizing all client-side profile reads through either:
--   • SAFE_PROFILE_COLUMNS (constant, no phone/email)
--   • get_my_full_profile() RPC (SECURITY DEFINER self-read)
--   • get_public_profile_by_username() RPC (SECURITY DEFINER, anon)
-- ...we can REVOKE direct column SELECT on phone/email from authenticated.
--
-- This is a hard wall: a malicious authenticated user opening browser
-- console and running supabase.from('profiles').select('phone') against
-- another user — or even themselves — will receive HTTP 403 from PostgREST.
-- The only paths that work are the two RPCs above, both of which return
-- only the caller's OWN phone/email.
--
-- service_role retains full access (server-side APIs unaffected).
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE SELECT (phone, email) ON TABLE public.profiles FROM authenticated;
REVOKE SELECT (phone, email) ON TABLE public.profiles FROM anon;
REVOKE SELECT (phone, email) ON TABLE public.profiles FROM PUBLIC;
