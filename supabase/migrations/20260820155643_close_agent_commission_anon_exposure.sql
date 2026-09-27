-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820155643 "close_agent_commission_anon_exposure"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5abacb476fb46c1220bec0220f664e6f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Close the three the new standing guard just found (2026-08-20)
--
-- fn_anon_exposure_check fired immediately on first run — before the test
-- grant I used to prove it works — and surfaced three more functions callable
-- by `anon` that my manual sweep had missed because they are not named
-- fn_union_*:
--
--   fn_enforce_agent_commission_bounds()  SECURITY DEFINER, no auth check.
--     A trigger-support function; nothing should be calling it directly at
--     all, let alone unauthenticated. Closed completely.
--
--   fn_get_agent_commission_summary(p_agent_id)   SECURITY INVOKER
--   get_agent_commission_history(p_agent_id, ...) SECURITY INVOKER
--     Lower risk, because SECURITY INVOKER means they run with the caller's
--     rights and RLS still applies — an anon caller gets no rows rather than
--     data. But they take an arbitrary agent id and there is no reason for a
--     logged-out visitor to reach them at all, so `anon` is revoked.
--     fn_get_agent_commission_summary is called from the browser
--     (AgentCommissionDashboard.tsx), so `authenticated` is retained;
--     get_agent_commission_history has no application caller but is the same
--     shape, so it keeps `authenticated` too rather than risk breaking an
--     unindexed call path.
--
-- This is the guard earning its place on the first run: a one-off sweep found
-- 23, and the standing check immediately found 4 more (including one added by
-- another agent while I was working).
REVOKE EXECUTE ON FUNCTION public.fn_enforce_agent_commission_bounds() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_get_agent_commission_summary(p_agent_id uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_agent_commission_history(p_agent_id uuid, p_limit integer) FROM PUBLIC, anon;
