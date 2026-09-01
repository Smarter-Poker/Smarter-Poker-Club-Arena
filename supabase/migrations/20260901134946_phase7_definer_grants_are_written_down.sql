-- ═══════════════════════════════════════════════════════════════════════════
--  PHASE 7 FOLLOW-UP: THE DEFINER GRANTS ARE WRITTEN DOWN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Applied to production as version 20260901134946 and, until this file, NOT
-- COMMITTED - which is the exact condition `check-applied-migrations-are-recorded`
-- exists to catch: a database rebuilt from this repo would not have had it.
-- Written down here after the audit sweep found it missing.
--
-- WHY IT WAS NEEDED. 20260901133348 re-created three SECURITY DEFINER functions.
-- The database's autorevoke event trigger strips PUBLIC and anon from every new
-- definer function, so production was tight the moment they were created - and
-- the FILE said nothing about it. `check-definer-authorization` reads the file
-- rather than the database, and it is right to: an intention that lives only in
-- a trigger is an intention the next reader cannot see, and the next reader is
-- who decides whether a widening is safe.
--
-- All three are operator surface, not player surface:
--
--   get_daily_commission_summary   answers for whichever agent id it is given,
--                                  so an authenticated caller could read another
--                                  agent's day-by-day earnings with an id they
--                                  happen to know. Its one caller is the World
--                                  Hub trends endpoint, which holds the service
--                                  role.
--   fn_union_money_path_check      an estate guard reporting which money paths
--                                  have stopped reaching club scope. Diagnostics.
--   fn_ca_gdpr_financial_precheck  reports another account's balances, seats,
--                                  tickets and unclaimed commission by user id.
--                                  Only the deletion pipeline calls it.
REVOKE ALL ON FUNCTION public.get_daily_commission_summary(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_commission_summary(uuid, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.fn_union_money_path_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_money_path_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_gdpr_financial_precheck(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_gdpr_financial_precheck(uuid) TO service_role;
