-- A RESTORED VIEW KEEPS THE GRANTS IT HAD, NOT THE ONES THE SCHEMA HANDS OUT.
--
-- Two migrations tonight retyped a column a view was reading, and both used
-- the same pattern: capture the view from the catalogue, DROP it, ALTER the
-- column, re-CREATE it from the captured text, re-GRANT what it held.
--
--   20260906162705  tournament_escrow_shadow  (tournaments.prize_pool etc.)
--   20260907035639  club_agents               (agents.agent_wallet_balance)
--
-- THE RE-GRANT WAS ADDITIVE, AND THIS DATABASE IS NOT. Supabase carries
-- ALTER DEFAULT PRIVILEGES on the public schema for `anon` and
-- `authenticated`, so a view CREATED here is granted to both of them before
-- anything else runs. Restoring the captured grants on top of that leaves the
-- union of the two, not the original. Measured immediately afterwards:
--
--   tournament_escrow_shadow  before  postgres | service_role
--                             after   postgres | service_role | anon=rxtm | authenticated=rxtm
--   club_agents               before  postgres | service_role | anon=rm | authenticated=rm
--                             after   postgres | service_role | anon=rxtm | authenticated=rxtm
--
-- The escrow shadow is the serious one and it is entirely my doing: it was an
-- operator report, readable by the engine and nobody else, and for about four
-- minutes any signed-in browser could select from it. It is
-- `security_invoker=true`, so RLS on the underlying tables still applied to
-- whoever read it, which is why this is a widening rather than a leak of rows
-- a caller could not otherwise reach - but it is a widening I did not intend,
-- did not ask for, and would not have noticed if I had checked only that the
-- view came back.
--
-- The verify blocks in both migrations compared the DEFINITION and the OPTIONS
-- and stopped there. A definition that matches character for character tells
-- you nothing about who may read it. That is the lesson worth keeping: when
-- you put something back, put back everything about it, and assert the part
-- that decides who can see it.
--
-- WHAT THIS RESTORES, exactly as each view held it before it was dropped:
--
--   tournament_escrow_shadow   postgres (owner) and service_role only
--   club_agents                plus anon and authenticated with SELECT and
--                              MAINTAIN, which is what they had - the club
--                              agents page reads it
--
-- REVOKE first, then GRANT, which is the shape the additive version was
-- missing. GRANT and REVOKE do not fire pgrst_ddl_watch (production DDL
-- policy, rule 5), so this costs no schema reload.

BEGIN;

REVOKE ALL ON public.tournament_escrow_shadow FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tournament_escrow_shadow TO service_role;

REVOKE ALL ON public.club_agents FROM PUBLIC, anon, authenticated;
GRANT SELECT, MAINTAIN ON public.club_agents TO anon, authenticated;
GRANT ALL ON public.club_agents TO service_role;

DO $verify$
BEGIN
  IF has_table_privilege('anon', 'public.tournament_escrow_shadow', 'SELECT')
     OR has_table_privilege('authenticated', 'public.tournament_escrow_shadow', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a browser role can still read the escrow shadow';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.tournament_escrow_shadow', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the engine can no longer read the escrow shadow';
  END IF;

  IF NOT has_table_privilege('anon', 'public.club_agents', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.club_agents', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the club agents page can no longer read club_agents';
  END IF;
  IF has_table_privilege('authenticated', 'public.club_agents', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.club_agents', 'TRIGGER') THEN
    RAISE EXCEPTION 'VERIFY FAILED: club_agents still carries privileges it did not have';
  END IF;

  RAISE NOTICE 'VIEW_GRANTS_RESTORED the escrow shadow is engine-only again; club_agents keeps exactly the SELECT it had';
END $verify$;

COMMIT;
