-- 20260829b_weighted_rake_definer_grants.sql
-- Companion to 20260829_weighted_contributed_rake.sql, demanded by
-- check-definer-authorization: the four SECURITY DEFINER writers that
-- migration re-declared must not be reachable from a browser role, because
-- none of them derives an actor from auth.uid() — they are engine/cron
-- surfaces.
--
--   fn_rakeback_recompute_periods  — engine settler recompute path
--   fn_close_settlement_period     — reached by browsers ONLY through
--                                    fn_claim_rakeback (which derives
--                                    auth.uid()) and settle_club_rakeback;
--                                    both are SECURITY DEFINER, so they keep
--                                    working after direct EXECUTE is revoked
--   fn_club_rake_rollup_day        — daily rollup job
--   fn_bbj_rollup_day              — daily rollup job
--
-- PUBLIC is named alongside the roles deliberately: revoking a role while
-- PUBLIC still holds EXECUTE reads as a fix and does nothing.

REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.fn_close_settlement_period(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_settlement_period(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_day(uuid, date) TO service_role;

REVOKE ALL ON FUNCTION public.fn_bbj_rollup_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_rollup_day(uuid, date) TO service_role;
