-- 20261007034527_seat_map_in_scope_and_walk_ins_need_staff.sql
--
-- A SEAT IS READ WITH ITS TABLE, AND A COMMANDER WALK-IN IS ENTERED BY STAFF
--
-- The two browser-access holes left over from the security fixes Dan approved
-- on 2026-10-06 (#6302, #6303), closed in one transaction. Decided by Claude on
-- Dan's delegation (2026-09-30: "these are all for you to decide not me").
--
-- ─── 1. table_seats: a signed-in account reads a seat only in scope ─────────
--
-- BEFORE  "Public read access": FOR SELECT, roles PUBLIC, USING (true).
--         20261006140021_a_seat_map_is_readable_only_in_scope took the read
--         away from a browser with no account and said in its own header what
--         it left open: any signed-in account - free to create - read every
--         seat on the platform. Measured 2026-10-07: 1,441,223 rows, which is
--         who sits at which club's table and with what stack. In a rolled-back
--         rehearsal, a signed-in account with no club read all 9 seats of a
--         Midway Union table, and a player of another club read all 9 at a
--         table whose row it is not allowed to see.
--
-- AFTER   "seat_read_with_table_or_own": FOR SELECT, TO authenticated,
--
--           user_id = (SELECT auth.uid())
--           OR EXISTS (SELECT 1 FROM public.tables t WHERE t.id = table_seats.table_id)
--
--         The EXISTS is evaluated under the CALLER'S row security on
--         public.tables (tables_select_scoped, poker_arena_diamond_tables and
--         the restrictive poker_arena_table_access), so a seat is readable
--         exactly where its table is: a club's tables to that club's active or
--         approved members (a union's to the members of every club in it) and
--         its overseers; the Diamond Arena's tables to every signed-in player;
--         a table with no club and no union to everyone signed in. A player
--         always reads their own seats, including seats at a club they no
--         longer belong to. union_overseer_read and "Service role manages" are
--         unchanged.
--
--         No new visibility rule is invented. "Which tables may this viewer
--         see" is already written once, on public.tables, and the seat follows
--         it. That is the definer-wrapper problem 20261006140021 described,
--         solved by not needing one.
--
-- WHAT READS table_seats WITH A CALLER'S RIGHTS, checked 2026-10-07:
--
--   Client (src/), 20 call sites. Ten read the caller's own seats
--   (.eq('user_id', <me>)): TournamentAutoSeat, ClubHomePage, MultiTablePage,
--   TournamentPage, VoiceSignalService, SeatLeaveIntent, three in TablePage
--   and the first FriendSuggestionService read. The other ten read the seats
--   of a table the caller already reads under its own rights: GameLobbyPanel's
--   seat map (its lobby entries come from the caller's own tables read), the
--   three TablePage roster reads and TableService.getSeatedPlayers (TablePage
--   loads the table row with .from('tables') first and stops if it cannot),
--   and the staff tools AntiCheatPage, BlacklistManagerPage and
--   IntegrityActionService, which inner-join the tables of their own club.
--   FriendSuggestionService's second read lists people met at the caller's
--   recent tables; a table the caller can no longer see drops out of it,
--   which is the point.
--
--   The view v_spin_unfilled_waits (security_invoker) joins tables, so it
--   already counted only readable tables' seats. The caller's-rights
--   functions a signed-in user may execute that read seats
--   (cash_tables_needing_engine, cash_tables_with_players,
--   fn_batch_active_player_counts, fn_get_active_player_count,
--   fn_get_available_seats, get_club_home, get_club_players_playing,
--   get_club_traffic) all join public.tables, or read the table row first,
--   under the same rights, so their answers do not change.
--
--   All 275 definer functions that read table_seats are owned by postgres,
--   which bypasses row security. Every other role that can read the table
--   bypasses row security too, except supabase_backup_admin, which inherits
--   service_role and its policy. table_seats is in no realtime publication,
--   the engine reads through one service_role client, no edge function reads
--   it, and no other table's policy reads it, so the EXISTS cannot recurse.
--
--   HORSES ARE PLAYERS (CLAUDE.md 10.5): a horse's seat follows the same rule
--   as a person's, and nothing here names horse_id, which stays closed to both
--   browser roles (20261005115325).
--
-- ─── 2. a Commander walk-in is entered by venue staff ───────────────────────
--
-- BEFORE  captain_entries_insert (commander_tournament_entries) and
--         captain_waitlist_insert (commander_waitlist): FOR INSERT TO PUBLIC
--         WITH CHECK (player_id = auth.uid() OR player_id IS NULL
--                     OR <active staff of the venue>).
--         Measured 2026-10-07 in a rolled-back rehearsal against production:
--         a signed-in account that is staff nowhere inserted a walk-in row into
--         a venue's waitlist AND into a tournament's entries. anon held INSERT
--         on both tables and the middle branch is TRUE for anon too; anon's
--         insert was refused only by accident - evaluating the staff branch
--         reads commander_staff, whose own policy calls
--         fn_user_is_active_staff_at_venue, which anon may not execute, so the
--         statement died with 42501 on a helper function. That is an error, not
--         a control, and it disappears the day that grant changes.
--
-- AFTER   Both policies TO authenticated with the middle branch gone. A row
--         is the player's own (player_id = auth.uid()) or is written by active
--         staff of that venue, which is how a walk-in is entered. anon's
--         INSERT, UPDATE and DELETE on both tables are revoked, PUBLIC named
--         too (tests/a-revoke-from-anon-must-name-public.law.test.ts). anon's
--         UPDATE and DELETE already matched no row through their policies, so
--         that half changes no answer; it removes the grant the next
--         permissive policy on these tables would otherwise hand to anon.
--
-- WHAT WRITES THESE TABLES, checked 2026-10-07. Every insert is a server route
-- of the Commander app (Smarter-Poker/smarter-poker-commander:
-- pages/api/waitlist/index.js, waitlist/public-join.js, squads/[id]/submit.js,
-- tournaments/[id]/register.js, tournaments/[id]/entries.js), which World Hub
-- reaches through its /api/commander rewrite, and every one writes through
-- SUPABASE_SERVICE_ROLE_KEY, which is set on that project's production
-- environment and bypasses row security. No browser path, database function
-- or edge function inserts into either table. Newest rows: waitlist
-- 2026-03-08, entries 2026-03-03.
--
-- ─── LOCKS: why the seat table is locked before anything else ──────────────
--
-- Every CREATE/ALTER/DROP POLICY run as postgres takes ACCESS EXCLUSIVE on all
-- 23 tables Supabase lists in supautils.policy_grants (auth.users,
-- auth.sessions, auth.refresh_tokens, storage.objects, realtime.messages and
-- the rest) until the transaction ends - whichever table the policy is on.
-- Measured 2026-10-07: after one ALTER POLICY on commander_tournament_entries
-- the transaction held all of them.
--
-- The first rehearsal of this migration ran the Commander policies first and
-- then waited for table_seats while holding auth.users. The engine holds
-- table_seats and then checks a foreign key into auth.users when it queues a
-- hand's Daily Missions events, so they deadlocked; the rehearsal rolled
-- back, and three horses' Daily Missions events for three hands were not
-- queued (fn_enqueue_hand_daily_missions caught the error and warned).
--
-- So this transaction (1) waits for table_seats while holding nothing anyone
-- else needs, with LOCK TABLE and a 500 ms ceiling, and only then (2) runs the
-- policy statements, whose locks may wait at most 250 ms. Both ceilings are
-- below deadlock_timeout (1 s): if anything stands in the way, this
-- transaction gives up first and rolls back, and no engine transaction is
-- ever the one that fails. A refusal here is "dispatch again later", once,
-- never in a loop. Held, the seat table and the auth tables are locked for the
-- few milliseconds the statements below take.
--
-- @live-proof: (NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='table_seats' AND cmd='SELECT' AND qual='true') AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='table_seats' AND policyname='seat_read_with_table_or_own' AND cmd='SELECT' AND roles='{authenticated}'::name[]) AND NOT has_any_column_privilege('anon', 'public.table_seats', 'SELECT'))
-- @live-proof: (NOT has_any_column_privilege('anon', 'public.commander_tournament_entries', 'INSERT') AND NOT has_any_column_privilege('anon', 'public.commander_waitlist', 'INSERT') AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('commander_tournament_entries','commander_waitlist') AND cmd='INSERT' AND roles='{authenticated}'::name[] AND with_check !~ 'player_id IS NULL') = 2)

BEGIN;

-- Every lock wait below stays under deadlock_timeout (1 s); see LOCKS above.
SET LOCAL lock_timeout = '500ms';

-- ─── PRE: written against this exact state, and nothing it relies on moved ──
DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='table_seats'
      AND policyname='Public read access' AND cmd='SELECT' AND qual='true'
      AND roles='{public}'::name[]
  ) THEN
    RAISE EXCEPTION '"Public read access" on table_seats is not the PUBLIC USING (true) policy this migration was written against';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='table_seats'
       AND policyname IN ('union_overseer_read','Service role manages')) <> 2 THEN
    RAISE EXCEPTION 'table_seats no longer carries union_overseer_read and "Service role manages"; re-read it before narrowing';
  END IF;
  -- The reader audit above found no realtime subscriber because there is none.
  -- Read off the catalogue, which opens no published table.
  IF EXISTS (SELECT 1 FROM pg_publication p WHERE p.puballtables)
     OR EXISTS (SELECT 1 FROM pg_publication_rel pr WHERE pr.prrelid = 'public.table_seats'::regclass)
     OR EXISTS (SELECT 1 FROM pg_publication_namespace pn WHERE pn.pnnspid = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'table_seats is in a realtime publication now; its subscribers were not part of this analysis';
  END IF;
  IF has_any_column_privilege('anon','public.table_seats','SELECT') THEN
    RAISE EXCEPTION 'anon reads table_seats again; 20261006140021 has regressed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='commander_tournament_entries'
      AND policyname='captain_entries_insert' AND cmd='INSERT' AND with_check ~ 'player_id IS NULL'
  ) THEN
    RAISE EXCEPTION 'captain_entries_insert does not carry the player_id IS NULL branch this migration removes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='commander_waitlist'
      AND policyname='captain_waitlist_insert' AND cmd='INSERT' AND with_check ~ 'player_id IS NULL'
  ) THEN
    RAISE EXCEPTION 'captain_waitlist_insert does not carry the player_id IS NULL branch this migration removes';
  END IF;
END
$pre$;

-- ─── the seat table first, while this transaction holds nothing else ──────
LOCK TABLE public.table_seats IN ACCESS EXCLUSIVE MODE;

SET LOCAL lock_timeout = '250ms';

-- ─── 1. table_seats: a seat is read with its table, or by its occupant ──────
DROP POLICY "Public read access" ON public.table_seats;

CREATE POLICY "seat_read_with_table_or_own" ON public.table_seats
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM public.tables t WHERE t.id = table_seats.table_id)
  );

-- ─── 2. Commander: a row is the player's own or written by venue staff ──────
ALTER POLICY "captain_entries_insert" ON public.commander_tournament_entries
  TO authenticated
  WITH CHECK (
    player_id = (SELECT auth.uid())
    OR tournament_id IN (
      SELECT ct.id FROM public.commander_tournaments ct
       WHERE ct.venue_id IN (
         SELECT cs.venue_id FROM public.commander_staff cs
          WHERE cs.user_id = (SELECT auth.uid()) AND cs.is_active = true
       )
    )
  );

ALTER POLICY "captain_waitlist_insert" ON public.commander_waitlist
  TO authenticated
  WITH CHECK (
    player_id = (SELECT auth.uid())
    OR venue_id IN (
      SELECT cs.venue_id FROM public.commander_staff cs
       WHERE cs.user_id = (SELECT auth.uid()) AND cs.is_active = true
    )
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.commander_tournament_entries FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.commander_waitlist FROM anon, PUBLIC;

-- ─── POST: assert the end state, every part of it ───────────────────────────
DO $post$
DECLARE q text; r text; tbl text;
BEGIN
  -- 1. No SELECT policy on table_seats answers every reader any more.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='table_seats'
              AND cmd='SELECT' AND qual='true') THEN
    RAISE EXCEPTION 'a SELECT policy on table_seats is still USING (true)';
  END IF;

  -- 2. The new policy says what it is meant to say, read off the stored
  --    expression so a predicate that drifts later cannot pass this.
  SELECT qual, roles::text INTO q, r FROM pg_policies
   WHERE schemaname='public' AND tablename='table_seats'
     AND policyname='seat_read_with_table_or_own' AND cmd='SELECT' AND permissive='PERMISSIVE';
  IF q IS NULL THEN RAISE EXCEPTION 'seat_read_with_table_or_own is missing'; END IF;
  IF r <> '{authenticated}' THEN
    RAISE EXCEPTION 'seat_read_with_table_or_own is not scoped to authenticated: %', r;
  END IF;
  IF q !~ 'user_id = \( SELECT auth\.uid\(\)' THEN
    RAISE EXCEPTION 'seat_read_with_table_or_own lost its own-seat branch: %', q;
  END IF;
  IF q !~ 'EXISTS \( SELECT 1\s+FROM (public\.)?tables t\s+WHERE \(t\.id = table_seats\.table_id\)\)' THEN
    RAISE EXCEPTION 'seat_read_with_table_or_own lost its readable-table branch: %', q;
  END IF;

  -- 3. What sits beside it is untouched.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='table_seats'
       AND policyname IN ('union_overseer_read','Service role manages')) <> 2 THEN
    RAISE EXCEPTION 'union_overseer_read or "Service role manages" went missing';
  END IF;

  -- 4. The seat table's grants are untouched: anon reads no column, the
  --    columns the felt reads every hand stay readable by a signed-in player,
  --    and horse_id stays closed to both browser roles.
  IF has_any_column_privilege('anon','public.table_seats','SELECT') THEN
    RAISE EXCEPTION 'anon reads table_seats';
  END IF;
  IF NOT has_column_privilege('authenticated','public.table_seats','user_id','SELECT')
     OR NOT has_column_privilege('authenticated','public.table_seats','seat_number','SELECT')
     OR NOT has_column_privilege('authenticated','public.table_seats','stack','SELECT')
     OR NOT has_column_privilege('authenticated','public.table_seats','table_id','SELECT') THEN
    RAISE EXCEPTION 'authenticated lost a column of table_seats the table surface reads';
  END IF;
  IF has_column_privilege('anon','public.table_seats','horse_id','SELECT')
     OR has_column_privilege('authenticated','public.table_seats','horse_id','SELECT') THEN
    RAISE EXCEPTION 'table_seats.horse_id became readable by a browser role';
  END IF;

  -- 5. Commander: anon writes nothing, the signed-in and service roles keep
  --    their writes, and neither insert policy admits a row by its NULL owner.
  FOREACH tbl IN ARRAY ARRAY['public.commander_tournament_entries','public.commander_waitlist'] LOOP
    IF has_any_column_privilege('anon', tbl, 'INSERT')
       OR has_any_column_privilege('anon', tbl, 'UPDATE')
       OR has_table_privilege('anon', tbl, 'DELETE') THEN
      RAISE EXCEPTION 'anon can still write %', tbl;
    END IF;
    IF NOT has_table_privilege('authenticated', tbl, 'INSERT')
       OR NOT has_table_privilege('authenticated', tbl, 'UPDATE')
       OR NOT has_table_privilege('authenticated', tbl, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated lost a privilege on % that Commander staff use', tbl;
    END IF;
    IF NOT has_table_privilege('service_role', tbl, 'INSERT') THEN
      RAISE EXCEPTION 'service_role lost INSERT on %; every Commander write path uses it', tbl;
    END IF;
  END LOOP;

  FOR tbl, q, r IN
    SELECT tablename::text, with_check, roles::text FROM pg_policies
     WHERE schemaname='public' AND cmd='INSERT'
       AND (tablename, policyname) IN (('commander_tournament_entries','captain_entries_insert'),
                                       ('commander_waitlist','captain_waitlist_insert'))
  LOOP
    IF r <> '{authenticated}' THEN
      RAISE EXCEPTION 'the insert policy on % is not scoped to authenticated: %', tbl, r;
    END IF;
    IF q ~ 'player_id IS NULL' THEN
      RAISE EXCEPTION 'the insert policy on % still admits a row by its NULL owner: %', tbl, q;
    END IF;
    IF q !~ 'player_id = \( SELECT auth\.uid\(\)' OR q !~ 'commander_staff' OR q !~ 'is_active' THEN
      RAISE EXCEPTION 'the insert policy on % lost its own-row or active-staff branch: %', tbl, q;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND cmd='INSERT'
       AND (tablename, policyname) IN (('commander_tournament_entries','captain_entries_insert'),
                                       ('commander_waitlist','captain_waitlist_insert'))) <> 2 THEN
    RAISE EXCEPTION 'a Commander insert policy went missing';
  END IF;
END
$post$;

COMMIT;
