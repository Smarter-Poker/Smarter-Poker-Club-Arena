-- COMMANDER ENTRIES AND WAITLIST ARE NOT PUBLIC
--
-- Two SELECT policies on the Commander product were open to every anonymous
-- browser holding the published anon key, while the Diamond Arena is open to
-- the public. Both tables carry a player's NAME, PHONE and MONEY.
--
-- ─── commander_tournament_entries ────────────────────────────────────────────
--
-- BEFORE  captain_entries_select, FOR SELECT, roles PUBLIC (so anon),
--         permissive, USING (true)
--
-- AFTER   captain_entries_select, FOR SELECT, TO authenticated, permissive,
--         USING (
--           player_id = (SELECT auth.uid())
--           OR tournament_id IN (
--                SELECT id FROM commander_tournaments
--                 WHERE venue_id IN (SELECT venue_id FROM commander_staff
--                                     WHERE user_id = (SELECT auth.uid())
--                                       AND is_active = true))
--         )
--
-- WHY THAT IS THE NARROWEST PREDICATE THAT KEEPS THE PRODUCT WORKING. It is
-- not a new rule - it is the rule the SAME TABLE already applies to every
-- other verb. captain_entries_update and captain_entries_delete are already
-- scoped to exactly this disjunction, and captain_entries_insert to the same
-- staff set. So SELECT was the only verb that disagreed with its own table:
-- a player could not change an entry that was not theirs, but could read all
-- 318 of them. Giving SELECT the scope its siblings already have removes the
-- disagreement rather than inventing a policy. commander_audit_logs on this
-- same product writes the staff half of it the same way (audit_logs_select).
--
-- Measured before this change: 318 rows, 317 of them carrying a player name;
-- anon held SELECT on EVERY column, with player_name and payout_amount both
-- confirmed readable, and player_phone and notes exposed as columns too
-- (sparse today, which is luck and not a control).
--
-- WHAT STILL READS IT, checked 2026-10-06 across club-arena and
-- Smarter-Poker-World-Hub. One browser call site:
-- pages/hub/commander/tournament/[id]/my-status.js reads
-- `.eq('tournament_id', id).eq('player_id', authUser.id)` - already its own
-- row, so it is inside the self branch and needs no change.
-- pages/hub/commander/tournament/[id]/register.js holds a realtime
-- subscription on INSERTs for a tournament; a non-staff player stops being
-- woken by OTHER players' registrations, which is the leak, and its handler
-- only re-reads the tournament row that carries the counts.
--
-- ─── commander_waitlist (the same shape, one branch) ─────────────────────────
--
-- BEFORE  captain_waitlist_select, FOR SELECT, roles PUBLIC, permissive,
--         USING (player_id = (SELECT auth.uid())
--                OR player_id IS NULL
--                OR venue_id IN (SELECT venue_id FROM commander_staff
--                                 WHERE user_id = (SELECT auth.uid())
--                                   AND is_active = true))
--
-- AFTER   the same policy TO authenticated, with the middle branch GONE.
--
-- `player_id IS NULL` marks a WALK-IN - somebody the venue wrote down who has
-- no platform account. For an anonymous caller auth.uid() is NULL, so the
-- first and third branches are false and the second is TRUE: the branch meant
-- to describe "a row with no account holder" published every walk-in row, 18
-- of 43 today, with name, phone and notes, to anyone at all. A row with no
-- account holder has no owner to show it to; it belongs to venue staff, who
-- reach it through the third branch.
--
-- WHAT STILL READS IT. pages/api/public/venue/[id].js takes a HEAD COUNT of
-- waiting rows for the public venue page (`count: 'exact', head: true`, no
-- columns). It runs server-side through SUPABASE_SERVICE_ROLE_KEY, which is
-- configured on the hub project and bypasses RLS, so the count is unaffected.
-- (That call site has an `|| NEXT_PUBLIC_SUPABASE_ANON_KEY` fallback; it does
-- not trigger in production, and a fallback that silently downgrades a
-- server route to the browser's role is its own defect, reported separately,
-- not something to leave a table open for.) The browser pages under
-- pages/hub/commander/ read their own rows or their venue's.
--
-- ─── the grants, not just the policies ──────────────────────────────────────
--
-- A policy is only half of it: anon holds a table-level SELECT grant on both
-- tables (`anon=arwdxtm/postgres`). No anonymous surface reads either table,
-- so the grant goes too - otherwise the next permissive policy added to these
-- tables is anonymous again by default. Both REVOKEs name PUBLIC as well as
-- anon, per the law in tests/a-revoke-from-anon-must-name-public.law.test.ts:
-- anon is a member of PUBLIC, so a revoke that names only anon reads
-- correctly and can change nothing. There is no PUBLIC entry on either ACL
-- today, which makes naming it a no-op here and the right habit everywhere.
--
-- authenticated and service_role keep what they had, and that is asserted
-- rather than assumed.
--
-- @live-proof: (NOT has_table_privilege('anon', 'public.commander_tournament_entries', 'SELECT') AND NOT has_table_privilege('anon', 'public.commander_waitlist', 'SELECT') AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('commander_tournament_entries','commander_waitlist') AND cmd='SELECT' AND qual='true') = 0)

-- ─── PRE: the holes are still here, and nothing else depends on them ────────
DO $pre$
DECLARE v text; n int;
BEGIN
  -- Refuse to run twice, or against a tree somebody already changed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='commander_tournament_entries' AND policyname='captain_entries_select'
      AND cmd='SELECT' AND qual='true'
  ) THEN
    RAISE EXCEPTION 'captain_entries_select is not the USING (true) policy this migration was written against';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='commander_waitlist' AND policyname='captain_waitlist_select'
      AND cmd='SELECT' AND qual ~ 'player_id IS NULL'
  ) THEN
    RAISE EXCEPTION 'captain_waitlist_select does not carry the player_id IS NULL branch this migration removes';
  END IF;

  -- A view or another table's policy reading these tables would route around
  -- the new predicate, so it has to be absent before the predicate is trusted.
  SELECT string_agg(c.relname, ', ') INTO v FROM pg_class c
   JOIN pg_namespace n2 ON n2.oid = c.relnamespace AND n2.nspname = 'public'
   WHERE c.relkind IN ('v','m')
     AND pg_get_viewdef(c.oid) ~* '(commander_tournament_entries|commander_waitlist)\y';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a view reads these tables and would bypass the new predicate: %', v;
  END IF;

  SELECT count(*) INTO n FROM commander_tournament_entries;
  RAISE NOTICE 'commander_tournament_entries rows now readable by anon: %', n;
  SELECT count(*) INTO n FROM commander_waitlist WHERE player_id IS NULL;
  RAISE NOTICE 'commander_waitlist walk-in rows now readable by anon: %', n;
END
$pre$;

-- ─── commander_tournament_entries ───────────────────────────────────────────
DROP POLICY "captain_entries_select" ON public.commander_tournament_entries;

CREATE POLICY "captain_entries_select" ON public.commander_tournament_entries
  FOR SELECT TO authenticated
  USING (
    player_id = (SELECT auth.uid())
    OR tournament_id IN (
      SELECT ct.id FROM public.commander_tournaments ct
       WHERE ct.venue_id IN (
         SELECT cs.venue_id FROM public.commander_staff cs
          WHERE cs.user_id = (SELECT auth.uid()) AND cs.is_active = true
       )
    )
  );

REVOKE SELECT ON TABLE public.commander_tournament_entries FROM anon, PUBLIC;

-- ─── commander_waitlist ─────────────────────────────────────────────────────
DROP POLICY "captain_waitlist_select" ON public.commander_waitlist;

CREATE POLICY "captain_waitlist_select" ON public.commander_waitlist
  FOR SELECT TO authenticated
  USING (
    player_id = (SELECT auth.uid())
    OR venue_id IN (
      SELECT cs.venue_id FROM public.commander_staff cs
       WHERE cs.user_id = (SELECT auth.uid()) AND cs.is_active = true
    )
  );

REVOKE SELECT ON TABLE public.commander_waitlist FROM anon, PUBLIC;

-- ─── POST: assert the end state, every part of it ───────────────────────────
DO $post$
DECLARE q text; r text;
BEGIN
  -- 1. The old predicate is gone from both tables.
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename IN ('commander_tournament_entries','commander_waitlist')
      AND cmd='SELECT' AND qual='true'
  ) THEN
    RAISE EXCEPTION 'a SELECT policy on these tables is still USING (true)';
  END IF;

  -- 2. The new entries policy is present, scoped to authenticated, and says
  --    what it is meant to say. Checked on the stored expression, so a
  --    predicate that drifts later cannot pass this.
  SELECT qual, roles::text INTO q, r FROM pg_policies
   WHERE schemaname='public' AND tablename='commander_tournament_entries'
     AND policyname='captain_entries_select';
  IF q IS NULL THEN RAISE EXCEPTION 'captain_entries_select is missing'; END IF;
  IF r <> '{authenticated}' THEN
    RAISE EXCEPTION 'captain_entries_select is not scoped to authenticated: %', r;
  END IF;
  IF q !~ 'player_id = \( SELECT auth\.uid\(\)' THEN
    RAISE EXCEPTION 'captain_entries_select lost its self branch: %', q;
  END IF;
  IF q !~ 'commander_staff' OR q !~ 'is_active' THEN
    RAISE EXCEPTION 'captain_entries_select lost its active-staff branch: %', q;
  END IF;

  -- 3. The waitlist policy no longer admits a row by its NULL owner.
  SELECT qual, roles::text INTO q, r FROM pg_policies
   WHERE schemaname='public' AND tablename='commander_waitlist'
     AND policyname='captain_waitlist_select';
  IF q IS NULL THEN RAISE EXCEPTION 'captain_waitlist_select is missing'; END IF;
  IF r <> '{authenticated}' THEN
    RAISE EXCEPTION 'captain_waitlist_select is not scoped to authenticated: %', r;
  END IF;
  IF q ~ 'player_id IS NULL' THEN
    RAISE EXCEPTION 'captain_waitlist_select still admits a row by its NULL owner: %', q;
  END IF;
  IF q !~ 'player_id = \( SELECT auth\.uid\(\)' OR q !~ 'commander_staff' THEN
    RAISE EXCEPTION 'captain_waitlist_select lost a branch it must keep: %', q;
  END IF;

  -- 4. The grants are what was intended: anon out, the other two untouched.
  IF has_table_privilege('anon', 'public.commander_tournament_entries', 'SELECT') THEN
    RAISE EXCEPTION 'anon still holds SELECT on commander_tournament_entries';
  END IF;
  IF has_table_privilege('anon', 'public.commander_waitlist', 'SELECT') THEN
    RAISE EXCEPTION 'anon still holds SELECT on commander_waitlist';
  END IF;
  -- Revoking PUBLIC is the wider cut, so the roles that must survive it are
  -- asserted, not assumed.
  IF NOT has_table_privilege('authenticated', 'public.commander_tournament_entries', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.commander_waitlist', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT and the Commander product cannot work';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.commander_tournament_entries', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.commander_waitlist', 'SELECT') THEN
    RAISE EXCEPTION 'service_role lost SELECT and the public venue head-count breaks';
  END IF;

  -- 5. The write policies this migration borrowed its scope from are still
  --    there. If one of them were dropped, the "SELECT now matches its own
  --    table" reasoning above would be describing a table that no longer
  --    exists in that shape.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public'
       AND tablename='commander_tournament_entries'
       AND policyname IN ('captain_entries_insert','captain_entries_update','captain_entries_delete')) <> 3 THEN
    RAISE EXCEPTION 'the correctly scoped write policies on commander_tournament_entries are not all present';
  END IF;
END
$post$;
