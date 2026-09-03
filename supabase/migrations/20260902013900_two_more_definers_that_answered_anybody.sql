-- ═══════════════════════════════════════════════════════════════════════════
-- TWO MORE DEFINERS THAT ANSWERED ANYBODY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found by sweeping for the SHAPE of the hole closed in
-- 20260902011456_an_agents_book_is_not_public_reading: a SECURITY DEFINER
-- function in the agent / commission / credit family, granted EXECUTE to
-- `authenticated`, that takes somebody else's id and never consults auth.uid()
-- or any role helper. Two more had it.
--
-- Neither is fixed with a guard, because neither has a caller that needs one.
--
-- 1. `sum_agent_volume(p_club_id, p_agent_id, p_start)` sums ABS(amount) from
--    action_audit_logs for one member. Any logged-in user could ask it about
--    any other member in any club and be told their transaction volume. It has
--    ZERO callers in the database and exactly one in either repo:
--    `pages/api/club-arena/agent-analytics.js`, through `getSupabase()` - the
--    SERVICE role. `authenticated` never needed it.
--
-- 2. `fn_club_rakeback_margin_violations(p_club_id)` returns every
--    manager-to-manager and manager-to-player edge in a club whose margin is
--    under ten points, and every player under the ten percent floor - which
--    means it returns THE CLUB'S ENTIRE RATE CARD: each agent's user id, role
--    and commission_rate, and each player's user id and rakeback_rate. Any
--    logged-in user with a club id could read a competitor club's commercial
--    terms. It has ZERO callers anywhere: no function, no route, no component.
--    Only the CI schema manifest names it.
--
-- The fix is therefore the smallest one that closes both: take EXECUTE away
-- from `authenticated`. They keep working for the service role, which is the
-- only thing that was ever calling them, and the margin report stays available
-- as an operator query.
--
-- GRANT/REVOKE does NOT fire pgrst_ddl_watch, so this migration causes no
-- PostgREST schema-cache reload and no PGRST002 exposure. CLAUDE.md,
-- "Production DDL policy", rule 5.
--
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
--   GRANT EXECUTE ON FUNCTION public.sum_agent_volume(uuid, uuid, timestamptz)
--     TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_club_rakeback_margin_violations(uuid)
--     TO authenticated;
--   -- Do this only alongside a real guard. Restoring the grant on its own
--   -- restores the disclosure.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.sum_agent_volume(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sum_agent_volume(uuid, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.sum_agent_volume(uuid, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sum_agent_volume(uuid, uuid, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.fn_club_rakeback_margin_violations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_club_rakeback_margin_violations(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_club_rakeback_margin_violations(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_rakeback_margin_violations(uuid) TO service_role;

COMMENT ON FUNCTION public.sum_agent_volume(uuid, uuid, timestamptz) IS
  'One member''s audit-log volume. SERVICE ROLE ONLY - it takes another person''s user id and has no guard of its own. Its only caller is pages/api/club-arena/agent-analytics.js, which runs as the service role. Do not grant this to authenticated without writing a guard first.';

COMMENT ON FUNCTION public.fn_club_rakeback_margin_violations(uuid) IS
  'Rakeback ladder violations for one club. SERVICE ROLE ONLY - it returns every agent commission_rate and every player rakeback_rate in the club, which is the club''s whole rate card. Do not grant this to authenticated without writing a guard first.';

DO $verify$
BEGIN
  IF has_function_privilege('authenticated',
       'public.sum_agent_volume(uuid,uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still execute sum_agent_volume';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_club_rakeback_margin_violations(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still execute fn_club_rakeback_margin_violations';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.sum_agent_volume(uuid,uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on sum_agent_volume, which agent-analytics needs';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_club_rakeback_margin_violations(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on fn_club_rakeback_margin_violations';
  END IF;
  RAISE NOTICE 'two more definers that answered anybody: applied and verified';
END
$verify$;
