-- 20260908021100_horse_reports_dead_alias_and_join_blockers_are_not_player_readable
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 02:11:00 UTC.
--
-- ═══════════════════════════════════════════════════════════════════════════════
--  THREE MORE WAYS A SIGNED-IN PLAYER COULD LEARN WHO THE HORSES ARE
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-02, binding: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT
-- OUR CODE OR USE A DEVELOPER TOOL AND FIND THIS OUT."
--
-- The 2026-09-02 closure took `profiles.is_horse` off the player's grants,
-- masked it in the four SECURITY DEFINER RPCs that return it, and cut it from
-- the Realtime column lists. A sweep on 2026-09-07 of EVERY relation and
-- function a player may read found three doors it did not reach. Each was
-- verified from the database, as `authenticated` with a real non-staff
-- profile's JWT claims, inside one rolled-back DO block (11.5):
--
--   1. `horse_bug_reports` had the policy "Anyone can read bug reports"
--      (SELECT, role public, USING true) and a SELECT grant to anon and
--      authenticated. 16,101 rows naming 202 horses by `horse_id` and
--      `horse_name`, readable from the console of any tab, signed in or not.
--      The client that wrote them (HorseBugReporter) is deleted in #3536; the
--      engine's own reporting does not read this table back. The read policy
--      is now `fn_is_horse_admin()` (admin / superadmin / god) and anon has
--      no grant at all. Insert stays as it was (authenticated only).
--
--   2. `club_memberships` is a security_invoker VIEW over `club_members`
--      exposing every column including `is_bot` - which is `profiles.is_horse`
--      mirrored by trigger (`fn_club_members_bot_follows_horse`): 1,903 rows
--      flagged, all 1,000 horses, no human. Nothing in either repo reads the
--      view; it survives only because `ca_diamond_dead_store_writes` watches
--      it as a dead store. The view's SELECT is revoked from anon and
--      authenticated. (The underlying `is_bot` column on `club_members` is
--      readable through the roster / own-membership / cashier-downline
--      policies and is closed separately with column-level grants, after
--      the client stops selecting `*` there - the same sequence as
--      `table_seats.horse_id`.)
--
--   3. `fn_club_union_join_blockers(club_id)` returned `horse_count` and
--      `horse_wallets` for ANY club to ANY authenticated caller - no guard,
--      no client caller in src/, no server caller. Its one real caller is
--      the union-join trigger `fn_enforce_club_enters_union_empty`, which is
--      SECURITY DEFINER and runs as the owner, so revoking EXECUTE from
--      anon, authenticated and PUBLIC changes nothing for it. A guard inside
--      the function on auth.uid() would have broken that trigger for every
--      automated join; the revoke does not.
--
-- PROBE (rolled back, verbatim):
--   bug_reports as player=0; club_memberships refused 42501;
--   join_blockers refused 42501; bug_reports as god=16101;
--   join_blockers as owner horse_count=416
--
-- GRANT/REVOKE and policy changes do not trigger a PostgREST schema reload.
-- One transaction regardless (production DDL policy, CLAUDE.md section 2).

BEGIN;

-- 1. horse_bug_reports: admins read, nobody else.
DROP POLICY IF EXISTS "Anyone can read bug reports" ON public.horse_bug_reports;
DROP POLICY IF EXISTS horse_bug_reports_admin_read ON public.horse_bug_reports;
CREATE POLICY horse_bug_reports_admin_read
  ON public.horse_bug_reports
  FOR SELECT
  TO authenticated
  USING (public.fn_is_horse_admin());
REVOKE ALL ON TABLE public.horse_bug_reports FROM anon;

-- 2. club_memberships: a dead alias of club_members that nobody reads.
REVOKE ALL ON public.club_memberships FROM anon, authenticated;

-- 3. fn_club_union_join_blockers: the trigger keeps it; players lose it.
REVOKE ALL ON FUNCTION public.fn_club_union_join_blockers(uuid) FROM PUBLIC, anon, authenticated;

-- Post-flight: every door is shut, and the admin door still opens.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'horse_bug_reports'
       AND cmd = 'SELECT' AND qual = 'true'
  ) THEN
    RAISE EXCEPTION 'horse_bug_reports still has an unconditional read policy';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'horse_bug_reports'
       AND policyname = 'horse_bug_reports_admin_read'
  ) THEN
    RAISE EXCEPTION 'the admin read policy on horse_bug_reports did not land';
  END IF;
  IF has_table_privilege('anon', 'public.horse_bug_reports', 'SELECT') THEN
    RAISE EXCEPTION 'anon can still select horse_bug_reports';
  END IF;
  IF has_table_privilege('authenticated', 'public.club_memberships', 'SELECT')
     OR has_table_privilege('anon', 'public.club_memberships', 'SELECT') THEN
    RAISE EXCEPTION 'club_memberships is still selectable by a player';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_club_union_join_blockers(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_club_union_join_blockers(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_club_union_join_blockers is still executable by a player';
  END IF;
END $$;

COMMIT;
