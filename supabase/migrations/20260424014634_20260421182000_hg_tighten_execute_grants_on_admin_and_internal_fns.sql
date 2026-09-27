-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424014634 "20260421182000_hg_tighten_execute_grants_on_admin_and_internal_fns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7b049447ebca43e36de208b88daf8914 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug hunt: fn EXECUTE grants to PUBLIC/anon were inherited from default
-- CREATE FUNCTION behavior. Tighten on 6 admin-only + internal helpers.
--
-- Note: internal body checks still gate access; these REVOKEs are
-- defense-in-depth, closing the "can-call-from-REST" surface for fns
-- that shouldn't appear in anon's PostgREST catalog at all.

-- Admin moderator actions — users/anon should not be able to PostgREST-call these.
-- Auth users can still call via the API route (service_role path).
REVOKE EXECUTE ON FUNCTION public.resolve_home_content_report(uuid, text, text, uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.review_home_ban_appeal(uuid, text, text, uuid) FROM anon, authenticated, PUBLIC;
-- Re-grant to authenticated so our existing frontend-side admin RPC path still works
-- (admin role is checked INSIDE the function body).
GRANT EXECUTE ON FUNCTION public.resolve_home_content_report(uuid, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_home_ban_appeal(uuid, text, text, uuid) TO authenticated;

-- GDPR content scrubber — authz checks inside, but deny anon outright.
REVOKE EXECUTE ON FUNCTION public.fn_anonymize_hg_user_content(uuid, uuid) FROM anon, PUBLIC;

-- Internal helper: fn_try_consume_home_rate_limit. Exposed publicly a
-- rate-limit-consume call with arbitrary endpoint strings could be
-- abused to stuff the rate-limit table. Lock to service_role only.
REVOKE EXECUTE ON FUNCTION public.fn_try_consume_home_rate_limit(uuid, text, integer, integer) FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_try_consume_home_rate_limit(uuid, text, integer, integer) TO service_role;

-- Internal cleanup helpers
REVOKE EXECUTE ON FUNCTION public.fn_prune_stale_rate_limits() FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_prune_stale_rate_limits() TO service_role;

-- Trigger-helper functions — triggers invoke them regardless of grants,
-- but cleanliness / smaller PostgREST surface. Revoke from PUBLIC.
REVOKE EXECUTE ON FUNCTION public.fn_hg_enforce_quotas_on_write() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_hg_require_onboarded_on_write() FROM anon, authenticated, PUBLIC;

-- fn_emit_home_notification is called inside other SECDEF fns. Keep
-- service_role-only (already correct). No change.
