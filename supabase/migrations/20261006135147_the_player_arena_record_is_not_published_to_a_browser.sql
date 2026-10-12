-- THE PLAYER ARENA RECORD IS NOT PUBLISHED TO A BROWSER
--
-- public.player_stats published every player's money to any anonymous visitor
-- holding the published anon key, and it defeated an applied law by inference.
--
-- ─── BEFORE / AFTER ─────────────────────────────────────────────────────────
--
-- BEFORE  "Player stats are public", FOR SELECT, roles PUBLIC (so anon),
--         permissive, USING (true)
--         + a table-level SELECT grant to anon (`anon=arwdxtm/postgres`)
--
--         A correct sibling already existed - player_stats_self, FOR ALL TO
--         authenticated, USING (auth.uid() = user_id) - but permissive
--         policies are OR'd, so the public one decided everything and the
--         self one could only ever widen it. Confirmed from the catalogue:
--         has_column_privilege('anon','public.player_stats','total_winnings',
--         'SELECT') was true.
--
-- AFTER   "Player stats are public" is GONE. anon holds no SELECT at all.
--         Two permissive policies remain, both TO authenticated:
--           player_stats_self            (kept, FOR ALL)  auth.uid() = user_id
--           player_stats_club_member_read (new, FOR SELECT)
--             club_id IN (SELECT club_id FROM club_members
--                          WHERE user_id = (SELECT auth.uid())
--                            AND coalesce(status,'active') IN ('active','approved'))
--
-- WHY THAT IS THE NARROWEST PREDICATE THAT KEEPS THE PRODUCT WORKING.
-- player_stats is one row per (user, club), and every direct reader in the
-- estate is already asking about ONE CLUB IT BELONGS TO - checked 2026-10-06
-- across club-arena src/ and server/src/ and Smarter-Poker-World-Hub:
--
--   src/pages/AdminDashboardPage.tsx      .eq('club_id', uuid)  total_rake
--   src/pages/AgentDashboardPage.tsx      .eq('club_id', uuid)  last played
--   src/components/agent/AgentScoreCard.tsx .eq('club_id', clubId) retention
--   src/services/LeaderboardService.ts    .eq('club_id', resolvedClubId) x2
--   src/services/AchievementTriggerService.ts  the caller's own rows
--
-- So "a club I am a member of" is not a new rule invented for this migration;
-- it is the shape every surviving caller already queries in. A club admin, an
-- agent and an ordinary player on a leaderboard are all members of the club
-- they are looking at, which is why one predicate serves all three and no
-- staff-only or agent-only branch is needed.
--
-- `status IN ('active','approved')` and NOT fn_my_club_ids(). The helper
-- exists and is tempting, but it tests `coalesce(status,'active')='active'`,
-- and club_members holds 1,481 rows at 'approved' against 444 at 'active'.
-- Using it would have cut three quarters of all memberships out of every
-- screen above - a silent break, in the direction that looks like a fix.
-- ca_player_stats_shared_clubs already uses IN ('active','approved'); this
-- matches it. The subquery is written inline rather than behind a new
-- SECURITY DEFINER helper because club_members already carries
-- "Members can read own club memberships" (user_id = auth.uid()) for
-- authenticated, so the predicate resolves under RLS as the querying role
-- without a definer in the path.
--
-- ─── THE INFERENCE, AND WHY THIS CLOSES IT ──────────────────────────────────
--
-- The applied law a_browser_cannot_read_which_seat_or_member_is_a_horse was
-- defeated WITHOUT READING A HORSE COLUMN. Measured: 2,804 of 2,814 rows are
-- horses, averaging 4,643 hands_played against 168 for the 10 humans, with
-- distinct vpip/pfr. table_seats grants anon COLUMN access to user_id,
-- seat_number, table_id and stack. Classify on hands_played, join the seat
-- map, and "which seat is a horse" falls out.
--
-- CLAUDE.md 10.5, HORSES ARE PLAYERS, decides the shape of the fix: the table
-- stops being published. Nothing here filters a horse out of anything, and no
-- path below treats a horse's row differently from a person's. Removing the
-- classifier removes the inference; table_seats' own over-broad
-- "Public read access" is a separate, narrower change (hole 1b) and is not
-- touched here.
--
-- ─── THE ONE SCREEN THAT NEEDED MORE THAN A POLICY ──────────────────────────
--
-- src/pages/PublicProfilePage.tsx is the only reader that is NOT club-scoped:
-- it reads another player's hands_played, vpip, pfr, tournaments_played and
-- tournaments_won across EVERY club, for any signed-in viewer, and folds them
-- with aggregateArenaRecord(). The club-member predicate would have silently
-- under-reported that record to a viewer who shares no club with the target,
-- which is a broken screen, not a closed hole.
--
-- The public leaderboard's correct path is the model: a SECURITY DEFINER
-- reader that returns what the screen needs instead of the raw table
-- (fn_global_leaderboard_period, fn_club_leaderboard_period_v2). So
-- ca_public_arena_record_v1 returns the SAME ROW SHAPE the page already
-- folds - one row per club, the five play fields and nothing else. The page's
-- diff is one call; aggregateArenaRecord and its unit test are untouched, so
-- the tested weighting cannot drift while this moves.
--
-- It returns NO MONEY. total_winnings, total_losses, total_rake and
-- sum_big_blind were the worst of what anon could read and no screen outside
-- the club-member scope needs them, so the definer path does not carry them
-- at all - not as a filter that could be widened later, but as columns that
-- are not in the function.
--
-- @live-proof: (NOT has_table_privilege('anon', 'public.player_stats', 'SELECT') AND NOT has_column_privilege('anon', 'public.player_stats', 'total_winnings', 'SELECT') AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_stats' AND policyname='Player stats are public') AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_stats' AND policyname='player_stats_club_member_read' AND roles::text='{authenticated}'))

BEGIN;

-- ─── PRE: the hole is still here, and nothing routes around the new rule ────
DO $pre$
DECLARE v text; n_tot int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_stats'
      AND policyname='Player stats are public' AND cmd='SELECT' AND qual='true'
  ) THEN
    RAISE EXCEPTION 'player_stats is not in the state this migration was written against: "Player stats are public" USING (true) is absent';
  END IF;

  -- The sibling this migration leans on has to be there, or "self is already
  -- covered" below is describing a policy that does not exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_stats'
      AND policyname='player_stats_self' AND roles::text='{authenticated}'
  ) THEN
    RAISE EXCEPTION 'player_stats_self is missing; a player would lose their own rows';
  END IF;

  -- The predicate reads club_members. If club_members ever stops letting a
  -- player see their own membership, every screen above goes empty, so the
  -- dependency is asserted here rather than discovered in production.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='club_members'
      AND cmd='SELECT' AND qual ~ 'user_id = \( SELECT auth\.uid\(\)'
  ) THEN
    RAISE EXCEPTION 'club_members no longer lets a member read their own membership; the new predicate would resolve empty';
  END IF;

  -- A view over player_stats would keep publishing it past the policy.
  SELECT string_agg(c.relname, ', ') INTO v FROM pg_class c
   JOIN pg_namespace n2 ON n2.oid=c.relnamespace AND n2.nspname='public'
   WHERE c.relkind IN ('v','m') AND pg_get_viewdef(c.oid) ~* 'player_stats\y';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a view reads player_stats and would bypass the new policy: %', v;
  END IF;

  -- Counted, not classified: HORSES ARE PLAYERS (CLAUDE.md 10.5), and this
  -- migration has no business asking which of these rows is which.
  SELECT count(*) INTO n_tot FROM player_stats;
  RAISE NOTICE 'player_stats rows an anonymous browser could read: %', n_tot;
END
$pre$;

-- ─── the policy ─────────────────────────────────────────────────────────────
DROP POLICY "Player stats are public" ON public.player_stats;

CREATE POLICY "player_stats_club_member_read" ON public.player_stats
  FOR SELECT TO authenticated
  USING (
    club_id IN (
      SELECT cm.club_id FROM public.club_members cm
       WHERE cm.user_id = (SELECT auth.uid())
         AND coalesce(cm.status, 'active') IN ('active', 'approved')
    )
  );

-- ─── the grant ──────────────────────────────────────────────────────────────
-- Both roles are named: anon is a member of PUBLIC, so a revoke that names
-- only anon reads correctly and can change nothing where a PUBLIC grant
-- exists (tests/a-revoke-from-anon-must-name-public.law.test.ts). There is no
-- PUBLIC entry on this ACL today, which makes naming it a no-op here and the
-- right habit everywhere.
REVOKE SELECT ON TABLE public.player_stats FROM anon, PUBLIC;

-- ─── the definer reader for the one screen that is not club-scoped ──────────
CREATE OR REPLACE FUNCTION public.ca_public_arena_record_v1(p_target_user uuid)
RETURNS TABLE (
  hands_played numeric,
  vpip numeric,
  pfr numeric,
  tournaments_played numeric,
  tournaments_won numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_viewer uuid := auth.uid();
BEGIN
  -- A signed-in viewer only. The arena record was never meant to be anonymous
  -- and this function exists because it was.
  IF v_viewer IS NULL THEN
    RAISE EXCEPTION 'the arena record requires a signed-in viewer' USING ERRCODE = '42501';
  END IF;
  IF p_target_user IS NULL THEN
    RAISE EXCEPTION 'no target player' USING ERRCODE = '22023';
  END IF;

  -- One row per club, the five play fields, NO MONEY and no club identity.
  -- HORSES ARE PLAYERS (CLAUDE.md 10.5): there is no horse branch here, and a
  -- horse's row is returned on exactly the same terms as a person's.
  RETURN QUERY
    SELECT ps.hands_played::numeric,
           ps.vpip::numeric,
           ps.pfr::numeric,
           ps.tournaments_played::numeric,
           ps.tournaments_won::numeric
      FROM public.player_stats ps
     WHERE ps.user_id = p_target_user
     ORDER BY ps.hands_played DESC NULLS LAST
     LIMIT 100;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_public_arena_record_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_public_arena_record_v1(uuid) TO authenticated;

-- ─── POST: assert the end state, every part of it ───────────────────────────
DO $post$
DECLARE q text; r text; a text;
BEGIN
  -- 1. The open policy is gone, and nothing on this table is USING (true).
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_stats'
      AND policyname='Player stats are public'
  ) THEN
    RAISE EXCEPTION '"Player stats are public" is still present';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_stats'
      AND cmd IN ('SELECT','ALL') AND qual='true'
  ) THEN
    RAISE EXCEPTION 'a readable policy on player_stats is still USING (true)';
  END IF;

  -- 2. The new policy is present, scoped to authenticated, and says what it
  --    is meant to say - asserted on the stored expression so a later drift
  --    cannot pass this.
  SELECT qual, roles::text INTO q, r FROM pg_policies
   WHERE schemaname='public' AND tablename='player_stats'
     AND policyname='player_stats_club_member_read';
  IF q IS NULL THEN RAISE EXCEPTION 'player_stats_club_member_read is missing'; END IF;
  IF r <> '{authenticated}' THEN
    RAISE EXCEPTION 'player_stats_club_member_read is not scoped to authenticated: %', r;
  END IF;
  IF q !~ 'club_members' THEN
    RAISE EXCEPTION 'player_stats_club_member_read does not read club_members: %', q;
  END IF;
  IF q !~ 'approved' THEN
    RAISE EXCEPTION 'player_stats_club_member_read dropped the approved status and would hide most memberships: %', q;
  END IF;

  -- 3. The self policy survived, so a player keeps their own rows.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='player_stats'
      AND policyname='player_stats_self'
  ) THEN
    RAISE EXCEPTION 'player_stats_self was lost';
  END IF;

  -- 4. The grants. anon out at table AND column level - a table-level revoke
  --    leaves a column grant standing, and a column grant is how table_seats
  --    is readable at all, so it is checked by name rather than assumed.
  IF has_table_privilege('anon', 'public.player_stats', 'SELECT') THEN
    RAISE EXCEPTION 'anon still holds SELECT on player_stats';
  END IF;
  SELECT string_agg(att.attname, ', ') INTO a
    FROM pg_attribute att
   WHERE att.attrelid = 'public.player_stats'::regclass AND att.attnum > 0
     AND NOT att.attisdropped
     AND has_column_privilege('anon', 'public.player_stats', att.attnum, 'SELECT');
  IF a IS NOT NULL THEN
    RAISE EXCEPTION 'anon still holds a COLUMN grant on player_stats: %', a;
  END IF;

  -- Revoking PUBLIC is the wider cut, so the roles that must survive it are
  -- asserted, not assumed.
  IF NOT has_table_privilege('authenticated', 'public.player_stats', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on player_stats and every club screen breaks';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.player_stats', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.player_stats', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated lost the writes AchievementTriggerService upserts with';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.player_stats', 'SELECT') THEN
    RAISE EXCEPTION 'service_role lost SELECT on player_stats';
  END IF;

  -- 5. The definer reader exists, is a reader, authorises its caller, carries
  --    NO money column, and is not anonymous.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='ca_public_arena_record_v1'
                    AND p.prosecdef AND p.provolatile='s') THEN
    RAISE EXCEPTION 'ca_public_arena_record_v1 is missing, not DEFINER, or not STABLE';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO q FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ca_public_arena_record_v1';
  IF q !~ 'auth\.uid\(\)' THEN
    RAISE EXCEPTION 'ca_public_arena_record_v1 does not know who is calling it';
  END IF;
  IF q ~* '(total_winnings|total_losses|total_rake|sum_big_blind)' THEN
    RAISE EXCEPTION 'ca_public_arena_record_v1 carries a money column; it must not';
  END IF;
  IF has_function_privilege('anon', 'public.ca_public_arena_record_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute ca_public_arena_record_v1';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.ca_public_arena_record_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute ca_public_arena_record_v1 and the profile record breaks';
  END IF;
END
$post$;

COMMIT;
