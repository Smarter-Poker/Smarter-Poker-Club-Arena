-- A SEAT MAP IS READABLE ONLY IN SCOPE: NOT BY A BROWSER WITH NO ACCOUNT
--
-- This is hole 1b, deliberately narrower than its name suggests. READ THE
-- "WHAT THIS DOES NOT DO" SECTION BEFORE ASSUMING table_seats IS NOW SCOPED.
--
-- ─── BEFORE / AFTER ─────────────────────────────────────────────────────────
--
-- BEFORE  Policy "Public read access", FOR SELECT, roles PUBLIC, permissive,
--         USING (true).
--         anon held NO table-level grant, but a COLUMN-LEVEL SELECT grant on
--         25 of table_seats' 26 columns (`anon=r/postgres` on each),
--         including user_id, seat_number, table_id and stack. The 26th,
--         horse_id, has attacl NULL and therefore falls back to the table ACL,
--         which has no anon entry - so horse_id was already unreadable. That
--         is not an accident: it is
--         20261005115325_a_browser_cannot_read_which_seat_or_member_is_a_horse
--         doing its job at column level.
--
-- AFTER   Those 25 column grants are revoked from anon (and PUBLIC). anon can
--         read no column of table_seats at all. The policy is UNCHANGED.
--
-- ─── WHY THIS IS THE HALF WORTH SHIPPING ON ITS OWN ─────────────────────────
--
-- The seat map was the JOIN SIDE of the inference that defeated
-- a_browser_cannot_read_which_seat_or_member_is_a_horse. player_stats supplied
-- the classifier - 2,804 of 2,814 rows averaging 4,643 hands_played against
-- 168 for the 10 human rows - and table_seats supplied "which user_id is in
-- which seat at which table". Withholding horse_id stopped the direct read
-- and nothing stopped the join.
--
-- 20261006135147 removed the classifier. This removes the join side for the
-- same caller, so neither half is reachable by a browser with no account.
-- HORSES ARE PLAYERS (CLAUDE.md 10.5): nothing here filters a horse out of
-- anything, and no path added by this change treats a horse's row differently
-- from a person's. The whole table stops answering anon, for every row.
--
-- ─── ESTABLISHING THAT NO ANONYMOUS SURFACE NEEDS IT ────────────────────────
--
-- A live poker client legitimately needs seats and stacks at the table it is
-- sitting at or observing, so the question was not "is this data sensitive"
-- but "does a caller with NO ACCOUNT ever ask for it". Checked 2026-10-06:
--
--   Club Arena SPA. Every route whose page reads table_seats is behind
--   <AuthGuard>: table/:tableId (TableRouteSurface), clubs/:clubId
--   (ClubHomePage, additionally behind <ClubMemberGuard>),
--   clubs/:clubId/tournaments, clubs/:clubId/blacklist,
--   clubs/:clubId/anti-cheat, tournaments (TournamentLobbyPage). The routes
--   that are NOT behind AuthGuard are /auth, /share/hand/:handId, /replay,
--   /bonus-replay/:shareId, /sim, /dev/* and /legal/*, and none of them reads
--   a seat.
--
--   World Hub. No browser path reads table_seats. pages/hub/poker/lobby.js and
--   pages/hub/poker/table/[tableId].js say so in their own words - they keep
--   seats in memory and never read or write the table. Every server-side read
--   (pages/api/horses/grinder-stats.js, fleet-admin.js, club-arena-admin.js,
--   pages/api/club-arena/auto-close-tables.js) is an operator-gated route
--   behind withOperatorRoute, not an anonymous browser.
--
--   Club Arena game server. Reads through the service role, which keeps every
--   grant it had.
--
-- ─── WHAT THIS DOES NOT DO, STATED SO NOBODY TRUSTS IT TOO FAR ──────────────
--
-- "Public read access" is STILL `USING (true)`, and `authenticated` still
-- holds the same 25 column grants. So any signed-in player can still read
-- every seat and every stack at every table in the estate, which is more than
-- the client needs and is a real over-breadth.
--
-- It is not narrowed here, for a reason rather than for lack of time.
-- fn_club_home_in_scope - the helper that already encodes "which clubs may
-- this viewer see" - takes the VIEWER'S CONTEXT AS SIX PARAMETERS
-- (p_viewer_union_id, p_viewer_club_id, p_viewer_union_club_ids and the rest),
-- so it cannot be dropped into an RLS predicate without first building a
-- definer wrapper that derives that context for auth.uid(). And 45 files
-- across src/ and server/ read table_seats, including the live engine's
-- seating, settlement and tournament paths, where a predicate that is wrong
-- by one case does not show up as an error - it shows up as a seat that will
-- not take a player mid-hand. Establishing what the client needs at the table
-- it is observing, versus at a table it merely sees in a lobby, is its own
-- lane with its own evidence, and pretending otherwise in this migration
-- would be the kind of change that looks like a fix.
--
-- Revoking anon needs none of that: the answer there is "never", and it is
-- the half that is reachable right now with the published anon key.
--
-- @live-proof: (NOT has_table_privilege('anon', 'public.table_seats', 'SELECT') AND NOT has_column_privilege('anon', 'public.table_seats', 'stack', 'SELECT') AND NOT has_column_privilege('anon', 'public.table_seats', 'user_id', 'SELECT') AND has_column_privilege('authenticated', 'public.table_seats', 'stack', 'SELECT'))

-- ─── PRE: the hole is still here, and the engine's own access is unaffected ─
DO $pre$
DECLARE n_anon int; n_auth int;
BEGIN
  SELECT count(*) INTO n_anon FROM pg_attribute a
   WHERE a.attrelid='public.table_seats'::regclass AND a.attnum>0 AND NOT a.attisdropped
     AND has_column_privilege('anon','public.table_seats',a.attnum,'SELECT');
  IF n_anon = 0 THEN
    RAISE EXCEPTION 'anon already reads no column of table_seats; this migration has nothing to do';
  END IF;
  RAISE NOTICE 'columns of table_seats an anonymous browser can read: %', n_anon;

  SELECT count(*) INTO n_auth FROM pg_attribute a
   WHERE a.attrelid='public.table_seats'::regclass AND a.attnum>0 AND NOT a.attisdropped
     AND has_column_privilege('authenticated','public.table_seats',a.attnum,'SELECT');
  RAISE NOTICE 'columns authenticated can read (unchanged by this migration): %', n_auth;

  -- horse_id must already be closed to BOTH browser roles. If it is not, the
  -- law it belongs to has regressed and that is a bigger problem than this
  -- migration, so it is refused rather than papered over.
  IF has_column_privilege('anon','public.table_seats','horse_id','SELECT')
     OR has_column_privilege('authenticated','public.table_seats','horse_id','SELECT') THEN
    RAISE EXCEPTION 'table_seats.horse_id is readable by a browser role; a_browser_cannot_read_which_seat_or_member_is_a_horse has regressed';
  END IF;

  IF NOT has_table_privilege('service_role','public.table_seats','SELECT') THEN
    RAISE EXCEPTION 'service_role cannot read table_seats; the engine would already be broken';
  END IF;
END
$pre$;

-- ─── the revoke ─────────────────────────────────────────────────────────────
-- Column-level grants are revoked by revoking the privilege on the table from
-- the role: a table-level REVOKE removes the role's column entries too. Both
-- roles are named because anon is a member of PUBLIC, so a revoke naming only
-- anon reads correctly and can change nothing where a PUBLIC grant exists
-- (tests/a-revoke-from-anon-must-name-public.law.test.ts). There is no PUBLIC
-- entry on this ACL today, which makes naming it a no-op here and the right
-- habit everywhere. `authenticated` and `service_role` are not named at all.
REVOKE SELECT ON TABLE public.table_seats FROM anon, PUBLIC;

-- ─── POST: assert the end state, every part of it ───────────────────────────
DO $post$
DECLARE a text; n_auth int;
BEGIN
  -- 1. anon reads nothing: not the table, and not one column through a
  --    column grant. The column check is the one that matters here, because
  --    anon never HAD a table-level grant - the whole exposure was columns,
  --    and a table-level check alone would have passed before this migration.
  IF has_table_privilege('anon','public.table_seats','SELECT') THEN
    RAISE EXCEPTION 'anon still holds a table-level SELECT on table_seats';
  END IF;
  SELECT string_agg(a2.attname, ', ') INTO a FROM pg_attribute a2
   WHERE a2.attrelid='public.table_seats'::regclass AND a2.attnum>0 AND NOT a2.attisdropped
     AND has_column_privilege('anon','public.table_seats',a2.attnum,'SELECT');
  IF a IS NOT NULL THEN
    RAISE EXCEPTION 'anon still reads these columns of table_seats: %', a;
  END IF;

  -- 2. The live client and the engine kept everything. The seat map is what a
  --    poker table IS; a revoke that reached authenticated would stop a
  --    player seeing the chairs.
  SELECT count(*) INTO n_auth FROM pg_attribute a3
   WHERE a3.attrelid='public.table_seats'::regclass AND a3.attnum>0 AND NOT a3.attisdropped
     AND has_column_privilege('authenticated','public.table_seats',a3.attnum,'SELECT');
  IF n_auth < 25 THEN
    RAISE EXCEPTION 'authenticated lost column reads on table_seats (% left); the live client needs the seat map', n_auth;
  END IF;
  IF NOT has_column_privilege('authenticated','public.table_seats','stack','SELECT')
     OR NOT has_column_privilege('authenticated','public.table_seats','seat_number','SELECT')
     OR NOT has_column_privilege('authenticated','public.table_seats','user_id','SELECT') THEN
    RAISE EXCEPTION 'authenticated lost a column the table surface reads every hand';
  END IF;
  IF NOT has_table_privilege('service_role','public.table_seats','SELECT')
     OR NOT has_table_privilege('service_role','public.table_seats','UPDATE') THEN
    RAISE EXCEPTION 'service_role lost table_seats and the engine cannot seat anybody';
  END IF;

  -- 3. horse_id is still closed to both browser roles.
  IF has_column_privilege('anon','public.table_seats','horse_id','SELECT')
     OR has_column_privilege('authenticated','public.table_seats','horse_id','SELECT') THEN
    RAISE EXCEPTION 'table_seats.horse_id became readable by a browser role';
  END IF;

  -- 4. The policy was deliberately NOT changed, and that is asserted so the
  --    next reader is not misled by this migration's name into thinking the
  --    predicate was narrowed. If somebody later narrows it, this assertion
  --    is the one to delete, in the migration that does the narrowing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='table_seats'
      AND policyname='Public read access' AND qual='true'
  ) THEN
    RAISE EXCEPTION '"Public read access" is no longer USING (true); this migration did not touch it, so something else did and its assumptions need re-reading';
  END IF;
END
$post$;
